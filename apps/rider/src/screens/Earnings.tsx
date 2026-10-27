// P4.5 Earnings: a month at a time (this month first; up to 12 back): what he earned and from what
// (₹25 a moving hour, the POC base, his share of sales as of the last pay update, bonuses), each
// week and day, the POC's progress to the founding bonus, and his monthly statement to save.
import { formatRupees, paise, type RiderLanguage } from '@recall/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { API_URL, ApiError, call } from '../api';
import { say, sayError } from '../i18n';
import { color, touch } from '../theme';
import { Alert, Label, LinkButton, MainButton, Muted, Screen, Title, Words, s } from '../ui';
import { hoursText } from './Today';

interface Period {
  readonly countedSeconds: number;
  readonly earnedPaise: number;
}

export interface EarningsPage {
  readonly month: string;
  readonly months: readonly string[];
  readonly closed: boolean;
  readonly days: readonly (Period & { readonly day: string })[];
  readonly weeks: readonly (Period & { readonly from: string; readonly to: string })[];
  readonly countedSeconds: number;
  readonly paidSeconds: number;
  readonly hourlyPaise: number;
  readonly adjustmentPaise: number;
  readonly pocPaise: number;
  readonly soldPaise: number;
  readonly soldAsOf: number | null;
  readonly bonusPaise: number;
  readonly totalPaise: number;
  readonly poc: {
    readonly countedSeconds: number;
    readonly fromHours: number;
    readonly fullHours: number;
    readonly bonusPaise: number;
    readonly given: boolean;
  } | null;
  readonly perMovingHourPaise: number;
  readonly monthlyCapHours: number;
}

const rupees = (p: number) => formatRupees(paise(p)).replace(/\.00$/, '');
const dm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const dateOf = (t: number) => {
  const d = new Date((t + 19_800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

function Line({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={[s.row, { justifyContent: 'space-between', minHeight: 30 }]}>
      <Words style={{ color: color.text, fontSize: 15, flexShrink: 1 }}>{label}</Words>
      <Words style={[s.mono, { fontSize: 15 }]}>{value}</Words>
    </View>
  );
}

export function Earnings({
  lang,
  token,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly onSignOut: () => void;
}) {
  const [month, setMonth] = useState<string>();
  const [page, setPage] = useState<EarningsPage>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signOut = useRef(onSignOut);
  signOut.current = onSignOut;
  const asked = useRef(0);

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
    const mine = ++asked.current;
    try {
      const p = await call<EarningsPage>(`/rider/earnings${month ? `?month=${month}` : ''}`, {
        token,
      });
      if (mine !== asked.current) return;
      setPage(p);
      setError('');
    } catch (e) {
      if (mine === asked.current) failed(e);
    }
  }, [token, month, failed]);
  useEffect(() => {
    void load();
  }, [load]);

  const statement = async () => {
    if (!page) return;
    setBusy(true);
    try {
      const r = await call<{ path: string }>('/rider/statement', {
        token,
        body: { month: page.month },
      });
      await Linking.openURL(`${API_URL}${r.path}`);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const p = page;
  const progress = p?.poc ? Math.min(1, p.poc.countedSeconds / (p.poc.fullHours * 3600)) : 0;
  return (
    <Screen>
      <Title>{say(lang, 'earningsTitle')}</Title>
      {error !== '' && <Alert>{error}</Alert>}
      {!p && error === '' && <Muted>{say(lang, 'loading')}</Muted>}
      {p && (
        <>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
            accessibilityRole="radiogroup"
          >
            {p.months.map((m) => (
              <Pressable
                key={m}
                accessibilityRole="radio"
                accessibilityState={{ checked: m === p.month }}
                onPress={() => {
                  if (m === p.month) return;
                  setPage(undefined);
                  setMonth(m);
                }}
                style={{
                  minHeight: touch.min,
                  paddingHorizontal: 14,
                  borderRadius: 999,
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: m === p.month ? color.volt : color.line,
                  backgroundColor: m === p.month ? color.volt : 'transparent',
                }}
              >
                <Words
                  weight="semibold"
                  style={{ color: m === p.month ? color.onVolt : color.text, fontSize: 14 }}
                >
                  {`${m.slice(5, 7)}/${m.slice(0, 4)}`}
                </Words>
              </Pressable>
            ))}
          </View>

          <View style={s.card}>
            <Label>{say(lang, p.closed ? 'monthClosed' : 'monthSoFar')}</Label>
            <Words weight="extrabold" style={{ color: color.text, fontSize: 34, lineHeight: 42 }}>
              {rupees(p.totalPaise)}
            </Words>
            <Muted small>{say(lang, 'beforeTax')}</Muted>
            <Line
              label={say(lang, 'hoursTimesRate', {
                h: hoursText(lang, p.paidSeconds),
                rate: rupees(p.perMovingHourPaise),
              })}
              value={rupees(p.hourlyPaise)}
            />
            {p.pocPaise > 0 && <Line label={say(lang, 'pocBase')} value={rupees(p.pocPaise)} />}
            <Line
              label={
                p.soldAsOf === null
                  ? say(lang, 'salesShareNone')
                  : say(lang, 'salesShare', { d: dateOf(p.soldAsOf) })
              }
              value={rupees(p.soldPaise)}
            />
            {p.adjustmentPaise !== 0 && (
              <Line label={say(lang, 'adjusted')} value={rupees(p.adjustmentPaise)} />
            )}
            {p.bonusPaise > 0 && (
              <Line label={say(lang, 'bonusGiven')} value={rupees(p.bonusPaise)} />
            )}
            <Muted small>{say(lang, 'capNote', { cap: p.monthlyCapHours })}</Muted>
          </View>

          {p.poc && (
            <View style={s.card}>
              <Label>{say(lang, 'pocBonusTitle')}</Label>
              <Words weight="semibold" style={{ color: color.text, fontSize: 18 }}>
                {say(lang, 'pocHoursOf', {
                  h: Math.floor(p.poc.countedSeconds / 3600),
                  full: p.poc.fullHours,
                })}
              </Words>
              <View
                style={{
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: color.line,
                  overflow: 'hidden',
                }}
                accessibilityRole="progressbar"
                accessibilityValue={{
                  min: 0,
                  max: p.poc.fullHours,
                  now: Math.floor(p.poc.countedSeconds / 3600),
                }}
              >
                <View
                  style={{ width: `${progress * 100}%`, height: 10, backgroundColor: color.volt }}
                />
              </View>
              <Muted small>
                {say(lang, p.poc.given ? 'pocBonusGiven' : 'pocBonusSoFar', {
                  amount: rupees(p.poc.bonusPaise),
                  from: p.poc.fromHours,
                  full: p.poc.fullHours,
                })}
              </Muted>
            </View>
          )}

          <View style={s.card}>
            <Label>{say(lang, 'byWeek')}</Label>
            {[...p.weeks].reverse().map((w) => (
              <Line
                key={w.from}
                label={`${dm(w.from)}–${dm(w.to)} · ${hoursText(lang, w.countedSeconds)}`}
                value={rupees(w.earnedPaise)}
              />
            ))}
          </View>

          <View style={s.card}>
            <Label>{say(lang, 'byDay')}</Label>
            {[...p.days]
              .reverse()
              .filter((d) => d.countedSeconds > 0 || d.earnedPaise > 0)
              .map((d) => (
                <Line
                  key={d.day}
                  label={`${dm(d.day)} · ${hoursText(lang, d.countedSeconds)}`}
                  value={rupees(d.earnedPaise)}
                />
              ))}
            {p.days.every((d) => d.countedSeconds === 0 && d.earnedPaise === 0) && (
              <Muted small>{say(lang, 'noRidesYet')}</Muted>
            )}
          </View>

          <MainButton label={say(lang, 'statement')} busy={busy} onPress={() => void statement()} />
        </>
      )}
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
