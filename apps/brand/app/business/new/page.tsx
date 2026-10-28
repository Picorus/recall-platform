'use client';
// P5.2: a business sets itself up. Its GST number is looked up first: the legal name, state and
// address on its invoices come from the GST record (shown, not typed). With no GST number, or when
// the lookup cannot be done, they are typed. Then the name shown on its campaigns, brand or agency,
// what kind of business, the email for invoices and a mobile number for WhatsApp messages.
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type BusinessForm, type GstAnswer } from '../../../lib/api';
import { groupMobile } from '../../../lib/sign-in';
import { Shell, useMe } from '../../../lib/session';

const message = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Could not reach the server. Try again.';

export default function NewBusiness() {
  const me = useMe();
  const router = useRouter();
  const [form, setForm] = useState<BusinessForm>();
  const [kind, setKind] = useState<'brand' | 'agency'>('brand');
  const [noGst, setNoGst] = useState(false);
  const [gstin, setGstin] = useState('');
  const [gst, setGst] = useState<GstAnswer>();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<BusinessForm>('/business-form')
      .then(setForm)
      .catch((e: unknown) => setError(message(e)));
  }, []);

  const lookUp = async () => {
    setBusy(true);
    setError('');
    setGst(undefined);
    try {
      const r = await api<GstAnswer>('/gst', { gstin });
      setGst(r);
      if (r.status === 'found' && name === '') setName(r.tradeName ?? r.legalName);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? '').trim();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ brandId: string }>('/business', {
        gstin: noGst ? null : gstin,
        name,
        kind,
        businessType: v('businessType'),
        invoiceEmail: v('invoiceEmail'),
        phone: v('phone'),
        ...(noGst || gst?.status === 'type-it'
          ? { legalName: v('legalName'), address: v('address') }
          : {}),
        ...(noGst ? { stateCode: v('stateCode') } : {}),
      });
      router.replace(`/business?brand=${encodeURIComponent(r.brandId)}`);
    } catch (err) {
      // The lookup ran out (the form was left open a long time): find the business again.
      if (err instanceof ApiError && err.why === 'look-up-again') setGst(undefined);
      setError(message(err));
      setBusy(false);
    }
  };

  if (!me || !form)
    return (
      <main className="narrow">
        <p className="muted">{error || 'Loading…'}</p>
      </main>
    );
  const ready = noGst || gst !== undefined;
  const signedInWithEmail = me.address.includes('@');
  return (
    <Shell me={me}>
      <form className="rc-card stack" onSubmit={submit} aria-label="Your business">
        <h1>Your business</h1>
        <p className="muted">
          We put these details on your GST invoices. You can add your team later.
        </p>
        <div className="row" role="group" aria-label="You are">
          <button
            type="button"
            className="rc-chip"
            aria-pressed={kind === 'brand'}
            onClick={() => setKind('brand')}
          >
            A brand or shop
          </button>
          <button
            type="button"
            className="rc-chip"
            aria-pressed={kind === 'agency'}
            onClick={() => setKind('agency')}
          >
            An agency (booking for brands)
          </button>
        </div>

        {!noGst && (
          <div className="stack">
            <label className="rc-field">
              <span className="rc-field__label">GST number</span>
              <input
                className="rc-input mono"
                name="gstin"
                value={gstin}
                onChange={(e) => {
                  // A GST number never has a space ("36 ABCDE 1234 F1Z5" as pasted).
                  setGstin(e.target.value.replace(/\s/g, '').toUpperCase());
                  setGst(undefined);
                }}
                placeholder="36ABCDE1234F1Z5"
                maxLength={30}
                autoComplete="off"
              />
            </label>
            {gst === undefined && (
              <button
                type="button"
                className="rc-button rc-button--secondary"
                disabled={busy || gstin.trim().length < 15}
                onClick={() => void lookUp()}
              >
                Find my business
              </button>
            )}
          </div>
        )}
        <label className="row">
          <input
            type="checkbox"
            checked={noGst}
            onChange={(e) => {
              setNoGst(e.target.checked);
              setGst(undefined);
              setError('');
            }}
          />
          My business has no GST number
        </label>

        {gst?.status === 'found' && (
          <dl className="facts" aria-label="From the GST records">
            <dt>Legal name</dt>
            <dd>{gst.legalName}</dd>
            <dt>State</dt>
            <dd>{gst.stateName ?? gst.stateCode}</dd>
            <dt>Address</dt>
            <dd>{gst.address}</dd>
          </dl>
        )}
        {gst?.status === 'type-it' && (
          <p className="muted">
            We could not read the GST records just now: type your details as on your GST
            registration.
          </p>
        )}

        {ready && (
          <>
            {(noGst || gst?.status === 'type-it') && (
              <>
                <label className="rc-field">
                  <span className="rc-field__label">Legal name</span>
                  <input className="rc-input" name="legalName" maxLength={200} required />
                </label>
                {noGst && (
                  <label className="rc-field">
                    <span className="rc-field__label">State</span>
                    <select className="rc-input" name="stateCode" defaultValue="36">
                      {form.states.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="rc-field">
                  <span className="rc-field__label">Address</span>
                  <input className="rc-input" name="address" maxLength={300} />
                </label>
              </>
            )}
            <label className="rc-field">
              <span className="rc-field__label">Business name</span>
              <input
                className="rc-input"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required
              />
              <span className="rc-field__help">Shown on your campaigns and report.</span>
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Kind of business</span>
              <select className="rc-input" name="businessType" required defaultValue="">
                <option value="" disabled>
                  Choose one
                </option>
                {form.types.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Email for invoices</span>
              <input
                className="rc-input"
                name="invoiceEmail"
                type="email"
                defaultValue={signedInWithEmail ? me.address : ''}
                required
              />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Mobile for WhatsApp messages</span>
              <input
                className="rc-input"
                name="phone"
                type="tel"
                defaultValue={signedInWithEmail ? '' : me.shown}
                onChange={(e) => {
                  // Shown grouped as typed ("98480 12345"); the API reads it again.
                  const grouped = groupMobile(e.currentTarget.value);
                  if (grouped !== e.currentTarget.value) e.currentTarget.value = grouped;
                }}
                required
              />
              <span className="rc-field__help">
                Only two messages a campaign: booked and paid, and your report.
              </span>
            </label>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {ready && (
          <button className="rc-button rc-button--primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save my business'}
          </button>
        )}
      </form>
    </Shell>
  );
}
