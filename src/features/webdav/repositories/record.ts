import {
  createRecord,
  getRecords,
  updateRecord,
  type PersistedFileRecord,
  type WebDavFileRecord,
} from '@/repositories/record';
import { Lock } from '@/utils/lock';

export const equalBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

export const getWebDavCredentials = async (id: string) => {
  const record = (await getRecords()).find((record) => record.id === id);
  return record?.type === 'webdav' ? record.source.credentials : undefined;
};

export const createWebDavRecovery = (record: Extract<PersistedFileRecord, { type: 'local' }>, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  return createRecord(record);
};

const insertLock = new Lock('webdav.repository.insert');

export const insertWebDavRecord = async (
  record: Omit<WebDavFileRecord, 'source'> & { source: { url: string } },
  credentials: Uint8Array,
  signal?: AbortSignal,
  recoveryBytes?: Uint8Array,
) =>
  insertLock.runInLock(async () => {
    signal?.throwIfAborted();
    const records = await getRecords();
    if (records.some((row) => row.type === 'webdav' && row.source.url === record.source.url)) {
      throw new Error('A record for this WebDAV file already exists.');
    }
    const nextRecord = { ...record, source: { ...record.source, credentials } };
    if (!recoveryBytes) {
      signal?.throwIfAborted();
      const created = await createRecord(nextRecord);
      if (created.type !== 'webdav') throw new Error('WebDAV database not found.');
      return created;
    }
    const updated = await updateRecord(record.id, (current) => {
      signal?.throwIfAborted();
      if (current.type !== 'local' || !equalBytes(current.kdbx.encryptedBytes, recoveryBytes)) {
        throw new Error('The local recovery database changed or was removed.');
      }
      return nextRecord;
    });
    if (updated.type !== 'webdav') throw new Error('WebDAV database not found.');
    return updated;
  });

type WebDavUpdateResult =
  { status: 'applied'; record: WebDavFileRecord } | { status: 'superseded' } | { status: 'missing' };

class WebDavUpdateError extends Error {
  constructor(readonly status: 'superseded' | 'missing') {
    super(status);
  }
}

export const updateWebDavRecord = async ({
  id,
  generation,
  change,
  signal,
  accept = () => true,
}: {
  id: string;
  generation: number;
  change:
    | { kind: 'touch' }
    | {
        kind: 'save';
        bytes: Uint8Array;
        localEditState: NonNullable<WebDavFileRecord['synchronization']['localEditState']>;
      }
    | { kind: 'sync'; bytes: Uint8Array };
  signal?: AbortSignal;
  accept?: () => boolean;
}): Promise<WebDavUpdateResult> => {
  try {
    const record = await updateRecord(id, (current) => {
      signal?.throwIfAborted();
      if (current.type !== 'webdav') throw new WebDavUpdateError('missing');
      if (current.synchronization.generation !== generation || !accept()) throw new WebDavUpdateError('superseded');
      return change.kind === 'touch'
        ? { ...current, lastOpenedAt: new Date().toISOString() }
        : {
            ...current,
            kdbx: { ...current.kdbx, encryptedBytes: change.bytes.slice() },
            synchronization: {
              generation:
                generation + (change.kind === 'save' || !equalBytes(current.kdbx.encryptedBytes, change.bytes) ? 1 : 0),
              pending: change.kind === 'save',
              ...(change.kind === 'save' ? { localEditState: change.localEditState } : {}),
            },
          };
    });
    if (record.type !== 'webdav') throw new WebDavUpdateError('missing');
    return { status: 'applied', record };
  } catch (error) {
    if (error instanceof WebDavUpdateError) return { status: error.status };
    if (error instanceof Error && error.message === 'Record not found.') return { status: 'missing' };
    throw error;
  }
};
