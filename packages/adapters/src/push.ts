// P4.10: phone notifications to the rider app (hard rule 4: behind an adapter with a working fake).
// The real one (Expo's push service, which reaches Android through Firebase) comes with the app's
// store account (P6). Each notification goes with a key that never changes for the same alert on the
// same phone, so sending it again never shows it twice.

export interface PushMessage {
  readonly key: string;
  /** The phone's push token, as the app registered it. */
  readonly token: string;
  readonly title: string;
  readonly body: string;
}

export type PushResult =
  | { readonly status: 'sent' }
  /** The phone no longer takes notifications (app removed, token changed): stop using it. */
  | { readonly status: 'gone' }
  | { readonly status: 'failed'; readonly reason: string };

export interface PushAdapter {
  send(m: PushMessage): Promise<PushResult>;
}

/** A laptop stand-in: remembers what it "sent"; a token starting "gone-" is a phone that left. */
export function fakePush(): PushAdapter & { readonly sent: readonly PushMessage[] } {
  const sent: PushMessage[] = [];
  const keys = new Set<string>();
  return {
    sent,
    send(m) {
      if (m.token.startsWith('gone-')) return Promise.resolve({ status: 'gone' });
      if (!keys.has(m.key)) {
        keys.add(m.key);
        sent.push(m);
      }
      return Promise.resolve({ status: 'sent' });
    },
  };
}
