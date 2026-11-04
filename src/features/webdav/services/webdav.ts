import type kdbx from '@/utils/kdbxweb';
import { createRecord, getRecord, type PersistedFileRecord, type WebDavFileRecord } from '@/repositories/record';
import { insertWebDavRecord } from '@/features/webdav/repositories/record';
import {
  readWebDav,
  statWebDav,
  writeWebDav,
  webdavConnectionSchema,
  type WebDavSetup,
} from '@/features/webdav/repositories/webdav';
import type { Sync } from '@/services/provider';
import { createEmptyDatabase, unlockDatabase, loadDatabase } from '@/services/database';
import { validateNewDatabaseInput, toKey } from '@/services/record';

const sessionConnections = new WeakMap<kdbx.Credentials, WebDavSetup>();

const encryptConnection = async (setup: WebDavSetup, database: kdbx.Kdbx) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', await database.credentials.getHash(), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const bytes = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(setup.url) },
    key,
    new TextEncoder().encode(JSON.stringify(setup)),
  );
  return new Uint8Array([...salt, ...iv, ...new Uint8Array(bytes)]);
};

const decryptConnection = async (record: WebDavFileRecord, database: kdbx.Kdbx) => {
  const cached = sessionConnections.get(database.credentials);
  if (cached) {
    return cached;
  }
  const encrypted = record.source.credentials;
  const material = await crypto.subtle.importKey('raw', await database.credentials.getHash(), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encrypted.slice(0, 16), iterations: 600_000 },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: encrypted.slice(16, 28), additionalData: new TextEncoder().encode(record.source.url) },
    key,
    encrypted.slice(28),
  );
  const setup = webdavConnectionSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  sessionConnections.set(database.credentials, setup);
  return setup;
};

export const importWebDavRecord = async ({
  databasePassword,
  keyFile,
  ...input
}: WebDavSetup & {
  databasePassword: string;
  keyFile?: FileList;
}) => {
  const setup = webdavConnectionSchema.parse(input);
  const { pathname } = new URL(setup.url);
  const { bytes, etag } = await readWebDav(setup);
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
      source: { url: setup.url, etag },
      key,
      kdbx: {
        name: decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)),
        encryptedBytes: bytes,
      },
      version: 0,
      syncedVersion: 0,
    },
    credentials,
  );
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
  const setup = webdavConnectionSchema.parse(setupInput);
  const { name, kdbxFileName } = validateNewDatabaseInput(databaseName, password);
  const { encryptedBytes, generatedKey } = await createEmptyDatabase({ name, password, useKeyFile });
  const recovery = await createRecord({
    id: crypto.randomUUID(),
    type: 'local',
    kdbx: { name: kdbxFileName, encryptedBytes },
    key: generatedKey?.key,
  });
  const generatedKeyFile = generatedKey ? { bytes: generatedKey.keyFileBytes, name: generatedKey.key.name } : undefined;
  try {
    const database = await unlockDatabase({
      encryptedBytes,
      password,
      keyFileHashBase64: generatedKey?.key.hash,
    });
    const credentials = await encryptConnection(setup, database);
    const etag = await writeWebDav({ setup, bytes: encryptedBytes, create: true });
    const record = await insertWebDavRecord(
      {
        ...recovery,
        type: 'webdav',
        kdbx: { ...recovery.kdbx, name: kdbxFileName },
        source: { url: setup.url, etag },
        version: 0,
        syncedVersion: 0,
      },
      credentials,
      encryptedBytes,
    );
    return { outcome: 'created', record, generatedKeyFile };
  } catch (cause) {
    const record = await getRecord(recovery.id);
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
  }
};

export const webDavSync: Sync<
  WebDavFileRecord,
  {
    setup: WebDavSetup;
    etag?: string;
    credentials: kdbx.Credentials;
  }
> = {
  check: async (record, database) => {
    const setup = await decryptConnection(record, database).catch((cause: unknown) => {
      throw new Error('Saved WebDAV credentials could not be unlocked. Download and reimport to reconnect.', { cause });
    });
    const etag = await statWebDav(setup);
    return {
      data: { setup, etag, credentials: database.credentials },
      isRemoteChanged: !etag || etag !== record.source.etag,
    };
  },
  pull: async (record, { setup, etag, credentials }) => {
    const load = (bytes: Uint8Array) => loadDatabase({ encryptedBytes: bytes, credentials });
    const snapshot = await readWebDav(setup, etag);
    const candidate = await load(record.kdbx.encryptedBytes);
    const remote = await load(snapshot.bytes).catch((cause: unknown) => {
      throw new Error(
        'The remote WebDAV database could not be unlocked. Download your local database and reimport with its current password and key file.',
        { cause },
      );
    });
    if (!candidate.getDefaultGroup().uuid.equals(remote.getDefaultGroup().uuid)) {
      throw new Error('The WebDAV file is a different database. The local cache has been kept.');
    }
    return { bytes: snapshot.bytes, source: { ...record.source, etag: snapshot.etag } };
  },
  push: async ({ source }, bytes, { setup, etag }) => ({
    ...source,
    etag: await writeWebDav({ setup, bytes, etag }),
  }),
};
