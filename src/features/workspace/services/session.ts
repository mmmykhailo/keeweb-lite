import type kdbxweb from '@/utils/kdbxweb';
import type { FileRecord } from '@/repositories/record';
import { getProvider } from '@/services/provider-registry';
import type { SyncInput } from '@/services/provider';
import { Lock } from '@/utils/lock';

const updateRecordDatabaseLock = new Lock('record.service.update-record-database');

export const updateRecordDatabase = async <Result>({
  database,
  record,
  update,
  signal,
}: {
  database: kdbxweb.Kdbx;
  record: FileRecord;
  signal?: AbortSignal;
  update: (nextDatabase: kdbxweb.Kdbx) => Result | Promise<Result>;
}): Promise<[nextDatabase: kdbxweb.Kdbx, nextRecord: FileRecord, result: Result]> => {
  return updateRecordDatabaseLock.runInLock(async () => {
    signal?.throwIfAborted();
    const { storage } = getProvider(record);
    const nextDatabase = await storage.load({ database, record, signal });
    signal?.throwIfAborted();
    const result = await update(nextDatabase);
    signal?.throwIfAborted();
    const nextRecord = await storage.save({ database: nextDatabase, record, signal });

    return [nextDatabase, nextRecord, result];
  });
};

const syncSessionLock = new Lock('session.service.sync-session');

export const syncSession = async (input: SyncInput) => {
  const { sync, label } = getProvider(input.record);
  if (!sync) {
    throw new Error(`${label} does not support sync.`);
  }

  return syncSessionLock.runInLock(() => sync(input));
};
