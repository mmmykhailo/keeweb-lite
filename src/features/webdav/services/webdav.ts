import type kdbx from '@/utils/kdbxweb';
import { isSameBytes } from '@/utils/buffer';
import {
  createRecord,
  updateRecord,
  getRecord,
  getRecords,
  type PersistedFileRecord,
  type WebDavFileRecord,
} from '@/repositories/record';
import { insertWebDavRecord } from '@/features/webdav/repositories/record';
import {
  createWebDavConnection,
  validateWebDavSetup,
  WebDavError,
  type WebDavSetup,
} from '@/features/webdav/repositories/webdav';
import { createEmptyDatabase, toEncryptedBytes, unlockDatabase, loadDatabase } from '@/services/database';
import { validateNewDatabaseInput, toKey } from '@/services/record';

const encryptConnection = async (setup: WebDavSetup, database: kdbx.Kdbx) => {
  const kdbx = (await import('@/utils/kdbxweb')).default;
  const container = kdbx.Kdbx.create(database.credentials, 'WebDAV connection');
  if (database.versionMajor < 4) {
    const rounds = database.header.keyEncryptionRounds;
    if (!rounds || rounds < 1) throw new Error('The database uses an unsupported key transformation setting.');
    container.setVersion(3);
    container.header.keyEncryptionRounds = rounds;
  } else {
    const sourceParameters = database.header.kdfParameters;
    if (!sourceParameters) throw new Error('The database uses an unsupported key derivation setting.');
    const stream = new kdbx.BinaryStream();
    sourceParameters.write(stream);
    container.header.kdfParameters = kdbx.VarDictionary.read(new kdbx.BinaryStream(stream.getWrittenBytes()));
  }
  const entry = container.createEntry(container.getDefaultGroup());
  entry.fields.set('Title', 'Connection credentials');

  entry.fields.set('Username', kdbx.ProtectedValue.fromString(setup.username));
  entry.fields.set('Password', kdbx.ProtectedValue.fromString(setup.password));

  return await toEncryptedBytes(container);
};

export const importWebDavRecord = async ({
  databasePassword,
  keyFile,
  ...input
}: WebDavSetup & {
  databasePassword: string;
  keyFile?: FileList;
}) => {
  const setup = validateWebDavSetup(input);
  const connection = createWebDavConnection(setup);
  try {
    const { bytes } = await connection.read();
    const key = await toKey(keyFile);
    const database = await unlockDatabase({
      encryptedBytes: bytes,
      password: databasePassword,
      keyFileHashBase64: key?.hash,
    });
    const credentials = await encryptConnection(setup, database);
    return await insertWebDavRecord(
      {
        id: crypto.randomUUID(),
        type: 'webdav',
        source: { url: setup.url },
        key,
        kdbx: {
          name: decodeURIComponent(new URL(setup.url).pathname.split('/').at(-1) || 'webdav.kdbx'),
          encryptedBytes: bytes,
        },
        synchronization: { generation: 0, pending: false },
      },
      credentials,
    );
  } finally {
    connection.dispose();
  }
};

export type WebDavCreationResult = {
  record: PersistedFileRecord;
  generatedKeyFile?: { bytes: Uint8Array; name: string };
} & ({ outcome: 'created' } | { outcome: 'saved-locally'; error: Error });

export const createWebDavRecord = async ({
  databaseName,
  password,
  useKeyFile,
  setupInput,
}: {
  databaseName: string;
  password: string;
  useKeyFile?: boolean;
  setupInput: WebDavSetup;
}): Promise<WebDavCreationResult> => {
  const setup = validateWebDavSetup(setupInput);
  const { name, kdbxFileName } = validateNewDatabaseInput(databaseName, password);
  const { encryptedBytes, generatedKey } = await createEmptyDatabase({ name, password, useKeyFile });
  const records = await getRecords();
  let recoveryName = kdbxFileName;
  while (records.some((row) => row.type === 'local' && row.kdbx.name === recoveryName)) {
    recoveryName = `${name}-recovery-${crypto.randomUUID()}.kdbx`;
  }
  const recovery = await createRecord({
    id: crypto.randomUUID(),
    type: 'local',
    kdbx: { name: recoveryName, encryptedBytes },
    key: generatedKey?.key,
  });
  const generatedKeyFile = generatedKey ? { bytes: generatedKey.keyFileBytes, name: generatedKey.key.name } : undefined;
  const connection = createWebDavConnection(setup);
  try {
    const database = await unlockDatabase({
      encryptedBytes,
      password,
      keyFileHashBase64: generatedKey?.key.hash,
    });
    const credentials = await encryptConnection(setup, database);
    await connection.write(encryptedBytes, undefined, true);
    const record = await insertWebDavRecord(
      {
        ...recovery,
        type: 'webdav',
        kdbx: { ...recovery.kdbx, name: kdbxFileName },
        source: { url: setup.url },
        synchronization: { generation: 0, pending: false },
      },
      credentials,
      encryptedBytes,
    );
    return { outcome: 'created', record, generatedKeyFile };
  } catch (cause) {
    const record = await getRecord(recovery.id).catch(() => {
      throw new DOMException('Local recovery was removed.', 'AbortError');
    });
    return {
      outcome: 'saved-locally',
      record,
      generatedKeyFile,
      error: new Error(
        'Database saved locally. Check the WebDAV destination, download the local database, and import the remote file separately. ' +
          (cause instanceof Error ? cause.message : 'Upload failed.'),
        { cause },
      ),
    };
  } finally {
    connection.dispose();
  }
};

const snapshots = new WeakMap<WebDavFileRecord, { bytes: Uint8Array; etag?: string; credentials: kdbx.Credentials }>();
const uploaded = new WeakMap<WebDavFileRecord, Uint8Array>();

export const saveWebDav = async (record: WebDavFileRecord, database: kdbx.Kdbx, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const confirmedBytes = uploaded.get(record);
  const bytes = confirmedBytes ?? (await toEncryptedBytes(database));
  const nextRecord = await updateRecord(record.id, (current) => {
    signal?.throwIfAborted();
    if (current.type !== 'webdav' || current.synchronization.generation !== record.synchronization.generation) {
      throw new Error('The saved database changed or was removed. Download your edits before reopening.');
    }
    return {
      ...current,
      kdbx: { ...current.kdbx, encryptedBytes: bytes.slice() },
      synchronization: {
        generation:
          current.synchronization.generation +
          (!confirmedBytes || !isSameBytes(current.kdbx.encryptedBytes, bytes) ? 1 : 0),
        pending: !confirmedBytes,
      },
    };
  });
  if (nextRecord.type !== 'webdav') throw new Error('WebDAV database not found.');
  uploaded.delete(record);
  return nextRecord;
};

const connectWebDav = async (record: WebDavFileRecord, credentials: kdbx.Credentials) => {
  const kdbx = (await import('@/utils/kdbxweb')).default;
  const container = await loadDatabase({
    encryptedBytes: record.source.credentials,
    credentials,
  });
  const entry = container.getDefaultGroup().entries[0];
  const username = entry?.fields.get('Username');
  const password = entry?.fields.get('Password');
  if (!(username instanceof kdbx.ProtectedValue) || !(password instanceof kdbx.ProtectedValue)) {
    throw new Error('Saved WebDAV credentials are invalid. Download and reimport to reconnect.');
  }
  return createWebDavConnection({ url: record.source.url, username: username.getText(), password: password.getText() });
};

export const loadWebDavDatabase = async ({ database, record }: { database: kdbx.Kdbx; record: WebDavFileRecord }) => {
  const current = await getRecord(record.id);
  if (current.type !== 'webdav' || current.synchronization.generation !== record.synchronization.generation) {
    throw new Error('The saved database changed or was removed. Download your edits before reopening.');
  }
  return loadDatabase({
    encryptedBytes: current.kdbx.encryptedBytes,
    credentials: database.credentials,
  });
};

export const pullWebDav = async (record: WebDavFileRecord, database: kdbx.Kdbx) => {
  const connection = await connectWebDav(record, database.credentials);
  try {
    const snapshot = await connection.read();
    const candidate = await loadWebDavDatabase({ record, database });
    const remote = await loadDatabase({ encryptedBytes: snapshot.bytes, credentials: database.credentials });
    if (!candidate.getDefaultGroup().uuid.equals(remote.getDefaultGroup().uuid)) {
      throw new Error('The WebDAV file is a different database. The local cache has been kept.');
    }
    if (record.synchronization.pending) {
      // KDBX drops milliseconds. kdbxweb identifies current and historical versions by
      // timestamp; refuse collisions that could discard remote content.
      const kdbx = (await import('@/utils/kdbxweb')).default;
      const entryContent = (version: kdbx.KdbxEntry) =>
        JSON.stringify(
          {
            fields: new Map(
              [...version.fields].map(([name, value]) => [name, typeof value === 'string' ? value : value.getText()]),
            ),
            binaries: new Map(
              [...version.binaries].map(([name, value]) => [name, 'hash' in value ? value.hash : value]),
            ),
            tags: version.tags.toSorted(),
            icon: version.icon,
            customIcon: version.customIcon,
            fgColor: version.fgColor,
            bgColor: version.bgColor,
            overrideUrl: version.overrideUrl,
            autoType: version.autoType,
            customData: version.customData,
            qualityCheck: version.qualityCheck,
            expires: !!version.times.expires,
            expiryTime: version.times.expires ? version.times.expiryTime : undefined,
          },
          (_key, value: unknown) => {
            if (value instanceof kdbx.ProtectedValue) return value.toBase64();
            if (value instanceof kdbx.KdbxUuid) return value.id;
            if (value instanceof Map)
              return [...value.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)));
            if (value instanceof ArrayBuffer || value instanceof Uint8Array) return kdbx.ByteUtils.bytesToBase64(value);
            return value;
          },
        );
      const remoteEntries = new Map([...remote.getDefaultGroup().allEntries()].map((entry) => [entry.uuid.id, entry]));
      for (const entry of candidate.getDefaultGroup().allEntries()) {
        const remoteEntry = remoteEntries.get(entry.uuid.id);
        if (!remoteEntry) continue;
        const localVersions = [entry, ...entry.history].map((version) => ({
          time: version.lastModTime,
          content: entryContent(version),
        }));
        for (const version of [remoteEntry, ...remoteEntry.history]) {
          const remoteContent = entryContent(version);
          if (
            localVersions.some((local) => local.time === version.lastModTime && local.content !== remoteContent) &&
            !localVersions.some((local) => local.content === remoteContent)
          ) {
            throw new WebDavError(
              'entry-conflict',
              'Conflicting entry changes have the same timestamp. Download your local database and resolve the conflict before retrying.',
            );
          }
        }
      }
    }
    snapshots.set(record, { ...snapshot, credentials: database.credentials });
    return snapshot.bytes;
  } finally {
    connection.dispose();
  }
};

export const pushWebDav = async ({ record, bytes }: { record: WebDavFileRecord; bytes: Uint8Array }) => {
  const snapshot = snapshots.get(record);
  if (!snapshot) throw new Error('Read the WebDAV file before uploading changes.');
  snapshots.delete(record);
  if (record.synchronization.pending && !isSameBytes(record.kdbx.encryptedBytes, snapshot.bytes)) {
    const connection = await connectWebDav(record, snapshot.credentials);
    try {
      await connection.write(bytes, snapshot.etag);
    } finally {
      connection.dispose();
    }
  }
  uploaded.set(record, bytes);
};
