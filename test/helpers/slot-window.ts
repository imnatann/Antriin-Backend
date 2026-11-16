/**
 * Builds a pickup window that is valid at any hour of the day.
 *
 * `now() + interval '30 minutes'` … `+90 minutes` is the obvious fixture, and it
 * silently breaks between 22:30 and 23:59 in the tenant timezone: the window
 * then crosses local midnight, `slotFitsWindow` rejects it because a slot may
 * not span two local days, and the suite fails with "outside operating hours"
 * although nothing in the product changed. CI runs late in the day often
 * enough that this is a recurring false alarm, so every spec building a
 * relative slot uses this helper instead of an inline interval.
 *
 * Jakarta has no DST, so a fixed +07:00 offset is exact and keeps the helper
 * dependency-free.
 */
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function localDayIndex(epochMs: number): number {
  return Math.floor((epochMs + JAKARTA_OFFSET_MS) / DAY_MS);
}

function localMidnightEpoch(dayIndex: number): number {
  return dayIndex * DAY_MS - JAKARTA_OFFSET_MS;
}

/**
 * A window starting `offsetMinutes` from now and lasting `durationMinutes`,
 * pulled back or pushed forward so it never straddles local midnight.
 */
export function sameDaySlotWindow(
  options: { offsetMinutes?: number; durationMinutes?: number } = {},
): { startsAt: Date; endsAt: Date } {
  const offsetMinutes = options.offsetMinutes ?? 30;
  const durationMinutes = options.durationMinutes ?? 60;
  const durationMs = durationMinutes * 60_000;

  let start = Date.now() + offsetMinutes * 60_000;
  let end = start + durationMs;

  let clamped = false;
  if (localDayIndex(start) !== localDayIndex(end)) {
    // End just before the current local midnight, keeping the duration.
    end = localMidnightEpoch(localDayIndex(start) + 1) - 1000;
    start = end - durationMs;
    clamped = true;
  }
  // Only a clamp may land in the past. A caller that deliberately asks for a
  // past window (a negative offset, e.g. to prove a finished slot is not
  // recommended) must keep it, so the rollover is tied to the clamp.
  if (clamped && end <= Date.now()) {
    start = localMidnightEpoch(localDayIndex(Date.now()) + 1) + 5 * 60_000;
    end = start + durationMs;
  }
  return { startsAt: new Date(start), endsAt: new Date(end) };
}
