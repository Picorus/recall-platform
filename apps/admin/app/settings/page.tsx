'use client';
// P3.17 Settings: cities, fitting centres, support numbers and hours, message wording, the rider pay
// zone and the screen-loan bank; who has which role (changed on the Staff page); which outside
// services are on. Every member sees them; a super admin changes one at a time, with why. Each save
// is a new version (nothing overwritten) and shows in the audit log.
import { Fold, Info } from '@recall/web-ui';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api';
import { clock, dayOfIndia, groupMobile, noSpaces, regroupMobile } from '../../lib/format';
import { Shell, useMember } from '../../lib/session';
import {
  MODE_NAMES,
  type BusinessSwitch,
  DAY_NAMES,
  BRAND_SIGN_IN_LABELS,
  RIDER_SIGN_IN_LABELS,
  type FittingCentre,
  type MessageWordings,
  type PayZone,
  type SettingKey,
  type SettingRecord,
  type Settings,
  type SettingsPage,
  type SupportPhone,
  type Wording,
} from '../../lib/settings';
import { AREA_NAMES, ROLE_NAMES, type Area, type Role } from '../../lib/staff';

const failed = (e: unknown, what: string) => (e instanceof ApiError ? e.message : what);

const ROLE_RIGHTS: Record<Role, string> = {
  'super-admin': 'Everything, in every part: staff, settings, prices, the audit log.',
  admin: 'Looks and changes in the parts they work in.',
  'read-only': 'Looks in the parts they may see; changes nothing.',
};

/** One setting: its editor, who saved it last, and (for a super admin) why and Save. */
function Section<K extends SettingKey>({
  name,
  title,
  record,
  canChange,
  saved,
  onSaved,
  children,
}: {
  readonly name: K;
  readonly title: string;
  readonly record: SettingRecord<K>;
  readonly canChange: boolean;
  /** What the last save here said (kept by the page: this section starts afresh after a save). */
  readonly saved: string;
  readonly onSaved: (message: string) => void;
  readonly children: (value: Settings[K], set: (v: Settings[K]) => void) => ReactNode;
}) {
  const [draft, setDraft] = useState<Settings[K]>(record.value);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const reason = String(new FormData(form).get('reason') ?? '');
    setBusy(true);
    api<{ version: number }>(`/settings/${name}`, {
      value: draft,
      reason,
      version: record.version,
    })
      .then((x) => {
        setError('');
        form.reset();
        onSaved(`Saved as version ${x.version}.`);
      })
      .catch((err: unknown) => {
        setError(failed(err, 'Could not save.'));
      })
      .finally(() => setBusy(false));
  };
  return (
    <section className="rc-card stack" aria-label={title}>
      <h2>{title}</h2>
      <p className="muted">
        {record.version === 0
          ? 'Not changed yet (the starting setting).'
          : `Version ${record.version}, saved by ${record.savedBy ?? '?'} on ${dayOfIndia(
              record.savedAt ?? 0,
            )}, ${clock(record.savedAt ?? 0)}: ${record.reason ?? ''}`}
      </p>
      <form className="stack" onSubmit={save}>
        <fieldset className="plain stack" disabled={!canChange || busy}>
          {children(draft, setDraft)}
        </fieldset>
        {canChange && (
          <div className="cal-bar">
            <label className="rc-field">
              <span className="rc-field__label">Why</span>
              <input className="rc-input" name="reason" minLength={5} maxLength={300} required />
            </label>
            <button className="rc-button" type="submit" disabled={busy}>
              Save
            </button>
            <button
              className="rc-button rc-button--secondary"
              type="button"
              onClick={() => setDraft(record.value)}
            >
              Undo my edits
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {saved && !error && <p role="status">{saved}</p>}
      </form>
    </section>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="rc-field">
      <span className="rc-field__label">{label}</span>
      {children}
    </label>
  );
}

function WordingFields({
  title,
  hint,
  value,
  onChange,
}: {
  readonly title: string;
  readonly hint: string;
  readonly value: Wording;
  readonly onChange: (w: Wording) => void;
}) {
  return (
    <fieldset className="plain stack" aria-label={title}>
      <h3>{title}</h3>
      <p className="muted">{hint}</p>
      <Field label="WhatsApp template (its approved name)">
        <input
          className="rc-input mono"
          value={value.whatsappTemplate}
          onChange={(e) => onChange({ ...value, whatsappTemplate: e.target.value })}
        />
      </Field>
      <Field label="Email subject">
        <input
          className="rc-input"
          value={value.emailSubject}
          onChange={(e) => onChange({ ...value, emailSubject: e.target.value })}
        />
      </Field>
      <Field label="Email text">
        <textarea
          className="rc-input"
          rows={5}
          value={value.emailText}
          onChange={(e) => onChange({ ...value, emailText: e.target.value })}
        />
      </Field>
    </fieldset>
  );
}

/** Whole days from `now` to `t` (at least 0). */
const daysTo = (now: number, t: number) => Math.max(0, Math.ceil((t - now) / 86_400));

/**
 * The business switch (P7.7.7): the whole business runs as the POC or as regular business. It
 * changes how riders are paid and how the calendar limits bookings. A super admin flips it, says
 * why, and it counts from a day ahead (the POC from a 1st), so nothing already earned changes.
 * P7.8 (Prateek, 28 Oct 2026): switched on, the POC is scheduled until its 1st (POC brands, their
 * fees and plans are set up meanwhile); it is planned to run its months (a setting) and ends only by
 * a super admin's switch back; one that would end it early asks first.
 */
function BusinessSwitchCard({
  b,
  now,
  onSaved,
}: {
  b: BusinessSwitch;
  now: number;
  onSaved: () => void;
}) {
  const to = b.mode === 'poc' ? 'regular' : 'poc';
  const from = to === 'poc' ? b.pocFrom : b.regularFrom;
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Days the switch back would cut off the POC's planned months (asked before it is sent). */
  const p = b.poc;
  const early =
    to === 'regular' && p.phase === 'running' && from < p.plannedEnd
      ? Math.max(1, Math.ceil((p.plannedEnd - from) / 86_400))
      : 0;
  const [sure, setSure] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancel = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/settings/business/cancel', { reason });
      setCancelling(false);
      setReason('');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/settings/business', { mode: to, reason, ...(early > 0 ? { early: sure } : {}) });
      setAsking(false);
      setReason('');
      setSure(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rc-card stack" aria-label="POC or regular business">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>POC or regular business</h2>
        <span className={`rc-chip ${b.mode === 'poc' ? 'rc-chip--info' : 'rc-chip--go'}`}>
          Now: {MODE_NAMES[b.mode]}
        </span>
      </div>
      {b.alerts.map((a) => (
        <p
          key={a.kind}
          className={`banner${a.kind === 'months-over' ? ' banner--warn' : ''}`}
          role="status"
        >
          {a.text}
        </p>
      ))}
      {p.phase !== 'none' && (
        <dl className="facts" aria-label="The POC">
          <div>
            <dt>{p.phase === 'scheduled' ? 'Starts' : 'Started'}</dt>
            <dd>
              {dayOfIndia(p.startsAt)}, 8 am
              {p.phase === 'scheduled' && ` (in ${daysTo(now, p.startsAt)} days)`}
            </dd>
          </div>
          <div>
            <dt>Planned</dt>
            <dd>
              {b.pocMonths} months, ends {dayOfIndia(p.plannedEnd - 86_400)}; switch to regular
              business on the morning of {dayOfIndia(p.plannedEnd)}
              {p.phase === 'running' &&
                (now < p.plannedEnd
                  ? ` (${daysTo(now, p.plannedEnd)} days to go)`
                  : ' (its months are over)')}
            </dd>
          </div>
          {p.endedAt !== null && (
            <div>
              <dt>Ended</dt>
              <dd>{dayOfIndia(p.endedAt)}, 8 am</dd>
            </div>
          )}
        </dl>
      )}
      {b.next && (
        <p className="ok" role="status">
          Switching to {MODE_NAMES[b.next.mode]} from {dayOfIndia(b.next.from)}, 8 am.
        </p>
      )}
      <Info label="What the switch changes">
        In the POC, riders get the POC base pay (₹2,000 / ₹4,000 / ₹6,000 in months 1, 2 and 3) and
        the founding bonus, every bike plays the POC brands in turn, and up to the POC&apos;s bikes
        can be fitted. In regular business, riders earn ₹25 a moving hour and their share of sales,
        and the calendar uses the supply forecast. The POC is switched on from the 1st of a month
        (scheduled until then: POC brands, their fees and plans are set up meanwhile) and switched
        back by hand from the start of the day: on the morning of the 1st after its months. It runs
        once.
      </Info>
      {b.canSwitch && !b.next && !asking && (
        <button
          type="button"
          className="rc-button rc-button--strong"
          onClick={() => setAsking(true)}
        >
          Switch to {MODE_NAMES[to]} from {dayOfIndia(from)}
        </button>
      )}
      {b.canSwitch && p.phase === 'scheduled' && !cancelling && !asking && (
        <button
          type="button"
          className="rc-button rc-button--secondary"
          onClick={() => setCancelling(true)}
        >
          Cancel the scheduled POC
        </button>
      )}
      {cancelling && (
        <form className="stack" onSubmit={(e) => void cancel(e)} aria-label="Cancel the POC">
          <p>
            The POC will not start on {dayOfIndia(p.phase === 'scheduled' ? p.startsAt : 0)}. It
            never ran, so it can be scheduled again; POC months already paid for it are owed back.
          </p>
          <label className="rc-field">
            <span className="rc-field__label">Why (kept with the cancel)</span>
            <input
              className="rc-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={5}
              maxLength={300}
              required
            />
          </label>
          <div className="row">
            <button
              type="submit"
              className="rc-button rc-button--primary"
              disabled={busy || reason.trim().length < 5}
            >
              Yes, cancel the POC
            </button>
            <button
              type="button"
              className="rc-button rc-button--quiet"
              onClick={() => setCancelling(false)}
            >
              Keep it
            </button>
          </div>
        </form>
      )}
      {asking && (
        <form className="stack" onSubmit={(e) => void save(e)} aria-label="Switch the business">
          <p>
            The whole business moves to <b>{MODE_NAMES[to]}</b> from <b>{dayOfIndia(from)}, 8 am</b>
            . Riders&apos; pay from that day follows it.
          </p>
          {early > 0 && (
            <label className="banner banner--warn">
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />{' '}
              This ends the POC {early} {early === 1 ? 'day' : 'days'} early — are you sure?
            </label>
          )}
          <label className="rc-field">
            <span className="rc-field__label">Why (kept with the switch)</span>
            <input
              className="rc-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={5}
              maxLength={300}
              required
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <button
              type="submit"
              className="rc-button rc-button--primary"
              disabled={busy || reason.trim().length < 5 || (early > 0 && !sure)}
              aria-busy={busy}
            >
              Yes, switch to {MODE_NAMES[to]}
            </button>
            <button
              type="button"
              className="rc-button rc-button--quiet"
              onClick={() => setAsking(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {!b.canSwitch && (
        <p className="muted">
          {b.pocEnded
            ? 'The POC has ended: the business stays on regular business.'
            : 'Only a super admin switches the business.'}
        </p>
      )}
      {b.history.length > 0 && (
        <Fold
          title="Every switch"
          hint={`${b.history.length} ${b.history.length === 1 ? 'switch' : 'switches'}`}
        >
          <ul className="plain">
            {b.history.map((h, i) => (
              <li key={i}>
                <b>{MODE_NAMES[h.mode]}</b> from {dayOfIndia(h.from)} · by {h.setBy} on{' '}
                {dayOfIndia(h.setAt)}, {clock(h.setAt)} · {h.reason}
                {h.cancelled &&
                  ` · cancelled before it started on ${dayOfIndia(h.cancelled.at)}: ${h.cancelled.reason}`}
              </li>
            ))}
          </ul>
        </Fold>
      )}
    </section>
  );
}

export default function SettingsPageView() {
  const me = useMember();
  const [page, setPage] = useState<SettingsPage | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Partial<Record<SettingKey, string>>>({});
  const load = useCallback(() => {
    api<SettingsPage>('/settings')
      .then((p) => {
        setPage(p);
        setError('');
      })
      .catch((e: unknown) => setError(failed(e, 'Could not load the settings.')));
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);
  if (!me) return <p className="muted">Loading…</p>;
  const s = page?.settings;
  const can = page?.canChange ?? false;
  // A section starts afresh (its edits dropped) when a new version is saved.
  const common = <K extends SettingKey>(name: K) => ({
    key: `${name}:${s?.[name].version ?? 0}`,
    name,
    record: s?.[name] as SettingRecord<K>,
    canChange: can,
    saved: saved[name] ?? '',
    onSaved: (message: string) => {
      setSaved((x) => ({ ...x, [name]: message }));
      load();
    },
  });
  return (
    <Shell member={me}>
      <h1>Settings</h1>
      <p className="muted">
        {can
          ? 'Change one setting at a time and say why. Each save is a new version, kept with who and when, and shows in the audit log.'
          : 'Only a super admin changes these.'}{' '}
        Prices and rider pay rates are on the Prices page.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page && s && (
        <div className="stack">
          {page.business && <BusinessSwitchCard b={page.business} now={page.at} onSaved={load} />}
          <section className="rc-card stack" aria-label="Staff and roles">
            <h2>Staff and roles</h2>
            <p className="muted">
              Members are added, changed and switched off on the{' '}
              {me.role === 'super-admin' ? <Link href="/staff">Staff page</Link> : 'Staff page'}.
              Parts of the business:{' '}
              {page.staffAreas.map((a) => AREA_NAMES[a as Area] ?? a).join(', ')}.
            </p>
            <table className="rc-table" aria-label="Roles">
              <tbody>
                {page.roles.map((r) => (
                  <tr key={r}>
                    <th>{ROLE_NAMES[r as Role] ?? r}</th>
                    <td>{ROLE_RIGHTS[r as Role] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <Section {...common('cities')} title="Cities">
            {(v, set) => (
              <>
                <p className="muted">An area belongs to one of these. A city is never removed.</p>
                <ul>
                  {v.map((c) => (
                    <li key={c.name}>{c.name}</li>
                  ))}
                </ul>
                {can && <AddRow label="New city" onAdd={(name) => set([...v, { name }])} />}
              </>
            )}
          </Section>

          <Section {...common('fittingCentres')} title="Fitting centres">
            {(v, set) => (
              <>
                <Info label="About this setting">
                  Where screens are fitted and taken off. Slots are opened at a centre that is on. A
                  centre is never removed: switch it off.
                </Info>
                {v.length === 0 && <p className="muted">No centre yet.</p>}
                {v.map((c, i) => (
                  <CentreRow
                    key={c.name}
                    centre={c}
                    onChange={(x) => set(v.map((y, j) => (j === i ? x : y)))}
                  />
                ))}
                {can && <NewCentre onAdd={(c) => set([...v, c])} />}
              </>
            )}
          </Section>

          <Section {...common('support')} title="Support numbers and hours">
            {(v, set) => (
              <>
                <p>
                  Support is <strong>{page.supportOpen ? 'open' : 'closed'}</strong> now (India
                  time).
                </p>
                {v.phones.map((p, i) => (
                  <PhoneRow
                    key={i}
                    phone={p}
                    onChange={(x) =>
                      set({ ...v, phones: v.phones.map((y, j) => (j === i ? x : y)) })
                    }
                    onRemove={() => set({ ...v, phones: v.phones.filter((_, j) => j !== i) })}
                  />
                ))}
                {can && (
                  <button
                    className="rc-button rc-button--secondary"
                    type="button"
                    onClick={() =>
                      set({
                        ...v,
                        phones: [...v.phones, { label: '', phone: '+91', whatsapp: true }],
                      })
                    }
                  >
                    Add a number
                  </button>
                )}
                <fieldset className="areas">
                  <legend className="rc-field__label">Open on</legend>
                  {DAY_NAMES.map((d, i) => (
                    <label key={d}>
                      <input
                        type="checkbox"
                        checked={v.days.includes(i + 1)}
                        onChange={(e) =>
                          set({
                            ...v,
                            days: e.target.checked
                              ? [...v.days, i + 1].sort((a, b) => a - b)
                              : v.days.filter((x) => x !== i + 1),
                          })
                        }
                      />
                      {d}
                    </label>
                  ))}
                </fieldset>
                <div className="cal-bar">
                  <Field label="Opens (India time)">
                    <input
                      className="rc-input"
                      type="time"
                      value={v.opens}
                      onChange={(e) => set({ ...v, opens: e.target.value })}
                    />
                  </Field>
                  <Field label="Closes">
                    <input
                      className="rc-input"
                      type="time"
                      value={v.closes}
                      onChange={(e) => set({ ...v, closes: e.target.value })}
                    />
                  </Field>
                </div>
              </>
            )}
          </Section>

          <Section {...common('messages')} title="Message wording">
            {(v, set) => (
              <>
                <p className="muted">
                  WhatsApp sends only templates the provider has approved: write the approved
                  template&apos;s name here (it must take the same values, in the same order). Email
                  wording is ours; words in {'{braces}'} are filled in when sent.
                </p>
                {(
                  [
                    [
                      'supportReply',
                      'Support reply',
                      'Fills in: {reply} (needed), {subject}. WhatsApp: 1 value, the reply.',
                    ],
                    [
                      'reportReady',
                      'Campaign report ready',
                      'Fills in: {booking}, {period}, {summary}, {link} (needed). WhatsApp: 4 values: booking, period, first line of the summary, link. The email carries the report itself as designed; this wording is its subject and plain-text part.',
                    ],
                    [
                      'bookedPaid',
                      'Campaign booked and paid',
                      'Fills in: {booking}, {period}, {total}, {adsDue}, {link} (needed). WhatsApp: 4 values: booking, period, total, link.',
                    ],
                    [
                      'adsMissing',
                      'Ads missing (9 and 7 days before the start)',
                      'Fills in: {booking}, {start}, {adsDue}, {link} (needed). WhatsApp: 4 values: booking, start day, ads due, link.',
                    ],
                  ] as const
                ).map(([k, title, hint]) => (
                  <WordingFields
                    key={k}
                    title={title}
                    hint={hint}
                    value={v[k]}
                    onChange={(w) => set({ ...v, [k]: w } as MessageWordings)}
                  />
                ))}
              </>
            )}
          </Section>

          <Section {...common('pocZone')} title="Rider pay zone in the POC">
            {(v, set) => (
              <>
                <Info label="About this setting">
                  Where a rider&apos;s moving hours count for pay while the POC runs: a circle round
                  Hitech City (15 km). Sent to the screens with the POC plans; outside it the screen
                  is blank.
                </Info>
                <ZoneFields name="poc-zone" v={v} set={set} areas={page.areas} />
              </>
            )}
          </Section>

          <Section {...common('regularZone')} title="Rider pay zone in regular business">
            {(v, set) => (
              <>
                <Info label="About this setting">
                  Where a rider&apos;s moving hours count for pay in regular business: inside any
                  area that is on (not its edge zone). Outside every area nothing counts. Pick areas
                  only for an exception.
                </Info>
                <ZoneFields name="regular-zone" v={v} set={set} areas={page.areas} />
              </>
            )}
          </Section>

          <Section {...common('loanBank')} title="Screen-loan bank">
            {(v, set) => (
              <>
                <Info label="About this setting">
                  The bank that lends riders the money for a screen. The loan is between the rider
                  and the bank. Used when screen loans are recorded (rider app, P4.2.6).
                </Info>
                <Field label="Bank">
                  <input
                    className="rc-input"
                    value={v.name}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </Field>
              </>
            )}
          </Section>

          <Section {...common('riderSignIn')} title="Rider app limits">
            {(v, set) => (
              <>
                <Info label="About this setting">
                  Riders sign in with a code sent on WhatsApp or by SMS, and start their own ID,
                  agreement and bank checks. These limits stop guessing and keep costs down; each
                  message and check costs money.
                </Info>
                <div className="cal-bar">
                  {RIDER_SIGN_IN_LABELS.map(([k, label]) => (
                    <Field key={k} label={label}>
                      <input
                        className="rc-input mono"
                        type="number"
                        min={1}
                        step={1}
                        value={v[k]}
                        onChange={(e) => set({ ...v, [k]: Number(e.target.value) })}
                      />
                    </Field>
                  ))}
                </div>
              </>
            )}
          </Section>

          <Section {...common('freeWeek')} title="Free week for new businesses">
            {(v, set) => (
              <>
                <Info label="About this setting">
                  When on, the brand portal offers each new brand one free week (its days and
                  bike-hours are in the price book). One per business, phone, GST number and person.
                  Off: no free week is offered.
                </Info>
                <label>
                  <input
                    type="checkbox"
                    checked={v.on}
                    onChange={(e) => set({ on: e.target.checked })}
                  />{' '}
                  Offer the free week on the brand portal
                </label>
              </>
            )}
          </Section>

          <Section {...common('poc')} title="POC package">
            {(v, set) => (
              <>
                <Info label="About this setting">
                  While the business is on POC: the most brands in a month (each gets the
                  hour&apos;s 200 brand plays shared out: 40 brands, 5 each), the fixed fee a month
                  before GST, the most bikes with a screen, and the months the POC is planned to run
                  (its alerts and the early-end check; also a brand&apos;s longest commitment). A
                  month already added keeps the fee it was added at.
                </Info>
                <div className="cal-bar">
                  <Field label="Most brands in a month">
                    <input
                      className="rc-input"
                      type="number"
                      min={1}
                      max={200}
                      value={v.maxBrands}
                      onChange={(e) => set({ ...v, maxBrands: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Fee a month, ₹ before GST">
                    <input
                      className="rc-input"
                      type="number"
                      min={1000}
                      step={1}
                      value={v.feePaise / 100}
                      onChange={(e) =>
                        set({ ...v, feePaise: Math.round(Number(e.target.value) * 100) })
                      }
                    />
                  </Field>
                  <Field label="Most bikes">
                    <input
                      className="rc-input"
                      type="number"
                      min={1}
                      value={v.maxBikes}
                      onChange={(e) => set({ ...v, maxBikes: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Months the POC runs">
                    <input
                      className="rc-input"
                      type="number"
                      min={1}
                      max={12}
                      value={v.pocMonths}
                      onChange={(e) => set({ ...v, pocMonths: Number(e.target.value) })}
                    />
                  </Field>
                </div>
              </>
            )}
          </Section>

          <Section {...common('company')} title="Company details on invoices">
            {(v, set) => (
              <>
                <Info label="About this setting">
                  RECALL&apos;s legal name, GSTIN and address, printed on every tax invoice and
                  credit note. Until all three are filled in, invoices say they are not valid tax
                  invoices yet. Leave all three empty to clear them.
                </Info>
                <Field label="Legal name">
                  <input
                    className="rc-input"
                    value={v.legalName}
                    onChange={(e) => set({ ...v, legalName: e.target.value })}
                  />
                </Field>
                <Field label="GSTIN">
                  <input
                    className="rc-input mono"
                    value={v.gstin}
                    maxLength={20}
                    onChange={(e) => set({ ...v, gstin: noSpaces(e.target.value).toUpperCase() })}
                  />
                </Field>
                <Field label="Registered address">
                  <textarea
                    className="rc-input"
                    rows={3}
                    value={v.address}
                    onChange={(e) => set({ ...v, address: e.target.value })}
                  />
                </Field>
              </>
            )}
          </Section>

          <Section {...common('brandSignIn')} title="Brand portal limits">
            {(v, set) => (
              <>
                <Info label="About this setting">
                  Brands and agencies sign in to the brand portal with a code sent on WhatsApp, by
                  SMS or by email, and look up their GST number when they set up. These limits stop
                  guessing and keep message and lookup costs down.
                </Info>
                <div className="cal-bar">
                  {BRAND_SIGN_IN_LABELS.map(([k, label]) => (
                    <Field key={k} label={label}>
                      <input
                        className="rc-input mono"
                        type="number"
                        min={1}
                        step={1}
                        value={v[k]}
                        onChange={(e) => set({ ...v, [k]: Number(e.target.value) })}
                      />
                    </Field>
                  ))}
                </div>
              </>
            )}
          </Section>

          <section className="rc-card stack" aria-label="Outside services">
            <h2>Outside services</h2>
            <Info label="About this setting">
              Which services are connected. Their keys are kept in the secret store, never on this
              page; a new provider is plugged in by the tech team. A stand-in works on a laptop only
              and sends nothing.
            </Info>
            <table className="rc-table" aria-label="Connections">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>State</th>
                  <th>Provider</th>
                </tr>
              </thead>
              <tbody>
                {page.connections.map((c) => (
                  <tr key={c.service}>
                    <td>{c.service}</td>
                    <td>{c.state === 'on' ? 'On' : c.state === 'stand-in' ? 'Stand-in' : 'Off'}</td>
                    <td className="mono">{c.provider || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </Shell>
  );
}

function AddRow({ label, onAdd }: { readonly label: string; readonly onAdd: (v: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="cal-bar">
      <Field label={label}>
        <input className="rc-input" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <button
        className="rc-button rc-button--secondary"
        type="button"
        disabled={text.trim().length < 2}
        onClick={() => {
          onAdd(text.trim());
          setText('');
        }}
      >
        Add
      </button>
    </div>
  );
}

function CentreRow({
  centre,
  onChange,
}: {
  readonly centre: FittingCentre;
  readonly onChange: (c: FittingCentre) => void;
}) {
  return (
    <div className="cal-bar" aria-label={centre.name}>
      <strong>{centre.name}</strong>
      <Field label="Address">
        <input
          className="rc-input"
          value={centre.address}
          onChange={(e) => onChange({ ...centre, address: e.target.value })}
        />
      </Field>
      <label>
        <input
          type="checkbox"
          checked={centre.on}
          onChange={(e) => onChange({ ...centre, on: e.target.checked })}
        />{' '}
        On
      </label>
    </div>
  );
}

function NewCentre({ onAdd }: { readonly onAdd: (c: FittingCentre) => void }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  return (
    <div className="cal-bar">
      <Field label="New centre">
        <input className="rc-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Its address">
        <input className="rc-input" value={address} onChange={(e) => setAddress(e.target.value)} />
      </Field>
      <button
        className="rc-button rc-button--secondary"
        type="button"
        disabled={name.trim().length < 2 || address.trim().length < 5}
        onClick={() => {
          onAdd({ name: name.trim(), address: address.trim(), on: true });
          setName('');
          setAddress('');
        }}
      >
        Add centre
      </button>
    </div>
  );
}

function PhoneRow({
  phone,
  onChange,
  onRemove,
}: {
  readonly phone: SupportPhone;
  readonly onChange: (p: SupportPhone) => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="cal-bar">
      <Field label="For">
        <input
          className="rc-input"
          value={phone.label}
          onChange={(e) => onChange({ ...phone, label: e.target.value })}
        />
      </Field>
      <Field label="Number">
        <input
          className="rc-input mono"
          type="tel"
          value={groupMobile(phone.phone)}
          onChange={(e) =>
            onChange({ ...phone, phone: regroupMobile(e.target.value, groupMobile(phone.phone)) })
          }
        />
      </Field>
      <label>
        <input
          type="checkbox"
          checked={phone.whatsapp}
          onChange={(e) => onChange({ ...phone, whatsapp: e.target.checked })}
        />{' '}
        WhatsApp
      </label>
      <button className="rc-button rc-button--secondary" type="button" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

/** The fields of a pay zone: a circle, chosen areas, or all areas that are on (P1.7.5). */
function ZoneFields({
  name,
  v,
  set,
  areas,
}: {
  readonly name: string;
  readonly v: PayZone;
  readonly set: (z: PayZone) => void;
  readonly areas: readonly { readonly id: string; readonly name: string }[];
}) {
  return (
    <>
      <fieldset className="areas">
        <legend className="rc-field__label">Kind</legend>
        <label>
          <input
            type="radio"
            name={name}
            checked={v.kind === 'circle'}
            onChange={() =>
              set({
                kind: 'circle',
                centre: { lat: 17.4504, lng: 78.381 },
                radiusM: 15_000,
              })
            }
          />
          A circle
        </label>
        <label>
          <input
            type="radio"
            name={name}
            checked={v.kind === 'areas'}
            onChange={() => set({ kind: 'areas', areaIds: [], withEdge: true })}
          />
          Chosen areas
        </label>
        <label>
          <input
            type="radio"
            name={name}
            checked={v.kind === 'allAreas'}
            onChange={() => set({ kind: 'allAreas', withEdge: false })}
          />
          All areas that are on
        </label>
      </fieldset>
      {v.kind === 'circle' ? (
        <div className="cal-bar">
          <Field label="Centre latitude">
            <input
              className="rc-input mono"
              type="number"
              step="0.0001"
              value={v.centre.lat}
              onChange={(e) => set({ ...v, centre: { ...v.centre, lat: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Centre longitude">
            <input
              className="rc-input mono"
              type="number"
              step="0.0001"
              value={v.centre.lng}
              onChange={(e) => set({ ...v, centre: { ...v.centre, lng: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Radius (km)">
            <input
              className="rc-input mono"
              type="number"
              step="0.1"
              value={v.radiusM / 1000}
              onChange={(e) => set({ ...v, radiusM: Math.round(Number(e.target.value) * 1000) })}
            />
          </Field>
        </div>
      ) : (
        <>
          {v.kind === 'areas' && (
            <fieldset className="areas">
              <legend className="rc-field__label">Areas that count</legend>
              {areas.map((a) => (
                <label key={a.id}>
                  <input
                    type="checkbox"
                    checked={v.areaIds.includes(a.id)}
                    onChange={(e) =>
                      set({
                        ...v,
                        areaIds: e.target.checked
                          ? [...v.areaIds, a.id]
                          : v.areaIds.filter((x) => x !== a.id),
                      })
                    }
                  />
                  {a.name}
                </label>
              ))}
            </fieldset>
          )}
          <label>
            <input
              type="checkbox"
              checked={v.withEdge}
              onChange={(e) => set({ ...v, withEdge: e.target.checked })}
            />{' '}
            Their edge zones count too
          </label>
        </>
      )}
    </>
  );
}
