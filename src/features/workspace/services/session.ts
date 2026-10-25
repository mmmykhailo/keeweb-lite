import type kdbxweb from '@/utils/kdbxweb';
import {
  getSyncableRecord,
  isModified,
  updateSyncableRecord,
  type FileRecord,
  type SyncableRecord,
} from '@/repositories/record';
import { loadDatabase, toEncryptedBytes } from '@/services/database';
import { getProvider } from '@/services/provider-registry';
import { SyncConflictError, type Sync } from '@/services/provider';
import { isSameBytes } from '@/utils/buffer';
import { Lock } from '@/utils/lock';

const updateRecordDatabaseLock = new Lock('record.service.update-record-database');

export const updateRecordDatabase = async <Result>({
  database,
  record,
  update,
}: {
  database: kdbxweb.Kdbx;
  record: FileRecord;
  update: (nextDatabase: kdbxweb.Kdbx) => Result | Promise<Result>;
}): Promise<[nextDatabase: kdbxweb.Kdbx, nextRecord: FileRecord, result: Result]> => {
  return updateRecordDatabaseLock.runInLock(async () => {
    const { storage } = getProvider(record);
    const nextDatabase = await storage.load({ database, record });
    const result = await update(nextDatabase);
    const nextRecord = await storage.update(record, {
      encryptedBytes: await toEncryptedBytes(nextDatabase),
      localEditState: nextDatabase.getLocalEditState(),
    });

    return [nextDatabase, nextRecord, result];
  });
};

type SyncSessionResult = {
  database: kdbxweb.Kdbx;
  record: FileRecord;
};

type Synced = {
  encryptedBytes: Uint8Array<ArrayBuffer>;
  source: SyncableRecord['source'];
};

const syncSessionLock = new Lock('session.service.sync-session');

const MAX_SYNC_ATTEMPTS = 3;

export const syncSession = async ({
  record,
  database,
  sync: preparedSync,
}: {
  record: FileRecord;
  database: kdbxweb.Kdbx;
  sync?: Sync<FileRecord, unknown> | Error;
}): Promise<SyncSessionResult> => {
  const provider = getProvider(record);
  const configuredSync = preparedSync ?? provider.sync;
  if (configuredSync instanceof Error) throw configuredSync;
  const sync = typeof configuredSync === 'function' ? await configuredSync({ record, database }) : configuredSync;
  const { label } = provider;
  if (!sync) {
    throw new Error(`${label} does not support sync.`);
  }

  const load = (encryptedBytes: Uint8Array, localEditState?: SyncableRecord['localEditState']) =>
    loadDatabase({ encryptedBytes, credentials: database.credentials, localEditState });

  const merge = async (local: SyncableRecord, remoteBytes: Uint8Array) => {
    const merged = await load(local.kdbx.encryptedBytes, local.localEditState);
    merged.merge(await load(remoteBytes));

    return merged;
  };

  // remote only: brings the snapshot and the remote file to the same state, without writing the local record
  const syncSnapshot = async (snapshot: SyncableRecord): Promise<Synced | undefined> => {
    const isLocalChanged = isModified(snapshot);
    const { data, isRemoteChanged } = (await sync.check?.(snapshot)) ?? { data: undefined, isRemoteChanged: true };

    if (!isLocalChanged && !isRemoteChanged) {
      return undefined;
    }

    const remote = isRemoteChanged ? await sync.pull(snapshot, data) : undefined;
    if (remote && !isLocalChanged) {
      return { encryptedBytes: remote.bytes, source: remote.source };
    }

    const encryptedBytes = remote
      ? await toEncryptedBytes(await merge(snapshot, remote.bytes))
      : snapshot.kdbx.encryptedBytes;

    return { encryptedBytes, source: await sync.push(snapshot, encryptedBytes, data) };
  };

  // local only: merges the result into what is stored now, like any other change, and marks only the
  // snapshot version as synced, so saves made during the sync are kept and uploaded by the next one
  const apply = (snapshot: SyncableRecord, synced: Synced) =>
    updateRecordDatabaseLock.runInLock(async () => {
      const stored = await getSyncableRecord(record.id);
      const nextDatabase = isSameBytes(stored.kdbx.encryptedBytes, snapshot.kdbx.encryptedBytes)
        ? await load(synced.encryptedBytes)
        : await merge(stored, synced.encryptedBytes);
      const encryptedBytes = isSameBytes(stored.kdbx.encryptedBytes, snapshot.kdbx.encryptedBytes)
        ? synced.encryptedBytes
        : await toEncryptedBytes(nextDatabase);
      const state = nextDatabase.getLocalEditState();
      const localEditState =
        (stored.version ?? 0) === (snapshot.version ?? 0)
          ? undefined
          : {
              entries: Object.fromEntries(
                Object.entries(state.entries ?? {}).map(([id, entry]) => [
                  id,
                  {
                    added: entry.added.filter((time) => !snapshot.localEditState?.entries?.[id]?.added.includes(time)),
                    deleted: entry.deleted.filter(
                      (time) => !snapshot.localEditState?.entries?.[id]?.deleted.includes(time),
                    ),
                  },
                ]),
              ),
              meta: Object.fromEntries(
                Object.entries(state.meta ?? {}).filter(
                  ([key, date]) =>
                    date instanceof Date &&
                    !Object.entries(snapshot.localEditState?.meta ?? {}).some(
                      ([uploadedKey, uploadedDate]) =>
                        key === uploadedKey && date.getTime() === uploadedDate?.getTime(),
                    ),
                ),
              ),
            };
      nextDatabase.removeLocalEditState();
      if (localEditState) nextDatabase.setLocalEditState(localEditState);

      const nextRecord = await updateSyncableRecord(stored.id, (current) => {
        const next = {
          ...current,
          kdbx: { ...current.kdbx, encryptedBytes },
          syncedVersion: snapshot.version ?? 0,
          localEditState,
        };
        if (next.type === 'webdav' && 'url' in synced.source) return { ...next, source: synced.source };
        if (next.type === 'google-drive' && 'id' in synced.source) return { ...next, source: synced.source };
        throw new Error('The provider returned an invalid sync source.');
      });

      return { database: nextDatabase, record: nextRecord };
    });

  const syncOnce = async (): Promise<SyncSessionResult> => {
    const snapshot = await getSyncableRecord(record.id);
    const synced = await syncSnapshot(snapshot);

    return synced
      ? apply(snapshot, synced)
      : { database: await load(snapshot.kdbx.encryptedBytes, snapshot.localEditState), record: snapshot };
  };

  return syncSessionLock.runInLock(async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await syncOnce();
      } catch (error) {
        if (!(error instanceof SyncConflictError) || attempt >= MAX_SYNC_ATTEMPTS) {
          throw error;
        }
      }
    }
  });
};
