import type kdbxweb from '@/utils/kdbxweb';
import { unlockWebDav } from '@/features/webdav/services/webdav';
import type { WebDavConnection } from '@/features/webdav/repositories/webdav';
import type { Dispatch, SetStateAction } from 'react';
import { updateRecord, type FileRecord, type PersistedFileRecord } from '@/repositories/record';
import { unlockDatabase } from '@/services/database';

export type SetSession = Dispatch<SetStateAction<UnlockSession | null>>;

export type UnlockSession = {
  database: kdbxweb.Kdbx;
  record: FileRecord;
  version: number;
  webDav?: WebDavConnection;
  webDavError?: Error;
};

export const unlockSession = async ({
  record,
  password,
}: {
  record: PersistedFileRecord;
  password: string;
}): Promise<UnlockSession> => {
  if (record.type === 'webdav') return unlockWebDav(record.id, password);
  const database = await unlockDatabase({
    encryptedBytes: record.kdbx.encryptedBytes,
    keyFileHashBase64: record.key?.hash,
    password,
  });

  const updatedRecord = await updateRecord(record.id, (currentRecord) => ({
    ...currentRecord,
    lastOpenedAt: new Date().toISOString(),
  }));

  return { database, record: updatedRecord, version: 0 };
};
