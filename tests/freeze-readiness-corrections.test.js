'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeVehicleSubtotal } = require('../netlify/lib/booking-price-catalog');
const { bookingMatchesVerifiedContact } = require('../netlify/functions/customer-portal-auth');
const portal = require('../netlify/functions/customer-portal-data');
const {
  suppressPhone,
  isPhoneSuppressed,
  clearSuppression,
} = require('../netlify/lib/sms-suppression');
const { TERMS_POLICY_VERSION } = require('../netlify/lib/customer-policy');

describe('jet ski server price', () => {
  it('prices a Jet Ski maintenance wash at the powersports tier', () => {
    const quoted = computeVehicleSubtotal({
      cat: 'boats',
      boatType: 'jetski',
      tierKey: 'jetski',
      pkgId: 'maint',
      lengthFt: '',
      addons: [],
    });
    assert.equal(quoted.ok, true);
    assert.equal(quoted.basePrice, 105);
    assert.equal(quoted.tierKey, 'jetski');
  });

  it('keeps a 22 ft runabout on marine length pricing', () => {
    const quoted = computeVehicleSubtotal({
      cat: 'boats',
      boatType: 'runabout',
      tierKey: 'length',
      pkgId: 'maint',
      lengthFt: 22,
      addons: [],
    });
    assert.equal(quoted.ok, true);
    assert.equal(quoted.basePrice, 242);
    assert.equal(quoted.tierKey, 'length');
  });
});

describe('magic-link contact match', () => {
  const booking = { email: 'owner@example.com', phone: '2015550100' };

  it('requires the booking email and, when supplied, the same booking phone', () => {
    assert.equal(bookingMatchesVerifiedContact(booking, {
      email: 'owner@example.com',
      phoneDigits: '2015550100',
    }), true);
    assert.equal(bookingMatchesVerifiedContact(booking, {
      email: 'attacker@example.com',
      phoneDigits: '2015550100',
    }), false);
    assert.equal(bookingMatchesVerifiedContact(
      { email: '', phone: '2015550100' },
      { email: 'attacker@example.com', phoneDigits: '2015550100' }
    ), false);
    assert.equal(bookingMatchesVerifiedContact(booking, {
      email: 'owner@example.com',
      phoneDigits: '',
    }), true);
  });

  it('portal discovery requires both factors when the session has both', () => {
    const match = portal.__test.contactMatchesSession;
    assert.equal(match(booking, {
      emailHash: require('node:crypto').createHash('sha256').update('owner@example.com').digest('base64url'),
      phoneDigits: '2015550100',
    }), true);
    assert.equal(match(booking, {
      emailHash: require('node:crypto').createHash('sha256').update('attacker@example.com').digest('base64url'),
      phoneDigits: '2015550100',
    }), false);
  });
});

describe('SMS STOP suppression', () => {
  it('suppresses a phone without a customer profile and clears on START', async () => {
    delete process.env.NETLIFY;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    const phone = '+12015550177';
    const stored = await suppressPhone(phone);
    assert.equal(stored.ok, true);
    assert.equal(await isPhoneSuppressed(phone), true);
    const cleared = await clearSuppression(phone);
    assert.equal(cleared.ok, true);
    assert.equal(await isPhoneSuppressed(phone), false);
  });
});

describe('terms policy version', () => {
  it('uses one version for card and cash booking requests', () => {
    assert.equal(TERMS_POLICY_VERSION, '2026-09-dba-booking-request');
  });
});
