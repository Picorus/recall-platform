// The Night Signal faces, bundled with the app (P4.1; Design 2.0, P7.7.3): Instrument Sans for
// English, Anek in Telugu and Devanagari (each also carries Latin letters, so mixed text stays one
// family) and IBM Plex Mono for codes. A phone does not fall back between faces the way a browser does, so each text names the
// one face for its language and weight.
import { AnekDevanagari_400Regular } from '@expo-google-fonts/anek-devanagari/400Regular';
import { AnekDevanagari_600SemiBold } from '@expo-google-fonts/anek-devanagari/600SemiBold';
import { AnekDevanagari_800ExtraBold } from '@expo-google-fonts/anek-devanagari/800ExtraBold';
import { AnekTelugu_400Regular } from '@expo-google-fonts/anek-telugu/400Regular';
import { AnekTelugu_600SemiBold } from '@expo-google-fonts/anek-telugu/600SemiBold';
import { AnekTelugu_800ExtraBold } from '@expo-google-fonts/anek-telugu/800ExtraBold';
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium';
import { InstrumentSerif_400Regular } from '@expo-google-fonts/instrument-serif/400Regular';
import { InstrumentSerif_400Regular_Italic } from '@expo-google-fonts/instrument-serif/400Regular_Italic';
import { InstrumentSans_400Regular } from '@expo-google-fonts/instrument-sans/400Regular';
import { InstrumentSans_600SemiBold } from '@expo-google-fonts/instrument-sans/600SemiBold';
import { InstrumentSans_700Bold } from '@expo-google-fonts/instrument-sans/700Bold';
import type { RiderLanguage } from '@recall/domain';

/** Loaded once when the app starts (expo-font). */
export const FONT_FILES = {
  InstrumentSans_400Regular,
  InstrumentSerif_400Regular,
  InstrumentSerif_400Regular_Italic,
  InstrumentSans_600SemiBold,
  InstrumentSans_700Bold,
  AnekTelugu_400Regular,
  AnekTelugu_600SemiBold,
  AnekTelugu_800ExtraBold,
  AnekDevanagari_400Regular,
  AnekDevanagari_600SemiBold,
  AnekDevanagari_800ExtraBold,
  IBMPlexMono_500Medium,
};

export type Weight = 'regular' | 'semibold' | 'extrabold';

const FAMILY: Record<RiderLanguage, string> = {
  en: 'InstrumentSans',
  te: 'AnekTelugu',
  hi: 'AnekDevanagari',
};
const SUFFIX: Record<Weight, string> = {
  regular: '400Regular',
  semibold: '600SemiBold',
  extrabold: '800ExtraBold',
};
// Instrument Sans stops at 700: its boldest face stands in for "extrabold".
const LATIN_SUFFIX: Record<Weight, string> = { ...SUFFIX, extrabold: '700Bold' };

/** The face for words in this language and weight. */
export const face = (lang: RiderLanguage, weight: Weight = 'regular') =>
  `${FAMILY[lang]}_${(lang === 'en' ? LATIN_SUFFIX : SUFFIX)[weight]}`;

/** The display face for the one big English headline on the sign-in screen (Telugu and Hindi keep Anek). */
export const SERIF = 'InstrumentSerif_400Regular';
export const SERIF_ITALIC = 'InstrumentSerif_400Regular_Italic';

/** The face for numbers (phone numbers, codes, money). */
export const MONO = 'IBMPlexMono_500Medium';
