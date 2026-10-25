import { defineProvider } from '@/services/provider';
import { CreateWebDavDialog } from '@/features/webdav/components/create-dialog';
import { ImportWebDavDialog } from '@/features/webdav/components/import-dialog';
import { createWebDavSync } from '@/features/webdav/services/webdav';

export const webDavProvider = defineProvider({
  type: 'webdav',
  label: 'WebDAV',
  sync: createWebDavSync,
  ImportDialog: ImportWebDavDialog,
  CreateDialog: CreateWebDavDialog,
});
