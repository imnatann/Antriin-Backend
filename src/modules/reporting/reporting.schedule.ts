import type { ReportSchedule } from './reporting.constants';

/**
 * When a scheduled export is due next.
 *
 * report_exports stores `schedule` and a local `schedule_hour`, plus
 * `next_run_at` (timestamptz). The hour is a wall-clock hour in the campus
 * timezone ("local hour" in the schema comment); the campus is the natural
 * authority because tenants carry no timezone of their own while campuses do
 * (campuses.timezone, default Asia/Jakarta).
 *
 * Everything here is pure and does not touch the database, so the rules are
 * testable without a clock stub: the caller passes `now`.
 */

const HOURS_PER_DAY = 24;

/**
 * Upper bound on catch-up steps. A daily schedule that was not run for years
 * would otherwise walk every missed hour; the guard keeps a broken worker from
 * spinning and falls back to counting from now.
 */
const MAX_CATCH_UP_STEPS = 1000;

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type DueSchedule = Exclude<ReportSchedule, 'manual'>;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** True when Intl can resolve the zone; report_exports stores no zone itself. */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function isValidScheduleHour(hour: unknown): hour is number {
  return (
    typeof hour === 'number' &&
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour < HOURS_PER_DAY
  );
}

/**
 * The next instant after `from` at the given local hour. A daily schedule
 * moves one calendar day, a weekly one seven: the local wall-clock hour is kept
 * across DST changes instead of adding 24h of milliseconds.
 *
 * Throws for an invalid hour or an unknown time zone; the caller turns that
 * into a stored error instead of silently picking another hour.
 */
export function nextRunAt(
  from: Date,
  schedule: DueSchedule,
  hour: number,
  timeZone: string,
): Date {
  if (!isValidScheduleHour(hour))
    throw new RangeError('schedule hour must be an integer from 0 to 23');
  if (!isValidTimeZone(timeZone))
    throw new RangeError('invalid time zone: ' + String(timeZone));

  const wall = wallClock(from, timeZone);
  const today = zonedInstant(wall.year, wall.month, wall.day, hour, timeZone);
  if (today.getTime() > from.getTime()) return today;

  const next = shiftCalendarDay(
    wall.year,
    wall.month,
    wall.day,
    schedule === 'weekly' ? 7 : 1,
  );
  return zonedInstant(next.year, next.month, next.day, hour, timeZone);
}

/**
 * The first scheduled instant strictly after `now`, counting from the instant
 * the export was actually due. Counting from `previous` keeps the cadence when
 * the worker ran late; the loop skips every occurrence a stopped worker missed
 * so a due row can never be claimed twice in a row by the same caller.
 */
export function advanceNextRunAt(
  now: Date,
  previous: Date,
  schedule: DueSchedule,
  hour: number,
  timeZone: string,
): Date {
  let candidate = nextRunAt(previous, schedule, hour, timeZone);
  let steps = 0;
  while (candidate.getTime() <= now.getTime() && steps < MAX_CATCH_UP_STEPS) {
    candidate = nextRunAt(candidate, schedule, hour, timeZone);
    steps += 1;
  }
  if (candidate.getTime() <= now.getTime())
    candidate = nextRunAt(now, schedule, hour, timeZone);
  return candidate;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  formatters.set(timeZone, created);
  return created;
}

function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % HOURS_PER_DAY,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Offset of the zone at that instant: local wall clock minus UTC. */
function offsetMs(instant: Date, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time. The offset is read twice so a
 * local time near a DST boundary resolves with the offset in force then, not
 * the offset of the guessed instant.
 */
function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour);
  const firstOffset = offsetMs(new Date(guess), timeZone);
  const instant = guess - firstOffset;
  const secondOffset = offsetMs(new Date(instant), timeZone);
  if (secondOffset === firstOffset) return new Date(instant);
  return new Date(guess - secondOffset);
}

function shiftCalendarDay(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}
