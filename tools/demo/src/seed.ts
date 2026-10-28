// Fills a new, empty demo database with a made-up but consistent RECALL, through the same functions
// the real system uses: prices and areas, staff who can sign in, ten brands and an agency with their
// ads (drawn by the ad maker, approved), riders with screens fitted, and campaigns in every state:
// finished last week (with plays, money and a report), running today (plays so far), coming next week,
// waiting for payment, a staff draft and one cancelled. Times are around `now`, so whenever the demo
// starts, campaigns are running today.
import { fakeDeviceCa, type FileStore } from '@recall/adapters';
import { hashPassword, newToken, newTotpSecret, renderAd, seal, tokenHash } from '@recall/api';
import {
  acceptInvite,
  accrueRiderPay,
  addStaff,
  buildDueReports,
  closeEarnings,
  createAccount,
  createBooking,
  enrolScreen,
  fitScreen,
  markDemoCopy,
  moveBooking,
  openThread,
  noteThread,
  reviewAd,
  saveAreaVersion,
  savePriceBook,
  saveSetting,
  setBookingAds,
  setBrandContact,
  setBrandTaxProfile,
  setBusinessMode,
  setPortalMember,
  settleDue,
  uploadAd,
  accountPrint,
  preparePayoutRun,
  answerPanel,
  startFittingFromApp,
  stepRider,
  reviewRiderDocument,
  uploadRiderDocument,
  storeUpload,
} from '@recall/db';
import {
  businessDayOf,
  DEFAULT_RIDER_SIGN_IN,
  enrolmentBytes,
  launchAreas,
  lineIdOf,
  lineStartsAt,
  PRICE_BOOK_V1,
  REVIEW_CHECKLIST,
  type AreaVersion,
} from '@recall/domain';
import { fakeMaps } from '@recall/adapters';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type pg from 'pg';
import { playsFor, sendHistory, type DemoScreen } from './screens.js';
import {
  AGENCY,
  AGENCY_CLIENTS,
  AGENCY_EMAIL,
  BRAND_PHONE,
  BRANDS,
  riderOf,
  STAFF,
  STAFF_PASSWORD,
} from './world.js';

const DAY = 86_400;
const iso = (t: number) => new Date(t * 1000).toISOString();
/** India's business date `days` from `now`'s (business days run 08:00–02:00). */
const dayFrom = (now: number, days: number) =>
  businessDayOf(new Date((now + days * DAY) * 1000)) ??
  new Date((now + days * DAY + 19_800) * 1000).toISOString().slice(0, 10);

/** Runs f(0) … f(n − 1), `at` of them at a time. */
async function inChunks(n: number, at: number, f: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(at, n) }, async () => {
      while (next < n) await f(next++);
    }),
  );
}

export interface Seeded {
  /** Two-step secret of every staff member (same one for all), to show today's code. */
  readonly totpSecret: string;
  readonly screens: DemoScreen[];
  readonly areas: AreaVersion[];
  readonly counts: Record<string, number>;
}

export async function seedDemo(
  pool: pg.Pool,
  files: FileStore,
  secretKey: Buffer,
  now: number,
  o: { readonly riders: number; readonly log: (l: string) => void },
): Promise<Seeded> {
  const log = o.log;
  await markDemoCopy(pool, 'demo');
  const start = now - 60 * DAY;
  const founder = { id: 'demo', role: 'super-admin' } as const;

  // Prices, areas, the business, settings.
  log('prices, areas and settings…');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, validFrom: iso(start) }, 'founder');
  const areas = launchAreas(iso(start)).map((a) => ({ ...a, draft: false }));
  for (const a of areas) await saveAreaVersion(pool, a, 'founder');
  await setBusinessMode(pool, 'poc', founder, 'the POC is running (demo)', start);
  await saveSetting(
    pool,
    'company',
    {
      legalName: 'RECALL Media Private Limited (demo)',
      gstin: '36AABCU9603R1ZO',
      address: 'Plot 1, Hitech City Road, Madhapur, Hyderabad 500081, Telangana',
    },
    founder,
    'demo company details',
    0,
  );
  await saveSetting(
    pool,
    'fittingCentres',
    [
      { name: 'Madhapur fitting centre', address: 'Road 36, Madhapur', on: true },
      { name: 'Gachibowli fitting centre', address: 'DLF Road, Gachibowli', on: true },
    ],
    founder,
    'two centres open (demo)',
    0,
  );
  await saveSetting(
    pool,
    'support',
    {
      phones: [
        { label: 'Riders', phone: '+919000011111', whatsapp: true },
        { label: 'Brands', phone: '+919000022222', whatsapp: true },
      ],
      days: [1, 2, 3, 4, 5, 6, 7],
      opens: '10:00',
      closes: '19:00',
    },
    founder,
    'support lines (demo)',
    0,
  );

  // Staff: one password, one two-step secret (the demo desk shows today's code).
  log('staff…');
  const totpSecret = newTotpSecret();
  const staffIds: Record<string, string> = {};
  for (const s of STAFF) {
    const token = newToken();
    const nowMs = (start + DAY) * 1000;
    const m = await addStaff(pool, {
      email: s.email,
      name: s.name,
      access: s.access,
      // The first is the founder (nobody before him); the founder adds the rest.
      byId: staffIds['founder@recall.demo'] ?? 'setup',
      reason: 'demo staff',
      invite: {
        tokenHash: tokenHash(token),
        totpSealed: seal(secretKey, totpSecret),
        untilMs: nowMs + 3_600_000,
      },
      nowMs,
    });
    staffIds[s.email] = m.id;
    await acceptInvite(pool, {
      tokenHash: tokenHash(token),
      passwordHash: await hashPassword(STAFF_PASSWORD),
      totpStep: Math.floor(nowMs / 30_000),
      nowMs,
    });
  }
  const sales = `Sana (sales) (${staffIds['sales@recall.demo']})`;
  const reviewer = `Prateek (founder) (${staffIds['founder@recall.demo']})`;

  // Brands, the agency and its clients, contacts, tax details, portal access, ads.
  log('brands and ads…');
  await createAccount(
    pool,
    {
      brandId: AGENCY.brandId,
      kind: 'agency',
      details: { name: AGENCY.name, agencyId: null, referredBy: null, active: true },
      by: sales,
      reason: 'agency (demo)',
    },
    start,
  );
  await setPortalMember(
    pool,
    {
      brandId: AGENCY.brandId,
      address: AGENCY_EMAIL,
      role: 'owner',
      active: true,
      reason: 'agency owner (demo)',
      by: sales,
    },
    start + 60,
  );
  const adsOf: Record<string, string[]> = {};
  for (const [i, b] of BRANDS.entries()) {
    await createAccount(
      pool,
      {
        brandId: b.brandId,
        kind: 'brand',
        details: {
          name: b.name,
          agencyId: AGENCY_CLIENTS.includes(b.brandId) ? AGENCY.brandId : null,
          referredBy: null,
          active: true,
        },
        by: sales,
        reason: 'new client (demo)',
      },
      start + 120 + i,
    );
    await setBrandContact(
      pool,
      b.brandId,
      { phone: `+9190000${String(10001 + i).padStart(5, '0')}` },
      sales,
    );
    await setBrandTaxProfile(pool, b.brandId, { legalName: b.legalName, stateCode: '36' }, sales);
    adsOf[b.brandId] = [];
    for (const [k, ad] of b.ads.entries()) {
      const png = renderAd({ ...ad, qr: '', colour: b.colour, layout: k % 3 }, null);
      const up = await uploadAd(
        pool,
        files,
        { brandId: b.brandId, name: ad.headline.slice(0, 60), data: png, by: sales },
        start + DAY + i * 60 + k,
      );
      await reviewAd(
        pool,
        {
          adId: up.adId,
          decision: 'approved',
          reason: null,
          checklist: Object.fromEntries(REVIEW_CHECKLIST.map((c) => [c.key, true])),
          by: reviewer,
          superAdmin: true,
        },
        start + DAY + i * 60 + k + 30,
      );
      adsOf[b.brandId]?.push(up.adId);
    }
  }
  await setPortalMember(
    pool,
    {
      brandId: 'masala-chai-co',
      address: BRAND_PHONE,
      role: 'owner',
      active: true,
      reason: 'owner (demo)',
      by: sales,
    },
    start + 600,
  );

  // Riders, approved and paid by UPI; screens enrolled at the warehouse and fitted to their bikes.
  log(`${o.riders} riders and screens…`);
  const ca = fakeDeviceCa();
  // One stand-in picture for every rider's documents (the demo holds no real person's papers).
  const docPicture = renderAd(
    {
      headline: 'Document (demo)',
      offer: 'A stand-in picture',
      code: '',
      qr: '',
      colour: '#9AA4C4',
      theme: 'midnight',
      layout: 0,
    },
    null,
  );
  const yearOn = new Date((now + 365 * DAY) * 1000).toISOString().slice(0, 10);
  const screens: DemoScreen[] = [];
  const setUp = async (n: number) => {
    const r = riderOf(n);
    const at = start + 2 * DAY + n * 10;
    await pool.query(
      `INSERT INTO riders (rider_id, channel, created_by, created_at) VALUES ($1, 'admin', 'Omar (operations)', to_timestamp($2))`,
      [r.riderId, at],
    );
    await pool.query(
      `INSERT INTO rider_versions (rider_id, version, name, phone, bike_plate, rides, apps, reason, set_by, set_at)
       VALUES ($1, 1, $2, $3, $4, 'Madhapur, Gachibowli', '{swiggy,zomato}', 'joined (demo)', 'Omar (operations)', to_timestamp($5))`,
      [r.riderId, r.name, r.phone, r.plate, at],
    );
    await pool.query(
      `INSERT INTO rider_steps (rider_id, seq, status, reason, by_who, at)
       VALUES ($1, 1, 'applied', 'joined (demo)', 'Omar (operations)', to_timestamp($2)),
              ($1, 2, 'approved', 'ID, bank and agreement checked (demo)', 'Omar (operations)', to_timestamp($3))`,
      [r.riderId, at, at + 3600],
    );
    const upi = { kind: 'upi' as const, vpa: `rider${n + 1}@okdemo`, name: r.name };
    await pool.query(
      `INSERT INTO rider_checks (check_id, rider_id, kind, provider_ref, about, started_by, started_at)
       VALUES ($1, $2, 'bank', 'demo', $3, 'demo', to_timestamp($4))`,
      [
        `CHK-${(0xd0000000 + n).toString(16).toUpperCase().padStart(10, '0')}`,
        r.riderId,
        accountPrint(upi),
        at,
      ],
    );
    await pool.query(
      `INSERT INTO rider_check_results (check_id, outcome, name, at) VALUES ($1, 'passed', $2, to_timestamp($3))`,
      [`CHK-${(0xd0000000 + n).toString(16).toUpperCase().padStart(10, '0')}`, r.name, at + 60],
    );
    await pool.query(
      `INSERT INTO rider_payout_accounts (rider_id, destination, set_by) VALUES ($1, $2, 'demo')`,
      [r.riderId, JSON.stringify(upi)],
    );
    const tls = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const play = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');
    const req = {
      hardwareSerial: `RK3566-DEMO${String(n + 1).padStart(5, '0')}`,
      model: 'VendorX LED28 v1',
      tlsPublicKey: spki(tls.publicKey),
      playPublicKey: spki(play.publicKey),
      madeAt: at,
    };
    const bytes = Buffer.from(enrolmentBytes(req));
    const e = await enrolScreen(
      pool,
      ca,
      {
        ...req,
        tlsSignature: sign('sha256', bytes, tls.privateKey).toString('base64'),
        playSignature: sign('sha256', bytes, play.privateKey).toString('base64'),
      },
      'warehouse',
      at,
    );
    await fitScreen(
      pool,
      { qr: e.qr, plate: r.plate, riderId: r.riderId },
      'Omar (operations)',
      at + 7200,
    );
    const screen: DemoScreen = {
      screenId: e.screenId,
      riderId: r.riderId,
      key: play.privateKey,
      seq: 0,
      home: areas[n % areas.length]?.areaId ?? 'hyd-madhapur',
    };
    screens.push(screen);
    // The fitting check, as at the centre: started from his app, the box reports, the technician
    // confirms the test pattern was seen. His app then shows his day, not the fitting steps.
    const { commandId } = await startFittingFromApp(
      pool,
      r.riderId,
      at + 7300,
      DEFAULT_RIDER_SIGN_IN,
    );
    screen.seq += 1;
    await storeUpload(
      pool,
      screen.screenId,
      [
        {
          seq: screen.seq,
          at: at + 7400,
          report: {
            kind: 'fitting',
            id: commandId,
            at: at + 7400,
            gpsAccuracyM: 5,
            lineUp: true,
            camera: 'ok',
            batteryPct: 92,
            charging: false,
            panel: 'unknown',
          },
        },
      ],
      screen.seq,
      at + 7410,
    );
    await answerPanel(pool, r.riderId, commandId, true, at + 7450);
    // Switched on by operations: he is riding for RECALL.
    // His photo, bike registration (RC) and insurance, sent and accepted (an active rider needs them).
    for (const kind of ['photo', 'rc', 'insurance'] as const) {
      const d = await uploadRiderDocument(
        pool,
        files,
        { riderId: r.riderId, kind, data: docPicture, by: 'Omar (operations)' },
        at + 7460,
      );
      await reviewRiderDocument(
        pool,
        {
          riderId: r.riderId,
          docId: d.docId,
          decision: 'accepted',
          reason: 'clear and in date (demo)',
          expiresOn: kind === 'photo' ? null : yearOn,
          by: 'Omar (operations)',
        },
        at + 7470,
      );
    }
    await stepRider(
      pool,
      r.riderId,
      'active',
      'Omar (operations)',
      'screen fitted and checked (demo)',
      at + 7500,
    );
  };
  // A few at a time (each is a dozen steps in the database).
  await inChunks(o.riders, 10, setUp);
  screens.sort((a, b) => (a.riderId < b.riderId ? -1 : 1));

  // Campaigns. Each line: an area, a business date, an hour, bikes.
  log('campaigns…');
  const today = dayFrom(now, 0);
  type Plan = {
    id: string;
    brand: string;
    lines: { area: string; date: string; hour: number; bikes: number }[];
  };
  const hours = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const lines = (area: string, date: string, hs: number[], bikes: number) =>
    hs.map((hour) => ({ area, date, hour, bikes }));
  const plan = (id: string, brand: string, ls: Plan['lines']): Plan => ({ id, brand, lines: ls });
  const last = dayFrom(now, -9);
  const lastWeek = dayFrom(now, -6);
  const nextWeek = dayFrom(now, 6);
  const finished = [
    plan('BK-DEMO-0001', 'masala-chai-co', [
      ...lines('hyd-madhapur', last, [18, 19, 20], 20),
      ...lines('hyd-hitech-city', last, [18, 19], 15),
    ]),
    plan('BK-DEMO-0002', 'fitzone-gyms', lines('hyd-gachibowli', lastWeek, [8, 9, 19, 20], 20)),
    plan('BK-DEMO-0003', 'skillup-academy', lines('hyd-madhapur', lastWeek, [17, 18, 19, 20], 15)),
  ];
  const running = [
    plan('BK-DEMO-0011', 'masala-chai-co', lines('hyd-madhapur', today, hours(8, 23), 10)),
    plan('BK-DEMO-0012', 'zippy-grocers', [
      ...lines('hyd-kondapur', today, hours(8, 23), 10),
      ...lines('hyd-gachibowli', today, hours(8, 23), 10),
    ]),
    plan('BK-DEMO-0013', 'biryani-house', [
      ...lines('hyd-hitech-city', today, hours(12, 25), 10),
      ...lines('hyd-jubilee-hills', today, hours(19, 25), 10),
    ]),
    plan('BK-DEMO-0014', 'pearl-jewellers', lines('hyd-banjara-hills', today, hours(10, 21), 10)),
    plan('BK-DEMO-0015', 'brightsmile-dental', lines('hyd-madhapur', today, hours(9, 20), 8)),
  ];
  const upcoming = [
    plan('BK-DEMO-0021', 'lakeview-homes', lines('hyd-hitech-city', nextWeek, [9, 10, 18, 19], 25)),
    plan('BK-DEMO-0022', 'cloudnine-cafe', lines('hyd-kondapur', nextWeek, [15, 16, 17, 18], 20)),
  ];
  const toPay = plan(
    'BK-DEMO-0031',
    'quickfix-mobiles',
    lines('hyd-madhapur', dayFrom(now, 10), [11, 12, 13], 25),
  );
  const staffDraft = plan(
    'BK-DEMO-0041',
    'zippy-grocers',
    lines('hyd-banjara-hills', dayFrom(now, 14), [18, 19, 20], 30),
  );
  const cancelled = plan(
    'BK-DEMO-0051',
    'fitzone-gyms',
    lines('hyd-kondapur', dayFrom(now, 3), [8, 9, 10, 11], 20),
  );

  const book = async (p: Plan, at: number) =>
    createBooking(
      pool,
      {
        bookingId: p.id,
        brandId: p.brand,
        request: {
          lines: p.lines.map((l) => ({
            areaId: l.area,
            date: l.date,
            startHour: l.hour,
            bikes: l.bikes,
          })),
          repeatMonths: 1,
          channel: 'admin',
        },
        by: sales,
      },
      at,
    );
  const by = { by: sales, actor: 'admin' as const };
  const system = { by: 'payments', actor: 'system' as const };
  /** Booked and paid at `at`, ads chosen and approved soon after. */
  const bookAndPay = async (p: Plan, at: number) => {
    await book(p, at);
    await moveBooking(pool, p.id, 'awaiting-payment', by, at + 60);
    await moveBooking(pool, p.id, 'paid', system, at + 600);
    await setBookingAds(pool, p.id, adsOf[p.brand] ?? [], sales, at + 1200);
    await moveBooking(
      pool,
      p.id,
      'ads-approved',
      { by: reviewer, actor: 'admin' },
      at + 1500,
    ).catch(() => undefined);
  };
  for (const p of finished) await bookAndPay(p, now - 20 * DAY);
  for (const p of running) await bookAndPay(p, now - 12 * DAY);
  for (const p of upcoming) await bookAndPay(p, now - 2 * DAY);
  await book(toPay, now - DAY);
  await moveBooking(pool, toPay.id, 'awaiting-payment', by, now - DAY + 60);
  await book(staffDraft, now - 3600);
  await book(cancelled, now - 5 * DAY);
  await moveBooking(pool, cancelled.id, 'awaiting-payment', by, now - 5 * DAY + 60);
  await moveBooking(
    pool,
    cancelled.id,
    'cancelled',
    { by: sales, actor: 'admin', reason: 'brand changed plans' },
    now - 4 * DAY,
  );

  // Plays: what the screens in each area played, line by line. Finished campaigns delivered (one line
  // a little short, to show a make-up and a refund); today's lines up to the hour now.
  log('plays so far…');
  const byArea = new Map<string, DemoScreen[]>();
  for (const s of screens) byArea.set(s.home, [...(byArea.get(s.home) ?? []), s]);
  const busy = new Set<string>();
  const played: Parameters<typeof playsFor>[0][] = [];
  const deliver = (p: Plan, shortLine?: string) => {
    for (const l of p.lines) {
      const startsAt = lineStartsAt({ date: l.date, startHour: l.hour });
      if (startsAt + 3600 > now) continue; // not over yet: the live bikes play it
      const pool_ = (byArea.get(l.area) ?? []).filter(
        (s) => !busy.has(`${s.screenId}|${startsAt}`),
      );
      const lineId = lineIdOf(p.id, l.area, l.date, l.hour);
      const short = lineId === shortLine;
      for (const s of pool_.slice(0, short ? Math.floor(l.bikes * 0.8) : l.bikes)) {
        busy.add(`${s.screenId}|${startsAt}`);
        played.push({ screen: s, lineId, area: l.area, startsAt, ads: adsOf[p.brand] ?? [] });
      }
    }
  };
  const first = finished[0];
  for (const p of finished)
    deliver(p, p === first ? lineIdOf(p.id, 'hyd-hitech-city', last, 19) : undefined);
  for (const p of running) deliver(p);
  await sendHistory(pool, played.map((x) => playsFor(x)).flat(), areas, log);

  // Steps the system takes as time passes: running, done; money closed hour by hour; make-ups and
  // refunds decided; reports built for finished campaigns; riders' pay for the month so far.
  log('money, make-ups and reports…');
  for (const p of finished) {
    const firstAt = Math.min(
      ...p.lines.map((l) => lineStartsAt({ date: l.date, startHour: l.hour })),
    );
    const lastAt = Math.max(
      ...p.lines.map((l) => lineStartsAt({ date: l.date, startHour: l.hour })),
    );
    await moveBooking(pool, p.id, 'running', { by: 'system', actor: 'system' }, firstAt);
    await moveBooking(pool, p.id, 'done', { by: 'system', actor: 'system' }, lastAt + 3600);
  }
  for (const p of running) {
    const firstAt = Math.min(
      ...p.lines.map((l) => lineStartsAt({ date: l.date, startHour: l.hour })),
    );
    if (firstAt <= now)
      await moveBooking(pool, p.id, 'running', { by: 'system', actor: 'system' }, firstAt);
  }
  for (let t = now - 10 * DAY; t <= now; t += DAY) {
    await settleDue(pool, Math.min(t, now));
    await closeEarnings(pool, Math.min(t, now));
  }
  await settleDue(pool, now);
  await closeEarnings(pool, now);
  await buildDueReports(pool, fakeMaps(), now).catch((e: unknown) => log(`reports: ${String(e)}`));
  const month = new Date((now + 19_800) * 1000).toISOString().slice(0, 7);
  await accrueRiderPay(pool, month, now).catch((e: unknown) => log(`rider pay: ${String(e)}`));

  // Last Monday's rider payout run, prepared and waiting for finance to approve and send.
  const india = new Date((now + 19_800) * 1000);
  const back = (india.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate() - back),
  )
    .toISOString()
    .slice(0, 10);
  await preparePayoutRun(pool, monday, now, 'Meena (finance)').catch((e: unknown) =>
    log(`payout run: ${String(e)}`),
  );

  // A few conversations on the support desk.
  const omar = { id: staffIds['ops@recall.demo'] ?? 'demo', name: 'Omar (operations)' };
  const t1 = await openThread(
    pool,
    {
      channel: 'whatsapp',
      contact: riderOf(3).phone,
      subject: 'Screen dim in the afternoon',
      note: 'Rider says the screen looks dim in bright sun.',
    },
    omar,
    now - 5 * 3600,
  );
  await noteThread(
    pool,
    t1,
    'Asked him to send a photo; brightness is automatic, checking the sensor.',
    omar,
    now - 4 * 3600,
  );
  await openThread(
    pool,
    {
      channel: 'phone',
      contact: '+919000010003',
      subject: 'Bulk booking for Diwali',
      note: 'FitZone wants 3 areas for 2 weeks in November.',
    },
    omar,
    now - 2 * 3600,
  );

  const count = async (sql: string) =>
    Number((await pool.query<{ n: string }>(sql)).rows[0]?.n ?? 0);
  return {
    totpSecret,
    screens,
    areas,
    counts: {
      brands: BRANDS.length,
      bookings: await count('SELECT count(*) AS n FROM bookings'),
      riders: o.riders,
      plays: await count("SELECT count(*) AS n FROM plays WHERE counts <> 'no'"),
    },
  };
}
