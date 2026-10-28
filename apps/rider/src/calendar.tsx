// P4.5: "Pick dates": a small month calendar, big enough for a thumb (each day 44 points tall). Tap
// the first day, then the last; days after today, too old, or past 92 days from the first are
// greyed out. Plain React Native views (no date-picker module), so it works the same on Android and
// on the web build.
import type { RiderLanguage } from '@recall/domain';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  canTap,
  earliestDay,
  monthGrid,
  RANGE_MAX_DAYS,
  shiftMonth,
  tapDay,
  type DayRange,
  type Picking,
} from './dates';
import { rangeLabel, say } from './i18n';
import { color, radius, touch } from './theme';
import { Icon, LinkButton, MainButton, Muted, Words, s } from './ui';

function Arrow({
  label,
  back,
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly back: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: touch.min,
        height: touch.min,
        borderRadius: radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: color.divider,
        opacity: disabled ? 0.35 : pressed ? 0.7 : 1,
        transform: [{ rotate: back ? '0deg' : '180deg' }],
      })}
    >
      <Icon name="back" size={20} tint={color.text} />
    </Pressable>
  );
}

export function DayRangePicker({
  lang,
  today,
  start,
  onDone,
  onCancel,
}: {
  readonly lang: RiderLanguage;
  /** His business day now. */
  readonly today: string;
  /** The days shown now (the calendar opens on their last month). */
  readonly start: DayRange;
  readonly onDone: (r: DayRange) => void;
  readonly onCancel: () => void;
}) {
  const [month, setMonth] = useState(start.to.slice(0, 7));
  const [picking, setPicking] = useState<Picking>({ from: start.from, to: start.to });
  const months = say(lang, 'months').split(',');
  const weekdays = say(lang, 'weekdays').split(',');
  const first = earliestDay(today).slice(0, 7);
  const chosen: DayRange | undefined = picking.from
    ? { from: picking.from, to: picking.to ?? picking.from }
    : undefined;
  const title = `${months[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
  return (
    <View style={[s.card, { gap: 12 }]} accessibilityLabel={say(lang, 'pickTitle')}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Arrow
          label={say(lang, 'prevMonth')}
          back
          disabled={month <= first}
          onPress={() => setMonth(shiftMonth(month, -1))}
        />
        <Words weight="semibold" style={{ color: color.text, fontSize: 17 }}>
          {title}
        </Words>
        <Arrow
          label={say(lang, 'nextMonth')}
          back={false}
          disabled={month >= today.slice(0, 7)}
          onPress={() => setMonth(shiftMonth(month, 1))}
        />
      </View>
      <View style={{ flexDirection: 'row' }} accessible={false}>
        {weekdays.map((w, i) => (
          <View key={`${w}-${i}`} style={{ flex: 1, alignItems: 'center' }}>
            <Muted small>{w}</Muted>
          </View>
        ))}
      </View>
      <View style={{ gap: 4 }}>
        {monthGrid(month).map((row, r) => (
          <View key={r} style={{ flexDirection: 'row' }}>
            {row.map((day, i) => {
              if (!day) return <View key={`e${i}`} style={{ flex: 1, height: touch.min }} />;
              const ok = canTap(picking, day, today);
              const end = chosen !== undefined && (day === chosen.from || day === chosen.to);
              const inside = chosen !== undefined && day > chosen.from && day < chosen.to;
              return (
                <Pressable
                  key={day}
                  accessibilityRole="button"
                  accessibilityLabel={`${Number(day.slice(8, 10))} ${title}`}
                  accessibilityState={{ disabled: !ok, selected: end || inside }}
                  aria-disabled={!ok}
                  aria-selected={end || inside}
                  disabled={!ok}
                  onPress={() => setPicking(tapDay(picking, day))}
                  style={({ pressed }) => ({
                    flex: 1,
                    height: touch.min,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: inside ? color.voltSoft : 'transparent',
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <View
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 19,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: end ? color.volt : 'transparent',
                      borderWidth: day === today && !end ? 1 : 0,
                      borderColor: color.line,
                    }}
                  >
                    <Words
                      weight={end ? 'semibold' : 'regular'}
                      style={[
                        s.figures,
                        {
                          fontSize: 15,
                          color: end ? color.onVolt : ok ? color.text : color.quiet,
                          opacity: ok ? 1 : 0.45,
                        },
                      ]}
                    >
                      {String(Number(day.slice(8, 10)))}
                    </Words>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
      <Muted small>
        {chosen ? rangeLabel(lang, chosen) : say(lang, 'pickHint', { n: RANGE_MAX_DAYS })}
      </Muted>
      {chosen && picking.to === undefined && (
        <Muted small>{say(lang, 'pickHint', { n: RANGE_MAX_DAYS })}</Muted>
      )}
      <MainButton
        label={say(lang, 'pickShow')}
        disabled={!chosen}
        onPress={() => chosen && onDone(chosen)}
      />
      <LinkButton label={say(lang, 'pickCancel')} onPress={onCancel} />
    </View>
  );
}
