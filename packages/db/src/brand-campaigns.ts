// P5.3 in the database: a business's campaigns on the brand portal, newest first: each booking with
// its areas, days, bike-hours, plays promised, total, and where it stands (Scheduled, Running, Done,
// or To pay, Cancelled) with what comes next. A draft staff are still writing is not shown. Read
// only; nothing here is ever the brand's to change.
import { campaignNote, campaignStage, type BookingState, type CampaignStage } from '@recall/domain';
import type { Pool } from 'pg';

type Q = Pick<Pool, 'query'>;

export interface PortalCampaign {
  readonly bookingId: string;
  readonly stage: CampaignStage;
  readonly note: string | null;
  readonly trial: boolean;
  /** Area names, by name. */
  readonly areas: readonly string[];
  /** First and last India day ("YYYY-MM-DD") and how many days it plays. */
  readonly firstDay: string;
  readonly lastDay: string;
  readonly days: number;
  readonly bikeHours: number;
  readonly playsPromised: number;
  readonly totalPaise: number;
  readonly firstHourAt: number;
  readonly lastHourEndsAt: number;
}

export async function portalCampaigns(
  c: Q,
  brandId: string,
  now: number,
): Promise<PortalCampaign[]> {
  const r = await c.query<{
    booking_id: string;
    state: BookingState;
    channel: string;
    trial: boolean;
    total_paise: string;
    first_at: string;
    last_at: string;
    first_day: string;
    last_day: string;
    days: string;
    bike_hours: string;
    plays: string;
    areas: string[];
    has_ads: boolean;
    report: boolean;
  }>(
    `SELECT b.booking_id, e.state, b.channel, b.trial, b.total_paise,
            extract(epoch FROM b.first_hour_at)::bigint AS first_at,
            extract(epoch FROM b.last_hour_ends_at)::bigint AS last_at,
            l.first_day::text, l.last_day::text, l.days, l.bike_hours, l.plays, l.areas,
            coalesce(cardinality(s.ad_ids), 0) > 0 AS has_ads,
            EXISTS (SELECT 1 FROM campaign_reports cr WHERE cr.booking_id = b.booking_id) AS report
       FROM bookings b
       JOIN LATERAL (SELECT state FROM booking_events x WHERE x.booking_id = b.booking_id
                      ORDER BY seq DESC LIMIT 1) e ON true
       JOIN LATERAL (SELECT min(bl.day) AS first_day, max(bl.day) AS last_day,
                            count(DISTINCT bl.day) AS days, sum(bl.bikes) AS bike_hours,
                            sum(bl.plays) AS plays,
                            array_agg(DISTINCT av.name ORDER BY av.name) AS areas
                       FROM booking_lines bl
                       JOIN area_versions av ON av.area_id = bl.area_id AND av.version = bl.area_version
                      WHERE bl.booking_id = b.booking_id) l ON true
       LEFT JOIN LATERAL (SELECT ad_ids FROM booking_ad_sets x WHERE x.booking_id = b.booking_id
                           ORDER BY version DESC LIMIT 1) s ON true
      WHERE b.brand_id = $1 AND NOT (e.state = 'draft' AND b.channel = 'admin')
      ORDER BY b.first_hour_at DESC, b.booking_id
      LIMIT 200`,
    [brandId],
  );
  return r.rows.map((x) => {
    const first = Number(x.first_at);
    const last = Number(x.last_at);
    const stage = campaignStage(x.state, now, first, last);
    return {
      bookingId: x.booking_id,
      stage,
      note: campaignNote(x.state, stage, x.has_ads, x.report),
      trial: x.trial,
      areas: x.areas,
      firstDay: x.first_day,
      lastDay: x.last_day,
      days: Number(x.days),
      bikeHours: Number(x.bike_hours),
      playsPromised: Number(x.plays),
      totalPaise: Number(x.total_paise),
      firstHourAt: first,
      lastHourEndsAt: last,
    };
  });
}
