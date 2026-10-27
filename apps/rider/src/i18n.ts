// The rider app's words in Telugu, Hindi and English (P4.1). Every key exists in all three (a test
// holds this). Telugu and Hindi to be checked by a native speaker before riders see them.
import type { RiderLanguage } from '@recall/domain';

const en = {
  forRiders: 'for riders',
  headline: 'Earn while you ride.',
  pitch:
    'Get paid for the hours your bike moves with the RECALL screen on. Paid to your bank every Monday.',
  language: 'LANGUAGE',
  mobile: 'Mobile number',
  sendWhatsApp: 'Send code on WhatsApp',
  sendSms: 'No WhatsApp? Get the code by SMS',
  newHere:
    'New here? The same button starts your sign-up. Keep your Aadhaar, PAN, vehicle papers and bank details ready.',
  typeCode: 'Type the code',
  sentOn: 'We sent a 6-digit code on {channel} to {phone}. It works for 10 minutes.',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  code: 'Code',
  signIn: 'Sign in',
  newCode: 'Send a new code',
  newCodeIn: 'New code in {s} s',
  changeNumber: 'Change number',
  sending: 'Sending…',
  checking: 'Checking…',
  hello: 'Hello',
  welcome: 'Welcome to RECALL',
  joinNext:
    'Next: your profile, vehicle papers, ID check, bank, agreement and screen loan. These steps open here soon.',
  status_applied: 'Your application is with us. We will call you.',
  status_approved: 'You are approved. Book your fitting next.',
  status_active: 'Your screen is on the road.',
  status_paused: 'Your account is paused. Call support.',
  status_left: 'You have left RECALL.',
  status_rejected: 'Your application was not accepted. Call support to know why.',
  signedInAs: 'Signed in as {phone}',
  signOut: 'Sign out',
  // Errors, by the server's reason code.
  'err.bad-phone': 'Type your 10-digit mobile number.',
  'err.bad-code': 'The code has 6 digits.',
  'err.wrong-code': 'Wrong code. {n} tries left.',
  'err.wrong-code-0': 'Wrong code. Ask for a new one.',
  'err.code-dead': 'This code no longer works. Ask for a new one.',
  'err.too-many-number': 'Too many codes for this number. Try again in {n} minutes.',
  'err.too-many-today': 'Too many codes for this number today. Try again tomorrow.',
  'err.too-many-connection': 'Too many codes from this connection. Try again in an hour.',
  'err.too-many-wrong': 'Too many wrong codes from this connection. Try again in an hour.',
  'err.not-sent-whatsapp': 'The code could not be sent on WhatsApp. Try SMS.',
  'err.not-sent-sms': 'The code could not be sent by SMS. Try again in a minute.',
  'err.not-set-up': 'Sign-in is not open yet. Please try later.',
  'err.signed-out': 'Please sign in again.',
  'err.offline': 'No internet. Check your connection and try again.',
  'err.other': 'Something went wrong. Try again.',
} as const;

export type Key = keyof typeof en;

const te: Record<Key, string> = {
  forRiders: 'రైడర్ల కోసం',
  headline: 'నడుపుతూ సంపాదించండి.',
  pitch:
    'RECALL స్క్రీన్ ఆన్‌లో ఉండి మీ బైక్ కదిలిన గంటలకు డబ్బు పొందండి. ప్రతి సోమవారం మీ బ్యాంక్‌కి చెల్లిస్తాం.',
  language: 'భాష',
  mobile: 'మొబైల్ నంబర్',
  sendWhatsApp: 'WhatsAppలో కోడ్ పంపండి',
  sendSms: 'WhatsApp లేదా? SMS ద్వారా కోడ్ పొందండి',
  newHere:
    'కొత్తవారా? ఇదే బటన్ మీ నమోదును మొదలుపెడుతుంది. మీ ఆధార్, PAN, వాహన పత్రాలు, బ్యాంక్ వివరాలు సిద్ధంగా ఉంచుకోండి.',
  typeCode: 'కోడ్ టైప్ చేయండి',
  sentOn: '{phone}కు {channel}లో 6 అంకెల కోడ్ పంపాం. ఇది 10 నిమిషాలు పనిచేస్తుంది.',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  code: 'కోడ్',
  signIn: 'సైన్ ఇన్',
  newCode: 'కొత్త కోడ్ పంపండి',
  newCodeIn: '{s} సెకన్లలో కొత్త కోడ్',
  changeNumber: 'నంబర్ మార్చండి',
  sending: 'పంపుతున్నాం…',
  checking: 'చూస్తున్నాం…',
  hello: 'నమస్తే',
  welcome: 'RECALLకు స్వాగతం',
  joinNext:
    'తర్వాత: మీ ప్రొఫైల్, వాహన పత్రాలు, ID తనిఖీ, బ్యాంక్, ఒప్పందం, స్క్రీన్ లోన్. ఈ దశలు త్వరలో ఇక్కడ తెరుచుకుంటాయి.',
  status_applied: 'మీ దరఖాస్తు మాకు అందింది. మేము మీకు కాల్ చేస్తాం.',
  status_approved: 'మీరు ఆమోదం పొందారు. తర్వాత మీ ఫిట్టింగ్ బుక్ చేసుకోండి.',
  status_active: 'మీ స్క్రీన్ రోడ్డు మీద ఉంది.',
  status_paused: 'మీ ఖాతా నిలిపివేయబడింది. సపోర్ట్‌కు కాల్ చేయండి.',
  status_left: 'మీరు RECALL నుండి వెళ్లిపోయారు.',
  status_rejected: 'మీ దరఖాస్తు అంగీకరించబడలేదు. కారణం తెలుసుకోవడానికి సపోర్ట్‌కు కాల్ చేయండి.',
  signedInAs: '{phone}తో సైన్ ఇన్ అయ్యారు',
  signOut: 'సైన్ అవుట్',
  'err.bad-phone': 'మీ 10 అంకెల మొబైల్ నంబర్ టైప్ చేయండి.',
  'err.bad-code': 'కోడ్‌లో 6 అంకెలు ఉంటాయి.',
  'err.wrong-code': 'తప్పు కోడ్. ఇంకా {n} ప్రయత్నాలు ఉన్నాయి.',
  'err.wrong-code-0': 'తప్పు కోడ్. కొత్త కోడ్ అడగండి.',
  'err.code-dead': 'ఈ కోడ్ ఇక పనిచేయదు. కొత్త కోడ్ అడగండి.',
  'err.too-many-number': 'ఈ నంబర్‌కు చాలా కోడ్‌లు అడిగారు. {n} నిమిషాల తర్వాత ప్రయత్నించండి.',
  'err.too-many-today': 'ఈరోజు ఈ నంబర్‌కు చాలా కోడ్‌లు అడిగారు. రేపు ప్రయత్నించండి.',
  'err.too-many-connection': 'ఈ కనెక్షన్ నుండి చాలా కోడ్‌లు అడిగారు. ఒక గంట తర్వాత ప్రయత్నించండి.',
  'err.too-many-wrong': 'ఈ కనెక్షన్ నుండి చాలా తప్పు కోడ్‌లు. ఒక గంట తర్వాత ప్రయత్నించండి.',
  'err.not-sent-whatsapp': 'WhatsAppలో కోడ్ పంపలేకపోయాం. SMS ప్రయత్నించండి.',
  'err.not-sent-sms': 'SMS ద్వారా కోడ్ పంపలేకపోయాం. ఒక నిమిషం తర్వాత ప్రయత్నించండి.',
  'err.not-set-up': 'సైన్ ఇన్ ఇంకా తెరవలేదు. తర్వాత ప్రయత్నించండి.',
  'err.signed-out': 'దయచేసి మళ్లీ సైన్ ఇన్ చేయండి.',
  'err.offline': 'ఇంటర్నెట్ లేదు. మీ కనెక్షన్ చూసి మళ్లీ ప్రయత్నించండి.',
  'err.other': 'ఏదో తప్పు జరిగింది. మళ్లీ ప్రయత్నించండి.',
};

const hi: Record<Key, string> = {
  forRiders: 'राइडर्स के लिए',
  headline: 'चलाते हुए कमाइए।',
  pitch:
    'RECALL स्क्रीन चालू रहते आपकी बाइक जितने घंटे चलती है, उसके पैसे पाइए। हर सोमवार आपके बैंक में।',
  language: 'भाषा',
  mobile: 'मोबाइल नंबर',
  sendWhatsApp: 'WhatsApp पर कोड भेजें',
  sendSms: 'WhatsApp नहीं है? SMS से कोड पाएं',
  newHere:
    'नए हैं? यही बटन आपका साइन-अप शुरू करता है। अपना आधार, PAN, गाड़ी के कागज़ और बैंक की जानकारी तैयार रखें।',
  typeCode: 'कोड लिखें',
  sentOn: 'हमने {phone} पर {channel} से 6 अंकों का कोड भेजा है। यह 10 मिनट तक काम करेगा।',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  code: 'कोड',
  signIn: 'साइन इन',
  newCode: 'नया कोड भेजें',
  newCodeIn: '{s} सेकंड में नया कोड',
  changeNumber: 'नंबर बदलें',
  sending: 'भेज रहे हैं…',
  checking: 'जाँच रहे हैं…',
  hello: 'नमस्ते',
  welcome: 'RECALL में आपका स्वागत है',
  joinNext:
    'आगे: आपकी प्रोफ़ाइल, गाड़ी के कागज़, ID जाँच, बैंक, अनुबंध और स्क्रीन लोन। ये कदम जल्द यहाँ खुलेंगे।',
  status_applied: 'आपका आवेदन हमें मिल गया है। हम आपको कॉल करेंगे।',
  status_approved: 'आप मंज़ूर हो गए हैं। अब अपनी फ़िटिंग बुक करें।',
  status_active: 'आपकी स्क्रीन सड़क पर है।',
  status_paused: 'आपका खाता रुका हुआ है। सपोर्ट को कॉल करें।',
  status_left: 'आप RECALL छोड़ चुके हैं।',
  status_rejected: 'आपका आवेदन स्वीकार नहीं हुआ। कारण जानने के लिए सपोर्ट को कॉल करें।',
  signedInAs: '{phone} से साइन इन',
  signOut: 'साइन आउट',
  'err.bad-phone': 'अपना 10 अंकों का मोबाइल नंबर लिखें।',
  'err.bad-code': 'कोड में 6 अंक होते हैं।',
  'err.wrong-code': 'गलत कोड। {n} कोशिशें बाकी हैं।',
  'err.wrong-code-0': 'गलत कोड। नया कोड मांगें।',
  'err.code-dead': 'यह कोड अब काम नहीं करेगा। नया कोड मांगें।',
  'err.too-many-number': 'इस नंबर के लिए बहुत कोड मांगे गए। {n} मिनट बाद कोशिश करें।',
  'err.too-many-today': 'आज इस नंबर के लिए बहुत कोड मांगे गए। कल कोशिश करें।',
  'err.too-many-connection': 'इस कनेक्शन से बहुत कोड मांगे गए। एक घंटे बाद कोशिश करें।',
  'err.too-many-wrong': 'इस कनेक्शन से बहुत गलत कोड। एक घंटे बाद कोशिश करें।',
  'err.not-sent-whatsapp': 'WhatsApp पर कोड नहीं भेज पाए। SMS से कोशिश करें।',
  'err.not-sent-sms': 'SMS से कोड नहीं भेज पाए। एक मिनट बाद कोशिश करें।',
  'err.not-set-up': 'साइन इन अभी शुरू नहीं हुआ है। बाद में कोशिश करें।',
  'err.signed-out': 'कृपया फिर से साइन इन करें।',
  'err.offline': 'इंटरनेट नहीं है। अपना कनेक्शन देखकर फिर कोशिश करें।',
  'err.other': 'कुछ गड़बड़ हो गई। फिर कोशिश करें।',
};

export const WORDS: Readonly<Record<RiderLanguage, Readonly<Record<Key, string>>>> = { en, te, hi };

/** The language names, each in its own script (the order on the sign-in screen). */
export const LANGUAGE_NAMES: readonly (readonly [RiderLanguage, string])[] = [
  ['te', 'తెలుగు'],
  ['hi', 'हिन्दी'],
  ['en', 'English'],
];

/** A text in the language, with {blanks} filled. */
export function say(
  lang: RiderLanguage,
  key: Key,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return (WORDS[lang][key] ?? en[key]).replace(/\{(\w+)\}/g, (all, k: string) =>
    values[k] === undefined ? all : String(values[k]),
  );
}

/** An API error in the rider's language (by its reason code), or a plain fallback. */
export function sayError(
  lang: RiderLanguage,
  why: string | undefined,
  n: number | undefined,
): string {
  if (why === 'wrong-code' && n === 0) return say(lang, 'err.wrong-code-0');
  const key = `err.${why ?? 'other'}`;
  return key in en ? say(lang, key as Key, { n: n ?? '' }) : say(lang, 'err.other');
}
