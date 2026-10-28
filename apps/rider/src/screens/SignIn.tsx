// P4.1 sign-in (approved screen R01): pick a language, type the mobile number, get a code on
// WhatsApp (or by SMS). A new number starts the sign-up the same way.
import NIGHT from '@recall/design/photos/avenue-s.webp';
import {
  groupMobile,
  indiaMobile,
  regroupMobile,
  type CodeChannel,
  type RiderLanguage,
} from '@recall/domain';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, call } from '../api';
import { LANGUAGE_NAMES, say, sayError } from '../i18n';
import { face, SERIF } from '../fonts';
import { color, radius, touch } from '../theme';
import { Alert, Field, LinkButton, Logo, MainButton, Muted, Screen, Title } from '../ui';

export interface CodeSent {
  readonly phone: string;
  readonly shown: string;
  readonly channel: CodeChannel;
  readonly expiresAt: number;
}

export function SignIn({
  lang,
  onLanguage,
  initialPhone,
  onSent,
}: {
  readonly lang: RiderLanguage;
  readonly onLanguage: (l: RiderLanguage) => void;
  readonly initialPhone: string;
  readonly onSent: (sent: CodeSent) => void;
}) {
  const [phone, setPhone] = useState(() => groupMobile(initialPhone));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<CodeChannel | null>(null);
  const send = (channel: CodeChannel) => {
    const full = indiaMobile(phone);
    if (!full) {
      setError(say(lang, 'err.bad-phone'));
      return;
    }
    setBusy(channel);
    setError('');
    call<{ phone: string; shown: string; expiresAt: number }>('/rider/code', {
      body: { phone: full, channel, language: lang },
    })
      .then((x) => onSent({ ...x, channel }))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? sayError(lang, e.why, e.n) : say(lang, 'err.other')),
      )
      .finally(() => setBusy(null));
  };
  return (
    <Screen>
      {/* Hyderabad at night (drawn for RECALL): the street the rider is about to light up. */}
      <View style={h.hero} accessible={false}>
        <Image source={NIGHT} style={h.photo} resizeMode="cover" />
        <View style={h.fade1} />
        <View style={h.fade2} />
        <View style={h.logo}>
          <Logo tagline={say(lang, 'forRiders')} />
        </View>
      </View>
      <View style={{ gap: 8, marginTop: -64 }}>
        {lang === 'en' ? (
          <Text style={h.serif} accessibilityRole="header">
            {say(lang, 'headline')}
          </Text>
        ) : (
          <Title>{say(lang, 'headline')}</Title>
        )}
        <Muted>{say(lang, 'pitch')}</Muted>
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Language"
        style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}
      >
        {LANGUAGE_NAMES.map(([code, name]) => {
          const on = code === lang;
          return (
            <Pressable
              key={code}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={name}
              onPress={() => onLanguage(code)}
              style={({ pressed }) => ({
                minHeight: touch.min,
                paddingHorizontal: 16,
                borderRadius: radius.pill,
                justifyContent: 'center',
                backgroundColor: on ? color.text : 'transparent',
                borderWidth: 1,
                borderColor: on ? color.text : color.line,
                transform: [{ scale: pressed ? 0.96 : 1 }],
              })}
            >
              <Text
                style={{
                  color: on ? color.ground : color.text,
                  fontSize: 15.5,
                  fontFamily: face(code, 'semibold'),
                }}
              >
                {name}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Field
        label={say(lang, 'mobile')}
        prefix="+91"
        value={phone}
        // Grouped as typed ("98480 12345"), so it reads easily; what is sent is read again.
        onChangeText={(t) => setPhone((was) => regroupMobile(t, was))}
        keyboardType="phone-pad"
        inputMode="tel"
        autoComplete="tel"
        // Room for a pasted "+91 98480-12345".
        maxLength={20}
        onSubmitEditing={() => send('whatsapp')}
      />
      {error !== '' && <Alert>{error}</Alert>}
      <MainButton
        label={say(lang, 'sendWhatsApp')}
        busy={busy === 'whatsapp'}
        disabled={busy !== null}
        onPress={() => send('whatsapp')}
      />
      <LinkButton
        label={say(lang, 'sendSms')}
        disabled={busy !== null}
        onPress={() => send('sms')}
      />
      <Muted small>{say(lang, 'newHere')}</Muted>
    </Screen>
  );
}

const h = StyleSheet.create({
  hero: {
    height: 300,
    marginHorizontal: -20,
    marginTop: -20,
    overflow: 'hidden',
    justifyContent: 'flex-start',
  },
  photo: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
  },
  // A soft fall into the page's ground (no gradient library: two veils).
  fade1: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 150,
    backgroundColor: color.ground,
    opacity: 0.55,
  },
  fade2: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 70,
    backgroundColor: color.ground,
    opacity: 0.9,
  },
  logo: { paddingTop: 28, paddingHorizontal: 20 },
  serif: {
    color: color.text,
    fontFamily: SERIF,
    fontSize: 48,
    lineHeight: 50,
    letterSpacing: -0.5,
  },
});
