/**
 * Post-pay customer ops: address apply, pending CR cleanup, policy fees, refund status.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('portal post-pay ops', () => {
  it('normalizeAggregate prefers top-level address over stale service.serviceAddress', () => {
    const { normalizeAggregate } = require('../netlify/lib/booking-aggregate');
    const { ok, aggregate } = normalizeAggregate({
      id: 'CD1-ADDR',
      bookingVersion: 3,
      schemaVersion: 1,
      address: '260 Talla Ave',
      service: {
        serviceAddress: 'Old Street 1',
        vehicles: [{ vehicleId: 'v1', cat: 'cars', packageId: 'essential', addOnIds: [] }],
      },
      ledger: { approvedCents: 10000, settledCents: 10000, creditedCents: 0, entries: [] },
      quote: { quoteVersion: 1, approvedCents: 10000 },
    });
    assert.equal(ok, true);
    assert.equal(aggregate.address, '260 Talla Ave');
    assert.equal(aggregate.service.serviceAddress, '260 Talla Ave');
  });

  it('decide address_update patches service.serviceAddress', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/booking-commands.js'), 'utf8');
    const idx = src.indexOf("rt === 'address_update'");
    assert.ok(idx > 0);
    const slice = src.slice(idx, idx + 550);
    assert.match(slice, /serviceAddress/);
    assert.match(slice, /requestedAddress\s*=\s*''/);
  });

  it('paid invoice hides money pending requests from customer projection', () => {
    const { resolveCustomerVisibleRequests } = require('../netlify/lib/customer-change-requests');
    const booking = {
      id: 'CD1-CR',
      paymentWorkflowStatus: 'payment_succeeded',
      paymentStatus: 'paid',
      ledger: { approvedCents: 20000, settledCents: 20000, creditedCents: 0, entries: [] },
      changeRequests: [
        { requestId: 'cr_addon', requestType: 'addon_request', status: 'pending_approval' },
        { requestId: 'cr_addr', requestType: 'address_update', status: 'pending' },
      ],
    };
    const visible = resolveCustomerVisibleRequests(booking, [
      { id: 'cr_addon', bookingId: 'CD1-CR', requestType: 'addon_request', status: 'pending_approval' },
      { id: 'cr_addr', bookingId: 'CD1-CR', requestType: 'address_update', status: 'pending' },
      { id: 'cr_orphan', bookingId: 'CD1-CR', requestType: 'addon_request', status: 'pending' },
    ]);
    assert.equal(visible.some((r) => r.requestType === 'addon_request'), false);
    assert.equal(visible.some((r) => r.requestType === 'address_update'), true);
  });

  it('settlement supersedes money change requests', () => {
    const { reconcileCustomerBalanceSession } = require('../netlify/lib/payment-service');
    const { normalizeAggregate } = require('../netlify/lib/booking-aggregate');
    const raw = {
      id: 'CD1-SUP',
      bookingVersion: 2,
      quoteVersion: 1,
      schemaVersion: 1,
      paymentWorkflowStatus: 'awaiting_customer_payment',
      changeRequests: [
        { requestId: 'cr_a', requestType: 'addon_request', status: 'pending_approval' },
        { requestId: 'cr_r', requestType: 'reschedule_request', status: 'pending' },
      ],
      ledger: { approvedCents: 15000, settledCents: 0, creditedCents: 0, entries: [] },
      paymentAttempts: [{
        bookingId: 'CD1-SUP',
        providerObjectId: 'cs_sup_1',
        amountCents: 15000,
        quoteVersion: 1,
        bookingVersion: 2,
        currency: 'usd',
        status: 'open',
      }],
      quote: { quoteVersion: 1, approvedCents: 15000 },
      service: { vehicles: [{ vehicleId: 'v1', cat: 'cars', packageId: 'essential', addOnIds: [] }] },
    };
    const { aggregate } = normalizeAggregate(raw);
    const result = reconcileCustomerBalanceSession({
      aggregate,
      session: {
        id: 'cs_sup_1',
        amount_total: 15000,
        currency: 'usd',
        payment_status: 'paid',
        metadata: {
          purpose: 'customer_balance',
          booking_id: 'CD1-SUP',
          bookingVersion: '2',
          quoteVersion: '1',
        },
      },
    });
    assert.equal(result.ok, true);
    const addon = result.aggregate.changeRequests.find((r) => r.requestId === 'cr_a');
    const resched = result.aggregate.changeRequests.find((r) => r.requestId === 'cr_r');
    assert.equal(addon.status, 'superseded');
    assert.equal(resched.status, 'pending');
  });

  it('financialProjection maps refunded away from payment_succeeded', () => {
    const { financialProjection } = require('../netlify/lib/payment-service');
    const { projectJobForAdmin } = require('../netlify/lib/ops-workflow');
    const booking = {
      id: 'CD1-REF',
      bookingVersion: 4,
      schemaVersion: 1,
      paymentWorkflowStatus: 'payment_succeeded',
      paymentStatus: 'refunded',
      refundStatus: 'refunded',
      ledger: { approvedCents: 20000, settledCents: 20000, creditedCents: 0, entries: [] },
      quote: { quoteVersion: 1, approvedCents: 20000 },
      service: { vehicles: [{ vehicleId: 'v1', cat: 'cars', packageId: 'essential', addOnIds: [] }] },
    };
    const fp = financialProjection(booking);
    assert.equal(fp.paymentStatus, 'refunded');
    assert.equal(fp.paymentWorkflowStatus, 'refunded');
    const admin = projectJobForAdmin(booking);
    assert.equal(admin.paymentWorkflowStatus, 'refunded');
  });

  it('charge_policy_fee blocked when completed or cancelled', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    assert.match(src, /policy_charge_blocked/);
    assert.match(src, /mark_refunded/);
  });

  it('stripe-webhook handles refund events', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/stripe-webhook.js'), 'utf8');
    assert.match(src, /charge\.refunded/);
    assert.match(src, /reconcilePostgresRefund/);
    assert.match(src, /refund\.created/);
    assert.doesNotMatch(src, /paymentWorkflowStatus:\s*'refunded'/);
  });

  it('customer portal keeps paid appointments accessible', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/customer-portal-data.js'), 'utf8');
    assert.match(src, /Paid invoice is NOT terminal|listVisibleRequestsForBooking/);
    assert.doesNotMatch(
      src.slice(src.indexOf('function selectUpcoming'), src.indexOf('function selectUpcoming') + 500),
      /'Paid',\s*'Closed'/
    );
  });

  it('admin UI hides isolated 410 money affordances and keeps refund badge styling', () => {
    const html = fs.readFileSync(path.join(ROOT, 'admin-ops.html'), 'utf8') + fs.readFileSync(path.join(ROOT, 'assets/admin-ops.css'), 'utf8') + fs.readFileSync(path.join(ROOT, 'assets/admin-ops.js'), 'utf8');
    assert.doesNotMatch(html, /id="dChargeNoShow"/);
    assert.doesNotMatch(html, /id="dMarkRefunded"/);
    assert.match(html, /dCloseWhenPaid|Close job when paid/);
    assert.match(html, /parseCashAmountInput|dCashAmt/);
    assert.match(html, /refunded:'b-warn'|refunded:\s*'b-warn'/);
  });
});
