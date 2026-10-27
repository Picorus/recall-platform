// P3.15: messages people send to RECALL on WhatsApp or by email (hard rule 4: behind an adapter with a
// working fake). The provider posts each one to us, signed; a message whose signature is wrong is
// never trusted. Each has the provider's own id, so a message posted twice is kept once.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InboundMessage {
  readonly channel: 'whatsapp' | 'email';
  /** The provider's id for this message (the same if it is posted again). */
  readonly providerId: string;
  /** Who wrote: a mobile number (+91 and 10 digits) or an email address. */
  readonly from: string;
  readonly subject?: string;
  readonly text: string;
  /** UTC seconds, by the provider's clock. */
  readonly at: number;
}

export interface InboundAdapter {
  /** The message in a provider's post, or null when its signature (or content) is wrong. */
  verify(rawBody: string, signature: string): InboundMessage | null;
}

const PHONE = /^\+91[6-9]\d{9}$/;
/** Control characters other than tab and new lines (a NUL would break the database). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** A subject is one line. */
// eslint-disable-next-line no-control-regex
const LINE_BREAK = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$/;

/** A post's content, checked field by field (even a signed one is not trusted blindly). */
export function inboundShape(x: unknown): InboundMessage | null {
  const m = x as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') return null;
  const { channel, providerId, from, subject, text, at } = m;
  if (channel !== 'whatsapp' && channel !== 'email') return null;
  if (typeof providerId !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(providerId)) return null;
  if (typeof from !== 'string' || !(channel === 'whatsapp' ? PHONE : EMAIL).test(from)) return null;
  if (typeof text !== 'string' || text.length > 10_000 || CONTROL.test(text)) return null;
  if (
    subject !== undefined &&
    (typeof subject !== 'string' || subject.length > 300 || LINE_BREAK.test(subject))
  )
    return null;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > 9_999_999_999)
    return null;
  return {
    channel,
    providerId,
    from: channel === 'email' ? from.toLowerCase() : from,
    ...(typeof subject === 'string' ? { subject } : {}),
    text,
    at,
  };
}

/**
 * A working fake: `message` makes the signed post a provider would send (for tests and the laptop);
 * `verify` checks it like the real one.
 */
export function fakeInbound(
  secret = 'fake-inbound-secret',
): InboundAdapter & { message(m: InboundMessage): { body: string; signature: string } } {
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex');
  return {
    message(m) {
      const body = JSON.stringify(m);
      return { body, signature: sign(body) };
    },
    verify(rawBody, signature) {
      const want = Buffer.from(sign(rawBody), 'hex');
      const got = Buffer.from(/^[0-9a-f]{64}$/.test(signature) ? signature : '', 'hex');
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      try {
        return inboundShape(JSON.parse(rawBody));
      } catch {
        return null;
      }
    },
  };
}
