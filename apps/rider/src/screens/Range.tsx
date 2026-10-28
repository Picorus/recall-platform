// P4.5: on Earnings, the days he wants to look at besides today: quick picks (today, yesterday,
// this week, last week, this month) or his own dates on a small calendar. For those days: screen-on
// and moving hours side by side, what they earned before tax (moving-hour pay; the share of sales
// is monthly), and a small chart by day. Business days in India time; the server checks every pick.
import { formatRupees, paise, todayOf, type RiderLanguage } from '@recall/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ApiError, call } from '../api';
import { DayRangePicker } from '../calendar';
import { DayBars, type ChartDay } from '../chart';
import { addDays, presetOf, presetRange, PRESETS, type DayRange, type Preset } from '../dates';
import { HoursPair, hoursWords } from '../hours';
import { rangeLabel, say, sayError, type Key } from '../i18n';
import { color, touch } from '../theme';
import { Alert, Label, Muted, Words, s } from '../ui';

export interface RangePage {
  readonly at: number;
  /** His business day by the server's clock. */
  readonly today: string;
  readonly from: string;
  readonly to: string;
  readonly days: readonly ChartDay[];
  readonly countedSeconds: number;
  readonly screenOnSeconds: number;
  readonly earnedPaise: number;
}

const rupees = (p: number) => formatRupees(paise(p)).replace(/\.00$/, '');

const CHIP: Record<Preset | 'pick', Key> = {
  today: 'range.today',
  yesterday: 'range.yesterday',
  thisWeek: 'range.thisWeek',
  lastWeek: 'range.lastWeek',
  thisMonth: 'range.thisMonth',
  pick: 'range.pick',
};

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
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      aria-checked={on}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: touch.min,
        paddingHorizontal: 14,
        borderRadius: 999,
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: on ? color.volt : color.line,
        backgroundColor: on ? color.volt : 'transparent',
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}
    >
      <Words weight="semibold" style={{ color: on ? color.onVolt : color.text, fontSize: 14 }}>
        {label}
      </Words>
    </Pressable>
  );
}

export function RangeCard({
  lang,
  token,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly onSignOut: () => void;
}) {
  // His business day now (between 02:00 and 08:00, the day that just ended): the phone's clock
  // first, then the server's (a phone's clock can be off; quick picks follow the server).
  const [today, setToday] = useState(() => todayOf(Math.floor(Date.now() / 1000)));
  const [range, setRange] = useState<DayRange>(() => presetRange('thisWeek', today));
  // The quick pick in force (undefined: his own dates), so it moves with the server's day.
  const [chosenPreset, setChosenPreset] = useState<Preset | undefined>('thisWeek');
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState<RangePage>();
  const [error, setError] = useState('');
  const out = useRef(onSignOut);
  out.current = onSignOut;
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
      const p = await call<RangePage>(`/rider/earnings/range?from=${range.from}&to=${range.to}`, {
        token,
      });
      if (mine !== asked.current) return;
      if (p.today && p.today !== today) {
        setToday(p.today);
        // A quick pick means the server's days ("this week" there): ask again for those.
        if (chosenPreset) {
          const r = presetRange(chosenPreset, p.today);
          if (r.from !== range.from || r.to !== range.to) {
            setRange(r);
            return;
          }
        }
      }
      setPage(p);
      setError('');
    } catch (e) {
      if (mine !== asked.current) return;
      // The phone is a day ahead of the server: step back a day and ask again.
      if (e instanceof ApiError && e.why === 'range-future' && chosenPreset && today === range.to) {
        const back = addDays(today, -1);
        setToday(back);
        setRange(presetRange(chosenPreset, back));
        return;
      }
      if (e instanceof ApiError && e.status === 401) out.current();
      else
        setError(
          e instanceof ApiError && e.why ? sayError(lang, e.why, e.n) : say(lang, 'err.other'),
        );
    }
  }, [token, lang, range, today, chosenPreset]);
  useEffect(() => {
    void load();
  }, [load]);

  const preset = chosenPreset ?? presetOf(range, today);
  const shown = page && page.from === range.from && page.to === range.to ? page : undefined;
  const choose = (r: DayRange, p?: Preset) => {
    setPicking(false);
    setChosenPreset(p ?? presetOf(r, today));
    if (r.from === range.from && r.to === range.to) return;
    setPage(undefined);
    setRange(r);
  };
  return (
    <View style={{ gap: 12 }}>
      <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
        accessibilityRole="radiogroup"
      >
        {PRESETS.map((p) => (
          <Chip
            key={p}
            label={say(lang, CHIP[p])}
            on={!picking && preset === p}
            onPress={() => choose(presetRange(p, today), p)}
          />
        ))}
        <Chip
          label={say(lang, CHIP.pick)}
          on={picking || preset === undefined}
          onPress={() => setPicking(true)}
        />
      </View>

      {picking && (
        <DayRangePicker
          lang={lang}
          today={today}
          start={range}
          onDone={choose}
          onCancel={() => setPicking(false)}
        />
      )}

      {error !== '' && <Alert>{error}</Alert>}
      <View style={s.card}>
        <Label>{rangeLabel(lang, range)}</Label>
        {!shown && error === '' && <Muted>{say(lang, 'loading')}</Muted>}
        {shown && (
          <>
            <HoursPair
              lang={lang}
              screenOnSeconds={shown.screenOnSeconds}
              countedSeconds={shown.countedSeconds}
            />
            <View style={[s.row, { justifyContent: 'space-between', minHeight: 36 }]}>
              <Words style={{ color: color.text, fontSize: 15 }}>
                {say(lang, 'earnedBeforeTax')}
              </Words>
              <Words style={[s.figures, { fontSize: 22 }]}>{rupees(shown.earnedPaise)}</Words>
            </View>
            <Muted small>{say(lang, 'rangeNote')}</Muted>
            {shown.days.length > 1 &&
              (shown.days.some((d) => d.screenOnSeconds > 0 || d.countedSeconds > 0) ? (
                <View style={{ gap: 6, marginTop: 6 }}>
                  <Label>{say(lang, 'hoursByDay')}</Label>
                  <DayBars
                    lang={lang}
                    days={shown.days}
                    hours={(sec) => hoursWords(lang, sec)}
                    money={rupees}
                  />
                </View>
              ) : (
                <Muted small>{say(lang, 'noHoursThese')}</Muted>
              ))}
          </>
        )}
      </View>
    </View>
  );
}
