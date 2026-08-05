'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  updateCustomerContact,
  mutateVehicles,
  approveAdjustment,
  markCashReceived,
  markRefunded,
  adminTechStatus,
} = require('../netlify/lib/admin-booking-mutations');

const baseBooking = {
  id: 'CD1-TEST',
  firstName: 'Test',
  phone: '2015550199',
  email: 'test@example.com',
  zipCode: '07030',
  vehicleCategory: 'cars',
  packageId: 'interior',
  package: 'Interior Detail',
  vehicles: [{ cat: 'cars', pkgId: 'interior', tierKey: 'small', tierLabel: 'Small Car' }],
  jobStatus: 'confirmed',
  serviceStatus: 'confirmed',
  totalPrice: 225,
};

test('updateCustomerContact patches contact fields', () => {
  const r = updateCustomerContact(baseBooking, { firstName: 'Updated', email: 'new@example.com' });
  assert.equal(r.ok, true);
  assert.equal(r.booking.firstName, 'Updated');
  assert.equal(r.booking.email, 'new@example.com');
});

test('mutateVehicles adds second vehicle and recalculates', () => {
  const r = mutateVehicles(baseBooking, {
    vehicleOp: 'add',
    vehicle: { cat: 'cars', pkgId: 'full', tierKey: 'small', tierLabel: 'Small Car' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.booking.vehicles.length, 2);
  assert.ok(Number(r.booking.totalPrice) > 225);
});

test('adminTechStatus can mark en route', () => {
  const assigned = { ...baseBooking, serviceStatus: 'assigned', jobStatus: 'assigned' };
  const r = adminTechStatus(assigned, { statusAction: 'en_route' });
  assert.equal(r.ok, true);
  assert.equal(r.booking.serviceStatus, 'en_route');
});

test('approveAdjustment sets approved final amount', () => {
  const r = approveAdjustment({ ...baseBooking, proposedFinalAmount: 200 }, { approvedFinalAmount: 200 });
  assert.equal(r.booking.approvedFinalAmount, 200);
  assert.equal(r.booking.adjustmentStatus, 'approved');
});

test('markCashReceived settles payment without closing service lifecycle', () => {
  const r = markCashReceived(baseBooking, {});
  assert.equal(r.booking.paymentStatus, 'paid_cash');
  assert.equal(r.booking.serviceStatus, 'confirmed');
  assert.equal(r.booking.jobStatus, 'confirmed');
});

test('admin-ops-jobs exposes operational mutations', () => {
  const src = read('netlify/functions/admin-ops-jobs.js');
  for (const action of [
    'create_appointment', 'update_customer', 'update_vehicles', 'update_service',
    'admin_tech_status', 'approve_adjustment', 'reject_adjustment', 'mark_cash_received',
    'mark_card_on_site', 'generate_customer_link', 'list_audit', 'reopen_appointment',
  ]) {
    assert.match(src, new RegExp(`action === '${action}'`));
  }
});

test('markRefunded clamps to net settled and never exceeds what was actually paid', () => {
  const paidBooking = {
    ...baseBooking,
    ledger: { approvedCents: 22500, settledCents: 22500, creditedCents: 0, entries: [] },
  };
  const full = markRefunded(paidBooking, {});
  assert.equal(full.amount, 225);
  assert.equal(full.booking.refundStatus, 'refunded');

  const overRequested = markRefunded(paidBooking, { amount: 999 });
  assert.equal(overRequested.amount, 225, 'must clamp to net settled, never the caller-requested amount');

  const partial = markRefunded(paidBooking, { amount: 50 });
  assert.equal(partial.amount, 50);

  const nothingSettled = markRefunded({ ...baseBooking, ledger: { approvedCents: 22500, settledCents: 0, creditedCents: 0, entries: [] } }, { amount: 100 });
  assert.equal(nothingSettled.amount, 0, 'nothing was ever paid — refund amount must be zero, not the requested amount');
});

test('refund execution is webhook-authoritative, never a manual status flip', () => {
  const src = read('netlify/functions/admin-ops-jobs.js');
  assert.match(src, /authority\.createRefund\(/);
  assert.match(src, /requestKey:/);
  assert.match(src, /expectedQuoteVersion:/);
  const handlerStart = src.lastIndexOf("if (action === 'mark_refunded') {");
  const handlerBlock = src.slice(handlerStart, handlerStart + 320);
  assert.match(handlerBlock, /manual_refund_status_disabled/);
  assert.doesNotMatch(handlerBlock, /markRefunded\(|persistMutation\(/);
  assert.doesNotMatch(handlerBlock, /store\.setJSON/);
  const requestStart = src.indexOf("if (action === 'record_refund_request') {");
  const requestBlock = src.slice(requestStart, requestStart + 2600);
  assert.doesNotMatch(requestBlock, /markRefunded\s*===\s*true|markDone/);
});

test('technician cash/card-on-site completion is routed through the ledger + CAS, never a bare status flip', () => {
  const src = read('netlify/functions/tech-complete-job.js');
  assert.match(src, /commitBooking/);
  assert.match(src, /kind:\s*'settlement'/);
  assert.match(src, /remainingCents\(base\.ledger\)/);
});

test('admin ops UI wires customer edit and audit', () => {
  const ui = read('admin-ops.html');
  assert.match(ui, /dSaveCustomer/);
  assert.match(ui, /dTechComplete/);
  assert.match(ui, /dGenCompletion/);
  assert.match(ui, /list_audit/);
  assert.match(ui, /Operational audit/);
});

test('customer portal action supports session auth', () => {
  const src = read('netlify/functions/customer-portal-action.js');
  assert.match(src, /authorizeBookingAccess/);
  assert.match(src, /verifyActionToken/);
});

test('my garage uses modals not prompt for actions', () => {
  const html = read('my-garage.html');
  assert.doesNotMatch(html, /prompt\(/);
  assert.match(html, /action-modal/);
  assert.match(html, /cancellation_request/);
  const js = read('assets/my-garage.js');
  assert.doesNotMatch(js, /alert\(/);
  assert.match(js, /openActionModal/);
});

test('customer cancellation request is supported', () => {
  const src = read('netlify/functions/submit-customer-action.js');
  assert.match(src, /cancellation_request/);
});

test('qa-opscore harness is branch-only and production-safe', () => {
  const src = read('netlify/functions/qa-opscore-lifecycle.js');
  assert.match(src, /QA-OPSCORE/);
  assert.match(src, /operations-core-job-lifecycle/);
  assert.match(src, /verifyAdminKey/);
  assert.match(src, /not_found/);
  assert.match(src, /listAllBlobs/);
  assert.doesNotMatch(src, /const\s*\{\s*list\s*\}\s*=\s*await\s+store\.list/);
  assert.match(src, /isProductionContext/);
  assert.match(src, /CONTEXT.*production/);
  assert.match(src, /cardetail1\.com/);
});

test('qa-opscore isQaBranchDeploy denies production context', () => {
  const { __test } = require('../netlify/functions/qa-opscore-lifecycle.js');
  const prev = { ...process.env };
  try {
    process.env.CONTEXT = 'production';
    process.env.BRANCH = 'operations-core-job-lifecycle';
    assert.equal(__test.isProductionContext(), true);
    assert.equal(
      __test.isQaBranchDeploy({
        headers: { host: 'operations-core-job-lifecycle--cardetail1.netlify.app' },
      }),
      false
    );
    process.env.CONTEXT = 'branch-deploy';
    assert.equal(
      __test.isQaBranchDeploy({
        headers: { host: 'operations-core-job-lifecycle--cardetail1.netlify.app' },
      }),
      true
    );
    assert.equal(
      __test.isQaBranchDeploy({ headers: { host: 'cardetail1.com' } }),
      false
    );
  } finally {
    Object.keys(process.env).forEach((k) => {
      if (!(k in prev)) delete process.env[k];
    });
    Object.assign(process.env, prev);
  }
});

test('qa-opscore cleanupQa only deletes QA_PREFIX keys via listAllBlobs', async () => {
  const { __test } = require('../netlify/functions/qa-opscore-lifecycle.js');
  const deleted = [];
  const store = {
    async list() {
      throw new Error('cleanup must not call raw store.list without pagination helper');
    },
    async get(key) {
      if (key.startsWith('QA-OPSCORE')) return { id: key, qaFixture: true, createdAt: new Date().toISOString() };
      return { id: key, qaFixture: false };
    },
    async delete(key) { deleted.push(key); },
  };
  // Monkey-patch listAllBlobs through cleanup using a store that mimics listAllBlobs call path:
  // cleanupQa calls listAllBlobs(store) which uses store.list({paginate:true}) then fallback.
  // Provide paginate async iterator.
  store.list = async function list(opts) {
    if (opts && opts.paginate) {
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            blobs: [
              { key: 'QA-OPSCORE-CUST-A-001' },
              { key: 'CD1-REAL-BOOKING' },
              { key: 'QA-OPSCORE-MULTI-003' },
            ],
          };
        },
      };
    }
    return {
      blobs: [
        { key: 'QA-OPSCORE-CUST-A-001' },
        { key: 'CD1-REAL-BOOKING' },
        { key: 'QA-OPSCORE-MULTI-003' },
      ],
    };
  };
  const removed = await __test.cleanupQa(store);
  assert.equal(removed, 2);
  assert.deepEqual(deleted.sort(), ['QA-OPSCORE-CUST-A-001', 'QA-OPSCORE-MULTI-003']);
  assert.ok(!deleted.includes('CD1-REAL-BOOKING'));
});

test('sync injects My Garage into public nav', () => {
  const sync = read('scripts/sync-public-surface.mjs');
  assert.match(sync, /injectMyGarageNav/);
});

test('six-step checkout remains in branch with ops wiring', () => {
  const html = read('index.html');
  assert.match(html, /BK_VISIBLE_STEPS\s*=\s*6/);
  assert.match(html, /id="bpt5"/);
  assert.match(read('assets/hub-booking-bridge.js'), /hub-booking-bridge/);
});
