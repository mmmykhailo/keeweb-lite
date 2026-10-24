import { CreateGoogleDriveDialog } from '@/features/google-drive/components/create-dialog';
import { ImportGoogleDriveDialog } from '@/features/google-drive/components/import-dialog';
import { getFile, isGoogleDriveConfigured, updateFile } from '@/features/google-drive/repositories/google-drive';
import { defineProvider } from '@/services/provider';
import { loadDatabase, toEncryptedBytes } from '@/services/database';

export const googleDriveProvider = defineProvider({
  type: 'google-drive',
  isConfigured: isGoogleDriveConfigured,
  scripts: ['https://accounts.google.com/gsi/client', 'https://apis.google.com/js/api.js'],
  sync: async ({ record, database, signal, canApply = () => true, onApply }) => {
    const { updateRecordDatabase } = await import('@/features/workspace/services/session');
    const check = () => {
      signal?.throwIfAborted();
      if (!canApply()) throw new DOMException('Sync deferred.', 'AbortError');
    };
    check();
    const remoteBytes = await getFile(record.source.id, signal);
    const [nextDatabase, nextRecord] = await updateRecordDatabase({
      database,
      record,
      signal,
      update: async (updatedDatabase) => {
        const remoteDatabase = await loadDatabase({
          encryptedBytes: remoteBytes,
          credentials: updatedDatabase.credentials,
        });
        updatedDatabase.merge(remoteDatabase);
        const bytes = await toEncryptedBytes(updatedDatabase);
        check();
        await updateFile(record.source.id, bytes, signal);
        check();
        onApply?.();
        check();
      },
    });
    return { database: nextDatabase, record: nextRecord };
  },
  ImportDialog: ImportGoogleDriveDialog,
  CreateDialog: CreateGoogleDriveDialog,
});
