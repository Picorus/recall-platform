// P4.4 Today (home), for a rider on the road: his screen now (on and playing, bike stopped, or
// off; battery, signal), his counted moving hours and earnings today and this week (by his pay
// rules, before tax; the sales share comes later), and the 10-minute stop rule. Looks again every
// minute while open.
import {
  alertWords,
  formatRupees,
  paise,
  type RiderAlertKind,
  type RiderLanguage,
} from '@recall/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ApiError, call, type Me } from '../api';
import { say, sayError, type Key } from '../i18n';
import { color, radius } from '../theme';
import { Alert, Fold, Label, LinkButton, Muted, Screen, Title, Words, s } from '../ui';

interface Day {
  readonly day: string;
  readonly countedSeconds: number;
  readonly earnedPaise: number;
}

/** India time of day, "14:05". */
const indiaClock = (t: number) => {
  const d = new Date((t + 19_800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

export interface TodayPage {
  readonly at: number;
  readonly screen: {
    readonly screenId: string;
    readonly state: 'moving' | 'stopped' | 'offline' | 'at-hub';
    readonly batteryPct: number | null;
    readonly charging: boolean | null;
    readonly signalBars: number | null;
  } | null;
  readonly mode: 'poc' | 'regular';
  readonly today: Day;
  readonly week: {
    readonly days: readonly Day[];
    readonly countedSeconds: number;
    readonly earnedPaise: number;
  };
  readonly perMovingHourPaise: number;
  readonly monthlyCapHours: number;
}

/** "2 h 15 min" (numbers the same in every language; the units are his). */
export function hoursText(lang: RiderLanguage, seconds: number): string {
  const m = Math.floor(seconds / 60);
  return say(lang, 'hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}

const rupees = (p: number) => formatRupees(paise(p)).replace(/\.00$/, '');

// The screen's state as a light: volt while it plays (the one volt thing on the page), a quiet
// grey while the bike stands, red when it is off.
const STATE: Record<string, { key: Key; dot: string; wash: string }> = {
  moving: { key: 'screen.moving', dot: color.volt, wash: color.voltSoft },
  stopped: { key: 'screen.stopped', dot: color.muted, wash: color.field },
  offline: { key: 'screen.offline', dot: color.error, wash: color.errorSoft },
  'at-hub': { key: 'screen.offline', dot: color.error, wash: color.errorSoft },
};

function Bars({ n }: { readonly n: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2 }} accessible={false}>
      {[1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={{
            width: 5,
            height: 4 + i * 3,
            borderRadius: 1,
            backgroundColor: i <= n ? color.text : color.line,
          }}
        />
      ))}
    </View>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Muted small>{label}</Muted>
      <Words
        weight="semibold"
        style={{ color: color.text, fontSize: 26, lineHeight: 32, letterSpacing: -0.5 }}
      >
        {value}
      </Words>
    </View>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

export function Today({
  lang,
  token,
  me,
  onProfile,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly me: Me;
  /** P4.11: opens his profile and settings. */
  readonly onProfile?: () => void;
  readonly onSignOut: () => void;
}) {
  const [page, setPage] = useState<TodayPage>();
  // P4.10: his latest alerts (the same words his phone's notifications use).
  const [alerts, setAlerts] = useState<
    readonly { kind: RiderAlertKind; vals: Record<string, string | number>; at: number }[]
  >([]);
  const [error, setError] = useState('');
  const signOut = useRef(onSignOut);
  signOut.current = onSignOut;

  // Only the newest look counts (a slow answer never overwrites a newer one), and none after the
  // page has closed.
  const asked = useRef(0);
  useEffect(
    () => () => {
      asked.current = -1;
    },
    [],
  );
  const load = useCallback(async () => {
    const mine = ++asked.current;
    try {
      const [p, a] = await Promise.all([
        call<TodayPage>('/rider/today', { token }),
        call<{
          alerts: { kind: RiderAlertKind; vals: Record<string, string | number>; at: number }[];
        }>('/rider/alerts', { token }),
      ]);
      if (mine !== asked.current) return;
      setPage(p);
      setAlerts(a.alerts.slice(0, 3));
      setError('');
    } catch (e) {
      if (mine !== asked.current) return;
      if (e instanceof ApiError && e.status === 401) signOut.current();
      else
        setError(
          e instanceof ApiError && e.why ? sayError(lang, e.why, e.n) : say(lang, 'err.other'),
        );
    }
  }, [token, lang]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const scr = page?.screen;
  const st = scr ? STATE[scr.state] : undefined;
  return (
    <Screen>
      <View style={[s.row, { justifyContent: 'space-between', gap: 12 }]}>
        <View style={{ gap: 2, flexShrink: 1 }}>
          <Muted small>{say(lang, 'hello')}</Muted>
          <Title>{me.name ?? say(lang, 'welcome')}</Title>
        </View>
        {onProfile && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={say(lang, 'profileLink')}
            onPress={onProfile}
            style={({ pressed }) => [t.avatar, pressed && { transform: [{ scale: 0.94 }] }]}
          >
            <Words weight="semibold" style={{ color: color.text, fontSize: 17 }}>
              {initials(me.name ?? '') || '·'}
            </Words>
          </Pressable>
        )}
      </View>
      {page && (
        <View style={t.pill} accessibilityLabel={say(lang, 'earned')}>
          <Words style={{ color: color.muted, fontSize: 14 }}>{say(lang, 'todayTitle')}</Words>
          <Words weight="semibold" style={{ color: color.text, fontSize: 22, letterSpacing: -0.4 }}>
            {rupees(page.today.earnedPaise)}
          </Words>
        </View>
      )}
      {me.status === 'paused' && <Alert>{say(lang, 'status_paused')}</Alert>}
      {error !== '' && <Alert>{error}</Alert>}
      {error !== '' && page && <Muted small>{say(lang, 'asOf', { t: indiaClock(page.at) })}</Muted>}
      {!page && error === '' && <Muted>{say(lang, 'loading')}</Muted>}

      {page && (
        <>
          <View style={s.card} accessibilityLabel={say(lang, 'yourScreen')}>
            <Label>{say(lang, 'yourScreen')}</Label>
            {scr && st ? (
              <>
                <View style={[s.row, { gap: 14 }]}>
                  <View style={[t.orb, { backgroundColor: st.wash }]} accessible={false}>
                    <View
                      style={[
                        t.light,
                        { backgroundColor: st.dot, shadowColor: st.dot },
                        scr.state === 'moving' && t.glow,
                      ]}
                    />
                  </View>
                  <Words
                    weight="semibold"
                    style={{ color: color.text, fontSize: 20, lineHeight: 26, flexShrink: 1 }}
                  >
                    {say(lang, st.key)}
                  </Words>
                </View>
                <View style={[s.row, { gap: 16, flexWrap: 'wrap' }]}>
                  {scr.batteryPct !== null && (
                    <Muted small>
                      {say(lang, scr.charging ? 'batteryCharging' : 'battery', {
                        n: scr.batteryPct,
                      })}
                    </Muted>
                  )}
                  {scr.signalBars !== null && (
                    <View
                      style={s.row}
                      accessibilityLabel={say(lang, 'signalOf', { n: scr.signalBars })}
                    >
                      <Muted small>{say(lang, 'signal')}</Muted>
                      <Bars n={scr.signalBars} />
                    </View>
                  )}
                </View>
              </>
            ) : (
              <Muted>{say(lang, 'noScreen')}</Muted>
            )}
          </View>

          <View style={s.card}>
            <Label>{say(lang, 'todayTitle')}</Label>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Stat
                label={say(lang, 'movingHours')}
                value={hoursText(lang, page.today.countedSeconds)}
              />
              <Stat label={say(lang, 'earned')} value={rupees(page.today.earnedPaise)} />
            </View>
          </View>

          <View style={s.card}>
            <Label>{say(lang, 'weekTitle')}</Label>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Stat
                label={say(lang, 'movingHours')}
                value={hoursText(lang, page.week.countedSeconds)}
              />
              <Stat label={say(lang, 'earned')} value={rupees(page.week.earnedPaise)} />
            </View>
            {page.week.days.map((d) => (
              <View key={d.day} style={[s.row, { justifyContent: 'space-between', minHeight: 28 }]}>
                <Words style={[s.figures, { fontSize: 14, color: color.muted }]}>
                  {`${d.day.slice(8, 10)}/${d.day.slice(5, 7)}`}
                </Words>
                <Words style={{ color: color.text, fontSize: 14 }}>
                  {hoursText(lang, d.countedSeconds)}
                </Words>
                <Words style={[s.figures, { fontSize: 14, color: color.text }]}>
                  {rupees(d.earnedPaise)}
                </Words>
              </View>
            ))}
            <Fold quiet title={say(lang, 'howPayWorks')}>
              <Muted small>
                {page.mode === 'poc'
                  ? say(lang, 'payPoc')
                  : say(lang, 'payRegular', {
                      rate: rupees(page.perMovingHourPaise),
                      cap: page.monthlyCapHours,
                    })}
              </Muted>
            </Fold>
          </View>

          {alerts.length > 0 && (
            <View style={s.card} accessibilityLabel={say(lang, 'alertsTitle')}>
              <Label>{say(lang, 'alertsTitle')}</Label>
              {alerts.map((a) => {
                const w = alertWords(lang, a.kind, a.vals);
                return (
                  <View key={`${a.kind}-${a.at}`} style={{ gap: 2, paddingVertical: 4 }}>
                    <Words weight="semibold" style={{ color: color.text, fontSize: 15 }}>
                      {`${indiaClock(a.at)} · ${w.title}`}
                    </Words>
                    <Muted small>{w.body}</Muted>
                  </View>
                );
              })}
            </View>
          )}

          <Fold icon="clock" title={say(lang, 'stopRuleTitle')}>
            <Muted>{say(lang, 'stopRule')}</Muted>
          </Fold>
        </>
      )}
      <LinkButton label={say(lang, 'refresh')} onPress={() => void load()} />
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}

const t = {
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.field,
    borderWidth: 1,
    borderColor: color.line,
  },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: color.raised,
    borderWidth: 1,
    borderColor: color.divider,
  },
  orb: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  light: { width: 12, height: 12, borderRadius: 6 },
  glow: { shadowOpacity: 0.9, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
} as const;
