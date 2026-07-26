// Admin incomplete-bookings feed — surfaces card-saved drafts that never
// finalized, so a customer who saved a card but did not submit is never lost.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { __test } = require('../netlify/functions/admin-incomplete-bookings');
const { selectIncompleteBookings, projectIncomplete, hasCardEngagement } = __test;

const FINALIZED = {
  id: 'CD1-FINAL', isDraft: false, status: 'Pending Review', bookingVersion: 1,
  finalizedAt: '2026-07-26T09:00:00Z', cardOnFileStatus: 'saved', setupIntentId: 'si_final',
  jobStatus: 'pending_review', firstName: 'Done', phone: '5551234567',
};
const CARD_SAVED_DRAFT = {
  id: 'CD1-SAVED', isDraft: true, cardOnFileStatus: 'saved', setupIntentId: 'si_1',
  stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1', jobStatus: 'not_started',
  firstName: 'Ana', lastName: 'Silva', phone: '5559990000', email: 'ana@example.com',
  vehicleLabel: 'Tesla Model 3', package: 'Premium Detail', preferredDate: '2026-08-01',
  totalPrice: 285, createdAt: '2026-07-26T10:00:00Z',
};
const SETUP_PENDING_DRAFT = {
  id: 'CD1-PENDING', isDraft: true, cardOnFileStatus: 'pending', setupIntentId: 'si_2',
  firstName: 'Bob', phone: '5558887777', createdAt: '2026-07-26T11:00:00Z',
};
const BARE_DRAFT = {
  id: 'CD1-BARE', isDraft: true, cardOnFileStatus: 'pending', firstName: 'NoCard',
  createdAt: '2026-07-26T12:00:00Z',
};
const ARCHIVED_TEST_DRAFT = {
  id: 'CD1-TEST', isDraft: true, cardOnFileStatus: 'saved', setupIntentId: 'si_3',
  isTest: true, firstName: 'Test', createdAt: '2026-07-26T08:00:00Z',
};

test('selects only card-engaged, unfinalized, non-test drafts', () => {
  const rows = selectIncompleteBookings([
    FINALIZED, CARD_SAVED_DRAFT, SETUP_PENDING_DRAFT, BARE_DRAFT, ARCHIVED_TEST_DRAFT,
  ]);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes('CD1-SAVED'), 'card-saved draft is surfaced');
  assert.ok(ids.includes('CD1-PENDING'), 'setup-intent draft is surfaced');
  assert.ok(!ids.includes('CD1-FINAL'), 'finalized booking is excluded');
  assert.ok(!ids.includes('CD1-BARE'), 'draft with no card engagement is excluded');
  assert.ok(!ids.includes('CD1-TEST'), 'archived/test draft is excluded');
  assert.equal(rows.length, 2);
});

test('orders card-saved before merely-pending, regardless of recency', () => {
  const rows = selectIncompleteBookings([SETUP_PENDING_DRAFT, CARD_SAVED_DRAFT]);
  assert.equal(rows[0].id, 'CD1-SAVED', 'card saved (submit never happened) ranks first');
  assert.equal(rows[1].id, 'CD1-PENDING');
});

test('projection never leaks Stripe identifiers', () => {
  const p = projectIncomplete(CARD_SAVED_DRAFT);
  for (const leak of ['setupIntentId', 'stripeCustomerId', 'stripePaymentMethodId', 'paymentIntentId']) {
    assert.ok(!(leak in p), `projection must not expose ${leak}`);
  }
  // But it must carry the follow-up essentials.
  assert.equal(p.firstName, 'Ana');
  assert.equal(p.phone, '5559990000');
  assert.equal(p.cardOnFileStatus, 'saved');
  assert.equal(p.package, 'Premium Detail');
});

test('hasCardEngagement requires a real card/setup signal', () => {
  assert.equal(hasCardEngagement({ cardOnFileStatus: 'saved' }), true);
  assert.equal(hasCardEngagement({ setupIntentId: 'si_x' }), true);
  assert.equal(hasCardEngagement({ stripeCustomerId: 'cus_x' }), true);
  assert.equal(hasCardEngagement({ cardOnFileStatus: 'pending' }), false);
  assert.equal(hasCardEngagement({}), false);
});

test('handler is admin-gated and forwards no Stripe ids in source', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'netlify', 'functions', 'admin-incomplete-bookings.js'),
    'utf8'
  );
  assert.match(src, /verifyAdminKey/, 'endpoint verifies the admin session');
  // The projection is an explicit allow-list; ensure no Stripe id is placed on the wire object.
  assert.doesNotMatch(src, /setupIntentId:\s*b\./, 'must not project setupIntentId');
  assert.doesNotMatch(src, /stripeCustomerId:\s*b\./, 'must not project stripeCustomerId');
});
