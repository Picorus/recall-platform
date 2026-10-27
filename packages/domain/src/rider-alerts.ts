// P4.10: alerts to the rider's phone: his payout sent, his screen gone silent or its battery low,
// a repair or a swap booked for his screen. Never while his bike is moving (he is riding): an alert
// waits until the bike stops, and one older than a day is not sent at all (it would be old news).
// The words are his language's (te, hi, en); the numbers are the same in all three.
import type { RiderLanguage } from './rider-sign-in.js';

export const RIDER_ALERT_KINDS = [
  'payout-paid',
  'screen-offline',
  'battery-low',
  'repair-booked',
] as const;
export type RiderAlertKind = (typeof RIDER_ALERT_KINDS)[number];

/** An alert older than this is not sent any more (seconds): only shown in the app's list. */
export const ALERT_SEND_WITHIN = 86_400;

const WORDS: Readonly<
  Record<RiderLanguage, Readonly<Record<RiderAlertKind, readonly [string, string]>>>
> = {
  en: {
    'payout-paid': ['Payout sent', '{amount} is on its way to your account.'],
    'screen-offline': [
      'Your screen is silent',
      'We have not heard from it for {minutes} minutes. Check its power.',
    ],
    'battery-low': ['Battery low', 'Your screen battery is at {pct}%. Charge it soon.'],
    'repair-booked': [
      'Repair booked',
      'Support has booked a repair or swap for your screen. They will call you.',
    ],
  },
  te: {
    'payout-paid': ['చెల్లింపు పంపాం', '{amount} మీ ఖాతాకు వస్తోంది.'],
    'screen-offline': [
      'మీ స్క్రీన్ నుండి సమాచారం లేదు',
      '{minutes} నిమిషాలుగా దాని నుండి సమాచారం లేదు. పవర్ చూడండి.',
    ],
    'battery-low': ['బ్యాటరీ తక్కువ', 'మీ స్క్రీన్ బ్యాటరీ {pct}% ఉంది. త్వరలో ఛార్జ్ చేయండి.'],
    'repair-booked': [
      'రిపేర్ బుక్ అయింది',
      'సపోర్ట్ మీ స్క్రీన్‌కు రిపేర్ లేదా మార్పిడి బుక్ చేసింది. వారు మీకు కాల్ చేస్తారు.',
    ],
  },
  hi: {
    'payout-paid': ['भुगतान भेजा', '{amount} आपके खाते में आ रहा है।'],
    'screen-offline': [
      'आपकी स्क्रीन से संपर्क नहीं',
      '{minutes} मिनट से उससे कोई संपर्क नहीं। बिजली देखें।',
    ],
    'battery-low': ['बैटरी कम', 'आपकी स्क्रीन की बैटरी {pct}% है। जल्द चार्ज करें।'],
    'repair-booked': [
      'रिपेयर बुक हुआ',
      'सपोर्ट ने आपकी स्क्रीन का रिपेयर या बदलाव बुक किया है। वे आपको कॉल करेंगे।',
    ],
  },
};

/** An alert's title and text in his language, its {blanks} filled. */
export function alertWords(
  lang: RiderLanguage,
  kind: RiderAlertKind,
  values: Readonly<Record<string, string | number>>,
): { readonly title: string; readonly body: string } {
  const [title, body] = WORDS[lang][kind];
  const fill = (t: string) => t.replace(/\{(\w+)\}/g, (all, k: string) => String(values[k] ?? all));
  return { title: fill(title), body: fill(body) };
}

/** No notification between these hours, India time (a phone buzzing at 3 am helps nobody). */
export const QUIET_FROM_HOUR = 22;
export const QUIET_UNTIL_HOUR = 7;

/**
 * Whether an alert made at `madeAt` may go to his phone at `now`: not while he rides, not at night
 * in India, not stale.
 */
export function mayPush(madeAt: number, now: number, moving: boolean): boolean {
  const hour = Math.floor(((((now + 19_800) % 86_400) + 86_400) % 86_400) / 3600);
  const night = hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
  return !moving && !night && now - madeAt <= ALERT_SEND_WITHIN;
}
