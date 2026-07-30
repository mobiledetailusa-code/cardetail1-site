'use strict';

/**
 * Minimal Twilio production-readiness repair coverage:
 * feature-flag contract, first-message STOP copy, consent disclosure,
 * provider error redaction, channel independence, and safety defaults.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');

function memoryStore() {
  const store = createCasMemoryStore();
  store._map = {
    values() {
      const out = [];
      for (const [, entry] of store._data.entries()) out.push(JSON.parse(entry.value));
      return out[Symbol.iterator]();
    },
    entries() {
      const out = [];
      for (const [k, entry] of store._data.entries()) out.push([k, JSON.parse(entry.value)]);
      return out[Symbol.iterator]();
    },
  };
  return store;
}

function baseBooking(overrides = {}) {
  return {
    id: 'CD1-TWILIOREADY01',
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
  customerTransactionalSmsEnabled,
  buildSmsBody,
  smsSegmentInfo,
  sendCustomerSms,
  emitRequestReceived,
  EVENT_REQUEST_RECEIVED,
  EVENT_CONFIRMED,
  REQUEST_RECEIVED_SMS_OPT_OUT,
} = require('../netlify/lib/booking-transactional-notifications');

const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');

function withNotifyStores(fn) {
  return async () => {
    const tokenStore = memoryStore();
    const focusStore = memoryStore();
    const claimStore = createCasMemoryStore();
    setAppointmentAccessStoreFactories({
      tokenStore: () => tokenStore,
      focusStore: () => focusStore,
    });
    setNotificationClaimStoreFactory(() => claimStore);
    try {
      await fn({ tokenStore, focusStore, claimStore });
    } finally {
      resetAppointmentAccessStoreFactories();
      resetNotificationClaimStoreFactory();
    }
  };
}

test.beforeEach(() => {
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
  process.env.CONTEXT = 'production';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  delete process.env.URL;
  delete process.env.DEPLOY_URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.BRANCH;
  delete process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED;
  delete process.env.TWILIO_SID;
  delete process.env.TWILIO_TOKEN;
  delete process.env.TWILIO_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
});

// ── 1–4 feature flag contract ───────────────────────────────────────────────

test('1. customer SMS suppressed when feature flag is absent', () => {
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  delete process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED;
  assert.equal(customerTransactionalSmsEnabled(), false);
});

test('2. customer SMS suppressed when feature flag is false/0/empty', () => {
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  for (const v of ['false', 'FALSE', '0', '', ' ']) {
    process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = v;
    assert.equal(customerTransactionalSmsEnabled(), false, `flag=${JSON.stringify(v)}`);
  }
});

test('3. credentials alone do not activate customer SMS', () => {
  process.env.TWILIO_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  process.env.TWILIO_TOKEN = 'secret-token-value';
  process.env.TWILIO_FROM = '+15551112222';
  delete process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED;
  assert.equal(customerTransactionalSmsEnabled(), false);
});

test('4. flag plus valid credentials enables the send attempt', () => {
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  assert.equal(customerTransactionalSmsEnabled(), true);
});

// ── 5–9 sendCustomerSms outcomes ────────────────────────────────────────────

test('5. Twilio 2xx produces accepted/sent result', async () => {
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  const originalFetch = global.fetch;
  let capturedTo = null;
  global.fetch = async (_url, init) => {
    capturedTo = new URLSearchParams(init.body).get('To');
    return {
      ok: true,
      status: 201,
      json: async () => ({ sid: 'SMabcdef0123456789deadbeef' }),
      text: async () => '',
    };
  };
  try {
    const result = await sendCustomerSms('+15513132956', 'Detailing Zone test');
    assert.equal(result.sent, true);
    assert.equal(capturedTo, '+15513132956');
    assert.equal(result.correlationId, 'SMdeadbeef');
    assert.notEqual(result.correlationId, 'SMabcdef0123456789deadbeef');
  } finally {
    global.fetch = originalFetch;
  }
});

test('6. Twilio HTTP rejection fails safely with stable reason', async () => {
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ message: 'Invalid To phone number', code: 21211 }),
    json: async () => ({ message: 'Invalid To phone number' }),
  });
  try {
    const result = await sendCustomerSms('+15513132956', 'body');
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'twilio_http_400');
    assert.equal(result.httpStatus, 400);
    assert.equal(result.detail, undefined);
    assert.doesNotMatch(JSON.stringify(result), /Invalid To phone number|21211/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('7. provider network timeout fails safely', async () => {
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('network timeout talking to api.twilio.com Authorization: Basic secret');
  };
  try {
    const result = await sendCustomerSms('+15513132956', 'body');
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'twilio_network_error');
    assert.doesNotMatch(JSON.stringify(result), /Authorization|timeout talking|secret/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('8. invalid phone produces no_customer_phone', async () => {
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  const result = await sendCustomerSms(null, 'body');
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_customer_phone');
});

test('9. phone is submitted in E.164 format', async () => {
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  const { normalizeUsPhoneE164 } = require('../netlify/lib/phone-auth');
  assert.equal(normalizeUsPhoneE164('5513132956'), '+15513132956');
  assert.equal(normalizeUsPhoneE164('(551) 313-2956'), '+15513132956');
  assert.equal(normalizeUsPhoneE164('+1 551-313-2956'), '+15513132956');

  const originalFetch = global.fetch;
  let to = null;
  global.fetch = async (_url, init) => {
    to = new URLSearchParams(init.body).get('To');
    return { ok: true, status: 201, json: async () => ({ sid: 'SM12' }), text: async () => '' };
  };
  try {
    await sendCustomerSms(normalizeUsPhoneE164('5513132956'), 'hi');
    assert.equal(to, '+15513132956');
    assert.match(to, /^\+1\d{10}$/);
  } finally {
    global.fetch = originalFetch;
  }
});

// ── 10 first-message copy + segment count ───────────────────────────────────

test('10. first request_received SMS has brand, under-review, STOP, not confirmed', () => {
  const accessUrl = 'https://cardetail1.com/.netlify/functions/customer-appointment-access?token=aat_EXAMPLETOKENVALUE0123456789abcdefghijk';
  const body = buildSmsBody(EVENT_REQUEST_RECEIVED, baseBooking(), accessUrl);
  assert.match(body, /Detailing Zone/);
  assert.match(body, /received your booking request/i);
  assert.match(body, /under review/i);
  assert.doesNotMatch(body, /confirmed/i);
  assert.match(body, /View status:/);
  assert.match(body, /cardetail1\.com/);
  assert.match(body, new RegExp(REQUEST_RECEIVED_SMS_OPT_OUT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(body, /bit\.ly|tinyurl|goo\.gl|short\.io|twil\.io/i);
  assert.doesNotMatch(body, /sale|promo|discount|limited time|marketing/i);

  const segments = smsSegmentInfo(body);
  assert.equal(segments.encoding, 'GSM-7');
  assert.ok(segments.segments >= 1);
  assert.ok(segments.segments <= 3, `expected <=3 segments, got ${segments.segments} (${segments.length} chars)`);
  // Capture for report consumers.
  console.log('[twilio-readiness] request_received SMS segments:', segments);

  // Subsequent confirmed message does not require STOP footer duplication.
  const confirmed = buildSmsBody(EVENT_CONFIRMED, baseBooking({
    confirmedDate: '2026-08-02',
    confirmedTimeWindow: '9:00-11:00 AM',
  }), accessUrl);
  assert.doesNotMatch(confirmed, /Reply STOP/i);
});

// ── 11–12 consent disclosure ────────────────────────────────────────────────

test('11. transactional consent disclosure appears in authoritative booking entry points', () => {
  const index = read('index.html');
  assert.match(index, /id="bk-sms-consent-info"/);
  assert.match(index, /id="bk-sms-consent-confirm"/);
  assert.match(index, /data-consent-version="dz-txn-sms-v1"/);
  assert.match(index, /By providing your mobile number, you agree to receive transactional text messages from Detailing Zone about this booking/);
  assert.match(index, /Message and data rates may apply/);
  assert.match(index, /Reply STOP to opt out/);
  assert.match(index, /transactionalSmsConsentAccepted:\s*true/);
  assert.match(index, /transactionalSmsConsentTextVersion:\s*'dz-txn-sms-v1'/);

  // Hubs/specialty delegate to index.html — authoritative surface.
  assert.match(read('assets/hub-booking-bridge.js'), /index\.html/);
  assert.match(read('assets/specialty-booking-bridge.js'), /index\.html/);
  for (const page of [
    'new-jersey-hub.html',
    'ny-metro-hub.html',
    'connecticut-hub.html',
    'pennsylvania-hub.html',
    'bergen-county-hub.html',
  ]) {
    assert.match(read(page), /hub-booking-bridge\.js/);
  }
});

test('12. consent language does not authorize marketing', () => {
  const index = read('index.html');
  const info = index.slice(
    index.indexOf('id="bk-sms-consent-info"'),
    index.indexOf('id="bk-sms-consent-info"') + 500
  );
  assert.match(info, /transactional text messages/);
  assert.match(info, /not marketing consent/i);
  assert.doesNotMatch(info, /promotional offers|marketing texts|special deals/i);
  assert.match(index, /marketingSmsConsentAccepted:\s*false/);
  // No pre-checked marketing SMS checkbox in booking confirm.
  assert.doesNotMatch(index, /id="marketing-sms-ok"[^>]*checked/);
});

// ── 13–16 channel independence + idempotency ────────────────────────────────

test('13. email success remains independent from SMS failure', withNotifyStores(async () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'test@example.com';
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      return { ok: true, json: async () => ({ id: 'email_ok' }), text: async () => '' };
    }
    if (String(url).includes('twilio.com')) {
      return { ok: false, status: 500, text: async () => 'raw provider body', json: async () => ({}) };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    const result = await emitRequestReceived(baseBooking(), {});
    assert.equal(result.ok, true);
    assert.equal(result.delivery.email.sent, true);
    assert.equal(result.delivery.sms.sent, false);
    assert.equal(result.delivery.sms.reason, 'twilio_http_500');
  } finally {
    global.fetch = originalFetch;
  }
}));

test('14. SMS success remains independent from email failure', withNotifyStores(async () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'test@example.com';
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      return { ok: false, status: 503, text: async () => 'down', json: async () => ({}) };
    }
    if (String(url).includes('twilio.com')) {
      return { ok: true, status: 201, json: async () => ({ sid: 'SMok12345678' }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    const result = await emitRequestReceived(baseBooking(), {});
    assert.equal(result.ok, true);
    assert.equal(result.delivery.sms.sent, true);
    assert.equal(result.delivery.email.sent, false);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('15. retry after failed SMS follows current idempotency rules', withNotifyStores(async () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'test@example.com';
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  let smsCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      return { ok: true, json: async () => ({ id: 'email_ok' }), text: async () => '' };
    }
    if (String(url).includes('twilio.com')) {
      smsCalls += 1;
      if (smsCalls === 1) {
        return { ok: false, status: 429, text: async () => 'rate limited body', json: async () => ({}) };
      }
      return { ok: true, status: 201, json: async () => ({ sid: 'SMretryok99' }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    const first = await emitRequestReceived(baseBooking(), {});
    assert.equal(first.delivery.sms.sent, false);
    assert.equal(first.delivery.sms.reason, 'twilio_http_429');
    const failed = Object.values(first.booking.transactionalNotifications)
      .find((v) => v.channel === 'sms' || (v.status === 'failed' && String(v.reason || '').includes('twilio')));
    // Ledger marks failed SMS retryable (channel result shape).
    const smsFailed = Object.values(first.booking.transactionalNotifications)
      .find((v) => v.status === 'failed' && v.retryable === true);
    assert.ok(smsFailed || failed);

    const second = await emitRequestReceived(first.booking, {});
    assert.equal(second.delivery.sms.sent, true);
    assert.equal(smsCalls, 2);
    // Email remains terminal from first send — not duplicated.
    assert.ok(second.delivery.email.sent || second.delivery.email.skipped);
  } finally {
    global.fetch = originalFetch;
  }
}));

test('16. duplicate event does not send a second terminal SMS', withNotifyStores(async () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'test@example.com';
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';
  let smsCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      return { ok: true, json: async () => ({ id: 'email_ok' }), text: async () => '' };
    }
    if (String(url).includes('twilio.com')) {
      smsCalls += 1;
      return { ok: true, status: 201, json: async () => ({ sid: 'SMonceonly1' }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    const first = await emitRequestReceived(baseBooking(), {});
    assert.equal(first.delivery.sms.sent, true);
    const second = await emitRequestReceived(first.booking, {});
    assert.equal(smsCalls, 1);
    assert.ok(second.skipped === true || second.delivery.sms.skipped === true || second.delivery.sms.reason === 'already_sent');
  } finally {
    global.fetch = originalFetch;
  }
}));

// ── 17–20 redaction / logging ───────────────────────────────────────────────

test('17–19. txn-notify source logs no full phone, access token, or Twilio credentials', () => {
  const src = read('netlify/lib/booking-transactional-notifications.js');
  assert.match(src, /Never log raw tokens, emails, or phones/);
  assert.doesNotMatch(src, /console\.log\([^)]*working\.phone/);
  assert.doesNotMatch(src, /console\.log\([^)]*toE164/);
  assert.doesNotMatch(src, /console\.log\([^)]*access\.token/);
  assert.doesNotMatch(src, /console\.log\([^)]*TWILIO_TOKEN/);
  assert.doesNotMatch(src, /console\.log\([^)]*Authorization/);
  assert.doesNotMatch(src, /console\.(log|warn|info)\([^)]*accessUrl/);
});

test('20. admin/inquiry error results contain no raw Twilio provider body', () => {
  const bookingSrc = read('netlify/functions/submit-booking.js');
  const inquirySrc = read('netlify/functions/submit-inquiry.js');
  for (const [label, src] of [['submit-booking', bookingSrc], ['submit-inquiry', inquirySrc]]) {
    assert.doesNotMatch(src, /twilio \$\{res\.status\}: \$\{err\}/, label);
    assert.match(src, /twilio_http_\$\{status\}/, label);
    assert.match(src, /twilio_network_error/, label);
    assert.match(src, /Never return raw Twilio response bodies/, label);
  }
});

// ── 21–22 recovery + Stripe untouched ───────────────────────────────────────

test('21. recovery automation remains disabled/dry-run by default', () => {
  const { recoveryDryRun, recoveryEnabled } = require('../netlify/lib/revenue-recovery');
  delete process.env.RECOVERY_AUTOMATION_ENABLED;
  delete process.env.RECOVERY_DRY_RUN;
  assert.equal(recoveryEnabled(), false);
  assert.equal(recoveryDryRun(), true);
  const recoverySrc = read('netlify/lib/recovery-communications.js');
  assert.match(recoverySrc, /dry-run by default/i);
});

test('22. no Stripe/payment files changed in this repair', () => {
  // Compare against HEAD only — ignore unrelated dirty artifacts other tests may write.
  const diff = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(diff.status, 0, diff.stderr || 'git diff failed');
  const untracked = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(untracked.status, 0, untracked.stderr || 'git ls-files failed');
  const files = [...String(diff.stdout || '').split(/\r?\n/), ...String(untracked.stdout || '').split(/\r?\n/)]
    .map((s) => s.trim())
    .filter(Boolean)
    // Ignore generated strategy assets that other suites may rewrite on disk.
    .filter((f) => !/universal-customer-strategy/i.test(f));
  const forbidden = files.filter((f) =>
    /(^|\/)(stripe|create-payment-intent|create-setup-intent|capture-payment|customer-balance-payment)/i.test(f)
  );
  assert.deepEqual(forbidden, [], `unexpected payment/stripe files changed: ${forbidden.join(', ')}`);
  const allow = new Set([
    'index.html',
    'netlify/lib/booking-transactional-notifications.js',
    'netlify/functions/submit-booking.js',
    'netlify/functions/submit-inquiry.js',
    'tests/twilio-production-readiness.test.js',
    // Scope-guard allowlist updates for inquiry SMS redaction.
    'tests/state-hub-accordion-header.test.js',
    'tests/pre-commit-stabilization.test.js',
    'tests/ai-chat-public-pricing.test.js',
    'tests/encoding-chat-pricing-correction.test.js',
    'tests/home-service-areas.test.js',
  ]);
  for (const f of files) {
    assert.ok(allow.has(f), `unexpected changed file: ${f}`);
  }
});
