'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../netlify/lib/review-request-lifecycle');
const { processClaimedSms } = require('../netlify/lib/sms-outbox');
const { notifyIfServiceClosedAndPaid } = require('../netlify/lib/service-completion-notice');
const { notifyReviewRequested } = require('../netlify/lib/review-request-notifications');
const { renderSmsTemplate, TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
const { setSuppressionReadOverride } = require('../netlify/lib/sms-suppression');

const GOOGLE = 'https://g.page/r/CTJwfJerrQeCEAI/review';
const HOUR = 3600 * 1000;
// Tuesday 2026-11-24 10:00 America/New_York (EST, UTC-5).
const NOW = Date.parse('2026-11-24T15:00:00.000Z');

const BASE_ENV = Object.freeze({
  TWILIO_OUTBOX_ENABLED: 'true',
  TWILIO_ENABLED: 'true',
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'true',
});
const ON_ENV = Object.freeze({
  ...BASE_ENV,
  REVIEW_REMINDER_AUTOMATION_ENABLED: 'true',
  REVIEW_MANUAL_RESEND_ENABLED: 'true',
  REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED: 'true',
  REVIEW_SOLICITATION_CONSENT_VERSIONS: 'cd1-txn-sms-v3-2026-08-28',
});

function booking(overrides = {}) {
  return {
    id: 'CD1-REVIEW-1',
    bookingId: 'CD1-REVIEW-1',
    firstName: 'Test',
    phone: '(201) 555-0142',
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
      phoneE164: '+12015550142',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory SmsOutbox with the filter semantics the code relies on.

function toMs(v) {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}
function matches(row, where) {
  return Object.entries(where || {}).every(([key, cond]) => {
    if (key === 'OR') return cond.some((alt) => matches(row, alt));
    const value = row[key];
    if (cond === null) return value == null;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(value);
      if ('lt' in cond) return value != null && toMs(value) < toMs(cond.lt);
      if ('lte' in cond) return value != null && toMs(value) <= toMs(cond.lte);
      throw new Error(`fake outbox: unsupported filter ${key}`);
    }
    return value === cond;
  });
}
function fakePrisma() {
  const rows = new Map();
  let n = 0;
  const clone = (r) => (r ? { ...r, templateData: { ...(r.templateData || {}) } } : null);
  const smsOutbox = {
    async findUnique({ where }) {
      if (where.id) return clone(rows.get(where.id));
      for (const r of rows.values()) {
        if (where.idempotencyKey && r.idempotencyKey === where.idempotencyKey) return clone(r);
        if (where.providerMessageSid && r.providerMessageSid === where.providerMessageSid) return clone(r);
      }
      return null;
    },
    async findMany({ where, orderBy } = {}) {
      const out = [...rows.values()].filter((r) => matches(r, where)).map(clone);
      if (orderBy?.acceptedAt) out.sort((a, b) => toMs(a.acceptedAt) - toMs(b.acceptedAt));
      return out;
    },
    async create({ data }) {
      for (const r of rows.values()) {
        if (r.idempotencyKey === data.idempotencyKey) {
          const e = new Error('dup');
          e.code = 'P2002';
          throw e;
        }
      }
      n += 1;
      const now = new Date(NOW + n); // stable ordering
      const row = {
        id: `sms_${n}`,
        status: 'accepted',
        providerMessageSid: null,
        providerStatus: null,
        attemptCount: 0,
        maxAttempts: 5,
        availableAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        acceptedAt: now,
        sentAt: null,
        deliveredAt: null,
        failedAt: null,
        ...data,
      };
      rows.set(row.id, row);
      return clone(row);
    },
    async update({ where, data }) {
      const r = rows.get(where.id);
      if (!r) throw new Error('not found');
      const next = { ...r };
      for (const [k, v] of Object.entries(data)) {
        next[k] = v && typeof v === 'object' && 'increment' in v ? (r[k] || 0) + v.increment : v;
      }
      rows.set(r.id, next);
      return clone(next);
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const r of rows.values()) {
        if (!matches(r, where)) continue;
        await smsOutbox.update({ where: { id: r.id }, data });
        count += 1;
      }
      return { count };
    },
  };
  return {
    rows,
    smsOutbox,
    customerAccount: { async findUnique() { return null; } },
    async $transaction(fn) { return fn(this); },
  };
}

function rowsOf(prisma, templateKey) {
  return [...prisma.rows.values()].filter((r) => !templateKey || r.templateKey === templateKey);
}

function fakeProvider() {
  const sent = [];
  return {
    sent,
    ok: true,
    async send({ to, body }) {
      sent.push({ to, body });
      return { sid: `SM${String(sent.length).padStart(32, '0')}`, status: 'queued' };
    },
  };
}

// Freeze Date.now for enqueueSms' future-only availableAt check.
let realNow;
test.beforeEach(() => {
  realNow = Date.now;
  Date.now = () => NOW;
  setSuppressionReadOverride(async () => ({ ok: true, suppressed: false }));
});
test.afterEach(() => {
  Date.now = realNow;
  setSuppressionReadOverride(null);
});


// Compliance only (no follow-up switches): simulates an owner who verified the
// campaign and approved a consent version. Tests only.
const COMPLIANT_ENV = Object.freeze({
  ...BASE_ENV,
  REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED: 'true',
  REVIEW_SOLICITATION_CONSENT_VERSIONS: 'cd1-txn-sms-v3-2026-08-28',
});

test('send window is 10:00-18:00 America/New_York, Monday to Saturday', () => {
  assert.equal(lifecycle.isWithinSendWindow(Date.parse('2026-11-24T15:00:00Z')), true); // Tue 10:00
  assert.equal(lifecycle.isWithinSendWindow(Date.parse('2026-11-24T14:59:00Z')), false); // Tue 09:59
  assert.equal(lifecycle.isWithinSendWindow(Date.parse('2026-11-24T23:00:00Z')), false); // Tue 18:00
  assert.equal(lifecycle.isWithinSendWindow(Date.parse('2026-11-29T16:00:00Z')), false); // Sunday 11:00
  assert.equal(lifecycle.nextSendWindowStart(Date.parse('2026-11-28T23:30:00Z')).toISOString(), '2026-11-30T15:00:00.000Z');
  assert.equal(lifecycle.nextSendWindowStart(Date.parse('2026-07-06T13:00:00Z')).toISOString(), '2026-07-06T14:00:00.000Z');
});

test('defaults: no review solicitation on any path; the receipt is still sent', async () => {
  assert.deepEqual(lifecycle.programBlockers(BASE_ENV), ['a2p_campaign_not_verified', 'review_consent_not_established']);
  assert.equal(lifecycle.solicitationCompliance(booking(), BASE_ENV).ok, false);

  const prisma = fakePrisma();
  const paid = await notifyIfServiceClosedAndPaid(booking(), { prisma, env: BASE_ENV, now: NOW });
  assert.equal(paid.queued, true);
  assert.equal(paid.reviewLinkIncluded, false);
  const receipt = rowsOf(prisma, TEMPLATE_KEYS.SERVICE_COMPLETED)[0];
  assert.match(receipt.templateData.receiptUrl, /receipt\.html\?bookingId=CD1-REVIEW-1&type=final$/);
  assert.equal(receipt.templateData.reviewUrl, '');
  const body = renderSmsTemplate(TEMPLATE_KEYS.SERVICE_COMPLETED, receipt.templateData).body;
  assert.match(body, /View your receipt/);
  assert.doesNotMatch(body, /Google review|g\.page/);

  const tech = await notifyReviewRequested(
    booking({ id: 'CD1-REVIEW-T', bookingId: 'CD1-REVIEW-T', jobStatus: 'completed_pending_admin_review' }),
    { prisma, env: BASE_ENV, now: NOW, verifiedPhoneE164: null },
  );
  assert.equal(tech.skipped, true);
  assert.equal(tech.reason, 'a2p_campaign_not_verified');
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REQUESTED).length, 0);

  assert.equal(paid.reminder.reason, 'no_review_link');
  const manual = await lifecycle.manualResend(booking(), { prisma, env: BASE_ENV, now: NOW });
  assert.equal(manual.reason, 'manual_resend_disabled');
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER).length, 0);
});

test('existing transactional consent versions are never treated as review consent', async () => {
  const prisma = fakePrisma();
  const switchesOnly = {
    ...BASE_ENV,
    REVIEW_REMINDER_AUTOMATION_ENABLED: 'true',
    REVIEW_MANUAL_RESEND_ENABLED: 'true',
    REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED: 'true',
  };
  const res = await notifyIfServiceClosedAndPaid(booking(), { prisma, env: switchesOnly, now: NOW });
  assert.equal(res.reviewLinkIncluded, false);
  assert.equal(lifecycle.solicitationCompliance(booking(), switchesOnly).reason, 'review_consent_not_established');

  const legacy = booking({
    id: 'CD1-REVIEW-2',
    bookingId: 'CD1-REVIEW-2',
    transactionalSmsConsent: { ...booking().transactionalSmsConsent, textVersion: 'dz-txn-sms-v2-2026-08-22' },
  });
  assert.equal(lifecycle.solicitationCompliance(legacy, ON_ENV).reason, 'consent_version_not_covered');
  const res2 = await notifyIfServiceClosedAndPaid(legacy, { prisma, env: ON_ENV, now: NOW });
  assert.equal(res2.reviewLinkIncluded, false);
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER).length, 0);
});

async function dispatch(prisma, row, { now, bookingState, env = ON_ENV, provider = fakeProvider() } = {}) {
  const claimed = await prisma.smsOutbox.update({ where: { id: row.id }, data: { attemptCount: { increment: 1 } } });
  const result = await processClaimedSms(claimed, {
    prisma,
    env,
    now,
    provider,
    reviewBookingLoader: async () => (typeof bookingState === 'function' ? bookingState() : bookingState),
  });
  return { result, provider, row: await prisma.smsOutbox.findUnique({ where: { id: row.id } }) };
}

test('a previously queued completion text loses its review link at dispatch; the receipt still sends', async () => {
  const prisma = fakePrisma();
  const legacyRow = await prisma.smsOutbox.create({
    data: {
      idempotencyKey: 'booking.service_completed:CD1-REVIEW-1',
      audience: 'customer',
      bookingId: 'CD1-REVIEW-1',
      toE164: '+12015550142',
      templateKey: TEMPLATE_KEYS.SERVICE_COMPLETED,
      templateVersion: 'sms-v6-2026-09-16',
      templateData: { receiptUrl: 'https://cardetail1.com/receipt.html?bookingId=CD1-REVIEW-1&type=final', reviewUrl: GOOGLE },
    },
  });
  const { provider, row } = await dispatch(prisma, legacyRow, { now: NOW, bookingState: booking(), env: BASE_ENV });
  assert.equal(provider.sent.length, 1);
  assert.match(provider.sent[0].body, /View your receipt/);
  assert.doesNotMatch(provider.sent[0].body, /Google review|g\.page/);
  assert.equal(row.templateData.reviewUrl, '');
  assert.ok(row.providerMessageSid);
  const again = await notifyIfServiceClosedAndPaid(booking(), { prisma, env: BASE_ENV, now: NOW + 1000 });
  assert.equal(again.queued, true);
  assert.equal(again.idempotent, true, 'payload hash updated with the strip');
});

test('a previously queued review_requested row is cancelled at dispatch without consent', async () => {
  const prisma = fakePrisma();
  const queued = await prisma.smsOutbox.create({
    data: {
      idempotencyKey: 'booking.review_requested:CD1-REVIEW-1',
      audience: 'customer',
      bookingId: 'CD1-REVIEW-1',
      toE164: '+12015550142',
      templateKey: TEMPLATE_KEYS.REVIEW_REQUESTED,
      templateData: { url: 'https://cardetail1.com/reviews' },
    },
  });
  const { provider, row } = await dispatch(prisma, queued, { now: NOW, bookingState: booking(), env: BASE_ENV });
  assert.equal(provider.sent.length, 0);
  assert.equal(row.status, 'failed');
  assert.equal(row.lastErrorCode, 'review_cancelled_a2p_campaign_not_verified');
});

test('neutral eligibility: service issues, disputes and ratings do not change who is asked', async () => {
  for (const overrides of [
    { jobStatus: 'issue_reported' },
    { serviceStatus: 'disputed' },
    { serviceIssues: [{ issueId: 'i1', category: 'quality', description: 'x', status: 'open', createdAt: new Date(NOW).toISOString() }] },
    { customerSatisfaction: 1, predictedRating: 1 },
  ]) {
    const b = booking({ completedAt: new Date(NOW - HOUR).toISOString(), ...overrides });
    assert.equal(lifecycle.initialEligibility(b, [], { now: NOW, env: COMPLIANT_ENV }).ok, true, JSON.stringify(overrides));
  }
  const { shouldAskForReview } = require('../netlify/lib/review-request-notifications');
  assert.equal(shouldAskForReview(booking({ jobStatus: 'issue_reported' })), true);
  for (const stars of [1, 5]) {
    const reviewed = booking({ review: { reviewId: 'r', stars, submittedAt: new Date(NOW).toISOString() } });
    assert.equal(lifecycle.initialEligibility(reviewed, [], { now: NOW, env: COMPLIANT_ENV }).reason, 'review_received');
  }
});

test('compliant: one initial ask across paths, then one reminder about 48 h later inside the window', async () => {
  const prisma = fakePrisma();
  const b = booking();
  const first = await notifyIfServiceClosedAndPaid(b, { prisma, env: ON_ENV, now: NOW });
  assert.equal(first.reviewLinkIncluded, true);
  assert.equal(first.reminder.queued, true);
  const reminder = rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER);
  assert.equal(reminder.length, 1);
  assert.equal(reminder[0].idempotencyKey, 'booking.review_reminder:CD1-REVIEW-1:auto');
  const at = toMs(reminder[0].availableAt);
  assert.ok(at >= toMs(b.completedAt) + 48 * HOUR);
  assert.ok(lifecycle.isWithinSendWindow(at));

  await notifyIfServiceClosedAndPaid(b, { prisma, env: ON_ENV, now: NOW + 60_000 });
  const tech = await notifyReviewRequested(b, { prisma, env: ON_ENV, now: NOW + 120_000, verifiedPhoneE164: null });
  assert.equal(tech.reason, 'duplicate_initial');
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER).length, 1);
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.SERVICE_COMPLETED).length, 1);
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REQUESTED).length, 0);
});

test('compliant, tech path first: the paid completion text keeps the receipt and drops the link', async () => {
  const prisma = fakePrisma();
  const pending = booking({ jobStatus: 'completed_pending_admin_review', paymentStatus: 'unpaid', ledger: { settledCents: 0 } });
  const asked = await notifyReviewRequested(pending, { prisma, env: COMPLIANT_ENV, now: NOW, verifiedPhoneE164: null });
  assert.equal(asked.queued, true);
  const res = await notifyIfServiceClosedAndPaid(booking(), { prisma, env: COMPLIANT_ENV, now: NOW + 1000 });
  assert.equal(res.queued, true);
  assert.equal(res.reviewLinkIncluded, false);
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.SERVICE_COMPLETED)[0].templateData.reviewUrl, '');
});

test('automation and manual resend are independent switches', async () => {
  const autoOnly = { ...COMPLIANT_ENV, REVIEW_REMINDER_AUTOMATION_ENABLED: 'true' };
  const manualOnly = { ...COMPLIANT_ENV, REVIEW_MANUAL_RESEND_ENABLED: 'true' };

  const p1 = fakePrisma();
  const a = await notifyIfServiceClosedAndPaid(booking(), { prisma: p1, env: autoOnly, now: NOW });
  assert.equal(a.reminder.queued, true);
  const m1 = await lifecycle.manualResend(booking(), { prisma: p1, env: autoOnly, now: NOW });
  assert.equal(m1.reason, 'manual_resend_disabled');

  const p2 = fakePrisma();
  const b = await notifyIfServiceClosedAndPaid(booking(), { prisma: p2, env: manualOnly, now: NOW });
  assert.equal(b.reminder.reason, 'automation_disabled');
  const m2 = await lifecycle.manualResend(booking(), { prisma: p2, env: manualOnly, now: NOW });
  assert.equal(m2.queued, true);
  assert.equal(rowsOf(p2, TEMPLATE_KEYS.REVIEW_REMINDER)[0].idempotencyKey, 'booking.review_reminder:CD1-REVIEW-1:manual');
});

test('a historical completion never schedules a reminder (no retroactive sends)', async () => {
  const prisma = fakePrisma();
  const old = booking({ completedAt: new Date(NOW - 3 * 24 * HOUR).toISOString() });
  const res = await notifyIfServiceClosedAndPaid(old, { prisma, env: ON_ENV, now: NOW });
  assert.equal(res.reminder.reason, 'historical_completion');
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER).length, 0);
});

async function scheduledReminder(env = ON_ENV, b = booking()) {
  const prisma = fakePrisma();
  await notifyIfServiceClosedAndPaid(b, { prisma, env, now: NOW });
  const initial = rowsOf(prisma, TEMPLATE_KEYS.SERVICE_COMPLETED)[0];
  await prisma.smsOutbox.update({
    where: { id: initial.id },
    data: { providerMessageSid: 'SM' + 'a'.repeat(32), status: 'sent', sentAt: new Date(NOW) },
  });
  const reminder = rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER)[0];
  return { prisma, reminder, dueAt: toMs(reminder.availableAt) };
}

test('dispatch: an eligible reminder goes out once, with neutral wording', async () => {
  const { prisma, reminder, dueAt } = await scheduledReminder();
  const { provider, row } = await dispatch(prisma, reminder, { now: dueAt, bookingState: booking() });
  assert.equal(provider.sent.length, 1);
  assert.match(provider.sent[0].body, /^Cardetail1: Thanks again for choosing us\./);
  assert.match(provider.sent[0].body, /honest Google review: https:\/\/g\.page\/r\/CTJwfJerrQeCEAI\/review/);
  assert.match(provider.sent[0].body, /Reply STOP or HELP$/);
  assert.doesNotMatch(provider.sent[0].body, /discount|free|gift|coupon|reward|5[- ]star|five[- ]star/i);
  assert.ok(row.providerMessageSid);
  const again = lifecycle.followUpEligibility(booking(), rowsOf(prisma), { kind: 'auto', now: dueAt + HOUR, env: ON_ENV });
  assert.equal(again.reason, 'automatic_cap_reached');
});

test('dispatch cancels when stopped, received, any review left, STOP, expired, or a gate is off', async () => {
  const cases = [
    ['stopped', () => booking({ reviewRequest: { stoppedAt: new Date(NOW).toISOString() } }), ON_ENV],
    ['review_received', () => booking({ reviewRequest: { receivedAt: new Date(NOW).toISOString() } }), ON_ENV],
    ['review_received', () => booking({ review: { reviewId: 'r1', stars: 2, submittedAt: new Date(NOW).toISOString() } }), ON_ENV],
    ['automation_disabled', () => booking(), { ...ON_ENV, REVIEW_REMINDER_AUTOMATION_ENABLED: '' }],
    ['a2p_campaign_not_verified', () => booking(), { ...ON_ENV, REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED: '' }],
    ['review_consent_not_established', () => booking(), { ...ON_ENV, REVIEW_SOLICITATION_CONSENT_VERSIONS: '' }],
  ];
  for (const [reason, state, env] of cases) {
    const { prisma, reminder, dueAt } = await scheduledReminder();
    const { provider, row } = await dispatch(prisma, reminder, { now: dueAt, bookingState: state, env });
    assert.equal(provider.sent.length, 0, reason);
    assert.equal(row.status, 'failed', reason);
    assert.equal(row.lastErrorCode, `review_cancelled_${reason}`, reason);
  }

  const { prisma, reminder } = await scheduledReminder();
  const expired = await dispatch(prisma, reminder, { now: NOW + 15 * 24 * HOUR, bookingState: booking() });
  assert.equal(expired.provider.sent.length, 0);
  assert.equal(expired.row.lastErrorCode, 'review_cancelled_expired');

  const stop = await scheduledReminder();
  setSuppressionReadOverride(async () => ({ ok: true, suppressed: true }));
  const opted = await dispatch(stop.prisma, stop.reminder, { now: stop.dueAt, bookingState: booking() });
  assert.equal(opted.provider.sent.length, 0);
  assert.equal(opted.row.lastErrorCode, 'review_cancelled_sms_suppressed');
});

test('dispatch defers outside the window without burning an attempt, and fails closed on lookup errors', async () => {
  const { prisma, reminder, dueAt } = await scheduledReminder();
  const sunday = Date.parse('2026-11-29T16:00:00Z');
  const deferred = await dispatch(prisma, reminder, { now: sunday, bookingState: booking() });
  assert.equal(deferred.provider.sent.length, 0);
  assert.equal(deferred.row.status, 'accepted');
  assert.equal(deferred.row.attemptCount, 0);
  assert.equal(new Date(deferred.row.availableAt).toISOString(), '2026-11-30T15:00:00.000Z');

  let row = deferred.row;
  for (let i = 0; i < 5; i += 1) {
    const out = await dispatch(prisma, row, { now: dueAt, bookingState: () => { throw new Error('blobs down'); } });
    assert.equal(out.provider.sent.length, 0);
    row = out.row;
  }
  assert.equal(row.status, 'failed');
  assert.equal(row.lastErrorCode, 'review_cancelled_gate_unavailable');
});

test('an ambiguous provider failure keeps its slot, so it cannot cause a second ask', async () => {
  const { prisma, reminder, dueAt } = await scheduledReminder();
  const timeoutProvider = { ok: true, async send() { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; } };
  const out = await dispatch(prisma, reminder, { now: dueAt, bookingState: booking(), provider: timeoutProvider });
  assert.equal(out.row.status, 'failed');
  assert.equal(out.row.providerMessageSid, null);
  assert.equal(lifecycle.rowStage(out.row), 'ambiguous');
  assert.equal(lifecycle.consumesSlot(out.row), true);
  assert.equal(lifecycle.slotCounts(rowsOf(prisma)).automatic, 2);
  const view = lifecycle.reviewLifecycleView(booking(), rowsOf(prisma), { now: dueAt, env: ON_ENV });
  assert.equal(view.state, 'failed');
  assert.equal(view.messages.find((m) => m.kind === 'automatic_reminder').deliveredAt, null);
});

test('owner marks cancel pending follow-ups; a leased row is left to the dispatch check', async () => {
  const { prisma, reminder } = await scheduledReminder();
  const res = await lifecycle.cancelPendingFollowUps('CD1-REVIEW-1', 'review_received', { prisma, now: NOW });
  assert.equal(res.cancelled, 1);
  const row = await prisma.smsOutbox.findUnique({ where: { id: reminder.id } });
  assert.equal(row.lastErrorCode, 'review_cancelled_review_received');

  const second = await scheduledReminder();
  await second.prisma.smsOutbox.update({ where: { id: second.reminder.id }, data: { leaseExpiresAt: new Date(NOW + 60_000) } });
  const leased = await lifecycle.cancelPendingFollowUps('CD1-REVIEW-1', 'stopped', { prisma: second.prisma, now: NOW });
  assert.equal(leased.cancelled, 0);
});

test('manual resend: one per booking, 24 h cooldown, total cap of three', async () => {
  const { prisma, reminder, dueAt } = await scheduledReminder();
  await dispatch(prisma, reminder, { now: dueAt, bookingState: booking() });
  await prisma.smsOutbox.update({ where: { id: reminder.id }, data: { status: 'sent', sentAt: new Date(dueAt) } });

  const soon = await lifecycle.manualResend(booking(), { prisma, env: ON_ENV, now: dueAt + HOUR });
  assert.equal(soon.queued, true);
  assert.ok(toMs(soon.scheduledFor) >= dueAt + 24 * HOUR);
  assert.ok(lifecycle.isWithinSendWindow(toMs(soon.scheduledFor)));
  const twice = await lifecycle.manualResend(booking(), { prisma, env: ON_ENV, now: dueAt + 2 * HOUR });
  assert.equal(twice.reason, 'manual_resend_already_used');
  assert.equal(lifecycle.slotCounts(rowsOf(prisma)).total, 3);
});

test('admin view distinguishes queued, submitted, delivered and the terminal states', () => {
  const b = booking();
  const base = {
    id: 'r1',
    bookingId: 'CD1-REVIEW-1',
    audience: 'customer',
    templateKey: TEMPLATE_KEYS.SERVICE_COMPLETED,
    idempotencyKey: 'booking.service_completed:CD1-REVIEW-1',
    templateData: { reviewUrl: GOOGLE, receiptUrl: 'x' },
    acceptedAt: new Date(NOW),
    availableAt: new Date(NOW),
    attemptCount: 0,
    providerMessageSid: null,
    status: 'accepted',
  };
  const view = (rows, extra = {}, bk = b) => lifecycle.reviewLifecycleView(bk, rows, { now: NOW, env: ON_ENV, ...extra }).state;
  assert.equal(view([]), 'not_requested');
  assert.equal(view([{ ...base, templateData: { reviewUrl: '', receiptUrl: 'x' } }]), 'not_requested', 'receipt-only is not an ask');
  assert.equal(view([base]), 'queued');
  assert.equal(view([{ ...base, providerMessageSid: 'SM1', providerStatus: 'queued' }]), 'sent');
  assert.equal(view([{ ...base, providerMessageSid: 'SM1', status: 'sent' }]), 'sent');
  assert.equal(view([{ ...base, providerMessageSid: 'SM1', status: 'delivered', deliveredAt: new Date(NOW) }]), 'delivered');
  assert.equal(view([{ ...base, providerMessageSid: 'SM1', status: 'failed', lastErrorCode: '30005' }]), 'failed');
  const scheduled = {
    ...base,
    id: 'r2',
    templateKey: TEMPLATE_KEYS.REVIEW_REMINDER,
    idempotencyKey: 'booking.review_reminder:CD1-REVIEW-1:auto',
    availableAt: new Date(NOW + 48 * HOUR),
  };
  assert.equal(view([{ ...base, status: 'delivered', providerMessageSid: 'SM1' }, scheduled]), 'reminder_scheduled');
  assert.equal(view([base], {}, booking({ reviewRequest: { receivedAt: 'x' } })), 'review_received');
  assert.equal(view([base], {}, booking({ reviewRequest: { stoppedAt: 'x' } })), 'stopped');
  assert.equal(view([base], { optedOut: true }), 'opted_out');
  assert.equal(view([base], {}, booking({ completedAt: new Date(NOW - 15 * 24 * HOUR).toISOString() })), 'expired');
  assert.equal(view([], { ledgerAvailable: false }), 'unknown');

  const full = lifecycle.reviewLifecycleView(b, [{ ...base, providerMessageSid: 'SM1', providerStatus: 'queued' }], { now: NOW, env: ON_ENV });
  assert.equal(full.messages[0].stage, 'submitted');
  assert.equal(full.messages[0].deliveredAt, null, 'delivery is never inferred');
  assert.equal(JSON.stringify(full).includes('555'), false, 'no phone in the admin view');
});

test('admin status batch: one outbox query for all bookings, bounded parallel reads', async () => {
  const { reviewRequestStatusBatch } = require('../netlify/functions/admin-ops-jobs');
  const prisma = fakePrisma();
  let findManyCalls = 0;
  const inner = prisma.smsOutbox.findMany;
  prisma.smsOutbox.findMany = async (args) => { findManyCalls += 1; return inner(args); };
  let inFlight = 0;
  let peak = 0;
  const ids = Array.from({ length: 40 }, (_, i) => `CD1-BATCH-${i}`);
  const res = await reviewRequestStatusBatch({ bookingIds: [...ids, 'not-a-booking'] }, {
    prisma,
    env: BASE_ENV,
    now: NOW,
    loadBooking: async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return booking({ id, bookingId: id });
    },
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.statuses.length, 40);
  assert.equal(findManyCalls, 1);
  assert.ok(peak <= 8 && peak > 1, `peak ${peak}`);
  assert.deepEqual(body.program.blockers, ['a2p_campaign_not_verified', 'review_consent_not_established']);
  assert.equal(JSON.stringify(body).includes('555'), false);
});

test('the reminder template stays neutral', () => {
  const r = renderSmsTemplate(TEMPLATE_KEYS.REVIEW_REMINDER, { reviewUrl: GOOGLE });
  assert.equal(r.ok, true);
  assert.equal(r.body, `Cardetail1: Thanks again for choosing us. If you have a moment, we would appreciate an honest Google review: ${GOOGLE} Reply STOP or HELP`);
  assert.equal(r.segmentCount <= 2, true);
});
