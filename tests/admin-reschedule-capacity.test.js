'use strict';

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { decideChangeRequestCommand } = require('../netlify/lib/booking-commands');
const { handleAdminAction } = require('../netlify/functions/admin-ops-jobs');
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

function occupiedKeys(index, bookingId) {
  return index.keys().filter((key) => (
    key.endsWith(`/${bookingId}`)
    && key.includes('/booked/')
    && !key.startsWith('span-claim/')
  ));
}

function baseBooking(overrides = {}) {
  return {
    id: 'CD1-ADMIN-SPAN',
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
    ...overrides,
  };
}

function install(record, index) {
  setBookingStoreOverride(createCasMemoryStore({ [record.id]: record }));
  setSlotIndexStoreOverride(index);
}

function parseBody(res) {
  return JSON.parse(res.body || '{}');
}

async function reschedule(record, body) {
  return handleAdminAction({
    action: 'reschedule',
    bookingId: record.id,
    ...body,
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

describe('admin reschedule capacity authority', () => {
  it('reschedule path moves one slot and a repeated decision does not move again', async () => {
    const record = baseBooking();
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const nextKey = bookedKey(TARGET, '10:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    install(record, index);

    const first = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTimeWindow: '10:00–11:00 AM',
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(parseBody(first).idempotent, false);
    let stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.confirmedDate, TARGET);
    assert.equal(stored.booking.preferredTime, '10:00 AM');
    assert.equal(stored.booking.confirmedTimeWindow, '10:00–11:00 AM');
    assert.equal(stored.booking.rescheduledByAdmin, true);
    assert.equal(index.raw(oldKey), undefined);
    assert.ok(index.raw(nextKey));
    assert.deepEqual(stored.booking.slotReleasePending, []);
    const eventId = stored.booking.rescheduleEventId;

    const again = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTimeWindow: '10:00–11:00 AM',
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(parseBody(again).idempotent, true);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.preferredTime, '10:00 AM');
    assert.equal(stored.booking.confirmedDate, TARGET);
    assert.equal(stored.booking.rescheduleEventId, eventId);
    assert.equal(index.raw(oldKey), undefined);
    assert.deepEqual(occupiedKeys(index, record.id), [nextKey]);
  });

  it('rejects a conflict on the first slot and keeps the old span', async () => {
    const record = baseBooking();
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const taken = bookedKey(TARGET, '10:00 AM', 'CD1-OTHER');
    const index = memoryIndex([oldKey, taken]);
    install(record, index);

    const result = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTime: '10:00 AM',
    });
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(parseBody(result).error, 'booking_slot_unavailable');
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(stored.booking.confirmedDate, OLD);
    assert.equal(stored.booking.status, 'Confirmed');
    assert.equal(index.raw(oldKey), 'KEEP');
    assert.equal(index.raw(taken), 'KEEP');
    assert.equal(index.raw(bookedKey(TARGET, '10:00 AM', record.id)), undefined);
    assert.equal(index.jsonWrites(), 0);
  });

  it('rejects a continuation-slot conflict and keeps the old span', async () => {
    const record = baseBooking({ appointmentDurationMinutes: 360 });
    const oldDays = [{ date: OLD, slots: ['8:00 AM', '10:00 AM', '12:00 PM'] }];
    const oldKeys = seedSpan(record.id, oldDays);
    const blocker = bookedKey(TARGET, '12:00 PM', 'CD1-OTHER');
    const index = memoryIndex([...oldKeys, blocker]);
    install(record, index);

    const result = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTime: '8:00 AM',
    });
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(parseBody(result).error, 'booking_slot_unavailable');
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(stored.booking.appointmentDurationMinutes, 360);
    for (const key of oldKeys) assert.equal(index.raw(key), 'KEEP');
    assert.equal(index.raw(blocker), 'KEEP');
    assert.equal(index.jsonWrites(), 0);
  });

  it('moves a multi-day span, including the continuation day', async () => {
    const oldDays = [
      { date: OLD, slots: WEEKDAY.slice() },
      { date: OLD_NEXT, slots: ['8:00 AM', '10:00 AM', '12:00 PM'] },
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
    const oldKeys = seedSpan(record.id, oldDays);
    const index = memoryIndex(oldKeys);
    install(record, index);

    const result = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTime: '8:00 AM',
    });
    assert.equal(result.statusCode, 200, result.body);
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.preferredTime, '8:00 AM');
    assert.equal(stored.booking.appointmentSchedule.multiDay, true);
    assert.ok(stored.booking.appointmentSchedule.days.length >= 2);
    assert.equal(stored.booking.appointmentSchedule.days[0].date, TARGET);
    assert.equal(stored.booking.slotReleasePending.length, 0);
    for (const key of oldKeys) assert.equal(index.raw(key), undefined);
    for (const day of stored.booking.appointmentSchedule.days) {
      for (const time of day.slots) assert.ok(index.raw(bookedKey(day.date, time, record.id)));
    }
    assert.ok(stored.booking.appointmentSchedule.days.some((day) => day.date === TARGET_NEXT));
  });

  it('lets one of two concurrent approvals take the slot and keeps a single span', async () => {
    const targetDays = [{ date: SHIFT, slots: WEEKDAY.slice() }];
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

    const [left, right] = await Promise.all([
      reschedule(first, { confirmedDate: SHIFT, confirmedTime: '8:00 AM' }),
      reschedule(second, { confirmedDate: SHIFT, confirmedTime: '8:00 AM' }),
    ]);
    const results = [left, right].map((res) => ({ statusCode: res.statusCode, ...parseBody(res) }));
    const won = results.filter((result) => result.ok);
    const lost = results.filter((result) => !result.ok);
    assert.equal(won.length, 1, JSON.stringify(results));
    assert.equal(lost.length, 1);
    assert.equal(lost[0].statusCode, 409);
    assert.equal(lost[0].error, 'booking_slot_unavailable');
    const winnerId = won[0].bookingId;
    const loserId = winnerId === first.id ? second.id : first.id;
    const winner = await getBookingRecord(winnerId);
    const loser = await getBookingRecord(loserId);
    assert.equal(winner.booking.preferredDate, SHIFT);
    assert.notEqual(loser.booking.preferredDate, SHIFT);
    for (const key of seedSpan(winnerId, targetDays)) assert.ok(index.raw(key));
    for (const key of seedSpan(loserId, targetDays)) assert.equal(index.raw(key), undefined);
    for (const key of seedSpan(loserId, [{ date: loser.booking.preferredDate, slots: WEEKDAY.slice() }])) {
      assert.equal(index.raw(key), 'KEEP');
    }

    const twin = baseBooking({ id: 'CD1-TWIN', appointmentDurationMinutes: 90 });
    const twinOld = bookedKey(OLD, '8:00 AM', twin.id);
    const twinNext = bookedKey(LATER, '10:00 AM', twin.id);
    const twinIndex = memoryIndex([twinOld]);
    setSlotIndexStoreOverride(twinIndex);
    setBookingStoreOverride(createCasMemoryStore({ [twin.id]: twin }));
    const raced = await Promise.all([
      reschedule(twin, { confirmedDate: LATER, confirmedTime: '10:00 AM' }),
      reschedule(twin, { confirmedDate: LATER, confirmedTime: '10:00 AM' }),
    ]);
    assert.equal(raced.filter((res) => res.statusCode === 200).length, 2, raced.map((res) => res.body).join('\n'));
    const saved = await getBookingRecord(twin.id);
    assert.equal(saved.booking.preferredDate, LATER);
    assert.equal(saved.booking.preferredTime, '10:00 AM');
    assert.equal(twinIndex.raw(twinOld), undefined);
    assert.ok(twinIndex.raw(twinNext));
    assert.equal(occupiedKeys(twinIndex, twin.id).length, 1);

    const split = baseBooking({ id: 'CD1-SPLIT', appointmentDurationMinutes: 90 });
    const splitOld = bookedKey(OLD, '8:00 AM', split.id);
    const splitIndex = memoryIndex([splitOld]);
    setSlotIndexStoreOverride(splitIndex);
    setBookingStoreOverride(createCasMemoryStore({ [split.id]: split }));
    const splitRace = await Promise.all([
      reschedule(split, { confirmedDate: TARGET, confirmedTime: '8:00 AM' }),
      reschedule(split, { confirmedDate: SHIFT, confirmedTime: '10:00 AM' }),
    ]);
    const splitBodies = splitRace.map((res) => ({ statusCode: res.statusCode, ...parseBody(res) }));
    const splitWon = splitBodies.filter((result) => result.ok);
    const splitLost = splitBodies.filter((result) => !result.ok);
    assert.equal(splitWon.length, 1, JSON.stringify(splitBodies));
    assert.equal(splitLost.length, 1);
    assert.equal(splitLost[0].statusCode, 409);
    assert.equal(splitLost[0].error, 'version_conflict');
    const splitStored = await getBookingRecord(split.id);
    assert.equal(splitStored.booking.preferredDate, splitWon[0].confirmedDate);
    assert.equal(splitIndex.raw(splitOld), undefined);
    const winnerKey = bookedKey(
      splitStored.booking.preferredDate,
      splitStored.booking.preferredTime,
      split.id
    );
    assert.deepEqual(occupiedKeys(splitIndex, split.id), [winnerKey]);
  });

  it('retries after a partial index write and after a commit that throws', async () => {
    const record = baseBooking({ appointmentDurationMinutes: 360 });
    const oldDays = [{ date: OLD, slots: ['8:00 AM', '10:00 AM', '12:00 PM'] }];
    const newDays = [{ date: TARGET, slots: ['8:00 AM', '10:00 AM', '12:00 PM'] }];
    const oldKeys = seedSpan(record.id, oldDays);
    const index = memoryIndex(oldKeys);
    index.failOnJsonWrite(2);
    install(record, index);

    const failed = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTime: '8:00 AM',
    });
    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(parseBody(failed).error, 'occupancy_incomplete');
    let stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, OLD);
    for (const key of oldKeys) assert.equal(index.raw(key), 'KEEP');
    for (const key of seedSpan(record.id, newDays)) assert.equal(index.raw(key), undefined);

    index.failOnJsonWrite(0);
    const retried = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTime: '8:00 AM',
    });
    assert.equal(retried.statusCode, 200, retried.body);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    for (const key of oldKeys) assert.equal(index.raw(key), undefined);
    for (const key of seedSpan(record.id, newDays)) assert.ok(index.raw(key));
    assert.deepEqual(stored.booking.slotReleasePending, []);

    const thrown = baseBooking({ id: 'CD1-THROW', appointmentDurationMinutes: 90 });
    const thrownOld = bookedKey(OLD, '8:00 AM', thrown.id);
    const thrownNext = bookedKey(LATER, '10:00 AM', thrown.id);
    const thrownIndex = memoryIndex([thrownOld]);
    const store = createCasMemoryStore({ [thrown.id]: thrown });
    const originalSet = store.setJSON.bind(store);
    let injected = false;
    store.setJSON = async (key, value, options) => {
      if (!injected && key === thrown.id) {
        injected = true;
        throw new Error('injected commit failure');
      }
      return originalSet(key, value, options);
    };
    setBookingStoreOverride(store);
    setSlotIndexStoreOverride(thrownIndex);
    const blew = await reschedule(thrown, {
      confirmedDate: LATER,
      confirmedTime: '10:00 AM',
    });
    assert.equal(blew.statusCode, 409, blew.body);
    assert.equal(parseBody(blew).error, 'write_outcome_unknown');
    stored = await getBookingRecord(thrown.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(thrownIndex.raw(thrownOld), 'KEEP');
    assert.equal(thrownIndex.raw(thrownNext), undefined);

    store.setJSON = originalSet;
    const afterThrow = await reschedule(thrown, {
      confirmedDate: LATER,
      confirmedTime: '10:00 AM',
    });
    assert.equal(afterThrow.statusCode, 200, afterThrow.body);
    stored = await getBookingRecord(thrown.id);
    assert.equal(stored.booking.preferredDate, LATER);
    assert.equal(thrownIndex.raw(thrownOld), undefined);
    assert.ok(thrownIndex.raw(thrownNext));
  });

  it('finishes a release that failed without moving the appointment again', async () => {
    const record = baseBooking();
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const nextKey = bookedKey(TARGET, '10:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    let failRelease = true;
    const originalDelete = index.delete.bind(index);
    index.delete = async (key) => {
      if (failRelease && String(key).includes('/booked/')) {
        failRelease = false;
        throw new Error('release failed');
      }
      return originalDelete(key);
    };
    install(record, index);

    const failed = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTimeWindow: '10:00–11:00 AM',
    });
    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(parseBody(failed).error, 'occupancy_incomplete');
    let stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.preferredTime, '10:00 AM');
    assert.ok(stored.booking.slotReleasePending.length > 0);
    assert.equal(index.raw(oldKey), 'KEEP');
    assert.ok(index.raw(nextKey));

    const retried = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTimeWindow: '10:00–11:00 AM',
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(parseBody(retried).idempotent, true);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.preferredTime, '10:00 AM');
    assert.deepEqual(stored.booking.slotReleasePending, []);
    assert.equal(index.raw(oldKey), undefined);
    assert.ok(index.raw(nextKey));
    assert.equal(occupiedKeys(index, record.id).length, 1);
  });

  it('refuses a closed day, an unknown window, and an index that cannot answer', async () => {
    const record = baseBooking();
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    install(record, index);

    const closed = await reschedule(record, {
      confirmedDate: CLOSED_SUNDAY,
      confirmedTime: '8:00 AM',
    });
    assert.equal(closed.statusCode, 409, closed.body);
    assert.equal(parseBody(closed).error, 'booking_date_unavailable');
    assert.equal(index.jsonWrites(), 0);
    assert.equal(index.raw(oldKey), 'KEEP');
    let stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, OLD);

    const unknown = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTimeWindow: '11:00–12:00 PM',
    });
    assert.equal(unknown.statusCode, 409, unknown.body);
    assert.equal(parseBody(unknown).error, 'booking_time_unavailable');
    assert.equal(index.jsonWrites(), 0);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(stored.booking.confirmedTime, '8:00 AM');

    const down = memoryIndex([oldKey]);
    down.down = true;
    install(record, down);
    const unavailable = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTime: '10:00 AM',
    });
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.equal(parseBody(unavailable).error, 'booking_verification_unavailable');
    assert.equal(down.jsonWrites(), 0);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(down.raw(oldKey), 'KEEP');

    process.env.SLOT_INDEX_READS = '0';
    const disabledIndex = memoryIndex([oldKey]);
    install(record, disabledIndex);
    const disabled = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTime: '10:00 AM',
    });
    assert.equal(disabled.statusCode, 503, disabled.body);
    assert.equal(parseBody(disabled).error, 'booking_verification_unavailable');
    assert.equal(disabledIndex.jsonWrites(), 0);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(disabledIndex.raw(oldKey), 'KEEP');
  });

  it('apply_customer_request uses the same authority and does not apply twice', async () => {
    const blocked = baseBooking({
      id: 'CD1-APPLY-BLOCK',
      rescheduledByClient: true,
      rescheduleRequestedDate: TARGET,
      rescheduleRequestedTime: '10:00–11:00 AM',
    });
    const oldKey = bookedKey(OLD, '8:00 AM', blocked.id);
    const taken = bookedKey(TARGET, '10:00 AM', 'CD1-OTHER');
    const blockedIndex = memoryIndex([oldKey, taken]);
    install(blocked, blockedIndex);
    const denied = await handleAdminAction({
      action: 'apply_customer_request',
      bookingId: blocked.id,
      requestType: 'reschedule',
    });
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(parseBody(denied).error, 'booking_slot_unavailable');
    let stored = await getBookingRecord(blocked.id);
    assert.equal(stored.booking.preferredDate, OLD);
    assert.equal(stored.booking.rescheduledByClient, true);
    assert.equal(blockedIndex.raw(oldKey), 'KEEP');
    assert.equal(blockedIndex.jsonWrites(), 0);

    const record = baseBooking({
      id: 'CD1-APPLY-OK',
      rescheduledByClient: true,
      rescheduleRequestedDate: TARGET,
      rescheduleRequestedTime: '10:00–11:00 AM',
    });
    const applyOld = bookedKey(OLD, '8:00 AM', record.id);
    const applyNext = bookedKey(TARGET, '10:00 AM', record.id);
    const index = memoryIndex([applyOld]);
    install(record, index);
    const applied = await handleAdminAction({
      action: 'apply_customer_request',
      bookingId: record.id,
      requestType: 'reschedule',
    });
    assert.equal(applied.statusCode, 200, applied.body);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.preferredTime, '10:00 AM');
    assert.equal(stored.booking.rescheduledByClient, false);
    assert.ok(stored.booking.rescheduleRequestAppliedAt);
    assert.equal(index.raw(applyOld), undefined);
    assert.ok(index.raw(applyNext));
    const appliedVersion = stored.booking.bookingVersion;

    const retry = await handleAdminAction({
      action: 'apply_customer_request',
      bookingId: record.id,
      requestType: 'reschedule',
    });
    assert.equal(retry.statusCode, 400, retry.body);
    assert.equal(parseBody(retry).error, 'no_pending_customer_request');
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.bookingVersion, appliedVersion);
    assert.deepEqual(occupiedKeys(index, record.id), [applyNext]);
  });

  it('apply_customer_request finishes a failed release without moving again', async () => {
    const record = baseBooking({
      id: 'CD1-APPLY-RELEASE',
      rescheduledByClient: true,
      rescheduleRequestedDate: TARGET,
      rescheduleRequestedTime: '10:00 AM',
    });
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const nextKey = bookedKey(TARGET, '10:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    let failRelease = true;
    const originalDelete = index.delete.bind(index);
    index.delete = async (key) => {
      if (failRelease && String(key).includes('/booked/')) {
        failRelease = false;
        throw new Error('release failed');
      }
      return originalDelete(key);
    };
    install(record, index);

    const failed = await handleAdminAction({
      action: 'apply_customer_request',
      bookingId: record.id,
      requestType: 'reschedule',
    });
    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(parseBody(failed).error, 'occupancy_incomplete');
    let stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.rescheduledByClient, false);
    assert.ok(stored.booking.slotReleasePending.length > 0);
    assert.equal(index.raw(oldKey), 'KEEP');
    assert.ok(index.raw(nextKey));

    const retried = await handleAdminAction({
      action: 'apply_customer_request',
      bookingId: record.id,
      requestType: 'reschedule',
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(parseBody(retried).idempotent, true);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.preferredTime, '10:00 AM');
    assert.deepEqual(stored.booking.slotReleasePending, []);
    assert.equal(index.raw(oldKey), undefined);
    assert.ok(index.raw(nextKey));
    assert.equal(occupiedKeys(index, record.id).length, 1);
  });

  it('canonical change-request approval still relocates once', async () => {
    const record = baseBooking({
      id: 'CD1-CANON',
      changeRequests: [{
        requestId: 'cr_span',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: TARGET, requestedTime: '10:00 AM' },
      }],
    });
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const nextKey = bookedKey(TARGET, '10:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    install(record, index);

    const first = await decideChangeRequestCommand({
      bookingId: record.id,
      requestId: 'cr_span',
      decision: 'approve',
      expectedBookingVersion: 1,
    });
    assert.equal(first.ok, true, first.error);
    assert.notEqual(first.idempotent, true);
    let stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.equal(stored.booking.preferredTime, '10:00 AM');
    assert.equal(index.raw(oldKey), undefined);
    assert.ok(index.raw(nextKey));

    const again = await decideChangeRequestCommand({
      bookingId: record.id,
      requestId: 'cr_span',
      decision: 'approve',
      expectedBookingVersion: stored.booking.bookingVersion,
    });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.idempotent, true);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.booking.preferredDate, TARGET);
    assert.deepEqual(occupiedKeys(index, record.id), [nextKey]);
  });
});
