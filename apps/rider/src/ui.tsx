// Small shared pieces for the rider app's screens (P4.1): the screen frame, words, buttons and a
// field, in Night Signal. Every control is at least 44 points and says what it is to screen readers.
import type { RiderLanguage } from '@recall/domain';
import { createContext, useContext, type ReactNode } from 'react';
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { face, MONO, type Weight } from './fonts';
import { color, touch } from './theme';

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
    <View style={s.row} accessibilityRole="header">
      <View style={s.mark} accessible={false}>
        <View style={[s.bar, { height: 11, width: 4 }]} />
        <View style={[s.bar, { height: 16, width: 7 }]} />
        <View style={[s.bar, { height: 20, width: 28, borderRadius: 5 }]} />
      </View>
      <Text style={[s.wordmark, { fontFamily: face('en', 'extrabold') }]}>RECALL</Text>
      <Words style={s.muted13}>{tagline}</Words>
    </View>
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
      style={({ pressed }) => [s.main, (pressed || off) && { opacity: 0.6 }]}
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

export const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ground },
  body: { padding: 16, paddingTop: 20, gap: 16, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  bar: { backgroundColor: color.volt, borderRadius: 3 },
  wordmark: { color: color.text, fontSize: 20, letterSpacing: 0.5 },
  title: { color: color.text, fontSize: 32, lineHeight: 40 },
  muted: { color: color.muted, fontSize: 16, lineHeight: 24 },
  muted13: { color: color.muted, fontSize: 13, lineHeight: 20 },
  label: { color: color.text, fontSize: 14 },
  alert: { color: color.error, fontSize: 15, lineHeight: 22 },
  main: {
    minHeight: touch.main,
    borderRadius: 6,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  mainText: { color: color.onVolt, fontSize: 16 },
  link: {
    minHeight: touch.min,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  linkText: { color: color.text, fontSize: 14, textDecorationLine: 'underline' },
  linkOff: { color: color.quiet, textDecorationLine: 'none' },
  prefix: {
    minHeight: touch.main,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 6,
    justifyContent: 'center',
  },
  mono: { color: color.text, fontSize: 17, fontFamily: MONO },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: touch.main,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 6,
    paddingHorizontal: 14,
    fontSize: 17,
    fontFamily: MONO,
    color: color.text,
    backgroundColor: color.field,
  },
  card: {
    backgroundColor: color.raised,
    borderRadius: 14,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: color.divider,
  },
});
