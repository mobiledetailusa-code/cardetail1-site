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

test('markCashReceived closes payment as cash', () => {
  const r = markCashReceived(baseBooking, {});
  assert.equal(r.booking.paymentStatus, 'paid_cash');
  assert.equal(r.booking.serviceStatus, 'closed');
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

test('qa-opscore harness is branch-only', () => {
  const src = read('netlify/functions/qa-opscore-lifecycle.js');
  assert.match(src, /QA-OPSCORE/);
  assert.match(src, /operations-core-job-lifecycle/);
  assert.match(src, /verifyAdminKey/);
  assert.match(src, /not_found/);
});

test('sync injects My Garage into public nav', () => {
  const sync = read('scripts/sync-public-surface.mjs');
  assert.match(sync, /injectMyGarageNav/);
});

test('f1c1c40 checkout work remains in branch', () => {
  const html = read('index.html');
  assert.match(html, /BK_VISIBLE_STEPS\s*=\s*4/);
  assert.doesNotMatch(html, /id="bpt5"/);
  assert.match(read('assets/hub-booking-bridge.js'), /hub-booking-bridge/);
});
