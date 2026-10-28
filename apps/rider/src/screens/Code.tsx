// P4.1: type the 6-digit code that came on WhatsApp or SMS. A new code can be asked for after 30
// seconds; the number can be changed.
import { typedCode, type RiderLanguage } from '@recall/domain';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ApiError, call } from '../api';
import { say, sayError } from '../i18n';
import { Alert, Field, LinkButton, MainButton, Muted, s, Screen, Title } from '../ui';
import type { CodeSent } from './SignIn';

const RESEND_AFTER_S = 30;

export function Code({
  lang,
  sent,
  onSignedIn,
  onResent,
  onChangeNumber,
}: {
  readonly lang: RiderLanguage;
  readonly sent: CodeSent;
  readonly onSignedIn: (token: string) => void;
  readonly onResent: (sent: CodeSent) => void;
  readonly onChangeNumber: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(RESEND_AFTER_S);
  useEffect(() => {
    setWait(RESEND_AFTER_S);
    const t = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(t);
  }, [sent]);
  const failed = (e: unknown) =>
    setError(e instanceof ApiError ? sayError(lang, e.why, e.n) : say(lang, 'err.other'));
  const check = () => {
    const c = typedCode(code);
    if (!c) {
      setError(say(lang, 'err.bad-code'));
      return;
    }
    setBusy(true);
    setError('');
    call<{ token: string }>('/rider/sign-in', { body: { phone: sent.phone, code: c } })
      .then((x) => onSignedIn(x.token))
      .catch(failed)
      .finally(() => setBusy(false));
  };
  const resend = () => {
    setBusy(true);
    setError('');
    setCode('');
    call<{ phone: string; shown: string; expiresAt: number }>('/rider/code', {
      body: { phone: sent.phone, channel: sent.channel, language: lang },
    })
      .then((x) => onResent({ ...x, channel: sent.channel }))
      .catch(failed)
      .finally(() => setBusy(false));
  };
  return (
    <Screen>
      <LinkButton label={say(lang, 'changeNumber')} onPress={onChangeNumber} />
      <View style={{ gap: 8 }}>
        <Title>{say(lang, 'typeCode')}</Title>
        <Muted>
          {say(lang, 'sentOn', {
            channel: say(lang, sent.channel === 'whatsapp' ? 'whatsapp' : 'sms'),
            // Kept on one line.
            phone: sent.shown.replace(/ /g, '\u00a0'),
          })}
        </Muted>
      </View>
      <Field
        label={say(lang, 'code')}
        value={code}
        onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
        // Big digits that stand apart ("4 8 2 9 1 5"); the code itself stays "482915".
        style={[s.input, s.code]}
        keyboardType="number-pad"
        inputMode="numeric"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        // Room for a pasted "123 456": the box keeps only its 6 digits.
        maxLength={12}
        autoFocus
        onSubmitEditing={check}
      />
      {error !== '' && <Alert>{error}</Alert>}
      <MainButton label={say(lang, 'signIn')} busy={busy} onPress={check} />
      <LinkButton
        label={wait > 0 ? say(lang, 'newCodeIn', { s: wait }) : say(lang, 'newCode')}
        disabled={wait > 0 || busy}
        onPress={resend}
      />
    </Screen>
  );
}
