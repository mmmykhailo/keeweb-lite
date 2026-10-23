import { defineProvider } from '@/services/provider';
import { CreateWebDavDialog } from '@/features/webdav/components/create-dialog';
import { ImportWebDavDialog } from '@/features/webdav/components/import-dialog';
import { loadWebDavDatabase, saveWebDav, unlockWebDav } from '@/features/webdav/services/webdav';

export const webDavProvider = defineProvider({
  type: 'webdav',
  label: 'WebDAV',
  unlock: ({ record, password }) => unlockWebDav(record.id, password),
  storage: {
    load: loadWebDavDatabase,
    save: ({ record, database, signal }) => saveWebDav(record, database, signal),
  },
  sync: ({ connection, ...options }) => {
    if (!connection?.sync) throw new Error('The WebDAV connection is unavailable. Unlock the database again.');
    return connection.sync(options);
  },
  ImportDialog: ImportWebDavDialog,
  CreateDialog: CreateWebDavDialog,
});
