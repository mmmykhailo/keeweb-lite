import * as z from 'zod/mini';
import { createClient, getPatcher, type RequestOptionsCustom, type WebDAVClient } from 'webdav';
import { equalBytes } from '@/repositories/record';

export const canonicalFileUrl = (input: unknown) => {
  const urlText = z.string().check(z.minLength(1)).parse(input);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch (cause) {
    throw new Error('Enter a full HTTPS WebDAV file URL.', { cause });
  }

  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    urlText.includes('?') ||
    urlText.includes('#') ||
    url.pathname === '/' ||
    url.pathname.endsWith('/')
  ) {
    throw new Error('Enter a full HTTPS WebDAV file URL without embedded credentials, query, or fragment.');
  }

  if (
    url.pathname.split('/').some((segment) => {
      try {
        decodeURIComponent(segment);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error('The WebDAV file URL contains malformed percent-encoding in its path.');
  }

  return url.href;
};

export const webdavConnectionSchema = z.object({
  url: z.string().check(
    z.trim(),
    z.minLength(1, 'Enter the full HTTPS WebDAV file URL.'),
    z.refine((value) => {
      try {
        canonicalFileUrl(value);
        return true;
      } catch {
        return false;
      }
    }, 'Enter a full HTTPS file URL without credentials, query, fragment, or malformed percent escapes.'),
  ),
  username: z.string().check(
    z.trim(),
    z.minLength(1, 'Enter a WebDAV username.'),
    z.refine(
      (value) => !value.includes(':'),
      'WebDAV usernames cannot contain a colon when using Basic authentication.',
    ),
  ),
  password: z.string().check(z.minLength(1, 'Enter a WebDAV password or app password.')),
});

const strongEtag = (value: string | null) => {
  if (!value || /^W\//i.test(value) || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)) return undefined;
  return value;
};

export class WebDavError extends Error {
  constructor(
    public code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const errorForStatus = (status: number) => {
  if (status === 401) return new WebDavError('authentication', 'WebDAV rejected these connection credentials.');
  if (status === 403)
    return new WebDavError('permission', 'The WebDAV account does not have permission for this file.');
  if (status === 404 || status === 410)
    return new WebDavError('missing-resource', 'The WebDAV file could not be found.');
  if (status === 412)
    return new WebDavError('precondition', 'The WebDAV file changed before this update could be applied.');
  if (status === 423) return new WebDavError('locked-resource', 'The WebDAV file is locked on the server.');
  if (status === 507) return new WebDavError('capacity', 'The WebDAV server does not have enough storage space.');
  if (status === 405 || status === 501)
    return new WebDavError('unsupported', 'The WebDAV server does not support this operation.');
  if (status === 409) return new WebDavError('remote-conflict', 'The WebDAV destination collection is unavailable.');
  return new WebDavError('network', `WebDAV request failed with HTTP ${status}.`);
};

getPatcher().patch('fetch', (url, options) => {
  if (typeof url !== 'string' || !options || typeof options !== 'object')
    throw new Error('Invalid WebDAV request options.');
  return fetch(url, { ...options, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error' });
});

export type WebDavSetup = z.infer<typeof webdavConnectionSchema>;
export const validateWebDavSetup = (input: WebDavSetup) => {
  const setup = webdavConnectionSchema.parse(input);
  return { ...setup, url: canonicalFileUrl(setup.url) };
};

export const createWebDavConnection = (input: WebDavSetup) => {
  const { url, username, password } = validateWebDavSetup(input);
  // webdav encodes Basic credentials as Latin-1; supply UTF-8 bytes for non-ASCII accounts.
  const [encodedUsername, encodedPassword] = [username, password].map((value) =>
    Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(''),
  );
  let client: WebDAVClient | undefined = createClient(url, { username: encodedUsername, password: encodedPassword });
  const controller = new AbortController();
  const request = async (options: RequestOptionsCustom) => {
    try {
      controller.signal.throwIfAborted();
      if (!client) throw new DOMException('WebDAV connection locked.', 'AbortError');
      const response = await client.customRequest('', {
        ...options,
        url,
        signal: AbortSignal.any([options.signal ?? controller.signal, controller.signal]),
      });
      if (!response.ok) throw errorForStatus(response.status);
      return response;
    } catch (error) {
      if (error instanceof WebDavError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      if (error instanceof Error && 'status' in error && typeof error.status === 'number')
        throw errorForStatus(error.status);
      throw new WebDavError(
        'network',
        'The browser could not access this WebDAV endpoint. Check its HTTPS and browser access settings.',
        { cause: error },
      );
    }
  };
  const read = async (signal: AbortSignal = controller.signal) => {
    const response = await request({ method: 'GET', signal });
    try {
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        etag: strongEtag(response.headers.get('ETag')),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new WebDavError('network', 'The WebDAV response could not be read completely.', { cause: error });
    }
  };
  return {
    signal: controller.signal,
    dispose: () => {
      client = undefined;
      controller.abort();
    },
    read,
    write: async (
      bytes: Uint8Array,
      etag: string | undefined,
      create = false,
      signal: AbortSignal = controller.signal,
    ) => {
      const validator = create ? '*' : strongEtag(etag ?? null);
      controller.signal.throwIfAborted();
      if (!validator) {
        throw new WebDavError('unsupported', 'This WebDAV server did not provide a strong ETag. Updates are disabled.');
      }
      const response = await request({
        method: 'PUT',
        signal,
        data: bytes.slice().buffer,
        headers: { 'Content-Type': 'application/octet-stream', [create ? 'If-None-Match' : 'If-Match']: validator },
      });
      if (!strongEtag(response.headers.get('ETag'))) {
        const snapshot = await read(signal);
        if (!snapshot.etag || !equalBytes(snapshot.bytes, bytes)) {
          throw new WebDavError(
            'unconfirmed',
            'The WebDAV upload could not be confirmed. Check the destination before retrying.',
          );
        }
      }
      signal.throwIfAborted();
      controller.signal.throwIfAborted();
    },
  };
};
export type WebDavConnection = ReturnType<typeof createWebDavConnection>;
