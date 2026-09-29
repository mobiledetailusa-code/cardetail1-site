'use strict';

/**
 * Real Stripe test-mode proof for one isolated booking.
 * Approval page → PaymentIntent → test-card confirm → signed webhook → ledger.
 * Refuses live keys and any database that is not on localhost.
 * Never prints secrets, client secrets, or the database URL.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function redact(value) {
  return String(value || '')
    .replace(/sk_(test|live)_[A-Za-z0-9]+/g, '[redacted-key]')
    .replace(/whsec_[A-Za-z0-9]+/g, '[redacted-webhook]')
    .replace(/pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '[redacted-client-secret]');
}

function refuse(code) {
  console.error(JSON.stringify({ ok: false, error: code }));
  process.exit(2);
}

function keyMode(value) {
  const secret = String(value || '');
  if (secret.startsWith('sk_live_') || secret.startsWith('rk_live_') || secret.startsWith('pk_live_')) return 'live';
  if (secret.startsWith('sk_test_') && secret.length >= 24) return 'test';
  if (!secret) return 'missing';
  return 'other';
}

const watched = ['STRIPE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_SECRET', 'STRIPE_API_KEY'];
if (watched.some((name) => keyMode(process.env[name]) === 'live')) refuse('live_stripe_key_refused');
if (keyMode(process.env.STRIPE_SECRET_KEY) !== 'test') refuse('stripe_test_key_missing');
if (String(process.env.STRIPE_WEBHOOK_SECRET || '').trim().length < 8) refuse('stripe_webhook_secret_missing');

let databaseHost = '';
try {
  databaseHost = new URL(String(process.env.DATABASE_URL || '')).hostname;
} catch {
  refuse('database_url_invalid');
}
if (databaseHost !== '127.0.0.1' && databaseHost !== 'localhost') refuse('database_host_refused');

process.env.CONTEXT = 'dev';
process.env.CD1_FORCE_LOCAL_STRIPE_GUARD = '1';
process.env.POSTGRES_PAYMENT_AUTHORITY = 'true';
process.env.DRAFT_TOKEN_SECRET = process.env.DRAFT_TOKEN_SECRET && String(process.env.DRAFT_TOKEN_SECRET).length >= 16
  ? process.env.DRAFT_TOKEN_SECRET
  : crypto.randomBytes(24).toString('hex');

const { assertStripeSecretAllowed } = require('../netlify/lib/stripe-mode');
const guard = assertStripeSecretAllowed(process.env, { purpose: 'charge' });
if (!guard.ok || guard.mode !== 'test') refuse('stripe_guard_rejected');

const { createCasMemoryStore } = require('../tests/helpers/cas-memory-store');
const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
const { setCustomerActionTokenStoreFactory } = require('../netlify/lib/customer-completion-link');
const { createCompletionLink } = require('../netlify/lib/customer-completion-link');
const { recordTechExtra } = require('../netlify/lib/quick-ops-price');
const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
const {
  reserveAndCreatePaymentIntent,
  getFinancialProjection,
} = require('../netlify/lib/db/payment-authority-service');
const { getPrisma } = require('../netlify/lib/prisma');
const customerAction = require('../netlify/functions/customer-portal-action');
const stripeWebhook = require('../netlify/functions/stripe-webhook');

function stripeHeaders(extra) {
  return {
    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    ...extra,
  };
}

async function stripeRequest(method, path, params) {
  const headers = stripeHeaders(method === 'POST'
    ? { 'Content-Type': 'application/x-www-form-urlencoded' }
    : {});
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers,
    body: method === 'POST' ? new URLSearchParams(params || {}).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    const code = json && json.error && json.error.code ? json.error.code : 'stripe_error';
    throw new Error(redact(code));
  }
  if (json && json.client_secret) delete json.client_secret;
  return json;
}

function signWebhook(rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function postWebhook(paymentIntent, eventId) {
  const safeIntent = JSON.parse(JSON.stringify(paymentIntent));
  delete safeIntent.client_secret;
  const raw = JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: safeIntent },
  });
  return stripeWebhook.handler({
    httpMethod: 'POST',
    headers: { 'stripe-signature': signWebhook(raw) },
    body: raw,
    isBase64Encoded: false,
  });
}

async function main() {
  const bookingId = `CD1ST${Date.now().toString(36).toUpperCase()}`;
  const booking = {
    id: bookingId,
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex.rivera@example.test',
    phone: '+12015550177',
    package: 'Interior Detail',
    preferredDate: '2026-09-19',
    confirmedDate: '2026-09-19',
    address: '12 Harbor View, Fort Lee, NJ',
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'assigned',
    bookingVersion: 1,
    quoteVersion: 1,
    approvedFinalAmount: 300,
    totalPrice: 300,
    techPayoutAmount: 95,
    transactionalSmsConsentAccepted: true,
    vehicles: [{ year: 2025, make: 'Honda', model: 'Civic', category: 'cars' }],
    ledger: {
      currency: 'usd',
      approvedCents: 30000,
      settledCents: 10000,
      creditedCents: 0,
      entries: [],
    },
    priceAdjustments: [],
    changeRequests: [],
  };

  const bookings = createCasMemoryStore({ [bookingId]: booking });
  const actionTokens = createCasMemoryStore();
  setBookingStoreOverride(bookings);
  setCustomerActionTokenStoreFactory(() => actionTokens);

  const ensured = await ensureBookingFinancial(booking);
  assert.equal(ensured.ok, true, ensured.error || 'ensure_failed');

  const pending = await recordTechExtra(booking, {
    amountDollars: '152.00',
    reason: 'Paint correction add-on',
    actorId: 'tech_quick_ops',
  });
  assert.equal(pending.ok, true, pending.error || pending.message);
  assert.equal(pending.booking.ledger.approvedCents, 30000);
  assert.equal(pending.booking.techPayoutAmount, 95);

  const beforeApproval = await getFinancialProjection(bookingId);
  assert.equal(beforeApproval.approvedCents, 30000);
  assert.equal(beforeApproval.settledCents, 10000);
  assert.equal(beforeApproval.remainingCents, 20000);

  const oldLink = await reserveAndCreatePaymentIntent({
    bookingId,
    quoteVersion: beforeApproval.quoteVersion,
  });
  assert.equal(oldLink.ok, true, oldLink.error || 'old_link_failed');
  assert.equal(oldLink.paymentAttempt.amountCents, 20000);
  const oldIntentId = oldLink.stripePaymentIntentId;
  assert.match(oldIntentId, /^pi_/);

  const link = await createCompletionLink(bookingId, 'extra_approval', {
    adjustmentId: pending.adjustment.adjustmentId,
  });
  const page = await customerAction.handler({
    httpMethod: 'GET',
    headers: { host: 'cardetail1.com' },
    queryStringParameters: { token: link.token },
  });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /\$152/);
  assert.match(page.body, /Paint correction add-on/);

  const approved = await customerAction.handler({
    httpMethod: 'POST',
    headers: { host: 'cardetail1.com', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve_extra', token: link.token }),
  });
  const approvedBody = JSON.parse(approved.body);
  assert.equal(approved.statusCode, 200, redact(approved.body));
  assert.equal(approvedBody.approvedCents, 45200);
  assert.equal(approvedBody.remainingCents, 35200);

  const approvedAgain = await customerAction.handler({
    httpMethod: 'POST',
    headers: { host: 'cardetail1.com', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve_extra', token: link.token }),
  });
  const approvedAgainBody = JSON.parse(approvedAgain.body);
  assert.equal(approvedAgain.statusCode, 200, redact(approvedAgain.body));
  assert.equal(approvedAgainBody.idempotent, true);
  assert.equal(approvedAgainBody.approvedCents, 45200);

  const oldIntent = await stripeRequest('GET', `payment_intents/${oldIntentId}`);
  assert.equal(oldIntent.amount, 20000);
  assert.equal(oldIntent.status, 'canceled');
  assert.equal(oldIntent.amount_received || 0, 0);

  const afterApproval = await getFinancialProjection(bookingId);
  assert.equal(afterApproval.approvedCents, 45200);
  assert.equal(afterApproval.settledCents, 10000);
  assert.equal(afterApproval.remainingCents, 35200);

  const payment = await reserveAndCreatePaymentIntent({
    bookingId,
    quoteVersion: afterApproval.quoteVersion,
  });
  assert.equal(payment.ok, true, payment.error || 'payment_link_failed');
  assert.equal(payment.paymentAttempt.amountCents, 35200);
  const paymentIntentId = payment.stripePaymentIntentId;
  const replay = await reserveAndCreatePaymentIntent({
    bookingId,
    quoteVersion: afterApproval.quoteVersion,
  });
  assert.equal(replay.ok, true, replay.error || 'payment_link_replay_failed');
  assert.equal(replay.stripePaymentIntentId, paymentIntentId);

  let confirmed;
  try {
    confirmed = await stripeRequest('POST', `payment_intents/${paymentIntentId}/confirm`, {
      payment_method: 'pm_card_visa',
      return_url: 'https://cardetail1.com/pay/return',
    });
  } catch (error) {
    if (error.message !== 'payment_intent_unexpected_state') throw error;
    confirmed = await stripeRequest('GET', `payment_intents/${paymentIntentId}`);
  }
  try {
    await stripeRequest('POST', `payment_intents/${paymentIntentId}/confirm`, {
      payment_method: 'pm_card_visa',
      return_url: 'https://cardetail1.com/pay/return',
    });
  } catch (error) {
    if (error.message !== 'payment_intent_unexpected_state') throw error;
  }
  confirmed = await stripeRequest('GET', `payment_intents/${paymentIntentId}`);
  assert.equal(confirmed.status, 'succeeded');
  assert.equal(confirmed.amount, 35200);
  assert.equal(confirmed.amount_received, 35200);
  const charges = await stripeRequest('GET', `charges?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=10`);
  assert.equal(charges.data.length, 1);
  assert.equal(charges.data[0].amount, 35200);
  assert.equal(charges.data[0].paid, true);

  const eventId = `evt_proof_${bookingId}`;
  const first = await postWebhook(confirmed, eventId);
  const firstBody = JSON.parse(first.body || '{}');
  assert.equal(first.statusCode, 200, redact(first.body));
  assert.equal(firstBody.route, 'customer_balance');
  assert.equal(firstBody.duplicate, false);

  const second = await postWebhook(confirmed, eventId);
  const secondBody = JSON.parse(second.body || '{}');
  assert.equal(second.statusCode, 200, redact(second.body));
  assert.equal(secondBody.duplicate, true);

  const paid = await getFinancialProjection(bookingId);
  assert.equal(paid.approvedCents, 45200);
  assert.equal(paid.settledCents, 45200);
  assert.equal(paid.remainingCents, 0);

  const prisma = getPrisma();
  const entries = await prisma.ledgerEntry.findMany({
    where: { bookingId, kind: 'settlement' },
    orderBy: { amountCents: 'asc' },
  });
  assert.deepEqual(entries.map((entry) => entry.amountCents), [10000, 35200]);

  const saved = await bookings.get(bookingId, { type: 'json' });
  assert.equal(saved.techPayoutAmount, 95);
  assert.equal(saved.jobStatus, 'assigned');

  console.log(JSON.stringify({
    ok: true,
    bookingId,
    approvedCents: paid.approvedCents,
    settledBeforeCents: 10000,
    pendingExcludedAmountCents: 20000,
    chargedCents: 35200,
    settledAfterCents: paid.settledCents,
    remainingCents: paid.remainingCents,
    settlementAmounts: entries.map((entry) => entry.amountCents),
    paymentIntentId,
    paymentIntentStatus: confirmed.status,
    chargeCount: charges.data.length,
    oldIntentStatus: oldIntent.status,
    oldIntentAmountCents: oldIntent.amount,
    webhookDuplicate: secondBody.duplicate,
    techPayoutAmount: saved.techPayoutAmount,
    jobStatus: saved.jobStatus,
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: redact(error && error.stack ? error.message : error) }));
  process.exit(1);
});
