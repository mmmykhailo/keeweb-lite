import * as webDavService from '@/features/webdav/services/webdav';
import * as recordRepository from '@/features/webdav/repositories/record';
import userEvent from '@testing-library/user-event';
import { updateRecordDatabase } from '@/features/workspace/services/session';
import { useLayoutEffect, useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePage } from '@/features/workspace/pages/workspace';
import { unlockSession, type UnlockSession } from '@/features/unlock/services/session';
import { createRecord, getRecord, removeRecord } from '@/repositories/record';
import { toEncryptedBytes } from '@/services/database';
import { cloneDatabase } from '@/services/database';
import { createTestDatabase, createTestEntry } from '@tests/utils/kdbx';
import { render } from '@tests/utils/render';

const setup = { url: 'https://dav.example/vault.kdbx', username: 'user', password: 'server-password' };

const response = (bytes: Uint8Array, options?: RequestInit) =>
  options?.method === 'PATCH'
    ? Response.json({ id: 'drive-file', name: 'vault.kdbx', modifiedTime: '2026-01-01T00:00:00.000Z' })
    : new Response(bytes.slice().buffer, { headers: { ETag: '"etag"' } });
const fixture = async (type: 'webdav' | 'google-drive' = 'webdav') => {
  const db = await createTestDatabase();
  createTestEntry(db);
  const bytes = await toEncryptedBytes(db);
  const fetch = vi.fn().mockImplementation((_url, options?: RequestInit) => Promise.resolve(response(bytes, options)));
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
  const record =
    type === 'webdav'
      ? await webDavService.importWebDavRecord({ ...setup, databasePassword: 'component-test-password' })
      : await createRecord({
          id: 'drive-record',
          type,
          source: { id: 'drive-file' },
          kdbx: { name: 'vault.kdbx', encryptedBytes: bytes },
        });
  const session = await unlockSession({ record, password: 'component-test-password' });
  const remote = await cloneDatabase(db);
  remote.getDefaultGroup().entries[0].fields.set('Title', 'Remote title');
  remote.getDefaultGroup().entries[0].times.lastModTime = new Date(Date.now() + 2000);
  const remoteBytes = await toEncryptedBytes(remote);
  return {
    session,
    initialRequests: fetch.mock.calls.length,
    record: await getRecord(record.id),
    remoteBytes,
    fetch,
    bytes,
    [Symbol.dispose]: () => {
      session.connection?.dispose();
      fetchSpy.mockRestore();
    },
  };
};
const Harness = ({
  initial,
  reopen,
  onSession,
}: {
  initial: UnlockSession;
  reopen?: UnlockSession;
  onSession?: (session: UnlockSession | null) => void;
}) => {
  const [session, setSession] = useState<UnlockSession | null>(initial);
  useLayoutEffect(() => {
    onSession?.(session);
  }, [session, onSession]);
  return session ? (
    <WorkspacePage session={session} setSession={setSession} />
  ) : (
    <button onClick={() => setSession(reopen ?? null)}>Reopen</button>
  );
};

describe('workspace sync', () => {
  describe.each(['webdav', 'google-drive'] as const)('%s synchronization', (type) => {
    it.each(['password generator', 'tag search'])(
      'continues syncing after canceling %s input without changing the entry',
      async (widget) => {
        using context = await fixture(type);
        const { session, remoteBytes, fetch } = context;
        const get = Promise.withResolvers<Response>();
        fetch.mockReturnValueOnce(get.promise);
        const user = userEvent.setup();
        render(<Harness initial={session} />);
        await user.click(screen.getByRole('button', { name: /Test Entry test-user/ }));

        if (widget === 'password generator') {
          await user.click(screen.getByRole('button', { name: 'Generate password' }));
          await user.clear(screen.getByLabelText('Length'));
          await user.type(screen.getByLabelText('Length'), '24');
          await user.click(screen.getByRole('button', { name: 'Close' }));
        } else {
          await user.type(screen.getByLabelText('Tags'), 'search');
          await user.keyboard('{Escape}');
        }

        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        await act(async () => get.resolve(response(remoteBytes)));
        await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Remote title'));
        expect(screen.getByText('Synced')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Lock workspace' }));
        expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
      },
    );

    it('keeps a mounted dirty draft and its cache when an in-flight GET resolves; discard resumes the deferred pull', async () => {
      using context = await fixture(type);
      const { session, record, remoteBytes, fetch } = context;
      const get = Promise.withResolvers<Response>();
      fetch
        .mockReturnValueOnce(get.promise)
        .mockImplementation((_url, options?: RequestInit) => Promise.resolve(response(remoteBytes, options)));
      const user = userEvent.setup();
      render(<Harness initial={session} />);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(context.initialRequests + 1));
      await user.click(screen.getByRole('button', { name: /Test Entry test-user/ }));
      const title = screen.getByLabelText('Title');
      await user.clear(title);
      await user.type(title, 'Draft');
      await act(async () => get.resolve(response(remoteBytes)));
      expect(screen.getByText('Syncing')).toBeInTheDocument();
      expect(screen.getByLabelText('Title')).toBe(title);
      expect(title).toHaveValue('Draft');
      expect(await getRecord(record.id)).toEqual(record);
      await user.click(screen.getByRole('button', { name: /Test Entry test-user/ }));
      await user.click(screen.getByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Remote title'));
    });

    it('ignores old completion after lock and re-unlock of the same record at version zero', async () => {
      using context = await fixture(type);
      const { session, record, remoteBytes, fetch, bytes } = context;
      const next = await unlockSession({ record, password: 'component-test-password' });
      using _next = { [Symbol.dispose]: () => next.connection?.dispose() };
      const oldGet = Promise.withResolvers<Response>();
      const nextGet = Promise.withResolvers<Response>();
      fetch.mockReturnValueOnce(oldGet.promise).mockReturnValueOnce(nextGet.promise);
      const user = userEvent.setup();
      render(<Harness initial={session} reopen={next} />);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(context.initialRequests + 1));
      await user.click(screen.getByRole('button', { name: 'Lock workspace' }));
      expect(session.connection?.signal.aborted).toBe(true);
      await user.click(screen.getByRole('button', { name: 'Reopen' }));
      await act(async () => oldGet.resolve(response(remoteBytes)));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(context.initialRequests + 2));
      expect((await getRecord(record.id)).kdbx.encryptedBytes).toEqual(bytes);
      await act(async () => nextGet.resolve(response(bytes)));
      await waitFor(() => expect(screen.getByText('Synced')).toBeInTheDocument());
      expect(screen.queryByText('Remote title')).not.toBeInTheDocument();
    });

    it('does not restore a record removed in another tab while GET completes', async () => {
      using context = await fixture(type);
      const { session, record, remoteBytes, fetch } = context;
      const get = Promise.withResolvers<Response>();
      fetch.mockReturnValueOnce(get.promise);
      render(<Harness initial={session} />);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(context.initialRequests + 1));
      await removeRecord(record.id);
      await act(async () => get.resolve(response(remoteBytes)));
      await waitFor(() => expect(screen.getByText('Sync error')).toBeInTheDocument());
      await expect(getRecord(record.id)).rejects.toThrow('not found');
    });
    it('pauses after errors across saves and resumes only on explicit retry, without online/visibility triggers', async () => {
      using context = await fixture(type);
      const { session, record, bytes, fetch } = context;
      fetch.mockImplementation(() => Promise.reject(new TypeError('offline')));
      const user = userEvent.setup();
      render(<Harness initial={session} />);
      await waitFor(() => expect(screen.getByText('Sync error')).toBeInTheDocument());
      const calls = fetch.mock.calls.length;
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await user.click(screen.getByRole('button', { name: /Test Entry test-user/ }));
      await user.type(screen.getByLabelText('Title'), ' edited');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
      expect(fetch).toHaveBeenCalledTimes(calls);
      const local = await getRecord(record.id);
      if (local.type === 'webdav') expect(local.synchronization.pending).toBe(true);
      fetch.mockImplementation((_url, options?: RequestInit) => Promise.resolve(response(bytes, options)));
      await user.click(screen.getByRole('button', { name: 'Sync status: error' }));
      await waitFor(() => expect(screen.getByText('Synced')).toBeInTheDocument());
      const confirmed = await getRecord(record.id);
      if (confirmed.type === 'webdav') expect(confirmed.synchronization.pending).toBe(false);
    });
  });

  describe('WebDAV transaction', () => {
    it('retains a newer local Save when an old upload finishes', async () => {
      using context = await fixture();
      const { session, record, bytes, fetch } = context;
      const [database, pendingRecord] = await updateRecordDatabase({
        database: session.database,
        record,
        update: (database) => {
          database.meta.name = 'Pending';
        },
      });
      session.database = database;
      session.record = pendingRecord;
      const upload = Promise.withResolvers<Response>();
      const rerun = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      fetch.mockImplementation((_url, options: RequestInit) => {
        if (options.method === 'PUT' || options.method === 'PATCH') {
          started.resolve();
          return upload.promise;
        }
        return Promise.resolve(response(bytes));
      });
      const user = userEvent.setup();
      render(<Harness initial={session} />);
      await started.promise;
      await user.click(screen.getByRole('button', { name: /Test Entry test-user/ }));
      await user.clear(screen.getByLabelText('Title'));
      await user.type(screen.getByLabelText('Title'), 'Newer local Save');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
      const saved = await getRecord(record.id);
      fetch.mockReturnValue(rerun.promise);
      await act(async () => upload.resolve(response(bytes)));
      expect(await getRecord(record.id)).toEqual(saved);
      expect(screen.getByLabelText('Title')).toHaveValue('Newer local Save');
      if (saved.type === 'webdav') expect(saved.synchronization.pending).toBe(true);
      await act(async () => rerun.resolve(new Response(null, { status: 403 })));
    });

    it('holds the edit gate through the final transaction and publishes matching form defaults before the next Save', async () => {
      using context = await fixture();
      const { session, record, remoteBytes, fetch } = context;
      const get = Promise.withResolvers<Response>();
      const release = Promise.withResolvers<void>();
      fetch
        .mockReturnValueOnce(get.promise)
        .mockImplementation((_url, options?: RequestInit) => Promise.resolve(response(remoteBytes, options)));
      const update = recordRepository.updateWebDavRecord;
      using held = vi.spyOn(recordRepository, 'updateWebDavRecord').mockImplementation(async (input) => {
        await release.promise;
        return update(input);
      });
      const user = userEvent.setup();
      const { container } = render(<Harness initial={session} />);
      await user.click(screen.getByRole('button', { name: /Test Entry test-user/ }));
      await act(async () => get.resolve(response(remoteBytes)));
      await waitFor(() => expect(held).toHaveBeenCalled());
      const title = screen.getByLabelText('Title');
      expect(title.closest('[inert]')).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Create entry' }));
      expect(await getRecord(record.id)).toEqual(record);
      expect(title).toHaveValue('Test Entry');
      held.mockRestore();
      await act(async () => release.resolve());
      await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Remote title'));
      expect(container.querySelector('[inert]')).toBeNull();
      fetch.mockImplementation(() => Promise.reject(new TypeError('offline')));
      await user.clear(screen.getByLabelText('Title'));
      await user.type(screen.getByLabelText('Title'), 'After gate');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
      const current = await getRecord(record.id);
      expect(current.type === 'webdav' && current.synchronization.pending).toBe(true);
      expect(screen.getByLabelText('Title')).toHaveValue('After gate');
    });
  });
});
