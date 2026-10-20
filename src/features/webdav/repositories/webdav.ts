import * as z from 'zod/mini';
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

const basicAuthorization = (username: string, password: string) => {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
};

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

const request = async ({
  url,
  authorization,
  method,
  signal,
  headers,
  body,
}: {
  url: string;
  authorization: string;
  method: 'GET' | 'PUT';
  signal?: AbortSignal;
  headers?: HeadersInit;
  body?: Uint8Array;
}) => {
  try {
    const response = await fetch(url, {
      method,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { Authorization: authorization, ...Object.fromEntries(new Headers(headers).entries()) },
      body: body ? body.slice().buffer : undefined,
    });

    if (!response.ok) throw errorForStatus(response.status);
    return response;
  } catch (error) {
    if (error instanceof WebDavError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new WebDavError(
      'network',
      'The browser could not access this WebDAV endpoint. Check its HTTPS and browser access settings.',
      { cause: error },
    );
  }
};

export const readWebDavFile = async (url: string, authorization: string, signal?: AbortSignal) => {
  const response = await request({ url, authorization, method: 'GET', signal });
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

export type WebDavSetup = z.infer<typeof webdavConnectionSchema>;
export const validateWebDavSetup = (input: WebDavSetup) => {
  const setup = webdavConnectionSchema.parse(input);
  return { ...setup, url: canonicalFileUrl(setup.url) };
};

export const createWebDavConnection = (input: WebDavSetup) => {
  const setup = validateWebDavSetup(input);
  let authorization: string | undefined = basicAuthorization(setup.username, setup.password);
  const url = setup.url;
  const controller = new AbortController();
  const getAuthorization = () => {
    controller.signal.throwIfAborted();
    if (authorization === undefined) throw new DOMException('WebDAV connection locked.', 'AbortError');
    return authorization;
  };
  return {
    signal: controller.signal,
    dispose: () => {
      authorization = undefined;
      controller.abort();
    },
    read: (signal: AbortSignal = controller.signal) => {
      controller.signal.throwIfAborted();
      return readWebDavFile(url, getAuthorization(), AbortSignal.any([signal, controller.signal]));
    },
    write: async (
      bytes: Uint8Array,
      etag: string | undefined,
      create = false,
      signal: AbortSignal = controller.signal,
    ) => {
      controller.signal.throwIfAborted();
      signal = AbortSignal.any([signal, controller.signal]);
      if (!create && !strongEtag(etag ?? null)) {
        throw new WebDavError('unsupported', 'This WebDAV server did not provide a strong ETag. Updates are disabled.');
      }
      const response = await request({
        url: setup.url,
        authorization: getAuthorization(),
        method: 'PUT',
        signal,
        body: bytes,
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(create ? { 'If-None-Match': '*' } : { 'If-Match': etag! }),
        },
      });
      if (!strongEtag(response.headers.get('ETag'))) {
        const snapshot = await readWebDavFile(url, getAuthorization(), signal);
        if (!snapshot.etag || !equalBytes(snapshot.bytes, bytes)) {
          throw new WebDavError(
            'unconfirmed',
            'The WebDAV upload could not be confirmed. Check the destination before retrying.',
          );
        }
      }
      signal.throwIfAborted();
    },
  };
};
export type WebDavConnection = ReturnType<typeof createWebDavConnection>;
