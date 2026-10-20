import { describe, expect, it, vi } from 'vitest';
import { canonicalFileUrl, createWebDavConnection } from '@/features/webdav/repositories/webdav';

const setup = { url: 'https://dav.example/vault.kdbx', username: 'user', password: 'app-password' };
const bytes = new Uint8Array([1, 2, 3]);
const response = (etag?: string, body = bytes) =>
  new Response(body.slice().buffer, { headers: etag ? { ETag: etag } : {} });

describe('WebDAV transport', () => {
  it.each([
    'http://dav.example/a',
    'https://user:pass@dav.example/a',
    'https://dav.example/',
    'https://dav.example/a/',
    'https://dav.example/a?x',
    'https://dav.example/a#x',
    'https://dav.example/%no',
  ])('rejects unsafe file URL %s', (url) => {
    expect(() => canonicalFileUrl(url)).toThrow();
  });

  it('canonicalizes the endpoint and rejects colon usernames', () => {
    expect(canonicalFileUrl('https://DAV.example:443/path/../vault.kdbx')).toBe(setup.url);
    expect(() => createWebDavConnection({ ...setup, username: 'user:other' })).toThrow('colon');
  });

  it('reads bytes and their exact quoted ETag in one authenticated request', async () => {
    const fetch = vi.fn().mockResolvedValue(response('"opaque:123"'));
    using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
    const snapshot = await createWebDavConnection(setup).read();
    expect(snapshot).toEqual({ bytes, etag: '"opaque:123"' });
    expect(fetch).toHaveBeenCalledWith(
      setup.url,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Authorization: `Basic ${btoa('user:app-password')}` },
      }),
    );
  });

  it.each([undefined, 'W/"weak"', 'unquoted'])(
    'allows reading but refuses replacement without strong ETag %s',
    async (etag) => {
      const fetch = vi.fn().mockResolvedValue(response(etag));
      using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
      const connection = createWebDavConnection(setup);
      const snapshot = await connection.read();
      expect(snapshot.etag).toBeUndefined();
      await expect(connection.write(bytes, snapshot.etag)).rejects.toThrow('strong ETag');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('uses If-Match for updates and If-None-Match for creation', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response('"next"')));
    using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
    const connection = createWebDavConnection(setup);
    await connection.write(bytes, '"exact"');
    await connection.write(bytes, undefined, true);
    expect(new Headers(fetch.mock.calls[0][1].headers).get('If-Match')).toBe('"exact"');
    expect(new Headers(fetch.mock.calls[1][1].headers).get('If-None-Match')).toBe('*');
    expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('If-Match');
  });

  it('verifies exact bytes and strong ETag when PUT omits its validator', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response('"readback"'));
    using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
    await createWebDavConnection(setup).write(bytes, '"old"');
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['PUT', 'GET']);
  });

  it.each([response('"other"', new Uint8Array([9])), response()])('rejects unconfirmed read-back', async (readback) => {
    using _fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(readback));
    await expect(createWebDavConnection(setup).write(bytes, undefined, true)).rejects.toThrow('could not be confirmed');
  });

  it.each([
    [401, 'credentials'],
    [403, 'permission'],
    [404, 'found'],
    [410, 'found'],
    [412, 'changed'],
    [423, 'locked'],
    [507, 'storage'],
    [405, 'support'],
    [409, 'collection'],
  ])('reports actionable HTTP %s errors', async (status, message) => {
    using _fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(vi.fn().mockResolvedValue(new Response(null, { status: Number(status) })));
    await expect(createWebDavConnection(setup).read()).rejects.toThrow(String(message));
  });

  it('reports network and redirect failures and incomplete response bodies', async () => {
    using _fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(vi.fn().mockRejectedValue(new TypeError('redirect')));
    await expect(createWebDavConnection(setup).read()).rejects.toThrow('HTTPS');
    using _fetch0 = vi.spyOn(globalThis, 'fetch').mockImplementation(
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        arrayBuffer: () => Promise.reject(new TypeError('truncated')),
      }),
    );
    await expect(createWebDavConnection(setup).read()).rejects.toThrow('read completely');
  });

  it('aborts active requests and refuses access after disposal', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        (_url, { signal }: RequestInit) =>
          new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))),
      );
    using _fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetch);
    const connection = createWebDavConnection(setup);
    const request = connection.read();
    connection.dispose();
    connection.dispose();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => connection.read()).toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
