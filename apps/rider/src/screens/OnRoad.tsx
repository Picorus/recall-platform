// P4.4–P4.7: a rider on the road moves between his pages with tabs at the bottom (Today, Earnings,
// Payouts, Loan; screen care and help join them as they come).
import type { RiderLanguage } from '@recall/domain';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Me } from '../api';
import { say, type Key } from '../i18n';
import { color, touch } from '../theme';
import { Words } from '../ui';
import { Earnings } from './Earnings';
import { Loan } from './Loan';
import { Payouts } from './Payouts';
import { Today } from './Today';

const TABS = [
  ['today', 'tab.today'],
  ['earnings', 'tab.earnings'],
  ['payouts', 'tab.payouts'],
  ['loan', 'tab.loan'],
] as const satisfies readonly (readonly [string, Key])[];
type Tab = (typeof TABS)[number][0];

export function OnRoad({
  lang,
  token,
  me,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly me: Me;
  readonly onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>('today');
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      <View style={{ flex: 1 }}>
        {tab === 'today' && <Today lang={lang} token={token} me={me} onSignOut={onSignOut} />}
        {tab === 'earnings' && <Earnings lang={lang} token={token} onSignOut={onSignOut} />}
        {tab === 'payouts' && <Payouts lang={lang} token={token} onSignOut={onSignOut} />}
        {tab === 'loan' && <Loan lang={lang} token={token} onSignOut={onSignOut} />}
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
              style={{ color: tab === id ? color.volt : color.muted, fontSize: 15 }}
            >
              {say(lang, key)}
            </Words>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
