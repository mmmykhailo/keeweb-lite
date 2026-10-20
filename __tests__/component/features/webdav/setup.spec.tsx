import * as webDavService from '@/features/webdav/services/webdav';
import * as downloadUtils from '@/utils/download';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ProviderMenu } from '@/features/unlock/components/provider-menu';
import { CreateWebDavDialog } from '@/features/webdav/components/create-dialog';
import { createTestRecord } from '@tests/utils/kdbx';
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

  it('refreshes records and downloads a generated key after canceled creation saved recovery, without stale success UI', async () => {
    const creationResult = Promise.withResolvers<webDavService.WebDavCreationResult>();
    using creation = vi.spyOn(webDavService, 'createWebDavRecord').mockReturnValue(creationResult.promise);
    using download = vi.spyOn(downloadUtils, 'downloadBytes').mockImplementation(() => {});
    using success = vi.spyOn(toast, 'success');
    using error = vi.spyOn(toast, 'error');
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<Harness onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Database name'), 'Vault');
    await user.type(screen.getByLabelText('HTTPS destination file URL'), 'https://dav.example/vault.kdbx');
    await user.type(screen.getByLabelText('WebDAV username'), 'user');
    await user.type(screen.getByLabelText('WebDAV password or app password'), 'server-password');
    await user.type(screen.getByLabelText('Database master password'), 'database-password');
    await user.type(screen.getByLabelText('Confirm master password'), 'database-password');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(creation).toHaveBeenCalled());
    const signal = creation.mock.calls[0][0].signal;
    if (!signal) throw new Error('Missing cancellation signal.');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(signal.aborted).toBe(true);
    const generatedKeyFile = { name: 'vault.keyx', bytes: new Uint8Array([1, 2]) };
    await act(async () =>
      creationResult.resolve({
        outcome: 'saved-locally',
        record: createTestRecord(),
        generatedKeyFile,
        error: new Error('Saved locally.'),
      }),
    );
    expect(onCreated).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith({ fileName: generatedKeyFile.name, bytes: generatedKeyFile.bytes });
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
