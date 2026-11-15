import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceNextRunAt,
  isValidScheduleHour,
  isValidTimeZone,
  nextRunAt,
} from '../src/modules/reporting/reporting.schedule';

const JAKARTA = 'Asia/Jakarta';

describe('Scheduled export instants', () => {
  it('places a daily run at the next local hour, never the instant itself', () => {
    // 2026-01-01T00:00Z is exactly 07:00 in Jakarta, so the next 07:00 run is
    // the following day: a due instant is never answered with itself.
    assert.equal(
      nextRunAt(
        new Date('2026-01-01T00:00:00.000Z'),
        'daily',
        7,
        JAKARTA,
      ).toISOString(),
      '2026-01-02T00:00:00.000Z',
    );
    // One millisecond later the same day's 08:00 run is still ahead.
    assert.equal(
      nextRunAt(
        new Date('2026-01-01T00:00:00.001Z'),
        'daily',
        8,
        JAKARTA,
      ).toISOString(),
      '2026-01-01T01:00:00.000Z',
    );
  });

  it('keeps a weekly run on the same local weekday', () => {
    // Thursday 2026-01-01 07:00 Jakarta -> Thursday 2026-01-08 07:00.
    assert.equal(
      nextRunAt(
        new Date('2026-01-01T00:00:00.000Z'),
        'weekly',
        7,
        JAKARTA,
      ).toISOString(),
      '2026-01-08T00:00:00.000Z',
    );
  });

  it('counts from the instant that was due, not from now', () => {
    // The worker was four days late: the cadence continues from the missed run
    // and the result is strictly after now, so the row is not due again.
    const now = new Date('2026-01-05T00:00:00.000Z');
    const next = advanceNextRunAt(
      now,
      new Date('2026-01-01T00:00:00.000Z'),
      'daily',
      7,
      JAKARTA,
    );
    assert.equal(next.toISOString(), '2026-01-06T00:00:00.000Z');
    assert.ok(next.getTime() > now.getTime());
  });

  it('skips every occurrence a stopped schedule missed', () => {
    const now = new Date('2026-02-01T00:00:00.000Z');
    const next = advanceNextRunAt(
      now,
      new Date('2026-01-01T00:00:00.000Z'),
      'weekly',
      7,
      JAKARTA,
    );
    assert.ok(next.getTime() > now.getTime());
    // Still the same weekday/hour as the schedule asked for.
    assert.equal(next.getUTCDay(), 4);
    assert.equal(next.toISOString().slice(11), '00:00:00.000Z');
  });

  it('stays monotonic across a DST transition instead of looping', () => {
    // America/New_York skips 02:00 and repeats 01:00 each year; the schedule
    // must still advance strictly for every day of the window.
    let cursor = new Date('2026-03-06T12:00:00.000Z');
    const seen = new Set<string>();
    for (let step = 0; step < 10; step += 1) {
      const next = nextRunAt(cursor, 'daily', 2, 'America/New_York');
      assert.ok(
        next.getTime() > cursor.getTime(),
        'the schedule stopped advancing at ' + cursor.toISOString(),
      );
      seen.add(next.toISOString());
      cursor = next;
    }
    assert.equal(seen.size, 10, 'a daily schedule repeated an instant');
  });

  it('rejects an hour that is not on a clock and a zone Intl does not know', () => {
    for (const hour of [-1, 24, 7.5, Number.NaN]) {
      assert.throws(
        () => nextRunAt(new Date(), 'daily', hour, JAKARTA),
        RangeError,
      );
    }
    assert.throws(
      () => nextRunAt(new Date(), 'daily', 7, 'Not/AZone'),
      RangeError,
    );
    assert.equal(isValidScheduleHour(0), true);
    assert.equal(isValidScheduleHour(23), true);
    assert.equal(isValidScheduleHour(24), false);
    assert.equal(isValidTimeZone('Asia/Jakarta'), true);
    assert.equal(isValidTimeZone('Not/AZone'), false);
    assert.equal(isValidTimeZone(''), false);
  });
});
