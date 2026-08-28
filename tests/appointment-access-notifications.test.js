'use strict';

/**
 * Appointment direct access + transactional booking notifications.
 * Proves secure tokens, event semantics, idempotency, and portal focus rules
 * without reintroducing CustomerVehicle / saved-vehicle garage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');

function memoryStore() {
  // CAS-capable store — appointment token consume requires onlyIfMatch.
  const store = createCasMemoryStore();
  store._map = {
    values() {
      const out = [];
      for (const [, entry] of store._data.entries()) {
        out.push(JSON.parse(entry.value));
      }
      return out[Symbol.iterator]();
    },
    entries() {
      const out = [];
      for (const [k, entry] of store._data.entries()) {
        out.push([k, JSON.parse(entry.value)]);
      }
      return out[Symbol.iterator]();
    },
  };
  return store;
}

function baseBooking(overrides = {}) {
  return {
    id: 'CD1-TESTACCESS01',
    firstName: 'Alex',
    lastName: 'Tester',
    email: 'alex.tester@example.com',
    phone: '5513132956',
    package: 'Interior Detail',
    vehicle: '2020 Honda Civic',
    preferredDate: '2026-08-01',
    preferredTime: '10:00 AM',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    bookingVersion: 1,
    finalizedAt: '2026-07-24T12:00:00.000Z',
    totalPrice: 199,
    approvedFinalAmount: 199,
    ...overrides,
  };
}

const {
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
} = require('../netlify/lib/booking-transactional-notifications');

test.beforeEach(() => {
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
  process.env.CONTEXT = 'production';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  delete process.env.URL;
  delete process.env.DEPLOY_URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.BRANCH;
  process.env.RESEND_API_KEY = '';
  process.env.TWILIO_SID = '';
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = '';
  delete process.env.RESEND_API_KEY;
  const claimStore = createCasMemoryStore();
  setNotificationClaimStoreFactory(() => claimStore);
});

test.afterEach(() => {
  resetNotificationClaimStoreFactory();
});

test('request-received copy is not described as confirmed', () => {
  const {
    buildEmailContent,
    EVENT_REQUEST_RECEIVED,
  } = require('../netlify/lib/booking-transactional-notifications');
  const content = buildEmailContent(EVENT_REQUEST_RECEIVED, baseBooking(), 'https://example.com/access');
  assert.equal(content.subject, 'We received your detailing request');
  assert.match(content.text, /under review/i);
  assert.match(content.text, /not yet a confirmed appointment/i);
  assert.doesNotMatch(content.text, /Your appointment is confirmed/i);
  assert.match(content.html, /not yet a confirmed appointment/i);
});

test('confirmed email includes date, window, vehicle, service, total, and secure link', () => {
  const {
    buildEmailContent,
    EVENT_CONFIRMED,
  } = require('../netlify/lib/booking-transactional-notifications');
  const booking = baseBooking({
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    confirmedDate: '2026-08-02',
    confirmedTimeWindow: '9:00–11:00 AM',
    confirmedAt: '2026-07-24T13:00:00.000Z',
  });
  const content = buildEmailContent(EVENT_CONFIRMED, booking, 'https://example.com/x');
  assert.equal(content.subject, 'Your detailing appointment is confirmed');
  assert.match(content.text, /Your appointment is confirmed/);
  assert.match(content.text, /2026-08-02/);
  assert.match(content.text, /9:00–11:00 AM/);
  assert.match(content.text, /Honda Civic/);
  assert.match(content.text, /Interior Detail/);
  assert.match(content.text, /\$199\.00/);
  assert.match(content.text, /https:\/\/example\.com\/x/);
  assert.match(content.html, /View Confirmed Appointment/);
});

test('customer-controlled text is HTML-escaped in email templates', () => {
  const {
    buildEmailContent,
    EVENT_REQUEST_RECEIVED,
    escapeHtml,
  } = require('../netlify/lib/booking-transactional-notifications');
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  const content = buildEmailContent(
    EVENT_REQUEST_RECEIVED,
    baseBooking({
      firstName: '<img onerror=alert(1)>',
      package: 'Shine & <b>Go</b>',
      vehicle: 'Truck "XL"',
    }),
    'https://example.com/a'
  );
  assert.doesNotMatch(content.html, /<img onerror/);
  assert.match(content.html, /&lt;img/);
  assert.match(content.html, /Shine &amp; &lt;b&gt;Go&lt;\/b&gt;/);
  assert.match(content.html, /Truck &quot;XL&quot;/);
});

test('access token is opaque, hashed at rest, and tied to one booking', async () => {
  const tokenStore = memoryStore();
  const focusStore = memoryStore();
  const {
    createAppointmentAccessToken,
    loadTokenRecord,
    hashToken,
    TOKEN_PREFIX,
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');

  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => focusStore,
  });
  try {
    const created = await createAppointmentAccessToken({
      bookingId: 'CD1-A',
      customerAccountId: 'acct_1',
      email: 'a@example.com',
      phoneDigits: '5513132956',
      eventType: 'booking.request_received',
    });
    assert.ok(created.token.startsWith(TOKEN_PREFIX));
    assert.doesNotMatch(created.token, /CD1-A/);
    assert.doesNotMatch(created.accessUrl, /5513132956|acct_1|a@example\.com/i);

    const loaded = await loadTokenRecord(created.token);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.record.bookingId, 'CD1-A');
    assert.equal(loaded.record.customerAccountId, 'acct_1');
    assert.equal(loaded.record.tokenHash, hashToken(created.token));

    // Raw token is not persisted.
    for (const v of tokenStore._map.values()) {
      const dump = JSON.stringify(v);
      assert.doesNotMatch(dump, new RegExp(created.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    resetAppointmentAccessStoreFactories();
  }
});

test('token cannot authenticate after expiry', async () => {
  const tokenStore = memoryStore();
  const {
    createAppointmentAccessToken,
    loadTokenRecord,
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');

  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => memoryStore(),
  });
  try {
    const created = await createAppointmentAccessToken({
      bookingId: 'CD1-EXP',
      customerAccountId: 'acct_exp',
      email: 'exp@example.com',
      ttlMs: 50,
    });
    // Force expiry on stored record.
    for (const [k, v] of tokenStore._map.entries()) {
      if (k.startsWith('tok_')) {
        await tokenStore.setJSON(k, {
          ...v,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
      }
    }
    const loaded = await loadTokenRecord(created.token);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.error, 'expired_token');
  } finally {
    resetAppointmentAccessStoreFactories();
  }
});

test('resend supersedes prior token (old token revoked)', async () => {
  const tokenStore = memoryStore();
  const {
    createAppointmentAccessToken,
    resendAppointmentAccessToken,
    loadTokenRecord,
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');

  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => memoryStore(),
  });
  try {
    const first = await createAppointmentAccessToken({
      bookingId: 'CD1-RESEND',
      customerAccountId: 'acct_r',
      email: 'r@example.com',
      supersede: false,
    });
    const second = await resendAppointmentAccessToken({
      bookingId: 'CD1-RESEND',
      customerAccountId: 'acct_r',
      email: 'r@example.com',
    });
    assert.notEqual(first.token, second.token);
    const oldLoaded = await loadTokenRecord(first.token, { allowExpired: true, allowConsumed: true });
    assert.ok(oldLoaded.record);
    assert.ok(oldLoaded.record.revokedAt);
    assert.equal(oldLoaded.ok, false);
    const newLoaded = await loadTokenRecord(second.token);
    assert.equal(newLoaded.ok, true);
  } finally {
    resetAppointmentAccessStoreFactories();
  }
});

test('consume marks token used and blocks replay', async () => {
  const tokenStore = memoryStore();
  const {
    createAppointmentAccessToken,
    consumeAppointmentAccessToken,
    loadTokenRecord,
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');

  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => memoryStore(),
  });
  try {
    const created = await createAppointmentAccessToken({
      bookingId: 'CD1-ONCE',
      customerAccountId: 'acct_once',
      email: 'once@example.com',
    });
    const consumed = await consumeAppointmentAccessToken(created.token);
    assert.equal(consumed.ok, true);
    assert.ok(consumed.record.consumedAt);
    const replay = await consumeAppointmentAccessToken(created.token);
    assert.equal(replay.ok, false);
    assert.equal(replay.error, 'consumed_token');
    const loaded = await loadTokenRecord(created.token);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.error, 'consumed_token');
  } finally {
    resetAppointmentAccessStoreFactories();
  }
});

test('idempotent confirmed notification does not duplicate channel sends', async () => {
  const tokenStore = memoryStore();
  const focusStore = memoryStore();
  const {
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');
  const {
    emitConfirmed,
    idempotencyKey,
    EVENT_CONFIRMED,
    eventStateKey,
  } = require('../netlify/lib/booking-transactional-notifications');

  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => focusStore,
  });

  const originalFetch = global.fetch;
  let emailCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      emailCalls += 1;
      return { ok: true, json: async () => ({ id: 'email_1' }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => 'no', json: async () => ({}) };
  };
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'test@example.com';

  try {
    const booking = baseBooking({
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      confirmedDate: '2026-08-02',
      confirmedTimeWindow: 'Morning',
      confirmedAt: '2026-07-24T13:00:00.000Z',
    });
    const first = await emitConfirmed(booking, {});
    assert.equal(first.ok, true);
    assert.equal(emailCalls, 1);
    const second = await emitConfirmed(first.booking, {});
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(emailCalls, 1);

    const stateKey = eventStateKey(EVENT_CONFIRMED, first.booking);
    const key = idempotencyKey(booking.id, EVENT_CONFIRMED, stateKey, 'email');
    assert.equal(first.booking.transactionalNotifications[key].status, 'sent');
  } finally {
    global.fetch = originalFetch;
    resetAppointmentAccessStoreFactories();
    delete process.env.RESEND_API_KEY;
  }
});

test('legacy Twilio credentials stay fail-closed and do not roll back booking', async () => {
  const tokenStore = memoryStore();
  const focusStore = memoryStore();
  const {
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');
  const { emitRequestReceived } = require('../netlify/lib/booking-transactional-notifications');

  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => focusStore,
  });

  const originalFetch = global.fetch;
  let twilioCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      return { ok: true, json: async () => ({ id: 'email_ok' }), text: async () => '' };
    }
    if (String(url).includes('twilio.com')) {
      twilioCalls += 1;
      return { ok: false, status: 500, text: async () => 'twilio down', json: async () => ({}) };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'test@example.com';
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';

  try {
    const booking = baseBooking();
    const result = await emitRequestReceived(booking, {});
    assert.equal(result.ok, true);
    assert.equal(result.booking.id, booking.id);
    assert.equal(result.booking.status, 'Pending Review');
    assert.equal(result.delivery.email.sent, true);
    assert.equal(result.delivery.sms.sent, false);
    assert.equal(twilioCalls, 0);
    assert.equal(result.delivery.sms.reason, 'customer_sms_not_enabled');
    // Email success + fail-closed SMS suppression are tracked independently.
    const ledger = result.booking.transactionalNotifications;
    const values = Object.values(ledger);
    assert.ok(values.some((v) => v.status === 'sent'));
    assert.ok(values.some((v) => v.status === 'suppressed' && v.reason === 'customer_sms_not_enabled'));
  } finally {
    global.fetch = originalFetch;
    resetAppointmentAccessStoreFactories();
    delete process.env.RESEND_API_KEY;
    delete process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED;
    delete process.env.TWILIO_SID;
    delete process.env.TWILIO_TOKEN;
    delete process.env.TWILIO_FROM;
  }
});

test('email failure remains retryable (not marked sent)', async () => {
  const tokenStore = memoryStore();
  const {
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');
  const { emitRequestReceived } = require('../netlify/lib/booking-transactional-notifications');

  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => memoryStore(),
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, text: async () => 'down', json: async () => ({}) });
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'test@example.com';

  try {
    const first = await emitRequestReceived(baseBooking(), {});
    assert.equal(first.ok, true);
    assert.equal(first.delivery.email.sent, false);
    const failed = Object.values(first.booking.transactionalNotifications)
      .find((v) => v.status === 'failed');
    assert.ok(failed);
    assert.equal(failed.retryable, true);

    // Retry after provider recovers.
    global.fetch = async (url) => {
      if (String(url).includes('api.resend.com')) {
        return { ok: true, json: async () => ({ id: 'ok' }), text: async () => '' };
      }
      return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
    };
    const second = await emitRequestReceived(first.booking, {});
    assert.equal(second.ok, true);
    assert.equal(second.delivery.email.sent, true);
  } finally {
    global.fetch = originalFetch;
    resetAppointmentAccessStoreFactories();
    delete process.env.RESEND_API_KEY;
  }
});

test('pending review customer status is not Confirmed', () => {
  const {
    customerFacingStatusLabel,
    customerFacingStatusKey,
  } = require('../netlify/lib/booking-customer-status');
  const pending = baseBooking();
  assert.equal(customerFacingStatusKey(pending), 'pending_review');
  assert.equal(customerFacingStatusLabel(pending), 'Pending Review');
  assert.notEqual(customerFacingStatusLabel(pending), 'Confirmed');
});

test('focus ref is opaque and not a booking id', async () => {
  const {
    ensureAppointmentPublicRef,
    FOCUS_PREFIX,
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');
  setAppointmentAccessStoreFactories({
    tokenStore: () => memoryStore(),
    focusStore: () => memoryStore(),
  });
  try {
    const { focusRef, booking } = await ensureAppointmentPublicRef(baseBooking());
    assert.ok(focusRef.startsWith(FOCUS_PREFIX));
    assert.notEqual(focusRef, booking.id);
    assert.doesNotMatch(focusRef, /CD1-/);
  } finally {
    resetAppointmentAccessStoreFactories();
  }
});

test('wiring: submit emits request_received; confirm emits confirmed; no garage reintro', () => {
  const submit = read('netlify/functions/submit-booking.js');
  const admin = read('netlify/functions/admin-ops-jobs.js');
  const access = read('netlify/functions/customer-appointment-access.js');
  const portalData = read('netlify/functions/customer-portal-data.js');
  const garageJs = read('assets/my-garage.js');
  const garageHtml = read('my-garage.html');
  const schema = read('prisma/schema.prisma');

  assert.match(submit, /emitRequestReceived/);
  assert.match(admin, /notifyConfirmed|emitConfirmed/);
  assert.match(admin, /notifyCancelled/);
  assert.match(admin, /notifyRescheduled/);
  assert.match(admin, /emitCustomerActionRequired/);
  assert.match(access, /consumeAppointmentAccessToken/);
  assert.match(access, /createAccountSession/);
  assert.match(access, /buildPortalFocusPath/);
  assert.match(access, /CONSUME_RESULT/);
  assert.match(access, /This secure link has expired/);
  assert.match(admin, /confirmBookingTransition/);
  assert.match(portalData, /appointmentPublicRef|resolveFocusRef/);
  assert.match(garageJs, /appointmentFocusRef|stripAppointmentFocusFromUrl/);
  assert.match(garageHtml, /Already have an appointment code/);
  assert.match(garageHtml, /Find your appointment/);
  assert.doesNotMatch(schema, /model\s+CustomerVehicle\b/);
  assert.doesNotMatch(garageJs, /CustomerVehicle|savedVehicles|defaultVehicle/);
  assert.doesNotMatch(portalData, /listCustomerVehicles\s*\(/);
  assert.doesNotMatch(portalData, /require\(['"]\.\.\/lib\/customer-vehicles['"]\)/);

  // Booking persistence completes before transactional notify; notify failures must not
  // convert a stored booking into a failed submit-booking response.
  const finalizeIdx = submit.indexOf('// ── Draft finalization');
  const finalizeBlock = finalizeIdx >= 0 ? submit.slice(finalizeIdx) : submit;
  assert.match(finalizeBlock, /await store\.setJSON\(rawDraftId, b\)/);
  assert.match(submit, /emitRequestReceived/);
  assert.match(finalizeBlock, /deliverBookingCreatedNotifications/);
  assert.match(finalizeBlock, /transactional notify failed/);
  const persistIdx = finalizeBlock.indexOf('await store.setJSON(rawDraftId, b)');
  const notifyIdx = finalizeBlock.indexOf('deliverBookingCreatedNotifications', persistIdx);
  const catchIdx = finalizeBlock.indexOf("transactional notify failed", notifyIdx);
  assert.ok(persistIdx >= 0 && notifyIdx > persistIdx && catchIdx > notifyIdx);
});

test('access URL uses short /a?t= path — not raw PII query params', () => {
  const {
    buildAccessUrl,
    buildPortalFocusUrl,
  } = require('../netlify/lib/appointment-access-token');
  process.env.CONTEXT = 'production';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  delete process.env.URL;
  const access = buildAccessUrl('aat_testtokenvalue');
  assert.match(access, /^https:\/\/cardetail1\.com\/a\?t=/);
  assert.doesNotMatch(access, /phone=|email=|bookingId=|customerAccountId=/i);
  assert.doesNotMatch(access, /branch-deploy|CONTEXT|envBinding|DEPLOY_/i);
  assert.doesNotMatch(access, /\.netlify\/functions/);
  const focus = buildPortalFocusUrl('aptr_abc');
  assert.match(focus, /\/my-garage\?appointment=aptr_/);
  assert.doesNotMatch(focus, /token=/);
});

test('request-received SMS stays GSM-7 with details and a typical short access URL', () => {
  const { renderSmsTemplate, TEMPLATE_KEYS, measureSms } = require('../netlify/lib/sms-templates');
  const { buildAccessUrl } = require('../netlify/lib/appointment-access-token');
  process.env.CONTEXT = 'production';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  delete process.env.URL;
  const typicalToken = 'aat_' + 'A'.repeat(43);
  const url = buildAccessUrl(typicalToken);
  const rendered = renderSmsTemplate(TEMPLATE_KEYS.REQUEST_RECEIVED, {
    url,
    date: '2026-08-28',
    service: 'Interior Detail',
    window: 'anytime',
  });
  assert.equal(rendered.ok, true);
  const measure = measureSms(rendered.body);
  assert.equal(measure.encoding, 'GSM-7');
  assert.ok(
    measure.segmentCount <= 2,
    `SMS segments ${measure.segmentCount} (${measure.characterCount} chars): ${rendered.body}`
  );
  assert.match(rendered.body, /STOP/i);
  assert.match(rendered.body, /HELP/i);
  assert.match(rendered.body, /\/a\?t=/);
  assert.match(rendered.body, /Interior Detail/);
  assert.match(rendered.body, /Any time that day/);
  assert.doesNotMatch(rendered.body, /Your appointment is confirmed/i);
});

test('branch-deploy request-received email uses branch-deploy origin', async () => {
  const {
    createAppointmentAccessToken,
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');
  const { emitRequestReceived } = require('../netlify/lib/booking-transactional-notifications');
  const tokenStore = memoryStore();
  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => memoryStore(),
  });
  process.env.CONTEXT = 'branch-deploy';
  process.env.BRANCH = 'appointment-access-final';
  process.env.URL = 'https://cardetail1.com';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.DEPLOY_URL = 'https://appointment-access-final--cardetail1.netlify.app';
  process.env.DEPLOY_PRIME_URL = 'https://appointment-access-final--cardetail1.netlify.app';
  process.env.RESEND_API_KEY = 're_test';
  const originalFetch = global.fetch;
  let captured = '';
  global.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      const body = JSON.parse(init.body);
      captured = String(body.html || '') + String(body.text || '');
      return { ok: true, json: async () => ({ id: 'em' }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    const booking = baseBooking({ id: 'CD1-BRANCH-ORIGIN' });
    const result = await emitRequestReceived(booking, {});
    assert.equal(result.ok, true);
    assert.match(captured, /https:\/\/appointment-access-final--cardetail1\.netlify\.app\/a\?t=/);
    assert.doesNotMatch(captured, /https:\/\/cardetail1\.com\/a\?t=/);
    const minted = await createAppointmentAccessToken({
      bookingId: booking.id,
      email: booking.email,
      phoneDigits: '5513132956',
    });
    assert.match(minted.accessUrl, /^https:\/\/appointment-access-final--cardetail1\.netlify\.app\//);
    assert.doesNotMatch(minted.accessUrl, /envBinding|branch-deploy:|CONTEXT=/);
  } finally {
    global.fetch = originalFetch;
    resetAppointmentAccessStoreFactories();
    delete process.env.RESEND_API_KEY;
  }
});

test('draft token works on draft env and fails safely on production env', async () => {
  const {
    createAppointmentAccessToken,
    consumeAppointmentAccessToken,
    loadTokenRecord,
    CONSUME_RESULT,
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');
  const tokenStore = memoryStore();
  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => memoryStore(),
  });
  try {
    process.env.CONTEXT = 'branch-deploy';
    process.env.BRANCH = 'appointment-access-final';
    process.env.DEPLOY_URL = 'https://appointment-access-final--cardetail1.netlify.app';
    const minted = await createAppointmentAccessToken({
      bookingId: 'CD1-ENV-ISO-1',
      email: 'iso@example.com',
      phoneDigits: '5513132956',
    });
    assert.equal(minted.envBinding, 'branch-deploy:appointment-access-final');
    const onDraft = await loadTokenRecord(minted.token);
    assert.equal(onDraft.ok, true);
    assert.equal(onDraft.record.envBinding, 'branch-deploy:appointment-access-final');
    const consumedDraft = await consumeAppointmentAccessToken(minted.token);
    assert.equal(consumedDraft.ok, true);
    assert.equal(consumedDraft.classification, CONSUME_RESULT.CONSUMED_SUCCESSFULLY);

    const minted2 = await createAppointmentAccessToken({
      bookingId: 'CD1-ENV-ISO-2',
      email: 'iso2@example.com',
      phoneDigits: '5513132956',
    });
    process.env.CONTEXT = 'production';
    process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
    delete process.env.BRANCH;
    delete process.env.DEPLOY_URL;
    const prodLoad = await loadTokenRecord(minted2.token);
    assert.equal(prodLoad.ok, false);
    assert.equal(prodLoad.classification, CONSUME_RESULT.INVALID);
    const prodConsume = await consumeAppointmentAccessToken(minted2.token);
    assert.equal(prodConsume.ok, false);
    assert.equal(prodConsume.classification, CONSUME_RESULT.INVALID);
  } finally {
    resetAppointmentAccessStoreFactories();
  }
});

test('production token fails safely when evaluated in branch-deploy context', async () => {
  const {
    createAppointmentAccessToken,
    loadTokenRecord,
    CONSUME_RESULT,
    setAppointmentAccessStoreFactories,
    resetAppointmentAccessStoreFactories,
  } = require('../netlify/lib/appointment-access-token');
  const tokenStore = memoryStore();
  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => memoryStore(),
  });
  try {
    process.env.CONTEXT = 'production';
    process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
    const minted = await createAppointmentAccessToken({
      bookingId: 'CD1-ENV-ISO-PROD',
      email: 'prod@example.com',
      phoneDigits: '5513132956',
    });
    process.env.CONTEXT = 'branch-deploy';
    process.env.BRANCH = 'appointment-access-final';
    process.env.DEPLOY_URL = 'https://appointment-access-final--cardetail1.netlify.app';
    const loaded = await loadTokenRecord(minted.token);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.classification, CONSUME_RESULT.INVALID);
  } finally {
    resetAppointmentAccessStoreFactories();
  }
});

test('no secrets or PII patterns in txn-notify log line template', () => {
  const src = read('netlify/lib/booking-transactional-notifications.js');
  assert.match(src, /bookingIdPrefix/);
  assert.doesNotMatch(src, /console\.log\([^)]*booking\.email/);
  assert.doesNotMatch(src, /console\.log\([^)]*access\.token/);
  assert.doesNotMatch(src, /console\.log\([^)]*phone/);
});

test('notification-delivery skips already-sent channels on retry', async () => {
  const { sendNotificationsDecoupled } = require('../netlify/lib/notification-delivery');
  let calls = 0;
  const delivery = await sendNotificationsDecoupled({
    id: 'CD1-X',
    notificationDelivery: {
      adminEmail: { status: 'sent', at: '2026-01-01T00:00:00.000Z', reason: null },
      customerEmail: { status: 'pending', at: null, reason: null },
      adminSms: { status: 'pending', at: null, reason: null },
      customerSms: { status: 'pending', at: null, reason: null },
    },
  }, {
    adminEmail: async () => { calls += 1; return { sent: true }; },
    customerEmail: async () => ({ sent: true }),
  });
  assert.equal(calls, 0);
  assert.equal(delivery.adminEmail.status, 'sent');
  assert.equal(delivery.customerEmail.status, 'sent');
});
