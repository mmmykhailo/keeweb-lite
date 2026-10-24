import { defineProvider, recordStorage } from '@/services/provider';
import { CreateWebDavDialog } from '@/features/webdav/components/create-dialog';
import { ImportWebDavDialog } from '@/features/webdav/components/import-dialog';
import { loadWebDavDatabase, saveWebDav, pullWebDav, pushWebDav } from '@/features/webdav/services/webdav';

export const webDavProvider = defineProvider({
  type: 'webdav',
  label: 'WebDAV',
  storage: {
    ...recordStorage,
    load: ({ record, database }) => {
      if (record.type !== 'webdav') throw new Error('WebDAV database not found.');
      return loadWebDavDatabase({ record, database });
    },
    save: ({ record, database }) => {
      if (record.type !== 'webdav') throw new Error('WebDAV database not found.');
      return saveWebDav(record, database);
    },
  },
  sync: {
    legacy: true,
    pull: pullWebDav,
    push: (record, bytes, database) => pushWebDav({ record, database, bytes }),
  },
  ImportDialog: ImportWebDavDialog,
  CreateDialog: CreateWebDavDialog,
});
