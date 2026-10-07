'use strict';

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { decideChangeRequestCommand } = require('../netlify/lib/booking-commands');
const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
const { setSlotIndexStoreOverride, slotIndexKey } = require('../netlify/lib/slot-index');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { installFrozenBookingClock, restoreFrozenBookingClock, addIsoDays } = require('./helpers/frozen-booking-clock');

const dates = installFrozenBookingClock();
const [OLD, TARGET, SHIFT, LATER] = dates.spanStarts(4);
const OLD_NEXT = addIsoDays(OLD, 1);
const TARGET_NEXT = addIsoDays(TARGET, 1);
const CLOSED_SUNDAY = dates.futureClosedSunday();

after(() => {
  restoreFrozenBookingClock();
});

const WEEKDAY = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];

function memoryIndex(seed = []) {
  const values = new Map(seed.map((key) => [key, 'KEEP']));
  let jsonWrites = 0;
  let failAt = 0;
  return {
    down: false,
    jsonWrites: () => jsonWrites,
    keys: () => [...values.keys()],
    raw: (key) => values.get(key),
    failOnJsonWrite(n) {
      failAt = n;
      jsonWrites = 0;
    },
    async list(opts = {}) {
      if (this.down) throw new Error('index unavailable');
      const prefix = opts.prefix || '';
      const blobs = [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key }));
      if (opts.paginate) {
        return (async function* pages() { yield { blobs }; })();
      }
      return { blobs };
    },
    async setJSON(key, value) {
      jsonWrites += 1;
      if (failAt && jsonWrites === failAt && !String(key).startsWith('span-claim/')) {
        throw new Error('injected write failure');
      }
      values.set(key, JSON.stringify(value == null ? 1 : value));
      return { modified: true };
    },
    async delete(key) {
      values.delete(key);
    },
    async set(key, payload, options = {}) {
      if (options.onlyIfNew && values.has(key)) return { modified: false };
      values.set(key, typeof payload === 'string' ? payload : JSON.stringify(payload));
      return { modified: true };
    },
    async get(key, opts) {
      if (!values.has(key)) return null;
      const raw = values.get(key);
      if (opts && opts.type === 'json') {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
  };
}

function bookedKey(date, time, bookingId) {
  return slotIndexKey({
    slotDate: date,
    slotTime: time,
    state: 'booked',
    expiresAtMs: 0,
    bookingId,
  });
}

function seedSpan(bookingId, days) {
  return days.flatMap((day) => day.slots.map((time) => bookedKey(day.date, time, bookingId)));
}

function baseBooking(overrides = {}) {
  return {
    id: 'CD1-SPAN',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex@example.test',
    phone: '2015550100',
    preferredDate: OLD,
    preferredTime: '8:00 AM',
    confirmedDate: OLD,
    confirmedTime: '8:00 AM',
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    bookingVersion: 1,
    quoteVersion: 1,
    appointmentDurationMinutes: 90,
    address: '12 Harbor View',
    ledger: {
      currency: 'usd',
      approvedCents: 19000,
      settledCents: 0,
      creditedCents: 0,
      pendingCents: 0,
      entries: [],
    },
    changeRequests: [{
      requestId: 'cr_span',
      requestType: 'reschedule_request',
      status: 'pending',
      delta: { requestedDate: TARGET, requestedTime: '8:00 AM' },
    }],
    ...overrides,
  };
}

function install(record, index) {
  setBookingStoreOverride(createCasMemoryStore({ [record.id]: record }));
  setSlotIndexStoreOverride(index);
}

async function approve(id, version = 1) {
  return decideChangeRequestCommand({
    bookingId: id,
    requestId: 'cr_span',
    decision: 'approve',
    expectedBookingVersion: version,
  });
}

beforeEach(() => {
  process.env.SLOT_INDEX_READS = '1';
  setBookingStoreOverride(null);
  setSlotIndexStoreOverride(null);
});

afterEach(() => {
  process.env.SLOT_INDEX_READS = '1';
  setBookingStoreOverride(null);
  setSlotIndexStoreOverride(null);
});

describe('reschedule span occupancy', () => {
  it('moves a multi-day service, including the continuation day', async () => {
    const oldDays = [
      { date: OLD, slots: WEEKDAY.slice() },
      { date: OLD_NEXT, slots: ['8:00 AM', '10:00 AM', '12:00 PM'] },
    ];
    const newDays = [
      { date: TARGET, slots: WEEKDAY.slice() },
      { date: TARGET_NEXT, slots: ['8:00 AM', '10:00 AM', '12:00 PM'] },
    ];
    const record = baseBooking({
      appointmentDurationMinutes: 720,
      companionInterior: true,
      appointmentSchedule: { multiDay: true, extendedAppointment: true, days: oldDays },
      service: {
        vehicles: [{
          vehicleId: 'veh_span',
          category: 'cars',
          pkgId: 'ceramic_3yr',
          packageId: 'ceramic_3yr',
          tierKey: 'small',
          companionInterior: true,
          addons: [{ id: 'pethair' }],
        }],
      },
    });
    const index = memoryIndex(seedSpan(record.id, oldDays));
    install(record, index);

    const result = await approve(record.id);
    assert.equal(result.ok, true, result.error);
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.preferredTime, '8:00 AM');
    assert.equal(stored.booking.appointmentDurationMinutes, 765);
    assert.equal(stored.booking.companionInterior, true);
    assert.deepEqual(stored.booking.appointmentSchedule.days, newDays);
    assert.deepEqual(stored.booking.slotReleasePending, []);
    for (const key of seedSpan(record.id, oldDays)) assert.equal(index.raw(key), undefined);
    for (const key of seedSpan(record.id, newDays)) assert.ok(index.raw(key));
    const again = await approve(record.id);
    assert.equal(again.ok, true, again.error);
    assert.equal(again.idempotent, true);
    for (const key of seedSpan(record.id, newDays)) assert.ok(index.raw(key));
  });

  it('rejects when only the continuation day is taken and keeps the old span', async () => {
    const oldDays = [
      { date: OLD, slots: WEEKDAY.slice() },
      { date: OLD_NEXT, slots: ['8:00 AM', '10:00 AM', '12:00 PM'] },
    ];
    const record = baseBooking({
      companionInterior: true,
      appointmentSchedule: { multiDay: true, extendedAppointment: true, days: oldDays },
      service: {
        vehicles: [{
          vehicleId: 'veh_span',
          category: 'cars',
          pkgId: 'ceramic_3yr',
          packageId: 'ceramic_3yr',
          tierKey: 'small',
          companionInterior: true,
          addons: [{ id: 'pethair' }],
        }],
      },
    });
    const oldKeys = seedSpan(record.id, oldDays);
    const blocker = bookedKey(TARGET_NEXT, '12:00 PM', 'CD1-OTHER');
    const index = memoryIndex([...oldKeys, blocker]);
    install(record, index);

    const result = await approve(record.id);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'booking_slot_unavailable');
    assert.equal(index.jsonWrites(), 0);
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(stored.booking.changeRequests[0].status, 'pending');
    for (const key of oldKeys) assert.equal(index.raw(key), 'KEEP');
    assert.equal(index.raw(blocker), 'KEEP');
  });

  it('keeps the overlapping slots and another customer when the new span shifts', async () => {
    const record = baseBooking({
      preferredDate: TARGET,
      preferredTime: '8:00 AM',
      confirmedDate: TARGET,
      confirmedTime: '8:00 AM',
      appointmentDurationMinutes: 360,
      appointmentSchedule: null,
      changeRequests: [{
        requestId: 'cr_span',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: TARGET, requestedTime: '10:00 AM' },
      }],
    });
    const keep = [
      bookedKey(TARGET, '10:00 AM', record.id),
      bookedKey(TARGET, '12:00 PM', record.id),
    ];
    const release = bookedKey(TARGET, '2:00 PM', record.id);
    const oldStart = bookedKey(TARGET, '8:00 AM', record.id);
    const other = bookedKey(TARGET_NEXT, '8:00 AM', 'CD1-OTHER');
    const index = memoryIndex([oldStart, ...keep, other]);
    install(record, index);

    const result = await approve(record.id);
    assert.equal(result.ok, true, result.error);
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredTime, '10:00 AM');
    assert.equal(stored.booking.appointmentSchedule, null);
    assert.equal(stored.booking.appointmentDurationMinutes, 360);
    assert.equal(index.raw(oldStart), undefined);
    for (const key of keep) assert.equal(index.raw(key), 'KEEP');
    assert.ok(index.raw(release));
    assert.equal(index.raw(other), 'KEEP');
    assert.deepEqual(stored.booking.slotReleasePending, []);
  });

  it('rolls back a partial index write and completes on retry', async () => {
    const oldDays = [{ date: TARGET, slots: ['8:00 AM', '10:00 AM', '12:00 PM'] }];
    const newDays = [{ date: LATER, slots: ['8:00 AM', '10:00 AM', '12:00 PM'] }];
    const record = baseBooking({
      preferredDate: TARGET,
      preferredTime: '8:00 AM',
      confirmedDate: TARGET,
      confirmedTime: '8:00 AM',
      appointmentDurationMinutes: 360,
      changeRequests: [{
        requestId: 'cr_span',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: LATER, requestedTime: '8:00 AM' },
      }],
    });
    const oldKeys = seedSpan(record.id, oldDays);
    const index = memoryIndex(oldKeys);
    index.failOnJsonWrite(2);
    install(record, index);

    const failed = await approve(record.id);
    assert.equal(failed.ok, false);
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.error, 'occupancy_incomplete');
    let stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.changeRequests[0].status, 'pending');
    for (const key of oldKeys) assert.equal(index.raw(key), 'KEEP');
    for (const key of seedSpan(record.id, newDays)) assert.equal(index.raw(key), undefined);

    index.failOnJsonWrite(0);
    const retried = await approve(record.id);
    assert.equal(retried.ok, true, retried.error);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, LATER);
    assert.equal(stored.booking.preferredTime, '8:00 AM');
    for (const key of oldKeys) assert.equal(index.raw(key), undefined);
    for (const key of seedSpan(record.id, newDays)) assert.ok(index.raw(key));
    assert.deepEqual(stored.booking.slotReleasePending, []);
  });

  it('lets one of two concurrent requests take the new period', async () => {
    const target = [{ date: SHIFT, slots: WEEKDAY.slice() }];
    function contender(id, oldDate) {
      return baseBooking({
        id,
        preferredDate: oldDate,
        preferredTime: '8:00 AM',
        confirmedDate: oldDate,
        confirmedTime: '8:00 AM',
        appointmentDurationMinutes: 480,
        appointmentSchedule: {
          multiDay: false,
          extendedAppointment: true,
          days: [{ date: oldDate, slots: WEEKDAY.slice() }],
        },
        changeRequests: [{
          requestId: 'cr_span',
          requestType: 'reschedule_request',
          status: 'pending',
          delta: { requestedDate: SHIFT, requestedTime: '8:00 AM' },
        }],
      });
    }
    const first = contender('CD1-RACE-A', OLD);
    const second = contender('CD1-RACE-B', TARGET);
    const index = memoryIndex([
      ...seedSpan(first.id, [{ date: OLD, slots: WEEKDAY.slice() }]),
      ...seedSpan(second.id, [{ date: TARGET, slots: WEEKDAY.slice() }]),
    ]);
    setSlotIndexStoreOverride(index);
    setBookingStoreOverride(createCasMemoryStore({
      [first.id]: first,
      [second.id]: second,
    }));

    const [left, right] = await Promise.all([approve(first.id), approve(second.id)]);
    const results = [left, right];
    const won = results.filter((result) => result.ok);
    const lost = results.filter((result) => !result.ok);
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].statusCode, 409);
    assert.equal(lost[0].error, 'booking_slot_unavailable');
    const winnerId = won[0].booking.id;
    const loserId = winnerId === first.id ? second.id : first.id;
    const winner = await getBookingRecord(winnerId);
    const loser = await getBookingRecord(loserId);
    assert.equal(winner.booking.preferredDate, SHIFT);
    assert.notEqual(loser.booking.preferredDate, SHIFT);
    for (const key of seedSpan(winnerId, target)) assert.ok(index.raw(key));
    for (const key of seedSpan(loserId, target)) assert.equal(index.raw(key), undefined);
    for (const key of seedSpan(loserId, [{ date: loser.booking.preferredDate, slots: WEEKDAY.slice() }])) {
      assert.equal(index.raw(key), 'KEEP');
    }

    const twin = baseBooking({
      id: 'CD1-TWIN',
      appointmentDurationMinutes: 90,
      appointmentSchedule: null,
      changeRequests: [{
        requestId: 'cr_span',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: LATER, requestedTime: '10:00 AM' },
      }],
    });
    const twinOld = bookedKey(OLD, '8:00 AM', twin.id);
    const twinIndex = memoryIndex([twinOld]);
    setSlotIndexStoreOverride(twinIndex);
    setBookingStoreOverride(createCasMemoryStore({ [twin.id]: twin }));
    const raced = await Promise.all([approve(twin.id), approve(twin.id)]);
    assert.equal(raced.filter((result) => result.ok).length, 2);
    const saved = await getBookingRecord(twin.id);
    assert.equal(saved.booking.preferredDate, LATER);
    assert.equal(saved.booking.preferredTime, '10:00 AM');
    assert.equal(twinIndex.raw(twinOld), undefined);
    assert.ok(twinIndex.raw(bookedKey(LATER, '10:00 AM', twin.id)));
    assert.equal(
      twinIndex.keys().filter((key) => key.endsWith(`/${twin.id}`) && !key.startsWith('span-claim/')).length,
      1
    );
  });

  it('refuses a closed day and an index that cannot answer without writing', async () => {
    const record = baseBooking({
      changeRequests: [{
        requestId: 'cr_span',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: CLOSED_SUNDAY, requestedTime: '8:00 AM' },
      }],
    });
    const oldKey = bookedKey(record.preferredDate, record.preferredTime, record.id);
    const index = memoryIndex([oldKey]);
    install(record, index);
    const closed = await approve(record.id);
    assert.equal(closed.ok, false);
    assert.equal(closed.statusCode, 409);
    assert.equal(closed.error, 'booking_date_unavailable');
    assert.equal(index.jsonWrites(), 0);
    assert.equal(index.raw(oldKey), 'KEEP');
    let stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, OLD);

    const open = baseBooking();
    const openKey = bookedKey(open.preferredDate, open.preferredTime, open.id);
    const down = memoryIndex([openKey]);
    down.down = true;
    install(open, down);
    const unavailable = await approve(open.id);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.error, 'booking_verification_unavailable');
    assert.equal(down.jsonWrites(), 0);
    stored = await getBookingRecord(open.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(down.raw(openKey), 'KEEP');

    process.env.SLOT_INDEX_READS = '0';
    const disabledIndex = memoryIndex([openKey]);
    install(open, disabledIndex);
    const disabled = await approve(open.id);
    assert.equal(disabled.ok, false);
    assert.equal(disabled.statusCode, 503);
    assert.equal(disabled.error, 'booking_verification_unavailable');
    assert.equal(disabledIndex.jsonWrites(), 0);
    stored = await getBookingRecord(open.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(disabledIndex.raw(openKey), 'KEEP');
  });

  it('moves a one-slot service without leaving the old slot booked', async () => {
    const record = baseBooking({
      preferredDate: TARGET,
      preferredTime: '8:00 AM',
      confirmedDate: TARGET,
      confirmedTime: '8:00 AM',
      appointmentDurationMinutes: 90,
      appointmentSchedule: null,
      changeRequests: [{
        requestId: 'cr_span',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: TARGET, requestedTime: '10:00 AM' },
      }],
    });
    const oldKey = bookedKey(TARGET, '8:00 AM', record.id);
    const nextKey = bookedKey(TARGET, '10:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    install(record, index);

    const result = await approve(record.id);
    assert.equal(result.ok, true, result.error);
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredTime, '10:00 AM');
    assert.equal(stored.booking.status, 'Rescheduled');
    assert.equal(stored.booking.appointmentSchedule, null);
    assert.equal(index.raw(oldKey), undefined);
    assert.ok(index.raw(nextKey));
    const again = await approve(record.id);
    assert.equal(again.ok, true, again.error);
    assert.equal(again.idempotent, true);
    assert.ok(index.raw(nextKey));
    assert.equal(index.raw(oldKey), undefined);
  });
});
