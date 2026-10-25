import { isSameBytes } from '@/utils/buffer';
import { createRecord, getRecords, updateRecord, type WebDavFileRecord } from '@/repositories/record';
import { Lock } from '@/utils/lock';

const insertLock = new Lock('webdav.repository.insert');

export const insertWebDavRecord = async (
  record: Omit<WebDavFileRecord, 'source'> & { source: Omit<WebDavFileRecord['source'], 'credentials'> },
  credentials: Uint8Array,
  recoveryBytes?: Uint8Array,
) =>
  insertLock.runInLock(async () => {
    const records = await getRecords();
    if (records.some((row) => row.type === 'webdav' && row.source.url === record.source.url)) {
      throw new Error('A record for this WebDAV file already exists.');
    }
    const nextRecord = { ...record, source: { ...record.source, credentials: credentials.slice() } };
    if (!recoveryBytes) {
      const created = await createRecord(nextRecord);
      if (created.type !== 'webdav') throw new Error('WebDAV database not found.');
      return created;
    }
    const updated = await updateRecord(record.id, (current) => {
      if (current.type !== 'local' || !isSameBytes(current.kdbx.encryptedBytes, recoveryBytes)) {
        throw new Error('The local recovery database changed or was removed.');
      }
      return nextRecord;
    });
    if (updated.type !== 'webdav') throw new Error('WebDAV database not found.');
    return updated;
  });
