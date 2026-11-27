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

// ---------------------------------------------------------------------------

test('send window is 10:00-18:00 America/New_York, Monday to Saturday', () => {
  assert.equal(lifecycle.isWithinSendWindow(Date.parse('2026-11-24T15:00:00Z')), true); // Tue 10:00
  assert.equal(lifecycle.isWithinSendWindow(Date.parse('2026-11-24T14:59:00Z')), false); // Tue 09:59
  assert.equal(lifecycle.isWithinSendWindow(Date.parse('2026-11-24T23:00:00Z')), false); // Tue 18:00
  assert.equal(lifecycle.isWithinSendWindow(Date.parse('2026-11-29T16:00:00Z')), false); // Sunday 11:00
  // Saturday 18:30 ET -> Monday 10:00 ET.
  assert.equal(
    lifecycle.nextSendWindowStart(Date.parse('2026-11-28T23:30:00Z')).toISOString(),
    '2026-11-30T15:00:00.000Z',
  );
  // Summer (EDT, UTC-4): Monday 09:00 EDT -> 10:00 EDT.
  assert.equal(
    lifecycle.nextSendWindowStart(Date.parse('2026-07-06T13:00:00Z')).toISOString(),
    '2026-07-06T14:00:00.000Z',
  );
});

test('defaults: every follow-up gate is closed and the blockers are reported', async () => {
  assert.deepEqual(lifecycle.programBlockers(BASE_ENV), ['a2p_campaign_not_verified', 'review_consent_not_established']);
  const prisma = fakePrisma();
  const res = await notifyIfServiceClosedAndPaid(booking(), { prisma, env: BASE_ENV, now: NOW });
  assert.equal(res.queued, true);
  assert.equal(res.reviewLinkIncluded, true, 'existing completion text unchanged');
  assert.equal(res.reminder.reason, 'automation_disabled');
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER).length, 0);
  const manual = await lifecycle.manualResend(booking(), { prisma, env: BASE_ENV, now: NOW });
  assert.equal(manual.queued, false);
  assert.equal(manual.reason, 'manual_resend_disabled');
});

test('switches on but no verified consent version: still no reminder', async () => {
  const prisma = fakePrisma();
  const env = { ...ON_ENV, REVIEW_SOLICITATION_CONSENT_VERSIONS: '' };
  const res = await notifyIfServiceClosedAndPaid(booking(), { prisma, env, now: NOW });
  assert.equal(res.reminder.queued, false);
  assert.equal(res.reminder.reason, 'review_consent_not_established');
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER).length, 0);

  const legacy = booking({
    transactionalSmsConsent: { ...booking().transactionalSmsConsent, textVersion: 'dz-txn-sms-v2-2026-08-22' },
  });
  const res2 = await notifyIfServiceClosedAndPaid({ ...legacy, id: 'CD1-REVIEW-2', bookingId: 'CD1-REVIEW-2' }, { prisma, env: ON_ENV, now: NOW });
  assert.equal(res2.reminder.reason, 'consent_version_not_covered');
});

test('enabled: one reminder ~48 h later inside the window, idempotent across calls and paths', async () => {
  const prisma = fakePrisma();
  const b = booking();
  const first = await notifyIfServiceClosedAndPaid(b, { prisma, env: ON_ENV, now: NOW });
  assert.equal(first.reminder.queued, true);
  const reminder = rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER);
  assert.equal(reminder.length, 1);
  assert.equal(reminder[0].idempotencyKey, 'booking.review_reminder:CD1-REVIEW-1:auto');
  const at = toMs(reminder[0].availableAt);
  assert.ok(at >= toMs(b.completedAt) + 48 * HOUR);
  assert.ok(lifecycle.isWithinSendWindow(at));
  assert.equal(reminder[0].templateData.reviewUrl, GOOGLE);

  // Repeated completion events (second webhook, QuickOps close, admin approve).
  await notifyIfServiceClosedAndPaid(b, { prisma, env: ON_ENV, now: NOW + 60_000 });
  await notifyReviewRequested(b, { prisma, env: ON_ENV, now: NOW + 120_000, verifiedPhoneE164: null });
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER).length, 1);
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.SERVICE_COMPLETED).length, 1);
  assert.equal(rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REQUESTED).length, 0, 'no second initial ask');
});

test('tech path asked first: the paid completion text keeps the receipt and drops the review link', async () => {
  const prisma = fakePrisma();
  const pending = booking({ jobStatus: 'completed_pending_admin_review', paymentStatus: 'unpaid', ledger: { settledCents: 0 } });
  const asked = await notifyReviewRequested(pending, { prisma, env: BASE_ENV, now: NOW, verifiedPhoneE164: null });
  assert.equal(asked.queued, true);
  const res = await notifyIfServiceClosedAndPaid(booking(), { prisma, env: BASE_ENV, now: NOW + 1000 });
  assert.equal(res.queued, true);
  assert.equal(res.reviewLinkIncluded, false);
  const receipt = rowsOf(prisma, TEMPLATE_KEYS.SERVICE_COMPLETED)[0];
  assert.match(receipt.templateData.receiptUrl, /receipt\.html\?bookingId=CD1-REVIEW-1/);
  assert.equal(receipt.templateData.reviewUrl, '');
  const body = renderSmsTemplate(TEMPLATE_KEYS.SERVICE_COMPLETED, receipt.templateData).body;
  assert.match(body, /View your receipt/);
  assert.doesNotMatch(body, /Google review/i);
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
  // The initial text reached Twilio.
  await prisma.smsOutbox.update({
    where: { id: initial.id },
    data: { providerMessageSid: 'SM' + 'a'.repeat(32), status: 'sent', sentAt: new Date(NOW) },
  });
  const reminder = rowsOf(prisma, TEMPLATE_KEYS.REVIEW_REMINDER)[0];
  return { prisma, reminder, dueAt: toMs(reminder.availableAt) };
}

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

test('dispatch: an eligible reminder goes out once, with neutral wording', async () => {
  const { prisma, reminder, dueAt } = await scheduledReminder();
  const { provider, row } = await dispatch(prisma, reminder, { now: dueAt, bookingState: booking() });
  assert.equal(provider.sent.length, 1);
  assert.match(provider.sent[0].body, /^Cardetail1: Thanks again for choosing us\./);
  assert.match(provider.sent[0].body, /honest Google review: https:\/\/g\.page\/r\/CTJwfJerrQeCEAI\/review/);
  assert.match(provider.sent[0].body, /Reply STOP or HELP$/);
  assert.doesNotMatch(provider.sent[0].body, /discount|free|gift|coupon|reward|5[- ]star|five[- ]star/i);
  assert.ok(row.providerMessageSid);
  // A worker retry of the same slot finds nothing left to send.
  const again = await lifecycle.followUpEligibility(booking(), rowsOf(prisma), { kind: 'auto', now: dueAt + HOUR, env: ON_ENV });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'automatic_cap_reached');
});

test('dispatch cancels when stopped, received, first-party review, STOP, expired or switched off', async () => {
  const cases = [
    ['stopped', () => booking({ reviewRequest: { stoppedAt: new Date(NOW).toISOString() } }), ON_ENV],
    ['review_received', () => booking({ reviewRequest: { receivedAt: new Date(NOW).toISOString() } }), ON_ENV],
    ['review_received', () => booking({ review: { reviewId: 'r1', stars: 5, submittedAt: new Date(NOW).toISOString() } }), ON_ENV],
    ['automation_disabled', () => booking(), { ...ON_ENV, REVIEW_REMINDER_AUTOMATION_ENABLED: '' }],
    ['a2p_campaign_not_verified', () => booking(), { ...ON_ENV, REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED: '' }],
    ['service_issue_open', () => booking({ jobStatus: 'issue_reported' }), ON_ENV],
  ];
  for (const [reason, state, env] of cases) {
    const { prisma, reminder, dueAt } = await scheduledReminder();
    const { provider, row } = await dispatch(prisma, reminder, { now: dueAt, bookingState: state, env });
    assert.equal(provider.sent.length, 0, reason);
    assert.equal(row.status, 'failed', reason);
    assert.equal(row.lastErrorCode, `review_cancelled_${reason}`, reason);
  }

  const { prisma, reminder } = await scheduledReminder();
  const late = NOW + 15 * 24 * HOUR;
  const expired = await dispatch(prisma, reminder, { now: late, bookingState: booking() });
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
  assert.ok(sunday > dueAt);
  const deferred = await dispatch(prisma, reminder, { now: sunday, bookingState: booking() });
  assert.equal(deferred.provider.sent.length, 0);
  assert.equal(deferred.row.status, 'accepted');
  assert.equal(deferred.row.attemptCount, 0);
  assert.equal(new Date(deferred.row.availableAt).toISOString(), '2026-11-30T15:00:00.000Z');

  let row = deferred.row;
  for (let i = 0; i < 5; i += 1) {
    const out = await dispatch(prisma, row, {
      now: dueAt,
      bookingState: () => { throw new Error('blobs down'); },
    });
    assert.equal(out.provider.sent.length, 0);
    row = out.row;
  }
  assert.equal(row.status, 'failed');
  assert.equal(row.lastErrorCode, 'review_cancelled_gate_unavailable');
});

test('owner marks cancel pending reminders; a leased row is left to the dispatch check', async () => {
  const { prisma, reminder } = await scheduledReminder();
  const res = await lifecycle.cancelPendingFollowUps('CD1-REVIEW-1', 'review_received', { prisma, now: NOW });
  assert.equal(res.cancelled, 1);
  const row = await prisma.smsOutbox.findUnique({ where: { id: reminder.id } });
  assert.equal(row.status, 'failed');
  assert.equal(row.lastErrorCode, 'review_cancelled_review_received');

  const second = await scheduledReminder();
  await second.prisma.smsOutbox.update({
    where: { id: second.reminder.id },
    data: { leaseExpiresAt: new Date(NOW + 60_000) },
  });
  const leased = await lifecycle.cancelPendingFollowUps('CD1-REVIEW-1', 'stopped', { prisma: second.prisma, now: NOW });
  assert.equal(leased.cancelled, 0);
});

test('manual resend: one per booking, 24 h cooldown, total cap of three', async () => {
  const { prisma, reminder, dueAt } = await scheduledReminder();
  await dispatch(prisma, reminder, { now: dueAt, bookingState: booking() });
  // Mark the reminder as sent at dueAt so the cooldown runs from there.
  await prisma.smsOutbox.update({ where: { id: reminder.id }, data: { status: 'sent', sentAt: new Date(dueAt) } });

  const soon = await lifecycle.manualResend(booking(), { prisma, env: ON_ENV, now: dueAt + HOUR });
  assert.equal(soon.queued, true);
  assert.ok(toMs(soon.scheduledFor) >= dueAt + 24 * HOUR, 'held until the cooldown ends');
  assert.ok(lifecycle.isWithinSendWindow(toMs(soon.scheduledFor)));

  const twice = await lifecycle.manualResend(booking(), { prisma, env: ON_ENV, now: dueAt + 2 * HOUR });
  assert.equal(twice.queued, false);
  assert.equal(twice.reason, 'manual_resend_already_used');
  assert.equal(lifecycle.slotCounts(rowsOf(prisma), dueAt).total, 3);
});

test('an initial review_requested row is cancelled at dispatch when the completion text already asked', async () => {
  const prisma = fakePrisma();
  await notifyIfServiceClosedAndPaid(booking(), { prisma, env: BASE_ENV, now: NOW });
  const dup = await prisma.smsOutbox.create({
    data: {
      idempotencyKey: 'booking.review_requested:CD1-REVIEW-1',
      audience: 'customer',
      bookingId: 'CD1-REVIEW-1',
      toE164: '+12015550142',
      templateKey: TEMPLATE_KEYS.REVIEW_REQUESTED,
      templateData: { url: 'https://cardetail1.com/reviews' },
    },
  });
  const { provider, row } = await dispatch(prisma, dup, { now: NOW, bookingState: booking(), env: BASE_ENV });
  assert.equal(provider.sent.length, 0);
  assert.equal(row.lastErrorCode, 'review_cancelled_duplicate_initial');
});

test('admin view distinguishes queued, submitted, delivered and the terminal states', () => {
  const b = booking();
  const base = {
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
  assert.equal(view([base]), 'queued');
  assert.equal(view([{ ...base, providerMessageSid: 'SM1', providerStatus: 'queued' }]), 'sent');
  assert.equal(view([{ ...base, providerMessageSid: 'SM1', status: 'sent' }]), 'sent');
  assert.equal(view([{ ...base, providerMessageSid: 'SM1', status: 'delivered', deliveredAt: new Date(NOW) }]), 'delivered');
  assert.equal(view([{ ...base, status: 'failed', lastErrorCode: '30005' }]), 'failed');
  const scheduled = {
    ...base,
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

test('the reminder template renders for every template enumeration and stays neutral', () => {
  const r = renderSmsTemplate(TEMPLATE_KEYS.REVIEW_REMINDER, { reviewUrl: GOOGLE });
  assert.equal(r.ok, true);
  assert.equal(r.body, `Cardetail1: Thanks again for choosing us. If you have a moment, we would appreciate an honest Google review: ${GOOGLE} Reply STOP or HELP`);
  assert.equal(r.segmentCount <= 2, true);
});
