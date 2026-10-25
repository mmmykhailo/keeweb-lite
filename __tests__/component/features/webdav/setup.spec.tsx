import * as downloadUtils from '@/utils/download';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ProviderMenu } from '@/features/unlock/components/provider-menu';
import { CreateWebDavDialog } from '@/features/webdav/components/create-dialog';
import { getRecords } from '@/repositories/record';
import { render } from '@tests/utils/render';

const Harness = ({ onCreated }: { onCreated: () => void }) => {
  const [open, setOpen] = useState(true);
  return <CreateWebDavDialog open={open} onOpenChange={setOpen} onSuccess={onCreated} />;
};

describe('WebDAV setup', () => {
  it.each(['Import', 'Create'])(
    'adds a direct WebDAV choice to %s while keeping Local and Google Drive',
    async (action) => {
      const user = userEvent.setup();
      render(
        <ProviderMenu
          label={action}
          dialog={action === 'Import' ? 'ImportDialog' : 'CreateDialog'}
          onSuccess={vi.fn()}
        />,
      );
      await user.click(screen.getByRole('button', { name: action }));
      expect(screen.getByRole('menuitem', { name: 'Local' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Google Drive' })).toBeInTheDocument();
      await user.click(screen.getByRole('menuitem', { name: 'WebDAV' }));
      expect(screen.getByRole('dialog', { name: `${action} WebDAV Database` })).toBeInTheDocument();
    },
  );

  it.each(['created', 'saved locally'])(
    'blocks dismissal during creation and handles the %s outcome',
    async (outcome) => {
      const upload = Promise.withResolvers<Response>();
      using fetch = vi.spyOn(globalThis, 'fetch').mockReturnValue(upload.promise);
      using download = vi.spyOn(downloadUtils, 'downloadBytes').mockImplementation(() => {});
      using success = vi.spyOn(toast, 'success');
      using error = vi.spyOn(toast, 'error');
      const onCreated = vi.fn();
      const user = userEvent.setup();
      render(<Harness onCreated={onCreated} />);
      await user.type(screen.getByLabelText('Database name'), 'Vault');
      await user.type(screen.getByLabelText('HTTPS destination file URL'), 'https://dav.example/vault.kdbx');
      await user.type(screen.getByLabelText('WebDAV username'), 'user');
      await user.type(screen.getByLabelText('WebDAV password'), 'server-password');
      await user.type(screen.getByLabelText('Database master password'), 'database-password');
      await user.type(screen.getByLabelText('Confirm master password'), 'database-password');
      await user.click(screen.getByLabelText('Use key file (generated and downloaded automatically)'));
      await user.click(screen.getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
      await user.keyboard('{Escape}');
      const overlay = document.querySelector('[data-slot="dialog-overlay"]');
      if (!overlay) throw new Error('Missing dialog overlay');
      await user.click(overlay);
      const form = screen.getByRole('button', { name: 'Creating...' }).closest('form');
      if (!form) throw new Error('Missing creation form');
      fireEvent.submit(form);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(fetch).toHaveBeenCalledOnce();
      await act(async () =>
        upload.resolve(
          new Response(null, {
            status: outcome === 'created' ? 201 : 500,
            headers: { ETag: '"created"' },
          }),
        ),
      );
      await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
      expect(download).toHaveBeenCalledOnce();
      expect((await getRecords())[0].type).toBe(outcome === 'created' ? 'webdav' : 'local');
      if (outcome === 'created') {
        expect(success).toHaveBeenCalledWith('WebDAV database created.');
        expect(error).not.toHaveBeenCalled();
      } else {
        expect(success).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('Database saved locally.'));
      }
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    },
  );
});
