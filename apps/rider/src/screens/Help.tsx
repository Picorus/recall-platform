// P4.9 Help: common questions, WhatsApp chat and a call to support (with its hours), writing to
// support from the app, and his requests with where each stands.
import type { RiderLanguage } from '@recall/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { ApiError, call } from '../api';
import { say, sayError, type Key } from '../i18n';
import { color } from '../theme';
import { Alert, Field, Label, LinkButton, MainButton, Muted, Screen, Title, Words, s } from '../ui';

interface HelpPage {
  readonly phones: readonly {
    readonly label: string;
    readonly phone: string;
    readonly whatsapp: boolean;
  }[];
  readonly open: boolean;
  readonly opens: string;
  readonly closes: string;
  readonly requests: readonly {
    readonly at: number;
    readonly subject: string;
    readonly state: 'open' | 'waiting' | 'done';
  }[];
}

const FAQ = [1, 2, 3, 4, 5, 6] as const;
const dm = (t: number) => {
  const d = new Date((t + 19_800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export function Help({
  lang,
  token,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly onSignOut: () => void;
}) {
  const [page, setPage] = useState<HelpPage>();
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [openQ, setOpenQ] = useState<number>();
  const signOut = useRef(onSignOut);
  signOut.current = onSignOut;

  const failed = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) signOut.current();
      else
        setError(
          e instanceof ApiError && e.why ? sayError(lang, e.why, e.n) : say(lang, 'err.other'),
        );
    },
    [lang],
  );
  const load = useCallback(async () => {
    try {
      setPage(await call<HelpPage>('/rider/help', { token }));
    } catch (e) {
      failed(e);
    }
  }, [token, failed]);
  useEffect(() => {
    void load();
  }, [load]);

  const ask = async () => {
    setBusy(true);
    setError('');
    try {
      await call('/rider/help', { token, body: { text: text.trim() } });
      setText('');
      setSent(true);
      await load();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const wa = page?.phones.find((p) => p.whatsapp);
  const tel = page?.phones[0];
  return (
    <Screen>
      <Title>{say(lang, 'helpTitle')}</Title>
      {error !== '' && <Alert>{error}</Alert>}
      {page && (
        <View style={[s.card, { borderColor: color.volt }]}>
          <Label>{say(lang, page.open ? 'supportOpen' : 'supportClosed')}</Label>
          <Muted small>
            {say(lang, 'supportHours', { opens: page.opens, closes: page.closes })}
          </Muted>
          {wa && (
            <MainButton
              label={say(lang, 'chatWhatsApp')}
              onPress={() => void Linking.openURL(`https://wa.me/${wa.phone.replace(/\D/g, '')}`)}
            />
          )}
          {tel && (
            <LinkButton
              label={say(lang, 'callSupport', { phone: tel.phone })}
              onPress={() => void Linking.openURL(`tel:${tel.phone}`)}
            />
          )}
          {page.phones.length === 0 && <Muted small>{say(lang, 'noNumbersYet')}</Muted>}
        </View>
      )}

      <View style={[s.card, { gap: 10 }]}>
        <Label>{say(lang, 'writeToUs')}</Label>
        <Field
          label={say(lang, 'yourQuestion')}
          value={text}
          onChangeText={(t) => {
            setText(t);
            setSent(false);
          }}
          multiline
          maxLength={2000}
          style={[s.input, { minHeight: 88, fontFamily: undefined, textAlignVertical: 'top' }]}
        />
        <MainButton
          label={say(lang, 'send')}
          busy={busy}
          disabled={text.trim().length < 3}
          onPress={() => void ask()}
        />
        {sent && <Muted>{say(lang, 'questionSent')}</Muted>}
      </View>

      <View style={s.card}>
        <Label>{say(lang, 'yourRequests')}</Label>
        {page?.requests.length === 0 && <Muted small>{say(lang, 'noRequests')}</Muted>}
        {page?.requests.map((r, i) => (
          <View key={`${r.at}-${i}`} style={{ paddingVertical: 4, gap: 2 }}>
            <Words
              style={{ color: color.text, fontSize: 15 }}
            >{`${dm(r.at)} · ${r.subject}`}</Words>
            <Words
              weight="semibold"
              style={{ color: r.state === 'done' ? color.done : color.muted, fontSize: 13 }}
            >
              {say(lang, `report.${r.state}` as Key)}
            </Words>
          </View>
        ))}
      </View>

      <View style={s.card}>
        <Label>{say(lang, 'faqTitle')}</Label>
        {FAQ.map((n) => (
          <View key={n} style={{ gap: 4 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: openQ === n }}
              onPress={() => setOpenQ(openQ === n ? undefined : n)}
              style={{ minHeight: 44, justifyContent: 'center' }}
            >
              <Words weight="semibold" style={{ color: color.text, fontSize: 15 }}>
                {say(lang, `faq${n}q` as Key)}
              </Words>
            </Pressable>
            {openQ === n && <Muted>{say(lang, `faq${n}a` as Key)}</Muted>}
          </View>
        ))}
      </View>
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
