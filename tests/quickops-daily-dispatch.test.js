'use strict';

/**
 * QuickOps Daily Dispatch — technician privacy, assignment, pagination,
 * photo, auction and withdrawal behaviour.
 *
 * Handlers run against an in-memory Blobs fake installed in require.cache
 * before any function module loads. Date.now is frozen per test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// In-memory @netlify/blobs fake (strong reads, etags, CAS, paginated list)
// ---------------------------------------------------------------------------

const STORES = new Map();
const PAGE_SIZE = 2; // small pages so pagination is exercised

function makeStore(name) {
  const data = new Map();
  let seq = 0;
  const etagOf = (k) => (data.has(k) ? data.get(k).etag : null);
  const store = {
    name,
    _data: data,
    writes: 0,
    async get(key, opts = {}) {
      const row = data.get(key);
      if (!row) return null;
      if (opts.type === 'json') return JSON.parse(row.value);
      return row.value;
    },
    async getWithMetadata(key, opts = {}) {
      const row = data.get(key);
      if (!row) return null;
      return { data: opts.type === 'json' ? JSON.parse(row.value) : row.value, etag: row.etag, metadata: {} };
    },
    async setJSON(key, value, opts = {}) {
      if (opts.onlyIfNew && data.has(key)) return { modified: false };
      if (opts.onlyIfMatch && etagOf(key) !== opts.onlyIfMatch) return { modified: false };
      seq += 1;
      store.writes += 1;
      data.set(key, { value: JSON.stringify(value), etag: `"${name}-${seq}"` });
      return { modified: true, etag: `"${name}-${seq}"` };
    },
    async set(key, value) {
      seq += 1;
      store.writes += 1;
      data.set(key, { value, etag: `"${name}-${seq}"` });
      return { modified: true };
    },
    async delete(key) { data.delete(key); },
    list(opts = {}) {
      const keys = [...data.keys()].filter((k) => !opts.prefix || k.startsWith(opts.prefix)).sort();
      const pages = [];
      for (let i = 0; i < keys.length; i += PAGE_SIZE) {
        pages.push({ blobs: keys.slice(i, i + PAGE_SIZE).map((key) => ({ key, etag: etagOf(key) })), directories: [] });
      }
      if (!pages.length) pages.push({ blobs: [], directories: [] });
      if (opts.paginate) {
        return {
          async* [Symbol.asyncIterator]() { for (const p of pages) yield p; },
        };
      }
      // Unpaginated call returns ONLY the first page (the pre-fix bug surface).
      return Promise.resolve(pages[0]);
    },
  };
  return store;
}

function getStore(opts) {
  const name = typeof opts === 'string' ? opts : opts && opts.name;
  if (!STORES.has(name)) STORES.set(name, makeStore(name));
  return STORES.get(name);
}

const blobsPath = require.resolve('@netlify/blobs');
require.cache[blobsPath] = {
  id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore },
};

function resetStores() { STORES.clear(); }
function store(name) { return getStore(name); }

// Module under test (pure)
const P = require('../netlify/lib/tech-dispatch-privacy');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TECH_A = { techId: 'TECH-AAAAAA111111', fullName: 'Alex Rivera', active: true, onboarding: { completed: true } };
const TECH_B = { techId: 'TECH-BBBBBB222222', fullName: 'Sam Lee', active: true, onboarding: { completed: true } };
const TECH_DUP = { techId: 'TECH-CCCCCC333333', fullName: 'Alex Rivera', active: true, onboarding: { completed: true } };

function sessionFor(tech) {
  return { techId: tech.techId, techName: tech.fullName, tech };
}

function rosterOf(...techs) {
  return P.createRosterLoader(async () => techs);
}

// 2026-11-24 (Tuesday, EST, UTC-5). 8:00 AM ET = 13:00Z.
const DAY = '2026-11-24';
const START_8AM = Date.parse('2026-11-24T13:00:00.000Z');
const HOUR = 3600 * 1000;

function booking(over = {}) {
  return {
    id: 'bk_' + crypto.randomBytes(4).toString('hex'),
    bookingVersion: 3,
    firstName: 'Jordan',
    lastName: 'Customer',
    phone: '+12015550123',
    email: 'jordan@example.com',
    address: '12 Harbor View, Fort Lee, NJ',
    zipCode: '07024',
    zone: 'Bergen',
    customerNote: 'Gate code 4411',
    accessNotes: 'Park in visitor lot B',
    package: 'Full Detail',
    vehicleLabel: 'SUV',
    preferredDate: DAY,
    confirmedDate: DAY,
    preferredTime: '8:00 AM',
    preferredArrivalWindow: '08:00-11:00',
    confirmedTime: '8:00 AM',
    confirmedTimeWindow: '08:00-11:00',
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'assigned',
    serviceStatus: 'assigned',
    assignedTechId: TECH_A.techId,
    assignedTechName: TECH_A.fullName,
    assignmentKind: 'registered',
    assignedAt: '2026-11-20T15:00:00.000Z',
    photosBefore: ['/.netlify/functions/job-photo-image?id=jobph_1_ab'],
    photosAfter: [],
    ...over,
  };
}

async function access(b, nowMs, sess = sessionFor(TECH_A), roster = rosterOf(TECH_A, TECH_B)) {
  return P.technicianAccess(b, sess, { nowMs, loadRoster: roster });
}

// ---------------------------------------------------------------------------
// 12-hour boundary
// ---------------------------------------------------------------------------

test('PII locked 13h before 8:00 AM ET and unlocked 11h before', async () => {
  const b = booking();
  const locked = await access(b, START_8AM - 13 * HOUR);
  assert.equal(locked.piiAllowed, false);
  assert.equal(locked.reason, 'before_unlock_window');
  assert.equal(locked.unlocksAt, '2026-11-24T01:00:00.000Z'); // 8:00 PM ET the evening before

  const open = await access(b, START_8AM - 11 * HOUR);
  assert.equal(open.piiAllowed, true);
});

test('exact 12h boundary: 1 ms before is locked, the instant itself is unlocked', async () => {
  const b = booking();
  assert.equal((await access(b, START_8AM - 12 * HOUR - 1)).piiAllowed, false);
  assert.equal((await access(b, START_8AM - 12 * HOUR)).piiAllowed, true);
});

test('arrival start is the window start, not the internal slot', () => {
  const r = P.resolveArrivalStart(booking({ confirmedTime: '10:00 AM', confirmedTimeWindow: '8:00 AM – 11:00 AM' }));
  assert.equal(r.ok, true);
  assert.equal(r.startMs, START_8AM);
});

test('redacted projection keeps day-board fields and blanks customer PII', async () => {
  const { projectJobForTech } = require('../netlify/lib/ops-workflow');
  const b = booking();
  const row = P.redactTechJob(projectJobForTech(b), await access(b, START_8AM - 13 * HOUR));
  assert.equal(row.piiLocked, true);
  for (const k of ['phone', 'email', 'address', 'zipCode', 'customerNote', 'notes', 'accessNotes', 'adminNotes']) {
    assert.equal(row[k], '', k);
  }
  assert.equal(row.customerName, 'Customer');
  assert.deepEqual(row.photosBefore, []);
  assert.equal(row.package, 'Full Detail');
  assert.equal(row.vehicle, 'SUV');
  assert.equal(row.confirmedDate, DAY);
  assert.equal(row.zone, 'Bergen');
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /Harbor View|5550123|Gate code|Jordan|jordan@/);
});

// ---------------------------------------------------------------------------
// DST
// ---------------------------------------------------------------------------

test('DST spring forward (2026-03-08): 8:00 AM EDT, unlock 12 elapsed hours earlier', async () => {
  const b = booking({ preferredDate: '2026-03-08', confirmedDate: '2026-03-08' });
  const start = Date.parse('2026-03-08T12:00:00.000Z'); // 8:00 AM EDT
  const r = P.resolveArrivalStart(b);
  assert.equal(r.startMs, start);
  assert.equal((await access(b, start - 12 * HOUR - 1)).piiAllowed, false);
  assert.equal((await access(b, start - 11 * HOUR)).piiAllowed, true);
  // 12 real hours before crosses the 2 AM jump: 7:00 PM EST on the 7th.
  assert.equal(new Date(r.unlockMs).toISOString(), '2026-03-08T00:00:00.000Z');
});

test('DST fall back (2026-11-01): 8:00 AM EST, unlock 9:00 PM EDT the evening before', async () => {
  const b = booking({ preferredDate: '2026-11-01', confirmedDate: '2026-11-01' });
  const start = Date.parse('2026-11-01T13:00:00.000Z'); // 8:00 AM EST
  assert.equal(P.resolveArrivalStart(b).startMs, start);
  assert.equal((await access(b, start - 13 * HOUR)).piiAllowed, false);
  assert.equal((await access(b, start - 11 * HOUR)).piiAllowed, true);
});

test('nonexistent wall time in the spring gap is rejected', () => {
  assert.equal(P.easternWallToUtcMs('2026-03-08', 150), null); // 2:30 AM never happens
});

// ---------------------------------------------------------------------------
// Missing / invalid / inconsistent scheduling fails closed
// ---------------------------------------------------------------------------

const BAD_SCHEDULES = [
  ['blank dates', { preferredDate: '', confirmedDate: '' }, 'missing_date'],
  ['invalid date', { preferredDate: 'next Tuesday', confirmedDate: '' }, 'invalid_date'],
  ['impossible calendar date', { preferredDate: '2026-02-30', confirmedDate: '' }, 'invalid_date'],
  ['confirmed vs preferred dates disagree', { confirmedDate: DAY, preferredDate: '2026-11-25' }, 'inconsistent_date'],
  ['Morning label', { confirmedTime: 'Morning', confirmedTimeWindow: '' }, 'invalid_time'],
  ['slot outside its window', { confirmedTime: '2:00 PM', confirmedTimeWindow: '08:00-11:00' }, 'inconsistent_time'],
  ['anytime without slot', { confirmedTime: '', confirmedTimeWindow: 'anytime' }, 'missing_time'],
  ['no time at all', { confirmedTime: '', confirmedTimeWindow: '', preferredTime: '', preferredArrivalWindow: '' }, 'missing_time'],
  ['middle of the night', { confirmedTime: '3:00 AM', confirmedTimeWindow: '' }, 'invalid_time'],
  ['garbage window', { confirmedTimeWindow: 'soon-ish', confirmedTime: '' }, 'invalid_time'],
];

for (const [label, over, reason] of BAD_SCHEDULES) {
  test(`fails closed: ${label}`, async () => {
    const b = booking(over);
    // Even on the service day itself, an hour before the nominal start.
    const a = await access(b, START_8AM - HOUR);
    assert.equal(a.piiAllowed, false);
    assert.equal(a.reason, reason);
  });
}

// ---------------------------------------------------------------------------
// Rescheduling
// ---------------------------------------------------------------------------

test('rescheduling revalidates: unlocked job relocks when moved days out', async () => {
  const now = START_8AM - 2 * HOUR;
  const b = booking();
  assert.equal((await access(b, now)).piiAllowed, true);
  const moved = { ...b, confirmedDate: '2026-11-27', preferredDate: '2026-11-27' };
  const a = await access(moved, now);
  assert.equal(a.piiAllowed, false);
  assert.equal(a.reason, 'before_unlock_window');
});

test('customer-applied reschedule that leaves confirmedDate stale fails closed', async () => {
  const b = booking({ preferredDate: '2026-11-27' }); // confirmedDate still DAY
  const a = await access(b, START_8AM - HOUR);
  assert.equal(a.piiAllowed, false);
  assert.equal(a.reason, 'inconsistent_date');
});

// ---------------------------------------------------------------------------
// Terminal states across status / jobStatus / serviceStatus
// ---------------------------------------------------------------------------

const TERMINAL = [
  ['legacy status Cancelled, stale jobStatus assigned', { status: 'Cancelled', jobStatus: 'assigned' }, 'cancelled'],
  ['appointmentStatus canceled only', { appointmentStatus: 'canceled' }, 'cancelled'],
  ['serviceStatus cancelled only', { serviceStatus: 'cancelled' }, 'cancelled'],
  ['legacy No-Show', { status: 'No-Show' }, 'cancelled'],
  ['jobStatus completed_pending_payment', { jobStatus: 'completed_pending_payment' }, 'completed'],
  ['serviceStatus closed, stale jobStatus in_progress', { serviceStatus: 'closed', jobStatus: 'in_progress' }, 'completed'],
  ['legacy status Paid only', { status: 'Paid' }, 'completed'],
  ['completedAt stamp with stale statuses', { completedAt: '2026-11-24T15:00:00Z' }, 'completed'],
  ['completionSubmitted flag', { completionSubmitted: true }, 'completed'],
  ['reopened, then service completed again', {
    jobStatus: 'reopened', serviceStatus: 'service_completed', reopenedAt: '2026-11-24T16:00:00Z', status: 'Completed',
  }, 'completed'],
];

for (const [label, over, reason] of TERMINAL) {
  test(`terminal (no PII): ${label}`, async () => {
    const a = await access(booking(over), START_8AM - HOUR);
    assert.equal(a.terminal, true);
    assert.equal(a.piiAllowed, false);
    assert.equal(a.reason, reason);
  });
}

test('an explicitly reopened job regains access despite the stale Completed label', async () => {
  const a = await access(booking({
    jobStatus: 'reopened', serviceStatus: 'reopened', reopenedAt: '2026-11-24T16:00:00Z',
    status: 'Completed', completedAt: '2026-11-24T15:00:00Z',
  }), START_8AM - HOUR);
  assert.equal(a.terminal, false);
  assert.equal(a.piiAllowed, true);
});

// ---------------------------------------------------------------------------
// Assignment / duplicate names
// ---------------------------------------------------------------------------

test('assignment by id grants; another technician id denies even with a matching name', async () => {
  const now = START_8AM - HOUR;
  assert.equal((await access(booking(), now)).piiAllowed, true);
  const other = await access(booking({ assignedTechId: TECH_B.techId, assignedTechName: TECH_A.fullName }), now);
  assert.equal(other.assigned, false);
  assert.equal(other.reason, 'assigned_to_other_id');
});

test('duplicate technician names: legacy name-only assignment is denied to both', async () => {
  const b = booking({ assignedTechId: '', assignedTech: '', assignedTechName: 'Alex Rivera' });
  const roster = rosterOf(TECH_A, TECH_B, TECH_DUP);
  for (const t of [TECH_A, TECH_DUP]) {
    const a = await access(b, START_8AM - HOUR, sessionFor(t), roster);
    assert.equal(a.assigned, false);
    assert.equal(a.reason, 'ambiguous_name');
  }
});

test('legacy name-only assignment still works when the name is unique', async () => {
  const b = booking({ assignedTechId: '', assignedTech: 'Alex Rivera', assignedTechName: 'Alex Rivera' });
  const a = await access(b, START_8AM - HOUR, sessionFor(TECH_A), rosterOf(TECH_A, TECH_B));
  assert.equal(a.assigned, true);
  assert.equal(a.piiAllowed, true);
});

test('legacy name path fails closed when the roster cannot load', async () => {
  const b = booking({ assignedTechId: '', assignedTech: '', assignedTechName: 'Alex Rivera' });
  const broken = P.createRosterLoader(async () => { throw new Error('down'); });
  const a = await access(b, START_8AM - HOUR, sessionFor(TECH_A), broken);
  assert.equal(a.assigned, false);
  assert.equal(a.reason, 'roster_unavailable');
});

test('freelance (phone) assignment never matches a registered technician', async () => {
  const a = await access(booking({ assignmentKind: 'freelance', assignedTechId: '', assignedTechName: 'Alex Rivera' }), START_8AM - HOUR);
  assert.equal(a.assigned, false);
});

test('synchronous bookingAssignedToTech no longer authorizes by name', () => {
  const { bookingAssignedToTech } = require('../netlify/lib/tech-security');
  const b = booking({ assignedTechId: '', assignedTech: '', assignedTechName: 'Alex Rivera' });
  assert.equal(bookingAssignedToTech(b, TECH_DUP.techId, 'Alex Rivera'), false);
  assert.equal(bookingAssignedToTech(booking(), TECH_A.techId, 'anything'), true);
});

// ---------------------------------------------------------------------------
// Handler tests (fake Blobs)
// ---------------------------------------------------------------------------

function seedTech(tech) {
  const token = crypto.randomBytes(32).toString('hex');
  store('cd1-tech-sessions')._data.set('tsess-' + token.slice(0, 16), {
    value: JSON.stringify({ token, techId: tech.techId, techName: tech.fullName, createdAt: 0, expiresAt: Number.MAX_SAFE_INTEGER }),
    etag: '"s"',
  });
  store('cd1-tech-accounts')._data.set('tech-' + tech.techId, { value: JSON.stringify(tech), etag: '"t"' });
  return token;
}

function seedBooking(b) {
  store('cd1-bookings')._data.set(b.id, { value: JSON.stringify(b), etag: `"b-${b.id}"` });
  return b;
}

function readBooking(id) {
  return JSON.parse(store('cd1-bookings')._data.get(id).value);
}

function freshRequire(rel) {
  const p = require.resolve(rel);
  delete require.cache[p];
  return require(p);
}

function freezeNow(t, ms) {
  t.mock.method(Date, 'now', () => ms);
}

test('tech-jobs GET paginates all booking pages and redacts per booking', async (t) => {
  resetStores();
  freezeNow(t, START_8AM - 13 * HOUR);
  const token = seedTech(TECH_A);
  seedTech(TECH_B);
  const ids = [];
  // 7 bookings over 4 list pages; 5 assigned to A.
  for (let i = 0; i < 5; i++) ids.push(seedBooking(booking({ id: `bk_a${i}` })).id);
  seedBooking(booking({ id: 'bk_b0', assignedTechId: TECH_B.techId, assignedTechName: TECH_B.fullName }));
  // A tomorrow-morning job inside 12h? No: one that starts in 6h on the same clock.
  const soonDay = '2026-11-23'; // 3:00 PM ET on the 23rd = 20:00Z, now = 00:00Z 24th → past start, still unlocked
  seedBooking(booking({ id: 'bk_soon', preferredDate: soonDay, confirmedDate: soonDay, confirmedTime: '2:00 PM', confirmedTimeWindow: '14:00-17:00', preferredTime: '2:00 PM', preferredArrivalWindow: '14:00-17:00' }));

  const handler = freshRequire('../netlify/functions/tech-jobs').handler;
  const res = await handler({ httpMethod: 'GET', headers: { 'x-tech-token': token }, queryStringParameters: {} });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const got = body.jobs.map((j) => j.id).sort();
  assert.deepEqual(got, [...ids, 'bk_soon'].sort(), 'every assigned job across all pages, none of B\'s');
  for (const j of body.jobs) {
    if (j.id === 'bk_soon') {
      assert.equal(j.piiLocked, false);
      assert.equal(j.phone, '+12015550123');
    } else {
      assert.equal(j.piiLocked, true);
      assert.equal(j.phone, '');
      assert.equal(j.address, '');
    }
  }
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('tech-jobs GET date filter and invalid date', async (t) => {
  resetStores();
  freezeNow(t, START_8AM - HOUR);
  const token = seedTech(TECH_A);
  seedBooking(booking({ id: 'bk_d1' }));
  seedBooking(booking({ id: 'bk_d2', confirmedDate: '2026-11-25', preferredDate: '2026-11-25' }));
  const handler = freshRequire('../netlify/functions/tech-jobs').handler;
  const okRes = await handler({ httpMethod: 'GET', headers: { 'x-tech-token': token }, queryStringParameters: { date: DAY } });
  assert.equal(okRes.statusCode, 200, okRes.body);
  const ok = JSON.parse(okRes.body);
  assert.deepEqual(ok.jobs.map((j) => j.id), ['bk_d1']);
  const bad = await handler({ httpMethod: 'GET', headers: { 'x-tech-token': token }, queryStringParameters: { date: 'tomorrow' } });
  assert.equal(bad.statusCode, 400);
});

test('tech-jobs GET drops jobs that are terminal only through a stale legacy field', async (t) => {
  resetStores();
  freezeNow(t, START_8AM - HOUR);
  const token = seedTech(TECH_A);
  seedBooking(booking({ id: 'bk_live' }));
  seedBooking(booking({ id: 'bk_cx', status: 'Cancelled', jobStatus: 'assigned' }));
  seedBooking(booking({ id: 'bk_done', serviceStatus: 'closed', jobStatus: 'in_progress' }));
  const handler = freshRequire('../netlify/functions/tech-jobs').handler;
  const body = JSON.parse((await handler({ httpMethod: 'GET', headers: { 'x-tech-token': token } })).body);
  assert.deepEqual(body.jobs.map((j) => j.id), ['bk_live']);
  assert.doesNotMatch(JSON.stringify(body), /Harbor View.*Harbor View/); // only one address delivered
});

test('tech-jobs POST status update is refused on a stale-cancelled booking', async (t) => {
  resetStores();
  freezeNow(t, START_8AM - HOUR);
  const token = seedTech(TECH_A);
  const b = seedBooking(booking({ id: 'bk_stale', status: 'Cancelled', jobStatus: 'assigned' }));
  const before = store('cd1-bookings')._data.get(b.id).value;
  const handler = freshRequire('../netlify/functions/tech-jobs').handler;
  const res = await handler({ httpMethod: 'POST', headers: { 'x-tech-token': token }, body: JSON.stringify({ bookingId: b.id, status: 'en_route' }) });
  assert.equal(res.statusCode, 403);
  assert.equal(store('cd1-bookings')._data.get(b.id).value, before);
});

test('tech-job-photos: locked before window, open inside it, closed after cancellation or reassignment', async (t) => {
  resetStores();
  const token = seedTech(TECH_A);
  seedTech(TECH_B);
  const b = seedBooking(booking({ id: 'bk_ph' }));
  const handler = freshRequire('../netlify/functions/tech-job-photos').handler;
  const get = () => handler({ httpMethod: 'GET', headers: { 'x-tech-token': token }, queryStringParameters: { bookingId: b.id } });

  const nowMock = t.mock.method(Date, 'now', () => START_8AM - 13 * HOUR);
  let res = await get();
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'photo_access_locked');
  assert.doesNotMatch(res.body, /jobph_/);

  nowMock.mock.mockImplementation(() => START_8AM - HOUR);
  res = await get();
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /jobph_1_ab/);

  seedBooking({ ...b, status: 'Cancelled' });
  res = await get();
  assert.equal(res.statusCode, 403);
  assert.doesNotMatch(res.body, /jobph_/);

  seedBooking({ ...b, assignedTechId: TECH_B.techId, assignedTechName: TECH_B.fullName });
  res = await get();
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'not_assigned_to_you');

  // Upload is refused too, before any photo is stored.
  seedBooking({ ...b, completedAt: '2026-11-24T15:00:00Z' });
  res = await handler({
    httpMethod: 'POST', headers: { 'x-tech-token': token },
    body: JSON.stringify({ bookingId: b.id, phase: 'after', data: 'AAAA', contentType: 'image/jpeg', filename: 'a.jpg' }),
  });
  assert.equal(res.statusCode, 403);
});

test('job-photo-image: legacy photos keep public immutable caching, new photos are private and short-lived', () => {
  const { _cacheHeadersFor } = freshRequire('../netlify/functions/job-photo-image');
  assert.equal(_cacheHeadersFor({ contentType: 'image/jpeg' })['Cache-Control'], 'public, max-age=31536000, immutable');
  const next = _cacheHeadersFor({ contentType: 'image/jpeg', cachePolicy: 'private-v1' });
  assert.equal(next['Cache-Control'], 'private, max-age=300');
  assert.equal(next['Access-Control-Allow-Origin'], undefined);
  const storage = fs.readFileSync(path.join(__dirname, '../netlify/lib/job-photo-storage.js'), 'utf8');
  assert.match(storage, /cachePolicy: PRIVATE_CACHE_POLICY/);
});

test('tech-auctions never returns customer notes', async () => {
  resetStores();
  const token = seedTech(TECH_A);
  store('cd1-auctions')._data.set('bk_auc', {
    value: JSON.stringify({
      jobId: 'bk_auc', status: 'open', postedAt: '2026-11-20T00:00:00Z', closesAt: '2099-01-01T00:00:00Z', bidMax: 120, bids: [],
      job: { package: 'Full Detail', vehicle: 'SUV', date: DAY, time: '8:00 AM', area: 'Bergen', addons: [], total: 300, serviceNotes: 'Gate code 4411, call 201-555-0123' },
    }),
    etag: '"a"',
  });
  const handler = freshRequire('../netlify/functions/tech-auctions').handler;
  const res = await handler({ httpMethod: 'GET', headers: { 'x-tech-token': token } });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /Gate code|555-0123|serviceNotes/);
  assert.match(res.body, /Full Detail/);
});

// ---------------------------------------------------------------------------
// Withdrawal requests
// ---------------------------------------------------------------------------

async function postWithdrawal(handler, token, bookingId, reason) {
  const res = await handler({
    httpMethod: 'POST', headers: { 'x-tech-token': token },
    body: JSON.stringify({ action: 'request_withdrawal', bookingId, reason }),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('withdrawal request: reason required, ≥12h notice, booking bytes unchanged', async (t) => {
  resetStores();
  const token = seedTech(TECH_A);
  const b = seedBooking(booking({ id: 'bk_wd' }));
  const before = store('cd1-bookings')._data.get(b.id).value;
  const handler = freshRequire('../netlify/functions/tech-jobs').handler;
  const nowMock = t.mock.method(Date, 'now', () => START_8AM - 20 * HOUR);

  let r = await postWithdrawal(handler, token, b.id, '');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'reason_required');
  r = await postWithdrawal(handler, token, b.id, 'short');
  assert.equal(r.status, 400);

  nowMock.mock.mockImplementation(() => START_8AM - 11 * HOUR);
  r = await postWithdrawal(handler, token, b.id, 'Family emergency, cannot make it');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'insufficient_notice');

  nowMock.mock.mockImplementation(() => START_8AM - 12 * HOUR + 1);
  r = await postWithdrawal(handler, token, b.id, 'Family emergency, cannot make it');
  assert.equal(r.status, 400, 'one millisecond short of 12h notice is refused');

  nowMock.mock.mockImplementation(() => START_8AM - 12 * HOUR);
  r = await postWithdrawal(handler, token, b.id, 'Family emergency, cannot make it');
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, 'pending');

  r = await postWithdrawal(handler, token, b.id, 'Family emergency, cannot make it');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'request_already_pending');

  assert.equal(store('cd1-bookings')._data.get(b.id).value, before, 'filing a request never writes the booking');
});

test('withdrawal request fails closed on an unresolvable schedule and for non-assignees', async (t) => {
  resetStores();
  freezeNow(t, START_8AM - 48 * HOUR);
  const tokenA = seedTech(TECH_A);
  const tokenB = seedTech(TECH_B);
  const vague = seedBooking(booking({ id: 'bk_vague', confirmedTime: 'Morning', confirmedTimeWindow: '' }));
  const ok = seedBooking(booking({ id: 'bk_ok' }));
  const handler = freshRequire('../netlify/functions/tech-jobs').handler;
  let r = await postWithdrawal(handler, tokenA, vague.id, 'Truck in the shop this week');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'schedule_unresolved');
  r = await postWithdrawal(handler, tokenB, ok.id, 'Truck in the shop this week');
  assert.equal(r.status, 403);
});

test('admin approval unassigns the requester only, keeps the booking confirmed, sends no SMS', async (t) => {
  resetStores();
  freezeNow(t, START_8AM - 30 * HOUR);
  const token = seedTech(TECH_A);
  const b = seedBooking(booking({ id: 'bk_appr', jobStatus: 'accepted' }));
  const jobs = freshRequire('../netlify/functions/tech-jobs').handler;
  const filed = await postWithdrawal(jobs, token, b.id, 'Double booked by mistake');
  assert.equal(filed.status, 200);

  const W = freshRequire('../netlify/lib/tech-withdrawal');
  const [req] = await W.listWithdrawalRequests({ status: 'pending' });
  const result = await W.decideWithdrawalRequest({ id: req.id, decision: 'approve' });
  assert.equal(result.ok, true, JSON.stringify(result));

  const after = readBooking(b.id);
  assert.equal(after.assignedTechId, null);
  assert.equal(after.assignedTechName, null);
  assert.notEqual(after.jobStatus, 'cancelled');
  assert.equal(after.jobStatus, 'confirmed');
  assert.equal(after.status, 'Confirmed');
  assert.equal(after.appointmentStatus, 'confirmed');
  assert.equal(after.confirmedDate, DAY);
  for (const name of STORES.keys()) assert.doesNotMatch(name, /sms|outbox/i, 'no SMS store touched');
  const [done] = await W.listWithdrawalRequests({ status: 'approved' });
  assert.equal(done.outcome, 'unassigned');

  // A second decision on the same request is refused.
  const again = await W.decideWithdrawalRequest({ id: req.id, decision: 'approve' });
  assert.equal(again.statusCode, 409);
  assert.equal(again.error, 'already_decided');
});

test('stale approval after reassignment never removes the new technician', async (t) => {
  resetStores();
  freezeNow(t, START_8AM - 30 * HOUR);
  const token = seedTech(TECH_A);
  seedTech(TECH_B);
  const b = seedBooking(booking({ id: 'bk_stale_wd' }));
  const jobs = freshRequire('../netlify/functions/tech-jobs').handler;
  assert.equal((await postWithdrawal(jobs, token, b.id, 'Vehicle broke down today')).status, 200);

  // Admin reassigns to B before deciding the request.
  seedBooking({ ...readBooking(b.id), assignedTechId: TECH_B.techId, assignedTechName: TECH_B.fullName, assignedAt: '2026-11-21T10:00:00Z', bookingVersion: 4 });
  const snapshot = store('cd1-bookings')._data.get(b.id).value;

  const W = freshRequire('../netlify/lib/tech-withdrawal');
  const [req] = await W.listWithdrawalRequests({ status: 'pending' });
  const result = await W.decideWithdrawalRequest({ id: req.id, decision: 'approve' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_request');
  assert.equal(store('cd1-bookings')._data.get(b.id).value, snapshot, 'booking untouched');
  assert.equal(readBooking(b.id).assignedTechId, TECH_B.techId);
});

test('stale approval when the same technician was re-assigned after filing', async (t) => {
  resetStores();
  freezeNow(t, START_8AM - 30 * HOUR);
  const token = seedTech(TECH_A);
  const b = seedBooking(booking({ id: 'bk_reassigned_same' }));
  const jobs = freshRequire('../netlify/functions/tech-jobs').handler;
  assert.equal((await postWithdrawal(jobs, token, b.id, 'Conflict with another job')).status, 200);
  seedBooking({ ...readBooking(b.id), assignedAt: '2026-11-22T09:00:00Z' });
  const W = freshRequire('../netlify/lib/tech-withdrawal');
  const [req] = await W.listWithdrawalRequests({ status: 'pending' });
  const result = await W.decideWithdrawalRequest({ id: req.id, decision: 'approve' });
  assert.equal(result.error, 'stale_request');
  assert.equal(readBooking(b.id).assignedTechId, TECH_A.techId);
});

test('decline leaves the booking untouched', async (t) => {
  resetStores();
  freezeNow(t, START_8AM - 30 * HOUR);
  const token = seedTech(TECH_A);
  const b = seedBooking(booking({ id: 'bk_decl' }));
  const jobs = freshRequire('../netlify/functions/tech-jobs').handler;
  await postWithdrawal(jobs, token, b.id, 'Would rather not drive that far');
  const snapshot = store('cd1-bookings')._data.get(b.id).value;
  const W = freshRequire('../netlify/lib/tech-withdrawal');
  const [req] = await W.listWithdrawalRequests({ status: 'pending' });
  const r = await W.decideWithdrawalRequest({ id: req.id, decision: 'decline', adminNote: 'Please keep it' });
  assert.equal(r.ok, true);
  assert.equal(store('cd1-bookings')._data.get(b.id).value, snapshot);
});

test('withdrawal approval reuses the existing unassign and is not a customer change request', () => {
  const src = fs.readFileSync(path.join(__dirname, '../netlify/lib/tech-withdrawal.js'), 'utf8');
  assert.match(src, /unassignQuickOpsTech/);
  assert.doesNotMatch(src, /createChangeRequest|cd1-customer-change-requests|cancel_booking/);
  const assign = fs.readFileSync(path.join(__dirname, '../netlify/functions/tech-assignment.js'), 'utf8');
  assert.match(assign, /decide_withdrawal/);
  assert.match(assign, /verifyAdminKey/);
});

// ---------------------------------------------------------------------------
// UI wiring (no browser-only security)
// ---------------------------------------------------------------------------

test('technician page renders the server lock state and never sends a tech id to pick jobs', () => {
  const html = fs.readFileSync(path.join(__dirname, '../technician.html'), 'utf8');
  assert.match(html, /piiLocked/);
  assert.match(html, /request_withdrawal/);
  assert.match(html, /setDispatchDate/);
  assert.doesNotMatch(html, /tech-jobs\?[^'"]*techId/);
  assert.doesNotMatch(html, /cancel 24\+ hours/);
});

test('admin Schedule tab lists unscheduled bookings and withdrawal requests via existing drawer', () => {
  const html = fs.readFileSync(path.join(__dirname, '../admin-ops.html'), 'utf8');
  const dv = fs.readFileSync(path.join(__dirname, '../assets/admin-dayview.js'), 'utf8');
  assert.match(html, /id="dvUnscheduled"/);
  assert.match(html, /id="dvWithdrawals"/);
  assert.match(html, /action: 'decide_withdrawal'/);
  assert.match(dv, /function renderUnscheduled/);
  assert.match(dv, /data-dv-open/);
});
