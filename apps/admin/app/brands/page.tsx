'use client';
// P3.8.1 Brands: every brand and agency account (search by name, id, phone, email or GSTIN); one
// account's page with its details and their history, contact, tax details, notes, bookings and, for
// an agency, the brands it handles. A Sales admin opens and changes accounts, contacts and notes; a
// Sales or Finance admin sets tax details. Sales, Finance and Support look. P5.1: Sales gives or
// removes a person's access to the brand portal for the account (a number or an email).
import { Info } from '@recall/web-ui';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Member } from '../../lib/api';
import { idFromName, matches, phoneText, STEP_NAMES, type AccountRow } from '../../lib/brands';
import {
  clock,
  dayOfIndia,
  groupMobile,
  noSpaces,
  regroupMobile,
  rupees,
  tidyBox,
} from '../../lib/format';
import { Shell, useMember } from '../../lib/session';
import BookingPanel from './booking-panel';
import NewBooking from './new-booking';

interface Page {
  readonly account: AccountRow;
  readonly history: readonly {
    version: number;
    name: string;
    agencyId: string | null;
    referredBy: string | null;
    active: boolean;
    reason: string;
    by: string;
    at: number;
  }[];
  readonly contact: { phone: string | null; email: string | null; by: string; at: number } | null;
  readonly tax: {
    legalName: string;
    gstin: string | null;
    stateCode: string;
    address: string;
    source: 'staff' | 'gst-record' | 'typed';
    by: string;
    at: number;
  } | null;
  readonly sameGstin: readonly { brandId: string; name: string }[];
  readonly notes: readonly { note: string; by: string; at: number }[];
  /** P5.1: who may sign in to the brand portal for this account. */
  readonly portal: readonly {
    address: string;
    role: 'owner' | 'booker';
    active: boolean;
    setBy: string;
    setAt: number;
    reason: string;
  }[];
  readonly brands: readonly { brandId: string; name: string; active: boolean }[];
  readonly bookings: readonly {
    bookingId: string;
    state: string;
    totalPaise: number;
    firstHour: number;
    trial: boolean;
  }[];
}

const isSuper = (m: Member) => m.role === 'super-admin';
const isSales = (m: Member) => isSuper(m) || (m.role === 'admin' && m.areas.includes('sales'));
const mayTax = (m: Member) => isSales(m) || (m.role === 'admin' && m.areas.includes('finance'));
const when = (s: number) => `${dayOfIndia(s)} ${clock(s)}`;
const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export default function BrandsPage() {
  const me = useMember();
  const [rows, setRows] = useState<readonly AccountRow[]>();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState('');
  // The account open now (a reload after a save must not bring back the one open before it).
  const openRef = useRef('');
  openRef.current = open;
  const [page, setPage] = useState<Page>();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [booking, setBooking] = useState('');
  const [newBooking, setNewBooking] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(() => {
    api<{ accounts: AccountRow[] }>('/brands')
      .then((r) => setRows(r.accounts))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);
  const loadOne = useCallback((id: string) => {
    if (!id) return setPage(undefined);
    api<Page>(`/brands/${id}`)
      .then((p) => {
        if (id === openRef.current) setPage(p); // an answer for an account no longer open is dropped
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);
  useEffect(() => {
    if (me) loadList();
  }, [me, loadList]);
  useEffect(() => loadOne(open), [open, loadOne]);

  const shown = useMemo(() => (rows ?? []).filter((r) => matches(r, query)), [rows, query]);
  const agencies = useMemo(
    () => (rows ?? []).filter((r) => r.kind === 'agency' && r.active),
    [rows],
  );

  if (!me) return <p className="narrow muted">Loading…</p>;

  const call = async (f: () => Promise<void>, done: string) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await f();
      setNote(done);
      loadList();
      loadOne(openRef.current);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };
  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const brandId = field(f, 'brandId');
    void call(
      async () => {
        await api('/brands', {
          brandId,
          kind: field(f, 'kind'),
          name: field(f, 'name'),
          agencyId: field(f, 'agencyId'),
          referredBy: field(f, 'referredBy'),
          reason: field(f, 'reason'),
        });
        setAdding(false);
        setNewName('');
        openRef.current = brandId;
        setOpen(brandId);
      },
      `${field(f, 'name')} added.`,
    );
  };
  const revise = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!page) return;
    const f = new FormData(e.currentTarget);
    void call(
      () =>
        api(`/brands/${page.account.brandId}`, {
          baseVersion: page.account.version,
          name: field(f, 'name'),
          agencyId: field(f, 'agencyId'),
          referredBy: field(f, 'referredBy'),
          active: f.get('active') === 'on',
          reason: field(f, 'reason'),
        }),
      'Details saved.',
    );
  };
  const contact = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!page) return;
    const f = new FormData(e.currentTarget);
    void call(
      () =>
        api(`/brands/${page.account.brandId}/contact`, {
          phone: field(f, 'phone'),
          email: field(f, 'email'),
        }),
      'Contact saved.',
    );
  };
  const portal = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!page) return;
    const f = new FormData(e.currentTarget);
    const give = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') !== 'remove';
    void call(
      () =>
        api(`/brands/${page.account.brandId}/portal`, {
          address: field(f, 'address'),
          role: field(f, 'role'),
          active: give,
          reason: field(f, 'reason'),
        }),
      give ? 'Portal access given.' : 'Portal access removed.',
    );
  };
  const tax = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!page) return;
    const f = new FormData(e.currentTarget);
    void call(
      () =>
        api(`/brands/${page.account.brandId}/tax`, {
          legalName: field(f, 'legalName'),
          gstin: field(f, 'gstin'),
          stateCode: field(f, 'stateCode'),
          address: field(f, 'address'),
          gstinChecked: f.get('gstinChecked') === 'on',
        }),
      'Tax details saved.',
    );
  };
  const addNote = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!page) return;
    const form = e.currentTarget;
    const text = field(new FormData(form), 'note');
    void call(async () => {
      await api(`/brands/${page.account.brandId}/notes`, { note: text });
      form.reset();
    }, 'Note added.');
  };
  const a = page?.account;

  return (
    <Shell member={me}>
      <h1>Brands</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      <div className="cal-bar">
        <label className="rc-field">
          <span className="rc-field__label">Search</span>
          <input
            className="rc-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, id, phone, email or GSTIN"
          />
        </label>
        {isSales(me) && (
          <button
            className="rc-button rc-button--secondary"
            type="button"
            onClick={() => setAdding(!adding)}
          >
            Add a brand or agency
          </button>
        )}
      </div>

      {adding && (
        <form className="rc-card stack" onSubmit={add} aria-label="New account">
          <h2 style={{ margin: 0 }}>New account</h2>
          <div className="tiles">
            <label className="rc-field">
              <span className="rc-field__label">Kind</span>
              <select className="rc-input" name="kind" defaultValue="brand">
                <option value="brand">Brand</option>
                <option value="agency">Agency</option>
              </select>
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Name</span>
              <input
                className="rc-input"
                name="name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                minLength={2}
                maxLength={120}
                required
              />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Id (cannot change later)</span>
              <input
                className="rc-input"
                name="brandId"
                key={idFromName(newName)}
                defaultValue={idFromName(newName)}
                pattern="[a-z0-9][a-z0-9-]*"
                onChange={tidyBox(noSpaces)}
                maxLength={64}
                required
              />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Agency (brands only)</span>
              <select className="rc-input" name="agencyId" defaultValue="">
                <option value="">None: books direct</option>
                {agencies.map((x) => (
                  <option key={x.brandId} value={x.brandId}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Referred by (app id, if any)</span>
              <input
                className="rc-input"
                name="referredBy"
                pattern="[a-z0-9][a-z0-9-]*"
                onChange={tidyBox(noSpaces)}
              />
            </label>
          </div>
          <label className="rc-field">
            <span className="rc-field__label">Why (logged)</span>
            <input className="rc-input" name="reason" minLength={3} maxLength={200} required />
          </label>
          <button className="rc-button" type="submit" disabled={busy}>
            Add
          </button>
        </form>
      )}

      <div className="rc-table-wrap">
        <table className="rc-table" aria-label="Accounts">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Agency</th>
              <th>Phone</th>
              <th>GSTIN</th>
              <th>Bookings</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.brandId}>
                <td>
                  {r.name}
                  {!r.active && <span className="muted"> (closed)</span>}
                  <div className="muted mono">{r.brandId}</div>
                </td>
                <td>{r.kind === 'agency' ? 'Agency' : 'Brand'}</td>
                <td>{r.agencyName ?? '—'}</td>
                <td>{phoneText(r.phone)}</td>
                <td className="mono">{r.gstin ?? '—'}</td>
                <td>{r.bookings}</td>
                <td>
                  <button
                    className="rc-button rc-button--quiet"
                    type="button"
                    onClick={() => setOpen(r.brandId)}
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows && shown.length === 0 && <p className="muted">No account matches.</p>}

      {page && a && (
        <section className="stack" aria-label="Account">
          <h2>
            {a.name}{' '}
            <span className="muted">
              · {a.kind === 'agency' ? 'agency' : 'brand'} · {a.brandId}
            </span>
          </h2>

          {isSales(me) && (
            <form
              className="rc-card stack"
              onSubmit={revise}
              aria-label="Details"
              key={`${a.brandId}|${a.version}`}
            >
              <h3 style={{ margin: 0 }}>Details</h3>
              <div className="tiles">
                <label className="rc-field">
                  <span className="rc-field__label">Name</span>
                  <input
                    className="rc-input"
                    name="name"
                    defaultValue={a.name}
                    minLength={2}
                    maxLength={120}
                    required
                  />
                </label>
                {a.kind === 'brand' && (
                  <label className="rc-field">
                    <span className="rc-field__label">Agency</span>
                    <select className="rc-input" name="agencyId" defaultValue={a.agencyId ?? ''}>
                      <option value="">None: books direct</option>
                      {agencies.map((x) => (
                        <option key={x.brandId} value={x.brandId}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="rc-field">
                  <span className="rc-field__label">Referred by</span>
                  <input
                    className="rc-input"
                    name="referredBy"
                    defaultValue={a.referredBy ?? ''}
                    pattern="[a-z0-9][a-z0-9-]*"
                    onChange={tidyBox(noSpaces)}
                  />
                </label>
              </div>
              <label>
                <input type="checkbox" name="active" defaultChecked={a.active} /> Open (untick to
                close the account; nothing is deleted)
              </label>
              <label className="rc-field">
                <span className="rc-field__label">Why (logged)</span>
                <input className="rc-input" name="reason" minLength={3} maxLength={200} required />
              </label>
              <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
                Save details
              </button>
            </form>
          )}

          <div className="tiles">
            <form
              className="rc-card stack"
              onSubmit={contact}
              aria-label="Contact"
              key={`c|${a.brandId}|${page.contact?.at ?? 0}`}
            >
              <h3 style={{ margin: 0 }}>Contact</h3>
              <p className="muted">Reports and messages go here.</p>
              <label className="rc-field">
                <span className="rc-field__label">Mobile (+91)</span>
                <input
                  className="rc-input"
                  name="phone"
                  type="tel"
                  defaultValue={groupMobile(page.contact?.phone ?? '')}
                  onChange={tidyBox(regroupMobile)}
                  disabled={!isSales(me)}
                />
              </label>
              <label className="rc-field">
                <span className="rc-field__label">Email</span>
                <input
                  className="rc-input"
                  name="email"
                  type="text"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  defaultValue={page.contact?.email ?? ''}
                  disabled={!isSales(me)}
                />
              </label>
              {page.contact && (
                <span className="muted">
                  Set by {page.contact.by}, {when(page.contact.at)}
                </span>
              )}
              {isSales(me) && (
                <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
                  Save contact
                </button>
              )}
            </form>

            <form
              className="rc-card stack"
              onSubmit={tax}
              aria-label="Tax details"
              key={`t|${a.brandId}|${page.tax?.at ?? 0}`}
            >
              <h3 style={{ margin: 0 }}>Tax details</h3>
              <p className="muted">Used on new invoices; invoices already made never change.</p>
              <label className="rc-field">
                <span className="rc-field__label">Legal name</span>
                <input
                  className="rc-input"
                  name="legalName"
                  defaultValue={page.tax?.legalName ?? ''}
                  disabled={!mayTax(me)}
                  required
                />
              </label>
              <label className="rc-field">
                <span className="rc-field__label">GSTIN (if registered)</span>
                <input
                  className="rc-input mono"
                  name="gstin"
                  defaultValue={page.tax?.gstin ?? ''}
                  onChange={tidyBox(noSpaces)}
                  disabled={!mayTax(me)}
                />
              </label>
              <label className="rc-field">
                <span className="rc-field__label">State code (Telangana 36)</span>
                <input
                  className="rc-input"
                  name="stateCode"
                  defaultValue={page.tax?.stateCode ?? '36'}
                  pattern="\d{2}"
                  onChange={tidyBox(noSpaces)}
                  disabled={!mayTax(me)}
                  required
                />
              </label>
              <label className="rc-field">
                <span className="rc-field__label">Address</span>
                <input
                  className="rc-input"
                  name="address"
                  defaultValue={page.tax?.address ?? ''}
                  disabled={!mayTax(me)}
                />
              </label>
              <label className="row">
                <input
                  type="checkbox"
                  name="gstinChecked"
                  defaultChecked={page.tax?.source === 'staff' && page.sameGstin.length === 0}
                  disabled={!mayTax(me)}
                />
                I checked this GST number and legal name (GST certificate or the GST records). Not
                ticked: no invoice carries it.
              </label>
              {page.tax && (
                <span className="muted">
                  Set by {page.tax.by}, {when(page.tax.at)}
                  {page.tax.source === 'gst-record' && ' · from the GST records'}
                </span>
              )}
              {page.sameGstin.length > 0 && (
                <p className="error">
                  The same GST number is on {page.sameGstin.map((x) => x.name).join(', ')}. Find out
                  which is the real business (ask for its GST certificate), then close the other
                  account or correct its tax details. No invoice carries the number until then.
                </p>
              )}
              {page.tax?.source === 'typed' && page.tax.gstin && (
                <p className="error">
                  Typed by the business, not checked against the GST records: check the GST number
                  and legal name, then save them here before the first invoice.
                </p>
              )}
              {mayTax(me) && (
                <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
                  Save tax details
                </button>
              )}
            </form>
          </div>

          {a.kind === 'agency' && (
            <section className="rc-card stack">
              <h3 style={{ margin: 0 }}>Brands it handles</h3>
              {page.brands.length === 0 ? (
                <p className="muted">None yet.</p>
              ) : (
                <ul className="plain">
                  {page.brands.map((b) => (
                    <li key={b.brandId}>
                      <button
                        className="rc-button rc-button--quiet"
                        type="button"
                        onClick={() => setOpen(b.brandId)}
                      >
                        {b.name}
                        {!b.active && ' (closed)'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="rc-card stack">
            <h3 style={{ margin: 0 }}>Bookings</h3>
            {isSales(me) && a.kind === 'brand' && a.active && (
              <button
                className="rc-button rc-button--secondary"
                type="button"
                onClick={() => setNewBooking(!newBooking)}
              >
                New booking
              </button>
            )}
            {newBooking && (
              <NewBooking
                brandId={a.brandId}
                onMade={(id) => {
                  setNewBooking(false);
                  setBooking(id);
                  setNote(`Draft booking ${id} made.`);
                  loadList();
                  loadOne(openRef.current);
                }}
              />
            )}
            {page.bookings.length === 0 ? (
              <p className="muted">None yet.</p>
            ) : (
              <div className="rc-table-wrap">
                <table className="rc-table">
                  <thead>
                    <tr>
                      <th>Booking</th>
                      <th>Step</th>
                      <th>First hour</th>
                      <th>Total with GST</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {page.bookings.map((b) => (
                      <tr key={b.bookingId}>
                        <td className="mono">
                          {b.bookingId}
                          {b.trial && ' (trial)'}
                        </td>
                        <td>{STEP_NAMES[b.state] ?? b.state}</td>
                        <td>{when(b.firstHour)}</td>
                        <td>{rupees(b.totalPaise)}</td>
                        <td>
                          <button
                            className="rc-button rc-button--quiet"
                            type="button"
                            onClick={() => setBooking(b.bookingId)}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {booking && page.bookings.some((x) => x.bookingId === booking) && (
              <BookingPanel
                key={booking}
                bookingId={booking}
                brandId={a.brandId}
                canAct={isSales(me)}
                onChange={() => {
                  loadList();
                  loadOne(openRef.current);
                }}
              />
            )}
          </section>

          <section className="rc-card stack" aria-label="Brand portal access">
            <h3 style={{ margin: 0 }}>Brand portal access</h3>
            <Info label="How this works">
              Who may sign in to the brand portal for this account, with a code to their mobile
              number or email. An owner does everything; a booker books and pays.
            </Info>
            {page.portal.length > 0 && (
              <ul className="plain">
                {page.portal.map((p) => (
                  <li key={p.address}>
                    <span className="mono">
                      {p.address.includes('@') ? p.address : phoneText(p.address)}
                    </span>{' '}
                    · {p.role === 'owner' ? 'Owner' : 'Booker'}
                    {p.active ? '' : ' · removed'}
                    <div className="muted">
                      {p.setBy}, {when(p.setAt)} · {p.reason}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {isSales(me) && (
              <form
                className="stack"
                onSubmit={portal}
                aria-label="Give or remove portal access"
                key={`p|${a.brandId}|${page.portal.length}|${page.portal.map((p) => p.setAt).join()}`}
              >
                <div className="tiles">
                  <label className="rc-field">
                    <span className="rc-field__label">Mobile number or email</span>
                    <input className="rc-input" name="address" maxLength={254} required />
                  </label>
                  <label className="rc-field">
                    <span className="rc-field__label">As</span>
                    <select className="rc-input" name="role" defaultValue="owner">
                      <option value="owner">Owner</option>
                      <option value="booker">Booker</option>
                    </select>
                  </label>
                  <label className="rc-field">
                    <span className="rc-field__label">Why (logged)</span>
                    <input
                      className="rc-input"
                      name="reason"
                      minLength={3}
                      maxLength={200}
                      required
                    />
                  </label>
                </div>
                <div className="areas">
                  <button
                    className="rc-button rc-button--secondary"
                    type="submit"
                    value="give"
                    disabled={busy}
                  >
                    Give access
                  </button>
                  <button
                    className="rc-button rc-button--quiet"
                    type="submit"
                    value="remove"
                    disabled={busy}
                  >
                    Remove access
                  </button>
                </div>
              </form>
            )}
          </section>

          <section className="rc-card stack">
            <h3 style={{ margin: 0 }}>Notes</h3>
            {isSales(me) && (
              <form className="stack" onSubmit={addNote} aria-label="New note">
                <label className="rc-field">
                  <span className="rc-field__label">Add a note</span>
                  <textarea className="rc-input" name="note" rows={2} maxLength={2000} required />
                </label>
                <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
                  Add note
                </button>
              </form>
            )}
            <ul className="plain">
              {page.notes.map((n, i) => (
                <li key={i}>
                  {n.note}
                  <div className="muted">
                    {n.by}, {when(n.at)}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="rc-card stack">
            <h3 style={{ margin: 0 }}>History</h3>
            <ul className="plain">
              {page.history.map((h) => (
                <li key={h.version}>
                  Version {h.version}: {h.name}
                  {h.agencyId ? ` · agency ${h.agencyId}` : ''}
                  {h.referredBy ? ` · referred by ${h.referredBy}` : ''}
                  {h.active ? '' : ' · closed'}
                  <div className="muted">
                    {h.by}, {when(h.at)} · {h.reason}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </section>
      )}
    </Shell>
  );
}
