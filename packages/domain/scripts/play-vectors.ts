// Writes test-vectors/plays.json from the cloud's own code (P2.7): the exact bytes a screen signs for
// a play (playBytes) and its report, for the Kotlin player to build the same. Each case is signed with
// a throwaway key made here (only its public half is kept), so the player also checks that the
// cloud's way of verifying (ECDSA P-256, SHA-256, DER) takes a signature over its bytes.
// Run from packages/domain: npx tsx scripts/play-vectors.ts
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { checkPlayShape, lineIdOf, playBytes, type PlayReport } from '../src/plays.js';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

type Fields = Omit<PlayReport, 'sig'>;
const base: Fields = {
  kind: 'play',
  keyId: 'k1',
  slot: 'brand',
  ref: lineIdOf('BK-0007', 'hyd-madhapur', '2026-11-02', 18),
  adId: 'a1',
  startAt: 1793628015,
  lengthS: 15,
  latE6: 17447512,
  lngE6: 78391044,
  accuracyM: 8,
  place: 'inside:hyd-madhapur@3',
  people: 0,
};
const cases: { name: string; screenId: string; seq: number; play: Fields }[] = [
  { name: 'a brand play inside its area', screenId: 'SCR-0001234K', seq: 1, play: base },
  {
    name: 'a make-up play in a RECALL spot',
    screenId: 'SCR-0001234K',
    seq: 4_000_000_001,
    play: {
      ...base,
      slot: 'make-up',
      ref: `${lineIdOf('BK-0003', 'hyd-madhapur', '2026-11-01', 20)}#1`,
      adId: 'm1',
      place: 'edge:hyd-madhapur@3',
    },
  },
  {
    name: "RECALL's own ad, no position (no GPS fix)",
    screenId: 'SCR-9999999Z',
    seq: 77,
    play: {
      ...base,
      slot: 'recall',
      ref: '',
      adId: 'r1',
      latE6: 0,
      lngE6: 0,
      accuracyM: 100_000,
      place: 'outside',
    },
  },
  {
    name: 'an aggregator spot, south-west of zero',
    screenId: 'SCR-0000001A',
    seq: 12,
    play: {
      ...base,
      slot: 'aggregator',
      ref: 'G-agg',
      adId: 'x1',
      latE6: -33868820,
      lngE6: -151209290,
    },
  },
];

const out = cases.map((c) => {
  const bytes = playBytes(c.screenId, c.seq, c.play);
  const sig = sign('sha256', Buffer.from(bytes, 'utf8'), privateKey).toString('base64');
  const problem = checkPlayShape({ ...c.play, sig });
  if (problem) throw new Error(`${c.name}: ${problem}`);
  return { ...c, bytes, sig };
});
writeFileSync(
  new URL('../test-vectors/plays.json', import.meta.url),
  `${JSON.stringify({ publicKey: spki, cases: out }, null, 2)}\n`,
);
console.log(`plays.json: ${out.length} cases`);
