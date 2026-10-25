import kdbx from '@/utils/kdbxweb';
import { unlockSession } from '@/features/unlock/services/session';
import { syncSession, updateRecordDatabase } from '@/features/workspace/services/session';
import { createFileList } from '@tests/utils/file-list';
import { get, set } from 'idb-keyval';
import { describe, expect, it, vi } from 'vitest';
import {
  RECORDS_STORAGE_KEY,
  createRecord,
  getRecord,
  getRecords,
  removeRecord,
  updateRecord,
  isModified,
} from '@/repositories/record';
import { insertWebDavRecord } from '@/features/webdav/repositories/record';
import { createWebDavRecord, importWebDavRecord } from '@/features/webdav/services/webdav';
import { recordStorage } from '@/services/provider';
import { isSameBytes } from '@/utils/buffer';
import { cloneDatabase } from '@/services/database';
import { toEncryptedBytes, unlockDatabase } from '@/services/database';

const setup = { url: 'https://dav.example/vault.kdbx', username: 'user', password: 'server-password' };
const password = 'database-password';
const response = (bytes: Uint8Array, etag = '"remote"') =>
  new Response(bytes.slice().buffer, { headers: { ETag: etag } });

const getWebDavCredentials = async (id: string) => {
  const record = (await getRecords()).find((record) => record.id === id);
  return record?.type === 'webdav' ? record.source.credentials : undefined;
};

const database = async (key?: Uint8Array) => {
  const credentials = new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key);
  await credentials.ready;
  return kdbx.Kdbx.create(credentials, 'Vault');
};
const imported = async (db?: kdbx.Kdbx) => {
  db ??= await database();
  const bytes = await toEncryptedBytes(db);
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(response(bytes, '"imported"')));
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
  const record = await importWebDavRecord({ ...setup, databasePassword: password });
  fetch.mockImplementation(() => Promise.resolve(response(bytes, '"next"')));
  return { db, bytes, record, fetch, [Symbol.dispose]: () => fetchSpy.mockRestore() };
};
describe('webdav', () => {
  describe('WebDAV persistence and credentials', () => {
    it('preserves Local/Drive rows while inserting, saving, and removing WebDAV and its credentials', async () => {
      const local = {
        id: 'local',
        type: 'local' as const,
        kdbx: { name: 'local', encryptedBytes: new Uint8Array([1]) },
        key: { name: 'key', hash: 'material' },
        lastOpenedAt: '2026-01-01',
      };
      const drive = { ...local, id: 'drive', type: 'google-drive' as const, source: { id: 'source-id' } };
      await createRecord(local);
      await createRecord(drive);
      using context = await imported();
      const { record, db } = context;
      expect(await getRecords()).toEqual([local, drive, record]);
      await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(db) });
      await removeRecord(record.id);
      expect(await get(RECORDS_STORAGE_KEY)).toEqual([local, drive]);
      expect(await getWebDavCredentials(record.id)).toBeUndefined();
    });

    it('rejects wrong database factors without saving credentials', async () => {
      const db = await database();
      const bytes = await toEncryptedBytes(db);
      using _fetch0 = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(vi.fn().mockImplementation(() => Promise.resolve(response(bytes))));
      await expect(importWebDavRecord({ ...setup, databasePassword: 'wrong' })).rejects.toThrow('Invalid password');
      expect(await getRecords()).toEqual([]);
    });

    it('rejects duplicate URLs without saving credentials', async () => {
      using context = await imported();
      const { record } = context;
      await removeRecord(record.id);
      const attempts = await Promise.allSettled([
        insertWebDavRecord(record, new Uint8Array([1])),
        insertWebDavRecord({ ...record, id: 'duplicate' }, new Uint8Array([2])),
      ]);
      expect(attempts.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(await getWebDavCredentials('duplicate')).toBeUndefined();
    });

    it.each(['v3-aes', 'v4-aes', 'argon2id', 'argon2d'])(
      'copies %s costs with independent salts and password/key-file protection',
      async (kind) => {
        const key = await kdbx.Credentials.createRandomKeyFile(2);
        const db = await database(key);
        if (kind === 'v3-aes') {
          db.setVersion(3);
          db.header.keyEncryptionRounds = 1234;
        } else if (kind === 'v4-aes') {
          db.setKdf(kdbx.Consts.KdfId.Aes);
          db.header.kdfParameters?.set('R', kdbx.VarDictionary.ValueType.UInt64, new kdbx.Int64(1234));
        } else db.setKdf(kind === 'argon2id' ? kdbx.Consts.KdfId.Argon2id : kdbx.Consts.KdfId.Argon2d);
        const bytes = await toEncryptedBytes(db);
        using _fetch = vi
          .spyOn(globalThis, 'fetch')
          .mockImplementation(vi.fn().mockImplementation(async () => response(bytes)));
        const keyFile = createFileList(new File([key.slice().buffer], 'vault.keyx'));
        const record = await importWebDavRecord({ ...setup, databasePassword: password, keyFile });
        const containerBytes = await getWebDavCredentials(record.id);
        if (!containerBytes) throw new Error('Missing credentials.');
        await expect(unlockDatabase({ encryptedBytes: containerBytes, password })).rejects.toThrow();
        const container = await unlockDatabase({
          encryptedBytes: containerBytes,
          password,
          keyFileHashBase64: record.key?.hash,
        });
        expect(container.versionMajor).toBe(db.versionMajor);
        expect(container.header.masterSeed).not.toEqual(db.header.masterSeed);
        if (kind === 'v3-aes') {
          expect(container.header.keyEncryptionRounds).toBe(1234);
          expect(container.header.transformSeed).not.toEqual(db.header.transformSeed);
        } else {
          for (const name of ['$UUID', ...(kind === 'v4-aes' ? ['R'] : ['P', 'I', 'M', 'V'])])
            expect(container.header.kdfParameters?.get(name)).toEqual(db.header.kdfParameters?.get(name));
          const containerSalt = container.header.kdfParameters?.get('S');
          const sourceSalt = db.header.kdfParameters?.get('S');
          if (!(containerSalt instanceof ArrayBuffer) || !(sourceSalt instanceof ArrayBuffer))
            throw new Error('Missing KDF salts.');
          expect(new Uint8Array(containerSalt)).not.toEqual(new Uint8Array(sourceSalt));
        }
        expect(container.getDefaultGroup().entries[0].fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
        expect(db.getDefaultGroup().entries).toHaveLength(0);
        const session = await unlockSession({ record, password });
        expect(session.database.meta.name).toBe('Vault');
        await expect(syncSession(session)).resolves.toBeDefined();
      },
    );

    it('unlocks cached data without network when saved credentials are broken', async () => {
      using context = await imported();
      const { record, fetch } = context;
      await set(RECORDS_STORAGE_KEY, [{ ...record, source: { ...record.source, credentials: new Uint8Array([0]) } }]);
      fetch.mockClear();
      const storedRecord = await getRecord(record.id);
      const session = await unlockSession({ record: storedRecord, password });
      expect(session.database.meta.name).toBe('Vault');
      await expect(syncSession(session)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(session.database) });
      expect(saved.type === 'webdav' && isModified(saved)).toBe(true);
    });
  });

  describe('WebDAV creation recovery', () => {
    it.each(['failure', 'exists', 'uncertain'])('keeps a local database and generated key after %s', async (kind) => {
      const fetch = vi.fn().mockImplementation(async (_url, options: RequestInit) => {
        expect((await getRecords())[0].type).toBe('local');
        expect(new Headers(options.headers).get('If-None-Match')).toBe('*');
        if (kind === 'exists') return new Response(null, { status: 412 });
        if (kind === 'uncertain') return response(new Uint8Array([9]));
        throw new TypeError('offline');
      });
      using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
      if (kind === 'uncertain') fetch.mockResolvedValueOnce(new Response(null));
      const result = await createWebDavRecord({
        databaseName: 'Vault',
        password,
        useKeyFile: true,
        setupInput: setup,
      });
      expect(result.outcome).toBe('saved-locally');
      expect(result.record.type).toBe('local');
      expect(result.generatedKeyFile?.bytes.length).toBeGreaterThan(0);
      await expect(
        unlockDatabase({
          encryptedBytes: result.record.kdbx.encryptedBytes,
          password,
          keyFileHashBase64: result.record.key?.hash,
        }),
      ).resolves.toBeDefined();
      expect(await getWebDavCredentials(result.record.id)).toBeUndefined();
    });

    it('uses a distinct recovery record when an existing Local database has the same name', async () => {
      const local = await createRecord({
        id: 'existing',
        type: 'local',
        kdbx: { name: 'Vault.kdbx', encryptedBytes: new Uint8Array([1]) },
      });
      using _fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(vi.fn().mockRejectedValue(new TypeError('offline')));
      const result = await createWebDavRecord({ databaseName: 'Vault', password, setupInput: setup });
      expect(result.outcome).toBe('saved-locally');
      expect(result.record.id).not.toBe(local.id);
      expect(result.record.kdbx.name).not.toBe(local.kdbx.name);
      expect(await getRecord(local.id)).toEqual(local);
    });

    it('promotes an unchanged recovery row only after confirmed creation', async () => {
      using _fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(vi.fn().mockResolvedValue(response(new Uint8Array())));
      const result = await createWebDavRecord({ databaseName: 'Vault', password, setupInput: setup });
      expect(result.outcome).toBe('created');
      expect(result.record.type).toBe('webdav');
      expect(await getWebDavCredentials(result.record.id)).toBeInstanceOf(Uint8Array);
      expect(await getRecords()).toHaveLength(1);
    });

    it.each(['removed', 'edited'])('never replaces a recovery row %s during upload', async (kind) => {
      using _fetch1 = vi.spyOn(globalThis, 'fetch').mockImplementation(
        vi.fn().mockImplementation(async () => {
          const row = (await getRecords())[0];
          if (kind === 'removed') await removeRecord(row.id);
          else await set(RECORDS_STORAGE_KEY, [{ ...row, kdbx: { ...row.kdbx, encryptedBytes: new Uint8Array([7]) } }]);
          return response(new Uint8Array());
        }),
      );
      const creation = createWebDavRecord({ databaseName: 'Vault', password, setupInput: setup });
      if (kind === 'removed') {
        await expect(creation).rejects.toMatchObject({ name: 'AbortError' });
        expect(await getRecords()).toEqual([]);
      } else {
        const result = await creation;
        expect(result.outcome).toBe('saved-locally');
        expect(result.record.kdbx.encryptedBytes).toEqual(new Uint8Array([7]));
      }
    });
  });

  describe('WebDAV synchronization', () => {
    it('uses native merge for independent edits after save/reload', async () => {
      const db = await database();
      const entry = db.createEntry(db.getDefaultGroup());
      entry.fields.set('Title', 'Original');
      using context = await imported(db);
      const { record, bytes, fetch } = context;
      const local = await cloneDatabase(db);
      const edited = local.getDefaultGroup().entries[0];
      edited.pushHistory();
      edited.fields.set('Title', 'Local');
      edited.times.lastModTime = new Date(Date.now() + 3000);
      const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(local) });
      const reopened = await unlockSession({ record, password });
      const reloaded = await recordStorage.load({ record: saved, database: reopened.database });
      const remote = await unlockDatabase({ encryptedBytes: bytes, password });
      remote.createEntry(remote.getDefaultGroup()).fields.set('Title', 'Remote entry');
      const remoteBytes = await toEncryptedBytes(remote);
      fetch.mockImplementation((_url, options: RequestInit) =>
        Promise.resolve(
          options.method !== 'PUT' ? response(remoteBytes, '"next"') : response(new Uint8Array(), '"confirmed"'),
        ),
      );
      const candidate = await syncSession({ record: saved, database: reloaded });
      expect(candidate.database.getDefaultGroup().entries.map((row) => row.fields.get('Title'))).toEqual([
        'Local',
        'Remote entry',
      ]);
      const current = await getRecord(record.id);
      if (current.type !== 'webdav') throw new Error('Expected WebDAV.');
      expect(isModified(current)).toBe(false);
    });

    it('decrypts saved credentials once per unlocked session', async () => {
      using context = await imported();
      const { record, fetch, bytes } = context;
      using load = vi.spyOn(kdbx.Kdbx, 'load');
      const session = await unlockSession({ record, password });
      fetch.mockImplementation(() => Promise.resolve(response(bytes, '"imported"')));
      await syncSession(session);
      await syncSession(session);
      expect(
        load.mock.calls.filter(([bytes]) => isSameBytes(new Uint8Array(bytes), record.source.credentials)),
      ).toHaveLength(1);
    });

    it('reloads and merges the new remote revision after a conflicting PUT', async () => {
      using context = await imported();
      const { record, db, bytes, fetch } = context;
      db.createEntry(db.getDefaultGroup()).fields.set('Title', 'Local entry');
      const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(db) });
      const remote = await unlockDatabase({ encryptedBytes: bytes, password });
      remote.createEntry(remote.getDefaultGroup()).fields.set('Title', 'Remote entry');
      const remoteBytes = await toEncryptedBytes(remote);
      const put = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 412 }))
        .mockResolvedValueOnce(response(new Uint8Array(), '"uploaded"'));
      fetch.mockClear();
      fetch.mockImplementation((_url, options: RequestInit) =>
        options.method === 'PUT'
          ? put()
          : Promise.resolve(response(remoteBytes, put.mock.calls.length ? '"new"' : '"imported"')),
      );
      const result = await syncSession({ record: saved, database: db });
      expect(result.database.getDefaultGroup().entries.map((entry) => entry.fields.get('Title'))).toEqual([
        'Local entry',
        'Remote entry',
      ]);
      expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['HEAD', 'PUT', 'HEAD', 'GET', 'PUT']);
      expect(result.record.type === 'webdav' && result.record.source.etag).toBe('"uploaded"');
    });

    it('rejects a stale ETag and keeps local pending data', async () => {
      using context = await imported();
      const { record, db, bytes, fetch } = context;
      db.meta.name = 'Local';
      const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(db) });
      fetch.mockClear();
      fetch.mockImplementation((_url, options: RequestInit) =>
        Promise.resolve(options.method !== 'PUT' ? response(bytes) : new Response(null, { status: 412 })),
      );
      await expect(syncSession({ record: saved, database: db })).rejects.toThrow();
      expect(fetch.mock.calls.filter((call) => call[1].method === 'PUT')).toHaveLength(3);
      expect(await getRecord(record.id)).toEqual(saved);
    });

    it.each(['identity', 'factors', 'missing', 'weak'])('retains the exportable cache on %s failure', async (kind) => {
      using context = await imported();
      const { record, db, fetch, bytes } = context;
      db.meta.name = 'Local';
      const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(db) });
      const other = await database();
      if (kind === 'factors')
        other.credentials = new kdbx.Credentials(kdbx.ProtectedValue.fromString('changed-password'));
      const otherBytes = await toEncryptedBytes(other);
      fetch.mockImplementation(() =>
        Promise.resolve(
          kind === 'missing'
            ? new Response(null, { status: 404 })
            : response(kind === 'weak' ? bytes : otherBytes, kind === 'weak' ? 'W/"weak"' : '"etag"'),
        ),
      );
      await expect(syncSession({ record: saved, database: db })).rejects.toThrow();
      expect(await getRecord(record.id)).toEqual(saved);
    });

    it('keeps unsynced intermediate history after reopening and merging a newer remote entry', async () => {
      const db = await database();
      const entry = db.createEntry(db.getDefaultGroup());
      entry.fields.set('Title', 'Original');
      entry.times.lastModTime = new Date('2026-01-01T00:00:00Z');
      using context = await imported(db);
      const { record, bytes, fetch } = context;
      const local = await cloneDatabase(db);
      const localEntry = local.getDefaultGroup().entries[0];
      localEntry.pushHistory();
      localEntry.fields.set('Title', 'Local intermediate');
      localEntry.times.lastModTime = new Date('2026-01-01T00:00:02Z');
      localEntry.pushHistory();
      localEntry.fields.set('Title', 'Local latest');
      localEntry.times.lastModTime = new Date('2026-01-01T00:00:04Z');
      const saved = await recordStorage.update(record, {
        encryptedBytes: await toEncryptedBytes(local),
        localEditState: local.getLocalEditState(),
      });
      const remote = await unlockDatabase({ encryptedBytes: bytes, password });
      const remoteEntry = remote.getDefaultGroup().entries[0];
      remoteEntry.pushHistory();
      remoteEntry.fields.set('Title', 'Remote latest');
      remoteEntry.times.lastModTime = new Date('2026-01-01T00:00:06Z');
      const remoteBytes = await toEncryptedBytes(remote);
      fetch.mockImplementation(() => Promise.resolve(response(remoteBytes, '"new"')));
      if (saved.type !== 'webdav') throw new Error('Expected WebDAV');
      const reopened = await unlockSession({ record: saved, password });
      const merged = await syncSession(reopened);
      const stored = await unlockSession({ record: await getRecord(record.id), password });
      expect(merged.database.getDefaultGroup().entries[0].fields.get('Title')).toBe('Remote latest');
      expect(stored.database.getDefaultGroup().entries[0].history.map((item) => item.fields.get('Title'))).toEqual(
        expect.arrayContaining(['Local intermediate', 'Local latest']),
      );
    });

    it('clears only uploaded history state when another edit is saved during upload', async () => {
      const db = await database();
      const entry = db.createEntry(db.getDefaultGroup());
      entry.fields.set('Title', 'Original');
      entry.times.lastModTime = new Date('2026-01-01T00:00:00Z');
      using context = await imported(db);
      const { record, fetch } = context;
      const [firstDatabase, firstRecord] = await updateRecordDatabase({
        record,
        database: db,
        update: (local) => {
          const entry = local.getDefaultGroup().entries[0];
          entry.pushHistory();
          entry.fields.set('Title', 'First');
          local.meta.historyMaxItems = 20;
          entry.times.lastModTime = new Date('2026-01-01T00:00:02Z');
        },
      });
      const upload = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      fetch.mockImplementation((_url, options: RequestInit) => {
        if (options.method === 'HEAD') return Promise.resolve(response(new Uint8Array(), '"imported"'));
        started.resolve();
        return upload.promise;
      });
      const syncing = syncSession({ record: firstRecord, database: firstDatabase });
      await started.promise;
      await updateRecordDatabase({
        record: firstRecord,
        database: firstDatabase,
        update: (local) => {
          const entry = local.getDefaultGroup().entries[0];
          entry.pushHistory();
          entry.fields.set('Title', 'Second');
          local.meta.color = '#112233';
          entry.times.lastModTime = new Date('2026-01-01T00:00:04Z');
        },
      });
      upload.resolve(response(new Uint8Array(), '"first"'));
      await syncing;
      const stored = await getRecord(record.id);
      if (stored.type !== 'webdav') throw new Error('Expected WebDAV');
      expect(stored.localEditState?.entries?.[entry.uuid.id]?.added).toEqual([
        new Date('2026-01-01T00:00:02Z').getTime(),
      ]);
      expect(stored.localEditState?.meta?.historyMaxItemsChanged).toBeUndefined();
      expect(stored.localEditState?.meta?.colorChanged).toBeInstanceOf(Date);
      expect(isModified(stored)).toBe(true);
      fetch.mockImplementation(() => Promise.resolve(response(new Uint8Array(), '"first"')));
      const reopened = await unlockSession({ record: stored, password });
      await syncSession(reopened);
      const synced = await getRecord(record.id);
      expect(synced.type === 'webdav' && synced.localEditState).toBeUndefined();
      expect(synced.type === 'webdav' && isModified(synced)).toBe(false);
    });

    it('retains both competing versions in native history without adding conflict entries', async () => {
      const db = await database();
      const entry = db.createEntry(db.getDefaultGroup());
      entry.fields.set('Title', 'Original');
      entry.times.lastModTime = new Date('2026-01-01T00:00:00Z');
      using context = await imported(db);
      const { record, bytes, fetch } = context;
      const local = await cloneDatabase(db);
      const localEntry = local.getDefaultGroup().entries[0];
      localEntry.pushHistory();
      localEntry.fields.set('Title', 'Local version');
      localEntry.times.lastModTime = new Date('2026-01-01T00:00:02Z');
      const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(local) });
      const remote = await unlockDatabase({ encryptedBytes: bytes, password });
      const remoteEntry = remote.getDefaultGroup().entries[0];
      remoteEntry.pushHistory();
      remoteEntry.fields.set('Title', 'Remote version');
      remoteEntry.times.lastModTime = new Date('2026-01-01T00:00:04Z');
      const remoteBytes = await toEncryptedBytes(remote);
      fetch.mockImplementation((_url, options: RequestInit) =>
        Promise.resolve(options.method !== 'PUT' ? response(remoteBytes, '"next"') : response(new Uint8Array())),
      );
      const candidate = await syncSession({ record: saved, database: local });
      expect(candidate.database.getDefaultGroup().entries).toHaveLength(1);
      const merged = candidate.database.getDefaultGroup().entries[0];
      expect(merged.fields.get('Title')).toBe('Remote version');
      expect(merged.history.map((item) => item.fields.get('Title'))).toContain('Local version');
    });

    it.each(['fields', 'binaries', 'tags', 'expiry', 'auto-type', 'custom-data'])(
      'keeps both databases unchanged when same-second edits conflict in %s',
      async (kind) => {
        const db = await database();
        const entry = db.createEntry(db.getDefaultGroup());
        entry.fields.set('Title', 'Original');
        entry.times.lastModTime = new Date('2026-01-01T00:00:00Z');
        using context = await imported(db);
        const { record, bytes, fetch } = context;
        const local = await unlockDatabase({ encryptedBytes: bytes, password });
        const remote = await unlockDatabase({ encryptedBytes: bytes, password });
        const localEntry = local.getDefaultGroup().entries[0];
        const remoteEntry = remote.getDefaultGroup().entries[0];
        localEntry.pushHistory();
        remoteEntry.pushHistory();
        localEntry.fields.set('Title', 'Edited');
        remoteEntry.fields.set('Title', 'Edited');
        localEntry.times.lastModTime = new Date('2026-01-01T00:00:02.100Z');
        remoteEntry.times.lastModTime = new Date('2026-01-01T00:00:02.900Z');
        switch (kind) {
          case 'fields':
            localEntry.fields.set('Password', kdbx.ProtectedValue.fromString('local password'));
            remoteEntry.fields.set('Password', kdbx.ProtectedValue.fromString('remote password'));
            break;
          case 'binaries':
            localEntry.binaries.set('file', await local.binaries.add(new Uint8Array([1]).buffer));
            remoteEntry.binaries.set('file', await remote.binaries.add(new Uint8Array([2]).buffer));
            break;
          case 'tags':
            localEntry.tags = ['local'];
            remoteEntry.tags = ['remote'];
            break;
          case 'expiry':
            localEntry.times.expires = true;
            remoteEntry.times.expires = true;
            localEntry.times.expiryTime = new Date('2026-02-01T00:00:00Z');
            remoteEntry.times.expiryTime = new Date('2026-03-01T00:00:00Z');
            break;
          case 'auto-type':
            localEntry.autoType.defaultSequence = '{PASSWORD}';
            remoteEntry.autoType.defaultSequence = '{USERNAME}';
            break;
          case 'custom-data':
            localEntry.customData = new Map([['setting', { value: 'local' }]]);
            remoteEntry.customData = new Map([['setting', { value: 'remote' }]]);
            break;
        }
        const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(local) });
        const remoteBytes = await toEncryptedBytes(remote);
        fetch.mockClear();
        fetch.mockImplementation(() => Promise.resolve(response(remoteBytes)));

        await expect(syncSession({ record: saved, database: local })).rejects.toThrow(
          'Conflicting entry changes have the same timestamp',
        );

        expect(await getRecord(record.id)).toEqual(saved);
        expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['HEAD', 'GET']);
      },
    );

    it.each(['remote current', 'local current', 'both histories'])(
      'refuses timestamp conflicts involving %s without uploading or changing the pending cache',
      async (kind) => {
        const db = await database();
        const entry = db.createEntry(db.getDefaultGroup());
        entry.fields.set('Title', 'Original');
        entry.times.lastModTime = new Date('2026-01-01T00:00:00Z');
        using context = await imported(db);
        const { record, bytes, fetch } = context;
        const local = await unlockDatabase({ encryptedBytes: bytes, password });
        const remote = await unlockDatabase({ encryptedBytes: bytes, password });
        const localEntry = local.getDefaultGroup().entries[0];
        const remoteEntry = remote.getDefaultGroup().entries[0];
        localEntry.pushHistory();
        localEntry.fields.set('Title', 'Local intermediate');
        localEntry.times.lastModTime = new Date('2026-01-01T00:00:02Z');
        if (kind !== 'local current') {
          localEntry.pushHistory();
          localEntry.fields.set('Title', 'Local final');
          localEntry.times.lastModTime = new Date('2026-01-01T00:00:04Z');
        }
        remoteEntry.pushHistory();
        remoteEntry.fields.set('Title', 'Remote intermediate');
        remoteEntry.times.lastModTime = new Date('2026-01-01T00:00:02Z');
        if (kind !== 'remote current') {
          remoteEntry.pushHistory();
          remoteEntry.fields.set('Title', 'Remote final');
          remoteEntry.times.lastModTime = new Date('2026-01-01T00:00:06Z');
        }
        const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(local) });
        const remoteBytes = await toEncryptedBytes(remote);
        fetch.mockClear();
        fetch.mockImplementation(() => Promise.resolve(response(remoteBytes)));

        await expect(syncSession({ record: saved, database: local })).rejects.toThrow(
          'Conflicting entry changes have the same timestamp',
        );

        expect(await getRecord(record.id)).toEqual(saved);
        expect(saved.type === 'webdav' && isModified(saved)).toBe(true);
        expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['HEAD', 'GET']);
      },
    );

    it('allows same-second edits when the remote version is already in local history', async () => {
      const db = await database();
      const entry = db.createEntry(db.getDefaultGroup());
      entry.fields.set('Title', 'Original');
      entry.times.lastModTime = new Date('2026-01-01T00:00:02.100Z');
      using context = await imported(db);
      const { record, bytes, fetch } = context;
      const local = await unlockDatabase({ encryptedBytes: bytes, password });
      const localEntry = local.getDefaultGroup().entries[0];
      localEntry.pushHistory();
      localEntry.fields.set('Title', 'Edited');
      localEntry.times.lastModTime = new Date('2026-01-01T00:00:02.900Z');
      const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(local) });
      fetch.mockClear();

      const prepared = await syncSession({ record: saved, database: local });
      const merged = prepared.database.getDefaultGroup().entries[0];
      expect(merged.fields.get('Title')).toBe('Edited');
      expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['HEAD', 'GET', 'PUT']);
    });

    it('ignores protection salts, field ordering and access times for otherwise identical entries', async () => {
      const db = await database();
      const entry = db.createEntry(db.getDefaultGroup());
      entry.fields.set('Password', kdbx.ProtectedValue.fromString('same password'));
      using context = await imported(db);
      const { record, bytes, fetch } = context;
      const local = await unlockDatabase({ encryptedBytes: bytes, password });
      const localEntry = local.getDefaultGroup().entries[0];
      localEntry.fields = new Map([...localEntry.fields].toReversed());
      localEntry.fields.set('Password', kdbx.ProtectedValue.fromString('same password'));
      localEntry.times.lastAccessTime = new Date('2026-01-01T00:00:10Z');
      local.createEntry(local.getDefaultGroup()).fields.set('Title', 'New entry');
      const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(local) });

      const prepared = await syncSession({ record: saved, database: local });

      expect(prepared.database.getDefaultGroup().entries.map((version) => version.fields.get('Title'))).toContain(
        'New entry',
      );
      expect(fetch.mock.calls.some((call) => call[1].method === 'PUT')).toBe(true);
    });

    it('checks an unchanged remote without downloading it and preserves metadata', async () => {
      using context = await imported();
      const { record, db, fetch, bytes } = context;
      fetch.mockClear();
      fetch.mockImplementation(() => Promise.resolve(response(bytes, '"imported"')));
      await updateRecord(record.id, (current) => ({ ...current, lastOpenedAt: new Date().toISOString() }));
      const touched = await getRecord(record.id);
      const result = await syncSession({ record, database: db });
      expect(result.record).toEqual(touched);
      expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['HEAD']);
    });

    it('keeps a newer local save dirty when an older upload completes', async () => {
      using context = await imported();
      const { record, db, bytes, fetch } = context;
      db.meta.name = 'First';
      const saved = await recordStorage.update(record, { encryptedBytes: await toEncryptedBytes(db) });
      const put = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      fetch.mockImplementation((_url, options: RequestInit) => {
        if (options.method !== 'PUT') return Promise.resolve(response(bytes));
        started.resolve();
        return put.promise;
      });
      const pass = syncSession({ record: saved, database: db });
      await started.promise;
      db.meta.name = 'Newer';
      await recordStorage.update(saved, { encryptedBytes: await toEncryptedBytes(db) });
      put.resolve(response(new Uint8Array(), '"done"'));
      await pass;
      const stored = await getRecord(record.id);
      expect(stored.type === 'webdav' && isModified(stored)).toBe(true);
      const reopened = await unlockSession({ record: stored, password });
      expect(reopened.database.meta.name).toBe('Newer');
    });
  });
});
