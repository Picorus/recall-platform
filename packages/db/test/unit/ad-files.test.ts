// P2.4.2, review S2: the most files in one list. Playing ads come first, then the soonest needed;
// what does not fit waits (and is said), never a playing ad left off for a later one.
import { MAX_AD_FILES, parseAdFiles, type AdFile } from '@recall/domain';
import { describe, expect, it } from 'vitest';
import { fileListText, neededAdFiles } from '../../src/ad-files.js';

const NOW = 1_800_000_000;
const sha = (i: number) => i.toString(16).padStart(64, '0');

/** A database stand-in: `books` bookings of 5 ads each, a booking an hour later than the one before
 * (the first already playing), and 3 of RECALL's own ads. */
function fakeDb(books: number) {
  const ads = new Map<string, number>();
  let n = 0;
  const bookings = Array.from({ length: books }, (_, b) => {
    const ids = Array.from({ length: 5 }, () => {
      n += 1;
      const id = `AD-${n.toString(16).toUpperCase().padStart(10, '0')}`;
      ads.set(id, n);
      return id;
    });
    const first = NOW + (b - 1) * 3600;
    return {
      first: String(first),
      last: String(first + 3600),
      ad_ids: ids,
      prev: null,
      changed: '0',
    };
  });
  const own = ['AD-00000FFFF1', 'AD-00000FFFF2', 'AD-00000FFFF3'];
  own.forEach((id, i) => ads.set(id, 900_000 + i));
  return {
    query: (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM bookings b')) return Promise.resolve({ rows: bookings });
      if (sql.includes('a.brand_id = $1'))
        return Promise.resolve({ rows: own.map((ad_id) => ({ ad_id })) });
      if (sql.includes('a.ad_id = ANY($1)')) {
        const want = params[0] as string[];
        return Promise.resolve({
          rows: want.map((ad_id) => ({ ad_id, file_key: sha(ads.get(ad_id) ?? 0), bytes: '1000' })),
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

describe('the most files in one list (S2)', () => {
  it('600 at most: playing first, then the soonest; the rest are counted to wait', async () => {
    const db = fakeDb(130); // 650 booking ads + 3 of RECALL's own
    const { files, left } = await neededAdFiles(db as never, NOW);
    expect(MAX_AD_FILES).toBe(600);
    expect(files).toHaveLength(600);
    expect(left).toBe(53);
    // Needed now (the booking playing, the one starting now, RECALL's own) come before the rest.
    const playing = files.filter((f) => f.needFrom === NOW).map((f) => f.ad);
    expect(playing).toHaveLength(13);
    expect(files.slice(0, 13).every((f) => f.needFrom === NOW)).toBe(true);
    // Sorted by need: what was left out is needed later than all that went in.
    for (let i = 1; i < files.length; i++)
      expect(files[i - 1]?.needFrom).toBeLessThanOrEqual(files[i]?.needFrom ?? 0);
  });

  it('a list too long for one message keeps the soonest files and says how many wait', () => {
    const files: AdFile[] = Array.from({ length: 600 }, (_, i) => ({
      ad: `A${i}`,
      sha256: sha(i + 1),
      bytes: 1000,
      url: `https://files.example/${'x'.repeat(2000)}`,
      keepUntil: NOW + 86_400,
    }));
    const said: string[] = [];
    const text = fileListText(files, NOW * 1000, (l) => said.push(l));
    const list = parseAdFiles(text);
    expect('files' in list && list.files[0]?.ad).toBe('A0');
    expect('files' in list && list.files.length).toBeLessThan(600);
    expect(said[0]).toMatch(/files left off a list/);
    // One that fits is sent whole, with nothing said.
    const small = fileListText(
      files.slice(0, 3).map((f) => ({ ...f, url: 'https://f.example/a' })),
      NOW * 1000,
      (l) => said.push(l),
    );
    expect('files' in parseAdFiles(small) && parseAdFiles(small)).toMatchObject({
      made: NOW * 1000,
    });
    expect(said).toHaveLength(1);
  });
});
