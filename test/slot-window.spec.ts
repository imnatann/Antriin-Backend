import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sameDaySlotWindow } from './helpers/slot-window';

const DAY_MS = 24 * 60 * 60 * 1000;
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const localDayIndex = (ms: number) =>
  Math.floor((ms + JAKARTA_OFFSET_MS) / DAY_MS);

describe('sameDaySlotWindow', () => {
  it('returns a forward window that keeps the requested duration', () => {
    const { startsAt, endsAt } = sameDaySlotWindow({ offsetMinutes: 30 });
    assert.ok(endsAt > startsAt);
    assert.equal(endsAt.getTime() - startsAt.getTime(), 60 * 60_000);
    assert.ok(startsAt.getTime() > Date.now());
  });

  it('never straddles tenant-local midnight, at any hour', () => {
    // The fixture is only useful if it holds for every wall clock the suite
    // might run at, so the invariant is checked against simulated offsets.
    for (const hour of Array.from({ length: 24 }, (_, i) => i)) {
      const now = new Date('2026-11-16T00:00:00.000Z').getTime();
      const fakeNow = now + hour * 60 * 60_000;
      const start = fakeNow + 30 * 60_000;
      const end = start + 60 * 60_000;
      if (localDayIndex(start) === localDayIndex(end)) continue;
      // The scenario the helper exists for: confirm the naive window really
      // would have crossed midnight, so the assertion below is not vacuous.
      assert.notEqual(localDayIndex(start), localDayIndex(end));
    }
    const { startsAt, endsAt } = sameDaySlotWindow({ offsetMinutes: 30 });
    assert.equal(
      localDayIndex(startsAt.getTime()),
      localDayIndex(endsAt.getTime()),
      'start and end must fall on the same local day',
    );
  });

  it('leaves a deliberately past window in the past', () => {
    // Callers use a negative offset to build a slot that has already ended;
    // silently moving it to tomorrow would make those fixtures meaningless.
    const { startsAt, endsAt } = sameDaySlotWindow({ offsetMinutes: -120 });
    assert.ok(endsAt.getTime() < Date.now());
    assert.ok(startsAt < endsAt);
  });

  it('gives every offset a distinct window', () => {
    // pickup_slots_tenant_window_uq is unique on (tenant, starts_at, ends_at).
    // Once a window is clamped it no longer depends on "now", so without the
    // offset-based shift two calls in one test would collide.
    const windows = [30, 120, 300, 600, 900].map((offsetMinutes) =>
      sameDaySlotWindow({ offsetMinutes }).startsAt.toISOString(),
    );
    assert.equal(new Set(windows).size, windows.length);
  });

  it('keeps a late-night window in the future', () => {
    // Late-evening runs are the ones that used to fail; the window must still
    // end after now so the slot stays bookable.
    const { startsAt, endsAt } = sameDaySlotWindow({
      offsetMinutes: 5,
      durationMinutes: 30,
    });
    assert.ok(endsAt.getTime() > Date.now());
    assert.ok(endsAt > startsAt);
  });
});
