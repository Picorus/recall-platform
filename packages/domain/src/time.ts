// Hard rule 5: store times in UTC, show India time. India has no daylight saving: always UTC+05:30.

export const INDIA_OFFSET_MINUTES = 330;

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

export interface BusinessHours {
  /** Opening time in India minutes after midnight (08:00 → 480). */
  readonly opensAtMinute: number;
  /** Closing time in India minutes after the business day's midnight; past 1440 means the next morning (02:00 → 1560). */
  readonly closesAtMinute: number;
}

/** 08:00–02:00 India time. Will be read from versioned settings once they exist (P1). */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  opensAtMinute: 8 * 60,
  closesAtMinute: 26 * 60,
};

export interface IndiaTime {
  readonly date: string; // YYYY-MM-DD
  readonly hour: number;
  readonly minute: number;
}

function assertValid(instant: Date): void {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('Invalid date');
  }
}

function isoDate(shifted: Date): string {
  return shifted.toISOString().slice(0, 10);
}

export function toIndiaTime(instant: Date): IndiaTime {
  assertValid(instant);
  const shifted = new Date(instant.getTime() + INDIA_OFFSET_MINUTES * MINUTE_MS);
  return {
    date: isoDate(shifted),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** "2026-10-22 23:15 IST" */
export function formatIndiaTime(instant: Date): string {
  const { date, hour, minute } = toIndiaTime(instant);
  return `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST`;
}

/**
 * The business day an instant belongs to, as an India date "YYYY-MM-DD".
 * 23:00–02:00 belongs to the day it started, so 01:30 on the 23rd counts for the 22nd.
 * Returns null outside business hours (02:00–08:00 with the default hours).
 */
export function businessDayOf(
  instant: Date,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS,
): string | null {
  assertValid(instant);
  const india = toIndiaTime(instant);
  const minuteOfDay = india.hour * 60 + india.minute;
  if (
    minuteOfDay >= hours.opensAtMinute &&
    minuteOfDay < Math.min(hours.closesAtMinute, DAY_MINUTES)
  ) {
    return india.date;
  }
  if (minuteOfDay < hours.closesAtMinute - DAY_MINUTES) {
    const previous = new Date(instant.getTime() - DAY_MINUTES * MINUTE_MS);
    return toIndiaTime(previous).date;
  }
  return null;
}
