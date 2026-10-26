// P3.9.1: the fake file store: files by fingerprint, stored once; read links only as signed and
// only until they end.
import { describe, expect, it } from 'vitest';
import { fakeFileStore, fileKey } from '../src/storage.js';

describe('fake file store (P3.9.1)', () => {
  it('stores by fingerprint, once; reads back exactly', async () => {
    const s = fakeFileStore({ baseUrl: 'http://localhost:8080/files', secret: 'test-secret' });
    const data = new TextEncoder().encode('an ad');
    const a = await s.put(data, 'image/png');
    expect(a).toEqual({ key: fileKey(data), bytes: 5, contentType: 'image/png' });
    expect(await s.put(data, 'image/png')).toEqual(a);
    expect(s.files.size).toBe(1);
    expect(await s.get(a.key)).toEqual({ data, contentType: 'image/png' });
    expect(await s.get('../etc/passwd')).toBeNull();
    expect(await s.get('0'.repeat(64))).toBeNull();
  });

  it('a read link works only as signed and until it ends', () => {
    const s = fakeFileStore({ baseUrl: 'http://localhost:8080/files', secret: 'test-secret' });
    const key = 'a'.repeat(64);
    const link = new URL(s.readLink(key, 1000));
    const sig = link.searchParams.get('sig') ?? '';
    expect(link.pathname).toBe(`/files/${key}`);
    expect(s.checkLink(key, 1000, sig, 999)).toBe(true);
    expect(s.checkLink(key, 1000, sig, 1000)).toBe(false);
    expect(s.checkLink(key, 2000, sig, 999)).toBe(false);
    expect(s.checkLink('b'.repeat(64), 1000, sig, 999)).toBe(false);
    expect(s.checkLink(key, 1000, 'nope', 999)).toBe(false);
  });
});
