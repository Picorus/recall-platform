// P4.11 Profile and settings: his details, the app's language, his papers (a renewed RC or insurance
// can be sent), where he is paid and asking to change it, leaving RECALL, and deleting his account.
// The last three are requests to support (a super admin changes his bank with him on a call).
import type { RiderLanguage } from '@recall/domain';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ApiError, call, upload } from '../api';
import { LANGUAGE_NAMES, say, sayError, type Key } from '../i18n';
import { color, touch } from '../theme';
import { Alert, Label, LinkButton, MainButton, Muted, Screen, Title, Words, s } from '../ui';

type DocState = 'todo' | 'waiting' | 'done' | 'again';
type RequestKind = 'bank-change' | 'leave' | 'delete';

interface ProfilePage {
  readonly riderId: string;
  readonly name: string;
  readonly shown: string;
  readonly bikePlate: string | null;
  readonly documents: Readonly<
    Record<
      'photo' | 'rc' | 'insurance',
      { readonly state: DocState; readonly expiresOn: string | null }
    >
  >;
  readonly account: string | null;
  readonly open: readonly RequestKind[];
}

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

export function Profile({
  lang,
  token,
  onLanguage,
  onBack,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly onLanguage: (l: RiderLanguage) => void;
  readonly onBack: () => void;
  readonly onSignOut: () => void;
}) {
  const [page, setPage] = useState<ProfilePage>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState<RequestKind>();
  const [done, setDone] = useState('');
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
      setPage(await call<ProfilePage>('/rider/profile', { token }));
    } catch (e) {
      failed(e);
    }
  }, [token, failed]);
  useEffect(() => {
    void load();
  }, [load]);

  const ask = async (kind: RequestKind) => {
    setBusy(kind);
    setError('');
    try {
      await call('/rider/requests', { token, body: { kind } });
      setConfirm(undefined);
      setDone(say(lang, `request.sent.${kind}` as Key));
      await load();
    } catch (e) {
      failed(e);
    } finally {
      setBusy('');
    }
  };

  const renew = async (kind: 'rc' | 'insurance') => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
    const uri = r.canceled ? undefined : r.assets[0]?.uri;
    if (!uri) return;
    setBusy(kind);
    setError('');
    try {
      await upload(`/rider/documents?kind=${kind}`, uri, token);
      setDone(say(lang, 'uploaded'));
      await load();
    } catch (e) {
      failed(e);
    } finally {
      setBusy('');
    }
  };

  const requestButton = (kind: RequestKind, label: Key, sure: Key) =>
    page?.open.includes(kind) ? (
      <Muted small>{say(lang, `request.open.${kind}` as Key)}</Muted>
    ) : confirm === kind ? (
      <View style={{ gap: 8 }}>
        <Alert>{say(lang, sure)}</Alert>
        <MainButton
          label={say(lang, 'yesAsk')}
          busy={busy === kind}
          onPress={() => void ask(kind)}
        />
        <LinkButton label={say(lang, 'back')} onPress={() => setConfirm(undefined)} />
      </View>
    ) : (
      <LinkButton label={say(lang, label)} onPress={() => setConfirm(kind)} />
    );

  return (
    <Screen>
      <View style={{ alignSelf: 'flex-start' }}>
        <LinkButton label={say(lang, 'back')} onPress={onBack} />
      </View>
      <Title>{say(lang, 'profileTitle')}</Title>
      {error !== '' && <Alert>{error}</Alert>}
      {done !== '' && <Muted>{done}</Muted>}
      {page && (
        <>
          <View style={s.card}>
            <Words weight="semibold" style={{ color: color.text, fontSize: 18 }}>
              {page.name}
            </Words>
            <Muted small>{`${page.riderId} · ${page.shown.replace(/ /g, ' ')}`}</Muted>
            {page.bikePlate && <Words style={[s.mono, { fontSize: 15 }]}>{page.bikePlate}</Words>}
          </View>

          <View style={s.card}>
            <Label>{say(lang, 'language')}</Label>
            <View
              style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}
              accessibilityRole="radiogroup"
            >
              {LANGUAGE_NAMES.map(([code, name]) => (
                <Pressable
                  key={code}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: lang === code }}
                  accessibilityLabel={name}
                  onPress={() => onLanguage(code)}
                  style={{
                    minHeight: touch.min,
                    paddingHorizontal: 14,
                    borderRadius: 999,
                    justifyContent: 'center',
                    borderWidth: 1,
                    borderColor: lang === code ? color.volt : color.line,
                    backgroundColor: lang === code ? color.volt : 'transparent',
                  }}
                >
                  <Words style={{ color: lang === code ? color.onVolt : color.text, fontSize: 15 }}>
                    {name}
                  </Words>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={[s.card, { gap: 10 }]}>
            <Label>{say(lang, 'yourPapers')}</Label>
            {(['photo', 'rc', 'insurance'] as const).map((k) => {
              const d = page.documents[k];
              return (
                <View key={k} style={{ gap: 4 }}>
                  <View style={[s.row, { justifyContent: 'space-between' }]}>
                    <Words style={{ color: color.text, fontSize: 15 }}>
                      {say(lang, `doc.${k}` as Key)}
                    </Words>
                    <Words
                      weight="semibold"
                      style={{
                        color:
                          d.state === 'done'
                            ? color.done
                            : d.state === 'again'
                              ? color.error
                              : color.muted,
                        fontSize: 13,
                      }}
                    >
                      {say(lang, `doc.${d.state}` as Key)}
                    </Words>
                  </View>
                  {d.expiresOn && (
                    <Muted small>{say(lang, 'validUntil', { d: dmy(d.expiresOn) })}</Muted>
                  )}
                  {k !== 'photo' && (
                    <LinkButton
                      label={say(lang, 'sendNewOne')}
                      disabled={busy !== ''}
                      onPress={() => void renew(k)}
                    />
                  )}
                </View>
              );
            })}
          </View>

          <View style={s.card}>
            <Label>{say(lang, 'paidToTitle')}</Label>
            <Muted>{page.account ?? say(lang, 'noAccountShort')}</Muted>
            {requestButton('bank-change', 'changeBank', 'sureBank')}
          </View>

          <View style={s.card}>
            {requestButton('leave', 'leaveRecall', 'sureLeave')}
            {requestButton('delete', 'deleteAccount', 'sureDelete')}
          </View>
        </>
      )}
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
