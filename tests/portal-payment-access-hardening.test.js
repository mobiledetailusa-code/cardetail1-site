/**
 * Hardening from owner portal tests:
 * - no second payable link after settlement
 * - vehicle approve must reprice
 * - trailer length + tier resolution
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('portal payment + access hardening', () => {
  it('settlement clears payLink and canPayBalance ignores leftover link', () => {
    const { reconcileCustomerBalanceSession } = require('../netlify/lib/payment-service');
    const { canPayBalance } = require('../netlify/lib/appointment-status-policy');
    const { normalizeAggregate } = require('../netlify/lib/booking-aggregate');

    const raw = {
      id: 'CD1-HARD',
      bookingVersion: 2,
      quoteVersion: 1,
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      payLink: 'https://checkout.stripe.com/c/pay/cs_old',
      stripeCheckoutSessionId: 'cs_test_hard',
      payLinkAmount: 310,
      ledger: { approvedCents: 31000, settledCents: 0, creditedCents: 0, entries: [] },
      paymentAttempts: [{
        bookingId: 'CD1-HARD',
        providerObjectId: 'cs_test_hard',
        amountCents: 31000,
        quoteVersion: 1,
        bookingVersion: 2,
        currency: 'usd',
        status: 'open',
      }],
      quote: { quoteVersion: 1, approvedCents: 31000 },
    };
    const { aggregate } = normalizeAggregate(raw);
    const result = reconcileCustomerBalanceSession({
      aggregate,
      session: {
        id: 'cs_test_hard',
        amount_total: 31000,
        currency: 'usd',
        payment_status: 'paid',
        metadata: {
          purpose: 'customer_balance',
          booking_id: 'CD1-HARD',
          bookingVersion: '2',
          quoteVersion: '1',
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.aggregate.paymentWorkflowStatus, 'payment_succeeded');
    assert.equal(result.aggregate.payLink || '', '');
    assert.equal(result.aggregate.stripeCheckoutSessionId || '', '');
    const deny = canPayBalance({
      ...result.aggregate,
      payLink: 'https://checkout.stripe.com/c/pay/stale',
    });
    assert.equal(deny.ok, false);
  });

  it('admin generate path reuses open attempt and blocks paid bookings', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    assert.match(src, /reused:\s*true/);
    assert.match(src, /forceAll:\s*true/);
    assert.match(src, /already paid or has no remaining balance/);
    assert.match(src, /manualPayLink/);
    assert.doesNotMatch(
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
      /action === 'set_payment_link'[\s\S]{0,400}paymentWorkflowStatus:\s*'awaiting_customer_payment'/
    );
  });

  it('ops-db and action-link use strong booking reads', () => {
    const ops = fs.readFileSync(path.join(ROOT, 'netlify/lib/ops-db.js'), 'utf8');
    assert.match(ops, /consistency:\s*'strong'/);
    const action = fs.readFileSync(path.join(ROOT, 'netlify/functions/customer-portal-action.js'), 'utf8');
    assert.match(action, /require\('\.\.\/lib\/ops-db'\)/);
  });

  it('usesLengthPricing includes trailer aliases', () => {
    const { usesLengthPricing, normalizeLengthCategory } = require('../netlify/lib/length-pricing');
    assert.equal(usesLengthPricing('trailer'), true);
    assert.equal(usesLengthPricing('trailers'), true);
    assert.equal(normalizeLengthCategory('trailer'), 'rvs');
  });

  it('resolveTierKey ignores unknown stale keys', () => {
    const { resolveTierKey } = (() => {
      // resolveTierKey is not exported — exercise via computeVehicleSubtotal path
      const catalog = require('../netlify/lib/booking-price-catalog');
      return {
        resolveTierKey: (vehicle) => {
          const r = catalog.computeVehicleSubtotal({
            ...vehicle,
            pkgId: 'premium',
            packageId: 'premium',
            cat: vehicle.cat || 'cars',
            addons: [],
          });
          return r.tierKey;
        },
      };
    })();
    assert.equal(resolveTierKey({ cat: 'cars', tierKey: 'suv3', tierLabel: 'SUV 3-Row' }), 'suv3');
    // Unknown key must not stick — fall through to label or nullish pricing path
    const bad = resolveTierKey({ cat: 'cars', tierKey: 'not_a_real_tier', tierLabel: 'SUV 3-Row' });
    assert.equal(bad, 'suv3');
  });

  it('vehicle approve applies identity + ledger (source contract)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/booking-commands.js'), 'utf8');
    assert.match(src, /vehicle_replace_request/);
    assert.match(src, /vehicleTypes\.has/);
    assert.match(src, /approvedCents: quote\.approvedCents/);
    assert.match(src, /vehicleChangeRequested\s*=\s*false/);
  });

  it('my-garage retains limited credentials and polls after paid=1', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
    assert.match(src, /cd1_garage_phone/);
    assert.match(src, /pollPaymentSettlement/);
    assert.match(src, /trailer.*rvs|trailers.*rvs/);
  });

  it('pack change prefers canonical vehicle tier over stale top-level', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/submit-customer-action.js'), 'utf8');
    assert.match(src, /targetVehicle\.tierKey|primaryVehicle\.tierKey/);
    assert.match(src, /carTiers\[candidate\]/);
  });

  it('Jobber: paid invoice routes catalog changes to Admin review and allows address', () => {
    const { canRequestChange, isInvoicePaid, classifyStatus } = require('../netlify/lib/appointment-status-policy');
    const paid = {
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      paymentWorkflowStatus: 'payment_succeeded',
      ledger: { approvedCents: 39000, settledCents: 39000, creditedCents: 0 },
    };
    assert.equal(isInvoicePaid(paid), true);
    assert.equal(classifyStatus(paid), 'paid');
    assert.equal(canRequestChange(paid, 'package_change').ok, true);
    assert.equal(canRequestChange(paid, 'package_change').pendingApproval, true);
    assert.equal(canRequestChange(paid, 'addon').ok, true);
    assert.equal(canRequestChange(paid, 'addon').pendingApproval, true);
    assert.equal(canRequestChange(paid, 'vehicle_replace').ok, true);
    assert.equal(canRequestChange(paid, 'vehicle_replace').pendingApproval, true);
    assert.equal(canRequestChange(paid, 'address').ok, true);
    assert.equal(canRequestChange(paid, 'reschedule').ok, true);
  });

  it('Jobber: admin projection marks invoicePaid and canGeneratePayLink', () => {
    const { projectJobForAdmin } = require('../netlify/lib/ops-workflow');
    const job = projectJobForAdmin({
      id: 'CD1-INV',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      paymentWorkflowStatus: 'payment_succeeded',
      ledger: { approvedCents: 30000, settledCents: 30000, creditedCents: 0, entries: [] },
      quote: { quoteVersion: 1, approvedCents: 30000 },
      bookingVersion: 3,
      schemaVersion: 1,
      service: { vehicles: [{ vehicleId: 'v1', cat: 'cars', packageId: 'essential', addOnIds: [] }] },
    });
    assert.equal(job.invoicePaid, true);
    assert.equal(job.canGeneratePayLink, false);
    assert.equal(job.paymentWorkflowStatus, 'payment_succeeded');
    assert.equal(job.remainingCents, 0);
  });

  it('Jobber: Admin approval routes paid catalog changes through authoritative adjustments', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/booking-commands.js'), 'utf8');
    assert.match(src, /applyPackageFinancialMutation/);
    assert.match(src, /applyAddonFinancialMutation/);
    assert.match(src, /applyVehicleFinancialMutation/);
    assert.match(src, /outstandingCreditCents/);
  });

  it('Jobber: my-garage prevents modal GET navigate and strips newAddress junk', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
    assert.match(src, /modalForm\.addEventListener\('submit'/);
    assert.match(src, /preventDefault/);
    assert.match(src, /newAddress/);
    assert.match(src, /junkKeys/);
    assert.match(src, /mf-pack-host/);
    assert.match(src, /Invoice paid/);
  });

  it('Jobber: admin drawer shows PAID independently and disables hosted generation', () => {
    const src = fs.readFileSync(path.join(ROOT, 'admin-ops.html'), 'utf8');
    assert.match(src, /· PAID/);
    assert.match(src, /const canGenLink = false/);
    assert.match(src, /Hosted Checkout and manual policy charges are isolated/);
    assert.match(src, /Invoice \/ Payment/);
  });
});
