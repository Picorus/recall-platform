// P4.1 sign-in (approved screen R01): pick a language, type the mobile number, get a code on
// WhatsApp (or by SMS). A new number starts the sign-up the same way.
import { indiaMobile, type CodeChannel, type RiderLanguage } from '@recall/domain';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ApiError, call } from '../api';
import { LANGUAGE_NAMES, say, sayError } from '../i18n';
import { face } from '../fonts';
import { color, touch } from '../theme';
import { Alert, Field, LinkButton, Logo, MainButton, Muted, Screen, Title, Words, s } from '../ui';

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
  const [phone, setPhone] = useState(initialPhone);
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
      <Logo tagline={say(lang, 'forRiders')} />
      <View style={{ gap: 8 }}>
        <Title>{say(lang, 'headline')}</Title>
        <Muted>{say(lang, 'pitch')}</Muted>
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel="Language" style={{ gap: 8 }}>
        <Words weight="semibold" style={[s.muted13, { letterSpacing: 1.4 }]}>
          {say(lang, 'language')}
        </Words>
        {LANGUAGE_NAMES.map(([code, name]) => {
          const on = code === lang;
          return (
            <Pressable
              key={code}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={name}
              onPress={() => onLanguage(code)}
              style={{
                minHeight: touch.main,
                paddingHorizontal: 16,
                borderRadius: 6,
                justifyContent: 'center',
                backgroundColor: on ? color.raised : 'transparent',
                borderWidth: on ? 2 : 1,
                borderColor: on ? color.text : color.line,
              }}
            >
              <Text style={{ color: color.text, fontSize: 17, fontFamily: face(code, 'semibold') }}>
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
        onChangeText={setPhone}
        keyboardType="phone-pad"
        inputMode="tel"
        autoComplete="tel"
        maxLength={16}
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
