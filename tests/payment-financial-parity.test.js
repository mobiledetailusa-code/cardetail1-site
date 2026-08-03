/**
 * Payment reconciliation parity — Admin + Customer share financialProjection.
 * Covers webhook success/delay/miss/dup and Admin load reconcile.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function baseBooking(overrides = {}) {
  return {
    id: 'CD1-PARITY',
    bookingVersion: 2,
    schemaVersion: 1,
    quoteVersion: 1,
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    paymentWorkflowStatus: 'awaiting_customer_payment',
    paymentStatus: 'no_payment_required_yet',
    payLink: 'https://checkout.stripe.com/c/pay/cs_parity_1',
    stripeCheckoutSessionId: 'cs_parity_1',
    ledger: { approvedCents: 30000, settledCents: 0, creditedCents: 0, entries: [] },
    paymentAttempts: [{
      bookingId: 'CD1-PARITY',
      providerObjectId: 'cs_parity_1',
      amountCents: 30000,
      quoteVersion: 1,
      bookingVersion: 2,
      currency: 'usd',
      status: 'open',
    }],
    quote: { quoteVersion: 1, approvedCents: 30000 },
    service: {
      vehicles: [{ vehicleId: 'v1', cat: 'cars', packageId: 'essential', pkgName: 'Essential', addOnIds: [] }],
    },
    ...overrides,
  };
}

function paidSession(bookingId = 'CD1-PARITY', sessionId = 'cs_parity_1') {
  return {
    id: sessionId,
    amount_total: 30000,
    currency: 'usd',
    payment_status: 'paid',
    payment_intent: 'pi_parity_1',
    metadata: {
      purpose: 'customer_balance',
      booking_id: bookingId,
      bookingVersion: '2',
      quoteVersion: '1',
    },
  };
}

describe('payment financial parity', () => {
  const {
    financialProjection,
    reconcileCustomerBalanceSession,
    applyCustomerBalanceReconciliation,
    reconcileOpenCheckoutFromProvider,
    canCreatePayment,
  } = require('../netlify/lib/payment-service');
  const { projectJobForAdmin, projectJobForAdminList } = require('../netlify/lib/ops-workflow');
  const { normalizePaymentWorkflowStatus } = require('../netlify/lib/ops-schema');
  const { normalizeAggregate } = require('../netlify/lib/booking-aggregate');

  function customerSafeLike(booking) {
    const money = financialProjection(booking);
    return {
      paymentStatus: money.paymentStatus,
      approvedCents: money.approvedCents,
      settledCents: money.settledCents,
      remainingCents: money.remainingCents,
    };
  }

  it('successful webhook reconcile → paid; Admin and Customer projections equal', () => {
    const { aggregate } = normalizeAggregate(baseBooking());
    const result = reconcileCustomerBalanceSession({
      aggregate,
      session: paidSession(),
      stripeEventId: 'evt_parity_1',
    });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.aggregate.ledger.settledCents, 30000);
    assert.equal(result.aggregate.ledger.entries.length, 1);
    assert.equal(result.aggregate.ledger.entries[0].stripeEventId, 'evt_parity_1');

    const cust = customerSafeLike(result.aggregate);
    const admin = projectJobForAdmin(result.aggregate);
    assert.equal(cust.paymentStatus, 'paid');
    assert.equal(admin.financialPaymentStatus, 'paid');
    assert.equal(admin.paymentWorkflowStatus, 'payment_succeeded');
    assert.equal(admin.invoicePaid, true);
    assert.equal(admin.canGeneratePayLink, false);
    assert.equal(cust.remainingCents, 0);
    assert.equal(admin.remainingCents, 0);
    assert.equal(cust.approvedCents, admin.approvedCents);
    assert.equal(cust.settledCents, admin.settledCents);
  });

  it('duplicate webhook / reconcile → exactly one ledger credit', () => {
    const { aggregate } = normalizeAggregate(baseBooking());
    const session = paidSession();
    const first = reconcileCustomerBalanceSession({
      aggregate,
      session,
      stripeEventId: 'evt_dup_1',
    });
    assert.equal(first.ok, true);
    assert.equal(first.aggregate.ledger.entries.length, 1);

    const second = reconcileCustomerBalanceSession({
      aggregate: first.aggregate,
      session,
      stripeEventId: 'evt_dup_1',
    });
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.aggregate.ledger.entries.length, 1);
    assert.equal(second.aggregate.ledger.settledCents, 30000);

    // Same session, different event id — still one credit (session uniqueness).
    const third = reconcileCustomerBalanceSession({
      aggregate: first.aggregate,
      session,
      stripeEventId: 'evt_dup_2',
    });
    assert.equal(third.duplicate, true);
    assert.equal(third.aggregate.ledger.entries.length, 1);
  });

  it('Admin load before webhook → still due; after webhook → paid', () => {
    const before = baseBooking();
    const fpBefore = financialProjection(before);
    assert.equal(fpBefore.paymentStatus, 'processing');
    assert.ok(fpBefore.remainingCents > 0);
    assert.equal(projectJobForAdmin(before).paymentWorkflowStatus, 'awaiting_customer_payment');

    const { aggregate } = normalizeAggregate(before);
    const settled = reconcileCustomerBalanceSession({
      aggregate,
      session: paidSession(),
      stripeEventId: 'evt_after',
    });
    const fpAfter = financialProjection(settled.aggregate);
    assert.equal(fpAfter.paymentStatus, 'paid');
    assert.equal(projectJobForAdmin(settled.aggregate).invoicePaid, true);
  });

  it('missing webhook: Admin load with paid Session runs same reconcile once', async () => {
    const pending = baseBooking();
    const store = new Map();
    store.set('CD1-PARITY', { ...pending });

    async function getBookingRecord(id) {
      const b = store.get(id);
      if (!b) return { exists: false, booking: null };
      const { ok, aggregate } = normalizeAggregate(b);
      return { exists: true, booking: ok ? aggregate : b };
    }
    async function commitBooking({ bookingId, expectedBookingVersion, nextAggregate }) {
      const cur = store.get(bookingId);
      if (!cur) return { ok: false, error: 'not_found' };
      if (Math.round(Number(cur.bookingVersion) || 0) !== Math.round(Number(expectedBookingVersion))) {
        return { ok: false, error: 'version_conflict', statusCode: 409 };
      }
      store.set(bookingId, nextAggregate);
      return { ok: true, booking: nextAggregate, bookingVersion: nextAggregate.bookingVersion };
    }

    const fetchImpl = async () => ({
      ok: true,
      json: async () => paidSession(),
    });

    const applied = await reconcileOpenCheckoutFromProvider({
      booking: pending,
      bookingId: 'CD1-PARITY',
      getBookingRecord,
      commitBooking,
      env: { STRIPE_SECRET_KEY: 'sk_test_parity', CONTEXT: 'dev', CD1_FORCE_LOCAL_STRIPE_GUARD: '1' },
      fetchImpl,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.skipped, false);
    assert.equal(applied.projection.paymentStatus, 'paid');
    assert.equal(store.get('CD1-PARITY').ledger.entries.length, 1);

    // Delayed second Admin load — idempotent, still one credit.
    const again = await reconcileOpenCheckoutFromProvider({
      booking: store.get('CD1-PARITY'),
      bookingId: 'CD1-PARITY',
      getBookingRecord,
      commitBooking,
      env: { STRIPE_SECRET_KEY: 'sk_test_parity', CONTEXT: 'dev', CD1_FORCE_LOCAL_STRIPE_GUARD: '1' },
      fetchImpl,
    });
    assert.equal(again.ok, true);
    assert.equal(again.skipped || again.duplicate, true);
    assert.equal(store.get('CD1-PARITY').ledger.entries.length, 1);
  });

  it('remainingCents === 0 → Generate denied', () => {
    const paid = baseBooking({
      paymentWorkflowStatus: 'payment_succeeded',
      paymentStatus: 'paid',
      payLink: '',
      stripeCheckoutSessionId: '',
      lastStripeCheckoutSessionId: 'cs_parity_1',
      ledger: {
        approvedCents: 30000,
        settledCents: 30000,
        creditedCents: 0,
        entries: [{
          kind: 'settlement',
          providerObjectId: 'cs_parity_1',
          amountCents: 30000,
        }],
      },
      paymentAttempts: [{
        bookingId: 'CD1-PARITY',
        providerObjectId: 'cs_parity_1',
        amountCents: 30000,
        quoteVersion: 1,
        bookingVersion: 2,
        currency: 'usd',
        status: 'settled',
      }],
    });
    const { aggregate } = normalizeAggregate(paid);
    const gate = canCreatePayment(aggregate);
    assert.equal(gate.ok, false);
    assert.ok(['zero_balance', 'not_payable'].includes(gate.error));
    const admin = projectJobForAdmin(aggregate);
    assert.equal(admin.canGeneratePayLink, false);
    assert.equal(admin.remainingCents, 0);
    assert.ok(admin.stripeCheckoutSessionIdPrefix);
  });

  it('stale awaiting_customer_payment + settled ledger → Admin paid (no list overwrite)', () => {
    const staleLabel = baseBooking({
      paymentWorkflowStatus: 'awaiting_customer_payment',
      paymentStatus: 'no_payment_required_yet',
      payLink: 'https://checkout.stripe.com/stale',
      ledger: {
        approvedCents: 30000,
        settledCents: 30000,
        creditedCents: 0,
        entries: [{ kind: 'settlement', providerObjectId: 'cs_parity_1', amountCents: 30000 }],
      },
    });
    const fp = financialProjection(staleLabel);
    assert.equal(fp.paymentStatus, 'paid');
    assert.equal(normalizePaymentWorkflowStatus(staleLabel), 'payment_succeeded');
    const admin = projectJobForAdmin(staleLabel);
    assert.equal(admin.paymentWorkflowStatus, 'payment_succeeded');
    assert.equal(admin.invoicePaid, true);

    // listJobs must not clobber projection (source contract).
    const listSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    const listFn = listSrc.slice(listSrc.indexOf('async function listJobs'), listSrc.indexOf('async function persistMutation') > 0
      ? listSrc.indexOf('async function persistMutation')
      : listSrc.indexOf('Persist Admin mutations'));
    assert.match(listFn, /projectJobForAdminList/);
    assert.doesNotMatch(listFn, /j\.paymentWorkflowStatus\s*=\s*normalizePaymentWorkflowStatus/);
    const lean = projectJobForAdminList(staleLabel);
    assert.equal(lean.paymentWorkflowStatus, 'payment_succeeded');
    assert.equal(lean.invoicePaid, true);
  });

  it('Customer safePaymentState uses financialProjection fields', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/customer-portal-data.js'), 'utf8');
    assert.match(src, /financialProjection/);
    assert.match(src, /state:\s*money\.paymentStatus/);
  });

  it('Admin get_job + strong fetchBlobRecords + webhook event id wired', () => {
    const adminSrc = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    assert.match(adminSrc, /action === 'get_job'/);
    assert.match(adminSrc, /reconcileOpenCheckoutFromProvider/);

    const techSrc = fs.readFileSync(path.join(ROOT, 'netlify/lib/tech-security.js'), 'utf8');
    assert.match(techSrc, /consistency:\s*'strong'/);

    const wh = fs.readFileSync(path.join(ROOT, 'netlify/functions/stripe-webhook.js'), 'utf8');
    assert.match(wh, /stripeEventId:\s*evt\.id/);
    assert.match(wh, /statusCode:\s*500/);
    assert.match(wh, /retryable/);

    const html = fs.readFileSync(path.join(ROOT, 'admin-ops.html'), 'utf8');
    assert.match(html, /action:'get_job'|action:\s*'get_job'/);
  });

  it('applyCustomerBalanceReconciliation CAS succeeds once', async () => {
    const pending = baseBooking();
    let version = pending.bookingVersion;
    const store = { booking: { ...pending } };
    const applied = await applyCustomerBalanceReconciliation({
      bookingId: 'CD1-PARITY',
      session: paidSession(),
      stripeEventId: 'evt_cas_1',
      getBookingRecord: async () => {
        const { ok, aggregate } = normalizeAggregate(store.booking);
        return { exists: true, booking: ok ? aggregate : store.booking };
      },
      commitBooking: async ({ expectedBookingVersion, nextAggregate }) => {
        if (Math.round(Number(store.booking.bookingVersion) || 0) !== Math.round(Number(expectedBookingVersion))) {
          return { ok: false, error: 'version_conflict', statusCode: 409 };
        }
        store.booking = nextAggregate;
        version = nextAggregate.bookingVersion;
        return { ok: true, booking: nextAggregate, bookingVersion: version };
      },
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.duplicate, false);
    assert.equal(store.booking.ledger.entries.length, 1);
    assert.equal(applied.projection.paymentStatus, 'paid');
  });
});
