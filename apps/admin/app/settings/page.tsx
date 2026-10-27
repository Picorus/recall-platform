'use client';
// P3.17 Settings: cities, fitting centres, support numbers and hours, message wording, the rider pay
// zone and the screen-loan bank; who has which role (changed on the Staff page); which outside
// services are on. Every member sees them; a super admin changes one at a time, with why. Each save
// is a new version (nothing overwritten) and shows in the audit log.
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api';
import { clock, dayOfIndia } from '../../lib/format';
import { Shell, useMember } from '../../lib/session';
import {
  DAY_NAMES,
  type FittingCentre,
  type MessageWordings,
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
  onSaved,
  children,
}: {
  readonly name: K;
  readonly title: string;
  readonly record: SettingRecord<K>;
  readonly canChange: boolean;
  readonly onSaved: () => void;
  readonly children: (value: Settings[K], set: (v: Settings[K]) => void) => ReactNode;
}) {
  const [draft, setDraft] = useState<Settings[K]>(record.value);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
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
        setDone(`Saved as version ${x.version}.`);
        form.reset();
        onSaved();
      })
      .catch((err: unknown) => {
        setDone('');
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
        {done && <p role="status">{done}</p>}
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

export default function SettingsPageView() {
  const me = useMember();
  const [page, setPage] = useState<SettingsPage | null>(null);
  const [error, setError] = useState('');
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
    onSaved: load,
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
                <p className="muted">
                  Where screens are fitted and taken off. Slots are opened at a centre that is on. A
                  centre is never removed: switch it off.
                </p>
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
                  template&apos;s name here. Email wording is ours; words in {'{braces}'} are filled
                  in when sent.
                </p>
                {(
                  [
                    ['supportReply', 'Support reply', 'Fills in: {reply} (needed), {subject}.'],
                    [
                      'reportReady',
                      'Campaign report ready',
                      'Fills in: {booking}, {period}, {summary}, {link} (needed).',
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

          <Section {...common('payZone')} title="Rider pay zone">
            {(v, set) => (
              <>
                <p className="muted">
                  Where a rider&apos;s moving hours count for pay. The POC: a circle round Hitech
                  City. After it: the areas picked here.
                </p>
                <fieldset className="areas">
                  <legend className="rc-field__label">Kind</legend>
                  <label>
                    <input
                      type="radio"
                      name="zone-kind"
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
                      name="zone-kind"
                      checked={v.kind === 'areas'}
                      onChange={() => set({ kind: 'areas', areaIds: [], withEdge: true })}
                    />
                    Areas
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
                        onChange={(e) =>
                          set({ ...v, centre: { ...v.centre, lat: Number(e.target.value) } })
                        }
                      />
                    </Field>
                    <Field label="Centre longitude">
                      <input
                        className="rc-input mono"
                        type="number"
                        step="0.0001"
                        value={v.centre.lng}
                        onChange={(e) =>
                          set({ ...v, centre: { ...v.centre, lng: Number(e.target.value) } })
                        }
                      />
                    </Field>
                    <Field label="Radius (km)">
                      <input
                        className="rc-input mono"
                        type="number"
                        step="0.1"
                        value={v.radiusM / 1000}
                        onChange={(e) =>
                          set({ ...v, radiusM: Math.round(Number(e.target.value) * 1000) })
                        }
                      />
                    </Field>
                  </div>
                ) : (
                  <>
                    <fieldset className="areas">
                      <legend className="rc-field__label">Areas that count</legend>
                      {page.areas.map((a) => (
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
            )}
          </Section>

          <Section {...common('loanBank')} title="Screen-loan bank">
            {(v, set) => (
              <>
                <p className="muted">
                  The bank that lends riders the money for a screen. The loan is between the rider
                  and the bank.
                </p>
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

          <section className="rc-card stack" aria-label="Outside services">
            <h2>Outside services</h2>
            <p className="muted">
              Which services are connected. Their keys are kept in the secret store, never on this
              page; a new provider is plugged in by the tech team. A stand-in works on a laptop only
              and sends nothing.
            </p>
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
          value={phone.phone}
          onChange={(e) => onChange({ ...phone, phone: e.target.value })}
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
