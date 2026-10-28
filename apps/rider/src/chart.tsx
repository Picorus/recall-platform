// P4.5: a small bar chart of the days he picked: for each day, how long his screen was on (a quiet
// bar behind) and his moving hours (volt, in front: what pay counts). Both series are named in a
// legend (never colour alone). A tap on the chart picks the day under the thumb; the chosen day is
// spelt out beneath, so the numbers are there for screen readers too.
import type { RiderLanguage } from '@recall/domain';
import { useState } from 'react';
import { Pressable, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { G, Line, Rect } from 'react-native-svg';
import { shortDay } from './dates';
import { say } from './i18n';
import { color } from './theme';
import { Muted, Words } from './ui';

export interface ChartDay {
  readonly day: string;
  readonly countedSeconds: number;
  readonly screenOnSeconds: number;
  readonly earnedPaise: number;
}

const HEIGHT = 120;
const TOP = 16;

function Swatch({ tint, label }: { readonly tint: string; readonly label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: tint }} />
      <Muted small>{label}</Muted>
    </View>
  );
}

/** The index of the bar under `x` (pixels from the chart's left), of `n` bars over `width`. */
export const barAt = (x: number, width: number, n: number) =>
  Math.max(0, Math.min(n - 1, Math.floor((x / Math.max(1, width)) * n)));

export function DayBars({
  lang,
  days,
  hours,
  money,
}: {
  readonly lang: RiderLanguage;
  readonly days: readonly ChartDay[];
  /** Hours as words ("2 h 15 min"). */
  readonly hours: (seconds: number) => string;
  /** Paise as rupees. */
  readonly money: (paise: number) => string;
}) {
  const [width, setWidth] = useState(0);
  const [chosen, setChosen] = useState<string>();
  const n = days.length;
  const top = Math.max(3600, ...days.map((d) => Math.max(d.screenOnSeconds, d.countedSeconds)));
  // Whole hours on the scale's top line.
  const topHours = Math.ceil(top / 3600);
  const slot = n > 0 ? width / n : 0;
  const gap = slot > 10 ? Math.min(6, slot * 0.25) : slot > 4 ? 1 : 0;
  const bar = Math.max(1, slot - gap);
  const y = (s: number) => HEIGHT - (s / (topHours * 3600)) * (HEIGHT - TOP);
  const sel = days.find((d) => d.day === chosen) ?? days.at(-1);
  const pick = (e: GestureResponderEvent) => {
    const d = days[barAt(e.nativeEvent.locationX, width, n)];
    if (d) setChosen(d.day);
  };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
        <Swatch tint={color.line} label={say(lang, 'screenOnHours')} />
        <Swatch tint={color.volt} label={say(lang, 'movingShort')} />
      </View>
      <Pressable
        onLayout={(e: LayoutChangeEvent) => setWidth(Math.floor(e.nativeEvent.layout.width))}
        onPress={pick}
        accessibilityRole="image"
        accessibilityLabel={say(lang, 'hoursByDay')}
        style={{ height: HEIGHT }}
      >
        {width > 0 && (
          <Svg width={width} height={HEIGHT} pointerEvents="none">
            <Line
              x1={0}
              x2={width}
              y1={y(topHours * 3600)}
              y2={y(topHours * 3600)}
              stroke={color.divider}
              strokeDasharray="3 4"
            />
            <Line x1={0} x2={width} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke={color.line} />
            {days.map((d, i) => {
              const x = i * slot + gap / 2;
              const on = sel?.day === d.day;
              return (
                <G key={d.day}>
                  {d.screenOnSeconds > 0 && (
                    <Rect
                      x={x}
                      y={y(d.screenOnSeconds)}
                      width={bar}
                      height={HEIGHT - y(d.screenOnSeconds)}
                      rx={Math.min(3, bar / 3)}
                      fill={on ? color.line : color.field}
                      stroke={color.line}
                      strokeWidth={bar > 4 ? 1 : 0}
                    />
                  )}
                  {d.countedSeconds > 0 && (
                    <Rect
                      x={x + (bar > 8 ? bar * 0.2 : 0)}
                      y={y(d.countedSeconds)}
                      width={bar > 8 ? bar * 0.6 : bar}
                      height={HEIGHT - y(d.countedSeconds)}
                      rx={Math.min(3, bar / 3)}
                      fill={color.volt}
                      opacity={on || chosen === undefined ? 1 : 0.55}
                    />
                  )}
                </G>
              );
            })}
          </Svg>
        )}
        <View style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
          <Muted small>{say(lang, 'hoursShort', { n: topHours })}</Muted>
        </View>
      </Pressable>
      {n > 1 && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Muted small>{shortDay(days[0]?.day ?? '')}</Muted>
          <Muted small>{shortDay(days[n - 1]?.day ?? '')}</Muted>
        </View>
      )}
      {sel && (
        <Words style={{ color: color.text, fontSize: 14, lineHeight: 20 }}>
          {say(lang, 'dayDetail', {
            d: shortDay(sel.day),
            on: hours(sel.screenOnSeconds),
            moving: hours(sel.countedSeconds),
            earned: money(sel.earnedPaise),
          })}
        </Words>
      )}
    </View>
  );
}
