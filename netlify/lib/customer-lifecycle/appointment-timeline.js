'use strict';

/**
 * Unified appointment timeline writer.
 * Appends to booking.eventLog, operations-audit blob, and optional Prisma AppointmentEvent.
 * Never stores card numbers, secrets, or full provider payloads.
 */

const crypto = require('crypto');

const EVENT_TYPES = [
  'booking_requested',
  'booking_created',
  'booking_approved',
  'booking_rejected',
  'booking_rescheduled_by_customer',
  'booking_rescheduled_by_owner',
  'booking_cancelled_by_customer',
  'booking_cancelled_by_owner',
  'package_changed',
  'vehicle_changed',
  'addon_requested',
  'addon_approved',
  'addon_rejected',
  'addon_cancelled',
  'quote_created',
  'quote_revised',
  'payment_method_saved',
  'payment_attempt_created',
  'payment_succeeded',
  'payment_failed',
  'email_requested',
  'email_sent',
  'email_failed',
  'portal_access_created',
  'appointment_completed',
  'appointment_archived',
  'maintenance_eligibility_evaluated',
  'membership_status_changed',
];

function newEventId() {
  return `ae_${crypto.randomBytes(8).toString('hex')}`;
}

function sanitizeSummary(summary) {
  const s = String(summary || '').slice(0, 500);
  return s.replace(/\b(?:sk_live_|sk_test_|pk_live_|pk_test_|whsec_)[A-Za-z0-9]+\b/g, '[redacted]');
}

function buildTimelineEvent(input = {}) {
  const eventType = String(input.eventType || '').trim();
  if (!EVENT_TYPES.includes(eventType)) {
    const err = new Error('invalid_timeline_event_type');
    err.code = 'invalid_timeline_event_type';
    throw err;
  }
  return {
    eventId: input.eventId || newEventId(),
    siteId: input.siteId || 'detailing-zone',
    appointmentId: input.appointmentId || input.bookingId || null,
    customerId: input.customerId || null,
    actorType: input.actorType || 'system',
    actorId: input.actorId || null,
    source: input.source || 'customer-lifecycle',
    eventType,
    occurredAtUtc: input.occurredAtUtc || new Date().toISOString(),
    appointmentVersion: input.appointmentVersion != null ? Number(input.appointmentVersion) : null,
    quoteVersion: input.quoteVersion != null ? Number(input.quoteVersion) : null,
    changeSummary: sanitizeSummary(input.changeSummary || input.summary || eventType),
    internalNote: input.internalNote ? sanitizeSummary(input.internalNote).slice(0, 300) : null,
    correlationId: input.correlationId || null,
    metadata: input.metadata && typeof input.metadata === 'object'
      ? sanitizeMetadata(input.metadata)
      : undefined,
  };
}

function sanitizeMetadata(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/card|secret|token|cookie|authorization|client_secret/i.test(k)) continue;
    if (typeof v === 'string') out[k] = sanitizeSummary(v).slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean' || v == null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? x.slice(0, 80) : x));
  }
  return out;
}

/**
 * Append event to booking.eventLog (immutable append).
 */
function appendEventLogEntry(booking, event) {
  const entry = {
    action: event.eventType,
    at: event.occurredAtUtc,
    by: event.actorType,
    eventId: event.eventId,
    summary: event.changeSummary,
    appointmentVersion: event.appointmentVersion,
    quoteVersion: event.quoteVersion,
  };
  const prev = Array.isArray(booking.eventLog) ? booking.eventLog : [];
  return { eventLog: [...prev, entry] };
}

async function writeAppointmentTimelineEvent(input) {
  const event = buildTimelineEvent(input);
  const results = { event, eventLog: false, opsAudit: false, prisma: false };

  // Ops audit blob (best-effort)
  try {
    const { appendAudit } = require('../operations-audit');
    if (typeof appendAudit === 'function') {
      await appendAudit({
        bookingId: event.appointmentId,
        action: event.eventType,
        actor: event.actorType,
        detail: {
          eventId: event.eventId,
          summary: event.changeSummary,
          appointmentVersion: event.appointmentVersion,
          quoteVersion: event.quoteVersion,
          correlationId: event.correlationId,
        },
      });
      results.opsAudit = true;
    }
  } catch (_) {
    /* optional */
  }

  // Prisma AppointmentEvent (best-effort; table may not exist until migration)
  try {
    const { tryGetPrisma } = require('../prisma');
    const prisma = tryGetPrisma();
    if (prisma?.appointmentEvent?.create) {
      await prisma.appointmentEvent.create({
        data: {
          eventId: event.eventId,
          siteId: event.siteId,
          appointmentId: event.appointmentId || 'unknown',
          customerId: event.customerId,
          actorType: event.actorType,
          actorId: event.actorId,
          source: event.source,
          eventType: event.eventType,
          occurredAtUtc: new Date(event.occurredAtUtc),
          appointmentVersion: event.appointmentVersion,
          quoteVersion: event.quoteVersion,
          changeSummary: event.changeSummary,
          internalNote: event.internalNote,
          correlationId: event.correlationId,
          metadata: event.metadata || undefined,
        },
      });
      results.prisma = true;
    }
  } catch (_) {
    /* optional until migration applied */
  }

  return results;
}

async function listAppointmentTimeline(bookingId, { limit = 100 } = {}) {
  const events = [];
  try {
    const { getBookingRecord } = require('../booking-store');
    const rec = await getBookingRecord(bookingId);
    const log = Array.isArray(rec?.booking?.eventLog) ? rec.booking.eventLog : [];
    for (const e of log.slice(-limit)) {
      events.push({
        eventId: e.eventId || null,
        eventType: e.action,
        occurredAtUtc: e.at,
        actorType: e.by,
        changeSummary: e.summary || e.action,
        appointmentVersion: e.appointmentVersion ?? null,
        quoteVersion: e.quoteVersion ?? null,
        source: 'eventLog',
      });
    }
  } catch (_) {
    /* ignore */
  }
  try {
    const { tryGetPrisma } = require('../prisma');
    const prisma = tryGetPrisma();
    if (prisma?.appointmentEvent?.findMany) {
      const rows = await prisma.appointmentEvent.findMany({
        where: { appointmentId: bookingId },
        orderBy: { occurredAtUtc: 'asc' },
        take: limit,
      });
      for (const r of rows) {
        events.push({
          eventId: r.eventId,
          eventType: r.eventType,
          occurredAtUtc: r.occurredAtUtc?.toISOString?.() || r.occurredAtUtc,
          actorType: r.actorType,
          changeSummary: r.changeSummary,
          appointmentVersion: r.appointmentVersion,
          quoteVersion: r.quoteVersion,
          source: 'prisma',
        });
      }
    }
  } catch (_) {
    /* ignore */
  }
  // Dedupe by eventId when present; else keep both streams chronologically
  const seen = new Set();
  const out = [];
  for (const e of events.sort((a, b) => String(a.occurredAtUtc).localeCompare(String(b.occurredAtUtc)))) {
    const key = e.eventId || `${e.eventType}:${e.occurredAtUtc}:${e.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.slice(-limit);
}

module.exports = {
  EVENT_TYPES,
  buildTimelineEvent,
  appendEventLogEntry,
  writeAppointmentTimelineEvent,
  listAppointmentTimeline,
  newEventId,
};
