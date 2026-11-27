'use strict';

/**
 * PostgreSQL-backed concurrency checks for the review request lifecycle.
 * Uses the real Prisma client, real SmsOutbox table, real unique keys and the
 * real pg_advisory_xact_lock. No provider call leaves the process: sends go to
 * an in-test provider double and kicks are disabled by the Twilio policy.
 *
 * Runs in CI (integration / full-test, PostgreSQL 16 service). Locally it
 * needs DATABASE_URL pointing at a disposable database; without one it is
 * skipped outside CI and fails inside CI.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getPrisma, prismaConfigured } = require('../netlify/lib/prisma');

const lifecycle = require('../netlify/lib/review-request-lifecycle');
const { processClaimedSms, claimSmsById, applyStatusCallback } = require('../netlify/lib/sms-outbox');
const { notifyIfServiceClosedAndPaid } = require('../netlify/lib/service-completion-notice');
const { notifyReviewRequested } = require('../netlify/lib/review-request-notifications');
const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
const { setSuppressionReadOverride } = require('../netlify/lib/sms-suppression');

const HOUR = 3600 * 1000;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const NOW = Date.now();

const ENV = Object.freeze({
  TWILIO_OUTBOX_ENABLED: 'true',
  TWILIO_ENABLED: 'true',
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'true',
  // No TWILIO_PRODUCTION_SENDS_ENABLED: request-time kicks are refused, so
  // nothing reaches a provider except the explicit in-test dispatch below.
  REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED: 'true',
  REVIEW_SOLICITATION_CONSENT_VERSIONS: 'cd1-txn-sms-v3-2026-08-28',
  REVIEW_REMINDER_AUTOMATION_ENABLED: 'true',
  REVIEW_MANUAL_RESEND_ENABLED: 'true',
});

const configured = prismaConfigured();
const skip = !configured && process.env.CI !== 'true'
  ? 'DATABASE_URL not set (disposable PostgreSQL required; runs in CI)'
  : false;

let prisma;
let seq = 0;
function bookingId(label) {
  seq += 1;
  return `CD1-PGREV-${RUN}-${label}-${seq}`;
}

function booking(id, overrides = {}) {
  return {
    id,
    bookingId: id,
    firstName: 'Test',
    phone: '(201) 555-0188',
    customerAccountId: null,
    jobStatus: 'completed_paid',
    serviceStatus: 'service_completed',
    status: 'Confirmed',
    paymentStatus: 'paid_card_on_site',
    finalAmount: 100,
    amountPaid: 100,
    balanceDue: 0,
    ledger: { settledCents: 10000, creditedCents: 0, entries: [] },
    completedAt: new Date(NOW - HOUR).toISOString(),
    transactionalSmsConsentAccepted: true,
    transactionalSmsConsent: {
      granted: true,
      recordedAt: '2026-11-20T00:00:00.000Z',
      textVersion: 'cd1-txn-sms-v3-2026-08-28',
      source: 'public_booking_checkbox',
      method: 'booking_checkbox',
      programName: 'Cardetail1',
      phoneE164: '+12015550188',
    },
    ...overrides,
  };
}

async function rowsFor(id) {
  return prisma.smsOutbox.findMany({ where: { bookingId: id }, orderBy: { acceptedAt: 'asc' } });
}

function countingProvider() {
  const sent = [];
  return {
    sent,
    ok: true,
    async send({ body }) {
      sent.push(body);
      await new Promise((r) => setTimeout(r, 30)); // widen the race window
      return { sid: `SM${RUN.padEnd(16, '0').slice(0, 16)}${String(sent.length).padStart(16, '0')}`, status: 'queued' };
    },
  };
}

describe('review request lifecycle on PostgreSQL', { skip }, () => {
  before(async () => {
    assert.equal(configured, true, 'PostgreSQL is required for the review lifecycle concurrency tests');
    prisma = getPrisma();
    setSuppressionReadOverride(async () => ({ ok: true, suppressed: false }));
  });

  after(async () => {
    setSuppressionReadOverride(null);
    if (prisma) await prisma.smsOutbox.deleteMany({ where: { bookingId: { startsWith: `CD1-PGREV-${RUN}` } } });
  });

  it('concurrent completion events across all paths create exactly one initial ask', async () => {
    const id = bookingId('XPATH');
    const b = booking(id);
    const pending = booking(id, { jobStatus: 'completed_pending_admin_review' });
    const calls = [];
    for (let i = 0; i < 4; i += 1) {
      calls.push(notifyIfServiceClosedAndPaid(b, { prisma, env: ENV, now: NOW, source: 'approve_completion' }));
      calls.push(notifyReviewRequested(pending, { prisma, env: ENV, now: NOW, verifiedPhoneE164: null }));
    }
    await Promise.all(calls);
    const rows = await rowsFor(id);
    const initial = rows.filter((row) => ['initial_request', 'completion_with_review_link'].includes(lifecycle.rowKind(row)));
    assert.equal(initial.length, 1, `initial asks: ${initial.map((r) => r.templateKey)}`);
    assert.equal(rows.filter((row) => row.templateKey === TEMPLATE_KEYS.SERVICE_COMPLETED).length <= 1, true);
    assert.equal(rows.filter((row) => row.templateKey === TEMPLATE_KEYS.REVIEW_REMINDER).length, 1);
  });

  it('the receipt is always queued even when the tech ask wins the race', async () => {
    const id = bookingId('RECEIPT');
    const pending = booking(id, { jobStatus: 'completed_pending_admin_review' });
    await notifyReviewRequested(pending, { prisma, env: ENV, now: NOW, verifiedPhoneE164: null });
    const res = await notifyIfServiceClosedAndPaid(booking(id), { prisma, env: ENV, now: NOW });
    assert.equal(res.queued, true);
    assert.equal(res.reviewLinkIncluded, false);
    const receipt = (await rowsFor(id)).find((row) => row.templateKey === TEMPLATE_KEYS.SERVICE_COMPLETED);
    assert.match(receipt.templateData.receiptUrl, /receipt\.html/);
    assert.equal(receipt.templateData.reviewUrl, '');
  });

  it('concurrent manual resends create one row', async () => {
    const id = bookingId('MANUAL');
    await notifyIfServiceClosedAndPaid(booking(id), { prisma, env: { ...ENV, REVIEW_REMINDER_AUTOMATION_ENABLED: '' }, now: NOW });
    const results = await Promise.all(Array.from({ length: 8 }, () => lifecycle.manualResend(booking(id), { prisma, env: ENV, now: NOW, kick: false })));
    const rows = (await rowsFor(id)).filter((row) => row.templateKey === TEMPLATE_KEYS.REVIEW_REMINDER);
    assert.equal(rows.length, 1);
    assert.equal(results.filter((r) => r.queued && !r.idempotent).length, 1);
    assert.equal(results.filter((r) => r.reason === 'manual_resend_already_used').length, 7);
  });

  it('two workers holding two due asks for one booking send exactly one', async () => {
    const id = bookingId('WORKERS');
    await notifyIfServiceClosedAndPaid(booking(id), { prisma, env: ENV, now: NOW });
    // The completion text reached Twilio long ago; make the reminder due and add a manual ask.
    const initial = (await rowsFor(id)).find((row) => row.templateKey === TEMPLATE_KEYS.SERVICE_COMPLETED);
    const past = new Date(NOW - 3 * 24 * HOUR);
    await prisma.smsOutbox.update({
      where: { id: initial.id },
      data: { providerMessageSid: `SM${'b'.repeat(16)}${RUN.padEnd(16, '0').slice(0, 16)}`, status: 'delivered', sentAt: past, deliveredAt: past, acceptedAt: past },
    });
    const completedLongAgo = booking(id, { completedAt: new Date(NOW - 3 * 24 * HOUR - HOUR).toISOString() });
    const manual = await lifecycle.manualResend(completedLongAgo, { prisma, env: ENV, now: NOW, kick: false });
    assert.equal(manual.queued, true);
    const followUps = (await rowsFor(id)).filter((row) => row.templateKey === TEMPLATE_KEYS.REVIEW_REMINDER);
    assert.equal(followUps.length, 2);

    // Find a moment inside the send window at which both are due.
    const at = lifecycle.nextSendWindowStart(Math.max(NOW, ...followUps.map((r) => r.availableAt.getTime())));
    for (const row of followUps) {
      await prisma.smsOutbox.update({ where: { id: row.id }, data: { availableAt: new Date(at.getTime() - 1000) } });
    }
    const claimed = await Promise.all(followUps.map((row) => claimSmsById(prisma, row.id, at)));
    assert.equal(claimed.filter(Boolean).length, 2);
    const provider = countingProvider();
    await Promise.all(claimed.map((row) => processClaimedSms(row, {
      prisma,
      env: ENV,
      now: at,
      provider,
      reviewBookingLoader: async () => completedLongAgo,
    })));
    assert.equal(provider.sent.length, 1);
    const after = (await rowsFor(id)).filter((row) => row.templateKey === TEMPLATE_KEYS.REVIEW_REMINDER);
    assert.equal(after.filter((row) => row.providerMessageSid).length, 1);
    const other = after.find((row) => !row.providerMessageSid);
    assert.ok(['accepted', 'failed'].includes(other.status));
    if (other.status === 'accepted') assert.ok(other.availableAt.getTime() > at.getTime(), 'deferred, not sent');
  });

  it('marking received cancels pending reminders; a racing dispatch is cancelled by its own check', async () => {
    const id = bookingId('RECEIVED');
    await notifyIfServiceClosedAndPaid(booking(id), { prisma, env: ENV, now: NOW });
    const reminder = (await rowsFor(id)).find((row) => row.templateKey === TEMPLATE_KEYS.REVIEW_REMINDER);
    assert.ok(reminder);
    const cancelled = await lifecycle.cancelPendingFollowUps(id, 'review_received', { prisma });
    assert.equal(cancelled.cancelled, 1);
    const row = await prisma.smsOutbox.findUnique({ where: { id: reminder.id } });
    assert.equal(row.status, 'failed');
    assert.equal(row.lastErrorCode, 'review_cancelled_review_received');

    const id2 = bookingId('LEASED');
    await notifyIfServiceClosedAndPaid(booking(id2), { prisma, env: ENV, now: NOW });
    const r2 = (await rowsFor(id2)).find((x) => x.templateKey === TEMPLATE_KEYS.REVIEW_REMINDER);
    const dueAt = r2.availableAt;
    await prisma.smsOutbox.update({ where: { id: r2.id }, data: { availableAt: new Date(dueAt.getTime() - 1000) } });
    const claimedRow = await claimSmsById(prisma, r2.id, dueAt);
    const skipLeased = await lifecycle.cancelPendingFollowUps(id2, 'review_received', { prisma, now: dueAt });
    assert.equal(skipLeased.cancelled, 0);
    const provider = countingProvider();
    await processClaimedSms(claimedRow, {
      prisma,
      env: ENV,
      now: dueAt,
      provider,
      reviewBookingLoader: async () => booking(id2, { reviewRequest: { receivedAt: new Date(NOW).toISOString() } }),
    });
    assert.equal(provider.sent.length, 0);
    const final = await prisma.smsOutbox.findUnique({ where: { id: r2.id } });
    assert.equal(final.lastErrorCode, 'review_cancelled_review_received');
  });

  it('STOP suppression cancels a due reminder before the provider call', async () => {
    const id = bookingId('STOP');
    await notifyIfServiceClosedAndPaid(booking(id), { prisma, env: ENV, now: NOW });
    const r = (await rowsFor(id)).find((x) => x.templateKey === TEMPLATE_KEYS.REVIEW_REMINDER);
    await prisma.smsOutbox.update({ where: { id: r.id }, data: { availableAt: new Date(r.availableAt.getTime() - 1000) } });
    const claimed = await claimSmsById(prisma, r.id, r.availableAt);
    setSuppressionReadOverride(async () => ({ ok: true, suppressed: true }));
    try {
      const provider = countingProvider();
      await processClaimedSms(claimed, { prisma, env: ENV, now: r.availableAt, provider, reviewBookingLoader: async () => booking(id) });
      assert.equal(provider.sent.length, 0);
      const row = await prisma.smsOutbox.findUnique({ where: { id: r.id } });
      assert.equal(row.lastErrorCode, 'review_cancelled_sms_suppressed');
    } finally {
      setSuppressionReadOverride(async () => ({ ok: true, suppressed: false }));
    }
  });

  it('delivery is shown only from Twilio status, and stays monotonic', async () => {
    const id = bookingId('STATUS');
    await notifyIfServiceClosedAndPaid(booking(id), { prisma, env: ENV, now: NOW });
    const receipt = (await rowsFor(id)).find((x) => x.templateKey === TEMPLATE_KEYS.SERVICE_COMPLETED);
    const sid = `SM${'c'.repeat(16)}${RUN.padEnd(16, '0').slice(0, 16)}`;
    await prisma.smsOutbox.update({ where: { id: receipt.id }, data: { providerMessageSid: sid, providerStatus: 'queued' } });
    let view = lifecycle.reviewLifecycleView(booking(id), await rowsFor(id), { now: NOW, env: ENV });
    assert.equal(view.messages.find((m) => m.kind === 'completion_with_review_link').stage, 'submitted');
    assert.equal(view.messages[0].deliveredAt, null);

    await applyStatusCallback({ providerMessageSid: sid, providerStatus: 'delivered' }, { prisma });
    await applyStatusCallback({ providerMessageSid: sid, providerStatus: 'sent' }, { prisma });
    view = lifecycle.reviewLifecycleView(booking(id), await rowsFor(id), { now: NOW, env: ENV });
    const m = view.messages.find((x) => x.kind === 'completion_with_review_link');
    assert.equal(m.stage, 'delivered');
    assert.ok(m.deliveredAt);
  });

  it('an ambiguous provider failure holds the slot in the real ledger', async () => {
    const id = bookingId('AMBIG');
    await notifyIfServiceClosedAndPaid(booking(id), { prisma, env: { ...ENV, REVIEW_REMINDER_AUTOMATION_ENABLED: '' }, now: NOW });
    const receipt = (await rowsFor(id)).find((x) => x.templateKey === TEMPLATE_KEYS.SERVICE_COMPLETED);
    const claimed = await claimSmsById(prisma, receipt.id, new Date(NOW + 1000));
    const timeout = { ok: true, async send() { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; } };
    await processClaimedSms(claimed, { prisma, env: ENV, now: new Date(NOW + 1000), provider: timeout, reviewBookingLoader: async () => booking(id) });
    const rows = await rowsFor(id);
    const row = rows.find((x) => x.id === receipt.id);
    assert.equal(row.status, 'failed');
    assert.equal(lifecycle.rowStage(row), 'ambiguous');
    // The initial slot stays used: a tech-path ask now is a duplicate.
    const tech = await notifyReviewRequested(booking(id, { jobStatus: 'completed_pending_admin_review' }), { prisma, env: ENV, now: NOW + 2000, verifiedPhoneE164: null });
    assert.equal(tech.reason, 'duplicate_initial');
  });

  it('a row the previous build cannot render fails closed instead of sending (rollback)', async () => {
    const { renderSmsTemplate } = require('../netlify/lib/sms-templates');
    // The previous build has no booking.review_reminder case; any unknown key fails rendering.
    assert.equal(renderSmsTemplate('booking.review_reminder_unknown_to_build', {}).ok, false);
  });
});
