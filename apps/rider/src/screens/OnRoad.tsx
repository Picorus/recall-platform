// P4.4–P4.8: a rider on the road moves between his pages with tabs at the bottom: Today, Earnings,
// Payouts, Screen (care, problems and the screen loan), Help.
import type { RiderLanguage } from '@recall/domain';
import { useEffect, useState } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Me } from '../api';
import { say, type Key } from '../i18n';
import { color, touch } from '../theme';
import { Words } from '../ui';
import { Earnings } from './Earnings';
import { Help } from './Help';
import { Care } from './Care';
import { Payouts } from './Payouts';
import { Profile } from './Profile';
import { Today } from './Today';

const TABS = [
  ['today', 'tab.today'],
  ['earnings', 'tab.earnings'],
  ['payouts', 'tab.payouts'],
  ['screen', 'tab.screen'],
  ['help', 'tab.help'],
] as const satisfies readonly (readonly [string, Key])[];
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
          backgroundColor: color.raised,
          paddingBottom: insets.bottom,
        }}
      >
        {TABS.map(([id, key]) => (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === id }}
            onPress={() => setTab(id)}
            style={{
              flex: 1,
              minHeight: touch.main,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Words
              weight="semibold"
              style={{ color: tab === id ? color.volt : color.muted, fontSize: 13 }}
            >
              {say(lang, key)}
            </Words>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
