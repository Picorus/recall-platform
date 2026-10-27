// The Night Signal faces, bundled with the app (P4.1): Anek in the rider's script (Telugu, Devanagari
// or Latin; each also carries Latin letters, so mixed text stays one family) and IBM Plex Mono for
// numbers. A phone does not fall back between faces the way a browser does, so each text names the
// one face for its language and weight.
import { AnekDevanagari_400Regular } from '@expo-google-fonts/anek-devanagari/400Regular';
import { AnekDevanagari_600SemiBold } from '@expo-google-fonts/anek-devanagari/600SemiBold';
import { AnekDevanagari_800ExtraBold } from '@expo-google-fonts/anek-devanagari/800ExtraBold';
import { AnekLatin_400Regular } from '@expo-google-fonts/anek-latin/400Regular';
import { AnekLatin_600SemiBold } from '@expo-google-fonts/anek-latin/600SemiBold';
import { AnekLatin_800ExtraBold } from '@expo-google-fonts/anek-latin/800ExtraBold';
import { AnekTelugu_400Regular } from '@expo-google-fonts/anek-telugu/400Regular';
import { AnekTelugu_600SemiBold } from '@expo-google-fonts/anek-telugu/600SemiBold';
import { AnekTelugu_800ExtraBold } from '@expo-google-fonts/anek-telugu/800ExtraBold';
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium';
import type { RiderLanguage } from '@recall/domain';

/** Loaded once when the app starts (expo-font). */
export const FONT_FILES = {
  AnekLatin_400Regular,
  AnekLatin_600SemiBold,
  AnekLatin_800ExtraBold,
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
  en: 'AnekLatin',
  te: 'AnekTelugu',
  hi: 'AnekDevanagari',
};
const SUFFIX: Record<Weight, string> = {
  regular: '400Regular',
  semibold: '600SemiBold',
  extrabold: '800ExtraBold',
};

/** The face for words in this language and weight. */
export const face = (lang: RiderLanguage, weight: Weight = 'regular') =>
  `${FAMILY[lang]}_${SUFFIX[weight]}`;

/** The face for numbers (phone numbers, codes, money). */
export const MONO = 'IBMPlexMono_500Medium';
