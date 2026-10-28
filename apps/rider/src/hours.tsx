// P4.4–P4.5: two numbers side by side: how long his screen was on ("Screen on": the app is live) and
// his moving hours (what pay counts), with one folded (i) line saying that pay counts moving hours.
import type { RiderLanguage } from '@recall/domain';
import { View } from 'react-native';
import { say } from './i18n';
import { color } from './theme';
import { Fold, Muted, Words } from './ui';

/** "2 h 15 min" (numbers the same in every language; the units are his). */
export function hoursWords(lang: RiderLanguage, seconds: number): string {
  const m = Math.floor(seconds / 60);
  return say(lang, 'hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
}

function Figure({
  label,
  value,
  strong,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}) {
  return (
    <View style={{ flex: 1, gap: 2 }} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: strong ? color.volt : color.line,
          }}
        />
        <Muted small>{label}</Muted>
      </View>
      <Words
        weight="semibold"
        style={{
          color: color.text,
          fontSize: 24,
          lineHeight: 30,
          letterSpacing: -0.5,
        }}
      >
        {value}
      </Words>
    </View>
  );
}

export function HoursPair({
  lang,
  screenOnSeconds,
  countedSeconds,
}: {
  readonly lang: RiderLanguage;
  readonly screenOnSeconds: number;
  readonly countedSeconds: number;
}) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Figure label={say(lang, 'screenOnHours')} value={hoursWords(lang, screenOnSeconds)} />
        <Figure label={say(lang, 'movingShort')} value={hoursWords(lang, countedSeconds)} strong />
      </View>
      <Fold quiet title={say(lang, 'payCountsMoving')}>
        <Muted small>{say(lang, 'payCountsMovingBody')}</Muted>
      </Fold>
    </View>
  );
}
