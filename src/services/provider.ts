import type kdbxweb from '@/utils/kdbxweb';
import type { ComponentType } from 'react';
import { getRecord, updateRecord, type FileRecord, type PersistedFileRecord } from '@/repositories/record';
import { loadDatabase, toEncryptedBytes, unlockDatabase } from '@/services/database';
import { kebabCaseToTitle } from '@/utils/string';
import type { UnlockSession } from '@/features/unlock/services/session';

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
};

type StorageInput<Record extends FileRecord> = {
  database: kdbxweb.Kdbx;
  record: Record;
  signal?: AbortSignal;
};

export type RecordStorage<Record extends FileRecord = FileRecord> = {
  load: (input: StorageInput<Record>) => Promise<kdbxweb.Kdbx>;
  save: (input: StorageInput<Record>) => Promise<FileRecord>;
};

export const recordStorage: RecordStorage = {
  load: async ({ database, record }) => {
    const { kdbx } = await getRecord(record.id);

    return loadDatabase({ encryptedBytes: kdbx.encryptedBytes, credentials: database.credentials });
  },
  save: async ({ database, record, signal }) => {
    const encryptedBytes = await toEncryptedBytes(database);

    return updateRecord(record.id, (currentRecord) => {
      signal?.throwIfAborted();
      return { ...currentRecord, kdbx: { ...currentRecord.kdbx, encryptedBytes } };
    });
  },
};

type RecordsByType = { [Record in FileRecord as Record['type']]: Record };
export type RecordOf<Type extends FileRecord['type']> = RecordsByType[Type];

export type SyncOptions = {
  signal?: AbortSignal;
  canApply?: () => boolean;
  onApply?: () => void;
};

export type SyncResult = { database: kdbxweb.Kdbx; record: FileRecord };

export type SessionConnection = {
  signal: AbortSignal;
  dispose: () => void;
  sync?: (options: SyncOptions) => Promise<SyncResult>;
};

export type SyncInput<Record extends FileRecord = FileRecord> = StorageInput<Record> &
  SyncOptions & { connection?: SessionConnection };

export type Provider<Type extends FileRecord['type'] = FileRecord['type']> = {
  type: Type;
  label: string;
  isConfigured: () => boolean;
  scripts?: string[];
  unlock: (input: { record: PersistedFileRecord; password: string }) => Promise<UnlockSession>;
  storage: RecordStorage<RecordOf<Type>>;
  sync?: (input: SyncInput<RecordOf<Type>>) => Promise<SyncResult>;
  ImportDialog?: ComponentType<DialogProps>;
  CreateDialog?: ComponentType<DialogProps>;
};

type ProviderConfig<Type extends FileRecord['type']> = Pick<Provider<Type>, 'type'> &
  Partial<Omit<Provider<Type>, 'type'>>;

export const defineProvider = <Type extends FileRecord['type']>(provider: ProviderConfig<Type>): Provider<Type> => ({
  label: kebabCaseToTitle(provider.type),
  isConfigured: () => true,
  storage: recordStorage,
  unlock: async ({ record, password }) => {
    const database = await unlockDatabase({
      encryptedBytes: record.kdbx.encryptedBytes,
      keyFileHashBase64: record.key?.hash,
      password,
    });
    const updatedRecord = await updateRecord(record.id, (current) => ({
      ...current,
      lastOpenedAt: new Date().toISOString(),
    }));
    const controller = new AbortController();
    return {
      database,
      record: updatedRecord,
      version: 0,
      connection: { signal: controller.signal, dispose: () => controller.abort() },
    };
  },
  ...provider,
});
