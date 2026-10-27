// P3.15: support. Support (and a super admin) look; Support admins (and a super admin) act.
//   POST /support/inbound              the provider posts a message someone sent (header
//                                      x-message-signature; trusted only when it checks out)
//   GET  /support?state=open|waiting|done|all&party=rider:RD-…|brand:<id>   the inbox
//   GET  /support/<SUP-…>              one conversation and its history
//   POST /support/open                 { channel, contact, subject, note }  a call, a visit, or to write
//   POST /support/<SUP-…>/reply        { text }   on WhatsApp or by email
//   POST /support/<SUP-…>/note         { text }   seen by staff only
//   POST /support/<SUP-…>/step         { state: open|waiting|done, owner: 'me'|null, reason }
import {
  noteThread,
  openThread,
  receiveMessage,
  Refusal,
  replyThread,
  stepThread,
  supportInbox,
  supportThread,
  problemsOfThread,
  type PartyKind,
  type SupportChannel,
  type SupportState,
  type ThreadRow,
} from '@recall/db';
import { can, type StaffAccess } from '@recall/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, rawBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) => can(a, { area: 'support', change: false });
const mayAct = (a: StaffAccess) => can(a, { area: 'support', change: true });
const STATES: readonly string[] = ['open', 'waiting', 'done'];
const CHANNELS: readonly string[] = ['whatsapp', 'email', 'phone', 'in person'];
const THREAD = /^\/support\/(SUP-[0-9A-F]{10})(?:\/(reply|note|step))?$/;

/** Read-only members see a phone's last 4 digits only, and an email's first letter and domain. */
const masked = (contact: string) =>
  /^\+91\d{10}$/.test(contact)
    ? `+91 ••••••${contact.slice(-4)}`
    : contact.replace(/^([^@])[^@]*@/, '$1•••@');

export async function handleSupport(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/', query = ''] = (req.url ?? '/').split('?');
  if (path !== '/support' && !path.startsWith('/support/')) return false;
  const method = req.method ?? 'GET';
  const now = Math.floor(nowMs / 1000);

  if (path === '/support/inbound') {
    if (method !== 'POST') throw new HttpError(405, 'Not allowed');
    const inbound = cfg.inbound;
    if (!inbound) throw new HttpError(503, 'Messages coming in are not set up');
    const m = inbound.verify(
      await rawBody(req, 64 * 1024),
      String(req.headers['x-message-signature'] ?? ''),
    );
    if (!m) throw new HttpError(401, 'Bad signature');
    const out = await receiveMessage(pool, m, now);
    send(res, 200, { threadId: out.threadId, isNew: out.isNew });
    return true;
  }

  if (method === 'GET') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    const hide = !mayAct(me.access);
    const show = (r: ThreadRow) => (hide ? { ...r, contact: masked(r.contact) } : r);
    if (path === '/support') {
      const q = new URLSearchParams(query);
      const state = q.get('state') ?? 'active';
      if (state !== 'active' && state !== 'all' && !STATES.includes(state))
        throw new HttpError(400, 'state: open, waiting, done, active or all');
      const p = q.get('party');
      let party: { kind: PartyKind; id: string } | undefined;
      if (p !== null) {
        const m = /^(rider|brand):([A-Za-z0-9-]{1,64})$/.exec(p);
        if (!m) throw new HttpError(400, 'party: rider:<id> or brand:<id>');
        party = { kind: m[1] as PartyKind, id: m[2] ?? '' };
      }
      const rows = await supportInbox(pool, {
        state: state as SupportState | 'all',
        ...(party ? { party } : {}),
      });
      send(res, 200, {
        at: now,
        rows: rows.map(show),
        canAct: mayAct(me.access),
        canReply: cfg.reports !== undefined,
        me: me.id,
      });
      return true;
    }
    const t = THREAD.exec(path);
    if (!t || t[2]) throw new HttpError(404, 'Not found');
    const page = await supportThread(pool, t[1] ?? '');
    if (!page) throw new HttpError(404, 'No such conversation');
    send(res, 200, {
      ...page,
      ...show(page),
      // Who wrote each message in is the person's contact: masked the same way.
      timeline: hide
        ? page.timeline.map((e) => (e.kind === 'in' ? { ...e, by: masked(e.by) } : e))
        : page.timeline,
      // P4.8: a screen problem from the rider app, with a link to its photo (10 minutes).
      problems: (await problemsOfThread(pool, page.threadId)).map(({ photoKey, ...p }) => ({
        ...p,
        photo: photoKey && cfg.files ? cfg.files.readLink(photoKey, now + 600) : null,
      })),
      me: me.id,
    });
    return true;
  }

  if (method !== 'POST') throw new HttpError(405, 'Not allowed');
  const origin = req.headers.origin;
  if (!origin || !cfg.origins.includes(origin)) throw new HttpError(403, 'Not from the admin site');
  const me = await staffFor(pool, cfg, req, nowMs);
  if (!mayAct(me.access)) throw new HttpError(403, 'Only Support admins answer conversations');
  const by = { id: me.id, name: me.name };
  const b = await jsonBody(req);
  const refused = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      if (e.message.startsWith('No conversation')) throw new HttpError(404, e.message);
      throw new HttpError(400, e.message);
    }
  };
  if (path === '/support/open') {
    const channel = str(b, 'channel', 20);
    if (!CHANNELS.includes(channel))
      throw new HttpError(400, 'channel: whatsapp, email, phone or in person');
    const threadId = await refused(() =>
      openThread(
        pool,
        {
          channel: channel as SupportChannel,
          contact: str(b, 'contact', 260),
          subject: str(b, 'subject', 200),
          note: str(b, 'note', 5000),
        },
        by,
        now,
      ),
    );
    send(res, 200, { threadId });
    return true;
  }
  const t = THREAD.exec(path);
  if (!t || !t[2]) throw new HttpError(404, 'Not found');
  const threadId = t[1] ?? '';
  if (t[2] === 'reply') {
    const messages = cfg.reports?.messages;
    if (!messages) throw new HttpError(503, 'Messages are not set up yet: replies cannot be sent');
    const status = await refused(() =>
      replyThread(pool, messages, threadId, str(b, 'text', 4000), by, now),
    );
    send(res, 200, { status });
  } else if (t[2] === 'note') {
    await refused(() => noteThread(pool, threadId, str(b, 'text', 5000), by, now));
    send(res, 200, { noted: true });
  } else {
    const state = str(b, 'state', 10);
    if (!STATES.includes(state)) throw new HttpError(400, 'state: open, waiting or done');
    if (b.owner !== 'me' && b.owner !== null) throw new HttpError(400, "owner: 'me' or null");
    await refused(() =>
      stepThread(
        pool,
        threadId,
        {
          state: state as SupportState,
          owner: b.owner === 'me' ? me.id : null,
          reason: str(b, 'reason', 300),
        },
        by,
        now,
      ),
    );
    send(res, 200, { state });
  }
  return true;
}
