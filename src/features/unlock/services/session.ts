import type kdbxweb from '@/utils/kdbxweb';
import type { Dispatch, SetStateAction } from 'react';
import { updateRecord, type FileRecord, type PersistedFileRecord } from '@/repositories/record';
import { unlockDatabase } from '@/services/database';
import { getProvider } from '@/services/provider-registry';
import type { Sync } from '@/services/provider';

export type SetSession = Dispatch<SetStateAction<UnlockSession | null>>;

export type UnlockSession = {
  database: kdbxweb.Kdbx;
  record: FileRecord;
  version: number;
  sync?: Sync<FileRecord, unknown> | Error;
};

export const unlockSession = async ({
  record,
  password,
}: {
  record: PersistedFileRecord;
  password: string;
}): Promise<UnlockSession> => {
  const database = await unlockDatabase({
    encryptedBytes: record.kdbx.encryptedBytes,
    keyFileHashBase64: record.key?.hash,
    password,
  });

  const updatedRecord = await updateRecord(record.id, (currentRecord) => ({
    ...currentRecord,
    lastOpenedAt: new Date().toISOString(),
  }));

  const { sync } = getProvider(updatedRecord);
  const sessionSync =
    typeof sync === 'function'
      ? await sync({ record: updatedRecord, database }).catch((error: unknown) =>
          error instanceof Error ? error : new Error('Unable to unlock provider credentials.'),
        )
      : sync;
  return { database, record: updatedRecord, version: 0, sync: sessionSync };
};
