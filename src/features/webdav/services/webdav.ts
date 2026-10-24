import type kdbx from '@/utils/kdbxweb';
import {
  createRecord,
  updateRecord,
  getRecord,
  getRecords,
  type PersistedFileRecord,
  type WebDavFileRecord,
} from '@/repositories/record';
import { insertWebDavRecord, equalBytes } from '@/features/webdav/repositories/record';
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
    const sourceId = sourceParameters.get('$UUID');
    if (!(sourceId instanceof ArrayBuffer)) throw new Error('The database uses an unsupported key derivation setting.');
    const kdfId = kdbx.ByteUtils.bytesToBase64(sourceId);
    const parameters = kdbx.VarDictionary.ValueType;
    const readInt64 = (name: string) => {
      const value = sourceParameters.get(name);
      if (value instanceof kdbx.Int64) return new kdbx.Int64(value.lo, value.hi);
      if (typeof value === 'number') return new kdbx.Int64(value);
      throw new Error('The database uses an unsupported key derivation setting.');
    };

    container.setKdf(kdfId);
    const targetParameters = container.header.kdfParameters;
    if (!targetParameters) throw new Error('The credential container key derivation could not be configured.');
    if (kdfId === kdbx.Consts.KdfId.Argon2d || kdfId === kdbx.Consts.KdfId.Argon2id) {
      const parallelism = sourceParameters.get('P');
      const version = sourceParameters.get('V');
      if (typeof parallelism !== 'number' || typeof version !== 'number') {
        throw new Error('The database uses an unsupported key derivation setting.');
      }
      targetParameters.set('P', parameters.UInt32, parallelism);
      targetParameters.set('I', parameters.UInt64, readInt64('I'));
      targetParameters.set('M', parameters.UInt64, readInt64('M'));
      targetParameters.set('V', parameters.UInt32, version);
    } else if (kdfId === kdbx.Consts.KdfId.Aes) {
      targetParameters.set('R', parameters.UInt64, readInt64('R'));
    } else {
      throw new Error('The database uses an unsupported key derivation setting.');
    }
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
  signal,
  ...input
}: WebDavSetup & {
  databasePassword: string;
  keyFile?: FileList;
  signal?: AbortSignal;
}) => {
  const setup = validateWebDavSetup(input);
  const connection = createWebDavConnection(setup);
  try {
    signal?.throwIfAborted();
    const { bytes } = await connection.read(signal);
    const key = await toKey(keyFile);
    const database = await unlockDatabase({
      encryptedBytes: bytes,
      password: databasePassword,
      keyFileHashBase64: key?.hash,
    });
    signal?.throwIfAborted();
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
      signal,
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
  signal,
}: {
  databaseName: string;
  password: string;
  useKeyFile?: boolean;
  setupInput: WebDavSetup;
  signal?: AbortSignal;
}): Promise<WebDavCreationResult> => {
  const setup = validateWebDavSetup(setupInput);
  const { name, kdbxFileName } = validateNewDatabaseInput(databaseName, password);
  signal?.throwIfAborted();
  const { encryptedBytes, generatedKey, database } = await createEmptyDatabase({ name, password, useKeyFile });
  signal?.throwIfAborted();
  const records = await getRecords();
  let recoveryName = kdbxFileName;
  while (records.some((row) => row.type === 'local' && row.kdbx.name === recoveryName)) {
    recoveryName = `${name}-recovery-${crypto.randomUUID()}.kdbx`;
  }
  signal?.throwIfAborted();
  const recovery = await createRecord({
    id: crypto.randomUUID(),
    type: 'local',
    kdbx: { name: recoveryName, encryptedBytes },
    key: generatedKey?.key,
  });
  const generatedKeyFile = generatedKey ? { bytes: generatedKey.keyFileBytes, name: generatedKey.key.name } : undefined;
  const connection = createWebDavConnection(setup);
  try {
    signal?.throwIfAborted();
    const credentials = await encryptConnection(setup, database);
    signal?.throwIfAborted();
    await connection.write(encryptedBytes, undefined, true, signal);
    const record = await insertWebDavRecord(
      {
        ...recovery,
        type: 'webdav',
        kdbx: { ...recovery.kdbx, name: kdbxFileName },
        source: { url: setup.url },
        synchronization: { generation: 0, pending: false },
      },
      credentials,
      signal,
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
  const localEditState = structuredClone(database.getLocalEditState());
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
          (!confirmedBytes || !equalBytes(current.kdbx.encryptedBytes, bytes) ? 1 : 0),
        pending: !confirmedBytes,
        ...(!confirmedBytes ? { localEditState } : {}),
      },
    };
  });
  if (nextRecord.type !== 'webdav') throw new Error('WebDAV database not found.');
  uploaded.delete(record);
  if (confirmedBytes) database.removeLocalEditState();
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

export const loadWebDavDatabase = async ({
  database,
  record,
  signal,
}: {
  database: kdbx.Kdbx;
  record: WebDavFileRecord;
  signal?: AbortSignal;
}) => {
  signal?.throwIfAborted();
  const current = await getRecord(record.id);
  if (current.type !== 'webdav' || current.synchronization.generation !== record.synchronization.generation) {
    throw new Error('The saved database changed or was removed. Download your edits before reopening.');
  }
  const nextDatabase = await loadDatabase({
    encryptedBytes: current.kdbx.encryptedBytes,
    credentials: database.credentials,
  });
  if (current.synchronization.localEditState)
    nextDatabase.setLocalEditState(structuredClone(current.synchronization.localEditState));
  return nextDatabase;
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
  if (record.synchronization.pending && !equalBytes(record.kdbx.encryptedBytes, snapshot.bytes)) {
    const connection = await connectWebDav(record, snapshot.credentials);
    try {
      await connection.write(bytes, snapshot.etag);
    } finally {
      connection.dispose();
    }
  }
  uploaded.set(record, bytes);
};
