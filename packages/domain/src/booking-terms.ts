// P5.6: the five plain rules a brand agrees to, with one tick box, before it pays (rulebook v5.4:
// the promise, the edge, make-ups, late ads, the report). Versioned: a booking keeps the version its
// brand agreed to, and a change of words is a new version, never an edit.
import type { PriceBook } from './price-book.js';

export const TERMS_VERSION = 1;

export interface Term {
  readonly key: 'promise' | 'edge' | 'make-ups' | 'late-ads' | 'report';
  readonly title: string;
  readonly text: string;
}

/** The rules in words, with the numbers the price book sets. */
export function bookingTerms(book: Pick<PriceBook, 'playsPerBikeHour' | 'adsDueDays'>): Term[] {
  return [
    {
      key: 'promise',
      title: 'What we promise',
      text: `For every bike you book in an hour, your ads play ${book.playsPerBikeHour} times inside your area in that hour, on at least as many different bikes as you booked. We do not promise how many bikes are in the area at any one moment.`,
    },
    {
      key: 'edge',
      title: 'The edge of an area',
      text: 'Bikes move in and out of areas. Up to 10% of plays may fall just outside the edge of your area; plays further out do not count.',
    },
    {
      key: 'make-ups',
      title: 'If we fall short',
      text: 'Plays we miss are made up in the next 2 hours in that area, or else at the same hour the next day. Anything still missing is refunded.',
    },
    {
      key: 'late-ads',
      title: 'Your ads on time',
      text: `Your ads are due ${book.adsDueDays} days before the start. If they are not ready and approved by the first hour, the campaign does not run and is not refunded. Talk to us if you are late.`,
    },
    {
      key: 'report',
      title: 'Your report',
      text: 'One report after the campaign: plays delivered, different bikes, a heat map and an estimate of people who saw it (approximate, never billed).',
    },
  ];
}
