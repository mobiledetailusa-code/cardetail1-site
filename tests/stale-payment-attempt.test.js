'use strict';

/**
 * A PaymentAttempt leaves 'creating' / 'open' / 'requires_action' only when a
 * Stripe webhook terminalises it, and nothing expires one. A webhook that never
 * arrived — or timed out — therefore blocks every later add-on approval and
 * package change on that booking with payment_attempt_in_progress, forever.
 * Declining stays fast because it never enters the money path, which is the
 * asymmetry an operator sees.
 *
 * Before refusing, ask Stripe what actually happened.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PRISMA_PATH = require.resolve('../netlify/lib/prisma');
let fakePrisma = null;

require.cache[PRISMA_PATH] = {
  id: PRISMA_PATH,
  filename: PRISMA_PATH,
  loaded: true,
  exports: {
    prismaConfigured: () => !!fakePrisma,
    tryGetPrisma: () => fakePrisma,
    getPrisma: () => fakePrisma,
  },
};

const {
  reconcileStalePaymentAttempts,
  paymentAttemptInProgressResponse,
  ATTEMPT_STALE_AFTER_MS,
} = require('../netlify/lib/db/payment-authority-service');

const OLD = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
const FRESH = new Date().toISOString();

function attempt(overrides = {}) {
  return {
    id: 'pa_1',
    bookingId: 'CD1-STUCK',
    status: 'open',
    providerObjectId: 'pi_123',
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

function prismaWith(attempts) {
  const updates = [];
  return {
    updates,
    paymentAttempt: {
      findMany: () => Promise.resolve(attempts),
      update: (args) => { updates.push(args); return Promise.resolve({}); },
    },
  };
}

/** Stripe double: one JSON response for the payment_intents retrieve. */
function stripeReturning(status, { ok = true } = {}) {
  return () => Promise.resolve({
    ok,
    json: () => Promise.resolve(ok ? { id: 'pi_123', status } : { error: { message: 'no such intent' } }),
  });
}

const ENV = { STRIPE_SECRET_KEY: 'sk_test_abc123' };

beforeEach(() => { fakePrisma = null; });
afterEach(() => { fakePrisma = null; });

describe('reconcileStalePaymentAttempts', () => {
  it('closes an attempt Stripe already settled', async () => {
    const prisma = prismaWith([attempt()]);
    fakePrisma = prisma;

    const out = await reconcileStalePaymentAttempts({
      bookingId: 'CD1-STUCK', env: ENV, fetchImpl: stripeReturning('succeeded'),
    });

    assert.equal(out.closed, 1);
    assert.equal(out.active, 0);
    assert.equal(prisma.updates[0].data.status, 'succeeded');
  });

  it('closes an attempt the customer abandoned and Stripe canceled', async () => {
    const prisma = prismaWith([attempt()]);
    fakePrisma = prisma;

    const out = await reconcileStalePaymentAttempts({
      bookingId: 'CD1-STUCK', env: ENV, fetchImpl: stripeReturning('canceled'),
    });

    assert.equal(out.closed, 1);
    assert.equal(prisma.updates[0].data.status, 'canceled');
  });

  it('keeps blocking while Stripe still reports the payment live', async () => {
    const prisma = prismaWith([attempt()]);
    fakePrisma = prisma;

    const out = await reconcileStalePaymentAttempts({
      bookingId: 'CD1-STUCK', env: ENV, fetchImpl: stripeReturning('requires_action'),
    });

    assert.equal(out.closed, 0);
    assert.equal(out.active, 1);
    assert.equal(out.blocked.stripeStatus, 'requires_action');
    assert.equal(prisma.updates.length, 0, 'a live payment must never be closed');
  });

  it('never disturbs an attempt that just started', async () => {
    const prisma = prismaWith([attempt({ createdAt: FRESH, updatedAt: FRESH })]);
    fakePrisma = prisma;
    let called = false;

    const out = await reconcileStalePaymentAttempts({
      bookingId: 'CD1-STUCK',
      env: ENV,
      fetchImpl: () => { called = true; return stripeReturning('succeeded')(); },
    });

    assert.equal(called, false, 'a payment in flight is not worth a round trip');
    assert.equal(out.checked, 0);
    assert.equal(out.active, 1);
  });

  it('leaves the guard strict when Stripe cannot answer', async () => {
    const prisma = prismaWith([attempt()]);
    fakePrisma = prisma;

    const out = await reconcileStalePaymentAttempts({
      bookingId: 'CD1-STUCK', env: ENV, fetchImpl: stripeReturning('succeeded', { ok: false }),
    });

    assert.equal(out.closed, 0);
    assert.equal(out.active, 1);
    assert.equal(prisma.updates.length, 0);
  });

  it('never throws when Prisma or the network is unavailable', async () => {
    fakePrisma = null;
    assert.deepEqual(
      await reconcileStalePaymentAttempts({ bookingId: 'CD1-STUCK', env: ENV }),
      { closed: 0, active: 0, checked: 0, blocked: null }
    );

    fakePrisma = { paymentAttempt: { findMany: () => Promise.reject(new Error('db down')) } };
    const out = await reconcileStalePaymentAttempts({ bookingId: 'CD1-STUCK', env: ENV });
    assert.equal(out.closed, 0);
  });

  it('closes an aged attempt that never reached Stripe', async () => {
    // No payment intent and old enough that no request could still be running:
    // nothing exists at Stripe to close it, so leaving it open blocks every
    // future amount change on the booking permanently. This is the case the
    // first cut skipped, and the one that kept blocking add-on approvals in
    // production after the fix shipped.
    const prisma = prismaWith([attempt({ providerObjectId: null, status: 'creating' })]);
    fakePrisma = prisma;
    let asked = false;

    const out = await reconcileStalePaymentAttempts({
      bookingId: 'CD1-STUCK',
      env: ENV,
      fetchImpl: () => { asked = true; return stripeReturning('succeeded')(); },
    });

    assert.equal(asked, false, 'there is no payment intent to ask about');
    assert.equal(out.closed, 1);
    assert.equal(out.active, 0);
    assert.equal(prisma.updates[0].data.status, 'canceled');
    assert.equal(prisma.updates[0].data.failureCode, 'never_reached_stripe');
  });

  it('leaves a young attempt without a payment intent alone', async () => {
    // Mid-creation: the request that reserved it may still be running.
    const prisma = prismaWith([attempt({
      providerObjectId: null, status: 'creating', createdAt: FRESH, updatedAt: FRESH,
    })]);
    fakePrisma = prisma;

    const out = await reconcileStalePaymentAttempts({ bookingId: 'CD1-STUCK', env: ENV });

    assert.equal(out.closed, 0);
    assert.equal(out.active, 1);
    assert.equal(prisma.updates.length, 0);
  });

  it('actually reaches Prisma rather than swallowing a missing import', async () => {
    // The first cut called tryGetPrisma() without importing it. The ReferenceError
    // landed in the catch, every reconcile returned "nothing to do", and the guard
    // stayed stale in exactly the case this exists to fix.
    let asked = false;
    fakePrisma = {
      paymentAttempt: {
        findMany: () => { asked = true; return Promise.resolve([]); },
        update: () => Promise.resolve({}),
      },
    };
    await reconcileStalePaymentAttempts({ bookingId: 'CD1-STUCK', env: ENV });
    assert.equal(asked, true, 'reconciliation must query the attempts, not fail silently');
  });

  it('waits a couple of minutes before calling an attempt stale', () => {
    assert.ok(ATTEMPT_STALE_AFTER_MS >= 60 * 1000);
    assert.ok(ATTEMPT_STALE_AFTER_MS <= 10 * 60 * 1000);
  });
});

describe('supersedeOutdatedAttempts', () => {
  const { supersedeOutdatedAttempts } = require('../netlify/lib/db/payment-authority-service');

  /** Stripe double that answers retrieve and cancel differently. */
  function stripe({ retrieveStatus = 'requires_payment_method', cancelOk = true } = {}) {
    const calls = [];
    const impl = (url, opts) => {
      calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
      if (String(url).endsWith('/cancel')) {
        return Promise.resolve({
          ok: cancelOk,
          json: () => Promise.resolve(cancelOk ? { status: 'canceled' } : { error: { message: 'nope' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: retrieveStatus }) });
    };
    impl.calls = calls;
    return impl;
  }

  it('cancels the stale intent at Stripe before retiring the attempt', async () => {
    const prisma = prismaWith([attempt({ quoteVersion: 1 })]);
    fakePrisma = prisma;
    const fetchImpl = stripe();

    const out = await supersedeOutdatedAttempts({
      bookingId: 'CD1-STUCK', currentQuoteVersion: 2, env: ENV, fetchImpl,
    });

    assert.equal(out.superseded, 1);
    assert.ok(fetchImpl.calls.some((c) => c.url.endsWith('/cancel') && c.method === 'POST'),
      'the customer must not be able to pay an amount that no longer applies');
    assert.equal(prisma.updates[0].data.status, 'superseded');
  });

  it('never voids an intent Stripe already settled', async () => {
    const prisma = prismaWith([attempt({ quoteVersion: 1 })]);
    fakePrisma = prisma;
    const fetchImpl = stripe({ retrieveStatus: 'succeeded' });

    const out = await supersedeOutdatedAttempts({
      bookingId: 'CD1-STUCK', currentQuoteVersion: 2, env: ENV, fetchImpl,
    });

    assert.equal(out.settled, 1);
    assert.equal(out.superseded, 0);
    assert.ok(!fetchImpl.calls.some((c) => c.url.endsWith('/cancel')),
      'money that moved is a settlement to record, never an obligation to void');
    assert.equal(prisma.updates[0].data.status, 'succeeded');
  });

  it('keeps the attempt open when Stripe refuses the cancel', async () => {
    const prisma = prismaWith([attempt({ quoteVersion: 1 })]);
    fakePrisma = prisma;

    const out = await supersedeOutdatedAttempts({
      bookingId: 'CD1-STUCK', currentQuoteVersion: 2, env: ENV, fetchImpl: stripe({ cancelOk: false }),
    });

    assert.equal(out.failed, 1);
    assert.equal(prisma.updates.length, 0, 'two live amounts is worse than a blocked change');
  });

  it('retires an outdated attempt that never reached Stripe without calling out', async () => {
    const prisma = prismaWith([attempt({ quoteVersion: 1, providerObjectId: null, status: 'creating' })]);
    fakePrisma = prisma;
    const fetchImpl = stripe();

    const out = await supersedeOutdatedAttempts({
      bookingId: 'CD1-STUCK', currentQuoteVersion: 2, env: ENV, fetchImpl,
    });

    assert.equal(out.superseded, 1);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(prisma.updates[0].data.failureCode, 'quote_version_superseded');
  });

  it('does nothing without a usable current version', async () => {
    // Number(null) and Number('') are both 0. Coercing an absent version would
    // read as version 0 and supersede every attempt on the booking, so the
    // absent case has to be rejected before the coercion.
    const fetchImpl = stripe();
    for (const version of [null, undefined, '', 'not-a-number']) {
      const prisma = prismaWith([attempt({ quoteVersion: 1 })]);
      fakePrisma = prisma;
      assert.deepEqual(
        await supersedeOutdatedAttempts({
          bookingId: 'CD1-STUCK', currentQuoteVersion: version, env: ENV, fetchImpl,
        }),
        { superseded: 0, settled: 0, failed: 0 },
        `version ${JSON.stringify(version)} must be treated as unknown`
      );
      assert.equal(prisma.updates.length, 0);
    }
    assert.equal(fetchImpl.calls.length, 0, 'nothing may be canceled at Stripe on an unknown version');
  });
});

describe('the guard only blocks on the amount being changed', () => {
  const svc = fs.readFileSync(
    path.join(__dirname, '..', 'netlify', 'lib', 'db', 'payment-authority-service.js'),
    'utf8'
  );

  it('scopes the active-attempt query to the current quote version', () => {
    const guard = svc.slice(svc.indexOf('const activeAttempt = await tx.paymentAttempt.findFirst'));
    assert.match(guard.slice(0, 400), /quoteVersion: previousQuote\.quoteVersion/);
  });

  it('retires outdated attempts before the transaction opens', () => {
    const call = svc.indexOf('await supersedeOutdatedAttempts({ bookingId: id');
    const tx = svc.indexOf('runSerializableWithRetry', call);
    assert.ok(call > -1 && tx > call);
  });
});

describe('the refusal tells the operator what is blocking', () => {
  it('names the attempt, its age and what Stripe reports', () => {
    const body = paymentAttemptInProgressResponse({
      attempt: attempt(), ageMs: 42 * 60 * 1000, stripeStatus: 'requires_action',
    });
    assert.equal(body.error, 'payment_attempt_in_progress');
    assert.equal(body.statusCode, 409);
    assert.equal(body.attemptId, 'pa_1');
    assert.equal(body.attemptAgeMinutes, 42);
    assert.equal(body.stripeStatus, 'requires_action');
    assert.match(body.message, /requires_action/);
  });

  it('suggests the next move when an attempt has been open a long time', () => {
    const body = paymentAttemptInProgressResponse({
      attempt: attempt(), ageMs: 90 * 60 * 1000, stripeStatus: null,
    });
    assert.match(body.message, /cancel it in Stripe/i);
  });

  it('still answers without detail when there is none', () => {
    const body = paymentAttemptInProgressResponse(null);
    assert.equal(body.error, 'payment_attempt_in_progress');
    assert.ok(body.message);
  });
});

describe('wiring', () => {
  const svc = fs.readFileSync(
    path.join(__dirname, '..', 'netlify', 'lib', 'db', 'payment-authority-service.js'),
    'utf8'
  );

  it('reconciles before the transaction, never inside it', () => {
    const call = svc.indexOf('await reconcileStalePaymentAttempts({ bookingId: id })');
    const tx = svc.indexOf('runSerializableWithRetry', call);
    assert.ok(call > -1 && tx > call, 'network calls must not be held inside a serializable transaction');
  });

  it('the adjustment guard answers with the detailed body', () => {
    assert.match(svc, /return paymentAttemptInProgressResponse\(/);
  });

  it('admin surfaces the explanation instead of the code', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin-ops.html'), 'utf8');
    assert.match(html, /payment_attempt_in_progress/);
    assert.match(html, /attemptAgeMinutes/);
  });
});
