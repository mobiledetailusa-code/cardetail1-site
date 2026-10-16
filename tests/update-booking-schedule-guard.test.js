'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const updateBooking = require('../netlify/functions/update-booking');
const { createAdminSession } = require('../netlify/lib/admin-security');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');

const SCHEDULE_FIELDS = [
  'preferredDate',
  'confirmedDate',
  'preferredTime',
  'confirmedTime',
  'confirmedTimeWindow',
  'appointmentSchedule',
  'appointmentDurationMinutes',
  'companionInterior',
  'slotReleasePending',
];

function booking(overrides = {}) {
  return {
    id: 'CD1-UPDATE',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex@example.test',
    phone: '2015550100',
    preferredDate: '2026-08-20',
    preferredTime: '8:00 AM',
    confirmedDate: '2026-08-20',
    confirmedTime: '8:00 AM',
    confirmedTimeWindow: '8:00–9:00 AM',
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    adminNotes: 'original note',
    bookingVersion: 4,
    ...overrides,
  };
}

function parseBody(res) {
  return JSON.parse(res.body || '{}');
}

async function post(token, updates, { context } = {}) {
  const previous = process.env.CONTEXT;
  if (context === undefined) delete process.env.CONTEXT;
  else process.env.CONTEXT = context;
  try {
    return await updateBooking.handler({
      httpMethod: 'POST',
      headers: token ? { 'x-admin-key': token } : {},
      body: JSON.stringify({ bookingId: 'CD1-UPDATE', updates }),
    });
  } finally {
    if (previous === undefined) delete process.env.CONTEXT;
    else process.env.CONTEXT = previous;
  }
}

beforeEach(() => {
  process.env.ADMIN_DASH_PASSWORD = 'Test-Admin-99';
  process.env.ADMIN_SESSION_SECRET = 's'.repeat(40);
  updateBooking.setBookingStoreOverride(null);
});

afterEach(() => {
  updateBooking.setBookingStoreOverride(null);
});

describe('update-booking refuses schedule fields', () => {
  it('rejects each occupancy field and writes nothing', async () => {
    const session = await createAdminSession('admin');
    for (const field of SCHEDULE_FIELDS) {
      const record = booking();
      let writes = 0;
      const store = createCasMemoryStore({ 'CD1-UPDATE': record });
      const original = store.setJSON.bind(store);
      store.setJSON = async (...args) => {
        writes += 1;
        return original(...args);
      };
      updateBooking.setBookingStoreOverride(store);
      const value = field === 'appointmentSchedule'
        ? { days: [] }
        : field === 'appointmentDurationMinutes'
          ? 120
          : field === 'companionInterior'
            ? true
            : field === 'slotReleasePending'
              ? [{ slotDate: '2026-08-21', slotTime: '8:00 AM' }]
              : '2026-09-01';
      const res = await post(session.token, { [field]: value });
      const body = parseBody(res);
      assert.equal(res.statusCode, 409, `${field} ${res.body}`);
      assert.equal(body.error, 'authoritative_reschedule_required');
      assert.deepEqual(body.fields, [field]);
      assert.equal(writes, 0, field);
      const stored = await store.get('CD1-UPDATE', { type: 'json' });
      assert.deepEqual(stored, record);
    }
  });

  it('rejects a schedule field mixed with an allowed field before any write', async () => {
    const session = await createAdminSession('admin');
    const record = booking();
    let writes = 0;
    const store = createCasMemoryStore({ 'CD1-UPDATE': record });
    const original = store.setJSON.bind(store);
    store.setJSON = async (...args) => {
      writes += 1;
      return original(...args);
    };
    updateBooking.setBookingStoreOverride(store);

    const res = await post(session.token, {
      adminNotes: 'should not land',
      preferredDate: '2026-09-02',
    });
    const body = parseBody(res);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(body.error, 'authoritative_reschedule_required');
    assert.equal(writes, 0);
    const stored = await store.get('CD1-UPDATE', { type: 'json' });
    assert.equal(stored.adminNotes, 'original note');
    assert.equal(stored.preferredDate, '2026-08-20');
    assert.deepEqual(stored, record);
  });

  it('still applies an admin note that does not move occupancy', async () => {
    const session = await createAdminSession('admin');
    const record = booking();
    let writes = 0;
    const store = createCasMemoryStore({ 'CD1-UPDATE': record });
    const original = store.setJSON.bind(store);
    store.setJSON = async (...args) => {
      writes += 1;
      return original(...args);
    };
    updateBooking.setBookingStoreOverride(store);

    const res = await post(session.token, { adminNotes: 'gate code is 1948' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(writes, 1);
    const stored = await store.get('CD1-UPDATE', { type: 'json' });
    assert.equal(stored.adminNotes, 'gate code is 1948');
    assert.equal(stored.preferredDate, record.preferredDate);
    assert.equal(stored.confirmedDate, record.confirmedDate);
    assert.equal(stored.preferredTime, record.preferredTime);
    assert.equal(stored.confirmedTime, record.confirmedTime);
    assert.equal(stored.confirmedTimeWindow, record.confirmedTimeWindow);
    assert.equal(stored.jobStatus, 'confirmed');
  });

  it('blocks an invalid admin key before any write', async () => {
    const record = booking();
    let writes = 0;
    const store = createCasMemoryStore({ 'CD1-UPDATE': record });
    const original = store.setJSON.bind(store);
    store.setJSON = async (...args) => {
      writes += 1;
      return original(...args);
    };
    updateBooking.setBookingStoreOverride(store);

    const res = await post('not-a-real-admin-key', { adminNotes: 'nope' });
    assert.equal(res.statusCode, 401, res.body);
    assert.equal(parseBody(res).ok, false);
    assert.equal(writes, 0);
    const stored = await store.get('CD1-UPDATE', { type: 'json' });
    assert.deepEqual(stored, record);
  });

  it('preview schedule updates produce no write', async () => {
    const session = await createAdminSession('admin');
    const record = booking();
    let writes = 0;
    let reads = 0;
    const store = createCasMemoryStore({ 'CD1-UPDATE': record });
    const originalSet = store.setJSON.bind(store);
    const originalGet = store.get.bind(store);
    store.setJSON = async (...args) => {
      writes += 1;
      return originalSet(...args);
    };
    store.get = async (...args) => {
      reads += 1;
      return originalGet(...args);
    };
    updateBooking.setBookingStoreOverride(store);

    const res = await post(session.token, {
      confirmedDate: '2026-09-03',
      adminNotes: 'preview must not apply',
    }, { context: 'deploy-preview' });
    const body = parseBody(res);
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(body.error, 'preview_writes_disabled');
    assert.equal(body.stored, false);
    assert.equal(body.sent, false);
    assert.equal(writes, 0);
    assert.equal(reads, 0);
    const stored = await originalGet('CD1-UPDATE', { type: 'json' });
    assert.deepEqual(stored, record);
  });
});
