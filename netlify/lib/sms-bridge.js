'use strict';

const { tryGetPrisma } = require('./prisma');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const { enabled } = require('./twilio-runtime-policy');
const smsOutbox = require('./sms-outbox');
const { TEMPLATE_KEYS, asciiSms } = require('./sms-templates');
const { isSmsRevokedByPhone } = require('./sms-consent-service');

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const OWNER_REPLY_WINDOW_MS = 48 * 60 * 60 * 1000;
const MISSED_DIAL = new Set(['busy', 'no-answer', 'failed', 'canceled']);

function prismaClient(override) {
  return override || tryGetPrisma();
}

function enqueueSmsFn(opts) {
  return opts.enqueueSms || smsOutbox.enqueueSms;
}

function kickFn(opts) {
  return opts.kickSmsOutboxByIds || smsOutbox.kickSmsOutboxByIds;
}

function last4FromE164(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

function adminE164(env = process.env) {
  return normalizeUsPhoneE164(env.ADMIN_SMS || '');
}

function samePhone(a, b) {
  const left = normalizeUsPhoneE164(a);
  const right = normalizeUsPhoneE164(b);
  return !!(left && right && left === right);
}

function inboundPreview(body, numMedia) {
  const text = asciiSms(body).slice(0, 400);
  const media = Number(numMedia) || 0;
  if (text) return media > 0 ? `${text} [MMS]` : text;
  if (media > 0) return 'Customer sent a photo or video (MMS).';
  return '';
}

function parseOwnerReply(body) {
  const raw = String(body || '').trim();
  const prefixed = /^(\d{4})(?:\s+|:)([\s\S]+)$/.exec(raw);
  if (prefixed) return { last4: prefixed[1], body: asciiSms(prefixed[2]).slice(0, 400) };
  return { last4: '', body: asciiSms(raw).slice(0, 400) };
}

async function recordMessage(prisma, threadId, direction, providerSid, bodyPreview) {
  const sid = String(providerSid || '').trim();
  try {
    await prisma.smsBridgeMessage.create({
      data: {
        threadId,
        direction,
        providerSid: sid || null,
        bodyPreview: String(bodyPreview || '').slice(0, 480),
      },
    });
  } catch (err) {
    if (err?.code === 'P2002') return { ok: true, duplicate: true };
    throw err;
  }
  return { ok: true };
}

async function upsertCustomerThread(prisma, customerE164, now) {
  const last4 = last4FromE164(customerE164);
  if (!last4) return null;
  return prisma.smsBridgeThread.upsert({
    where: { customerE164 },
    create: { customerE164, last4, lastInboundAt: now },
    update: { lastInboundAt: now, last4 },
  });
}

async function findOwnerTarget(prisma, parsed, now) {
  const since = new Date(now.getTime() - OWNER_REPLY_WINDOW_MS);
  if (parsed.last4) {
    const exact = await prisma.smsBridgeThread.findFirst({
      where: { last4: parsed.last4, lastInboundAt: { gte: since } },
      orderBy: { lastInboundAt: 'desc' },
    });
    if (exact) return exact;
  }
  return prisma.smsBridgeThread.findFirst({
    where: { lastInboundAt: { gte: since } },
    orderBy: { lastInboundAt: 'desc' },
  });
}

async function kickQueued(ids, opts) {
  if (!ids.length) return;
  try {
    await kickFn(opts)(ids, opts);
  } catch {
    // Scheduled worker remains the retry authority.
  }
}

async function notifyAdmin(templateKey, templateData, idempotencyKey, opts) {
  const env = opts.env || process.env;
  if (!enabled(env.ADMIN_SMS_CONSENT_GRANTED)) {
    return { ok: true, queued: false, skipped: true, reason: 'admin_sms_consent_required' };
  }
  const toE164 = adminE164(env);
  if (!toE164) {
    return { ok: true, queued: false, skipped: true, reason: 'admin_sms_destination_missing' };
  }
  const key = smsOutbox.smsSafeIdempotencyKey(idempotencyKey);
  if (!key) return { ok: false, error: 'invalid_idempotency_key' };
  const queued = await enqueueSmsFn(opts)({
    idempotencyKey: key,
    audience: 'admin',
    consentGranted: true,
    toE164,
    templateKey,
    templateData,
  }, opts);
  if (queued.ok && queued.queued && queued.outbox?.id) {
    await kickQueued([queued.outbox.id], opts);
  }
  return queued;
}

async function processCustomerInbound(params, opts) {
  const prisma = prismaClient(opts.prisma);
  const from = normalizeUsPhoneE164(params.From);
  const preview = inboundPreview(params.Body, params.NumMedia);
  if (!prisma?.smsBridgeThread) return { ok: false, statusCode: 503, error: 'bridge_store_unavailable' };
  if (!from) return { ok: true, skipped: true, reason: 'invalid_from' };
  if (!preview) return { ok: true, skipped: true, reason: 'empty_inbound' };
  const now = opts.now ? new Date(opts.now) : new Date();
  const thread = await upsertCustomerThread(prisma, from, now);
  if (!thread) return { ok: false, statusCode: 503, error: 'thread_unavailable' };
  await recordMessage(prisma, thread.id, 'inbound_customer', params.MessageSid || params.SmsSid, preview);
  const queued = await notifyAdmin(
    TEMPLATE_KEYS.ADMIN_INBOUND_SMS,
    { last4: thread.last4, body: preview },
    `admin.bridge.inbound:${String(params.MessageSid || params.SmsSid || '').slice(0, 40)}`,
    opts,
  );
  return { ok: true, role: 'customer', threadId: thread.id, queued };
}

async function processOwnerReply(params, opts) {
  const prisma = prismaClient(opts.prisma);
  const parsed = parseOwnerReply(params.Body);
  if (!parsed.body && !(Number(params.NumMedia) > 0)) {
    return { ok: true, skipped: true, reason: 'empty_owner_reply' };
  }
  if (!prisma?.smsBridgeThread) return { ok: false, statusCode: 503, error: 'bridge_store_unavailable' };
  const now = opts.now ? new Date(opts.now) : new Date();
  const thread = await findOwnerTarget(prisma, parsed, now);
  if (!thread) return { ok: true, skipped: true, reason: 'no_active_thread' };
  const stop = await isSmsRevokedByPhone(thread.customerE164, opts);
  if (!stop.ok || stop.revoked) {
    return { ok: true, skipped: true, reason: stop.revoked ? 'customer_opted_out' : 'consent_check_failed' };
  }
  const body = parsed.body || inboundPreview('', params.NumMedia);
  const key = smsOutbox.smsSafeIdempotencyKey(
    `bridge.customer.reply:${String(params.MessageSid || params.SmsSid || '').slice(0, 40)}`,
  );
  if (!key) return { ok: false, error: 'invalid_idempotency_key' };
  const queued = await enqueueSmsFn(opts)({
    idempotencyKey: key,
    audience: 'bridge',
    consentGranted: true,
    toE164: thread.customerE164,
    templateKey: TEMPLATE_KEYS.CUSTOMER_BRIDGE_REPLY,
    templateData: { body },
  }, opts);
  if (queued.ok && queued.queued && queued.outbox?.id) {
    await prisma.smsBridgeThread.update({
      where: { id: thread.id },
      data: { lastOwnerAt: now },
    });
    await recordMessage(prisma, thread.id, 'outbound_customer', params.MessageSid || params.SmsSid, body);
    await kickQueued([queued.outbox.id], opts);
  }
  return { ok: true, role: 'owner', threadId: thread.id, queued };
}

async function handleInboundSms(params = {}, opts = {}) {
  const env = opts.env || process.env;
  const from = normalizeUsPhoneE164(params.From);
  const owner = adminE164(env);
  if (owner && from && from === owner) {
    return processOwnerReply(params, { ...opts, env });
  }
  return processCustomerInbound(params, { ...opts, env });
}

async function handleMissedCall(params = {}, opts = {}) {
  const dialStatus = String(params.DialCallStatus || '').trim().toLowerCase();
  if (!MISSED_DIAL.has(dialStatus)) {
    return { ok: true, skipped: true, reason: 'not_missed' };
  }
  const prisma = prismaClient(opts.prisma);
  const callSid = String(params.CallSid || params.ParentCallSid || '').trim();
  const fromLast4 = last4FromE164(params.From || params.Caller);
  if (!prisma?.voiceBridgeCall) return { ok: false, statusCode: 503, error: 'bridge_store_unavailable' };
  if (!callSid || !fromLast4) return { ok: true, skipped: true, reason: 'invalid_call' };
  try {
    await prisma.voiceBridgeCall.create({
      data: { callSid, fromLast4, dialStatus, notified: false },
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      const existing = await prisma.voiceBridgeCall.findUnique({ where: { callSid } });
      if (existing?.notified) return { ok: true, skipped: true, reason: 'already_notified' };
    } else {
      return { ok: false, statusCode: 503, error: 'call_record_failed' };
    }
  }
  const queued = await notifyAdmin(
    TEMPLATE_KEYS.ADMIN_MISSED_CALL,
    { last4: fromLast4 },
    `admin.bridge.missed:${callSid.slice(0, 40)}`,
    opts,
  );
  if (queued.ok) {
    await prisma.voiceBridgeCall.updateMany({
      where: { callSid, notified: false },
      data: { notified: true, dialStatus },
    });
  }
  return { ok: true, queued, dialStatus };
}

module.exports = {
  EMPTY_TWIML,
  OWNER_REPLY_WINDOW_MS,
  last4FromE164,
  adminE164,
  samePhone,
  inboundPreview,
  parseOwnerReply,
  handleInboundSms,
  handleMissedCall,
};
