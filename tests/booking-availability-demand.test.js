'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startFitsDemand, pickEligibleStart } = require('../netlify/lib/booking-schedule');
const { arrivalWindowForSlot } = require('../netlify/lib/arrival-windows');
const { slotIndexKey, setSlotIndexStoreOverride } = require('../netlify/lib/slot-index');

function fakeIndexStore(keys) {
  const store = new Set(keys);
  return {
    list(opts) {
      const prefix = (opts && opts.prefix) || '';
      const blobs = [...store].filter((key) => key.startsWith(prefix)).map((key) => ({ key }));
      if (opts && opts.paginate) {
        return (async function* pages() { yield { blobs }; })();
      }
      return Promise.resolve({ blobs });
    },
    setJSON() { return Promise.resolve({ modified: true }); },
    delete() { return Promise.resolve(); },
  };
}

function booked(date, time, id) {
  return slotIndexKey({ slotDate: date, slotTime: time, state: 'booked', expiresAtMs: 0, bookingId: id });
}

const WEEKDAY = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];

// Fixtures stay on 2026-09-30 and 2026-10-01. slotsForDate reads the clock
// when it decides whether those dates are still open, so the review clock is
// the afternoon of the previous Tuesday. Assertions stay the same.
const REVIEW_CLOCK_MS = Date.parse('2026-09-29T15:00:00.000Z');

function useReviewClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: REVIEW_CLOCK_MS });
}

test('12-hour interior span matches submit: only the first slot fits, and continuation occupancy blocks it', (t) => {
  useReviewClock(t);
  const open = startFitsDemand('2026-10-05', '8:00 AM', {
    durationMinutes: 720,
    companionInterior: true,
    occupancy: {},
  });
  assert.equal(open.ok, true);
  assert.equal(open.span.multiDay, true);
  assert.deepEqual(open.span.days.map((day) => day.date), ['2026-10-05', '2026-10-06']);

  const late = startFitsDemand('2026-10-05', '10:00 AM', {
    durationMinutes: 720,
    companionInterior: true,
    occupancy: {},
  });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'ceramic_duration_exceeds_day');

  const blocked = startFitsDemand('2026-10-01', '8:00 AM', {
    durationMinutes: 720,
    companionInterior: true,
    occupancy: { '2026-10-02|8:00 AM': 1 },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'booking_slot_unavailable');

  const picked = pickEligibleStart('2026-09-30', WEEKDAY, {
    durationMinutes: 720,
    companionInterior: true,
    occupancy: {
      '2026-09-30|8:00 AM': 1,
      '2026-09-30|10:00 AM': 1,
      '2026-09-30|12:00 PM': 1,
      '2026-09-30|2:00 PM': 1,
    },
  });
  assert.equal(picked.slot, null);
  assert.equal(picked.durationFailure, null);

  const morning = pickEligibleStart('2026-10-05', ['8:00 AM', '10:00 AM'], {
    durationMinutes: 720,
    companionInterior: true,
    occupancy: {},
  });
  assert.equal(morning.slot, '8:00 AM');
  assert.equal(arrivalWindowForSlot('8:00 AM'), '08:00-11:00');
  assert.equal(arrivalWindowForSlot('10:00 AM'), '10:00-13:00');
});

test('availability nearby and selection use the same span rules as submit', async (t) => {
  useReviewClock(t);
  process.env.SLOT_INDEX_READS = '1';
  const keys = [];
  for (const time of WEEKDAY) keys.push(booked('2026-09-30', time, 'CD1-SEP30-' + time));
  keys.push(booked('2026-10-02', '8:00 AM', 'CD1-OCT2-AM'));
  setSlotIndexStoreOverride(fakeIndexStore(keys));
  const { handler } = require('../netlify/functions/booking-availability');
  const demand = { durationMinutes: '720', companionInterior: '1' };

  const nearby = await handler({
    httpMethod: 'GET',
    queryStringParameters: { action: 'nearby', fromDate: '2026-09-30', limit: '8', ...demand },
  });
  const nearbyBody = JSON.parse(nearby.body);
  assert.equal(nearbyBody.ok, true);
  assert.ok(nearbyBody.openings.length > 0);
  for (const opening of nearbyBody.openings) {
    assert.notEqual(opening.preferredDate, '2026-09-30');
    assert.notEqual(opening.preferredDate, '2026-10-01');
    assert.equal(opening.preferredTime, '8:00 AM');
    assert.equal(opening.preferredArrivalWindow, '08:00-11:00');
  }

  const rejected = await handler({
    httpMethod: 'GET',
    queryStringParameters: {
      action: 'selection',
      preferredDate: '2026-09-30',
      preferredArrivalWindow: '08:00-11:00',
      ...demand,
    },
  });
  const rejectedBody = JSON.parse(rejected.body);
  assert.equal(rejectedBody.available, false);
  assert.equal(rejectedBody.error, 'booking_slot_unavailable');

  const late = await handler({
    httpMethod: 'GET',
    queryStringParameters: {
      action: 'selection',
      preferredDate: '2026-10-05',
      preferredArrivalWindow: '10:00-13:00',
      ...demand,
    },
  });
  const lateBody = JSON.parse(late.body);
  assert.equal(lateBody.available, false);
  assert.equal(lateBody.error, 'ceramic_duration_exceeds_day');

  const accepted = await handler({
    httpMethod: 'GET',
    queryStringParameters: {
      action: 'selection',
      preferredDate: '2026-10-05',
      preferredArrivalWindow: '08:00-11:00',
      ...demand,
    },
  });
  const acceptedBody = JSON.parse(accepted.body);
  assert.equal(acceptedBody.available, true);
  assert.equal(acceptedBody.preferredTime, '8:00 AM');
  assert.equal(acceptedBody.preferredArrivalWindow, '08:00-11:00');

  delete process.env.SLOT_INDEX_READS;
  setSlotIndexStoreOverride(null);
});

beforeEach(() => {
  process.env.SLOT_INDEX_READS = '1';
});

afterEach(() => {
  delete process.env.SLOT_INDEX_READS;
  setSlotIndexStoreOverride(null);
});
