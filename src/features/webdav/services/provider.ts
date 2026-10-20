import { defineProvider } from '@/services/provider';
import { CreateWebDavDialog } from '@/features/webdav/components/create-dialog';
import { ImportWebDavDialog } from '@/features/webdav/components/import-dialog';

export const webDavProvider = defineProvider({
  type: 'webdav',
  label: 'WebDAV',
  ImportDialog: ImportWebDavDialog,
  CreateDialog: CreateWebDavDialog,
});
