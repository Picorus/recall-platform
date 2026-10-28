// P4.8 Screen care: how to charge and look after the screen; report a problem (not turning on,
// damage, theft, an accident) with a photo, which reaches support at once (a stolen screen or an
// accident is marked urgent); his reports and where each stands. His screen loan (P4.7) opens from
// here too.
import type { RiderLanguage } from '@recall/domain';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import { ApiError, call, upload } from '../api';
import { say, sayError, type Key } from '../i18n';
import { color, touch } from '../theme';
import {
  Alert,
  Fold,
  Field,
  Label,
  LinkButton,
  MainButton,
  Muted,
  Screen,
  Title,
  Words,
  s,
} from '../ui';
import { Loan } from './Loan';

const KINDS = ['not-on', 'damage', 'theft', 'accident', 'other'] as const;
type Kind = (typeof KINDS)[number];

interface Problem {
  readonly problemId: string;
  readonly kind: Kind;
  readonly at: number;
  readonly state: 'open' | 'waiting' | 'done';
}

const dmy = (t: number) => {
  const d = new Date((t + 19_800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export function Care({
  lang,
  token,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly onSignOut: () => void;
}) {
  const [showLoan, setShowLoan] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [kind, setKind] = useState<Kind>();
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
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
      setProblems((await call<{ problems: Problem[] }>('/rider/care', { token })).problems);
    } catch (e) {
      failed(e);
    }
  }, [token, failed]);
  useEffect(() => {
    void load();
  }, [load]);
  // Android's back button closes the loan page (not the app).
  useEffect(() => {
    if (!showLoan) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setShowLoan(false);
      return true;
    });
    return () => sub.remove();
  }, [showLoan]);

  const pick = async (camera: boolean) => {
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.6 };
    if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) return;
    const r = camera
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    const uri = r.canceled ? undefined : r.assets[0]?.uri;
    if (uri) setPhoto(uri);
  };

  const send = async () => {
    if (!kind) return;
    setBusy(true);
    setError('');
    const path = `/rider/problems?kind=${kind}`;
    try {
      if (photo) await upload(path, photo, token, { 'x-note': encodeURIComponent(note.trim()) });
      else await call(path, { token, body: { note: note.trim() } });
      setKind(undefined);
      setNote('');
      setPhoto(undefined);
      setSent(true);
    } catch (e) {
      failed(e);
      setBusy(false);
      return;
    }
    // Sent: a failed refresh of his list is not a failed report.
    try {
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (showLoan)
    return (
      <Loan lang={lang} token={token} onSignOut={onSignOut} onBack={() => setShowLoan(false)} />
    );

  return (
    <Screen>
      <Title>{say(lang, 'careTitle')}</Title>

      <Fold title={say(lang, 'careTipsTitle')}>
        {(['careTip1', 'careTip2', 'careTip3', 'careTip4'] as const).map((k) => (
          <Muted key={k}>{`• ${say(lang, k)}`}</Muted>
        ))}
      </Fold>

      <View style={[s.card, { gap: 10 }]}>
        <Label>{say(lang, 'reportTitle')}</Label>
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
          accessibilityRole="radiogroup"
        >
          {KINDS.map((k) => (
            <Pressable
              key={k}
              accessibilityRole="radio"
              accessibilityState={{ checked: kind === k }}
              onPress={() => {
                setKind(k);
                setSent(false);
                setError('');
              }}
              style={{
                minHeight: touch.min,
                paddingHorizontal: 14,
                borderRadius: 999,
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: kind === k ? color.volt : color.line,
                backgroundColor: kind === k ? color.volt : 'transparent',
              }}
            >
              <Words
                weight="semibold"
                style={{ color: kind === k ? color.onVolt : color.text, fontSize: 14 }}
              >
                {say(lang, `problem.${k}` as Key)}
              </Words>
            </Pressable>
          ))}
        </View>
        {(kind === 'theft' || kind === 'accident') && <Alert>{say(lang, 'urgentNote')}</Alert>}
        {kind && (
          <>
            <Field
              label={say(lang, 'whatHappened')}
              value={note}
              onChangeText={setNote}
              multiline
              maxLength={1000}
              style={[s.input, { minHeight: 88, fontFamily: undefined, textAlignVertical: 'top' }]}
            />
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <LinkButton label={say(lang, 'takePhoto')} onPress={() => void pick(true)} />
              <LinkButton label={say(lang, 'choosePhoto')} onPress={() => void pick(false)} />
            </View>
            {photo && <Muted small>{say(lang, 'photoReady')}</Muted>}
            <MainButton
              label={say(lang, 'sendReport')}
              busy={busy}
              disabled={kind === 'other' && note.trim().length < 3}
              onPress={() => void send()}
            />
          </>
        )}
        {error !== '' && <Alert>{error}</Alert>}
        {sent && <Muted>{say(lang, 'reportSent')}</Muted>}
      </View>

      <View style={s.card}>
        <Label>{say(lang, 'yourReports')}</Label>
        {problems?.length === 0 && <Muted small>{say(lang, 'noReports')}</Muted>}
        {problems?.map((p) => (
          <View
            key={p.problemId}
            style={[s.row, { justifyContent: 'space-between', minHeight: 30 }]}
          >
            <Words style={{ color: color.text, fontSize: 15, flexShrink: 1 }}>
              {`${dmy(p.at)} · ${say(lang, `problem.${p.kind}` as Key)}`}
            </Words>
            <Words
              weight="semibold"
              style={{ color: p.state === 'done' ? color.done : color.muted, fontSize: 13 }}
            >
              {say(lang, `report.${p.state}` as Key)}
            </Words>
          </View>
        ))}
      </View>

      <MainButton label={say(lang, 'myLoan')} onPress={() => setShowLoan(true)} />
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
