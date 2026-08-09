/**
 * Portal ops smoke — real Admin / Customer operation contracts.
 * PostgreSQL is financial authority; hosted Checkout stays isolated.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('portal ops smoke — customer + admin real ops', () => {
  it('lookup-booking gates drafts and requires phone match', () => {
    const src = read('netlify/functions/lookup-booking.js');
    assert.match(src, /isVisibleSubmittedBooking/);
    assert.match(src, /phonesMatch/);
    assert.match(src, /projectBookingForCustomer/);
  });

  it('customer pay uses embedded authoritative customer_balance PaymentIntent', () => {
    const src = read('netlify/functions/customer-balance-payment-intent.js');
    assert.match(src, /prepareEmbeddedPayment/);
    assert.match(read('netlify/lib/db/payment-authority-service.js'), /metadata\[purpose\].*customer_balance|customer_balance/);
    assert.match(src, /authorizeBookingAccess/);
    assert.doesNotMatch(
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
      /body\.amountCents|p\.amountCents/
    );
    assert.match(read('netlify/functions/customer-portal-pay.js'), /legacy_checkout_disabled/);
  });

  it('canPayBalance denies a settled invoice while catalog changes remain Admin-reviewed', () => {
    const { canPayBalance, isInvoicePaid, canRequestChange } = require('../netlify/lib/appointment-status-policy');
    const paid = {
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      paymentWorkflowStatus: 'payment_succeeded',
      payLink: 'https://checkout.stripe.com/c/pay/stale',
      ledger: { approvedCents: 39000, settledCents: 39000, creditedCents: 0 },
    };
    assert.equal(isInvoicePaid(paid), true);
    assert.equal(canPayBalance(paid).ok, false);
    const packageChange = canRequestChange(paid, 'package_change');
    assert.equal(packageChange.ok, true);
    assert.equal(packageChange.pendingApproval, true);
    const addr = canRequestChange(paid, 'address');
    assert.equal(addr.ok, true);
    assert.equal(addr.pendingApproval, false);
  });

  it('set_payment_link is non-authoritative manual reference only', () => {
    const src = read('netlify/functions/admin-ops-jobs.js');
    const block = src.slice(src.indexOf("action === 'set_payment_link'"), src.indexOf("action === 'generate_stripe_pay_link'"));
    assert.match(block, /manualPayLink/);
    assert.doesNotMatch(block, /paymentWorkflowStatus:\s*'awaiting_customer_payment'/);
    assert.match(block, /authoritative:\s*false/);
  });

  it('generate_stripe_pay_link rejects amount override and mints customer_balance', () => {
    const src = read('netlify/functions/admin-ops-jobs.js');
    assert.match(src, /amount_override_rejected/);
    assert.match(src, /purpose',\s*'customer_balance'|purpose.*customer_balance/);
    assert.match(src, /reused:\s*true/);
    assert.match(src, /forceAll:\s*true/);
  });

  it('Requests generate_pay_link is copy-only (not mint)', () => {
    const src = read('netlify/functions/admin-customer-requests.js');
    assert.match(src, /generate_pay_link/);
    assert.match(src, /payment_link_unavailable/);
    assert.match(src, /Generate Stripe link/);
    assert.doesNotMatch(
      src.slice(src.indexOf("action === 'generate_pay_link'")),
      /checkout\/sessions/
    );
  });

  it('stripe-webhook settles customer_balance via reconciliation', () => {
    const src = read('netlify/functions/stripe-webhook.js');
    assert.match(src, /checkout\.session\.completed/);
    assert.match(src, /applyCustomerBalanceReconciliation/);
    assert.match(src, /customer_balance/);
  });

  it('settlement clears payLink and closes invoice', () => {
    const { reconcileCustomerBalanceSession } = require('../netlify/lib/payment-service');
    const { canPayBalance } = require('../netlify/lib/appointment-status-policy');
    const { normalizeAggregate } = require('../netlify/lib/booking-aggregate');
    const raw = {
      id: 'CD1-SMOKE',
      bookingVersion: 2,
      quoteVersion: 1,
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      payLink: 'https://checkout.stripe.com/c/pay/cs_smoke',
      stripeCheckoutSessionId: 'cs_smoke',
      ledger: { approvedCents: 27500, settledCents: 0, creditedCents: 0, entries: [] },
      paymentAttempts: [{
        bookingId: 'CD1-SMOKE',
        providerObjectId: 'cs_smoke',
        amountCents: 27500,
        quoteVersion: 1,
        bookingVersion: 2,
        currency: 'usd',
        status: 'open',
      }],
      quote: { quoteVersion: 1, approvedCents: 27500 },
    };
    const { aggregate } = normalizeAggregate(raw);
    const result = reconcileCustomerBalanceSession({
      aggregate,
      session: {
        id: 'cs_smoke',
        amount_total: 27500,
        currency: 'usd',
        payment_status: 'paid',
        metadata: {
          purpose: 'customer_balance',
          booking_id: 'CD1-SMOKE',
          bookingVersion: '2',
          quoteVersion: '1',
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.aggregate.paymentWorkflowStatus, 'payment_succeeded');
    assert.equal(result.aggregate.payLink || '', '');
    assert.equal(canPayBalance(result.aggregate).ok, false);
  });

  it('address submit does not mutate live service address before approve', () => {
    const src = read('netlify/lib/booking-commands.js');
    const idx = src.indexOf("requestType === 'address_update'");
    assert.ok(idx > 0);
    const slice = src.slice(idx, idx + 450);
    assert.match(slice, /requestedAddress/);
    assert.match(slice, /do not mutate live address|Jobber-style/);
    assert.doesNotMatch(slice, /serviceAddress:\s*delta/);
  });

  it('my-garage: Enter cannot drop hub; paid locks money actions; paid=1 not authoritative', () => {
    const src = read('assets/my-garage.js');
    assert.match(src, /modalForm\.addEventListener\('submit'/);
    assert.match(src, /junkKeys/);
    assert.match(src, /newAddress/);
    assert.match(src, /invoiceIsPaid|Invoice paid/);
    assert.match(src, /Never treat \?paid=1|paid === '1'/);
  });

  it('admin drawer separates paid/service state and disables hosted generation', () => {
    const src = read('admin-ops.html') + read('assets/admin-ops.css') + read('assets/admin-ops.js');
    assert.match(src, /· PAID/);
    assert.match(src, /Legacy hosted Checkout \(disabled\)/);
    assert.doesNotMatch(src, />Generate Stripe link</);
    assert.doesNotMatch(src, />Copy pay link if present</);
    assert.match(src, /Manual external reference|manual reference/i);
    assert.match(src, /id="dSetPayLink"[^>]*>Save manual reference/);
    assert.match(src, /Hosted Checkout and manual policy charges are isolated/);
    assert.match(src, /Reconcile with Stripe|reconcile_with_stripe/);
    assert.doesNotMatch(src, /create-payment-link\.js|\/\.netlify\/functions\/create-payment-link/);
  });

  it('legacy create-payment-link stays disabled', () => {
    const src = read('netlify/functions/create-payment-link.js');
    assert.match(src, /endpoint_disabled|410/);
  });

  it('Prisma mirror optional — no DATABASE_URL does not break Blob commit', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';
    const { _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
    const { mirrorEnabled, upsertBookingMirror } = require('../netlify/lib/booking-prisma-mirror');
    assert.equal(mirrorEnabled(), false);
    const r = await upsertBookingMirror({ id: 'CD1-Z', kind: 'booking', isDraft: false });
    assert.equal(r.skipped, true);
    if (prev == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
    _resetPrismaForTests();
  });

  it('admin projection exposes invoicePaid / canGeneratePayLink', () => {
    const { projectJobForAdmin } = require('../netlify/lib/ops-workflow');
    const job = projectJobForAdmin({
      id: 'CD1-ADM',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      paymentWorkflowStatus: 'payment_succeeded',
      ledger: { approvedCents: 30000, settledCents: 30000, creditedCents: 0, entries: [] },
      quote: { quoteVersion: 1, approvedCents: 30000 },
      bookingVersion: 2,
      schemaVersion: 1,
      service: { vehicles: [{ vehicleId: 'v1', cat: 'cars', packageId: 'essential', addOnIds: [] }] },
    });
    assert.equal(job.invoicePaid, true);
    assert.equal(job.canGeneratePayLink, false);
  });
});
