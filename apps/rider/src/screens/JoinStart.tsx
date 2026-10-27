// P4.2: a new number starts his sign-up: name, where he rides, the apps he rides for. His record is
// made (or found, if staff added him at the warehouse) and the six steps open.
import type { RiderLanguage } from '@recall/domain';
import { View } from 'react-native';
import { call } from '../api';
import { say } from '../i18n';
import { LinkButton, Muted, Screen, Title } from '../ui';
import { DetailsForm } from './Join';

export function JoinStart({
  lang,
  token,
  onJoined,
  onSignOut,
}: {
  readonly lang: RiderLanguage;
  readonly token: string;
  readonly onJoined: () => Promise<void>;
  readonly onSignOut: () => void;
}) {
  return (
    <Screen>
      <View style={{ gap: 8 }}>
        <Title>{say(lang, 'startTitle')}</Title>
        <Muted>{say(lang, 'startIntro')}</Muted>
      </View>
      <DetailsForm
        lang={lang}
        initial={{ name: '', rides: '', apps: [], bikePlate: null }}
        withPlate={false}
        button={say(lang, 'signUp')}
        onSave={(d) => call('/rider/join', { body: d, token }).then(onJoined)}
      />
      <LinkButton label={say(lang, 'signOut')} onPress={onSignOut} />
    </Screen>
  );
}
