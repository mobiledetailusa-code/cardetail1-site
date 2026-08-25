#!/usr/bin/env node
'use strict';

/**
 * Read-only Production notification pipeline audit.
 *
 * Usage:
 *   node scripts/notification-pipeline-audit.js
 *   node scripts/notification-pipeline-audit.js --send-admin-email
 *   node scripts/notification-pipeline-audit.js --booking-id CD1-XXXX
 *
 * Never mutates bookings, consent, outbox rows, or payment state.
 * --send-admin-email sends ONE synthetic owner email to ADMIN_EMAIL only.
 */

const { Pool } = require('pg');
const {
  envPresence,
  emailContractSnapshot,
  sendSyntheticAdminEmail,
  prepareControlledOwnerSms,
  maskEmail,
  maskPhone,
  LEGACY_GMAIL,
} = require('../netlify/lib/notification-qa');

function argFlag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return '';
  return String(process.argv[i + 1] || '').trim();
}

function isTestLike(payload = {}, id = '') {
  const blob = JSON.stringify({
    id,
    firstName: payload.firstName,
    lastName: payload.lastName,
    notes: payload.notes,
    source: payload.source,
    email: payload.email,
  }).toLowerCase();
  return !!(
    payload.isTest ||
    payload.testBooking ||
    payload.archived ||
    /(?:^|[^a-z])(?:test|qa|smoke|demo|synthetic)(?:[^a-z]|$)/i.test(blob)
  );
}

async function loadRecentBookings(pool, { bookingId, limit = 40 } = {}) {
  if (bookingId) {
    const one = await pool.query(
      `SELECT id, "createdAt", "updatedAt", "preferredDate", "paymentStatus", "jobStatus",
              email, phone, payload
       FROM "BookingRecord" WHERE id = $1 LIMIT 1`,
      [bookingId]
    );
    return one.rows;
  }
  const recent = await pool.query(
    `SELECT id, "createdAt", "updatedAt", "preferredDate", "paymentStatus", "jobStatus",
            email, phone, payload
     FROM "BookingRecord"
     ORDER BY "createdAt" DESC
     LIMIT $1`,
    [limit]
  );
  return recent.rows;
}

async function loadOutboxForBooking(pool, bookingId) {
  const res = await pool.query(
    `SELECT id, "idempotencyKey", audience, "bookingId", "templateKey", status,
            "providerMessageSid", "providerStatus", "attemptCount", "maxAttempts",
            "availableAt", "lastErrorCode", "acceptedAt", "sentAt", "deliveredAt",
            "failedAt", "createdAt", "updatedAt", "toE164"
     FROM "SmsOutbox"
     WHERE "bookingId" = $1
     ORDER BY "createdAt" ASC`,
    [bookingId]
  );
  return res.rows.map((row) => ({
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    audience: row.audience,
    templateKey: row.templateKey,
    status: row.status,
    providerMessageSid: row.providerMessageSid,
    providerStatus: row.providerStatus,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    lastErrorCode: row.lastErrorCode,
    acceptedAt: row.acceptedAt,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    failedAt: row.failedAt,
    createdAt: row.createdAt,
    toMasked: maskPhone(row.toE164),
  }));
}

function summarizeBooking(row) {
  const p = row.payload || {};
  const delivery = p.notificationDelivery || null;
  const consent = p.transactionalSmsConsentAccepted
    ?? p.transactionalSmsConsent?.accepted
    ?? p.smsConsent
    ?? null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    preferredDate: row.preferredDate || p.preferredDate || null,
    preferredTime: p.preferredTime || p.confirmedTimeWindow || null,
    package: p.package || p.service || null,
    paymentStatus: row.paymentStatus || p.paymentStatus || null,
    jobStatus: row.jobStatus || p.jobStatus || null,
    emailMasked: maskEmail(row.email || p.email),
    phoneMasked: maskPhone(row.phone || p.phone),
    customerAccountId: p.customerAccountId || null,
    totalPrice: p.totalPrice ?? p.approvedFinalAmount ?? null,
    testLike: isTestLike(p, row.id),
    transactionalSmsConsentAccepted: consent,
    notificationDelivery: delivery,
  };
}

function stageVerdict(delivery, channel) {
  const cur = delivery && delivery[channel];
  if (!cur) return 'UNKNOWN';
  if (cur.status === 'sent' || cur.status === 'delivered' || cur.status === 'accepted') return 'YES';
  if (cur.status === 'suppressed') return 'BLOCKED BY POLICY_OR_CONSENT_OR_CONFIG';
  if (cur.status === 'failed') return 'YES_BUT_FAILED';
  if (cur.status === 'pending') return 'NO';
  return 'UNKNOWN';
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    productionShaHint: 'confirm via Netlify published_deploy.commit_ref',
    emailContract: emailContractSnapshot(process.env),
    twilioEnv: envPresence(process.env),
    legacyGmailLiteral: LEGACY_GMAIL,
    firstRealBooking: null,
    outbox: [],
    timeline: null,
    syntheticEmail: null,
    controlledSmsPrepare: prepareControlledOwnerSms({ env: process.env }),
    safety: {
      realBookingChanged: false,
      customerContacted: false,
      realSmsSent: false,
    },
  };

  const dbUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    report.db = { ok: false, error: 'database_url_missing' };
  } else {
    const pool = new Pool({
      connectionString: dbUrl,
      ssl: /localhost|127\.0\.0\.1/.test(dbUrl) ? false : { rejectUnauthorized: false },
    });
    try {
      const bookingId = argValue('--booking-id');
      const rows = await loadRecentBookings(pool, { bookingId, limit: 50 });
      const candidates = rows.map(summarizeBooking);
      const real = candidates.find((b) => !b.testLike) || null;
      report.bookingCandidates = candidates.slice(0, 10).map((b) => ({
        id: b.id,
        createdAt: b.createdAt,
        testLike: b.testLike,
        package: b.package,
        notificationDelivery: b.notificationDelivery,
        transactionalSmsConsentAccepted: b.transactionalSmsConsentAccepted,
      }));
      report.firstRealBooking = real;
      if (real) {
        report.outbox = await loadOutboxForBooking(pool, real.id);
        const d = real.notificationDelivery || {};
        report.timeline = {
          BOOKING_CREATED: 'YES',
          ADMIN_EMAIL_EVENT_GENERATED: stageVerdict(d, 'adminEmail'),
          CUSTOMER_EMAIL_EVENT_GENERATED: stageVerdict(d, 'customerEmail'),
          ADMIN_SMS_EVENT_GENERATED: stageVerdict(d, 'adminSms'),
          CUSTOMER_SMS_EVENT_GENERATED: stageVerdict(d, 'customerSms'),
          TWILIO_OUTBOX_ENTRY_CREATED: report.outbox.length ? 'YES' : 'NO',
          WORKER_SAW_ENTRY: report.outbox.some((o) => o.attemptCount > 0 || o.sentAt || o.failedAt)
            ? 'YES'
            : (report.outbox.length ? 'UNKNOWN' : 'NO'),
          PROVIDER_SEND_ATTEMPT: report.outbox.some((o) => o.providerMessageSid || o.sentAt)
            ? 'YES'
            : 'NO',
          TWILIO_MESSAGE_SID: report.outbox.some((o) => o.providerMessageSid) ? 'YES' : 'NO',
          DELIVERY_CALLBACK: report.outbox.some((o) => o.providerStatus) ? 'YES' : 'UNKNOWN',
          DELIVERED_FAILED_SUPPRESSED: report.outbox.map((o) => ({
            id: o.id,
            audience: o.audience,
            status: o.status,
            providerStatus: o.providerStatus,
            lastErrorCode: o.lastErrorCode,
          })),
        };
      }
      report.db = { ok: true };
    } finally {
      await pool.end();
    }
  }

  if (argFlag('--send-admin-email')) {
    report.syntheticEmail = await sendSyntheticAdminEmail({ env: process.env });
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  process.exit(1);
});
