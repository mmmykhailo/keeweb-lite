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
import { createEmptyDatabase, toEncryptedBytes, unlockDatabase, loadDatabase, loadKdbxweb } from '@/services/database';
import { validateNewDatabaseInput, toKey } from '@/services/record';

const encryptConnection = async (setup: WebDavSetup, database: kdbx.Kdbx) => {
  const kdbx = await loadKdbxweb();
  const container = kdbx.Kdbx.create(database.credentials, 'WebDAV connection');
  if (database.versionMajor < 4) {
    const rounds = database.header.keyEncryptionRounds;
    if (!rounds || rounds < 1) {
      throw new Error('The database uses an unsupported key transformation setting.');
    }
    container.setVersion(3);
    container.header.keyEncryptionRounds = rounds;
  } else {
    const sourceParameters = database.header.kdfParameters;
    if (!sourceParameters) {
      throw new Error('The database uses an unsupported key derivation setting.');
    }
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
    const kdbx = await loadKdbxweb();
    const container = await loadDatabase({
      encryptedBytes: record.source.credentials,
      credentials: database.credentials,
    }).catch((cause: unknown) => {
      throw new Error('Saved WebDAV credentials could not be unlocked. Download and reimport to reconnect.', { cause });
    });
    const entry = container.getDefaultGroup().entries[0];
    const username = entry?.fields.get('Username');
    const password = entry?.fields.get('Password');
    if (!(username instanceof kdbx.ProtectedValue) || !(password instanceof kdbx.ProtectedValue)) {
      throw new Error('Saved WebDAV credentials are invalid. Download and reimport to reconnect.');
    }
    const setup = { url: record.source.url, username: username.getText(), password: password.getText() };
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
