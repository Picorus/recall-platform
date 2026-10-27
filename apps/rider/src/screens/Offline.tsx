// P4.1: signed in, but RECALL could not be reached (weak signal, or the server is down). The rider
// stays signed in and tries again; he never needs a new code for this.
import type { RiderLanguage } from '@recall/domain';
import { useState } from 'react';
import { say, sayError } from '../i18n';
import { Alert, Logo, MainButton, Screen } from '../ui';

export function Offline({
  lang,
  why,
  onRetry,
}: {
  readonly lang: RiderLanguage;
  readonly why: string;
  readonly onRetry: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Screen>
      <Logo tagline={say(lang, 'forRiders')} />
      <Alert>
        {why === 'offline' || why === ''
          ? say(lang, 'err.offline')
          : sayError(lang, why, undefined)}
      </Alert>
      <MainButton
        label={say(lang, 'retry')}
        busy={busy}
        onPress={() => {
          setBusy(true);
          void Promise.resolve(onRetry()).finally(() => setBusy(false));
        }}
      />
    </Screen>
  );
}
