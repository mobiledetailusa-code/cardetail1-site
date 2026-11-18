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

function memoryStore() {
  const map = new Map();
  return {
    map,
    async set(key, value, opts = {}) {
      if (opts.onlyIfNew && map.has(key)) return { modified: false };
      map.set(key, value);
      return { modified: true, etag: 'e1' };
    },
    async get(key) { return map.get(key) || null; },
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
    assert.equal(url, 'https://api.resend.com/emails');
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
  return [...store.map.values()].map((v) => JSON.parse(v));
}

describe('submit-inquiry: commercial & specialty quote requests', () => {
  it('stores every structured field and notifies the owner by email and SMS', async () => {
    const res = await submit(SCHOOL_BUS);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.stored, true);
    assert.match(res.body.id, /^INQ-[A-Z0-9]+-[A-F0-9]{6}$/);

    const [rec] = storedRecords();
    assert.equal(store.map.size, 1);
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
    assert.equal(res.body.stored, true);
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
    assert.equal(res.body.stored, false);
    assert.equal(emails.length, 1);
    assert.equal(smsCalls.length, 1);
  });

  it('a stored request still succeeds when email and SMS are down', async () => {
    emailFails = true; smsFails = true;
    const res = await submit(SCHOOL_BUS);
    assert.equal(res.status, 200);
    assert.equal(res.body.stored, true);
  });

  it('reports failure when nothing was stored or delivered, so the page shows the phone number', async () => {
    storeFails = true; emailFails = true; smsFails = true;
    const res = await submit(SCHOOL_BUS);
    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
  });

  it('two requests in the same millisecond get separate records', async () => {
    await submit(SCHOOL_BUS);
    await submit(SCHOOL_BUS);
    assert.equal(store.map.size, 2);
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
      if (opts.fetchFails) throw new Error('offline');
      return { ok: true, json: async () => ({ ok: true, id: 'INQ-X' }) };
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
