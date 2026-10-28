// P4.4: "Where you are", a small map kept just in case (like other riding apps). Everything on it
// comes from the screen on his bike (hard rule 1): his last position (a volt dot that pulses while
// it is live; grey and plainly said when old or unknown), his route today as a volt line, the
// nearest street, and the roads around him for a base map (from the maps provider; a stand-in until
// the maps account, P6). Night Signal: dark ground, roads in a quiet line colour, main roads a little
// brighter. A tap opens it full screen. Roads are fetched again only once he has moved 300 m.
import { roadsStillCover, type MapRoad, type RiderLanguage } from '@recall/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { ApiError, call } from './api';
import { say } from './i18n';
import { ago, pathOf, viewOf } from './map-math';
import { color, radius, touch } from './theme';
import { Icon, Label, Muted, Words, s } from './ui';

export interface WherePage {
  readonly at: number;
  readonly position: {
    readonly t: number;
    readonly lat: number;
    readonly lng: number;
    readonly moving: boolean;
    readonly age: 'live' | 'recent' | 'old';
  } | null;
  readonly street: string | null;
  readonly route: readonly (readonly [number, number])[];
  readonly centre: { readonly lat: number; readonly lng: number } | null;
  readonly radiusM: number;
  readonly roads: readonly MapRoad[] | null;
  readonly credit: string | null;
}

/** India time of day, "14:05". */
const clock = (t: number) => {
  const d = new Date((t + 19_800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/**
 * Where he is, asked every minute while the page is open. The roads come once and again only after
 * he has moved 300 m from where they were drawn (each ask may cost a maps look-up).
 */
export function useWhere(token: string, onSignedOut: () => void) {
  const [where, setWhere] = useState<WherePage>();
  const [roads, setRoads] = useState<{
    readonly centre: { readonly lat: number; readonly lng: number };
    readonly roads: readonly MapRoad[];
    readonly credit: string | null;
  }>();
  const had = useRef(roads);
  had.current = roads;
  const out = useRef(onSignedOut);
  out.current = onSignedOut;
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
      const last = had.current;
      let w = await call<WherePage>(`/rider/where${last ? '?roads=no' : ''}`, { token });
      // Moved off the roads he has: ask once more, with roads.
      if (last && w.centre && !roadsStillCover(last.centre, w.centre))
        w = await call<WherePage>('/rider/where', { token });
      if (mine !== asked.current) return;
      setWhere(w);
      if (w.centre && w.roads) setRoads({ centre: w.centre, roads: w.roads, credit: w.credit });
    } catch (e) {
      if (mine === asked.current && e instanceof ApiError && e.status === 401) out.current();
      // Otherwise keep what was shown: the map is a help, never in the way.
    }
  }, [token]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);
  return { where, roads, reload: load };
}

/** The halo that pulses around a live position (still when the phone asks for less motion). */
function Pulse({ x, y }: { readonly x: number; readonly y: number }) {
  const v = useRef(new Animated.Value(0)).current;
  const [still, setStill] = useState(false);
  useEffect(() => {
    let stop = false;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((r) => !stop && setStill(r))
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, []);
  useEffect(() => {
    if (still) return;
    const a = Animated.loop(
      Animated.timing(v, {
        toValue: 1,
        duration: 1800,
        easing: Easing.out(Easing.quad),
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    a.start();
    return () => a.stop();
  }, [v, still]);
  if (still) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessible={false}
      style={{
        position: 'absolute',
        left: x - 12,
        top: y - 12,
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: color.volt,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 3.2] }) }],
      }}
    />
  );
}

/** The map itself: ground, roads, his route, his dot. */
export function MapDrawing({
  where,
  roads,
  width,
  height,
}: {
  readonly where: WherePage;
  readonly roads: readonly MapRoad[];
  readonly width: number;
  readonly height: number;
}) {
  const centre = where.centre;
  if (!centre || width <= 0 || height <= 0)
    return <View style={{ width, height, backgroundColor: color.ground }} />;
  // The longer side shows a little less than the roads reach, so the edges are never bare.
  const view = viewOf(centre, where.radiusM * 1.8, width, height);
  const minor = roads.filter((r) => !r.main).map((r) => pathOf(view, r.points));
  const major = roads.filter((r) => r.main).map((r) => pathOf(view, r.points));
  const route = pathOf(view, where.route);
  const p = where.position;
  const dot = p ? view.at(p.lat, p.lng) : undefined;
  const tint = p && p.age !== 'old' ? color.volt : color.muted;
  return (
    <View style={{ width, height }} accessible={false}>
      <Svg width={width} height={height}>
        <Rect x={0} y={0} width={width} height={height} fill={color.ground} />
        {minor.map(
          (d, i) =>
            d && (
              <Path
                key={`n${i}`}
                d={d}
                stroke={color.divider}
                strokeWidth={1.6}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ),
        )}
        {major.map(
          (d, i) =>
            d && (
              <Path
                key={`m${i}`}
                d={d}
                stroke={color.line}
                strokeOpacity={0.5}
                strokeWidth={2.6}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ),
        )}
        {route !== '' && (
          <Path
            d={route}
            stroke={color.volt}
            strokeOpacity={p?.age === 'old' ? 0.5 : 0.9}
            strokeWidth={3.5}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {dot && (
          <>
            <Circle cx={dot[0]} cy={dot[1]} r={15} fill={tint} fillOpacity={0.18} />
            <Circle
              cx={dot[0]}
              cy={dot[1]}
              r={7}
              fill={tint}
              stroke={color.ground}
              strokeWidth={2.5}
            />
          </>
        )}
      </Svg>
      {dot && p?.age === 'live' && <Pulse x={dot[0]} y={dot[1]} />}
    </View>
  );
}

/** What the map says in words: now, at a time (and how long ago), old, or not known. */
export function whereWords(
  lang: RiderLanguage,
  w: WherePage | undefined,
): {
  readonly line: string;
  readonly warn: boolean;
} {
  const p = w?.position;
  if (!w || !p) return { line: say(lang, 'whereUnknown'), warn: true };
  const a = ago(w.at, p.t);
  const since = say(lang, a.unit === 'min' ? 'minutesShort' : 'hoursShort', { n: a.n });
  const near = w.street ? say(lang, 'whereNear', { street: w.street }) : '';
  if (p.age === 'old')
    return { line: say(lang, 'whereOld', { t: clock(p.t), ago: since }), warn: true };
  const when =
    p.age === 'live' ? say(lang, 'whereNow') : say(lang, 'whereAt', { t: clock(p.t), ago: since });
  return { line: near ? `${when} · ${near}` : when, warn: false };
}

function Credit({ text }: { readonly text: string | null | undefined }) {
  if (!text) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', right: 6, bottom: 4, opacity: 0.8 }}
      accessible={false}
    >
      <Words style={{ color: color.quiet, fontSize: 10 }}>{text}</Words>
    </View>
  );
}

/** The map card on Today: a small map, where he is in words; a tap opens the big map. */
export function MapCard({
  lang,
  where,
  roads,
  credit,
}: {
  readonly lang: RiderLanguage;
  readonly where: WherePage | undefined;
  readonly roads: readonly MapRoad[];
  readonly credit: string | null | undefined;
}) {
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);
  const words = whereWords(lang, where);
  const known = where?.centre != null;
  return (
    <View style={s.card} accessibilityLabel={say(lang, 'whereTitle')}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Label>{say(lang, 'whereTitle')}</Label>
        {known && <Icon name="map" size={18} tint={color.muted} />}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={say(lang, 'openMap')}
        accessibilityHint={words.line}
        disabled={!known}
        onPress={() => setOpen(true)}
        onLayout={(e: LayoutChangeEvent) => setWidth(Math.floor(e.nativeEvent.layout.width))}
        style={({ pressed }) => ({
          height: 190,
          borderRadius: radius.control,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: color.divider,
          backgroundColor: color.ground,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        {where && known && width > 0 ? (
          <>
            <MapDrawing where={where} roads={roads} width={width} height={190} />
            <Credit text={credit} />
          </>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="pin" size={28} tint={color.quiet} />
          </View>
        )}
      </Pressable>
      <Words
        weight="semibold"
        style={{ color: words.warn ? color.muted : color.text, fontSize: 15, lineHeight: 21 }}
      >
        {words.line}
      </Words>
      {where?.position && (
        <View style={[s.row, { gap: 14, flexWrap: 'wrap' }]}>
          {where.route.length > 1 && (
            <View style={s.row}>
              <View
                style={{ width: 16, height: 3, borderRadius: 2, backgroundColor: color.volt }}
              />
              <Muted small>{say(lang, 'routeToday')}</Muted>
            </View>
          )}
          <Muted small>{say(lang, 'whereFrom')}</Muted>
        </View>
      )}
      {where && open && (
        <BigMap
          lang={lang}
          where={where}
          roads={roads}
          credit={credit}
          onClose={() => setOpen(false)}
        />
      )}
    </View>
  );
}

/** The big map, full screen; Android's back button closes it. */
function BigMap({
  lang,
  where,
  roads,
  credit,
  onClose,
}: {
  readonly lang: RiderLanguage;
  readonly where: WherePage;
  readonly roads: readonly MapRoad[];
  readonly credit: string | null | undefined;
  readonly onClose: () => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const words = whereWords(lang, where);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView style={{ flex: 1, backgroundColor: color.ground }}>
        <View
          style={{ flex: 1 }}
          onLayout={(e: LayoutChangeEvent) =>
            setSize({
              width: Math.floor(e.nativeEvent.layout.width),
              height: Math.floor(e.nativeEvent.layout.height),
            })
          }
        >
          <MapDrawing where={where} roads={roads} width={size.width} height={size.height} />
          <Credit text={credit} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={say(lang, 'closeMap')}
            onPress={onClose}
            style={({ pressed }) => ({
              position: 'absolute',
              left: 16,
              top: 12,
              minHeight: touch.min,
              paddingHorizontal: 14,
              borderRadius: radius.pill,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              backgroundColor: color.raised,
              borderWidth: 1,
              borderColor: color.divider,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Icon name="back" size={20} />
            <Words weight="semibold" style={{ color: color.text, fontSize: 15 }}>
              {say(lang, 'closeMap')}
            </Words>
          </Pressable>
        </View>
        <View style={[s.card, { margin: 16, marginTop: 0, borderRadius: radius.sheet }]}>
          <Label>{say(lang, 'whereTitle')}</Label>
          <Words
            weight="semibold"
            style={{ color: words.warn ? color.muted : color.text, fontSize: 17, lineHeight: 24 }}
          >
            {words.line}
          </Words>
          <View style={[s.row, { gap: 14, flexWrap: 'wrap' }]}>
            {where.route.length > 1 && (
              <View style={s.row}>
                <View
                  style={{ width: 16, height: 3, borderRadius: 2, backgroundColor: color.volt }}
                />
                <Muted small>{say(lang, 'routeToday')}</Muted>
              </View>
            )}
            <Muted small>{say(lang, 'whereFrom')}</Muted>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
