'use strict';

const { getBookingRecord, commitBooking } = require('./booking-repository');
const { buildNextAggregate } = require('./booking-aggregate');
const { appendEventLog } = require('./ops-workflow');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const { bookingStatus, jobCompleted } = require('./admin-quick-ops-view');
const { enqueueSms, smsSafeIdempotencyKey } = require('./sms-outbox');
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

function technicianPortalUrl() {
  const { trustedSiteOrigin } = require('./trusted-site-origin');
  return `${trustedSiteOrigin()}/technician`;
}

async function textTech({ booking, toE164, url, idempotencyKey, consentGranted, prisma, env }) {
  if (!toE164) return { ok: true, queued: false, skipped: true, reason: 'invalid_sms_recipient' };
  try {
    return await enqueueSms({
      idempotencyKey: smsSafeIdempotencyKey(idempotencyKey),
      audience: 'technician',
      consentGranted: consentGranted === true,
      toE164,
      bookingId: booking.id || booking.bookingId,
      templateKey: TEMPLATE_KEYS.TECH_JOB_LINK,
      templateData: {
        service: smsServiceLabel(booking),
        date: smsDateLabel(booking.confirmedDate || booking.preferredDate || ''),
        url,
      },
    }, { prisma, env });
  } catch (err) {
    return { ok: false, queued: false, error: 'sms_failed', reason: String(err && err.message || err).slice(0, 80) };
  }
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

/**
 * Assign the job to a roster technician, or to a freelance phone.
 * A phone that already belongs to an active technician uses that account.
 * Freelance phones receive a basic magic link and the job auto-closes when paid.
 */
async function assignQuickOpsTech(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  if (bookingStatus(booking) === 'cancelled' || jobCompleted(booking)) {
    return { ok: false, error: 'locked', statusCode: 409, message: 'This job cannot be assigned' };
  }
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

  const now = new Date().toISOString();
  const bookingId = booking.id || booking.bookingId;
  await revokeTechQuickOpsToken(booking.techQuickOpsTokenHash);

  if (tech) {
    const id = techIdOf(tech);
    const name = techNameOf(tech);
    const committed = await commitAssignment(booking, {
      assignedTechId: id,
      assignedTech: id,
      assignedTechName: name,
      assignedAt: now,
      assignedBy: 'quick_ops',
      assignmentKind: 'registered',
      freelancePhone: null,
      techQuickOpsTokenHash: null,
      quickOpsTechClose: false,
      jobStatus: 'assigned',
      appointmentStatus: booking.appointmentStatus === 'pending_review' ? 'confirmed' : (booking.appointmentStatus || 'confirmed'),
      status: booking.status === 'Pending Review' ? 'Confirmed' : (booking.status || 'Confirmed'),
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: booking.assignedTechId ? 'tech_reassigned' : 'tech_assigned',
        by: 'quick_ops',
        techId: id,
        techName: name,
        kind: 'registered',
      }),
    });
    if (!committed.ok) return committed;
    const techPhone = normalizeUsPhoneE164(tech.phone || tech.mobile || '');
    const sms = opts.skipSms
      ? { ok: true, queued: false, skipped: true, reason: 'skipped' }
      : await textTech({
        booking,
        toE164: techPhone,
        url: technicianPortalUrl(),
        idempotencyKey: `qo.assign:${bookingId}:${id}:${booking.bookingVersion}`,
        consentGranted: tech.smsConsent === true,
        prisma: opts.prisma,
        env: opts.env,
      });
    return {
      ok: true,
      kind: 'registered',
      assignedTechId: id,
      assignedTechName: name,
      booking: committed.booking,
      bookingVersion: committed.bookingVersion,
      sms,
      message: sms.queued
        ? `Assigned to ${name}. Portal link texted.`
        : `Assigned to ${name}.`,
    };
  }

  const minted = await createTechQuickOpsToken({ bookingId, phoneE164 });
  if (!minted.ok) return minted;
  const committed = await commitAssignment(booking, {
    assignedTechId: null,
    assignedTech: null,
    assignedTechName: `Freelance ${phoneE164.slice(-4)}`,
    assignedAt: now,
    assignedBy: 'quick_ops',
    assignmentKind: 'freelance',
    freelancePhone: phoneE164,
    techQuickOpsTokenHash: minted.tokenHash,
    quickOpsTechClose: true,
    jobStatus: 'assigned',
    appointmentStatus: booking.appointmentStatus === 'pending_review' ? 'confirmed' : (booking.appointmentStatus || 'confirmed'),
    status: booking.status === 'Pending Review' ? 'Confirmed' : (booking.status || 'Confirmed'),
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'tech_assigned',
      by: 'quick_ops',
      kind: 'freelance',
      phoneLast4: phoneE164.slice(-4),
    }),
  });
  if (!committed.ok) {
    await revokeTechQuickOpsToken(minted.tokenHash);
    return committed;
  }
  const sms = opts.skipSms
    ? { ok: true, queued: false, skipped: true, reason: 'skipped' }
    : await textTech({
      booking,
      toE164: phoneE164,
      url: minted.opsUrl,
      idempotencyKey: `qo.assign:${bookingId}:${phoneE164}:${booking.bookingVersion}`,
      // Admin typed this number and is dispatching one transactional job link.
      consentGranted: true,
      prisma: opts.prisma,
      env: opts.env,
    });
  return {
    ok: true,
    kind: 'freelance',
    freelancePhone: phoneE164,
    techUrl: minted.opsUrl,
    booking: committed.booking,
    bookingVersion: committed.bookingVersion,
    sms,
    message: sms.queued
      ? 'Freelance link texted. The job closes when the customer pays.'
      : 'Freelance link ready. Text it or copy it below. The job closes when the customer pays.',
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
  reloadBooking,
};
