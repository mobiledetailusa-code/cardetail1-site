'use strict';

const { getBookingRecord, commitBooking } = require('./booking-repository');
const { buildNextAggregate } = require('./booking-aggregate');
const { appendEventLog } = require('./ops-workflow');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const { assignmentFromBooking, bookingStatus, jobCompleted } = require('./admin-quick-ops-view');
const { enqueueSms, kickSmsOutboxByIds, smsSafeIdempotencyKey } = require('./sms-outbox');
const { TEMPLATE_KEYS, smsDateLabel, smsServiceLabel } = require('./sms-templates');
const {
  createTechQuickOpsToken,
  revokeTechQuickOpsToken,
} = require('./tech-quick-ops-token');

let rosterOverride = null;

function setQuickOpsTechRoster(loader) {
  rosterOverride = typeof loader === 'function' ? loader : null;
}

function resetQuickOpsTechRoster() {
  rosterOverride = null;
}

function techIdOf(tech) {
  return String(tech && (tech.techId || tech.id) || '').trim();
}

function techNameOf(tech) {
  return String(tech && (tech.fullName || tech.name) || '').trim() || 'Technician';
}

async function loadTechRecords() {
  if (rosterOverride) return rosterOverride() || [];
  const { blobsStore, listAllBlobs, fetchBlobRecords } = require('./tech-security');
  const store = await blobsStore('cd1-tech-accounts');
  const blobs = await listAllBlobs(store, 'cd1-tech-accounts');
  const techBlobs = blobs.filter((blob) => String(blob.key || '').startsWith('tech-'));
  const records = await fetchBlobRecords(store, techBlobs, 15);
  return records.filter((row) => row && typeof row === 'object');
}

function activeTechs(records) {
  return (records || []).filter((tech) => tech && tech.active !== false && techIdOf(tech));
}

async function listAssignableTechs() {
  const records = activeTechs(await loadTechRecords());
  return records
    .map((tech) => ({
      techId: techIdOf(tech),
      fullName: techNameOf(tech),
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function jobWindowRaw(booking) {
  return String(
    booking.confirmedTimeWindow
    || booking.confirmedWindow
    || booking.preferredArrivalWindow
    || booking.preferredTime
    || ''
  ).trim();
}

function jobPlaceLabel(booking) {
  const address = String(booking.address || booking.serviceAddress || '').replace(/\s+/g, ' ').trim();
  if (address) return address.slice(0, 48);
  return String(booking.city || '').replace(/\s+/g, ' ').trim().slice(0, 32);
}

function notificationFromKick(kick, queued) {
  const results = kick && Array.isArray(kick.results) ? kick.results : [];
  const hit = results.find((row) => row && row.outbox);
  const outbox = hit && hit.outbox;
  const status = outbox && outbox.status;
  const sid = outbox && outbox.providerMessageSid;
  if (sid && ['accepted', 'sent', 'delivered'].includes(status)) {
    return { notification: 'sent', reason: null };
  }
  const suppressed = (hit && hit.reason === 'suppressed')
    || (outbox && outbox.lastErrorCode === 'suppressed');
  if (suppressed) return { notification: 'failed', reason: 'suppressed' };
  const reason = (hit && (hit.reason || hit.error))
    || (kick && (kick.reason || kick.error))
    || (queued && (queued.reason || queued.error))
    || 'not_sent';
  return { notification: 'failed', reason };
}

function notifyMessage(notification) {
  return notification === 'sent'
    ? 'Assigned — notification sent'
    : 'Assigned — notification failed';
}

/**
 * Admin assignment is one transactional job text. It is sent in this request.
 * Auction invites still require the technician SMS checkbox; this dispatch does not.
 */
async function textTech({ booking, toE164, url, idempotencyKey, prisma, env, provider }) {
  if (!toE164) {
    return { ok: true, queued: false, sent: false, skipped: true, notification: 'failed', reason: 'invalid_sms_recipient' };
  }
  let queued;
  try {
    queued = await enqueueSms({
      idempotencyKey: smsSafeIdempotencyKey(idempotencyKey),
      audience: 'technician',
      consentGranted: true,
      toE164,
      bookingId: booking.id || booking.bookingId,
      templateKey: TEMPLATE_KEYS.TECH_JOB_LINK,
      templateData: {
        service: smsServiceLabel(booking),
        date: smsDateLabel(booking.confirmedDate || booking.preferredDate || ''),
        window: jobWindowRaw(booking),
        place: jobPlaceLabel(booking),
        url,
      },
    }, { prisma, env });
  } catch (err) {
    return { ok: false, queued: false, sent: false, error: 'sms_failed', reason: String(err && err.message || err).slice(0, 80) };
  }
  const outboxId = queued && queued.outbox && queued.outbox.id;
  if (!queued || !queued.queued || !outboxId) {
    return { ...queued, sent: false, notification: 'failed', reason: (queued && (queued.reason || queued.error)) || 'not_queued' };
  }
  let kick = null;
  try {
    kick = await kickSmsOutboxByIds([outboxId], { prisma, env, provider });
  } catch (err) {
    kick = { ok: false, error: 'kick_failed', reason: String(err && err.message || err).slice(0, 80) };
  }
  const outcome = notificationFromKick(kick, queued);
  return {
    ...queued,
    kick,
    sent: outcome.notification === 'sent',
    notification: outcome.notification,
    reason: outcome.reason,
  };
}

function assignmentActor(opts) {
  const value = String(opts && opts.by || 'quick_ops').replace(/[^\w.-]/g, '').slice(0, 24);
  return value || 'quick_ops';
}

function assignmentNotice(notification) {
  return notifyMessage(notification);
}

async function commitAssignment(booking, patch) {
  const bookingId = booking.id || booking.bookingId;
  const next = buildNextAggregate(booking, patch);
  return commitBooking({
    bookingId,
    expectedBookingVersion: booking.bookingVersion,
    nextAggregate: next,
  });
}

function sameActiveAssignee(booking, tech, phoneE164) {
  if (!booking || !booking.techQuickOpsTokenHash) return false;
  if (tech) {
    return booking.assignmentKind === 'registered'
      && techIdOf(tech) === String(booking.assignedTechId || '');
  }
  return booking.assignmentKind === 'freelance'
    && String(booking.freelancePhone || '') === String(phoneE164 || '');
}

function notifyKeyFor(bookingId, tokenHash) {
  return `jobnotify.${String(bookingId)}.${String(tokenHash).slice(0, 20)}`;
}

async function recordNotify(booking, status, key) {
  const committed = await commitAssignment(booking, {
    techNotifyStatus: status,
    techNotifyKey: key || booking.techNotifyKey || null,
    updatedAt: new Date().toISOString(),
  });
  if (!committed.ok) return { booking, bookingVersion: booking.bookingVersion };
  return { booking: committed.booking, bookingVersion: committed.bookingVersion };
}

function assignResult(booking, extra) {
  const notification = extra.notification || 'failed';
  return {
    ok: true,
    booking,
    bookingVersion: extra.bookingVersion != null ? extra.bookingVersion : booking.bookingVersion,
    assignment: assignmentFromBooking(booking),
    notification,
    message: assignmentNotice(notification),
    ...extra,
    notification,
    message: assignmentNotice(notification),
  };
}

/**
 * Assign the job to a roster technician, or to a freelance phone.
 * A phone that already belongs to an active technician uses that account.
 * Both paths mint one booking-scoped link and queue one job text.
 * Repeating the same assignee does not mint another link or another text.
 */
async function assignQuickOpsTech(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  if (bookingStatus(booking) === 'cancelled' || jobCompleted(booking)) {
    return { ok: false, error: 'locked', statusCode: 409, message: 'This job cannot be assigned' };
  }
  const actor = assignmentActor(opts);
  const requestedId = String(opts.techId || '').trim().slice(0, 48);
  const requestedPhone = String(opts.phone || '').trim();
  if (!requestedId && !requestedPhone) {
    return { ok: false, error: 'assignee_required', statusCode: 400, message: 'Choose a technician or enter a phone' };
  }

  const records = activeTechs(await loadTechRecords());
  let tech = requestedId ? records.find((row) => techIdOf(row) === requestedId) : null;
  if (requestedId && !tech) {
    return { ok: false, error: 'technician_not_found_or_inactive', statusCode: 404, message: 'Technician was not found' };
  }
  const phoneE164 = requestedPhone ? normalizeUsPhoneE164(requestedPhone) : '';
  if (requestedPhone && !phoneE164 && !tech) {
    return { ok: false, error: 'invalid_phone', statusCode: 400, message: 'Enter a valid US phone number' };
  }
  if (!tech && phoneE164) {
    tech = records.find((row) => normalizeUsPhoneE164(row.phone || row.mobile || '') === phoneE164) || null;
  }

  const assigneePhone = tech
    ? normalizeUsPhoneE164(tech.phone || tech.mobile || tech.phoneE164 || '')
    : phoneE164;
  if (sameActiveAssignee(booking, tech, assigneePhone)) {
    const notification = booking.techNotifyStatus === 'sent' ? 'sent' : 'failed';
    return assignResult(booking, {
      idempotent: true,
      kind: booking.assignmentKind,
      notification,
      sms: { sent: notification === 'sent', reason: notification === 'sent' ? null : 'already_assigned' },
    });
  }

  const now = new Date().toISOString();
  const bookingId = booking.id || booking.bookingId;
  await revokeTechQuickOpsToken(booking.techQuickOpsTokenHash);

  let minted = null;
  if (assigneePhone) {
    minted = await createTechQuickOpsToken({ bookingId, phoneE164: assigneePhone });
    if (!minted.ok) return minted;
  }
  const notifyKey = minted ? notifyKeyFor(bookingId, minted.tokenHash) : null;
  const basePatch = {
    assignedAt: now,
    assignedBy: actor,
    techQuickOpsTokenHash: minted ? minted.tokenHash : null,
    techNotifyKey: notifyKey,
    techNotifyStatus: 'pending',
    jobStatus: 'assigned',
    appointmentStatus: booking.appointmentStatus === 'pending_review' ? 'confirmed' : (booking.appointmentStatus || 'confirmed'),
    status: booking.status === 'Pending Review' ? 'Confirmed' : (booking.status || 'Confirmed'),
    updatedAt: now,
  };
  const patch = tech
    ? {
      ...basePatch,
      assignedTechId: techIdOf(tech),
      assignedTech: techIdOf(tech),
      assignedTechName: techNameOf(tech),
      assignmentKind: 'registered',
      freelancePhone: null,
      techLinkPhone: assigneePhone || null,
      quickOpsTechClose: false,
      eventLog: appendEventLog(booking, {
        action: booking.assignedTechId ? 'tech_reassigned' : 'tech_assigned',
        by: actor,
        techId: techIdOf(tech),
        techName: techNameOf(tech),
        kind: 'registered',
      }),
    }
    : {
      ...basePatch,
      assignedTechId: null,
      assignedTech: null,
      assignedTechName: `Freelance ${phoneE164.slice(-4)}`,
      assignmentKind: 'freelance',
      freelancePhone: phoneE164,
      techLinkPhone: null,
      quickOpsTechClose: true,
      eventLog: appendEventLog(booking, {
        action: 'tech_assigned',
        by: actor,
        kind: 'freelance',
        phoneLast4: phoneE164.slice(-4),
      }),
    };
  const committed = await commitAssignment(booking, patch);
  if (!committed.ok) {
    if (minted) await revokeTechQuickOpsToken(minted.tokenHash);
    return committed;
  }
  if (!minted) {
    const recorded = await recordNotify(committed.booking, 'failed', null);
    return assignResult(recorded.booking, {
      bookingVersion: recorded.bookingVersion,
      kind: tech ? 'registered' : 'freelance',
      assignedTechId: tech ? techIdOf(tech) : null,
      assignedTechName: tech ? techNameOf(tech) : null,
      notification: 'failed',
      sms: { sent: false, queued: false, reason: 'invalid_sms_recipient' },
    });
  }
  if (opts.skipSms) {
    const recorded = await recordNotify(committed.booking, 'skipped', notifyKey);
    return assignResult(recorded.booking, {
      bookingVersion: recorded.bookingVersion,
      kind: tech ? 'registered' : 'freelance',
      assignedTechId: tech ? techIdOf(tech) : null,
      assignedTechName: tech ? techNameOf(tech) : null,
      freelancePhone: tech ? null : phoneE164,
      techUrl: minted.opsUrl,
      notification: 'failed',
      sms: { sent: false, queued: false, skipped: true, reason: 'skipped' },
    });
  }
  const sms = await textTech({
    booking,
    toE164: assigneePhone,
    url: minted.opsUrl,
    idempotencyKey: notifyKey,
    prisma: opts.prisma,
    env: opts.env,
    provider: opts.provider,
  });
  const notification = sms && sms.sent === true ? 'sent' : 'failed';
  const recorded = await recordNotify(committed.booking, notification, notifyKey);
  return assignResult(recorded.booking, {
    bookingVersion: recorded.bookingVersion,
    kind: tech ? 'registered' : 'freelance',
    assignedTechId: tech ? techIdOf(tech) : null,
    assignedTechName: tech ? techNameOf(tech) : null,
    freelancePhone: tech ? null : phoneE164,
    techUrl: minted.opsUrl,
    notification,
    sms,
  });
}

/**
 * Resend the existing job text. Does not mint a second link or a second outbox row.
 */
async function retryQuickOpsTechNotification(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  if (!hasAssignment(booking) || !booking.techQuickOpsTokenHash) {
    return { ok: false, error: 'not_assigned', statusCode: 409, message: 'Assigned — notification failed' };
  }
  if (booking.techNotifyStatus === 'sent') {
    return assignResult(booking, {
      idempotent: true,
      kind: booking.assignmentKind,
      notification: 'sent',
      sms: { sent: true, reason: null },
    });
  }
  const key = smsSafeIdempotencyKey(booking.techNotifyKey || '');
  const prisma = opts.prisma || require('./prisma').tryGetPrisma();
  if (!key || !prisma || !prisma.smsOutbox) {
    return assignResult(booking, {
      kind: booking.assignmentKind,
      notification: 'failed',
      sms: { sent: false, reason: 'not_queued' },
    });
  }
  const row = await prisma.smsOutbox.findUnique({ where: { idempotencyKey: key } });
  if (!row) {
    return assignResult(booking, {
      kind: booking.assignmentKind,
      notification: 'failed',
      sms: { sent: false, reason: 'not_queued' },
    });
  }
  if (['sent', 'delivered'].includes(row.status) && row.providerMessageSid) {
    const recorded = await recordNotify(booking, 'sent', key);
    return assignResult(recorded.booking, {
      bookingVersion: recorded.bookingVersion,
      idempotent: true,
      kind: booking.assignmentKind,
      notification: 'sent',
      sms: { sent: true, reason: null },
    });
  }
  if (row.status !== 'accepted' || row.providerMessageSid) {
    await prisma.smsOutbox.update({
      where: { id: row.id },
      data: {
        status: 'accepted',
        providerMessageSid: null,
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: new Date(),
      },
    });
  }
  let kick = null;
  try {
    kick = await kickSmsOutboxByIds([row.id], { prisma, env: opts.env, provider: opts.provider });
  } catch (err) {
    kick = { ok: false, error: 'kick_failed', reason: String(err && err.message || err).slice(0, 80) };
  }
  const outcome = notificationFromKick(kick, { reason: 'not_sent' });
  const recorded = await recordNotify(booking, outcome.notification, key);
  return assignResult(recorded.booking, {
    bookingVersion: recorded.bookingVersion,
    kind: booking.assignmentKind,
    notification: outcome.notification,
    sms: { sent: outcome.notification === 'sent', reason: outcome.reason },
  });
}

const FIELD_JOB_STATUSES = new Set([
  'assigned', 'accepted', 'en_route', 'arrived', 'in_progress', 'paused', 'issue_reported',
]);

function hasAssignment(booking) {
  if (!booking) return false;
  return !!(
    booking.assignedTechId
    || booking.assignedTech
    || booking.freelancePhone
    || booking.assignmentKind
    || booking.techQuickOpsTokenHash
  );
}

/**
 * Take the job off the current technician so it can be assigned again.
 * Revokes the unused job link. Customer confirmation stays as it is.
 */
async function unassignQuickOpsTech(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  const actor = assignmentActor(opts);
  if (bookingStatus(booking) === 'cancelled' || jobCompleted(booking)) {
    return { ok: false, error: 'locked', statusCode: 409, message: 'This job cannot be reassigned' };
  }
  if (!hasAssignment(booking)) {
    return {
      ok: true,
      idempotent: true,
      booking,
      bookingVersion: booking.bookingVersion,
      assignment: assignmentFromBooking(booking),
      message: 'No technician is assigned.',
    };
  }
  const previous = assignmentFromBooking(booking);
  await revokeTechQuickOpsToken(booking.techQuickOpsTokenHash);
  const now = new Date().toISOString();
  const jobStatus = String(booking.jobStatus || '').toLowerCase();
  const committed = await commitAssignment(booking, {
    assignedTechId: null,
    assignedTech: null,
    assignedTechName: null,
    assignedAt: null,
    assignmentKind: null,
    freelancePhone: null,
    techLinkPhone: null,
    techQuickOpsTokenHash: null,
    techNotifyStatus: null,
    techNotifyKey: null,
    quickOpsTechClose: false,
    jobStatus: FIELD_JOB_STATUSES.has(jobStatus) ? 'confirmed' : booking.jobStatus,
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'tech_unassigned',
      by: actor,
      kind: previous.kind || '',
      techId: previous.techId || '',
      techName: previous.name || '',
      phoneLast4: previous.freelancePhone ? previous.freelancePhone.slice(-4) : '',
    }),
  });
  if (!committed.ok) return committed;
  const assignment = assignmentFromBooking(committed.booking);
  return {
    ok: true,
    booking: committed.booking,
    bookingVersion: committed.bookingVersion,
    assignment,
    message: previous.label
      ? `Removed ${previous.label}. You can assign this job to someone else.`
      : 'Assignment removed. You can assign this job to someone else.',
  };
}

async function reloadBooking(bookingId) {
  const rec = await getBookingRecord(bookingId);
  if (!rec.exists || !rec.booking) return null;
  return rec.booking;
}

module.exports = {
  setQuickOpsTechRoster,
  resetQuickOpsTechRoster,
  listAssignableTechs,
  assignQuickOpsTech,
  unassignQuickOpsTech,
  retryQuickOpsTechNotification,
  reloadBooking,
};
