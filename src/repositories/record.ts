import * as z from 'zod/mini';
import { createStore, del, get, set } from 'idb-keyval';
import { Lock } from '@/utils/lock';

export const RECORDS_STORAGE_KEY = 'keeweb-lite.records';

const lock = new Lock('record.repository.storage');

const keySchema = z.object({
  hash: z.string(),
  name: z.string(),
});

const recordKdbxSchema = z.object({
  encryptedBytes: z.instanceof(Uint8Array),
  name: z.string(),
});

const localFileRecordSchema = z.object({
  id: z.string(),
  kdbx: recordKdbxSchema,
  key: z.optional(keySchema),
  lastOpenedAt: z.optional(z.string()),
  type: z.literal('local'),
});

const googleDriveFileRecordSchema = z.object({
  id: z.string(),
  kdbx: recordKdbxSchema,
  key: z.optional(keySchema),
  lastOpenedAt: z.optional(z.string()),
  source: z.object({
    id: z.string(),
    rev: z.optional(z.string()),
  }),
  version: z.optional(z.number()),
  syncedVersion: z.optional(z.number()),
  type: z.literal('google-drive'),
});

const localEditStateSchema = z.object({
  entries: z.optional(z.record(z.string(), z.object({ added: z.array(z.number()), deleted: z.array(z.number()) }))),
  meta: z.optional(
    z.object({
      mntncHistoryDaysChanged: z.optional(z.date()),
      colorChanged: z.optional(z.date()),
      keyChangeRecChanged: z.optional(z.date()),
      keyChangeForceChanged: z.optional(z.date()),
      historyMaxItemsChanged: z.optional(z.date()),
      historyMaxSizeChanged: z.optional(z.date()),
      lastSelectedGroupChanged: z.optional(z.date()),
      lastTopVisibleGroupChanged: z.optional(z.date()),
      memoryProtectionChanged: z.optional(z.date()),
    }),
  ),
});
const webDavFileRecordSchema = z.object({
  ...localFileRecordSchema.shape,
  type: z.literal('webdav'),
  source: z.object({ url: z.url() }),
  synchronization: z.object({
    generation: z.int().check(z.minimum(0)),
    pending: z.boolean(),
    localEditState: z.optional(localEditStateSchema),
  }),
});
export type WebDavFileRecord = z.infer<typeof webDavFileRecordSchema>;
const fileRecordSchema = z.discriminatedUnion('type', [
  localFileRecordSchema,
  googleDriveFileRecordSchema,
  webDavFileRecordSchema,
]);
const fileRecordsSchema = z.array(fileRecordSchema);

type RecordKdbx = z.infer<typeof recordKdbxSchema>;
export type PersistedFileRecord = z.infer<typeof fileRecordSchema>;

// never persisted: intentionally excluded from fileRecordSchema so it can never pass
// getRecords/createRecord/updateRecord validation and land in IndexedDB
type DemoFileRecord = {
  id: string;
  type: 'demo';
  kdbx: Pick<RecordKdbx, 'name'>;
};

export type FileRecord = PersistedFileRecord | DemoFileRecord;

export const equalBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const decodeRecords = (value: unknown): PersistedFileRecord[] => {
  if (value == null) return [];
  const result = fileRecordsSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Saved database records are unsupported or corrupt. Browser data has been left untouched.');
  }
  return result.data;
};

const credentialKey = (id: string) => `keeweb-lite.credentials.${id}`;
const webDavStore = createStore('keyval-store', 'keyval');

const transactWebDav = <T>(
  apply: (records: PersistedFileRecord[], store: IDBObjectStore) => T,
  signal?: AbortSignal,
): Promise<T> =>
  lock.runInLock(() =>
    webDavStore(
      'readwrite',
      (store) =>
        new Promise<T>((resolve, reject) => {
          const transaction = store.transaction;
          let result: T;
          let failure: unknown;
          const abort = () => {
            failure = signal?.reason;
            transaction.abort();
          };
          transaction.oncomplete = () => {
            signal?.removeEventListener('abort', abort);
            resolve(result);
          };
          transaction.onabort = transaction.onerror = () => {
            signal?.removeEventListener('abort', abort);
            reject(failure ?? transaction.error ?? new Error('Database transaction aborted.'));
          };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) {
            abort();
            return;
          }
          const request = store.get(RECORDS_STORAGE_KEY);
          request.onsuccess = () => {
            try {
              signal?.throwIfAborted();
              result = apply(decodeRecords(request.result), store);
            } catch (error) {
              if (!signal?.aborted) {
                failure = error;
                transaction.abort();
              }
            }
          };
        }),
    ),
  );

const readRecords = async () => {
  const value = await get<unknown>(RECORDS_STORAGE_KEY);
  if (value == null) {
    return [];
  }

  const parseResult = fileRecordsSchema.safeParse(value);
  if (parseResult.success) {
    return parseResult.data;
  }

  // stored data is only written by this app and always matches the schema, so this isn't expected to happen
  // in production; it's a safety net that keeps the data untouched so the user can fix it by hand
  console.error('Invalid stored records:', parseResult.error);

  throw new Error(
    `Saved records can't be read. Fix the "${RECORDS_STORAGE_KEY}" key in this site's IndexedDB, ` +
      `or clear this site's data to start over (this deletes all local databases).`,
    { cause: parseResult.error },
  );
};

export const getRecords = async () => {
  return lock.runInLock(readRecords);
};

export type SyncableRecord = Extract<PersistedFileRecord, { source: unknown }>;

const isSyncable = (record: PersistedFileRecord): record is SyncableRecord => 'source' in record;

// `version` counts the local saves and `syncedVersion` is the version that was last synced,
// a record that was never synced has no `syncedVersion`
export const isModified = ({ version = 0, syncedVersion }: SyncableRecord) => syncedVersion !== version;

export const markSaved = (record: PersistedFileRecord): PersistedFileRecord =>
  isSyncable(record) ? { ...record, version: (record.version ?? 0) + 1 } : record;

export const getRecord = async (recordId: string) => {
  const records = await getRecords();
  const record = records.find(({ id }) => id === recordId);
  if (!record) {
    throw new Error('Record not found.');
  }

  return record;
};

export const getSyncableRecord = async (recordId: string) => {
  const record = await getRecord(recordId);
  if (!isSyncable(record)) {
    throw new Error('Record does not sync.');
  }

  return record;
};

const updateRecords = async <Update extends { nextRecords: PersistedFileRecord[]; result?: unknown }>(
  updater: (oldRecords: PersistedFileRecord[]) => Update,
): Promise<Update['result']> => {
  return lock.runInLock(async () => {
    const update = updater(await readRecords());
    await set(RECORDS_STORAGE_KEY, update.nextRecords);

    return update.result;
  });
};

export const clearRecords = async () => {
  await lock.runInLock(async () => {
    await del(RECORDS_STORAGE_KEY);
  });
};

export const createRecord = async (record: PersistedFileRecord) => {
  const parsedRecord = fileRecordSchema.parse(record);

  return updateRecords((oldRecords) => {
    const existingRecord = oldRecords.find(({ id }) => id === parsedRecord.id);
    if (existingRecord) {
      throw new Error(`Record with id ${parsedRecord.id} already exists`);
    }

    return { nextRecords: [...oldRecords, parsedRecord], result: parsedRecord };
  });
};

export const removeRecord = async (recordId: string) => {
  await transactWebDav((records, store) => {
    const current = records.find(({ id }) => id === recordId);
    if (current?.type === 'webdav') store.delete(credentialKey(recordId));
    store.put(
      records.filter(({ id }) => id !== recordId),
      RECORDS_STORAGE_KEY,
    );
  });
};

export const updateRecord = async (recordId: string, update: (record: PersistedFileRecord) => PersistedFileRecord) => {
  return updateRecords((oldRecords) => {
    const record = oldRecords.find(({ id }) => id === recordId);
    if (!record) {
      throw new Error('Record not found.');
    }

    const nextRecord = fileRecordSchema.parse(update(record));
    const nextRecords = oldRecords.map((currentRecord) => (currentRecord.id === recordId ? nextRecord : currentRecord));

    return { nextRecords, result: nextRecord };
  });
};

export const updateSyncableRecord = async (recordId: string, update: (record: SyncableRecord) => SyncableRecord) => {
  return updateRecord(recordId, (record) => {
    if (!isSyncable(record)) {
      throw new Error('Record does not sync.');
    }

    return update(record);
  });
};
export const getWebDavCredentials = (id: string) => get<Uint8Array>(credentialKey(id));

export const createWebDavRecovery = (record: Extract<PersistedFileRecord, { type: 'local' }>, signal?: AbortSignal) =>
  transactWebDav((records, store) => {
    const parsed = localFileRecordSchema.parse(record);
    if (records.some((row) => row.id === parsed.id)) throw new Error('This database record already exists.');
    store.put([...records, parsed], RECORDS_STORAGE_KEY);
    return parsed;
  }, signal);

export const insertWebDavRecord = async (
  record: WebDavFileRecord,
  credentials: Uint8Array,
  signal?: AbortSignal,
  recoveryBytes?: Uint8Array,
) =>
  transactWebDav((records, store) => {
    const parsed = webDavFileRecordSchema.parse(record);
    const current = records.find(({ id }) => id === parsed.id);
    if (recoveryBytes) {
      if (current?.type !== 'local' || !equalBytes(current.kdbx.encryptedBytes, recoveryBytes)) {
        throw new Error('The local recovery database changed or was removed.');
      }
    } else if (current) throw new Error('This database record already exists.');
    if (records.some((row) => row.type === 'webdav' && row.source.url === parsed.source.url)) {
      throw new Error('A record for this WebDAV file already exists.');
    }
    store.put(
      recoveryBytes ? records.map((row) => (row.id === parsed.id ? parsed : row)) : [...records, parsed],
      RECORDS_STORAGE_KEY,
    );
    store.put(credentials, credentialKey(parsed.id));
    return parsed;
  }, signal);

type WebDavUpdateResult =
  { status: 'applied'; record: WebDavFileRecord } | { status: 'superseded' } | { status: 'missing' };

export const updateWebDavRecord = ({
  id,
  generation,
  change,
  signal,
  accept = () => true,
}: {
  id: string;
  generation: number;
  change:
    | { kind: 'touch' }
    | {
        kind: 'save';
        bytes: Uint8Array;
        localEditState: NonNullable<WebDavFileRecord['synchronization']['localEditState']>;
      }
    | { kind: 'sync'; bytes: Uint8Array };
  signal?: AbortSignal;
  accept?: () => boolean;
}): Promise<WebDavUpdateResult> =>
  transactWebDav((records, store): WebDavUpdateResult => {
    const current = records.find((row) => row.id === id);
    if (current?.type !== 'webdav') return { status: 'missing' };
    if (current.synchronization.generation !== generation || !accept()) return { status: 'superseded' };
    const record: WebDavFileRecord =
      change.kind === 'touch'
        ? { ...current, lastOpenedAt: new Date().toISOString() }
        : {
            ...current,
            kdbx: { ...current.kdbx, encryptedBytes: change.bytes.slice() },
            synchronization: {
              generation:
                generation + (change.kind === 'save' || !equalBytes(current.kdbx.encryptedBytes, change.bytes) ? 1 : 0),
              pending: change.kind === 'save',
              ...(change.kind === 'save' ? { localEditState: change.localEditState } : {}),
            },
          };
    store.put(
      records.map((row) => (row.id === id ? record : row)),
      RECORDS_STORAGE_KEY,
    );
    return { status: 'applied', record };
  }, signal);
