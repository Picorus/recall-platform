'use client';
// P3.2 Today: the business day at a glance. Refreshes every minute. Each part shows only when the
// member's areas cover it (the API decides; a part it leaves out is not shown).
import { Meter } from '@recall/web-ui';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { ALERT_NAMES, clock, count, dayName, dayOfIndia, rupees, since } from '../lib/format';
import { Shell, useMember } from '../lib/session';

interface Today {
  readonly at: number;
  readonly fleet?: {
    moving: number;
    stopped: number;
    offline: number;
    atHub: number;
    total: number;
  };
  readonly hours?: {
    day: string;
    soldBikeHours: number;
    soldPlays: number;
    dueBikeHours: number;
    duePlays: number;
    deliveredBikeHours: number;
    deliveredPlays: number;
    runningBikeHours: number;
  };
  readonly makeUps?: readonly {
    makeUpId: string;
    brandId: string;
    areaId: string;
    from: number;
    until: number;
    plays: number;
    left: number;
  }[];
  readonly refunds?: {
    proposed: number;
    waiting: number;
    waitingPaise: number;
    approved: number;
    approvedPaise: number;
    rejected: number;
  };
  readonly alerts?: {
    total: number;
    list: readonly { screenId: string; bike: string | null; kind: string; since: number }[];
  };
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rc-stat">
      <span className="rc-stat__label">{label}</span>
      <span className="rc-stat__value">{value}</span>
      {note && <span className="rc-stat__note">{note}</span>}
    </div>
  );
}

const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.floor((part * 100) / whole)}%` : '–';

export default function TodayPage() {
  const member = useMember();
  const [t, setT] = useState<Today>();
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<Today>('/today')
      .then((x) => {
        setT(x);
        setError('');
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);
  useEffect(() => {
    if (!member) return;
    load();
    const every = setInterval(load, 60_000);
    return () => clearInterval(every);
  }, [member, load]);

  if (!member) return <p className="narrow muted">Loading…</p>;
  const nothing = t && !t.fleet && !t.hours && !t.makeUps && !t.refunds && !t.alerts;
  return (
    <Shell member={member}>
      <h1>Today{t?.hours ? ` · ${dayName(t.hours.day)}` : ''}</h1>
      {t && <p className="muted">Updated {clock(t.at)} India time. Refreshes every minute.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {nothing && <p>Nothing on this page is in your areas yet.</p>}

      {t?.fleet && (
        <section className="stack" aria-labelledby="bikes">
          <h2 id="bikes">Bikes now</h2>
          <div className="tiles">
            <Stat label="Moving" value={count(t.fleet.moving)} />
            <Stat label="Stopped" value={count(t.fleet.stopped)} note="online, not moving" />
            <Stat label="At hub" value={count(t.fleet.atHub)} note="not on a bike" />
            <Stat label="Offline" value={count(t.fleet.offline)} note="no contact for 5 min" />
          </div>
          <p className="muted">{count(t.fleet.total)} screens in all.</p>
        </section>
      )}

      {t?.hours && (
        <section className="stack" aria-labelledby="hours">
          <h2 id="hours">Hours sold and delivered</h2>
          <div className="tiles">
            <Stat
              label="Sold today"
              value={`${count(t.hours.soldBikeHours)} bike-hours`}
              note={`${count(t.hours.soldPlays)} plays`}
            />
            <Stat
              label="Delivered so far"
              value={`${t.hours.deliveredBikeHours} of ${count(t.hours.dueBikeHours)}`}
              note={`bike-hours over by now · ${pct(t.hours.deliveredPlays, t.hours.duePlays)} of their plays`}
            />
            <Stat
              label="Running this hour"
              value={`${count(t.hours.runningBikeHours)} bike-hours`}
            />
          </div>
          {t.hours.soldBikeHours > 0 && (
            <div className="rc-chart-card stack">
              <Meter
                label="Bike-hours over by now, of all sold today"
                value={t.hours.dueBikeHours}
                max={t.hours.soldBikeHours}
                format={count}
                note={`of ${count(t.hours.soldBikeHours)}`}
              />
              <Meter
                label="Plays delivered in those hours"
                value={t.hours.deliveredPlays}
                max={t.hours.duePlays}
                format={count}
                note={`of ${count(t.hours.duePlays)} promised`}
                tone={
                  t.hours.duePlays > 0 && t.hours.deliveredPlays < t.hours.duePlays ? 'data' : 'go'
                }
              />
            </div>
          )}
        </section>
      )}

      {t?.makeUps && (
        <section className="stack" aria-labelledby="makeups">
          <h2 id="makeups">Make-ups owed ({t.makeUps.length})</h2>
          {t.makeUps.length === 0 ? (
            <p className="muted">None owed.</p>
          ) : (
            <div className="rc-table-wrap">
              <table className="rc-table">
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th>Area</th>
                    <th>Window</th>
                    <th>Plays left</th>
                  </tr>
                </thead>
                <tbody>
                  {t.makeUps.map((m) => (
                    <tr key={m.makeUpId}>
                      <td>{m.brandId}</td>
                      <td>{m.areaId}</td>
                      <td>
                        {dayOfIndia(m.from)} {clock(m.from)}–{clock(m.until)}
                      </td>
                      <td>
                        {count(m.left)} of {count(m.plays)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {t?.refunds && (
        <section className="stack" aria-labelledby="refunds">
          <h2 id="refunds">Refunds this week</h2>
          <div className="tiles">
            <Stat
              label="Waiting for a super admin"
              value={count(t.refunds.waiting)}
              note={rupees(t.refunds.waitingPaise)}
            />
            <Stat
              label="Approved"
              value={count(t.refunds.approved)}
              note={rupees(t.refunds.approvedPaise)}
            />
            <Stat label="Rejected" value={count(t.refunds.rejected)} />
          </div>
          <p className="muted">Amounts include GST. The week starts Monday.</p>
        </section>
      )}

      {t?.alerts && (
        <section className="stack" aria-labelledby="alerts">
          <h2 id="alerts">Alerts ({count(t.alerts.total)})</h2>
          {t.alerts.total === 0 ? (
            <p className="muted">No open alerts.</p>
          ) : (
            <div className="rc-table-wrap">
              <table className="rc-table">
                <thead>
                  <tr>
                    <th>Bike</th>
                    <th>Screen</th>
                    <th>Alert</th>
                    <th>For</th>
                  </tr>
                </thead>
                <tbody>
                  {t.alerts.list.map((a) => (
                    <tr key={`${a.screenId}-${a.kind}`}>
                      <td>{a.bike ?? 'not on a bike'}</td>
                      <td className="mono">{a.screenId}</td>
                      <td>
                        <span className="rc-chip rc-chip--stop">
                          {ALERT_NAMES[a.kind] ?? a.kind}
                        </span>
                      </td>
                      <td>{since(a.since, t.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {t.alerts.total > t.alerts.list.length && (
                <p className="muted">Showing the oldest {t.alerts.list.length}.</p>
              )}
            </div>
          )}
        </section>
      )}
    </Shell>
  );
}
