// P4.3 fitting (once approved): book a slot at a fitting centre; at the slot the technician, on this
// phone, scans the screen's QR (or types the id printed under it); then the fitting check runs: the
// screen shows its test pattern and checks GPS, the 4G line, the camera and the battery, and the
// technician says whether every light came on. The server checks every rule again.
import type { RiderLanguage } from '@recall/domain';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ApiError, call } from '../api';
import { say, sayError, type Key } from '../i18n';
import { color, touch } from '../theme';
import { Alert, Field, Label, LinkButton, MainButton, Muted, Screen, Title, Words, s } from '../ui';

type Part = 'ok' | 'fail' | 'unknown' | 'waiting';

interface Slot {
  readonly slotId: string;
  readonly centre: string;
  readonly address: string;
  readonly startsAt: number;
  readonly minutes: number;
  readonly left: number;
}

export interface FittingPage {
  readonly status: string;
  readonly bikePlate: string | null;
  readonly booking: (Slot & { readonly canFitNow: boolean }) | null;
  readonly slots: readonly Slot[];
  readonly screenId: string | null;
  readonly check: {
    readonly commandId: string;
    readonly gps: Part;
    readonly line: Part;
    readonly camera: Part;
    readonly battery: Part;
    readonly panel: Part;
    readonly ready: boolean;
  } | null;
}

/** India time (UTC + 5:30), the same for every rider: "23/08 · 10:30". */
export function indiaTime(t: number): string {
  const d = new Date((t + 19_800) * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)} · ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

const PART_COLOR: Record<Part, string> = {
  ok: color.done,
  fail: color.error,
  unknown: color.error,
  waiting: '#9AA3FF',
};

const failed = (lang: RiderLanguage, e: unknown) => {
  if (!(e instanceof ApiError)) return say(lang, 'err.other');
  // Why this screen cannot go on (on another bike, in repair, …): the technician reads the reason.
  if (e.why === 'cannot-fit') return `${say(lang, 'err.cannot-fit')} (${e.message})`;
  return e.why ? sayError(lang, e.why, e.n) : say(lang, 'err.other');
};

function SlotCard({
  lang,
  slot,
  action,
}: {
  readonly lang: RiderLanguage;
  readonly slot: Slot;
  readonly action?: {
    readonly label: string;
    readonly onPress: () => void;
    readonly busy: boolean;
  };
}) {
  return (
    <View style={s.card}>
      <Words weight="semibold" style={{ color: color.text, fontSize: 18 }}>
        {indiaTime(slot.startsAt)}
      </Words>
      <Words style={{ color: color.text, fontSize: 16 }}>{slot.centre}</Words>
      {slot.address !== '' && <Muted small>{slot.address}</Muted>}
      <Muted small>{say(lang, 'slotLength', { m: slot.minutes })}</Muted>
      {action && <MainButton label={action.label} onPress={action.onPress} busy={action.busy} />}
    </View>
  );
}

/** The camera, reading the first RECALL QR it sees. */
function Scanner({
  lang,
  onCode,
  onClose,
}: {
  readonly lang: RiderLanguage;
  readonly onCode: (code: string) => void;
  readonly onClose: () => void;
}) {
  const [permission, ask] = useCameraPermissions();
  const seen = useRef(false);
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void ask();
  }, [permission, ask]);
  if (!permission) return null;
  if (!permission.granted)
    return (
      <View style={{ gap: 8 }}>
        <Alert>{say(lang, 'cameraNeeded')}</Alert>
        <LinkButton label={say(lang, 'back')} onPress={onClose} />
      </View>
    );
  return (
    <View style={{ gap: 8 }}>
      <View style={{ height: 300, borderRadius: 14, overflow: 'hidden' }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (seen.current || !data.startsWith('RECALL1:')) return;
            seen.current = true;
            onCode(data);
          }}
        />
      </View>
      <Muted small>{say(lang, 'scanHint')}</Muted>
      <LinkButton label={say(lang, 'back')} onPress={onClose} />
    </View>
  );
}

export function Fitting({
  lang,
  token,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly onSignOut: () => void;
}) {
  const [page, setPage] = useState<FittingPage>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [changing, setChanging] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [typed, setTyped] = useState('');
  const signOut = useRef(onSignOut);
  signOut.current = onSignOut;

  const load = useCallback(async () => {
    try {
      setPage(await call<FittingPage>('/rider/fitting', { token }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) signOut.current();
      else setError(failed(lang, e));
    }
  }, [token, lang]);
  useEffect(() => {
    void load();
  }, [load]);

  // While the screen checks itself, look again every 5 seconds.
  const waiting =
    page?.check &&
    [page.check.gps, page.check.line, page.check.camera, page.check.battery].includes('waiting');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [waiting, load]);

  const act = async (what: string, path: string, body: object) => {
    setBusy(what);
    setError('');
    try {
      await call(path, { token, body });
      setChanging(false);
      setScanning(false);
      setTyped('');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) signOut.current();
      else setError(failed(lang, e));
      await load();
    } finally {
      setBusy('');
    }
  };

  if (!page)
    return (
      <Screen>
        <Title>{say(lang, 'fitTitle')}</Title>
        {error ? <Alert>{error}</Alert> : <Muted>{say(lang, 'loading')}</Muted>}
        {error !== '' && <LinkButton label={say(lang, 'retry')} onPress={() => void load()} />}
      </Screen>
    );

  const check = page.check;
  const parts: [Key, Part][] = check
    ? [
        ['part.gps', check.gps],
        ['part.line', check.line],
        ['part.camera', check.camera],
        ['part.battery', check.battery],
        ['part.panel', check.panel],
      ]
    : [];
  const allIn = check !== null && !parts.some(([, p]) => p === 'waiting');

  return (
    <Screen>
      <Title>{say(lang, 'fitTitle')}</Title>
      {error !== '' && <Alert>{error}</Alert>}

      {!page.screenId && page.booking && !changing && (
        <>
          <Label>{say(lang, 'yourSlot')}</Label>
          <SlotCard lang={lang} slot={page.booking} />
          {page.booking.canFitNow ? (
            <View style={[s.card, { borderColor: color.volt }]}>
              <Words weight="semibold" style={{ color: color.text, fontSize: 18 }}>
                {say(lang, 'atCentre')}
              </Words>
              <Muted>{say(lang, 'handPhone')}</Muted>
              {scanning ? (
                <Scanner
                  lang={lang}
                  onClose={() => setScanning(false)}
                  onCode={(code) => void act('fit', '/rider/fitting/fit', { code })}
                />
              ) : (
                <MainButton label={say(lang, 'scanQr')} onPress={() => setScanning(true)} />
              )}
              <Field
                label={say(lang, 'typeScreen')}
                value={typed}
                onChangeText={setTyped}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="SCR-1234567M"
              />
              <MainButton
                label={say(lang, 'fitThis')}
                busy={busy === 'fit'}
                disabled={typed.trim().length < 5}
                onPress={() => void act('fit', '/rider/fitting/fit', { code: typed })}
              />
            </View>
          ) : (
            <Muted>{say(lang, 'comeAtSlot')}</Muted>
          )}
          <LinkButton label={say(lang, 'changeSlot')} onPress={() => setChanging(true)} />
          <LinkButton
            label={say(lang, 'cancelSlot')}
            disabled={busy !== ''}
            onPress={() => void act('cancel', '/rider/fitting/cancel', {})}
          />
        </>
      )}

      {!page.screenId && (!page.booking || changing) && (
        <>
          <Muted>{say(lang, 'pickSlot')}</Muted>
          {page.slots.length === 0 && (
            <View style={s.card}>
              <Muted>{say(lang, 'noSlots')}</Muted>
            </View>
          )}
          {page.slots
            .filter((x) => x.slotId !== page.booking?.slotId)
            .map((x) => (
              <SlotCard
                key={x.slotId}
                lang={lang}
                slot={x}
                action={{
                  label: say(lang, 'bookSlot'),
                  busy: busy === x.slotId,
                  onPress: () => void act(x.slotId, '/rider/fitting/book', { slotId: x.slotId }),
                }}
              />
            ))}
          {changing && <LinkButton label={say(lang, 'back')} onPress={() => setChanging(false)} />}
        </>
      )}

      {page.screenId && (
        <>
          <View style={s.card}>
            <Words weight="semibold" style={{ color: color.text, fontSize: 18 }}>
              {say(lang, 'screenOn', { plate: page.bikePlate ?? '' })}
            </Words>
            <Words style={[s.mono, { fontSize: 15 }]}>{page.screenId}</Words>
          </View>
          {check && (
            <View style={s.card} accessibilityLabel={say(lang, 'fitCheck')}>
              <Label>{say(lang, 'fitCheck')}</Label>
              {parts.map(([k, p]) => (
                <View key={k} style={[s.row, { justifyContent: 'space-between', minHeight: 32 }]}>
                  <Words style={{ color: color.text, fontSize: 16, flexShrink: 1 }}>
                    {say(lang, k)}
                  </Words>
                  <Words weight="semibold" style={{ color: PART_COLOR[p], fontSize: 14 }}>
                    {say(lang, `part.${p}` as Key)}
                  </Words>
                </View>
              ))}
            </View>
          )}
          {check && check.panel === 'waiting' && (
            <View style={[s.card, { borderColor: color.volt }]}>
              <Words weight="semibold" style={{ color: color.text, fontSize: 18 }}>
                {say(lang, 'panelAsk')}
              </Words>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(
                  [
                    [true, 'yes'],
                    [false, 'no'],
                  ] as const
                ).map(([seen, k]) => (
                  <Pressable
                    key={k}
                    accessibilityRole="button"
                    disabled={busy !== ''}
                    onPress={() =>
                      void act('panel', '/rider/fitting/panel', {
                        commandId: check.commandId,
                        seen,
                      })
                    }
                    style={{
                      flex: 1,
                      minHeight: touch.main,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: color.line,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Words weight="semibold" style={{ color: color.text, fontSize: 16 }}>
                      {say(lang, k)}
                    </Words>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          {check?.ready && (
            <View style={[s.card, { borderColor: color.done }]}>
              <Words weight="semibold" style={{ color: color.done, fontSize: 18 }}>
                {say(lang, 'fitReady')}
              </Words>
            </View>
          )}
          {!check && <Muted>{say(lang, 'checkIntro')}</Muted>}
          {(!check || (allIn && !check.ready)) && (
            <>
              {check && <Alert>{say(lang, 'notReady')}</Alert>}
              <MainButton
                label={say(lang, check ? 'checkAgainBtn' : 'startCheck')}
                busy={busy === 'check'}
                onPress={() => void act('check', '/rider/fitting/check', {})}
              />
            </>
          )}
        </>
      )}
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
