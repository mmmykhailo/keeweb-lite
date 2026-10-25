// Keep the KDBX dependencies (~245 KB) out of the initial unlock page bundle.
export const loadKdbxweb = async () => (await import('@/utils/kdbxweb')).default;
