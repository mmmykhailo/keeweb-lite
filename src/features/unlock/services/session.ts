import type kdbxweb from '@/utils/kdbxweb';
import type { SessionConnection } from '@/services/provider';
import type { Dispatch, SetStateAction } from 'react';
import type { FileRecord, PersistedFileRecord } from '@/repositories/record';
import { getProvider } from '@/services/provider-registry';

export type SetSession = Dispatch<SetStateAction<UnlockSession | null>>;

export type UnlockSession = {
  database: kdbxweb.Kdbx;
  record: FileRecord;
  version: number;
  connection?: SessionConnection;
};

export const unlockSession = async ({
  record,
  password,
}: {
  record: PersistedFileRecord;
  password: string;
}): Promise<UnlockSession> => getProvider(record).unlock({ record, password });
