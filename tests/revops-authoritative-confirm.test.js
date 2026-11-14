'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
const { confirmBookingTransition } = require('../netlify/lib/booking-confirm');
const { cancelBookingTransition } = require('../netlify/lib/booking-cancel');
const { confirmQuickOps } = require('../netlify/lib/admin-quick-ops-actions');
const {
  setAuthoritativeConfirmDeps,
  resetAuthoritativeConfirmDeps,
  setConfirmationQuoteReader,
  resetConfirmationQuoteReader,
} = require('../netlify/lib/revenue-authoritative-confirm');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');
const {
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
} = require('../netlify/lib/booking-transactional-notifications');

const NOW = '2026-07-24T15:00:00.000Z';

function pendingBooking(id, extra = {}) {
  return {
    id,
    bookingVersion: 3,
    firstName: 'Sam',
    lastName: 'Customer',
    email: 'sam@example.com',
    phone: '2015550177',
    package: 'Interior',
    vehicle: '2021 Toyota Camry',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    preferredDate: '2026-08-10',
    totalPrice: 180,
    approvedFinalAmount: 220,
    finalizedAt: '2026-07-24T12:00:00.000Z',
    schemaVersion: 1,
    quoteVersion: 1,
    ...extra,
  };
}

function memoryRevenue() {
  const blobs = new Map();
  return {
    blobs,
    async get() { return { name: 'mem' }; },
    async create(_store, key, value) {
      if (blobs.has(key)) return { created: false };
      blobs.set(key, JSON.parse(JSON.stringify(value)));
      return { created: true };
    },
    async read(_store, key) {
      return blobs.has(key) ? JSON.parse(JSON.stringify(blobs.get(key))) : null;
    },
  };
}

function confirmationRecords(deps) {
  const out = [];
  for (const [key, value] of deps.blobs) {
    if (value && value.event === 'booking_confirmed') out.push({ key, value });
  }
  return out;
}

function install(booking, quote = { state: 'ready', approvedCents: null }) {
  setBookingStoreOverride(createCasMemoryStore(
    Array.isArray(booking)
      ? Object.fromEntries(booking.map((row) => [row.id, row]))
      : { [booking.id]: booking }
  ));
  const deps = memoryRevenue();
  setAuthoritativeConfirmDeps(deps);
  setConfirmationQuoteReader(async () => quote);
  return deps;
}

function quietNotifyStores() {
  setAppointmentAccessStoreFactories({
    tokenStore: () => createCasMemoryStore(),
    focusStore: () => createCasMemoryStore(),
  });
  setNotificationClaimStoreFactory(() => createCasMemoryStore());
}

test.afterEach(() => {
  setBookingStoreOverride(null);
  resetAuthoritativeConfirmDeps();
  resetConfirmationQuoteReader();
  resetAppointmentAccessStoreFactories();
  resetNotificationClaimStoreFactory();
});

function loadRevenueHandler() {
  const rlPath = require.resolve('../netlify/lib/public-rate-limit');
  const storePath = require.resolve('../netlify/lib/revenue-store');
  const handlerPath = require.resolve('../netlify/functions/revenue-event');
  const rl = require(rlPath);
  const revenueStore = require(storePath);
  const original = {
    enforcePublicRateLimit: rl.enforcePublicRateLimit,
    getRevenueStore: revenueStore.getRevenueStore,
    blobGetJsonStrict: revenueStore.blobGetJsonStrict,
    blobCreateJson: revenueStore.blobCreateJson,
  };
  const writes = [];
  const stores = { eventIdempotency: new Map(), events: new Map() };
  rl.enforcePublicRateLimit = async () => ({ blocked: false, allowed: true });
  revenueStore.getRevenueStore = async (name) => ({ name });
  revenueStore.blobGetJsonStrict = async (store, key) => stores[store.name].get(key) || null;
  revenueStore.blobCreateJson = async (store, key, value) => {
    if (stores[store.name].has(key)) return { created: false, etag: null };
    stores[store.name].set(key, value);
    writes.push({ store: store.name, key, value });
    return { created: true, etag: 'etag' };
  };
  delete require.cache[handlerPath];
  const handler = require(handlerPath).handler;
  rl.enforcePublicRateLimit = original.enforcePublicRateLimit;
  Object.assign(revenueStore, {
    getRevenueStore: original.getRevenueStore,
    blobGetJsonStrict: original.blobGetJsonStrict,
    blobCreateJson: original.blobCreateJson,
  });
  return { handler, writes };
}

async function postEvent(handler, body, headers = {}) {
  return handler({
    httpMethod: 'POST',
    headers: {
      'x-nf-client-connection-ip': '203.0.113.50',
      'x-cd1-origin': 'server',
      'x-internal-auth': 'trust-me',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('anonymous booking_confirmed is rejected and stored nowhere', async () => {
  const { handler, writes } = loadRevenueHandler();
  const res = await postEvent(handler, {
    event: 'booking_confirmed',
    event_id: 'browser-forged-confirm',
    anonymous_session_id: 'sess_anon',
    properties: {
      estimated_value: 99999,
      booking_reference: 'CD1-FORGED',
      currency: 'USD',
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'authoritative_event_forbidden');
  assert.equal(writes.length, 0);
});

test('anonymous service_completed is rejected and stored nowhere', async () => {
  const { handler, writes } = loadRevenueHandler();
  const res = await postEvent(handler, {
    event: 'service_completed',
    event_id: 'browser-forged-complete',
    anonymous_session_id: 'sess_anon',
    properties: { estimated_value: 450, booking_reference: 'CD1-FORGED' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'authoritative_event_forbidden');
  assert.equal(writes.length, 0);
});

test('a public booking request can still be measured, without becoming approved revenue', async () => {
  const { handler, writes } = loadRevenueHandler();
  const res = await postEvent(handler, {
    event: 'booking_submitted',
    event_id: 'evt_submitted_1',
    anonymous_session_id: 'sess_real',
    properties: { estimated_value: 99999, currency: 'USD', booking_reference: 'CD1-REQ-1' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(writes.length, 2);
  const projection = writes.find((row) => row.store === 'events');
  assert.equal(projection.value.event, 'booking_submitted');
  assert.equal(projection.value.properties.estimated_value, 99999);

  const dash = await dashboardFrom([{
    event: 'booking_submitted',
    properties: { estimated_value: 99999, booking_reference: 'CD1-REQ-1' },
    receivedAt: new Date().toISOString(),
  }]);
  assert.equal(dash.summary.bookingSubmissions, 1);
  assert.equal(dash.summary.confirmedBookings, 0);
  assert.equal(dash.summary.approvedRevenueAtConfirmation, 0);
});

test('a public navigation event is still accepted', async () => {
  const { handler, writes } = loadRevenueHandler();
  const res = await postEvent(handler, {
    event: 'page_view',
    event_id: 'evt_page_1',
    anonymous_session_id: 'sess_nav',
    properties: { page_type: 'home', source_page: '/' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].value.event, 'page_view');
});

test('a submitted booking that is not confirmed produces no confirmation event', async () => {
  const booking = pendingBooking('CD1-SUBMIT-ONLY');
  const deps = install(booking);
  const rec = await getBookingRecord(booking.id);
  assert.equal(rec.booking.status, 'Pending Review');
  assert.equal(confirmationRecords(deps).length, 0);
  const dash = await dashboardFrom([{
    event: 'booking_submitted',
    properties: { estimated_value: 220, booking_reference: booking.id },
    receivedAt: new Date().toISOString(),
  }]);
  assert.equal(dash.summary.confirmedBookings, 0);
  assert.equal(dash.funnel.find((step) => step.step === 'booking_confirmed').count, 0);
});

test('an admin confirmation records one server event for the persisted booking', async () => {
  const booking = pendingBooking('CD1-ADMIN-1');
  const deps = install(booking, { state: 'ready', approvedCents: 31000 });
  const result = await confirmBookingTransition({
    bookingId: booking.id,
    now: NOW,
    by: 'admin',
  });
  assert.equal(result.ok, true);
  assert.equal(result.transitioned, true);
  assert.equal(result.booking.status, 'Confirmed');
  assert.equal(result.booking.appointmentStatus, 'confirmed');
  const records = confirmationRecords(deps);
  assert.equal(records.length, 1);
  const props = records[0].value.properties;
  assert.equal(props.event_origin, 'server_confirm');
  assert.equal(props.booking_reference, booking.id);
  assert.equal(props.estimated_value, 310);
  assert.equal(props.event_id, result.booking.confirmationEventId);
  assert.equal(props.timestamp, result.booking.confirmedAt);
  assert.equal(records[0].value.event, 'booking_confirmed');
  assert.equal(result.booking.approvedFinalAmount, 220);
});

test('QuickOps confirmation uses the same authoritative event and does not send from analytics', async () => {
  const booking = pendingBooking('CD1-QOPS-1');
  const deps = install(booking, { state: 'ready', approvedCents: 19000 });
  quietNotifyStores();
  const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/revenue-authoritative-confirm.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"][^'"]*(twilio|sms-outbox|stripe)/i);
  assert.doesNotMatch(src, /\bgtag\b|\bdataLayer\b|AW-/);
  const result = await confirmQuickOps(booking.id, {
    env: {
      CONTEXT: 'production',
      TWILIO_ENABLED: 'false',
      TWILIO_OUTBOX_ENABLED: 'false',
      CUSTOMER_TRANSACTIONAL_SMS_ENABLED: '',
      ADMIN_SMS_CONSENT_GRANTED: 'false',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.transitioned, true);
  assert.equal(result.booking.updatedBy, 'quick_ops');
  const records = confirmationRecords(deps);
  assert.equal(records.length, 1);
  assert.equal(records[0].value.properties.estimated_value, 190);
  assert.equal(records[0].value.properties.event_origin, 'server_confirm');
  assert.equal(records[0].value.properties.event_id, result.booking.confirmationEventId);
});

test('repeating a confirmation does not create a second event', async () => {
  const booking = pendingBooking('CD1-REPEAT-1');
  const deps = install(booking, { state: 'ready', approvedCents: 22000 });
  const first = await confirmBookingTransition({ bookingId: booking.id, now: NOW, by: 'admin' });
  const second = await confirmBookingTransition({ bookingId: booking.id, now: '2026-07-24T16:00:00.000Z', by: 'admin' });
  assert.equal(first.transitioned, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.transitioned, false);
  assert.equal(second.booking.confirmationEventId, first.booking.confirmationEventId);
  assert.equal(confirmationRecords(deps).length, 1);
});

test('two simultaneous confirmations produce one event', async () => {
  const booking = pendingBooking('CD1-RACE-1');
  const deps = install(booking, { state: 'ready', approvedCents: 22000 });
  const [a, b] = await Promise.all([
    confirmBookingTransition({ bookingId: booking.id, now: NOW, by: 'admin' }),
    confirmBookingTransition({ bookingId: booking.id, now: '2026-07-24T15:00:01.000Z', by: 'admin' }),
  ]);
  const winners = [a, b].filter((row) => row.ok && row.transitioned);
  assert.equal(winners.length, 1);
  assert.equal([a, b].filter((row) => row.ok && row.idempotent).length, 1);
  assert.equal(a.booking.confirmationEventId, b.booking.confirmationEventId);
  assert.equal(confirmationRecords(deps).length, 1);
});

test('a stored confirmation survives an analytics failure', async () => {
  const booking = pendingBooking('CD1-FAIL-1');
  setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
  setConfirmationQuoteReader(async () => ({ state: 'ready', approvedCents: 22000 }));
  setAuthoritativeConfirmDeps({
    async get() { return { name: 'mem' }; },
    async create() { throw new Error('blob down'); },
    async read() { return null; },
  });
  const result = await confirmBookingTransition({ bookingId: booking.id, now: NOW, by: 'admin' });
  assert.equal(result.ok, true);
  assert.equal(result.transitioned, true);
  assert.equal(result.booking.status, 'Confirmed');
  const stored = await getBookingRecord(booking.id);
  assert.equal(stored.booking.confirmationAnalytics.required, true);
  assert.equal(stored.booking.appointmentStatus, 'confirmed');
});

test('the missed event is recorded once on the next authorized confirm', async () => {
  const booking = pendingBooking('CD1-RECOVER-1');
  setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
  setConfirmationQuoteReader(async () => ({ state: 'ready', approvedCents: 22000 }));
  let failProjection = true;
  const deps = memoryRevenue();
  const realCreate = deps.create.bind(deps);
  deps.create = async (store, key, value) => {
    if (failProjection && !String(key).startsWith('evt:')) {
      failProjection = false;
      throw new Error('projection down');
    }
    return realCreate(store, key, value);
  };
  setAuthoritativeConfirmDeps(deps);
  const first = await confirmBookingTransition({ bookingId: booking.id, now: NOW, by: 'admin' });
  assert.equal(first.transitioned, true);
  assert.equal(confirmationRecords(deps).length, 0);
  const second = await confirmBookingTransition({ bookingId: booking.id, now: '2026-07-24T18:00:00.000Z', by: 'admin' });
  assert.equal(second.idempotent, true);
  const records = confirmationRecords(deps);
  assert.equal(records.length, 1);
  assert.equal(records[0].value.properties.event_id, first.booking.confirmationEventId);
  assert.equal(records[0].value.properties.estimated_value, 220);
});

test('a Postgres outage does not undo the confirmation or invent a zero amount', async () => {
  const booking = pendingBooking('CD1-PG-1');
  const deps = install(booking, { state: 'unavailable' });
  const first = await confirmBookingTransition({ bookingId: booking.id, now: NOW, by: 'admin' });
  assert.equal(first.ok, true);
  assert.equal(first.transitioned, true);
  assert.equal(first.booking.status, 'Confirmed');
  assert.equal(confirmationRecords(deps).length, 0);
  setConfirmationQuoteReader(async () => ({ state: 'ready', approvedCents: 31000 }));
  const second = await confirmBookingTransition({ bookingId: booking.id, now: '2026-07-24T19:00:00.000Z', by: 'admin' });
  assert.equal(second.idempotent, true);
  const records = confirmationRecords(deps);
  assert.equal(records.length, 1);
  assert.equal(records[0].value.properties.estimated_value, 310);
  assert.notEqual(records[0].value.properties.estimated_value, 0);
  assert.notEqual(records[0].value.properties.estimated_value, 220);
});

test('the recorded amount comes from the quote, not the browser or totalPrice', async () => {
  const booking = pendingBooking('CD1-QUOTE-1', { totalPrice: 180, approvedFinalAmount: 220 });
  const deps = install(booking, { state: 'ready', approvedCents: 31000 });
  await confirmBookingTransition({ bookingId: booking.id, now: NOW, by: 'admin' });
  const props = confirmationRecords(deps)[0].value.properties;
  assert.equal(props.estimated_value, 310);

  const bare = pendingBooking('CD1-NO-AMOUNT', { totalPrice: 180 });
  delete bare.approvedFinalAmount;
  const bareDeps = install(bare, { state: 'ready', approvedCents: null });
  await confirmBookingTransition({ bookingId: bare.id, now: NOW, by: 'admin' });
  const bareProps = confirmationRecords(bareDeps)[0].value.properties;
  assert.equal(bareProps.error_code, 'amount_unavailable');
  assert.equal(Object.prototype.hasOwnProperty.call(bareProps, 'estimated_value'), false);
  assert.notEqual(bareProps.estimated_value, 180);
  assert.notEqual(bareProps.estimated_value, 0);
});

test('cancelling a booking does not create a confirmation event', async () => {
  const pending = pendingBooking('CD1-CANCEL-NEW');
  const deps = install([
    pending,
    pendingBooking('CD1-CANCEL-DONE'),
  ], { state: 'ready', approvedCents: 22000 });
  const cancelled = await cancelBookingTransition({
    bookingId: pending.id,
    now: NOW,
    by: 'admin',
  });
  assert.equal(cancelled.transitioned, true);
  assert.equal(confirmationRecords(deps).length, 0);

  const confirmed = await confirmBookingTransition({
    bookingId: 'CD1-CANCEL-DONE',
    now: NOW,
    by: 'admin',
  });
  assert.equal(confirmationRecords(deps).length, 1);
  const afterCancel = await cancelBookingTransition({
    bookingId: 'CD1-CANCEL-DONE',
    now: '2026-07-24T20:00:00.000Z',
    by: 'admin',
  });
  assert.equal(afterCancel.transitioned, true);
  assert.equal(confirmationRecords(deps).length, 1);
  const stored = await getBookingRecord('CD1-CANCEL-DONE');
  assert.notEqual(stored.booking.appointmentStatus, 'confirmed');
});

test('already confirmed bookings without the marker are not backfilled', async () => {
  const historical = pendingBooking('CD1-OLD-1', {
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    confirmedAt: '2026-01-01T00:00:00.000Z',
    confirmationEventId: 'confirmed:CD1-OLD-1:2026-01-01T00:00:00.000Z',
  });
  const other = pendingBooking('CD1-OLD-2', {
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    confirmedAt: '2026-02-01T00:00:00.000Z',
    confirmationEventId: 'confirmed:CD1-OLD-2:2026-02-01T00:00:00.000Z',
  });
  const deps = install([historical, other], { state: 'ready', approvedCents: 22000 });
  const result = await confirmBookingTransition({
    bookingId: historical.id,
    now: NOW,
    by: 'admin',
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.transitioned, false);
  assert.equal(confirmationRecords(deps).length, 0);
  const untouched = await getBookingRecord(other.id);
  assert.equal(untouched.booking.confirmationAnalytics, undefined);
});

test('the dashboard counts server confirmations and keeps unverified history', async () => {
  const day = new Date().toISOString();
  const dash = await dashboardFrom([
    {
      event: 'booking_confirmed',
      properties: { event_origin: 'server_confirm', estimated_value: 310, booking_reference: 'CD1-SERVER-1' },
      receivedAt: day,
    },
    {
      event: 'booking_confirmed',
      properties: { estimated_value: 99999, booking_reference: 'CD1-OLD-FORGED' },
      receivedAt: day,
    },
    {
      event: 'booking_submitted',
      properties: { estimated_value: 50, booking_reference: 'CD1-REQ-9' },
      receivedAt: day,
    },
    {
      event: 'page_view',
      properties: { page_type: 'home' },
      receivedAt: day,
    },
  ]);
  assert.equal(dash.summary.confirmedBookings, 1);
  assert.equal(dash.summary.eventCounts.booking_confirmed_unverified, 1);
  assert.equal(dash.summary.approvedRevenueAtConfirmation, 310);
  assert.equal(dash.summary.bookingSubmissions, 1);
  assert.equal(dash.funnel.find((step) => step.step === 'booking_confirmed').count, 1);
  assert.equal(dash.funnel.find((step) => step.step === 'booking_confirmed').label, 'Confirmed');
});

test('authoritative confirmation is not forwarded to GA4 or Google Ads', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/revenue-authoritative-confirm.js'), 'utf8');
  const checkout = fs.readFileSync(path.join(ROOT, 'assets/checkout-analytics.js'), 'utf8');
  assert.doesNotMatch(src, /gtag|googleads|googletagmanager|AW-|dataLayer/i);
  assert.match(checkout, /trackGoogleAdsBookingConversion/);
  assert.match(checkout, /onBookingSubmitted/);
  assert.doesNotMatch(checkout, /booking_confirmed/);

  const client = loadRevenueClient();
  const forged = client.Cardetail1Revenue.track('booking_confirmed', {
    estimated_value: 99999,
    booking_reference: 'CD1-BROWSER',
  });
  client.Cardetail1Revenue.track('service_completed', { estimated_value: 450 });
  assert.ok(forged);
  assert.equal(client.fetchCalls.length, 0);
  assert.equal(client.gtagCalls.length, 0);
  assert.equal(client.Cardetail1Revenue.getContract().events.includes('booking_confirmed'), false);
  assert.equal(client.Cardetail1Revenue.getContract().events.includes('service_completed'), false);
  assert.equal(client.Cardetail1Revenue.getContract().events.includes('page_view'), true);
  client.Cardetail1Revenue.track('page_view', { page_type: 'home' });
  assert.equal(client.fetchCalls.length, 1);
  assert.equal(JSON.parse(client.fetchCalls[0].body).event, 'page_view');
});

test('the booking request path is unchanged and confirmation still persists', async () => {
  const submit = fs.readFileSync(path.join(ROOT, 'netlify/functions/submit-booking.js'), 'utf8');
  const hooks = fs.readFileSync(path.join(ROOT, 'assets/revops-booking-hooks.js'), 'utf8');
  assert.doesNotMatch(submit, /revenue-authoritative-confirm/);
  assert.doesNotMatch(hooks, /booking_confirmed/);
  const booking = pendingBooking('CD1-FLOW-1');
  const deps = install(booking, { state: 'not_configured' });
  const result = await confirmBookingTransition({ bookingId: booking.id, now: NOW, by: 'admin' });
  assert.equal(result.booking.status, 'Confirmed');
  assert.equal(result.booking.jobStatus, 'confirmed');
  assert.equal(confirmationRecords(deps)[0].value.properties.estimated_value, 220);
  const { handler } = loadRevenueHandler();
  const submitted = await postEvent(handler, {
    event: 'booking_submitted',
    event_id: 'evt_flow_submit',
    anonymous_session_id: 'sess_flow',
    properties: { booking_reference: booking.id, estimated_value: 220 },
  });
  assert.equal(submitted.statusCode, 200);
});

async function dashboardFrom(events) {
  const revenueStore = require('../netlify/lib/revenue-store');
  const { buildRevopsDashboard } = require('../netlify/lib/revops-dashboard');
  const original = {
    getRevenueStore: revenueStore.getRevenueStore,
    blobListKeys: revenueStore.blobListKeys,
    blobGetJson: revenueStore.blobGetJson,
  };
  const day = new Date().toISOString().slice(0, 10);
  const records = {};
  events.forEach((event, index) => {
    records[`${day}/evt_${index}`] = event;
  });
  revenueStore.getRevenueStore = async (name) => ({ name });
  revenueStore.blobListKeys = async (store, opts = {}) => {
    if (store.name !== 'events') return [];
    const prefix = opts.prefix || '';
    return Object.keys(records).filter((key) => key.startsWith(prefix));
  };
  revenueStore.blobGetJson = async (_store, key) => records[key] || null;
  try {
    return await buildRevopsDashboard({});
  } finally {
    Object.assign(revenueStore, original);
  }
}

function loadRevenueClient() {
  const fetchCalls = [];
  const gtagCalls = [];
  const storage = new Map();
  const memoryStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const context = {
    console,
    sessionStorage: memoryStorage,
    localStorage: memoryStorage,
    location: { pathname: '/', search: '', hostname: 'cardetail1.com', href: 'https://cardetail1.com/' },
    navigator: { userAgent: 'Mozilla/5.0' },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      cookie: '',
      readyState: 'complete',
    },
    fetch: (url, options) => {
      fetchCalls.push({ url, body: options.body });
      return Promise.resolve({ ok: true, status: 200, headers: { get() { return null; } } });
    },
    gtag: (...args) => { gtagCalls.push(args); },
    dataLayer: [],
    Cardetail1Consent: { getConsent: () => ({ analytics: true, marketing: true }) },
    crypto: require('node:crypto').webcrypto,
    innerWidth: 1280,
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/revenue-events.js'), 'utf8'), context);
  context.fetchCalls = fetchCalls;
  context.gtagCalls = gtagCalls;
  return context;
}
