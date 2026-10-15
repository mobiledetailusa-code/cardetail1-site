'use strict';

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  decideChangeRequestCommand,
  canonicalRescheduleEventId,
} = require('../netlify/lib/booking-commands');
const { handleAdminAction } = require('../netlify/functions/admin-ops-jobs');
const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
const { setSlotIndexStoreOverride, slotIndexKey } = require('../netlify/lib/slot-index');
const notifications = require('../netlify/lib/appointment-lifecycle-notifications');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { installFrozenBookingClock, restoreFrozenBookingClock } = require('./helpers/frozen-booking-clock');

const dates = installFrozenBookingClock();
const [OLD, TARGET, SHIFT] = dates.spanStarts(3);

after(() => {
  restoreFrozenBookingClock();
});

const PROTECTED_FIELDS = [
  'approvedFinalAmount',
  'amountPaid',
  'paidAmount',
  'ledger',
  'paymentIntentId',
  'paymentAttempts',
  'purpose',
  'currency',
  'techPayoutAmount',
  'platformFeeAmount',
  'payout',
  'package',
  'packageSnapshot',
  'addons',
  'discounts',
  'travelFeeAmount',
  'zoneSurcharge',
  'customerAccountId',
  'firstName',
  'lastName',
  'email',
  'phone',
  'address',
  'zipCode',
  'transactionalSmsConsent',
  'transactionalSmsConsentAccepted',
  'idempotencyKey',
  'decisionIdempotencyKey',
  'legacyCustomFlag',
  'service',
];

function memoryIndex(seed = []) {
  const values = new Map(seed.map((key) => [key, 'KEEP']));
  let jsonWrites = 0;
  return {
    jsonWrites: () => jsonWrites,
    keys: () => [...values.keys()],
    raw: (key) => values.get(key),
    async list(opts = {}) {
      const prefix = opts.prefix || '';
      const blobs = [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key }));
      if (opts.paginate) return (async function* pages() { yield { blobs }; })();
      return { blobs };
    },
    async setJSON(key, value) {
      jsonWrites += 1;
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

function occupiedKeys(index, bookingId) {
  return index.keys().filter((key) => (
    key.endsWith(`/${bookingId}`)
    && key.includes('/booked/')
    && !key.startsWith('span-claim/')
  ));
}

function richFinancials(overrides = {}) {
  return {
    approvedFinalAmount: 190,
    amountPaid: 50,
    paidAmount: 50,
    currency: 'usd',
    purpose: 'appointment_balance',
    paymentIntentId: 'pi_preserved_1',
    techPayoutAmount: 120,
    platformFeeAmount: 20,
    payout: { techCents: 12000, platformCents: 2000, currency: 'usd' },
    package: 'Full Detail',
    packageSnapshot: { id: 'full_detail', name: 'Full Detail', price: 160 },
    addons: [{ id: 'pet_hair', name: 'Pet Hair', price: 25 }],
    discounts: [{ id: 'welcome', cents: 1000 }],
    travelFeeAmount: 15,
    zoneSurcharge: 0,
    customerAccountId: 'acct_preserved',
    transactionalSmsConsentAccepted: true,
    transactionalSmsConsent: { accepted: true, at: '2026-01-02T00:00:00.000Z', source: 'checkout' },
    idempotencyKey: 'idem_booking_preserved',
    decisionIdempotencyKey: 'idem_decision_preserved',
    legacyCustomFlag: { keep: true, note: 'do-not-adapt' },
    service: {
      serviceAddress: '12 Harbor View',
      vehicles: [{
        vehicleId: 'veh_rich',
        category: 'cars',
        packageId: 'full_detail',
        pkgId: 'full_detail',
        addons: [{ id: 'pet_hair', price: 25 }],
      }],
    },
    ledger: {
      currency: 'usd',
      approvedCents: 19000,
      settledCents: 5000,
      creditedCents: 0,
      pendingCents: 0,
      entries: [{
        id: 'led_1',
        purpose: 'deposit',
        currency: 'usd',
        amountCents: 5000,
        paymentIntentId: 'pi_preserved_1',
        paymentAttemptId: 'pa_preserved_1',
      }],
    },
    paymentAttempts: [{
      id: 'pa_preserved_1',
      providerObjectId: 'pi_preserved_1',
      purpose: 'deposit',
      currency: 'usd',
      status: 'succeeded',
      idempotencyKey: 'idem_attempt_preserved',
    }],
    ...overrides,
  };
}

function baseBooking(overrides = {}) {
  return {
    id: 'CD1-INTEGRITY',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex@example.test',
    phone: '2015550100',
    address: '12 Harbor View',
    zipCode: '07601',
    preferredDate: OLD,
    preferredTime: '8:00 AM',
    confirmedDate: OLD,
    confirmedTime: '8:00 AM',
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    bookingVersion: 1,
    quoteVersion: 3,
    appointmentDurationMinutes: 90,
    ...richFinancials(),
    ...overrides,
  };
}

function pick(record, keys = PROTECTED_FIELDS) {
  const out = {};
  for (const key of keys) out[key] = record ? record[key] : undefined;
  return out;
}

function install(record, index) {
  const store = createCasMemoryStore({ [record.id]: record });
  setBookingStoreOverride(store);
  setSlotIndexStoreOverride(index);
  return store;
}

function parseBody(res) {
  return JSON.parse(res.body || '{}');
}

async function reschedule(record, body = {}) {
  return handleAdminAction({
    action: 'reschedule',
    bookingId: record.id,
    confirmedDate: TARGET,
    confirmedTimeWindow: '10:00–11:00 AM',
    ...body,
  });
}

let notifyCalls = 0;
const originalNotify = notifications.notifyRescheduled;

beforeEach(() => {
  process.env.SLOT_INDEX_READS = '1';
  notifyCalls = 0;
  notifications.notifyRescheduled = async (...args) => {
    notifyCalls += 1;
    return originalNotify(...args);
  };
  setBookingStoreOverride(null);
  setSlotIndexStoreOverride(null);
});

afterEach(() => {
  notifications.notifyRescheduled = originalNotify;
  process.env.SLOT_INDEX_READS = '1';
  setBookingStoreOverride(null);
  setSlotIndexStoreOverride(null);
});

describe('active reschedule preserves the financial record', () => {
  it('keeps money, contact, consent, and idempotency fields byte for byte', async () => {
    const record = baseBooking();
    const before = pick(record);
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const nextKey = bookedKey(TARGET, '10:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    install(record, index);

    const result = await reschedule(record);
    assert.equal(result.statusCode, 200, result.body);
    const stored = await getBookingRecord(record.id);
    assert.deepEqual(pick(stored.raw), before);
    assert.equal(stored.raw.ledger.settledCents, 5000);
    assert.equal(stored.raw.approvedFinalAmount, 190);
    assert.equal(stored.raw.amountPaid, 50);
    assert.equal(stored.raw.jobStatus, 'confirmed');
    assert.equal(stored.raw.preferredDate, TARGET);
    assert.equal(stored.raw.preferredTime, '10:00 AM');
    assert.equal(stored.raw.confirmedTimeWindow, '10:00–11:00 AM');
    assert.equal(stored.raw.status, 'Rescheduled');
    assert.equal(index.raw(oldKey), undefined);
    assert.ok(index.raw(nextKey));
    assert.equal(notifyCalls, 1);
  });

  it('keeps an in-progress job status while moving only the schedule', async () => {
    const record = baseBooking({
      id: 'CD1-IN-PROGRESS',
      jobStatus: 'in_progress',
      status: 'In Progress',
      appointmentStatus: 'confirmed',
    });
    const index = memoryIndex([bookedKey(OLD, '8:00 AM', record.id)]);
    install(record, index);
    const result = await reschedule(record);
    assert.equal(result.statusCode, 200, result.body);
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.raw.jobStatus, 'in_progress');
    assert.equal(stored.raw.appointmentStatus, 'confirmed');
    assert.equal(stored.raw.preferredDate, TARGET);
    assert.deepEqual(stored.raw.ledger, record.ledger);
  });

  it('uses one event id for the same slot regardless of window text', async () => {
    const record = baseBooking({ id: 'CD1-EVENT' });
    const index = memoryIndex([bookedKey(OLD, '8:00 AM', record.id)]);
    install(record, index);

    const byWindow = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTime: '',
      confirmedTimeWindow: '10:00–11:00 AM',
    });
    assert.equal(byWindow.statusCode, 200, byWindow.body);
    let stored = await getBookingRecord(record.id);
    const eventId = stored.raw.rescheduleEventId;
    assert.equal(eventId, canonicalRescheduleEventId(record.id, TARGET, '10:00 AM'));
    assert.doesNotMatch(eventId, /11:00/);

    const bySlot = await reschedule(record, {
      confirmedDate: TARGET,
      confirmedTime: '10:00 AM',
      confirmedTimeWindow: '',
    });
    assert.equal(bySlot.statusCode, 200, bySlot.body);
    assert.equal(parseBody(bySlot).idempotent, true);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.raw.rescheduleEventId, eventId);

    const moved = await reschedule(record, {
      confirmedDate: SHIFT,
      confirmedTime: '2:00 PM',
      confirmedTimeWindow: '2:00–3:00 PM',
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(parseBody(moved).idempotent, false);
    stored = await getBookingRecord(record.id);
    assert.equal(stored.raw.preferredDate, SHIFT);
    assert.equal(stored.raw.preferredTime, '2:00 PM');
    assert.notEqual(stored.raw.rescheduleEventId, eventId);
    assert.equal(stored.raw.rescheduleEventId, canonicalRescheduleEventId(record.id, SHIFT, '2:00 PM'));
  });

  it('approval of a customer reschedule does not rebuild the ledger', async () => {
    const record = baseBooking({
      id: 'CD1-APPROVE-MONEY',
      changeRequests: [{
        requestId: 'cr_money',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: TARGET, requestedTime: '10:00 AM' },
      }],
    });
    const before = pick(record);
    const index = memoryIndex([bookedKey(OLD, '8:00 AM', record.id)]);
    install(record, index);
    const result = await decideChangeRequestCommand({
      bookingId: record.id,
      requestId: 'cr_money',
      decision: 'approve',
      expectedBookingVersion: 1,
    });
    assert.equal(result.ok, true, result.error);
    const stored = await getBookingRecord(record.id);
    assert.deepEqual(pick(stored.raw), before);
    assert.equal(stored.raw.preferredDate, TARGET);
    assert.equal(stored.raw.changeRequests[0].status, 'applied');
    assert.equal(stored.raw.jobStatus, 'confirmed');
  });
});

describe('terminal and unknown bookings are not rescheduled', () => {
  const blocked = [
    { name: 'completed', patch: { jobStatus: 'completed', status: 'Completed', appointmentStatus: 'completed' } },
    { name: 'completed_paid', patch: { jobStatus: 'completed_paid', status: 'Paid', appointmentStatus: 'completed' } },
    { name: 'completed_pending_payment', patch: { jobStatus: 'completed_pending_payment', status: 'Completed', appointmentStatus: 'completed' } },
    { name: 'completed_pending_admin_review', patch: { jobStatus: 'completed_pending_admin_review', status: 'Completed' } },
    { name: 'cancelled', patch: { jobStatus: 'cancelled', status: 'Cancelled', appointmentStatus: 'canceled' } },
    { name: 'rejected', patch: { jobStatus: 'rejected', status: 'rejected', appointmentStatus: 'rejected' } },
    { name: 'revoked', patch: { jobStatus: 'revoked', status: 'revoked' } },
    { name: 'refunded', patch: { jobStatus: 'confirmed', status: 'Confirmed', paymentWorkflowStatus: 'refunded', paymentStatus: 'refunded' } },
    { name: 'closed', patch: { jobStatus: 'completed_paid', status: 'Closed' } },
    { name: 'unknown', patch: { jobStatus: 'banana', status: 'banana' } },
  ];

  for (const entry of blocked) {
    it(`blocks ${entry.name} before any capacity write`, async () => {
      const record = baseBooking({ id: `CD1-BLOCK-${entry.name}`, ...entry.patch });
      const before = structuredClone(record);
      const oldKey = bookedKey(OLD, '8:00 AM', record.id);
      const index = memoryIndex([oldKey]);
      install(record, index);
      notifyCalls = 0;

      const result = await reschedule(record);
      const body = parseBody(result);
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(body.error, 'booking_not_reschedulable');
      assert.equal(body.message, 'This appointment can no longer be rescheduled.');
      assert.doesNotMatch(JSON.stringify(body), /ledger|cents|stripe|balance|amountPaid|settled/i);
      assert.equal(index.jsonWrites(), 0);
      assert.equal(index.raw(oldKey), 'KEEP');
      assert.equal(notifyCalls, 0);
      const stored = await getBookingRecord(record.id);
      assert.deepEqual(stored.raw, before);
    });
  }

  it('does not turn completed_pending_payment into a future confirmed job', async () => {
    const record = baseBooking({
      id: 'CD1-DUE',
      jobStatus: 'completed_pending_payment',
      status: 'Completed',
      appointmentStatus: 'completed',
      amountPaid: 0,
      ledger: {
        currency: 'usd',
        approvedCents: 19000,
        settledCents: 0,
        creditedCents: 0,
        pendingCents: 19000,
        entries: [],
      },
    });
    const index = memoryIndex([bookedKey(OLD, '8:00 AM', record.id)]);
    install(record, index);
    const result = await reschedule(record);
    assert.equal(parseBody(result).error, 'booking_not_reschedulable');
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.raw.jobStatus, 'completed_pending_payment');
    assert.equal(stored.raw.status, 'Completed');
    assert.equal(stored.raw.ledger.settledCents, 0);
  });

  it('does not reconstruct a completed_paid ledger', async () => {
    const record = baseBooking({
      id: 'CD1-PAID-RAW',
      jobStatus: 'completed_paid',
      status: 'Paid',
      amountPaid: undefined,
      paidAmount: undefined,
      ledger: {
        currency: 'usd',
        approvedCents: 19000,
        settledCents: 5000,
        creditedCents: 0,
        pendingCents: 0,
        entries: [{ id: 'led_partial', amountCents: 5000, paymentIntentId: 'pi_partial' }],
      },
    });
    delete record.amountPaid;
    delete record.paidAmount;
    const index = memoryIndex([bookedKey(OLD, '8:00 AM', record.id)]);
    install(record, index);
    const result = await reschedule(record);
    assert.equal(parseBody(result).error, 'booking_not_reschedulable');
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.raw.ledger.settledCents, 5000);
    assert.equal(stored.raw.jobStatus, 'completed_paid');
    assert.equal(stored.raw.status, 'Paid');
    assert.equal(stored.raw.amountPaid, undefined);
    assert.equal(index.jsonWrites(), 0);
    assert.equal(notifyCalls, 0);
  });

  it('customer-request approval also refuses a completed booking without a claim', async () => {
    const record = baseBooking({
      id: 'CD1-APPROVE-DONE',
      jobStatus: 'completed_paid',
      status: 'Paid',
      changeRequests: [{
        requestId: 'cr_done',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: TARGET, requestedTime: '10:00 AM' },
      }],
    });
    const index = memoryIndex([bookedKey(OLD, '8:00 AM', record.id)]);
    install(record, index);
    const result = await decideChangeRequestCommand({
      bookingId: record.id,
      requestId: 'cr_done',
      decision: 'approve',
      expectedBookingVersion: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'booking_not_reschedulable');
    assert.equal(result.statusCode, 409);
    assert.equal(index.jsonWrites(), 0);
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.raw.changeRequests[0].status, 'pending');
    assert.equal(stored.raw.preferredDate, OLD);
    assert.equal(stored.raw.ledger.settledCents, 5000);
  });
});

describe('a reschedule loses when another command commits first', () => {
  function raceInstall(record, index, winner) {
    const store = createCasMemoryStore({ [record.id]: record });
    setBookingStoreOverride(store);
    setSlotIndexStoreOverride(index);
    const original = index.setJSON.bind(index);
    let fired = false;
    index.setJSON = async (key, value) => {
      const result = await original(key, value);
      if (!fired && String(key).includes('/booked/') && !String(key).startsWith('span-claim/')) {
        fired = true;
        await store.setJSON(record.id, winner);
      }
      return result;
    };
    return store;
  }

  async function loseTo(record, winner, index) {
    notifyCalls = 0;
    const result = await reschedule(record);
    const body = parseBody(result);
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(body.error, 'version_conflict');
    assert.equal(notifyCalls, 0);
    const stored = await getBookingRecord(record.id);
    assert.deepEqual(stored.raw, winner);
    const loserKey = bookedKey(TARGET, '10:00 AM', record.id);
    assert.equal(index.raw(loserKey), undefined);
    return stored;
  }

  it('completion wins', async () => {
    const record = baseBooking({ id: 'CD1-RACE-DONE' });
    const winner = {
      ...record,
      bookingVersion: 2,
      jobStatus: 'completed_paid',
      status: 'Paid',
      appointmentStatus: 'completed',
      updatedAt: '2026-01-06T12:00:00.000Z',
    };
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    raceInstall(record, index, winner);
    await loseTo(record, winner, index);
    assert.equal(index.raw(oldKey), 'KEEP');

    const writes = index.jsonWrites();
    const retry = await reschedule(record);
    assert.equal(parseBody(retry).error, 'booking_not_reschedulable');
    assert.equal(index.jsonWrites(), writes);
    assert.equal(notifyCalls, 0);
    const stored = await getBookingRecord(record.id);
    assert.deepEqual(stored.raw, winner);
    assert.equal(occupiedKeys(index, record.id).length, 1);
  });

  it('payment wins and a later retry keeps the payment', async () => {
    const record = baseBooking({ id: 'CD1-RACE-PAY' });
    const winner = {
      ...record,
      bookingVersion: 2,
      amountPaid: 190,
      paidAmount: 190,
      paymentIntentId: 'pi_winner',
      ledger: {
        ...record.ledger,
        settledCents: 19000,
        entries: [{
          id: 'led_winner',
          purpose: 'balance',
          currency: 'usd',
          amountCents: 14000,
          paymentIntentId: 'pi_winner',
        }],
      },
      paymentAttempts: [{
        id: 'pa_winner',
        providerObjectId: 'pi_winner',
        purpose: 'balance',
        currency: 'usd',
        status: 'succeeded',
        idempotencyKey: 'idem_winner',
      }],
    };
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    raceInstall(record, index, winner);
    await loseTo(record, winner, index);
    assert.equal(index.raw(oldKey), 'KEEP');

    const retry = await reschedule(record);
    assert.equal(retry.statusCode, 200, retry.body);
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.raw.preferredDate, TARGET);
    assert.equal(stored.raw.preferredTime, '10:00 AM');
    assert.equal(stored.raw.ledger.settledCents, 19000);
    assert.equal(stored.raw.amountPaid, 190);
    assert.equal(stored.raw.paymentIntentId, 'pi_winner');
    assert.deepEqual(stored.raw.paymentAttempts, winner.paymentAttempts);
    assert.equal(stored.raw.jobStatus, 'confirmed');
    assert.equal(index.raw(oldKey), undefined);
    assert.ok(index.raw(bookedKey(TARGET, '10:00 AM', record.id)));
  });

  it('cancellation wins', async () => {
    const record = baseBooking({ id: 'CD1-RACE-CANCEL' });
    const winner = {
      ...record,
      bookingVersion: 2,
      jobStatus: 'cancelled',
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      cancellationEventId: 'cancelled:CD1-RACE-CANCEL:winner',
    };
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const index = memoryIndex([oldKey]);
    raceInstall(record, index, winner);
    await loseTo(record, winner, index);
    assert.equal(index.raw(oldKey), 'KEEP');
    const retry = await reschedule(record);
    assert.equal(parseBody(retry).error, 'booking_not_reschedulable');
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.raw.jobStatus, 'cancelled');
    assert.equal(stored.raw.cancellationEventId, winner.cancellationEventId);
    assert.equal(stored.raw.preferredDate, OLD);
  });

  it('another reschedule wins', async () => {
    const record = baseBooking({ id: 'CD1-RACE-MOVE' });
    const winnerKey = bookedKey(SHIFT, '2:00 PM', record.id);
    const winner = {
      ...record,
      bookingVersion: 2,
      preferredDate: SHIFT,
      preferredTime: '2:00 PM',
      confirmedDate: SHIFT,
      confirmedTime: '2:00 PM',
      confirmedTimeWindow: '2:00–3:00 PM',
      status: 'Rescheduled',
      rescheduleEventId: canonicalRescheduleEventId(record.id, SHIFT, '2:00 PM'),
      rescheduledByAdmin: true,
    };
    const oldKey = bookedKey(OLD, '8:00 AM', record.id);
    const index = memoryIndex([oldKey, winnerKey]);
    raceInstall(record, index, winner);
    await loseTo(record, winner, index);
    assert.ok(index.raw(winnerKey));
    assert.equal(index.raw(bookedKey(TARGET, '10:00 AM', record.id)), undefined);
    const stored = await getBookingRecord(record.id);
    assert.equal(stored.raw.preferredDate, SHIFT);
    assert.equal(stored.raw.preferredTime, '2:00 PM');
    assert.equal(stored.raw.rescheduleEventId, winner.rescheduleEventId);
  });
});
