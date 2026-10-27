// P4.1: signed in. A rider we know sees where he stands; a new number is welcomed to the sign-up,
// whose steps (P4.2) open here next. The Today screen (P4.4) replaces this for fitted riders.
import type { RiderLanguage } from '@recall/domain';
import { View } from 'react-native';
import type { Me } from '../api';
import { say, type Key } from '../i18n';
import { color } from '../theme';
import { LinkButton, Muted, Screen, Title, Words, s } from '../ui';

/** What a known rider's step says. */
const STATUS: Readonly<Record<string, Key>> = {
  applied: 'status_applied',
  approved: 'status_approved',
  active: 'status_active',
  paused: 'status_paused',
  left: 'status_left',
  rejected: 'status_rejected',
};

export function Home({
  lang,
  me,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly me: Me;
  readonly onSignOut: () => void;
}) {
  return (
    <Screen>
      <View style={{ gap: 4 }}>
        <Muted small>{say(lang, 'hello')}</Muted>
        <Title>{me.name ?? say(lang, 'welcome')}</Title>
      </View>
      <View style={s.card}>
        <Words weight="semibold" style={{ color: color.text, fontSize: 18, lineHeight: 26 }}>
          {say(lang, (me.riderId && STATUS[me.status ?? '']) || 'joinNext')}
        </Words>
      </View>
      <Muted small>{say(lang, 'signedInAs', { phone: me.shown.replace(/ /g, '\u00a0') })}</Muted>
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
