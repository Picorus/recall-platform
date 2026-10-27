// P5.9: the brand portal's Help: plain answers to what brands ask most, and the ad rules in words
// (from the price book, so they always say what the checks check).
import type { AdRules } from './ad-checks.js';

export interface HelpAnswer {
  readonly q: string;
  readonly a: string;
}

/** What brands ask most, in the order shown; numbers from the price book in force. */
export const brandHelp = (playsPerBikeHour: number): readonly HelpAnswer[] => [
  {
    q: 'What do I pay for?',
    a: `Bike-hours: one bike showing your ads for one hour in the area and hours you picked. Never per view. Each bike-hour plays your ads ${playsPerBikeHour} times.`,
  },
  {
    q: 'How do I know my ads played?',
    a: 'Each screen signs every play it makes. When your campaign ends you get one report: plays delivered, different bikes, a heat map of where they played and the busiest streets.',
  },
  {
    q: 'What if fewer plays happen than promised?',
    a: 'We make them up in the next 2 hours, then the same hour the next day. Plays we still cannot make up are refunded with a credit note.',
  },
  {
    q: 'How many people saw my ads?',
    a: 'The report shows an estimate from the screens’ cameras, as a range. Only counts leave the screen, never pictures. It is never billed and never guaranteed.',
  },
  {
    q: 'When must my ads be ready?',
    a: 'By the date shown on your campaign ("Your ads are due by"), so our team can check them. Late ads may not run on the first days.',
  },
  {
    q: 'Can I start sooner than the portal allows?',
    a: 'Ask us below or call us: our team can sometimes start sooner.',
  },
  {
    q: 'Can I change or cancel a campaign?',
    a: 'Ask us below. Before it is paid nothing is held; once paid, our team looks at what can be changed.',
  },
  {
    q: 'Where are my invoices?',
    a: 'On Invoices: a GST invoice is made when you pay, and a credit note for any refund. Download one or all for the year.',
  },
  {
    q: 'How do I add a colleague?',
    a: 'The owner adds them on Team with their mobile number or work email. They sign in with a code; "can book" people book and add ads, owners also manage the team.',
  },
];

/** The ad rules in words, from the checks' own settings. */
export function adRulesText(r: AdRules): string[] {
  const mb = (b: number) => `${Math.round(b / (1024 * 1024))} MB`;
  const shape = (r.screenAspectMilli / 1000).toString();
  return [
    `A video lasts exactly ${r.spotMs / 1000} seconds; a picture is shown for ${r.spotMs / 1000} seconds.`,
    `Wide, ${shape} : 1 like the screen (1280 × 640 is best); at least ${r.minShortSide} pixels high.`,
    `Pictures up to ${mb(r.maxPictureBytes)}, videos up to ${mb(r.maxVideoBytes)}; MP4 (H.264) plays best.`,
    'No sound: the screens play none.',
    'No flashing, and nothing that looks like a road sign or a traffic light.',
    'Nothing against the law or the advertising code (ASCI): our team checks every ad before it runs.',
    '2 to 5 ads per campaign; they take turns.',
  ];
}
