'use strict';

/**
 * CASE A/B/C customer SMS policy:
 * consent false → no SMS
 * consent + verified match → access SMS (/a?t=)
 * consent + verified mismatch → safe confirmation (no private link)
 * Must not mutate account verified phone or weaken My Garage isolation.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalBookingSmsConsent,
  bookingSmsConsentGranted,
  BOOKING_CONSENT_TEXT_VERSION,
} = require('../netlify/lib/sms-program');
const {
  assertCustomerSmsConsent,
  loadAccountVerifiedPhoneE164,
  grantBookingSmsConsent,
} = require('../netlify/lib/sms-consent-service');
const {
  resolveCustomerBookingSmsPlan,
  EVENT_REQUEST_RECEIVED,
} = require('../netlify/lib/booking-transactional-notifications');
const {
  renderSmsTemplate,
  TEMPLATE_KEYS,
} = require('../netlify/lib/sms-templates');
const { normalizeUsPhoneE164, phonesMatch } = require('../netlify/lib/phone-auth');
const { generateOpaqueToken, buildAccessUrl } = require('../netlify/lib/appointment-access-token');

const VERIFIED = '+15513132956';
const BOOKING_OTHER = '+15513983986';
const ACCESS_URL = 'https://cardetail1.com/a?t=aat_TEST_OPAQUE_TOKEN_VALUE_NOT_REAL';

function consentedBooking(phone, overrides = {}) {
  const recordedAt = overrides.recordedAt || '2026-08-26T04:00:00.000Z';
  return {
    id: 'CD1-SMS-MISMATCH-TEST',
    phone,
    email: 'owner-test@example.test',
    transactionalSmsConsentAccepted: true,
    transactionalSmsConsent: canonicalBookingSmsConsent(true, recordedAt, phone),
    ...overrides,
  };
}

function accountPrisma({ verifiedPhone = '5513132956', consentStatus = 'granted', revokedAt = null } = {}) {
  const profile = {
    phone: verifiedPhone,
    normalizedPhone: String(verifiedPhone || '').replace(/\D/g, '').replace(/^1/, '').slice(-10) || null,
  };
  const consents = consentStatus
    ? [{
      channel: 'sms_transactional',
      status: consentStatus,
      grantedAt: consentStatus === 'granted' ? new Date('2026-08-20T00:00:00.000Z') : null,
      revokedAt: revokedAt ? new Date(revokedAt) : null,
      consentTextVersion: BOOKING_CONSENT_TEXT_VERSION,
      source: consentStatus === 'revoked' ? 'twilio_stop' : 'public_booking_checkbox',
    }]
    : [];
  return {
    customerAccount: {
      async findUnique() {
        return {
          id: 'account-sms-mismatch',
          status: 'active',
          version: 2,
          profile,
          consents,
        };
      },
    },
    async $transaction(fn) {
      return fn(this);
    },
  };
}

describe('phone normalization is not a false mismatch source', () => {
  it('formats of the same US number compare equal after E.164 normalize', () => {
    const forms = ['+15513132956', '(551) 313-2956', '5513132956', '1-551-313-2956'];
    const normalized = forms.map((f) => normalizeUsPhoneE164(f));
    assert.ok(normalized.every((n) => n === VERIFIED));
    assert.equal(phonesMatch('(551) 313-2956', '+15513132956'), true);
    assert.equal(phonesMatch('5513983986', VERIFIED), false);
  });
});

describe('resolveCustomerBookingSmsPlan CASE A/B/C', () => {
  it('1. consent=false → no customer SMS', () => {
    const booking = consentedBooking(VERIFIED, {
      transactionalSmsConsentAccepted: false,
      transactionalSmsConsent: canonicalBookingSmsConsent(false, '2026-08-26T04:00:00.000Z'),
    });
    const plan = resolveCustomerBookingSmsPlan({
      booking,
      toE164: VERIFIED,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: ACCESS_URL,
    });
    assert.equal(plan.send, false);
    assert.equal(plan.reason, 'booking_sms_consent_required');
  });

  it('2. consent=true + exact verified phone → access SMS allowed', () => {
    const plan = resolveCustomerBookingSmsPlan({
      booking: consentedBooking(VERIFIED),
      toE164: VERIFIED,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: ACCESS_URL,
    });
    assert.equal(plan.send, true);
    assert.equal(plan.mode, 'with_access');
    assert.equal(plan.includeAccessUrl, true);
    assert.equal(plan.templateKey, EVENT_REQUEST_RECEIVED);
    assert.equal(plan.templateData.url, ACCESS_URL);
  });

  it('3. consent=true + same phone different formatting → access SMS allowed', () => {
    const plan = resolveCustomerBookingSmsPlan({
      booking: consentedBooking('(551) 313-2956'),
      toE164: '551-313-2956',
      verifiedPhoneE164: '+1 (551) 313-2956',
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: ACCESS_URL,
    });
    assert.equal(plan.send, true);
    assert.equal(plan.mode, 'with_access');
    assert.equal(plan.includeAccessUrl, true);
  });

  it('4. consent=true + different phone → safe confirmation SMS', () => {
    const plan = resolveCustomerBookingSmsPlan({
      booking: consentedBooking(BOOKING_OTHER),
      toE164: BOOKING_OTHER,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: ACCESS_URL,
    });
    assert.equal(plan.send, true);
    assert.equal(plan.mode, 'safe_confirmation');
    assert.equal(plan.includeAccessUrl, false);
    assert.equal(plan.templateKey, TEMPLATE_KEYS.SAFE_CONFIRMATION);
  });

  it('5/6. mismatched phone → /a?t= and access token NOT included', () => {
    const plan = resolveCustomerBookingSmsPlan({
      booking: consentedBooking(BOOKING_OTHER),
      toE164: BOOKING_OTHER,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: ACCESS_URL,
    });
    const rendered = renderSmsTemplate(plan.templateKey, plan.templateData);
    assert.equal(rendered.ok, true);
    assert.doesNotMatch(rendered.body, /\/a\?t=/);
    assert.doesNotMatch(rendered.body, /aat_/);
    assert.doesNotMatch(rendered.body, /my-garage/i);
    assert.equal(plan.templateData.url, undefined);
  });

  it('8. safe confirmation retains STOP/HELP and brand', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.SAFE_CONFIRMATION, {});
    assert.equal(rendered.ok, true);
    assert.match(rendered.body, /Detailing Zone/);
    assert.match(rendered.body, /STOP/i);
    assert.match(rendered.body, /HELP/i);
    assert.match(rendered.body, /booking request/i);
  });

  it('9. no consent → safe confirmation NOT planned', () => {
    const booking = {
      phone: BOOKING_OTHER,
      transactionalSmsConsentAccepted: false,
      transactionalSmsConsent: canonicalBookingSmsConsent(false, '2026-08-26T04:00:00.000Z'),
    };
    const plan = resolveCustomerBookingSmsPlan({
      booking,
      toE164: BOOKING_OTHER,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: ACCESS_URL,
    });
    assert.equal(plan.send, false);
  });

  it('12. malicious/invalid phone fails closed', () => {
    const plan = resolveCustomerBookingSmsPlan({
      booking: consentedBooking('not-a-phone'),
      toE164: 'not-a-phone',
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: ACCESS_URL,
    });
    assert.equal(plan.send, false);
    assert.equal(plan.reason, 'invalid_sms_recipient');
  });

  it('13. unsupported/non-SMS destination fails safely', () => {
    const plan = resolveCustomerBookingSmsPlan({
      booking: consentedBooking('+442071838750'),
      toE164: '+442071838750',
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
    });
    assert.equal(plan.send, false);
    assert.equal(plan.reason, 'invalid_sms_recipient');
  });
});

describe('assertCustomerSmsConsent booking path vs account path', () => {
  it('14. booking consent + mismatch destination is allowed for enqueue (not verified_phone_mismatch)', async () => {
    const prisma = accountPrisma({ verifiedPhone: '5513132956', consentStatus: null });
    const result = await assertCustomerSmsConsent({
      customerAccountId: 'account-sms-mismatch',
      toE164: BOOKING_OTHER,
      booking: consentedBooking(BOOKING_OTHER),
    }, { prisma });
    assert.equal(result.ok, true);
    assert.equal(result.accessAuthorized, false);
    assert.equal(result.source, 'public_booking_checkbox');
  });

  it('matching verified phone remains accessAuthorized', async () => {
    const prisma = accountPrisma({ verifiedPhone: '5513132956', consentStatus: 'granted' });
    const result = await assertCustomerSmsConsent({
      customerAccountId: 'account-sms-mismatch',
      toE164: VERIFIED,
      booking: consentedBooking(VERIFIED),
    }, { prisma });
    assert.equal(result.ok, true);
    assert.equal(result.accessAuthorized, true);
  });

  it('without booking consent, destination mismatch still suppresses as verified_phone_mismatch', async () => {
    const prisma = accountPrisma({ verifiedPhone: '5513132956', consentStatus: 'granted' });
    const result = await assertCustomerSmsConsent({
      customerAccountId: 'account-sms-mismatch',
      toE164: BOOKING_OTHER,
      booking: null,
    }, { prisma });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'verified_phone_mismatch');
  });
});

describe('7/15. verified phone and account isolation preserved', () => {
  it('7. grantBookingSmsConsent does not rewrite verified phone on mismatch', async () => {
    const state = {
      version: 2,
      profilePhone: '5513132956',
      consent: null,
      writes: 0,
      profileWrites: 0,
    };
    const prisma = {
      state,
      async $transaction(fn) {
        const tx = {
          customerAccount: {
            async findUnique() {
              return {
                id: 'account-sms-mismatch',
                status: 'active',
                version: state.version,
                profile: { phone: state.profilePhone, normalizedPhone: state.profilePhone },
                consents: state.consent ? [state.consent] : [],
              };
            },
            async updateMany() {
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
          customerProfile: {
            async update() {
              state.profileWrites += 1;
              throw new Error('profile_must_not_mutate');
            },
          },
          auditEvent: { async create() { return { id: 'a1' }; } },
        };
        return fn(tx);
      },
    };
    const result = await grantBookingSmsConsent({
      customerAccountId: 'account-sms-mismatch',
      toE164: BOOKING_OTHER,
      booking: consentedBooking(BOOKING_OTHER),
    }, { prisma });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'verified_phone_mismatch');
    assert.equal(state.profilePhone, '5513132956');
    assert.equal(state.profileWrites, 0);
    assert.equal(state.writes, 0);
  });

  it('15. loadAccountVerifiedPhoneE164 is read-only and returns E.164', async () => {
    const prisma = accountPrisma({ verifiedPhone: '5513132956' });
    const phone = await loadAccountVerifiedPhoneE164('account-sms-mismatch', { prisma });
    assert.equal(phone, VERIFIED);
  });
});

describe('access link security release gate', () => {
  it('token is opaque/unguessable and URL carries no PII', () => {
    process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
    process.env.CONTEXT = 'production';
    process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
    const token = generateOpaqueToken();
    assert.match(token, /^aat_/);
    assert.ok(token.length >= 40);
    const url = buildAccessUrl(token);
    assert.match(url, /^https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(url, /phone=|email=|bookingId=|customerAccountId=/i);
  });

  it('with_access body may include /a?t=; safe body must not', () => {
    const withAccess = renderSmsTemplate(TEMPLATE_KEYS.REQUEST_RECEIVED, { url: ACCESS_URL });
    const safe = renderSmsTemplate(TEMPLATE_KEYS.SAFE_CONFIRMATION, { url: ACCESS_URL });
    assert.match(withAccess.body, /\/a\?t=/);
    // Even if a caller mistakenly passes url, SAFE_CONFIRMATION ignores it.
    assert.doesNotMatch(safe.body, /\/a\?t=/);
  });
});

describe('admin SMS and email paths remain independent (static contract)', () => {
  it('10. admin booking template does not require customer consent helpers', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_BOOKING, {
      bookingRef: 'CD1-ADMIN',
      customerName: 'Owner',
      customerPhone: VERIFIED,
    });
    assert.equal(rendered.ok, true);
    assert.match(rendered.body, /Booking alert/);
  });

  it('11. customer email builder still accepts access URLs (email unchanged by this fix)', () => {
    const {
      buildEmailContent,
      EVENT_REQUEST_RECEIVED: EVT,
    } = require('../netlify/lib/booking-transactional-notifications');
    const content = buildEmailContent(EVT, consentedBooking(BOOKING_OTHER), ACCESS_URL);
    assert.match(content.html || content.text, /\/a\?t=/);
  });
});

describe('consent evidence binds submitted phone', () => {
  it('persists phoneE164 on grant and rejects mismatched consent phone', () => {
    const ok = consentedBooking('(551) 398-3986');
    assert.equal(ok.transactionalSmsConsent.phoneE164, BOOKING_OTHER);
    assert.equal(bookingSmsConsentGranted(ok), true);

    const drifted = {
      ...ok,
      phone: VERIFIED,
    };
    assert.equal(bookingSmsConsentGranted(drifted), false);
  });
});

describe('source contract: mismatch path does not silently alter profile services', () => {
  it('sms-consent-service never writes profile phone fields', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../netlify/lib/sms-consent-service.js'),
      'utf8'
    );
    assert.doesNotMatch(src, /customerProfile\.update\b/);
    assert.doesNotMatch(src, /customerProfile\.upsert\b/);
    assert.doesNotMatch(src, /profile:\s*\{\s*update/);
  });
});
