// P4.2 joining (approved screen R02): the six steps with where each stands, and each step's own
// screen: profile and photo, vehicle papers, ID check, bank or UPI, the agreement, the screen loan.
// Changes are open while his application is; the server checks every rule again.
import { plateOf, RIDER_APPS, type RiderLanguage } from '@recall/domain';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Linking, Platform, Pressable, View } from 'react-native';
import { ApiError, call, upload, type JoinPage, type JoinStep, type StepState } from '../api';
import { say, sayError, type Key } from '../i18n';
import { color, touch } from '../theme';
import { Alert, Field, Label, LinkButton, MainButton, Muted, Screen, Title, Words, s } from '../ui';

const APP_NAMES: Readonly<Record<string, string>> = {
  swiggy: 'Swiggy',
  zomato: 'Zomato',
  zepto: 'Zepto',
  blinkit: 'Blinkit',
  instamart: 'Instamart',
  rapido: 'Rapido',
  uber: 'Uber',
  ola: 'Ola',
  porter: 'Porter',
};

const BADGE: Record<StepState | 'later', { bg: string; fg: string }> = {
  todo: { bg: color.raised, fg: color.muted },
  later: { bg: color.raised, fg: color.muted },
  waiting: { bg: 'rgba(110,123,255,0.16)', fg: '#9AA3FF' },
  done: { bg: 'rgba(61,220,151,0.14)', fg: color.done },
  again: { bg: 'rgba(255,107,74,0.14)', fg: color.error },
};

function Badge({
  lang,
  state,
}: {
  readonly lang: RiderLanguage;
  readonly state: StepState | 'later';
}) {
  return (
    <View
      style={{
        backgroundColor: BADGE[state].bg,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 4,
      }}
    >
      <Words weight="semibold" style={{ color: BADGE[state].fg, fontSize: 12 }}>
        {say(lang, `state.${state}` as Key)}
      </Words>
    </View>
  );
}

const failed = (lang: RiderLanguage, e: unknown) =>
  e instanceof ApiError
    ? e.why
      ? sayError(lang, e.why, e.n)
      : e.status === 400
        ? e.message
        : say(lang, 'err.other')
    : say(lang, 'err.other');

/** A toggle chip (an app he rides for, UPI or bank). */
function Chip({
  label,
  on,
  onPress,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: touch.min,
        paddingHorizontal: 14,
        borderRadius: 999,
        justifyContent: 'center',
        borderWidth: on ? 2 : 1,
        borderColor: on ? color.text : color.line,
        backgroundColor: on ? color.raised : 'transparent',
      }}
    >
      <Words weight="semibold" style={{ color: color.text, fontSize: 15 }}>
        {label}
      </Words>
    </Pressable>
  );
}

/** Name, where he rides, his apps, and (on the vehicle step) his plate: the sign-up form too. */
export function DetailsForm({
  lang,
  initial,
  withPlate,
  button,
  onSave,
}: {
  readonly lang: RiderLanguage;
  readonly initial: {
    name: string;
    rides: string;
    apps: readonly string[];
    bikePlate: string | null;
  };
  readonly withPlate: boolean;
  readonly button: string;
  readonly onSave: (d: {
    name: string;
    rides: string;
    apps: string[];
    bikePlate: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [rides, setRides] = useState(initial.rides);
  const [apps, setApps] = useState<string[]>([...initial.apps]);
  const [plate, setPlate] = useState(initial.bikePlate ?? '');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = () => {
    const n = name.trim();
    if (n.length < 2 || n.length > 80) return setError(say(lang, 'err.name'));
    const p = plate.trim() ? plateOf(plate) : null;
    if (plate.trim() && !p) return setError(say(lang, 'err.plate'));
    setError('');
    setNote('');
    // Shown in its one form once saved ("TS09AB4321").
    if (p) setPlate(p);
    setBusy(true);
    onSave({ name: n, rides: rides.trim(), apps, bikePlate: withPlate ? p : initial.bikePlate })
      .then(() => setNote(say(lang, 'saved')))
      .catch((e: unknown) => setError(failed(lang, e)))
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ gap: 16 }}>
      {withPlate ? (
        <Field
          label={say(lang, 'plate')}
          value={plate}
          onChangeText={setPlate}
          autoCapitalize="characters"
          maxLength={16}
          placeholder="TS09EA1234"
        />
      ) : (
        <>
          <Field
            label={say(lang, 'name')}
            value={name}
            onChangeText={setName}
            maxLength={80}
            autoComplete="name"
          />
          <Field label={say(lang, 'rides')} value={rides} onChangeText={setRides} maxLength={120} />
          <View style={{ gap: 8 }} accessibilityLabel={say(lang, 'apps')}>
            <Label>{say(lang, 'apps')}</Label>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {RIDER_APPS.map((a) => (
                <Chip
                  key={a}
                  label={APP_NAMES[a] ?? say(lang, 'appOther')}
                  on={apps.includes(a)}
                  onPress={() =>
                    setApps(apps.includes(a) ? apps.filter((x) => x !== a) : [...apps, a])
                  }
                />
              ))}
            </View>
          </View>
        </>
      )}
      {error !== '' && <Alert>{error}</Alert>}
      {note !== '' && <Muted>{note}</Muted>}
      <MainButton label={button} busy={busy} onPress={save} />
    </View>
  );
}

/** One document: where it stands, and a picture taken or chosen to send. */
function DocumentRow({
  lang,
  kind,
  state,
  token,
  canChange,
  onSent,
}: {
  readonly lang: RiderLanguage;
  readonly kind: 'photo' | 'rc' | 'insurance';
  readonly state: StepState;
  readonly token: string;
  readonly canChange: boolean;
  readonly onSent: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = async (camera: boolean) => {
    setError('');
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.6 };
    if (camera) {
      const p = await ImagePicker.requestCameraPermissionsAsync();
      if (!p.granted) return;
    }
    const r = camera
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    const uri = r.canceled ? undefined : r.assets[0]?.uri;
    if (!uri) return;
    setBusy(true);
    await upload(`/rider/documents?kind=${kind}`, uri, token)
      .then(onSent)
      .catch((e: unknown) => setError(failed(lang, e)))
      .finally(() => setBusy(false));
  };
  return (
    <View style={[s.card, { gap: 10 }]} accessibilityLabel={say(lang, `doc.${kind}` as Key)}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Words weight="semibold" style={{ color: color.text, fontSize: 16, flexShrink: 1 }}>
          {say(lang, `doc.${kind}` as Key)}
        </Words>
        <Badge lang={lang} state={state} />
      </View>
      <Muted small>{say(lang, `doc.${state}` as Key)}</Muted>
      {error !== '' && <Alert>{error}</Alert>}
      {/* A picture waiting for a look can be replaced (staff look at the newest). */}
      {canChange && state !== 'done' && (
        <View style={{ gap: 8 }}>
          {/* The web build (tests) has no camera; a phone has both. */}
          {Platform.OS !== 'web' && (
            <MainButton
              label={say(lang, 'takePhoto')}
              busy={busy}
              onPress={() => void pick(true)}
            />
          )}
          <LinkButton
            label={say(lang, 'choosePhoto')}
            disabled={busy}
            onPress={() => void pick(false)}
          />
        </View>
      )}
    </View>
  );
}

/** A step handled by an outside page (ID check, agreement): open it, then say you finished. */
function OutsideStep({
  lang,
  state,
  reason,
  intro,
  start,
  finished,
  doneText,
  path,
  token,
  canChange,
  onChanged,
}: {
  readonly lang: RiderLanguage;
  readonly state: StepState;
  readonly reason: string | null;
  readonly intro: string;
  readonly start: string;
  readonly finished: string;
  readonly doneText: string;
  readonly path: '/rider/identity' | '/rider/agreement';
  readonly token: string;
  readonly canChange: boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = () => {
    setBusy(true);
    setError('');
    call<{ link: string }>(path, { body: {}, token })
      .then(async (x) => {
        await onChanged();
        await Linking.openURL(x.link).catch(() => undefined);
      })
      .catch((e: unknown) => setError(failed(lang, e)))
      .finally(() => setBusy(false));
  };
  const check = () => {
    setBusy(true);
    setError('');
    call('/rider/checks', { body: {}, token })
      .then(onChanged)
      .catch((e: unknown) => setError(failed(lang, e)))
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ gap: 16 }}>
      <Muted>{intro}</Muted>
      {state === 'done' && (
        <Words weight="semibold" style={{ color: color.done, fontSize: 18 }}>
          {doneText}
        </Words>
      )}
      {state === 'waiting' && <Muted>{say(lang, 'waitingCheck')}</Muted>}
      {state === 'again' && <Alert>{say(lang, 'checkAgain', { reason: reason ?? '' })}</Alert>}
      {error !== '' && <Alert>{error}</Alert>}
      {canChange && state !== 'done' && state !== 'waiting' && (
        <MainButton label={start} busy={busy} onPress={go} />
      )}
      {state === 'waiting' && <MainButton label={finished} busy={busy} onPress={check} />}
      {/* Closed the provider's page too soon: the same check opens again (never a new one). */}
      {canChange && state === 'waiting' && (
        <LinkButton label={say(lang, 'openAgain')} disabled={busy} onPress={go} />
      )}
    </View>
  );
}

function BankStep({
  lang,
  page,
  token,
  onChanged,
}: {
  readonly lang: RiderLanguage;
  readonly page: JoinPage;
  readonly token: string;
  readonly onChanged: () => Promise<void>;
}) {
  const [kind, setKind] = useState<'upi' | 'bank'>('upi');
  const [vpa, setVpa] = useState('');
  const [accountNumber, setAccount] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [name, setName] = useState(page.details.name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = () => {
    const missing =
      !name.trim() || (kind === 'upi' ? !vpa.trim() : !accountNumber.trim() || !ifsc.trim());
    if (missing) return setError(say(lang, 'err.bank'));
    setBusy(true);
    setError('');
    call<{ outcome: 'passed' | 'failed'; reason: string | null }>('/rider/bank', {
      body: kind === 'upi' ? { kind, vpa, name } : { kind, accountNumber, ifsc, name },
      token,
    })
      .then(async (x) => {
        if (x.outcome === 'failed') setError(say(lang, 'checkAgain', { reason: x.reason ?? '' }));
        await onChanged();
      })
      .catch((e: unknown) => setError(failed(lang, e)))
      .finally(() => setBusy(false));
  };
  if (page.bank.state === 'done')
    return (
      <View style={{ gap: 16 }}>
        <Muted>{say(lang, 'bankIntro')}</Muted>
        <Words weight="semibold" style={{ color: color.done, fontSize: 18 }}>
          {say(lang, 'bankDone')}
        </Words>
      </View>
    );
  return (
    <View style={{ gap: 16 }}>
      <Muted>{say(lang, 'bankIntro')}</Muted>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label={say(lang, 'upi')} on={kind === 'upi'} onPress={() => setKind('upi')} />
        <Chip label={say(lang, 'account')} on={kind === 'bank'} onPress={() => setKind('bank')} />
      </View>
      {kind === 'upi' ? (
        <Field
          label={say(lang, 'vpa')}
          value={vpa}
          // Spaces beside the "@" go; one inside the name stays, so the server refuses it (never
          // joined into someone else's UPI id).
          onChangeText={(t) => setVpa(t.replace(/\s*@\s*/, '@'))}
          autoCapitalize="none"
          maxLength={100}
          placeholder="name@okaxis"
        />
      ) : (
        <>
          <Field
            label={say(lang, 'accountNumber')}
            value={accountNumber}
            onChangeText={(t) => setAccount(t.replace(/\s/g, ''))}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={30}
          />
          <Field
            label={say(lang, 'ifsc')}
            value={ifsc}
            onChangeText={(t) => setIfsc(t.replace(/\s/g, ''))}
            autoCapitalize="characters"
            maxLength={20}
          />
        </>
      )}
      <Field label={say(lang, 'holder')} value={name} onChangeText={setName} maxLength={120} />
      {page.bank.state === 'again' && error === '' && (
        <Alert>{say(lang, 'checkAgain', { reason: page.bank.reason ?? '' })}</Alert>
      )}
      {error !== '' && <Alert>{error}</Alert>}
      {page.canChange && <MainButton label={say(lang, 'checkBank')} busy={busy} onPress={send} />}
    </View>
  );
}

/** The steps list, and each step's screen. */
export function Join({
  lang,
  token,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  /** Also called when his session has ended elsewhere (he signs in again from the start). */
  readonly onSignOut: () => void;
}) {
  const [page, setPage] = useState<JoinPage | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<JoinStep | null>(null);
  const signOut = useRef(onSignOut);
  signOut.current = onSignOut;
  const load = useCallback(
    () =>
      call<JoinPage>('/rider/join', { token })
        .then((p) => {
          setPage(p);
          setError('');
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 401) signOut.current();
          else setError(failed(lang, e));
        }),
    [lang, token],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (open === null) return false;
      setOpen(null);
      return true;
    });
    return () => sub.remove();
  }, [open]);
  if (!page)
    return (
      <Screen>
        {error !== '' ? <Alert>{error}</Alert> : <Muted>…</Muted>}
        {error !== '' && <MainButton label={say(lang, 'retry')} onPress={() => void load()} />}
      </Screen>
    );
  const done = page.steps.filter((x) => x.state === 'done').length;
  if (open !== null) {
    const frame = (children: ReactNode) => (
      <Screen>
        <LinkButton label={`‹ ${say(lang, 'back')}`} onPress={() => setOpen(null)} />
        <Title>{say(lang, `step.${open}` as Key)}</Title>
        {!page.canChange && <Muted>{say(lang, 'decided')}</Muted>}
        {children}
      </Screen>
    );
    if (open === 'profile')
      return frame(
        <>
          <DocumentRow
            lang={lang}
            kind="photo"
            state={page.documents.photo.state}
            token={token}
            canChange={page.canChange}
            onSent={() => void load()}
          />
          {page.canChange && (
            <DetailsForm
              lang={lang}
              initial={page.details}
              withPlate={false}
              button={say(lang, 'save')}
              onSave={(d) => call('/rider/profile', { body: d, token }).then(load)}
            />
          )}
        </>,
      );
    if (open === 'vehicle')
      return frame(
        <>
          {page.canChange && (
            <DetailsForm
              lang={lang}
              initial={page.details}
              withPlate
              button={say(lang, 'save')}
              onSave={(d) => call('/rider/profile', { body: d, token }).then(load)}
            />
          )}
          <DocumentRow
            lang={lang}
            kind="rc"
            state={page.documents.rc.state}
            token={token}
            canChange={page.canChange}
            onSent={() => void load()}
          />
          <DocumentRow
            lang={lang}
            kind="insurance"
            state={page.documents.insurance.state}
            token={token}
            canChange={page.canChange}
            onSent={() => void load()}
          />
        </>,
      );
    if (open === 'identity')
      return frame(
        <OutsideStep
          lang={lang}
          state={page.identity.state}
          reason={page.identity.reason}
          intro={say(lang, 'identityIntro')}
          start={say(lang, 'startId')}
          finished={say(lang, 'finished')}
          doneText={say(lang, 'idDone')}
          path="/rider/identity"
          token={token}
          canChange={page.canChange}
          onChanged={load}
        />,
      );
    if (open === 'agreement')
      return frame(
        <>
          <View style={s.card}>
            <Words weight="semibold" style={[s.muted13, { letterSpacing: 1.4 }]}>
              {say(lang, 'cameraTitle')}
            </Words>
            <Words weight="semibold" style={{ color: color.text, fontSize: 18, lineHeight: 26 }}>
              {say(lang, 'cameraLine')}
            </Words>
            <Muted small>{say(lang, 'cameraNote')}</Muted>
          </View>
          <OutsideStep
            lang={lang}
            state={page.agreement.state}
            reason={page.agreement.reason}
            intro={say(lang, 'agreementIntro')}
            start={say(lang, 'signAgreement')}
            finished={say(lang, 'signed')}
            doneText={say(lang, 'agreementDone')}
            path="/rider/agreement"
            token={token}
            canChange={page.canChange}
            onChanged={load}
          />
        </>,
      );
    if (open === 'bank')
      return frame(<BankStep lang={lang} page={page} token={token} onChanged={load} />);
    return frame(
      <>
        <Muted>{say(lang, 'loanIntro', { bank: page.loanBank })}</Muted>
        <Muted>
          {say(
            lang,
            page.steps.find((x) => x.step === 'loan')?.state === 'later' ? 'loanLater' : 'loanSoon',
          )}
        </Muted>
      </>,
    );
  }
  return (
    <Screen>
      <View style={{ gap: 6 }}>
        <Title>{say(lang, 'joinTitle')}</Title>
        <Muted>{say(lang, 'joinProgress', { done })}</Muted>
        <View style={{ height: 8, backgroundColor: color.raised, borderRadius: 999 }}>
          <View
            style={{
              width: `${Math.round((done / 6) * 100)}%`,
              height: 8,
              backgroundColor: color.done,
              borderRadius: 999,
            }}
          />
        </View>
      </View>
      {!page.canChange && <Muted>{say(lang, 'decided')}</Muted>}
      <View>
        {page.steps.map((x, i) => (
          <Pressable
            key={x.step}
            accessibilityRole="button"
            accessibilityLabel={`${say(lang, `step.${x.step}` as Key)}: ${say(lang, `state.${x.state}` as Key)}`}
            onPress={() => setOpen(x.step)}
            style={{
              flexDirection: 'row',
              gap: 12,
              alignItems: 'center',
              paddingVertical: 14,
              borderTopWidth: 1,
              borderTopColor: color.divider,
              minHeight: touch.main,
            }}
          >
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: color.line,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Words weight="semibold" style={{ color: color.text, fontSize: 13 }}>
                {String(i + 1)}
              </Words>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Words weight="semibold" style={{ color: color.text, fontSize: 16 }}>
                {say(lang, `step.${x.step}` as Key)}
              </Words>
              <Muted small>{say(lang, `step.${x.step}.sub` as Key)}</Muted>
            </View>
            <Badge lang={lang} state={x.state} />
          </Pressable>
        ))}
      </View>
      <View style={s.card}>
        <Words weight="semibold" style={[s.muted13, { letterSpacing: 1.4 }]}>
          {say(lang, 'cameraTitle')}
        </Words>
        <Words weight="semibold" style={{ color: color.text, fontSize: 18, lineHeight: 26 }}>
          {say(lang, 'cameraLine')}
        </Words>
        <Muted small>{say(lang, 'cameraNote')}</Muted>
      </View>
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
