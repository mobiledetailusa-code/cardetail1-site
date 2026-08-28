'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const submitBooking = require('../netlify/functions/submit-booking');
const {
  PROGRAM_NAME,
  BOOKING_CONSENT_TEXT_VERSION,
  BOOKING_CONSENT_SOURCE,
  BOOKING_CONSENT_COPY,
  canonicalBookingSmsConsent,
  bookingSmsConsentGranted,
} = require('../netlify/lib/sms-program');
const { grantBookingSmsConsent } = require('../netlify/lib/sms-consent-service');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const BOOKING_SURFACES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function checkboxTag(html, id) {
  const match = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`, 'i'));
  assert.ok(match, `missing checkbox ${id}`);
  return match[0];
}

describe('public transactional SMS consent surface', () => {
  const index = read('index.html');
  const terms = read('terms-conditions.html');
  const privacy = read('privacy-policy.html');

  it('1/16. checkbox exists once, is SMS-specific, and defaults unchecked', () => {
    for (const file of BOOKING_SURFACES) {
      const html = read(file);
      assert.equal((html.match(/id="sms-consent-ok"/g) || []).length, 1, file);
      const tag = checkboxTag(html, 'sms-consent-ok');
      assert.match(tag, /type="checkbox"/i, file);
      assert.doesNotMatch(tag, /\bchecked\b/i, file);
      assert.match(html, new RegExp(BOOKING_CONSENT_TEXT_VERSION), file);
      assert.match(html, /\['sms-consent-ok','terms-ok','cof-policy-ok'\]/, `${file}: reset must restore unchecked default`);
    }
  });

  it('4/5. Terms acceptance and SMS consent are separate controls and state', () => {
    for (const file of BOOKING_SURFACES) {
      const html = read(file);
      assert.notEqual(checkboxTag(html, 'terms-ok'), checkboxTag(html, 'sms-consent-ok'), file);
      assert.match(html, /acceptedBookingPolicy:\s*!!document\.getElementById\('terms-ok'\)\?\.checked/, file);
      assert.match(html, /transactionalSmsConsentAccepted:\s*!!document\.getElementById\('sms-consent-ok'\)\?\.checked/, file);
      assert.doesNotMatch(html, /transactionalSmsConsentAccepted:\s*!!document\.getElementById\('terms-ok'\)/, file);
    }
  });

  it('7-13. exact sender, scope, frequency, rates, STOP, HELP and optionality are disclosed', () => {
    assert.equal(PROGRAM_NAME, 'Cardetail1');
    for (const file of BOOKING_SURFACES) {
      assert.match(read(file), new RegExp(BOOKING_CONSENT_COPY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), file);
    }
    assert.match(BOOKING_CONSENT_COPY, /booking request, appointment updates, reminders, and service-related notifications/);
    assert.match(BOOKING_CONSENT_COPY, /Message frequency varies/);
    assert.match(BOOKING_CONSENT_COPY, /Message and data rates may apply/);
    assert.match(BOOKING_CONSENT_COPY, /Reply STOP to opt out or HELP for help/);
    assert.match(BOOKING_CONSENT_COPY, /Consent is not a condition of booking/);
  });

  it('14/15/17. Privacy and Terms links are visible and marketing is not bundled', () => {
    for (const file of BOOKING_SURFACES) {
      const html = read(file);
      const block = html.slice(html.indexOf('id="booking-sms-consent"'), html.indexOf('id="booking-sms-consent"') + 1500);
      assert.match(block, /href="\/privacy-policy"[^>]*>Privacy Policy</, file);
      assert.match(block, /href="\/terms-conditions"[^>]*>Terms &amp; Conditions</, file);
      assert.match(block, /Transactional messages only; no marketing consent/, file);
      assert.match(html, /marketingSmsConsentAccepted:\s*false/, file);
    }
  });

  it('Privacy Policy distinguishes service-provider processing from marketing sharing', () => {
    assert.match(privacy, /Mobile information and SMS opt-in data or consent are not shared with third parties or affiliates for their own marketing or promotional purposes/i);
    assert.match(privacy, /including Twilio, only as needed to operate, transmit, secure, and support the messaging program/i);
    assert.match(privacy, /server-generated timestamp, the consent text version, and the opt-in source or method/i);
    assert.match(privacy, /replying <strong>STOP<\/strong>/i);
  });

  it('Terms contain bounded messaging terms without changing no-card booking terms', () => {
    assert.match(terms, /Cardetail1 Transactional SMS Program/);
    assert.match(terms, /Cardetail1 is a registered DBA of Detailing Zone L\.L\.C\./);
    assert.match(terms, /Message frequency varies\. Message and data rates may apply/);
    assert.match(terms, /Reply <strong>STOP<\/strong>/);
    assert.match(terms, /Reply <strong>HELP<\/strong>/);
    assert.match(terms, /not a condition of booking, purchase, or service/);
    assert.match(terms, /Mobile carriers are not liable for delayed or undelivered messages/);
    assert.match(terms, /No card or payment method is required to submit an initial booking request/);
  });

  it('Terms §12 acceptance is not SMS consent', () => {
    const heading = terms.indexOf('12. Customer Consent');
    assert.ok(heading >= 0, 'missing Terms §12 heading');
    const section = terms.slice(heading, terms.indexOf('class="foot"', heading));
    assert.doesNotMatch(section, /all terms above/i);
    assert.match(section, /Submitting a booking or accepting these Terms does not enroll you in SMS/);
    assert.match(section, /collected only through the separate booking checkbox/);
    assert.match(section, /not a condition of booking, purchase, or service/);
  });
});

function createMemoryStore() {
  const data = new Map();
  return {
    data,
    async get(key) {
      const value = data.get(key);
      return value == null ? null : structuredClone(value);
    },
    async setJSON(key, value) {
      data.set(key, structuredClone(value));
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

function requestPayload(overrides = {}) {
  return {
    firstName: 'SMS',
    lastName: 'Compliance',
    phone: '2015550142',
    email: 'sms-compliance@example.test',
    address: '1 Main St, Newark, NJ',
    zipCode: '07102',
    preferredDate: '2099-08-24',
    preferredTime: '10:00 AM',
    preferredArrivalWindow: '',
    scheduleFlexibility: 'exact',
    vehicle: '2024 Honda Civic',
    vehicleCategory: 'cars',
    vehicleTier: 'Small Car',
    package: 'Premium Detail',
    packageId: 'full',
    vehicles: [{
      vehicleId: 'vehicle-1',
      cat: 'cars',
      pkgId: 'full',
      pkgName: 'Premium Detail',
      tierKey: 'small',
      tierLabel: 'Small Car',
      vehicleLabel: '2024 Honda Civic',
      addons: [],
      addonTotal: 0,
    }],
    totalPrice: 240,
    travelFeeAmount: 0,
    zoneSurcharge: 0,
    paymentMethod: '',
    paymentMethodPreference: '',
    cardOnFileRequired: false,
    acceptedCardOnFilePolicy: false,
    acceptedBookingPolicy: true,
    policyVersion: '2026-08-booking-request',
    transactionalSmsConsentAccepted: false,
    marketingSmsConsentAccepted: true,
    ...overrides,
  };
}

async function post(body) {
  const response = await submitBooking.handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.142' },
    body: JSON.stringify(body),
  });
  return { response, body: JSON.parse(response.body) };
}

describe('booking consent evidence and no-card separation', () => {
  const store = createMemoryStore();
  const priorEnv = {};
  const envKeys = [
    'DRAFT_TOKEN_SECRET', 'ADMIN_EMAIL', 'RESEND_API_KEY',
    'CUSTOMER_TRANSACTIONAL_SMS_ENABLED', 'TWILIO_OUTBOX_ENABLED',
    'TWILIO_ENABLED', 'TWILIO_PRODUCTION_SENDS_ENABLED', 'STRIPE_SECRET_KEY',
  ];
  const externalCalls = [];
  let originalFetch;
  let declinedBookingId;

  before(() => {
    for (const key of envKeys) priorEnv[key] = process.env[key];
    process.env.DRAFT_TOKEN_SECRET = 's'.repeat(40);
    process.env.ADMIN_EMAIL = '';
    process.env.RESEND_API_KEY = '';
    process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'false';
    process.env.TWILIO_OUTBOX_ENABLED = 'false';
    process.env.TWILIO_ENABLED = 'false';
    process.env.TWILIO_PRODUCTION_SENDS_ENABLED = 'false';
    delete process.env.STRIPE_SECRET_KEY;
    submitBooking.__test.setPreviewTransactionGuardOverride(async () => ({ previewRequest: false }));
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      externalCalls.push(String(url));
      throw new Error('unexpected_external_call');
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    submitBooking.__test.setPreviewTransactionGuardOverride(null);
    submitBooking.__test.setBlobsStoreOverride(null);
    for (const key of envKeys) {
      if (priorEnv[key] == null) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
  });

  async function finalize(overrides = {}) {
    const draft = await post(requestPayload({ ...overrides, isDraft: true }));
    assert.equal(draft.response.statusCode, 200, draft.body.error);
    const final = await post(requestPayload({
      ...overrides,
      draftBookingId: draft.body.id,
      draftSaveToken: draft.body.draftSaveToken,
    }));
    return { draft, final, saved: await store.get(draft.body.id) };
  }

  it('2/6/18-20/22. unchecked customer books successfully; phone never implies consent', async () => {
    const { final, saved } = await finalize({ transactionalSmsConsentAccepted: false });
    assert.equal(final.response.statusCode, 200, final.body.error);
    assert.equal(final.body.bookingCreated, true);
    assert.equal(saved.transactionalSmsConsentAccepted, false);
    assert.deepEqual(saved.transactionalSmsConsent, canonicalBookingSmsConsent(false, saved.finalizedAt));
    assert.equal(bookingSmsConsentGranted(saved), false);
    assert.equal(saved.marketingSmsConsentAccepted, false);
    assert.equal(saved.acceptedBookingPolicy, true);
    assert.equal(saved.cardOnFileRequired, false);
    assert.equal(saved.cardOnFileStatus, 'not_collected');
    assert.equal('setupIntentId' in saved, false);
    assert.equal(externalCalls.some((url) => url.includes('stripe.com')), false);
    declinedBookingId = saved.id;
  });

  it('3/21. checked customer books successfully with server timestamp/version/source', async () => {
    const { final, saved } = await finalize({
      phone: '2015550143',
      email: 'sms-accepted@example.test',
      preferredDate: '2099-08-25',
      transactionalSmsConsentAccepted: true,
    });
    assert.equal(final.response.statusCode, 200, final.body.error);
    assert.equal(saved.transactionalSmsConsentAccepted, true);
    assert.equal(saved.transactionalSmsConsent.granted, true);
    assert.equal(saved.transactionalSmsConsent.recordedAt, saved.finalizedAt);
    assert.equal(saved.transactionalSmsConsent.textVersion, BOOKING_CONSENT_TEXT_VERSION);
    assert.equal(saved.transactionalSmsConsent.source, BOOKING_CONSENT_SOURCE);
    assert.equal(saved.transactionalSmsConsent.method, 'booking_checkbox');
    assert.equal(saved.transactionalSmsConsent.phoneE164, '+12015550143');
    assert.equal(bookingSmsConsentGranted(saved), true);
    assert.equal(saved.marketingSmsConsentAccepted, false);
    assert.equal(saved.cardOnFileRequired, false);
  });

  it('4/5. SMS consent cannot replace Terms acceptance', async () => {
    const draft = await post(requestPayload({
      phone: '2015550144',
      email: 'sms-no-terms@example.test',
      preferredDate: '2099-08-26',
      isDraft: true,
      acceptedBookingPolicy: false,
      transactionalSmsConsentAccepted: true,
    }));
    const final = await post(requestPayload({
      phone: '2015550144',
      email: 'sms-no-terms@example.test',
      preferredDate: '2099-08-26',
      acceptedBookingPolicy: false,
      transactionalSmsConsentAccepted: true,
      draftBookingId: draft.body.id,
      draftSaveToken: draft.body.draftSaveToken,
    }));
    assert.equal(final.response.statusCode, 400);
    assert.equal(final.body.error, 'booking_policy_required');
  });

  it('23. replay/update cannot turn a declined booking into consent', async () => {
    const before = await store.get(declinedBookingId);
    const replay = await post(requestPayload({
      draftBookingId: declinedBookingId,
      draftSaveToken: 'irrelevant-on-idempotent-finalize',
      transactionalSmsConsentAccepted: true,
    }));
    const afterReplay = await store.get(declinedBookingId);
    assert.equal(replay.response.statusCode, 200);
    assert.equal(replay.body.idempotent, true);
    assert.equal(afterReplay.transactionalSmsConsentAccepted, false);
    assert.deepEqual(afterReplay.transactionalSmsConsent, before.transactionalSmsConsent);
  });
});

function consentPrisma(currentConsent) {
  const state = {
    version: 4,
    consent: currentConsent ? structuredClone(currentConsent) : null,
    writes: 0,
  };
  const tx = {
    customerAccount: {
      async findUnique() {
        return {
          id: 'account-sms-test',
          status: 'active',
          version: state.version,
          profile: { phone: '2015550142', normalizedPhone: '2015550142' },
          consents: state.consent ? [structuredClone(state.consent)] : [],
        };
      },
      async updateMany({ where }) {
        if (where.version !== state.version) return { count: 0 };
        state.version += 1;
        return { count: 1 };
      },
    },
    customerConsent: {
      async upsert({ create, update }) {
        state.consent = state.consent ? { ...state.consent, ...update } : { ...create };
        state.writes += 1;
        return state.consent;
      },
    },
    auditEvent: { async create() { return { id: 'audit-sms-test' }; } },
  };
  return {
    state,
    async $transaction(fn) { return fn(tx); },
  };
}

describe('STOP/revocation precedence over booking replay', () => {
  const consentAt = '2026-08-22T16:00:00.000Z';
  const booking = {
    id: 'CD1-SMS-CONSENT-TEST',
    transactionalSmsConsentAccepted: true,
    transactionalSmsConsent: canonicalBookingSmsConsent(true, consentAt),
  };

  it('a revocation after booking consent cannot be replayed into a new grant', async () => {
    const prisma = consentPrisma({
      channel: 'sms_transactional',
      status: 'revoked',
      grantedAt: new Date(consentAt),
      revokedAt: new Date('2026-08-22T17:00:00.000Z'),
      source: 'twilio_stop',
      consentTextVersion: BOOKING_CONSENT_TEXT_VERSION,
    });
    const result = await grantBookingSmsConsent({
      customerAccountId: 'account-sms-test',
      toE164: '+12015550142',
      booking,
    }, { prisma });
    assert.equal(result.ok, true);
    assert.equal(result.granted, false);
    assert.equal(result.reason, 'newer_revocation');
    assert.equal(prisma.state.writes, 0);
    assert.equal(prisma.state.consent.status, 'revoked');
  });

  it('a new explicit booking opt-in after an older revocation may grant again', async () => {
    const prisma = consentPrisma({
      channel: 'sms_transactional',
      status: 'revoked',
      grantedAt: null,
      revokedAt: new Date('2026-08-22T15:00:00.000Z'),
      source: 'twilio_stop',
      consentTextVersion: BOOKING_CONSENT_TEXT_VERSION,
    });
    const result = await grantBookingSmsConsent({
      customerAccountId: 'account-sms-test',
      toE164: '+12015550142',
      booking,
    }, { prisma });
    assert.equal(result.ok, true);
    assert.equal(result.granted, true);
    assert.equal(prisma.state.writes, 1);
    assert.equal(prisma.state.consent.status, 'granted');
    assert.equal(prisma.state.consent.source, BOOKING_CONSENT_SOURCE);
  });
});
