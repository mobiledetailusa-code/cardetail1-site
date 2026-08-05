'use strict';

const crypto = require('crypto');
const { tryGetPrisma } = require('./prisma');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const { smsOutboxPolicy, outboundTwilioPolicy } = require('./twilio-runtime-policy');
const { renderSmsTemplate } = require('./sms-templates');
const { assertCustomerSmsConsent } = require('./sms-consent-service');
const { createTwilioProvider } = require('./twilio-provider');

const STATUS_RANK = Object.freeze({ accepted: 0, sent: 1, delivered: 2, failed: 2 });

function prismaClient(override) {
  return override || tryGetPrisma();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => {
    if (value[key] !== undefined) out[key] = canonical(value[key]);
    return out;
  }, {});
}

function payloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  return /^[A-Za-z0-9_.:-]{8,120}$/.test(key) ? key : '';
}

function safeOutboxLog(action, row, extra = {}) {
  console.info('[sms-outbox]', {
    action,
    outboxId: String(row?.id || '').slice(0, 16) || null,
    templateKey: String(row?.templateKey || '').slice(0, 64) || null,
    status: String(row?.status || extra.status || '').slice(0, 24) || null,
    errorCode: String(extra.errorCode || '').slice(0, 48) || null,
  });
}

function safeProviderErrorCode(err) {
  const raw = String(err?.code || err?.status || err?.statusCode || 'provider_error');
  return /^[A-Za-z0-9_.:-]{1,48}$/.test(raw) ? raw : 'provider_error';
}

async function enqueueSms(input = {}, opts = {}) {
  const env = opts.env || process.env;
  const policy = smsOutboxPolicy(env);
  if (!policy.ok) return { ok: true, queued: false, skipped: true, reason: policy.reason };
  const prisma = prismaClient(opts.prisma);
  if (!prisma?.smsOutbox) return { ok: false, error: 'sms_outbox_unavailable' };
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey) return { ok: false, error: 'invalid_idempotency_key' };
  const toE164 = normalizeUsPhoneE164(input.toE164 || input.to || '');
  if (!toE164) return { ok: false, error: 'invalid_sms_recipient' };
  const rendered = renderSmsTemplate(input.templateKey, input.templateData || {});
  if (!rendered.ok) return rendered;
  const audience = String(input.audience || 'customer').trim().toLowerCase();
  if (audience === 'customer') {
    const consent = await assertCustomerSmsConsent({
      customerAccountId: input.customerAccountId,
      toE164,
    }, { prisma });
    if (!consent.ok) {
      return { ok: true, queued: false, skipped: true, reason: consent.reason };
    }
  } else if (input.consentGranted !== true) {
    return { ok: true, queued: false, skipped: true, reason: 'sms_consent_required' };
  }
  const fingerprint = payloadHash({
    audience,
    bookingId: input.bookingId || null,
    customerAccountId: input.customerAccountId || null,
    toE164,
    templateKey: rendered.templateKey,
    templateVersion: rendered.templateVersion,
    templateData: input.templateData || {},
  });
  const existing = await prisma.smsOutbox.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.payloadHash !== fingerprint) {
      return { ok: false, error: 'sms_idempotency_conflict', statusCode: 409 };
    }
    return { ok: true, queued: true, idempotent: true, outbox: existing };
  }
  try {
    const outbox = await prisma.smsOutbox.create({
      data: {
        idempotencyKey,
        payloadHash: fingerprint,
        audience,
        bookingId: input.bookingId || null,
        customerAccountId: input.customerAccountId || null,
        toE164,
        templateKey: rendered.templateKey,
        templateVersion: rendered.templateVersion,
        templateData: canonical(input.templateData || {}),
        status: 'accepted',
        maxAttempts: Math.min(10, Math.max(1, Number(input.maxAttempts) || 5)),
      },
    });
    safeOutboxLog('accepted', outbox);
    return { ok: true, queued: true, outbox };
  } catch (err) {
    if (err?.code === 'P2002') {
      const raced = await prisma.smsOutbox.findUnique({ where: { idempotencyKey } });
      if (raced?.payloadHash === fingerprint) {
        return { ok: true, queued: true, idempotent: true, outbox: raced };
      }
      return { ok: false, error: 'sms_idempotency_conflict', statusCode: 409 };
    }
    return { ok: false, error: 'sms_outbox_write_failed' };
  }
}

function retryDelayMs(attemptCount) {
  const attempt = Math.max(1, Number(attemptCount) || 1);
  return Math.min(30 * 60_000, 30_000 * (2 ** (attempt - 1)));
}

function retryableProviderError(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  return [429, 500, 502, 503, 504].includes(status);
}

async function claimNextSms(prisma, now = new Date()) {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.smsOutbox.findMany({
      where: {
        status: 'accepted',
        providerMessageSid: null,
        availableAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
      take: 5,
    });
    for (const candidate of candidates) {
      const claimed = await tx.smsOutbox.updateMany({
        where: {
          id: candidate.id,
          status: 'accepted',
          providerMessageSid: null,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: {
          leaseToken,
          leaseExpiresAt,
          attemptCount: { increment: 1 },
        },
      });
      if (claimed?.count === 1) {
        return tx.smsOutbox.findUnique({ where: { id: candidate.id } });
      }
    }
    return null;
  });
}

function normalizeProviderStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['sent', 'sending'].includes(status)) return 'sent';
  if (['delivered', 'read'].includes(status)) return 'delivered';
  if (['failed', 'undelivered', 'canceled'].includes(status)) return 'failed';
  return 'accepted';
}

async function processClaimedSms(row, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  const rendered = renderSmsTemplate(row.templateKey, row.templateData || {});
  if (!rendered.ok) {
    const failed = await prisma.smsOutbox.update({
      where: { id: row.id },
      data: {
        status: 'failed',
        lastErrorCode: rendered.error,
        failedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    safeOutboxLog('failed', failed, { errorCode: rendered.error });
    return { ok: false, failed: true, outbox: failed };
  }
  const provider = opts.provider || createTwilioProvider(opts.env || process.env, opts.providerOptions);
  if (!provider.ok) return { ok: false, disabled: true, reason: provider.reason };
  try {
    const result = await provider.send({ to: row.toE164, body: rendered.body });
    if (!/^SM[a-zA-Z0-9]{32}$/.test(String(result.sid || ''))) {
      const error = new Error('provider_sid_missing');
      throw error;
    }
    const status = normalizeProviderStatus(result.status);
    const now = new Date();
    const outbox = await prisma.smsOutbox.update({
      where: { id: row.id },
      data: {
        providerMessageSid: result.sid,
        providerStatus: String(result.status || 'accepted').slice(0, 32),
        status,
        sentAt: ['sent', 'delivered'].includes(status) ? now : null,
        deliveredAt: status === 'delivered' ? now : null,
        failedAt: status === 'failed' ? now : null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: status === 'failed' ? 'provider_failed' : null,
      },
    });
    safeOutboxLog(status, outbox);
    return { ok: true, outbox };
  } catch (err) {
    const retryable = retryableProviderError(err) && row.attemptCount < row.maxAttempts;
    const now = new Date();
    const errorCode = safeProviderErrorCode(err);
    const outbox = await prisma.smsOutbox.update({
      where: { id: row.id },
      data: retryable
        ? {
          status: 'accepted',
          availableAt: new Date(now.getTime() + retryDelayMs(row.attemptCount)),
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: errorCode,
        }
        : {
          status: 'failed',
          failedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: errorCode,
        },
    });
    safeOutboxLog(retryable ? 'retry_scheduled' : 'failed', outbox, { errorCode });
    return { ok: false, retryable, outbox };
  }
}

async function processSmsOutbox(opts = {}) {
  const env = opts.env || process.env;
  const policy = outboundTwilioPolicy(env);
  if (!policy.ok) return { ok: true, disabled: true, reason: policy.reason, processed: 0 };
  const prisma = prismaClient(opts.prisma);
  if (!prisma?.smsOutbox || typeof prisma.$transaction !== 'function') {
    return { ok: false, error: 'sms_outbox_unavailable', processed: 0 };
  }
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 10));
  let processed = 0;
  const results = [];
  while (processed < limit) {
    const row = await claimNextSms(prisma, opts.now ? new Date(opts.now) : new Date());
    if (!row) break;
    results.push(await processClaimedSms(row, { ...opts, prisma, env }));
    processed += 1;
  }
  return { ok: true, processed, results };
}

async function applyStatusCallback({ providerMessageSid, providerStatus, errorCode }, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma?.smsOutbox) return { ok: false, error: 'sms_outbox_unavailable' };
  if (!/^SM[a-zA-Z0-9]{32}$/.test(String(providerMessageSid || ''))) {
    return { ok: false, error: 'invalid_message_sid', statusCode: 400 };
  }
  const nextStatus = normalizeProviderStatus(providerStatus);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await prisma.smsOutbox.findUnique({ where: { providerMessageSid } });
    if (!row) return { ok: false, error: 'message_not_found', statusCode: 404 };
    const currentStatus = row.status;
    const currentTerminal = ['delivered', 'failed'].includes(currentStatus);
    if (currentTerminal || STATUS_RANK[nextStatus] < STATUS_RANK[currentStatus]) {
      return { ok: true, unchanged: true, outbox: row };
    }
    const now = new Date();
    const updated = await prisma.smsOutbox.updateMany({
      where: { id: row.id, status: currentStatus },
      data: {
        status: nextStatus,
        providerStatus: String(providerStatus || '').slice(0, 32),
        lastErrorCode: errorCode ? safeProviderErrorCode({ code: errorCode }) : row.lastErrorCode,
        sentAt: ['sent', 'delivered'].includes(nextStatus) ? (row.sentAt || now) : row.sentAt,
        deliveredAt: nextStatus === 'delivered' ? now : row.deliveredAt,
        failedAt: nextStatus === 'failed' ? now : row.failedAt,
      },
    });
    if (updated.count === 1) {
      const outbox = await prisma.smsOutbox.findUnique({ where: { id: row.id } });
      safeOutboxLog('status_callback', outbox, { status: nextStatus, errorCode });
      return { ok: true, outbox };
    }
  }
  return { ok: false, error: 'status_update_conflict', statusCode: 503 };
}

module.exports = {
  STATUS_RANK,
  payloadHash,
  normalizeIdempotencyKey,
  retryDelayMs,
  retryableProviderError,
  safeProviderErrorCode,
  normalizeProviderStatus,
  enqueueSms,
  claimNextSms,
  processClaimedSms,
  processSmsOutbox,
  applyStatusCallback,
};
