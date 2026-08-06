'use strict';

/**
 * Concurrent booking confirmation — CAS transition + stable notification identity.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');

process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
process.env.RESEND_API_KEY = 're_test';
process.env.RESEND_FROM = 'test@example.com';
process.env.CONTEXT = process.env.CONTEXT || 'production';
process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = '';

const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
const { confirmBookingTransition } = require('../netlify/lib/booking-confirm');
const {
  emitConfirmed,
  eventStateKey,
  EVENT_CONFIRMED,
  idempotencyKey,
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
} = require('../netlify/lib/booking-transactional-notifications');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');

function pendingBooking(id = 'CD1-CONFIRM-1') {
  return {
    id,
    bookingVersion: 3,
    firstName: 'Sam',
    lastName: 'Customer',
    email: 'sam@example.com',
    phone: '5513132956',
    package: 'Interior',
    vehicle: '2021 Toyota Camry',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    preferredDate: '2026-08-10',
    totalPrice: 220,
    approvedFinalAmount: 220,
    finalizedAt: '2026-07-24T12:00:00.000Z',
    schemaVersion: 1,
    quoteVersion: 1,
  };
}

function installBookingStore(seedBooking) {
  const store = createCasMemoryStore({ [seedBooking.id]: seedBooking });
  // booking-repository getBookingRecord uses getWithMetadata + adapt/normalize.
  // Provide __etag-compatible shape via CAS store.
  setBookingStoreOverride(store);
  return store;
}

test.beforeEach(() => {
  const tokenStore = createCasMemoryStore();
  const focusStore = createCasMemoryStore();
  const claimStore = createCasMemoryStore();
  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => focusStore,
  });
  setNotificationClaimStoreFactory(() => claimStore);
});

test.afterEach(() => {
  setBookingStoreOverride(null);
  resetAppointmentAccessStoreFactories();
  resetNotificationClaimStoreFactory();
  delete process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED;
});

test('two simultaneous confirm transitions: exactly one transitioned', async () => {
  const booking = pendingBooking('CD1-CONF-2');
  installBookingStore(booking);

  const [a, b] = await Promise.all([
    confirmBookingTransition({ bookingId: booking.id, now: '2026-07-24T15:00:00.000Z' }),
    confirmBookingTransition({ bookingId: booking.id, now: '2026-07-24T15:00:01.000Z' }),
  ]);

  const winners = [a, b].filter((r) => r.ok && r.transitioned);
  const idempotent = [a, b].filter((r) => r.ok && r.idempotent);
  assert.equal(winners.length, 1);
  assert.equal(idempotent.length, 1);
  assert.ok(winners[0].booking.confirmedAt);
  assert.equal(idempotent[0].booking.confirmedAt, winners[0].booking.confirmedAt);
  assert.equal(
    winners[0].booking.confirmationEventId,
    idempotent[0].booking.confirmationEventId
  );
});

test('ten simultaneous confirm attempts still transition once', async () => {
  const booking = pendingBooking('CD1-CONF-10');
  installBookingStore(booking);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      confirmBookingTransition({
        bookingId: booking.id,
        now: `2026-07-24T16:00:0${i}.000Z`,
      }))
  );
  assert.equal(results.filter((r) => r.transitioned).length, 1);
  assert.equal(results.filter((r) => r.idempotent).length, 9);
});

test('stable notification key identical for same confirmation transition', async () => {
  const booking = pendingBooking('CD1-CONF-KEY');
  installBookingStore(booking);
  const transition = await confirmBookingTransition({
    bookingId: booking.id,
    now: '2026-07-24T17:00:00.000Z',
  });
  assert.equal(transition.transitioned, true);
  const key1 = eventStateKey(EVENT_CONFIRMED, transition.booking);
  const key2 = eventStateKey(EVENT_CONFIRMED, { ...transition.booking });
  assert.equal(key1, key2);
  assert.match(key1, /^confirmed:CD1-CONF-KEY:2026-07-24T17:00:00.000Z$|^confirmed:CD1-CONF-KEY:/);
  assert.equal(key1, transition.booking.confirmationEventId);
});

test('two concurrent emitConfirmed after one CAS confirm: one email terminal send', async () => {
  const booking = pendingBooking('CD1-CONF-EMAIL');
  installBookingStore(booking);
  const transition = await confirmBookingTransition({
    bookingId: booking.id,
    now: '2026-07-24T18:00:00.000Z',
  });

  let emailCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      emailCalls += 1;
      return { ok: true, json: async () => ({ id: `em_${emailCalls}` }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };

  try {
    const [a, b] = await Promise.all([
      emitConfirmed(transition.booking, {}),
      emitConfirmed(transition.booking, {}),
    ]);
    assert.equal(emailCalls, 1, 'atomic claim must admit exactly one provider send');
    // A losing claimant reports sent+skipped because the peer owns the terminal
    // send. Identify the provider caller by the absence of the skipped marker;
    // scheduler order is intentionally nondeterministic under the full suite.
    const winner = a.delivery?.email?.sent && !a.delivery?.email?.skipped ? a : b;
    const loser = winner === a ? b : a;
    assert.equal(winner.delivery.email.sent, true);
    assert.equal(!!loser.delivery.email.skipped || !!loser.skipped, true);
    const before = emailCalls;
    const third = await emitConfirmed(winner.booking, {});
    assert.equal(third.skipped, true);
    assert.equal(emailCalls, before);
  } finally {
    global.fetch = originalFetch;
  }
});

test('already-confirmed booking produces no duplicate notification', async () => {
  const booking = pendingBooking('CD1-CONF-AGAIN');
  installBookingStore(booking);
  const first = await confirmBookingTransition({
    bookingId: booking.id,
    now: '2026-07-24T19:00:00.000Z',
  });

  let emailCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      emailCalls += 1;
      return { ok: true, json: async () => ({ id: 'em' }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    const sent = await emitConfirmed(first.booking, {});
    assert.equal(sent.ok, true);
    assert.equal(emailCalls, 1);
    const again = await confirmBookingTransition({
      bookingId: booking.id,
      now: '2026-07-24T19:05:00.000Z',
    });
    assert.equal(again.idempotent, true);
    assert.equal(again.transitioned, false);
    const resent = await emitConfirmed(again.booking.transactionalNotifications
      ? again.booking
      : sent.booking, {});
    // Use booking with ledger from first send.
    const withLedger = sent.booking;
    const skipped = await emitConfirmed(withLedger, {});
    assert.equal(skipped.skipped, true);
    assert.equal(emailCalls, 1);
    void resent;
  } finally {
    global.fetch = originalFetch;
  }
});

test('retry after notification failure can resend safely', async () => {
  const booking = pendingBooking('CD1-CONF-RETRY');
  installBookingStore(booking);
  const transition = await confirmBookingTransition({
    bookingId: booking.id,
    now: '2026-07-24T20:00:00.000Z',
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, text: async () => 'down', json: async () => ({}) });
  const failed = await emitConfirmed(transition.booking, {});
  assert.equal(failed.delivery.email.sent, false);
  const stateKey = eventStateKey(EVENT_CONFIRMED, failed.booking);
  const emailKey = idempotencyKey(booking.id, EVENT_CONFIRMED, stateKey, 'email');
  assert.equal(failed.booking.transactionalNotifications[emailKey].status, 'failed');
  assert.equal(failed.booking.transactionalNotifications[emailKey].retryable, true);

  let emailCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      emailCalls += 1;
      return { ok: true, json: async () => ({ id: 'ok' }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    const retry = await emitConfirmed(failed.booking, {});
    assert.equal(retry.delivery.email.sent, true);
    assert.equal(emailCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('admin-ops and update-booking racing each other send once', async () => {
  const booking = pendingBooking('CD1-CONF-CROSS');
  installBookingStore(booking);

  let emailCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      emailCalls += 1;
      return { ok: true, json: async () => ({ id: `em_${emailCalls}` }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };

  try {
    // Simulate both paths calling the shared CAS transition then emit.
    const [t1, t2] = await Promise.all([
      confirmBookingTransition({ bookingId: booking.id, now: '2026-07-24T21:00:00.000Z', by: 'admin-ops' }),
      confirmBookingTransition({ bookingId: booking.id, now: '2026-07-24T21:00:01.000Z', by: 'update-booking' }),
    ]);
    assert.equal([t1, t2].filter((t) => t.transitioned).length, 1);
    const authoritative = t1.transitioned ? t1.booking : t2.booking;
    const other = t1.transitioned ? t2.booking : t1.booking;
    // Both paths notify using the authoritative confirmation identity.
    const n1 = await emitConfirmed(authoritative, {});
    const n2 = await emitConfirmed({
      ...other,
      confirmationEventId: authoritative.confirmationEventId,
      confirmedAt: authoritative.confirmedAt,
      transactionalNotifications: n1.booking.transactionalNotifications,
    }, {});
    assert.equal(emailCalls, 1);
    assert.equal(n2.skipped, true);
    assert.equal(
      eventStateKey(EVENT_CONFIRMED, authoritative),
      eventStateKey(EVENT_CONFIRMED, {
        ...other,
        confirmationEventId: authoritative.confirmationEventId,
        confirmedAt: authoritative.confirmedAt,
      })
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('spoofed Host header cannot change domain in customer email link', async () => {
  const booking = pendingBooking('CD1-CONF-HOST');
  installBookingStore(booking);
  const transition = await confirmBookingTransition({
    bookingId: booking.id,
    now: '2026-07-24T22:00:00.000Z',
  });

  process.env.CONTEXT = process.env.CONTEXT || 'production';
process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  delete process.env.URL;
  delete process.env.DEPLOY_PRIME_URL;

  const originalFetch = global.fetch;
  let capturedText = '';
  global.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      const body = JSON.parse(init.body);
      capturedText = String(body.text || '') + String(body.html || '');
      return { ok: true, json: async () => ({ id: 'em' }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    await emitConfirmed(transition.booking, {
      event: {
        headers: {
          Host: 'evil.example',
          'x-forwarded-host': 'phish.example',
          'x-forwarded-proto': 'https',
        },
      },
    });
    assert.match(capturedText, /https:\/\/cardetail1\.com\/\.netlify\/functions\/customer-appointment-access/);
    assert.doesNotMatch(capturedText, /evil\.example|phish\.example/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('legacy Twilio credentials cannot bypass the outbox during concurrent confirm', async () => {
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_SID = 'ACtest';
  process.env.TWILIO_TOKEN = 'token';
  process.env.TWILIO_FROM = '+15551112222';

  const booking = pendingBooking('CD1-CONF-SMS');
  installBookingStore(booking);
  const transition = await confirmBookingTransition({
    bookingId: booking.id,
    now: '2026-07-24T23:00:00.000Z',
  });

  let smsCalls = 0;
  let emailCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) {
      emailCalls += 1;
      return { ok: true, json: async () => ({ id: 'em' }), text: async () => '' };
    }
    if (String(url).includes('twilio.com')) {
      smsCalls += 1;
      return { ok: true, json: async () => ({ sid: 'SM1' }), text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    const first = await emitConfirmed(transition.booking, {});
    const second = await emitConfirmed(first.booking, {});
    assert.equal(emailCalls, 1);
    assert.equal(smsCalls, 0);
    assert.equal(first.delivery.sms.reason, 'customer_sms_not_enabled');
    assert.equal(second.skipped, true);
  } finally {
    global.fetch = originalFetch;
    delete process.env.TWILIO_SID;
    delete process.env.TWILIO_TOKEN;
    delete process.env.TWILIO_FROM;
  }
});

test('legitimate future action-required uses a distinct key', async () => {
  const booking = {
    ...pendingBooking('CD1-CONF-FUTURE'),
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    confirmedAt: '2026-07-24T23:30:00.000Z',
    confirmationEventId: 'confirmed:CD1-CONF-FUTURE:2026-07-24T23:30:00.000Z',
    paymentWorkflowStatus: 'payment_action_required',
    customerApprovalStatus: 'pending',
    remainingCents: 5000,
    bookingVersion: 5,
  };
  const confKey = eventStateKey(EVENT_CONFIRMED, booking);
  const {
    EVENT_ACTION_REQUIRED,
    eventStateKey: esk,
  } = require('../netlify/lib/booking-transactional-notifications');
  const actionKey = esk(EVENT_ACTION_REQUIRED, booking);
  assert.notEqual(confKey, actionKey);
});
