import kdbx from '@/utils/kdbxweb';
import { createFileList } from '@tests/utils/file-list';
import { get, set } from 'idb-keyval';
import { describe, expect, it, vi } from 'vitest';
import {
  RECORDS_STORAGE_KEY,
  createRecord,
  getRecord,
  getRecords,
  getWebDavCredentials,
  insertWebDavRecord,
  removeRecord,
  updateWebDavRecord,
  type WebDavFileRecord,
} from '@/repositories/record';
import { createWebDavConnection } from '@/features/webdav/repositories/webdav';
import {
  acceptWebDavSync,
  createWebDavRecord,
  importWebDavRecord,
  prepareWebDavSync,
  saveWebDav,
  unlockWebDav,
} from '@/features/webdav/services/webdav';
import { cloneDatabase } from '@/services/database';
import { toEncryptedBytes, unlockDatabase } from '@/services/database';

const setup = { url: 'https://dav.example/vault.kdbx', username: 'user', password: 'server-password' };
const password = 'database-password';
const response = (bytes: Uint8Array, etag = '"remote"') =>
  new Response(bytes.slice().buffer, { headers: { ETag: etag } });

const database = async (key?: Uint8Array) => {
  const credentials = new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key);
  await credentials.ready;
  return kdbx.Kdbx.create(credentials, 'Vault');
};
const imported = async (db?: kdbx.Kdbx) => {
  db ??= await database();
  const bytes = await toEncryptedBytes(db);
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(response(bytes)));
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
  const record = await importWebDavRecord({ ...setup, databasePassword: password });
  return { db, bytes, record, fetch, [Symbol.dispose]: () => fetchSpy.mockRestore() };
};
const prepare = (record: WebDavFileRecord, db: kdbx.Kdbx, connection = createWebDavConnection(setup)) =>
  prepareWebDavSync({
    id: record.id,
    credentials: db.credentials,
    connection,
    signal: connection.signal,
    canApply: () => true,
  });

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
      await saveWebDav(record, db);
      await removeRecord(record.id);
      expect(await get(RECORDS_STORAGE_KEY)).toEqual([local, drive]);
      expect(await getWebDavCredentials(record.id)).toBeUndefined();
    });

    it.each([false, 'bad', { version: 1, records: [] }, [{ type: 'webdav', id: 'legacy' }]])(
      'refuses reads and writes of unsupported stores without modifying %j',
      async (stored) => {
        await set(RECORDS_STORAGE_KEY, stored);
        await expect(getRecords()).rejects.toThrow(/Saved/);
        await expect(
          createRecord({ id: 'new', type: 'local', kdbx: { name: 'new', encryptedBytes: new Uint8Array() } }),
        ).rejects.toThrow(/Saved/);
        await expect(removeRecord('new')).rejects.toThrow(/Saved/);
        expect(await get(RECORDS_STORAGE_KEY)).toEqual(stored);
      },
    );

    it('rejects wrong database factors and canceled KDF without saving credentials', async () => {
      const db = await database();
      const bytes = await toEncryptedBytes(db);
      using _fetch0 = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(vi.fn().mockImplementation(() => Promise.resolve(response(bytes))));
      await expect(importWebDavRecord({ ...setup, databasePassword: 'wrong' })).rejects.toThrow('Invalid password');
      const controller = new AbortController();
      const load = kdbx.Kdbx.load;
      using _load = vi.spyOn(kdbx.Kdbx, 'load').mockImplementation(async (...args) => {
        const result = await load(...args);
        controller.abort();
        return result;
      });
      await expect(
        importWebDavRecord({ ...setup, databasePassword: password, signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(await getRecords()).toEqual([]);
    });

    it('makes duplicate URL insertion atomic and cancellation rolls both writes back', async () => {
      using context = await imported();
      const { record } = context;
      await removeRecord(record.id);
      const attempts = await Promise.allSettled([
        insertWebDavRecord(record, new Uint8Array([1])),
        insertWebDavRecord({ ...record, id: 'duplicate' }, new Uint8Array([2])),
      ]);
      expect(attempts.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(await getWebDavCredentials('duplicate')).toBeUndefined();
      await removeRecord(record.id);
      const controller = new AbortController();
      const put = IDBObjectStore.prototype.put;
      using _put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        const request = put.apply(this, args);
        if (args[1] === RECORDS_STORAGE_KEY) controller.abort();
        return request;
      });
      await expect(insertWebDavRecord(record, new Uint8Array([1]), controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(await getRecords()).toEqual([]);
      expect(await getWebDavCredentials(record.id)).toBeUndefined();
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
        using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(vi.fn().mockResolvedValue(response(bytes)));
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
        const session = await unlockWebDav(record.id, password);
        expect(session.webDavError).toBeUndefined();
        session.webDav?.dispose();
      },
    );

    it('unlocks cached data without network when saved credentials are broken', async () => {
      using context = await imported();
      const { record, fetch } = context;
      await set(`keeweb-lite.credentials.${record.id}`, new Uint8Array([0]));
      fetch.mockClear();
      const session = await unlockWebDav(record.id, password);
      expect(session.database.meta.name).toBe('Vault');
      expect(session.webDavError).toBeInstanceOf(Error);
      expect(session.webDav).toBeDefined();
      expect(fetch).not.toHaveBeenCalled();
      session.webDav?.dispose();
      expect((await saveWebDav(record, session.database)).synchronization.pending).toBe(true);
    });

    it('rejects a cache changed during unlock without overwriting it to touch metadata', async () => {
      using context = await imported();
      const { record } = context;
      const load = kdbx.Kdbx.load;
      let changed = false;
      using _load = vi.spyOn(kdbx.Kdbx, 'load').mockImplementation(async (...args) => {
        const db = await load(...args);
        if (!changed) {
          changed = true;
          await updateWebDavRecord({
            id: record.id,
            generation: 0,
            change: { kind: 'save', bytes: record.kdbx.encryptedBytes, localEditState: {} },
          });
        }
        return db;
      });
      await expect(unlockWebDav(record.id, password)).rejects.toThrow('changed or was removed');
      const current = await getRecord(record.id);
      expect(current.lastOpenedAt).toBeUndefined();
    });
  });

  describe('WebDAV creation recovery', () => {
    it.each(['failure', 'exists', 'canceled', 'uncertain'])(
      'keeps a local database and generated key after %s',
      async (kind) => {
        const controller = new AbortController();
        const fetch = vi.fn().mockImplementation(async (_url, options: RequestInit) => {
          expect((await getRecords())[0].type).toBe('local');
          expect(new Headers(options.headers).get('If-None-Match')).toBe('*');
          if (kind === 'canceled') {
            controller.abort();
            throw controller.signal.reason;
          }
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
          signal: controller.signal,
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
      },
    );

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
    it('decrypts each snapshot once when merging pending changes', async () => {
      using context = await imported();
      const { record, db } = context;
      db.createEntry(db.getDefaultGroup()).fields.set('Title', 'Local entry');
      const saved = await saveWebDav(record, db);
      using load = vi.spyOn(kdbx.Kdbx, 'load');

      const candidate = await prepare(saved, db);

      expect(candidate.database.getDefaultGroup().entries[0].fields.get('Title')).toBe('Local entry');
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('pulls clean changes without uploading and commits the matching model and row', async () => {
      using context = await imported();
      const { record, db, fetch } = context;
      db.meta.name = 'Remote update';
      const bytes = await toEncryptedBytes(db);
      fetch.mockImplementation(() => Promise.resolve(response(bytes)));
      const candidate = await prepare(record, db);
      expect(await getRecord(record.id)).toEqual(record);
      const result = await acceptWebDavSync(candidate, new AbortController().signal, () => true);
      expect(result.status).toBe('applied');
      expect(candidate.database.meta.name).toBe('Remote update');
      expect((await getRecord(record.id)).kdbx.encryptedBytes).toEqual(bytes);
      expect(fetch.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    });

    it('uses native merge for independent edits and keeps history tombstones through clone/save/reload', async () => {
      const db = await database();
      const entry = db.createEntry(db.getDefaultGroup());
      entry.fields.set('Title', 'Original');
      entry.pushHistory();
      entry.fields.set('Title', 'Second');
      entry.times.update();
      entry.times.lastModTime = new Date(Date.now() + 1000);
      using context = await imported(db);
      const { record, bytes, fetch } = context;
      const local = await cloneDatabase(db);
      const edited = local.getDefaultGroup().entries[0];
      edited.removeHistory(0, 1);
      edited.pushHistory();
      edited.fields.set('Title', 'Local');
      edited.times.lastModTime = new Date(Date.now() + 3000);
      const state = structuredClone(local.getLocalEditState());
      expect((await cloneDatabase(local)).getLocalEditState()).toEqual(state);
      const saved = await saveWebDav(record, local);
      const reopened = await unlockWebDav(record.id, password);
      expect(reopened.database.getLocalEditState()).toEqual(state);
      const remote = await unlockDatabase({ encryptedBytes: bytes, password });
      remote.createEntry(remote.getDefaultGroup()).fields.set('Title', 'Remote entry');
      const remoteBytes = await toEncryptedBytes(remote);
      fetch.mockImplementation((_url, options: RequestInit) =>
        Promise.resolve(options.method === 'GET' ? response(remoteBytes) : response(new Uint8Array(), '"confirmed"')),
      );
      const candidate = await prepare(saved, local);
      expect(candidate.database.getDefaultGroup().entries.map((row) => row.fields.get('Title'))).toEqual([
        'Local',
        'Remote entry',
      ]);
      const commit = await acceptWebDavSync(candidate, new AbortController().signal, () => true);
      expect(commit.status).toBe('applied');
      const current = await getRecord(record.id);
      if (current.type !== 'webdav') throw new Error('Expected WebDAV.');
      expect(current.synchronization).not.toHaveProperty('localEditState');
      expect(current.synchronization.pending).toBe(false);
      expect(candidate.database.getLocalEditState().entries).toEqual({});
      reopened.webDav?.dispose();
    });

    it('stops after three stale-write attempts and keeps local pending data', async () => {
      using context = await imported();
      const { record, db, bytes, fetch } = context;
      db.meta.name = 'Local';
      const saved = await saveWebDav(record, db);
      fetch.mockClear();
      fetch.mockImplementation((_url, options: RequestInit) =>
        Promise.resolve(options.method === 'GET' ? response(bytes) : new Response(null, { status: 412 })),
      );
      await expect(prepare(saved, db)).rejects.toThrow('kept changing');
      expect(fetch.mock.calls.filter((call) => call[1].method === 'PUT')).toHaveLength(3);
      expect(await getRecord(record.id)).toEqual(saved);
    });

    it.each(['identity', 'factors', 'missing', 'weak'])('retains the exportable cache on %s failure', async (kind) => {
      using context = await imported();
      const { record, db, fetch, bytes } = context;
      db.meta.name = 'Local';
      const saved = await saveWebDav(record, db);
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
      await expect(prepare(saved, db)).rejects.toThrow();
      expect(await getRecord(record.id)).toEqual(saved);
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
      const saved = await saveWebDav(record, local);
      const remote = await unlockDatabase({ encryptedBytes: bytes, password });
      const remoteEntry = remote.getDefaultGroup().entries[0];
      remoteEntry.pushHistory();
      remoteEntry.fields.set('Title', 'Remote version');
      remoteEntry.times.lastModTime = new Date('2026-01-01T00:00:04Z');
      const remoteBytes = await toEncryptedBytes(remote);
      fetch.mockImplementation((_url, options: RequestInit) =>
        Promise.resolve(options.method === 'GET' ? response(remoteBytes) : response(new Uint8Array())),
      );
      const candidate = await prepare(saved, local);
      expect(candidate.database.getDefaultGroup().entries).toHaveLength(1);
      const merged = candidate.database.getDefaultGroup().entries[0];
      expect(merged.fields.get('Title')).toBe('Remote version');
      expect(merged.history.map((item) => item.fields.get('Title'))).toContain('Local version');
    });

    it('rejects a local Save canceled during encryption', async () => {
      using context = await imported();
      const { record, db } = context;
      const serialized = await db.save();
      const encryption = Promise.withResolvers<ArrayBuffer>();
      using _save = vi.spyOn(db, 'save').mockReturnValue(encryption.promise);
      const controller = new AbortController();
      const saving = saveWebDav(record, db, controller.signal);
      controller.abort();
      encryption.resolve(serialized);
      await expect(saving).rejects.toMatchObject({ name: 'AbortError' });
      expect(await getRecord(record.id)).toEqual(record);
    });

    it('confirms identical remote bytes without PUT and preserves a metadata-only touch', async () => {
      using context = await imported();
      const { record, db, fetch } = context;
      const saved = await saveWebDav(record, db);
      fetch.mockImplementation(() => Promise.resolve(response(saved.kdbx.encryptedBytes)));
      const candidate = await prepare(saved, db);
      const touched = await updateWebDavRecord({
        id: record.id,
        generation: saved.synchronization.generation,
        change: { kind: 'touch' },
      });
      const result = await acceptWebDavSync(candidate, new AbortController().signal, () => true);
      expect(result.status).toBe('applied');
      if (result.status === 'applied' && touched.status === 'applied') {
        expect(result.record.lastOpenedAt).toBe(touched.record.lastOpenedAt);
        expect(result.record.synchronization.generation).toBe(saved.synchronization.generation);
      }
      expect(fetch.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
    });

    it('rejects old PUT completion after a newer local Save without clearing its edit state', async () => {
      using context = await imported();
      const { record, db, bytes, fetch } = context;
      db.meta.name = 'First';
      const saved = await saveWebDav(record, db);
      const put = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      fetch.mockImplementation((_url, options: RequestInit) => {
        if (options.method === 'GET') return Promise.resolve(response(bytes));
        started.resolve();
        return put.promise;
      });
      const pass = prepare(saved, db);
      await started.promise;
      db.meta.name = 'Newer';
      const newer = await saveWebDav(saved, db);
      put.resolve(response(new Uint8Array(), '"done"'));
      const candidate = await pass;
      expect(await acceptWebDavSync(candidate, new AbortController().signal, () => true)).toEqual({
        status: 'superseded',
      });
      expect(await getRecord(record.id)).toEqual(newer);
    });

    it('does not commit after lock, removal, or a final editor gate change', async () => {
      using context = await imported();
      const { record, db } = context;
      const candidate = await prepare(record, db);
      const controller = new AbortController();
      controller.abort();
      await expect(acceptWebDavSync(candidate, controller.signal, () => true)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(await acceptWebDavSync(candidate, new AbortController().signal, () => false)).toEqual({
        status: 'superseded',
      });
      await removeRecord(record.id);
      expect(await acceptWebDavSync(candidate, new AbortController().signal, () => true)).toEqual({
        status: 'missing',
      });
      expect(await getRecords()).toEqual([]);
      expect(await getWebDavCredentials(record.id)).toBeUndefined();
    });
  });
});
