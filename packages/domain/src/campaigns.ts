// P5.3: how a brand sees its bookings on the portal: Scheduled, Running or Done (the rulebook's
// three), plus "To pay" for a booking not yet paid and "Cancelled". Worked out from the booking's
// step and its hours, so a step the system has not moved yet never shows the wrong word.
import type { BookingState } from './booking-flow.js';

export type CampaignStage = 'to-pay' | 'scheduled' | 'running' | 'done' | 'cancelled';

export function campaignStage(
  state: BookingState,
  now: number,
  firstHourAt: number,
  lastHourEndsAt: number,
): CampaignStage {
  if (state === 'cancelled') return 'cancelled';
  if (state === 'done' || state === 'report-sent') return 'done';
  if (state === 'draft' || state === 'awaiting-payment') return 'to-pay';
  if (state === 'running') return now >= lastHourEndsAt ? 'done' : 'running';
  // Paid (ads approved or still missing): by its hours.
  if (now >= lastHourEndsAt) return 'done';
  return now >= firstHourAt ? 'running' : 'scheduled';
}

/** What the brand should know next about a campaign, in a few words (or none). */
export function campaignNote(
  state: BookingState,
  stage: CampaignStage,
  hasAds: boolean,
  reportReady: boolean,
): string | null {
  if (stage === 'to-pay') return 'Not paid yet: the hours are not held for you until it is paid';
  if (stage === 'cancelled') return null;
  if (stage === 'done') return reportReady ? 'Your report is ready' : 'Your report is on its way';
  if (state === 'ads-missing') return 'Your ads are missing: add them now';
  if (state === 'paid') return hasAds ? 'Your ads are being checked' : 'Add your ads';
  return null;
}
