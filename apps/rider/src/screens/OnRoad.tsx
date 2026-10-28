// P4.4–P4.8: a rider on the road moves between his pages with tabs at the bottom: Today, Earnings,
// Payouts, Screen (care, problems and the screen loan), Help.
import type { GlyphName } from '@recall/design';
import type { RiderLanguage } from '@recall/domain';
import { useEffect, useState } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Me } from '../api';
import { say, type Key } from '../i18n';
import { color, touch } from '../theme';
import { Icon, Words } from '../ui';
import { Earnings } from './Earnings';
import { Help } from './Help';
import { Care } from './Care';
import { Payouts } from './Payouts';
import { Profile } from './Profile';
import { Today } from './Today';

const TABS = [
  ['today', 'tab.today', 'home'],
  ['earnings', 'tab.earnings', 'wallet'],
  ['payouts', 'tab.payouts', 'bank'],
  ['screen', 'tab.screen', 'screen'],
  ['help', 'tab.help', 'help'],
] as const satisfies readonly (readonly [string, Key, GlyphName])[];
type Tab = (typeof TABS)[number][0];

export function OnRoad({
  lang,
  token,
  me,
  onLanguage,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly me: Me;
  readonly onLanguage: (l: RiderLanguage) => void;
  readonly onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>('today');
  const [profile, setProfile] = useState(false);
  // Android's back button closes the profile (not the app).
  useEffect(() => {
    if (!profile) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setProfile(false);
      return true;
    });
    return () => sub.remove();
  }, [profile]);
  if (profile)
    return (
      <Profile
        lang={lang}
        token={token}
        onLanguage={onLanguage}
        onBack={() => setProfile(false)}
        onSignOut={onSignOut}
      />
    );
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      <View style={{ flex: 1 }}>
        {tab === 'today' && (
          <Today
            lang={lang}
            token={token}
            me={me}
            onProfile={() => setProfile(true)}
            onSignOut={onSignOut}
          />
        )}
        {tab === 'earnings' && <Earnings lang={lang} token={token} onSignOut={onSignOut} />}
        {tab === 'payouts' && <Payouts lang={lang} token={token} onSignOut={onSignOut} />}
        {tab === 'screen' && <Care lang={lang} token={token} onSignOut={onSignOut} />}
        {tab === 'help' && <Help lang={lang} token={token} onSignOut={onSignOut} />}
      </View>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: 'row',
          borderTopWidth: 1,
          borderTopColor: color.divider,
          backgroundColor: color.ground,
          paddingTop: 6,
          paddingBottom: Math.max(insets.bottom, 8),
        }}
      >
        {TABS.map(([id, key, glyph]) => {
          const on = tab === id;
          return (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => setTab(id)}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: touch.main + 4,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                transform: [{ scale: pressed ? 0.92 : 1 }],
              })}
            >
              {/* The chosen tab: a small volt mark above its icon (the bar's one volt thing). */}
              <View
                style={{
                  position: 'absolute',
                  top: -6,
                  width: 26,
                  height: 3,
                  borderBottomLeftRadius: 3,
                  borderBottomRightRadius: 3,
                  backgroundColor: on ? color.volt : 'transparent',
                }}
                accessible={false}
              />
              <Icon name={glyph} size={24} tint={on ? color.text : color.quiet} />
              <Words
                weight="semibold"
                style={{ color: on ? color.text : color.quiet, fontSize: 11.5 }}
              >
                {say(lang, key)}
              </Words>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
