const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const {
  normalizeJobStatus,
  normalizePaymentWorkflowStatus,
  legacyDisplayStatus,
  projectBookingForCustomer,
  JOB_STATUSES,
} = require('../netlify/lib/ops-schema');

const myGarage = read('my-garage.html');
const myGarageJs = read('assets/my-garage.js');
const lookup = read('netlify/functions/lookup-booking.js');
const customerBookings = read('netlify/functions/customer-bookings.js');
const opsDb = read('netlify/lib/ops-db.js');

test('ops-schema normalizes legacy and not_started statuses', () => {
  assert.equal(normalizeJobStatus({ jobStatus: 'not_started' }), 'pending_review');
  assert.equal(normalizeJobStatus({ status: 'En Route' }), 'en_route');
  assert.equal(normalizeJobStatus({ status: 'Paid' }), 'completed_paid');
  assert.equal(normalizeJobStatus({ appointmentStatus: 'canceled' }), 'cancelled');
  assert.ok(JOB_STATUSES.includes('completed_pending_admin_review'));
});

test('ops-schema payment workflow derives from job status', () => {
  assert.equal(
    normalizePaymentWorkflowStatus({ jobStatus: 'completed_pending_admin_review' }),
    'pending_admin_review'
  );
  assert.equal(
    normalizePaymentWorkflowStatus({ jobStatus: 'completed_pending_payment' }),
    'payment_action_required'
  );
});

test('projectBookingForCustomer exposes ops fields for portal UI', () => {
  const p = projectBookingForCustomer({
    id: 'CD1-TEST',
    status: 'Confirmed',
    jobStatus: 'assigned',
    assignedTechName: 'Alex M.',
    totalPrice: 199,
  });
  assert.equal(p.jobStatus, 'assigned');
  assert.equal(p.status, 'Scheduled');
  assert.equal(p.assignedTechName, 'Alex M.');
});

test('customer portal uses cloud lookup — not localStorage cd1_bookings', () => {
  assert.match(myGarageJs, /customer-portal-data|lookup-booking/);
  assert.match(myGarageJs, /submit-customer-action/);
  assert.doesNotMatch(myGarageJs, /localStorage\.getItem\('cd1_bookings'\)/);
  assert.doesNotMatch(myGarage, /localStorage\.getItem\('cd1_bookings'\)/);
});

test('lookup-booking and customer-bookings use ops-db + ops-schema', () => {
  assert.match(lookup, /ops-db/);
  assert.match(lookup, /projectBookingForCustomer/);
  assert.match(customerBookings, /getBooking/);
  assert.match(customerBookings, /projectBookingForCustomer/);
  assert.match(opsDb, /BOOKINGS_STORE/);
  assert.doesNotMatch(opsDb, /require\('\.\.\/lib\/ops-db'\)/);
});
