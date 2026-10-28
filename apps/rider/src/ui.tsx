// Small shared pieces for the rider app's screens (P4.1): the screen frame, words, buttons and a
// field, in Night Signal. Every control is at least 44 points and says what it is to screen readers.
import type { RiderLanguage } from '@recall/domain';
import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
} from 'react-native';
import { glyphs, type GlyphName } from '@recall/design';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path, SvgXml } from 'react-native-svg';
import { face, MONO, type Weight } from './fonts';
import { LOCKUP_DARK } from './logo';
import { color, radius, touch } from './theme';

/** The rider's language, for the face every text is set in. */
export const LangContext = createContext<RiderLanguage>('en');

/** The face for this weight in the rider's language. */
export function useFace(weight: Weight = 'regular'): TextStyle {
  return { fontFamily: face(useContext(LangContext), weight) };
}

/** Words in the rider's language at a weight (a phone needs the face named, not a weight). */
export function Words({
  children,
  weight,
  style,
}: {
  readonly children: ReactNode;
  readonly weight?: Weight;
  readonly style?: TextStyle | readonly TextStyle[];
}) {
  return (
    <Text style={[useFace(weight), ...(Array.isArray(style) ? style : [style])]}>{children}</Text>
  );
}

export function Screen({ children }: { readonly children: ReactNode }) {
  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Logo({ tagline }: { readonly tagline: string }) {
  return (
    <View style={{ gap: 6 }} accessibilityRole="header" accessibilityLabel="RECALL">
      <SvgXml xml={LOCKUP_DARK} width={136} height={16} />
      <Words style={s.muted13}>{tagline}</Words>
    </View>
  );
}

/** One of the shared icons (Design 2.0), drawn as strokes. Decorative: its words say what it is. */
export function Icon({
  name,
  size = 22,
  tint = color.text,
}: {
  readonly name: GlyphName;
  readonly size?: number;
  readonly tint?: string;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={tint}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
    >
      <Path d={glyphs[name]} />
    </Svg>
  );
}

export function Title({ children }: { readonly children: ReactNode }) {
  return (
    <Text style={[s.title, useFace('extrabold')]} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Muted({
  children,
  small,
}: {
  readonly children: ReactNode;
  readonly small?: boolean;
}) {
  return <Words style={small ? s.muted13 : s.muted}>{children}</Words>;
}

export function Label({ children }: { readonly children: ReactNode }) {
  return (
    <Words weight="semibold" style={s.label}>
      {children}
    </Words>
  );
}

export function Alert({ children }: { readonly children: ReactNode }) {
  return (
    <Text
      style={[s.alert, useFace('semibold')]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      {children}
    </Text>
  );
}

export function MainButton({
  label,
  onPress,
  busy,
  disabled,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
}) {
  const off = disabled === true || busy === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: busy === true }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        s.main,
        pressed && { transform: [{ scale: 0.97 }] },
        off && { opacity: 0.45 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color.onVolt} />
      ) : (
        <Words weight="semibold" style={s.mainText}>
          {label}
        </Words>
      )}
    </Pressable>
  );
}

export function LinkButton({
  label,
  onPress,
  disabled,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled === true}
      onPress={onPress}
      style={s.link}
    >
      <Words weight="semibold" style={[s.linkText, ...(disabled === true ? [s.linkOff] : [])]}>
        {label}
      </Words>
    </Pressable>
  );
}

export function Field({
  label,
  prefix,
  ...input
}: TextInputProps & { readonly label: string; readonly prefix?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Label>{label}</Label>
      <View style={s.row}>
        {prefix !== undefined && (
          <View style={s.prefix}>
            <Text style={s.mono}>{prefix}</Text>
          </View>
        )}
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={color.quiet}
          style={s.input}
          {...input}
        />
      </View>
    </View>
  );
}

/**
 * Words folded away behind a tap (P7.7.6): the screen stays calm while riding, nothing is lost.
 * A titled card that opens, or (with `quiet`) a small (i) line for a note.
 */
export function Fold({
  title,
  quiet,
  icon,
  children,
}: {
  readonly title: string;
  readonly quiet?: boolean;
  readonly icon?: GlyphName;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={quiet ? { gap: 6 } : [s.card, { gap: 10 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [
          s.row,
          { minHeight: touch.min, justifyContent: quiet ? 'flex-start' : 'space-between' },
          pressed && { opacity: 0.7 },
        ]}
      >
        {quiet && (
          <View style={[s.info, open && { backgroundColor: color.text }]} accessible={false}>
            <Text style={[s.infoI, open && { color: color.ground }]}>i</Text>
          </View>
        )}
        <View style={[s.row, { flexShrink: 1 }]}>
          {icon && <Icon name={icon} size={20} tint={color.data} />}
          <Words
            weight="semibold"
            style={{ color: quiet ? color.muted : color.text, fontSize: 15 }}
          >
            {title}
          </Words>
        </View>
        {!quiet && (
          <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
            <Icon name="chevron" size={20} tint={color.muted} />
          </View>
        )}
      </Pressable>
      {open && <View style={{ gap: 6 }}>{children}</View>}
    </View>
  );
}

export const s = StyleSheet.create({
  info: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: color.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoI: { color: color.muted, fontSize: 12, fontStyle: 'italic', fontWeight: '700' },
  safe: { flex: 1, backgroundColor: color.ground },
  body: { padding: 20, paddingTop: 20, gap: 16, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: color.text, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 },
  muted: { color: color.muted, fontSize: 16, lineHeight: 24 },
  muted13: { color: color.muted, fontSize: 13, lineHeight: 20 },
  label: { color: color.text, fontSize: 14 },
  alert: { color: color.error, fontSize: 15, lineHeight: 22 },
  main: {
    minHeight: 54,
    borderRadius: radius.control,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  mainText: { color: color.onVolt, fontSize: 16.5 },
  link: {
    minHeight: touch.min,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  linkText: { color: color.muted, fontSize: 14.5 },
  linkOff: { color: color.quiet, textDecorationLine: 'none' },
  prefix: {
    minHeight: touch.main,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.control,
    justifyContent: 'center',
  },
  mono: { color: color.text, fontSize: 17, fontFamily: MONO },
  /** Money, dates and counts: the main face with even-width digits, so columns line up (Night Signal). */
  figures: {
    color: color.text,
    fontSize: 17,
    fontFamily: face('en', 'semibold'),
    fontVariant: ['tabular-nums'],
  },
  /** A 6-digit code box: big digits set apart. */
  code: { fontSize: 24, letterSpacing: 10, fontVariant: ['tabular-nums'] },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: touch.main,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.control,
    paddingHorizontal: 14,
    fontSize: 17,
    fontFamily: MONO,
    color: color.text,
    backgroundColor: color.field,
  },
  card: {
    backgroundColor: color.raised,
    borderRadius: radius.card,
    padding: 18,
    gap: 8,
    borderWidth: 1,
    borderColor: color.divider,
  },
});
