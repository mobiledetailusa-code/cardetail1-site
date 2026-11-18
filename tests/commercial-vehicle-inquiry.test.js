'use strict';

/**
 * Commercial & specialty vehicle quote requests (phase 1).
 *
 * - netlify/lib/vehicle-inquiry.js: allowlist, validation, sanitization, storage.
 * - netlify/functions/submit-inquiry.js: stores every inquiry, keeps the admin
 *   email + SMS notifications, and never prices or books anything.
 * - index.html: the Commercial & Specialty form (real block, run in jsdom).
 * - Booking guards: unlisted cars and fleet still cannot get a public price.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const revenueStore = require('../netlify/lib/revenue-store');
const rateLimit = require('../netlify/lib/public-rate-limit');
const smsOutbox = require('../netlify/lib/sms-outbox');
const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
const {
  VEHICLE_CATEGORIES,
  buildInquiryRecord,
} = require('../netlify/lib/vehicle-inquiry');
const { handler } = require('../netlify/functions/submit-inquiry');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');
const { validateBookingRouting } = require('../netlify/lib/booking-routing-validation');

const SCHOOL_BUS = {
  name: 'Dana Fleet',
  phone: '(201) 555-0142',
  email: 'Ops@Example.com',
  zip: '07601',
  source: 'Booking - commercial & specialty',
  message: 'Commercial / specialty vehicle quote request.',
  vehicle: {
    category: 'school_bus',
    year: '2019',
    make: 'Blue Bird',
    model: 'Vision',
    passengerCapacity: '72',
    wheelchairSpaces: '2',
    lengthFt: '40',
    services: ['exterior_wash', 'interior_cleaning', 'sanitizing'],
    extras: ['roof_cleaning', 'undercarriage_wash'],
    notes: 'Six buses, monthly.',
  },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function withVehicle(patch) {
  const body = clone(SCHOOL_BUS);
  body.vehicle = { ...body.vehicle, ...patch };
  return body;
}

function postEvent(body) {
  return {
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.7' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

// Same contract as Netlify Blobs: `onlyIfNew` / `onlyIfMatch` are atomic
// conditional writes (the check and the write happen with no await between),
// and strong reads return { data, etag } or null.
function memoryStore({ failKey = null, failRead = null } = {}) {
  const map = new Map();
  const etags = new Map();
  let n = 0;
  return {
    map,
    async set(key, value, opts = {}) {
      await new Promise((r) => setImmediate(r)); // let concurrent requests interleave
      if (failKey && failKey(key, value)) throw new Error('blob write failed');
      if (opts.onlyIfNew && map.has(key)) return { modified: false };
      if (opts.onlyIfMatch && etags.get(key) !== opts.onlyIfMatch) return { modified: false };
      map.set(key, value);
      const etag = `"e${++n}"`;
      etags.set(key, etag);
      return { modified: true, etag };
    },
    async get(key) { return map.get(key) || null; },
    async getWithMetadata(key, opts = {}) {
      await new Promise((r) => setImmediate(r));
      assert.equal(opts.consistency, 'strong', `strong read for ${key}`);
      if (failRead && failRead(key)) throw new Error('blob read failed');
      if (!map.has(key)) return null;
      return { data: map.get(key), etag: etags.get(key), metadata: {} };
    },
    async delete(key) { map.delete(key); etags.delete(key); },
    async list({ prefix = '' } = {}) {
      return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })) };
    },
  };
}

// ── harness: storage, email (Resend via fetch) and SMS outbox doubles ──────────
const ENV_KEYS = ['ADMIN_EMAIL', 'RESEND_API_KEY', 'ADMIN_SMS', 'CONTEXT', 'NETLIFY_CONTEXT', 'BRANCH'];
let saved;
let store;
let emails;
let smsCalls;
let storeFails;
let emailFails;
let smsFails;

beforeEach(() => {
  saved = {
    env: Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])),
    getRevenueStore: revenueStore.getRevenueStore,
    enqueueSms: smsOutbox.enqueueSms,
    fetch: global.fetch,
  };
  process.env.ADMIN_EMAIL = 'owner@example.test';
  process.env.RESEND_API_KEY = 're_test_dummy';
  process.env.ADMIN_SMS = '+15550000000';
  process.env.CONTEXT = 'production';
  delete process.env.NETLIFY_CONTEXT;
  delete process.env.BRANCH;
  store = memoryStore();
  emails = [];
  smsCalls = [];
  storeFails = false;
  emailFails = false;
  smsFails = false;
  revenueStore.getRevenueStore = async (name) => {
    assert.equal(name, 'inquiries');
    if (storeFails) throw new Error('blobs down');
    return store;
  };
  smsOutbox.enqueueSms = async (args) => {
    smsCalls.push(args);
    if (smsFails) return { ok: false, error: 'outbox_down' };
    return { ok: true, queued: true, outbox: { id: 'sms_1' } };
  };
  global.fetch = async (url, init) => {
    // Anything else (the Blobs SDK talking to the local BlobsServer) goes through.
    if (String(url) !== 'https://api.resend.com/emails') return saved.fetch(url, init);
    emails.push(JSON.parse(init.body));
    if (emailFails) return { ok: false, status: 500, text: async () => 'down' };
    return { ok: true, status: 200, text: async () => '' };
  };
  rateLimit.setPublicRateLimitStoreFactory(() => memoryStore());
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved.env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  revenueStore.getRevenueStore = saved.getRevenueStore;
  smsOutbox.enqueueSms = saved.enqueueSms;
  global.fetch = saved.fetch;
  rateLimit.resetPublicRateLimitStoreFactory();
});

async function submit(body) {
  const res = await handler(postEvent(body));
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function storedRecords() {
  return [...store.map.entries()].filter(([k]) => k.startsWith('rec/')).map(([, v]) => JSON.parse(v));
}

describe('submit-inquiry: commercial & specialty quote requests', () => {
  it('stores every structured field and notifies the owner by email and SMS', async () => {
    const res = await submit(SCHOOL_BUS);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, 'sent');
    assert.match(res.body.id, /^INQ-[A-Z0-9]+-[A-F0-9]{6}$/);
    assert.deepEqual(Object.keys(res.body).sort(), ['id', 'ok', 'status'], 'no provider details in the response');

    const [rec] = storedRecords();
    assert.equal(storedRecords().length, 1);
    assert.equal(rec.id, res.body.id);
    assert.equal(rec.kind, 'vehicle_quote');
    assert.equal(rec.status, 'new');
    assert.equal(rec.zip, '07601');
    assert.equal(rec.email, 'ops@example.com');
    assert.deepEqual(rec.vehicle, {
      category: 'school_bus',
      categoryLabel: 'School bus',
      year: 2019,
      make: 'Blue Bird',
      model: 'Vision',
      passengerCapacity: 72,
      wheelchairSpaces: 2,
      lengthFt: 40,
      services: ['exterior_wash', 'interior_cleaning', 'sanitizing'],
      extras: ['roof_cleaning', 'undercarriage_wash'],
      notes: 'Six buses, monthly.',
    });
    assert.ok(rec.retentionExpiresAt);

    assert.equal(emails.length, 1);
    assert.deepEqual(emails[0].to, ['owner@example.test']);
    assert.equal(emails[0].reply_to, 'ops@example.com');
    assert.match(emails[0].subject, /quote request — Dana Fleet/);
    for (const line of [/Category: School bus/, /Vehicle: 2019 Blue Bird Vision/, /Passenger capacity: 72/,
      /Wheelchair spaces: 2/, /Approx\. length: 40 ft/, /Services: Exterior wash, Interior cleaning, Sanitizing/,
      /Extras: Roof cleaning, Undercarriage wash/, /ZIP: {3}07601/]) {
      assert.match(emails[0].text, line);
    }

    assert.equal(smsCalls.length, 1);
    assert.equal(smsCalls[0].templateKey, TEMPLATE_KEYS.ADMIN_INQUIRY);
    assert.equal(smsCalls[0].audience, 'admin');
    assert.equal(smsCalls[0].toE164, '+15550000000');
    assert.match(smsCalls[0].templateData.message, /School bus; Vehicle: 2019 Blue Bird Vision; Passenger capacity: 72/);
  });

  it('never stores price, tier, booking or payment fields the browser sends', async () => {
    const body = clone(SCHOOL_BUS);
    Object.assign(body, { price: 1, totalPrice: 1, tierKey: 'small', basePrice: 1, payMethod: 'card', bookingId: 'B1', status: 'Confirmed' });
    Object.assign(body.vehicle, { price: 1, tierKey: 'small', units: 99 });
    const res = await submit(body);
    assert.equal(res.status, 200);
    const [rec] = storedRecords();
    const all = JSON.stringify(rec);
    for (const k of ['price', 'totalPrice', 'tierKey', 'basePrice', 'payMethod', 'bookingId', 'units']) {
      assert.equal(all.includes(`"${k}"`), false, k);
    }
    assert.equal(rec.status, 'new');
  });

  it('keeps only the details that apply to the vehicle type', () => {
    const { record } = buildInquiryRecord(withVehicle({ category: 'box_truck', passengerCapacity: '12', wheelchairSpaces: '1', lengthFt: '26' }));
    assert.equal(record.vehicle.lengthFt, 26);
    assert.equal(record.vehicle.passengerCapacity, undefined);
    assert.equal(record.vehicle.wheelchairSpaces, undefined);
    const van = buildInquiryRecord(withVehicle({ category: 'passenger_van', passengerCapacity: '15', lengthFt: '22' })).record;
    assert.equal(van.vehicle.passengerCapacity, 15);
    assert.equal(van.vehicle.lengthFt, undefined);
  });

  it('a car missing from the catalog can request a quote with make, model and year', async () => {
    const res = await submit({
      id: 'INQ-ABC123',
      name: 'Pat',
      phone: '2015550100',
      zip: '07650',
      source: 'Booking - vehicle not listed',
      message: 'Vehicle not listed in online booking - quote request.',
      vehicle: { category: 'car_suv', year: '1987', make: 'Studebaker', model: 'Avanti', notes: 'Show car' },
    });
    assert.equal(res.status, 200);
    const [rec] = storedRecords();
    assert.equal(rec.vehicle.category, 'car_suv');
    assert.equal(rec.vehicle.make, 'Studebaker');
    assert.equal(rec.vehicle.year, 1987);
    assert.equal(rec.clientRef, 'INQ-ABC123');
    assert.notEqual(rec.id, 'INQ-ABC123', 'the storage key is server-generated');
  });
});

describe('submit-inquiry: server validation', () => {
  const rejects = [
    ['unknown vehicle type', withVehicle({ category: 'spaceship' }), 'category'],
    ['vehicle is not an object', { ...clone(SCHOOL_BUS), vehicle: 'bus' }, 'vehicle'],
    ['bus without passenger capacity', withVehicle({ passengerCapacity: '' }), 'passengerCapacity'],
    ['capacity out of range', withVehicle({ passengerCapacity: '500' }), 'passengerCapacity'],
    ['capacity not a whole number', withVehicle({ passengerCapacity: '12.5' }), 'passengerCapacity'],
    ['negative wheelchair spaces', withVehicle({ wheelchairSpaces: '-1' }), 'wheelchairSpaces'],
    ['more wheelchair spaces than seats', withVehicle({ passengerCapacity: '4', wheelchairSpaces: '6' }), 'wheelchairSpaces'],
    ['length out of range', withVehicle({ lengthFt: '200' }), 'lengthFt'],
    ['year out of range', withVehicle({ year: '1890' }), 'year'],
    ['year far in the future', withVehicle({ year: '2099' }), 'year'],
    ['unknown service', withVehicle({ services: ['exterior_wash', 'ceramic_free'] }), 'services'],
    ['services not a list', withVehicle({ services: 'exterior_wash' }), 'services'],
    ['no service chosen', withVehicle({ services: [] }), 'services'],
    ['unknown extra', withVehicle({ extras: ['paint'] }), 'extras'],
    ['car without make', { name: 'A', phone: '2015550100', vehicle: { category: 'car_suv', model: 'X' } }, 'make'],
    ['invalid email', { ...clone(SCHOOL_BUS), email: 'not-an-email' }, 'email'],
  ];
  for (const [label, body, field] of rejects) {
    it(`rejects: ${label}`, async () => {
      const res = await submit(body);
      assert.equal(res.status, 400, label);
      assert.equal(res.body.ok, false);
      assert.ok(res.body.fields.includes(field), `${label}: ${JSON.stringify(res.body.fields)}`);
      assert.equal(store.map.size, 0, 'nothing stored');
      assert.equal(emails.length + smsCalls.length, 0, 'nothing sent');
    });
  }

  it('rejects missing contact details and bad JSON', async () => {
    assert.equal((await submit({ ...clone(SCHOOL_BUS), name: '   ' })).status, 400);
    assert.equal((await submit({ ...clone(SCHOOL_BUS), phone: '555-0100' })).status, 400, 'quote requests need an area code');
    assert.equal((await submit('{nope')).status, 400);
    assert.equal((await submit('[]')).status, 400);
    assert.equal(store.map.size, 0);
  });

  it('strips control characters and caps field lengths', async () => {
    const res = await submit({
      ...clone(SCHOOL_BUS),
      name: 'Dana\r\nBcc: x@evil.test\u0000',
      vehicle: { ...SCHOOL_BUS.vehicle, make: 'Blue‮Bird', notes: 'n'.repeat(5000) },
    });
    assert.equal(res.status, 200);
    const [rec] = storedRecords();
    assert.equal(rec.name, 'Dana Bcc: x@evil.test');
    assert.equal(rec.vehicle.make, 'BlueBird');
    assert.equal(rec.vehicle.notes.length, 1000);
    assert.doesNotMatch(emails[0].subject, /[\r\n]/);
  });
});

describe('submit-inquiry: existing chat questions and notifications', () => {
  it('a chat question is stored and sent exactly as before', async () => {
    const res = await submit({ id: 'INQ-LX1', name: 'Sam', phone: '201-555-0100', email: '', message: 'Do you do boats?', source: 'Chat widget' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, 'sent');
    const [rec] = storedRecords();
    assert.equal(rec.kind, 'question');
    assert.equal(rec.vehicle, null);
    assert.match(emails[0].subject, /^New Cardetail1 question — Sam \(201-555-0100\)$/);
    assert.match(emails[0].text, /^NEW CUSTOMER QUESTION — INQ-/);
    assert.match(emails[0].text, /Do you do boats\?/);
    assert.equal(smsCalls[0].templateData.message, 'Do you do boats?');
    assert.equal(smsCalls[0].templateData.customerName, 'Sam');
  });

  it('chat keeps accepting short phones and drops a malformed optional email', async () => {
    const res = await submit({ name: 'Sam', phone: '555-0100', email: 'sam@', message: 'hi' });
    assert.equal(res.status, 200);
    assert.equal(emails[0].reply_to, undefined);
    assert.equal(storedRecords()[0].email, '');
  });

  it('storage failure still sends the notifications', async () => {
    storeFails = true;
    const res = await submit(SCHOOL_BUS);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'sent', 'the team was alerted, so this is a real success');
    assert.equal(store.map.size, 0);
    assert.equal(emails.length, 1);
    assert.equal(smsCalls.length, 1);
  });

  it('saved but no channel reached the team: explicit 202 saved_not_notified, visible to admins', async () => {
    emailFails = true; smsFails = true;
    const res = await submit(SCHOOL_BUS);
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, 'saved_not_notified');
    assert.equal(res.body.email, undefined, 'no provider details');
    assert.equal(res.body.sms, undefined, 'no provider details');
    assert.match(res.body.message, /no need to send it again/);
    const [rec] = storedRecords();
    assert.equal(rec.id, res.body.id);
    assert.equal(rec.notification.state, 'failed');
    assert.equal(rec.notification.email, 'failed');
    assert.equal(rec.notification.sms, 'failed');
  });

  it('a delivered request records the alert outcome on the stored record', async () => {
    const res = await submit(SCHOOL_BUS);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'sent');
    const [rec] = storedRecords();
    assert.deepEqual({ state: rec.notification.state, email: rec.notification.email, sms: rec.notification.sms },
      { state: 'sent', email: 'sent', sms: 'queued' });
  });

  it('reports failure when nothing was stored or delivered, so the page shows the phone number', async () => {
    storeFails = true; emailFails = true; smsFails = true;
    const res = await submit(SCHOOL_BUS);
    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.status, 'not_delivered');
    assert.equal(res.body.email, undefined);
  });

  it('two requests in the same millisecond get separate records', async () => {
    await submit(SCHOOL_BUS);
    await submit(SCHOOL_BUS);
    assert.equal(storedRecords().length, 2);
  });

  it('preview and branch deploys still store and send nothing', async () => {
    process.env.CONTEXT = 'deploy-preview';
    const res = await submit(SCHOOL_BUS);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'preview_writes_disabled');
    assert.equal(store.map.size + emails.length + smsCalls.length, 0);
  });
});

describe('unsupported vehicles cannot get a public booking price', () => {
  it('a car outside the catalog is refused by server pricing', () => {
    const booking = {
      zipCode: '07601',
      totalPrice: 250,
      vehicles: [{ cat: 'cars', pkgId: 'full', addons: [], make: 'Studebaker', model: 'Avanti', year: 1987, tierKey: 'small', basePrice: 250, subtotal: 250 }],
    };
    const result = applyServerTravelAndTotal(booking, { catalogTierMode: 'require_identity' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'vehicle_unresolved');
  });

  it('commercial / fleet categories are still routed to a quote, never a booking', () => {
    assert.equal(validateBookingRouting({ zipCode: '07601', vehicles: [{ cat: 'fleet', units: 3 }] }).error, 'fleet_quote_required');
    assert.equal(validateBookingRouting({ zipCode: '07601', vehicles: [{ cat: 'cars' }], isCommercial: true }).ok, false);
  });
});

// ── browser: the real Commercial & Specialty block from index.html ─────────────
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `block not found: ${startMarker}`);
  return index.slice(start, end);
}

function makeSandbox(opts = {}) {
  const markup = slice('<!-- Commercial & specialty vehicles', '<div id="cd-chat">');
  const code = slice('// ── COMMERCIAL & SPECIALTY', 'function launchBooking(');
  const dom = new JSDOM(`<!DOCTYPE html><body><input id="bk-zip" value="07601"><div id="bk-ov" class="open"></div>${markup}</body>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  const calls = { fetch: [], closed: 0 };
  Object.assign(w, {
    INQUIRY_URL: '/.netlify/functions/submit-inquiry',
    ADMIN_SMS: '+15513893986',
    ST: { cat: 'cars', tierKey: 'small', basePrice: 250, pkgId: 'full' },
    forceCloseBooking() { calls.closed += 1; w.document.getElementById('bk-ov').classList.remove('open'); },
    cdToggle() { throw new Error('chat should not open when the form exists'); },
    fetch: async (url, init) => {
      calls.fetch.push({ url, body: JSON.parse(init.body) });
      if (opts.responses && opts.responses.length) {
        const r = opts.responses.shift();
        if (r === 'throw') throw new Error('offline');
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
      }
      if (opts.fetchFails) throw new Error('offline');
      return { ok: true, json: async () => ({ ok: true, id: 'INQ-X', status: 'sent' }) };
    },
  });
  w.eval(code + '\nwindow.__CS_FIELDS=CS_FIELDS;');
  const doc = w.document;
  const set = (id, v) => { doc.getElementById(id).value = v; };
  const check = (value) => { doc.querySelector(`input[value="${value}"]`).checked = true; };
  const status = () => doc.getElementById('cs-status').textContent;
  const submitForm = () => w.submitCommercialForm({ preventDefault() {} });
  return { w, doc, calls, set, check, status, submitForm };
}

describe('Commercial & Specialty form (index.html)', () => {
  it('the booking grid has a Commercial & Specialty tile that opens the form, not a booking', () => {
    assert.match(index, /id="bkcat-commercial"[^>]*onclick="openCommercialInquiry\(\)"/);
    assert.doesNotMatch(index, /selectCategory\('commercial'\)/);
    const sb = makeSandbox();
    sb.w.openCommercialInquiry();
    assert.equal(sb.doc.getElementById('cs-ov').hidden, false);
    assert.equal(sb.calls.closed, 1, 'booking modal closed');
    assert.equal(sb.w.ST.cat, '');
    assert.equal(sb.w.ST.tierKey, '');
    assert.equal(sb.w.ST.basePrice, 0);
    assert.equal(sb.doc.getElementById('cs-zip').value, '07601', 'ZIP carried over');
  });

  it('the car search says "Can’t find your vehicle?"', () => {
    assert.match(index, /id="car-unlisted-btn"[^>]*>Can’t find your vehicle\?<\/button>/);
  });

  it('browser field rules match the server categories', () => {
    const sb = makeSandbox();
    const client = sb.w.__CS_FIELDS;
    const server = Object.keys(VEHICLE_CATEGORIES).filter((k) => k !== 'car_suv');
    assert.deepEqual(Object.keys(client).sort(), server.sort());
    for (const k of server) {
      assert.deepEqual([...client[k].fields], VEHICLE_CATEGORIES[k].fields, k);
      assert.equal(Boolean(client[k].cap), Boolean(VEHICLE_CATEGORIES[k].requireCapacity), k);
    }
    const options = [...sb.doc.querySelectorAll('#cs-category option')].map((o) => o.value).filter(Boolean);
    assert.deepEqual(options.sort(), server.sort());
  });

  it('shows seats, wheelchair spaces and length only when relevant', () => {
    const sb = makeSandbox();
    const visible = () => [...sb.doc.querySelectorAll('[data-cs-field]')].filter((el) => !el.hidden).map((el) => el.getAttribute('data-cs-field'));
    sb.set('cs-category', 'box_truck'); sb.w.syncCommercialFields();
    assert.deepEqual(visible(), ['lengthFt']);
    sb.set('cs-category', 'paratransit'); sb.w.syncCommercialFields();
    assert.deepEqual(visible(), ['passengerCapacity', 'wheelchairSpaces', 'lengthFt']);
  });

  it('validates, then sends the structured request with no price', async () => {
    const sb = makeSandbox();
    sb.w.openCommercialInquiry();
    await sb.submitForm();
    assert.match(sb.status(), /vehicle type/);
    sb.set('cs-category', 'shuttle_bus'); sb.w.syncCommercialFields();
    await sb.submitForm();
    assert.match(sb.status(), /passenger seats/i);
    sb.set('cs-capacity', '24'); sb.set('cs-wheelchair', '2'); sb.set('cs-length', '300');
    await sb.submitForm();
    assert.match(sb.status(), /Length/);
    sb.set('cs-length', '28');
    await sb.submitForm();
    assert.match(sb.status(), /cleaning service/);
    sb.check('interior_cleaning'); sb.check('roof_cleaning');
    sb.set('cs-name', 'Lee'); sb.set('cs-phone', '555');
    await sb.submitForm();
    assert.match(sb.status(), /phone/i);
    assert.equal(sb.calls.fetch.length, 0);

    sb.set('cs-phone', '(201) 555-0150'); sb.set('cs-make', 'Ford'); sb.set('cs-model', 'E-450'); sb.set('cs-year', '2018');
    await sb.submitForm();
    assert.equal(sb.calls.fetch.length, 1);
    const { url, body } = sb.calls.fetch[0];
    assert.equal(url, '/.netlify/functions/submit-inquiry');
    assert.equal(body.source, 'Booking - commercial & specialty');
    assert.equal(body.zip, '07601');
    assert.deepEqual(body.vehicle, {
      category: 'shuttle_bus', year: '2018', make: 'Ford', model: 'E-450',
      services: ['interior_cleaning'], extras: ['roof_cleaning'], notes: '',
      passengerCapacity: 24, wheelchairSpaces: 2, lengthFt: 28,
    });
    for (const k of ['price', 'tierKey', 'basePrice', 'total', 'amount']) assert.equal(body[k], undefined, k);
    assert.match(sb.status(), /Nothing has been booked or charged/);

    // What the browser sends is accepted by the server as-is.
    const built = buildInquiryRecord(body);
    assert.equal(built.ok, true, JSON.stringify(built.fields));
    assert.equal(built.record.vehicle.passengerCapacity, 24);
  });

  it('a failed send shows the phone number instead of claiming success', async () => {
    const sb = makeSandbox({ fetchFails: true });
    sb.set('cs-category', 'cargo_van'); sb.check('exterior_wash');
    sb.set('cs-name', 'Lee'); sb.set('cs-phone', '2015550150');
    await sb.submitForm();
    assert.match(sb.status(), /389-3986/);
    assert.equal(sb.doc.querySelector('#cs-status a').getAttribute('href'), 'tel:+15513893986');
  });
});

// ── idempotency, concurrency and storage failure ───────────────────────────────
const SUB_ID = '3f1c2b9e-6a0d-4c3e-9b1f-7d2a5e8c4b10';
function withSubmission(body, submissionId = SUB_ID) { return { ...clone(body), submissionId }; }

describe('submit-inquiry: duplicate and concurrent submissions', () => {
  it('a retry with the same submission id keeps one record and sends one alert', async () => {
    const first = await submit(withSubmission(SCHOOL_BUS));
    const second = await submit(withSubmission(SCHOOL_BUS));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.id, first.body.id);
    assert.equal(storedRecords().length, 1);
    assert.equal(emails.length, 1);
    assert.equal(smsCalls.length, 1);
  });

  it('concurrent duplicates create exactly one record and one email + SMS', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => submit(withSubmission(SCHOOL_BUS))));
    const statuses = results.map((r) => r.body.status);
    assert.equal(results.filter((r) => r.status === 200 && r.body.status === 'sent' && !r.body.duplicate).length, 1, JSON.stringify(statuses));
    for (const r of results) {
      if (r.body.status === 'sent') continue;
      assert.equal(r.status, 409, JSON.stringify(statuses));
      assert.equal(r.body.status, 'processing');
      assert.equal(r.body.retryable, true);
      assert.equal(r.body.ok, false, 'never a false success');
    }
    assert.equal(new Set(results.map((r) => r.body.id).filter(Boolean)).size, 1, 'every response names the same request');
    assert.equal(storedRecords().length, 1);
    assert.equal(emails.length, 1);
    assert.equal(smsCalls.length, 1);
  });

  it('separate requests stay separate: new submission id, or a different customer', async () => {
    await submit(withSubmission(SCHOOL_BUS, SUB_ID));
    await submit(withSubmission(SCHOOL_BUS, 'a7b6c5d4-e3f2-4a1b-8c9d-0e1f2a3b4c5d'));
    await submit({ ...withSubmission(SCHOOL_BUS, SUB_ID), phone: '(973) 555-0177' });
    await submit(SCHOOL_BUS); // no submission id (chat widget): never deduplicated
    assert.equal(storedRecords().length, 4);
    assert.equal(emails.length, 4);
  });

  it('a retry of a saved-but-not-alerted request repeats the 202 and sends nothing new', async () => {
    emailFails = true; smsFails = true;
    const first = await submit(withSubmission(SCHOOL_BUS));
    emailFails = false; smsFails = false;
    const retry = await submit(withSubmission(SCHOOL_BUS));
    assert.equal(first.status, 202);
    assert.equal(retry.status, 202);
    assert.equal(retry.body.status, 'saved_not_notified');
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.id, first.body.id);
    assert.equal(storedRecords().length, 1);
    assert.equal(emails.length, 1, 'only the original attempt');
  });

  it('rejects a malformed submission id', async () => {
    const res = await submit(withSubmission(SCHOOL_BUS, 'short'));
    assert.equal(res.status, 400);
    assert.ok(res.body.fields.includes('submissionId'));
    const res2 = await submit(withSubmission(SCHOOL_BUS, '../../etc/passwd/xxxxxxxxxxxx'));
    assert.equal(res2.status, 400);
    assert.equal(store.map.size, 0);
  });

  it('a record write failure releases the claim so the retry is stored, not swallowed', async () => {
    let failRecords = true;
    store = memoryStore({ failKey: (k) => failRecords && k.startsWith('rec/') });
    const first = await submit(withSubmission(SCHOOL_BUS));
    assert.equal(first.status, 200, 'notifications still went out');
    assert.equal(first.body.status, 'sent');
    assert.equal(store.map.size, 0, 'claim released');
    failRecords = false;
    const retry = await submit(withSubmission(SCHOOL_BUS));
    assert.equal(retry.body.status, 'sent');
    assert.notEqual(retry.body.duplicate, true);
    assert.equal(storedRecords().length, 1);
  });
});

// ── admin read access (existing admin session auth) ───────────────────────────
const adminInquiries = require('../netlify/functions/admin-inquiries');
const { createAdminSession } = require('../netlify/lib/admin-security');
const ADMIN_SECRET = 'test-admin-session-secret-0123456789abcdef0123456789';

describe('admin-inquiries: authenticated, read-only retrieval', () => {
  let adminEnv;
  beforeEach(() => {
    adminEnv = { s: process.env.ADMIN_SESSION_SECRET, p: process.env.ADMIN_DASH_PASSWORD };
    process.env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
    process.env.ADMIN_DASH_PASSWORD = 'test-admin-dash-password-key';
  });
  afterEach(() => {
    if (adminEnv.s === undefined) delete process.env.ADMIN_SESSION_SECRET; else process.env.ADMIN_SESSION_SECRET = adminEnv.s;
    if (adminEnv.p === undefined) delete process.env.ADMIN_DASH_PASSWORD; else process.env.ADMIN_DASH_PASSWORD = adminEnv.p;
  });

  async function adminGet(headers = {}, method = 'GET') {
    const res = await adminInquiries.handler({ httpMethod: method, headers, queryStringParameters: { limit: '50' } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('an admin session sees stored requests, newest first, with every displayed field', async () => {
    const older = await submit(SCHOOL_BUS);
    await new Promise((r) => setTimeout(r, 5));
    emailFails = true; smsFails = true;
    const newer = await submit({ name: 'Sam', phone: '201-555-0100', message: 'Do you do boats?' });
    const { token } = await createAdminSession('admin');
    for (const headers of [{ 'x-admin-key': token }, { cookie: 'cd1_admin_session=' + token }]) {
      const res = await adminGet(headers);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.inquiries.map((q) => q.id), [newer.body.id, older.body.id]);
      const bus = res.body.inquiries[1];
      assert.ok(bus.createdAt);
      assert.equal(bus.status, 'new');
      assert.deepEqual(bus.contact, { name: 'Dana Fleet', phone: '(201) 555-0142', email: 'ops@example.com', zip: '07601' });
      assert.equal(bus.vehicle.categoryLabel, 'School bus');
      assert.equal(bus.vehicle.passengerCapacity, 72);
      assert.equal(bus.vehicle.wheelchairSpaces, 2);
      assert.equal(bus.vehicle.lengthFt, 40);
      assert.deepEqual(bus.services, ['Exterior wash', 'Interior cleaning', 'Sanitizing / disinfection']);
      assert.deepEqual(bus.extras, ['Roof cleaning', 'Undercarriage wash']);
      assert.equal(bus.notification.state, 'sent');
      assert.equal(res.body.inquiries[0].notification.state, 'failed', 'not-alerted request is flagged');
      assert.equal(res.body.inquiries[0].vehicle, null);
    }
  });

  it('refuses requests without a valid admin session', async () => {
    await submit(SCHOOL_BUS);
    for (const headers of [{}, { 'x-admin-key': 'not-a-real-token-123456' }, { 'x-admin-key': 'cd1s.' + 'x'.repeat(40) },
      { cookie: 'cd1_admin_session=forged-session-token-value' }]) {
      const res = await adminGet(headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal(res.body.inquiries, undefined);
    }
    const { token } = await createAdminSession('admin');
    process.env.ADMIN_SESSION_SECRET = 'a-different-secret-0123456789abcdef0123456789';
    assert.equal((await adminGet({ 'x-admin-key': token })).status, 401, 'token signed with another secret');
  });

  it('fails closed when admin auth is not configured', async () => {
    delete process.env.ADMIN_DASH_PASSWORD;
    const res = await adminGet({ 'x-admin-key': 'anything-long-enough-1234' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'missing_admin_config');
  });

  it('is read-only: other methods are refused even for an admin', async () => {
    const { token } = await createAdminSession('admin');
    for (const m of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await adminGet({ 'x-admin-key': token }, m)).status, 405, m);
    }
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-inquiries.js'), 'utf8');
    assert.doesNotMatch(src, /\.set\(|blobSetJson|blobCreateJson|\.delete\(/);
  });

  it('reports storage unavailable instead of an empty list', async () => {
    storeFails = true;
    const { token } = await createAdminSession('admin');
    const res = await adminGet({ 'x-admin-key': token });
    assert.equal(res.status, 503);
  });

  it('admin-ops has a Quote requests tab wired to the endpoint, escaping customer text', () => {
    const adminOps = fs.readFileSync(path.join(ROOT, 'admin-ops.html'), 'utf8');
    assert.match(adminOps, /data-tab="inquiries"[^>]*>Quote requests</);
    assert.match(adminOps, /id="p-inquiries"/);
    assert.match(adminOps, /if \(b\.dataset\.tab === 'inquiries'\) refreshInquiriesTab\(\);/);
    assert.match(adminOps, /api\('\/\.netlify\/functions\/admin-inquiries\?limit=100', 'GET'\)/);
    const fn = adminOps.slice(adminOps.indexOf('function inquiryRowHtml'), adminOps.indexOf('async function refreshInquiriesTab'));
    assert.doesNotMatch(fn, /\+ (c|q|v)\.(name|phone|email|zip|message|id|make|model) \+/, 'customer fields are escaped');
  });
});

// ── real @netlify/blobs SDK against the local BlobsServer (no network, no prod) ─
describe('storage contract: real @netlify/blobs SDK + local BlobsServer', () => {
  const os = require('node:os');
  const { getStore } = require('@netlify/blobs');
  const { BlobsServer } = require('@netlify/blobs/server');
  let server;
  let dir;
  let realStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd1-inq-blobs-'));
    server = new BlobsServer({ directory: dir, token: 'local-inquiry-token' });
    const { port } = await server.start();
    realStore = getStore({ edgeURL: `http://127.0.0.1:${port}`, uncachedEdgeURL: `http://127.0.0.1:${port}`, name: 'revenue-inquiries', token: 'local-inquiry-token', siteID: 'local-inquiry-site' });
    revenueStore.getRevenueStore = async (name) => {
      assert.equal(name, 'inquiries');
      if (storeFails) throw new Error('blobs down');
      return realStore;
    };
  });
  afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('onlyIfNew returns modified:false for an existing key (the dedupe primitive)', async () => {
    const a = await realStore.set('sub/abc', '{"id":"1"}', { onlyIfNew: true });
    const b = await realStore.set('sub/abc', '{"id":"2"}', { onlyIfNew: true });
    assert.equal(a.modified, true);
    assert.equal(b.modified, false);
    assert.equal(await realStore.get('sub/abc', { type: 'text' }), '{"id":"1"}');
  });

  it('stores, deduplicates, records the alert outcome and lists for admins through the real SDK', async () => {
    const first = await submit(withSubmission(SCHOOL_BUS));
    const retry = await submit(withSubmission(SCHOOL_BUS));
    await new Promise((r) => setTimeout(r, 5));
    const chat = await submit({ name: 'Sam', phone: '201-555-0100', message: 'Boats?' });
    assert.equal(first.body.status, 'sent');
    assert.equal(retry.body.status, 'sent', 'retry of a confirmed request');
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.id, first.body.id);
    assert.equal(emails.length, 2, 'school bus once + chat once');

    const { blobs } = await realStore.list({ prefix: 'rec/' });
    assert.equal(blobs.length, 2);
    const claims = await realStore.list({ prefix: 'sub/' });
    assert.equal(claims.blobs.length, 1);

    const { listInquiries } = require('../netlify/lib/vehicle-inquiry');
    const listed = await listInquiries({ limit: 10 });
    assert.deepEqual(listed.inquiries.map((q) => q.id), [chat.body.id, first.body.id], 'newest first');
    assert.equal(listed.inquiries[1].vehicle.passengerCapacity, 72);
    assert.equal(listed.inquiries[1].notification.state, 'sent');
  });

  it('a claim whose record write failed is deleted through the real SDK', async () => {
    const realSet = realStore.set.bind(realStore);
    realStore.set = async (key, value, opts) => {
      if (key.startsWith('rec/')) throw new Error('write failed');
      return realSet(key, value, opts);
    };
    const res = await submit(withSubmission(SCHOOL_BUS));
    assert.equal(res.body.status, 'sent', 'alerted without storage');
    const claims = await realStore.list({ prefix: 'sub/' });
    assert.equal(claims.blobs.length, 0);
  });
});

// ── browser: stable submission id and the saved-not-notified message ───────────
describe('quote forms send a stable submission id', () => {
  it('the commercial form reuses its id on retry and starts a new one after a sent request', async () => {
    const sb = makeSandbox({ responses: ['throw', { status: 200, body: { ok: true, id: 'INQ-A', status: 'sent' } }] });
    sb.w.openCommercialInquiry();
    sb.set('cs-category', 'cargo_van'); sb.check('exterior_wash');
    sb.set('cs-name', 'Lee'); sb.set('cs-phone', '2015550150');
    await sb.submitForm();
    assert.match(sb.status(), /389-3986/);
    await sb.submitForm();
    const [a, b] = sb.calls.fetch.map((c) => c.body.submissionId);
    assert.match(a, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(b, a, 'retry reuses the id');
    assert.match(sb.status(), /Request sent/);
    sb.w.closeCommercialForm();
    sb.w.openCommercialInquiry();
    assert.equal(sb.doc.getElementById('cs-submit').disabled, false, 'a new request can be sent');
    sb.set('cs-category', 'cargo_van'); sb.check('exterior_wash');
    sb.set('cs-name', 'Lee'); sb.set('cs-phone', '2015550150');
    await sb.submitForm();
    assert.notEqual(sb.calls.fetch[2].body.submissionId, a, 'a new request gets a new id');
  });

  it('saved_not_notified is not shown as a normal success and tells the customer not to resend', async () => {
    const sb = makeSandbox({ responses: [{ status: 202, body: { ok: true, id: 'INQ-ZZ9-AB12CD', status: 'saved_not_notified', stored: true, notified: false } }] });
    sb.set('cs-category', 'cargo_van'); sb.check('exterior_wash');
    sb.set('cs-name', 'Lee'); sb.set('cs-phone', '2015550150');
    await sb.submitForm();
    assert.match(sb.status(), /saved \(ref INQ-ZZ9-AB12CD\)/);
    assert.match(sb.status(), /no need to send it again/);
    assert.doesNotMatch(sb.status(), /Request sent/);
    assert.equal(sb.doc.getElementById('cs-submit').disabled, true, 'resend is not offered');
  });

  it('the car not-listed form and the fleet page send a submission id', () => {
    const car = slice('async function submitCarUnlisted', 'function showCarNote');
    assert.match(car, /submissionId:form\.dataset\.submissionId/);
    assert.match(car, /saved_not_notified/);
    const fleet = fs.readFileSync(path.join(ROOT, 'fleet-services.html'), 'utf8');
    assert.match(fleet, /submissionId:submissionId/);
    assert.match(fleet, /saved_not_notified/);
  });
});

// ── notification recovery: claims, interruption, strict reads ─────────────────
const VI = require('../netlify/lib/vehicle-inquiry');

describe('submit-inquiry: notification recovery and truthful status', () => {
  const LATER = () => Date.now() + VI.NOTIFY_LEASE_MS + 60_000;
  afterEach(() => VI.__test.setClock(null));

  /** Seed the store as an earlier, interrupted request would have left it. */
  async function seed({ record: withRecord = true, notification = { state: 'pending' }, ntf = null } = {}) {
    const built = VI.buildInquiryRecord(withSubmission(SCHOOL_BUS));
    const record = { ...built.record, notification };
    const recordKey = VI.recordKeyFor(record);
    await store.set(`sub/${built.dedupeKey}`, JSON.stringify({ id: record.id, recordKey, createdAt: record.createdAt, at: record.createdAt }));
    if (withRecord) await store.set(recordKey, JSON.stringify(record));
    if (ntf) await store.set(`ntf/${record.id}`, JSON.stringify({ at: new Date().toISOString(), ...ntf }));
    return { record, recordKey };
  }
  const recordById = (id) => storedRecords().find((r) => r.id === id);
  const retry = () => submit(withSubmission(SCHOOL_BUS));

  it('pending record, never notified (no claim), then retry: sends once and confirms', async () => {
    const { record } = await seed();
    const res = await retry();
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'sent');
    assert.equal(res.body.id, record.id);
    assert.equal(emails.length, 1);
    assert.equal(smsCalls.length, 1);
    assert.equal(recordById(record.id).notification.state, 'sent');
    assert.equal(storedRecords().length, 1, 'no duplicate record');
    const again = await retry();
    assert.equal(again.body.status, 'sent');
    assert.equal(emails.length, 1, 'confirmed requests are never re-sent');
  });

  it('function interrupted before notification (claim write fails): truthful retry, then recovery', async () => {
    let failClaims = true;
    store = memoryStore({ failKey: (k) => failClaims && k.startsWith('ntf/') });
    const first = await retry();
    assert.equal(first.status, 503);
    assert.equal(first.body.status, 'retry');
    assert.equal(first.body.retryable, true);
    assert.equal(first.body.ok, false, 'no false success');
    assert.equal(emails.length + smsCalls.length, 0, 'nothing sent without a claim');
    assert.equal(storedRecords()[0].notification.state, 'pending');
    failClaims = false;
    const second = await retry();
    assert.equal(second.body.status, 'sent');
    assert.equal(second.body.id, first.body.id);
    assert.equal(emails.length, 1);
    assert.equal(storedRecords().length, 1);
  });

  it('outcome write fails after providers accepted: customer told sent, outcome kept on the claim, retry does not resend', async () => {
    let failOutcome = true;
    store = memoryStore({ failKey: (k, v) => failOutcome && k.startsWith('rec/') && /"state":"sent"/.test(v) });
    const first = await retry();
    assert.equal(first.body.status, 'sent', 'this process saw the providers accept');
    const rec = storedRecords()[0];
    assert.equal(rec.notification.state, 'pending', 'record update failed');
    const claim = JSON.parse(store.map.get(`ntf/${rec.id}`));
    assert.equal(claim.phase, 'done');
    assert.equal(claim.outcome.state, 'sent');
    failOutcome = false;
    const again = await retry();
    assert.equal(again.body.status, 'sent');
    assert.equal(emails.length, 1, 'not resent');
  });

  it('provider accepted but the function died before recording anything: never resent, flagged unknown', async () => {
    const { record } = await seed({ ntf: { phase: 'sending' } });
    const soon = await retry();
    assert.equal(soon.status, 409);
    assert.equal(soon.body.status, 'processing');
    assert.equal(soon.body.ok, false);
    VI.__test.setClock(LATER);
    const later = await retry();
    assert.equal(later.status, 202);
    assert.equal(later.body.status, 'saved_alert_unconfirmed');
    assert.equal(later.body.ok, true);
    assert.equal(later.body.id, record.id);
    assert.equal(emails.length + smsCalls.length, 0, 'no automatic resend when a provider may have accepted');
    assert.equal(recordById(record.id).notification.state, 'unknown', 'visible to admins');
    const again = await retry();
    assert.equal(again.body.status, 'saved_alert_unconfirmed');
    assert.equal(emails.length, 0);
  });

  it('orphaned claim (stale, no provider called) is taken over once; a fresh one is respected', async () => {
    const { record } = await seed({ ntf: { phase: 'claimed' } });
    const fresh = await retry();
    assert.equal(fresh.body.status, 'processing');
    assert.equal(emails.length, 0);
    VI.__test.setClock(LATER);
    const results = await Promise.all(Array.from({ length: 6 }, retry));
    const sent = results.filter((r) => r.body.status === 'sent');
    assert.equal(sent.length, 1, JSON.stringify(results.map((r) => r.body.status)));
    assert.ok(results.every((r) => ['sent', 'processing'].includes(r.body.status)));
    assert.equal(emails.length, 1, 'one takeover, one alert');
    assert.equal(smsCalls.length, 1);
    assert.equal(recordById(record.id).notification.state, 'sent');
    assert.equal(storedRecords().length, 1);
  });

  it('concurrent retries of a pending record send exactly one alert', async () => {
    await seed();
    const results = await Promise.all(Array.from({ length: 8 }, retry));
    assert.equal(results.filter((r) => r.body.status === 'sent').length, 1, JSON.stringify(results.map((r) => r.body.status)));
    assert.ok(results.every((r) => r.body.status === 'sent' || (r.status === 409 && r.body.ok === false)));
    assert.equal(emails.length, 1);
    assert.equal(smsCalls.length, 1);
    assert.equal(storedRecords().length, 1);
  });

  it('dedupe claim with a missing record: waits during the lease, then recovers once', async () => {
    await seed({ record: false });
    const soon = await retry();
    assert.equal(soon.status, 409);
    assert.equal(soon.body.status, 'processing');
    assert.equal(storedRecords().length, 0, 'no record created while the first request may still be writing');
    VI.__test.setClock(LATER);
    const results = await Promise.all(Array.from({ length: 5 }, retry));
    assert.equal(results.filter((r) => r.body.status === 'sent').length, 1, JSON.stringify(results.map((r) => r.body.status)));
    assert.equal(storedRecords().length, 1, 'exactly one record after recovery');
    assert.equal(emails.length, 1);
  });

  it('strict read failures return a retryable status and change nothing', async () => {
    for (const prefix of ['sub/', 'rec/', 'ntf/']) {
      store = memoryStore();
      await seed();
      const seededKeys = store.map.size;
      const fail = memoryStore({ failRead: (k) => k.startsWith(prefix) });
      for (const [k, v] of store.map) await fail.set(k, v);
      store = fail;
      emails.length = 0; smsCalls.length = 0;
      const res = await retry();
      assert.equal(res.status, 503, prefix);
      assert.equal(res.body.status, 'retry', prefix);
      assert.equal(res.body.retryable, true, prefix);
      assert.equal(res.body.ok, false, prefix);
      assert.equal(emails.length + smsCalls.length, 0, `${prefix}: nothing sent`);
      assert.equal(store.map.size, seededKeys, `${prefix}: nothing written`);
    }
  });

  it('an unreadable record is a storage error, not a success', async () => {
    const { recordKey } = await seed();
    await store.set(recordKey, '{not json');
    const res = await retry();
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'retry');
    assert.equal(emails.length, 0);
  });

  it('only state "sent" counts as notified; failed and unknown are reported as such', async () => {
    await seed({ notification: { state: 'failed' } });
    const failed = await retry();
    assert.equal(failed.status, 202);
    assert.equal(failed.body.status, 'saved_not_notified');
    store = memoryStore();
    await seed({ notification: { state: 'unknown' } });
    const unknown = await retry();
    assert.equal(unknown.status, 202);
    assert.equal(unknown.body.status, 'saved_alert_unconfirmed');
    store = memoryStore();
    await seed({ notification: undefined });
    VI.__test.setClock(LATER);
    await store.set(`ntf/${storedRecords()[0].id}`, JSON.stringify({ phase: 'sending', at: new Date().toISOString() }));
    const missing = await retry();
    assert.equal(missing.body.status, 'saved_alert_unconfirmed', 'a missing state is never treated as sent');
    assert.equal(emails.length, 0);
  });

  it('admins see a request left pending past the lease as unconfirmed', async () => {
    await seed();
    VI.__test.setClock(LATER);
    const { inquiries } = await VI.listInquiries({ limit: 5 });
    assert.equal(inquiries[0].notification.state, 'unknown');
  });

  it('public responses carry only status, id and customer-safe text', async () => {
    emailFails = true; smsFails = true;
    const res = await submit(SCHOOL_BUS);
    assert.deepEqual(Object.keys(res.body).sort(), ['id', 'message', 'ok', 'status']);
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/submit-inquiry.js'), 'utf8');
    const respondFn = src.slice(src.indexOf('function respond('));
    assert.doesNotMatch(respondFn, /\bemail\b|\bsms\b|reason|outbox/i, 'respond() never echoes provider details');
  });
});

describe('quote forms never claim "sent" without evidence', () => {
  const fill = (sb) => {
    sb.set('cs-category', 'cargo_van'); sb.check('exterior_wash');
    sb.set('cs-name', 'Lee'); sb.set('cs-phone', '2015550150');
  };
  for (const [label, response] of [
    ['ok without a status', { status: 200, body: { ok: true, id: 'INQ-A' } }],
    ['saved_alert_unconfirmed', { status: 202, body: { ok: true, id: 'INQ-A', status: 'saved_alert_unconfirmed' } }],
    ['processing', { status: 409, body: { ok: false, id: 'INQ-A', status: 'processing', retryable: true } }],
    ['retry', { status: 503, body: { ok: false, status: 'retry', retryable: true } }],
  ]) {
    it(`${label}: no "Request sent"`, async () => {
      const sb = makeSandbox({ responses: [response] });
      fill(sb);
      await sb.submitForm();
      assert.doesNotMatch(sb.status(), /Request sent/);
    });
  }

  it('processing/retry keep the button and the same submission id for a safe retry', async () => {
    const sb = makeSandbox({ responses: [
      { status: 409, body: { ok: false, status: 'processing', retryable: true } },
      { status: 200, body: { ok: true, id: 'INQ-A', status: 'sent' } },
    ] });
    fill(sb);
    await sb.submitForm();
    assert.match(sb.status(), /won’t create a duplicate/);
    assert.equal(sb.doc.getElementById('cs-submit').disabled, false);
    await sb.submitForm();
    assert.equal(sb.calls.fetch[1].body.submissionId, sb.calls.fetch[0].body.submissionId);
    assert.match(sb.status(), /Request sent/);
  });

  it('saved_alert_unconfirmed says saved and not to resend', async () => {
    const sb = makeSandbox({ responses: [{ status: 202, body: { ok: true, id: 'INQ-A1', status: 'saved_alert_unconfirmed' } }] });
    fill(sb);
    await sb.submitForm();
    assert.match(sb.status(), /saved \(ref INQ-A1\)/);
    assert.match(sb.status(), /couldn’t confirm our team was alerted/);
    assert.match(sb.status(), /no need to send it again/);
    assert.equal(sb.doc.getElementById('cs-submit').disabled, true);
  });

  it('the car form and the fleet page require status "sent" for a sent message', () => {
    const car = slice('async function submitCarUnlisted', 'function showCarNote');
    assert.match(car, /if\(ok&&body\.status==='sent'\)/);
    assert.match(car, /body&&body\.retryable/);
    const fleet = fs.readFileSync(path.join(ROOT, 'fleet-services.html'), 'utf8');
    assert.match(fleet, /if\(ok && data\.status==='sent'\)/);
    assert.match(fleet, /data && data\.retryable/);
  });
});
