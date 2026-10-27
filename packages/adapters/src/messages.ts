// P1.9.2: WhatsApp and email, and SMS (P4.1) (hard rule 4: behind an adapter with a working fake). Each message is
// sent with a key that never changes for the same message, so sending it again (a retry, a crash
// after sending) never reaches the brand twice: the provider answers with what happened the first
// time. The real providers (a WhatsApp Business partner, an email service) come with their accounts.

export interface Attachment {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export type Message =
  | {
      readonly channel: 'whatsapp';
      readonly key: string;
      /** Full India mobile number: +91 and 10 digits. */
      readonly to: string;
      /** WhatsApp Business needs an approved template; its blanks are filled in order. */
      readonly template: string;
      readonly params: readonly string[];
      /** The template's language (P4.1: te, hi or en); none: the provider's default. */
      readonly language?: string;
    }
  | {
      /** P4.1: a plain SMS (sign-in codes for riders without WhatsApp). */
      readonly channel: 'sms';
      readonly key: string;
      /** Full India mobile number: +91 and 10 digits. */
      readonly to: string;
      readonly text: string;
    }
  | {
      readonly channel: 'email';
      readonly key: string;
      readonly to: string;
      readonly subject: string;
      readonly text: string;
      readonly html: string;
      readonly attachments: readonly Attachment[];
    };

export type MessageResult =
  | { readonly status: 'sent'; readonly providerRef: string }
  /** `retryable`: a passing problem (provider down); otherwise the address is wrong. */
  | { readonly status: 'failed'; readonly reason: string; readonly retryable: boolean };

export interface MessagesAdapter {
  send(m: Message): Promise<MessageResult>;
}

/**
 * A working fake: "sends" at once, remembers each key (a repeat gets the first answer), keeps what
 * was sent for tests and the laptop, and fails where told to (`failFor`: address → failure).
 */
export function fakeMessages(
  opts: {
    readonly failFor?: ReadonlyMap<string, { reason: string; retryable: boolean }>;
  } = {},
): MessagesAdapter & { readonly sent: readonly Message[] } {
  const sent: Message[] = [];
  const answers = new Map<string, MessageResult>();
  return {
    sent,
    send(m) {
      const before = answers.get(m.key);
      if (before) return Promise.resolve(before);
      const fail = opts.failFor?.get(m.to);
      const result: MessageResult = fail
        ? { status: 'failed', ...fail }
        : { status: 'sent', providerRef: `fake-${m.channel}-${answers.size + 1}` };
      // A passing failure is not remembered, so a retry can succeed once the problem is gone.
      if (!(fail?.retryable ?? false)) answers.set(m.key, result);
      if (result.status === 'sent') sent.push(m);
      return Promise.resolve(result);
    },
  };
}
