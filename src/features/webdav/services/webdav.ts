import type kdbx from '@/utils/kdbxweb';
import {
  createWebDavRecovery,
  getRecord,
  getRecords,
  getWebDavCredentials,
  insertWebDavRecord,
  updateWebDavRecord,
  equalBytes,
  type PersistedFileRecord,
  type WebDavFileRecord,
} from '@/repositories/record';
import {
  createWebDavConnection,
  validateWebDavSetup,
  WebDavError,
  type WebDavConnection,
  type WebDavSetup,
} from '@/features/webdav/repositories/webdav';
import { createEmptyDatabase, toEncryptedBytes, unlockDatabase, loadDatabase } from '@/services/database';
import { validateNewDatabaseInput, toKey } from '@/services/record';
import { Lock } from '@/utils/lock';

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
  const recovery = await createWebDavRecovery(
    {
      id: crypto.randomUUID(),
      type: 'local',
      kdbx: { name: recoveryName, encryptedBytes },
      key: generatedKey?.key,
    },
    signal,
  );
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

export const unlockWebDav = async (id: string, password: string) => {
  const kdbx = (await import('@/utils/kdbxweb')).default;
  const record = await getRecord(id);
  if (record.type !== 'webdav') throw new Error('WebDAV database not found.');
  const database = await unlockDatabase({
    encryptedBytes: record.kdbx.encryptedBytes,
    password,
    keyFileHashBase64: record.key?.hash,
  });
  if (record.synchronization.localEditState)
    database.setLocalEditState(structuredClone(record.synchronization.localEditState));
  let connection: WebDavConnection | undefined;
  let connectionError: Error | undefined;
  try {
    const bytes = await getWebDavCredentials(id);
    if (!bytes) throw new Error('Saved WebDAV credentials are missing. Download and reimport to reconnect.');
    const container = await unlockDatabase({ encryptedBytes: bytes, password, keyFileHashBase64: record.key?.hash });
    const entry = container.getDefaultGroup().entries[0];
    const username = entry?.fields.get('Username');
    const serverPassword = entry?.fields.get('Password');
    if (!(username instanceof kdbx.ProtectedValue) || !(serverPassword instanceof kdbx.ProtectedValue)) {
      throw new Error('Saved WebDAV credentials are invalid. Download and reimport to reconnect.');
    }
    connection = createWebDavConnection({
      url: record.source.url,
      username: username.getText(),
      password: serverPassword.getText(),
    });
  } catch (error) {
    connectionError = error instanceof Error ? error : new Error('Unable to unlock WebDAV credentials.');
    const controller = new AbortController();
    connection = {
      signal: controller.signal,
      dispose: () => controller.abort(),
      read: async () => {
        throw connectionError;
      },
      write: async () => {
        throw connectionError;
      },
    };
  }
  try {
    const result = await updateWebDavRecord({
      id,
      generation: record.synchronization.generation,
      change: { kind: 'touch' },
    });
    if (result.status !== 'applied') throw new Error('The saved database changed or was removed. Unlock it again.');
    return { database, record: result.record, webDav: connection, webDavError: connectionError, version: 0 };
  } catch (error) {
    connection?.dispose();
    throw error;
  }
};

export const saveWebDav = async (record: WebDavFileRecord, database: kdbx.Kdbx, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const localEditState = structuredClone(database.getLocalEditState());
  const bytes = await toEncryptedBytes(database);
  const result = await updateWebDavRecord({
    id: record.id,
    generation: record.synchronization.generation,
    change: { kind: 'save', bytes, localEditState },
    signal,
  });
  if (result.status !== 'applied')
    throw new Error('The saved database changed or was removed. Download your edits before reopening.');
  return result.record;
};

export type PreparedWebDavSync = {
  record: WebDavFileRecord;
  database: kdbx.Kdbx;
  bytes: Uint8Array;
};

export const prepareWebDavSync = async ({
  id,
  connection,
  credentials,
  signal,
  canApply,
}: {
  id: string;
  connection: WebDavConnection;
  credentials: kdbx.Credentials;
  signal: AbortSignal;
  canApply: () => boolean;
}): Promise<PreparedWebDavSync> =>
  new Lock(`webdav.service.sync.${id}`).runInLock(async () => {
    const check = () => {
      signal.throwIfAborted();
      connection.signal.throwIfAborted();
      if (!canApply()) throw new DOMException('WebDAV refresh deferred.', 'AbortError');
    };
    check();
    const record = await getRecord(id);
    if (record.type !== 'webdav') throw new Error('WebDAV database was removed.');
    const load = async (bytes: Uint8Array) => loadDatabase({ encryptedBytes: bytes, credentials });
    let snapshot = await connection.read(signal);
    for (let attempt = 0; attempt < 3; attempt++) {
      check();
      const candidate = await load(record.kdbx.encryptedBytes);
      check();
      const remote = await load(snapshot.bytes);
      if (!candidate.getDefaultGroup().uuid.equals(remote.getDefaultGroup().uuid)) {
        throw new Error('The WebDAV file is a different database. The local cache has been kept.');
      }
      if (!record.synchronization.pending || equalBytes(record.kdbx.encryptedBytes, snapshot.bytes)) {
        return { record, database: remote, bytes: snapshot.bytes };
      }
      // KDBX drops milliseconds, so concurrent edits can share a timestamp. kdbxweb's merge
      // discards the remote version on a tie unless it is already preserved in local history.
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
        if (!remoteEntry || entry.lastModTime !== remoteEntry.lastModTime) continue;
        const remoteContent = entryContent(remoteEntry);
        if (
          entryContent(entry) !== remoteContent &&
          !entry.history.some((version) => entryContent(version) === remoteContent)
        ) {
          throw new WebDavError(
            'entry-conflict',
            'Conflicting entry changes have the same timestamp. Download your local database and resolve the conflict before retrying.',
          );
        }
      }
      if (record.synchronization.localEditState)
        candidate.setLocalEditState(structuredClone(record.synchronization.localEditState));
      candidate.merge(remote);
      const bytes = await toEncryptedBytes(candidate);
      check();
      try {
        await connection.write(bytes, snapshot.etag, false, signal);
        check();
        return { record, database: candidate, bytes };
      } catch (error) {
        if (!(error instanceof WebDavError) || !['precondition', 'unconfirmed'].includes(error.code)) throw error;
        if (attempt === 2) break;
        snapshot = await connection.read(signal);
      }
    }
    throw new Error('The WebDAV file kept changing. Local changes are saved; retry synchronization.');
  });

export const acceptWebDavSync = async (prepared: PreparedWebDavSync, signal: AbortSignal, canApply: () => boolean) => {
  const result = await updateWebDavRecord({
    id: prepared.record.id,
    generation: prepared.record.synchronization.generation,
    change: { kind: 'sync', bytes: prepared.bytes },
    signal,
    accept: canApply,
  });
  if (result.status === 'applied') prepared.database.removeLocalEditState();
  return result;
};

export const updateWebDavDatabase = async <Result>({
  database,
  record,
  update,
  signal,
}: {
  database: kdbx.Kdbx;
  record: WebDavFileRecord;
  update: (database: kdbx.Kdbx) => Result | Promise<Result>;
  signal?: AbortSignal;
}): Promise<[kdbx.Kdbx, WebDavFileRecord, Result]> => {
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
  const result = await update(nextDatabase);
  return [nextDatabase, await saveWebDav(current, nextDatabase, signal), result];
};
