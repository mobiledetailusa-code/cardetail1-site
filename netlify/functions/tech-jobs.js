// Technician: list assigned jobs + post status updates (not completion).
const {
  blobsStore, jsonCors, validateTechSession, bookingAssignedToTech, sanitizeText,
} = require('../lib/tech-security');
const {
  projectJobForTech,
  TECH_STATUS_UPDATES,
  appendEventLog,
  isTechEligibleBooking,
  canTechTransition,
  normalizeTechJobStatus,
} = require('../lib/ops-workflow');
const {
  getBookingRecord,
  commitBooking,
  setBookingStoreOverride,
} = require('../lib/booking-repository');
const { buildNextAggregate, normalizeAggregate } = require('../lib/booking-aggregate');

const LEGACY_STATUS = {
  accepted: 'Scheduled',
  en_route: 'En Route',
  arrived: 'In Progress',
  in_progress: 'In Progress',
  paused: 'In Progress',
  issue_reported: 'Problem',
};

const FIELD_ACTIVE = new Set(['en_route', 'arrived', 'in_progress', 'paused', 'issue_reported']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});

  const session = await validateTechSession(event.headers || {});
  if (!session) return jsonCors(401, { ok: false, error: 'unauthorized' });

  if (event.httpMethod === 'GET') {
    try {
      const store = await blobsStore('cd1-bookings');
      const listing = await store.list();
      const all = (await Promise.all(
        ((listing && listing.blobs) || []).map(b => store.get(b.key, { type: 'json' }).catch(() => null))
      )).filter(Boolean);

      const jobs = all
        .filter(b => !b.isDraft && !b.isTest && !b.archived)
        .filter(b => bookingAssignedToTech(b, session.techId, session.techName))
        .filter(isTechEligibleBooking)
        .map(projectJobForTech)
        .sort((a, b) => String(a.preferredDate || '').localeCompare(String(b.preferredDate || '')));

      return jsonCors(200, { ok: true, count: jobs.length, jobs });
    } catch {
      return jsonCors(500, { ok: false, error: 'failed_to_load_jobs' });
    }
  }

  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const bookingId = sanitizeText(body.bookingId, 48);
  const newStatus = sanitizeText(body.status, 40).toLowerCase();
  const note = sanitizeText(body.note, 500);

  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });
  if (!TECH_STATUS_UPDATES.has(newStatus)) {
    return jsonCors(400, { ok: false, error: 'invalid_status', allowed: [...TECH_STATUS_UPDATES] });
  }

  const store = await blobsStore('cd1-bookings');
  setBookingStoreOverride(store);
  try {
    const current = await getBookingRecord(bookingId, { storeOverride: store });
    if (!current.exists || !current.booking) {
      return jsonCors(404, { ok: false, error: 'booking_not_found' });
    }
    const booking = current.booking;
    if (!bookingAssignedToTech(booking, session.techId, session.techName)) {
      return jsonCors(403, { ok: false, error: 'not_assigned_to_you' });
    }
    if (!isTechEligibleBooking(booking)) {
      return jsonCors(403, { ok: false, error: 'not_confirmed_eligible' });
    }
    const fromStatus = normalizeTechJobStatus(booking);
    if (!canTechTransition(fromStatus, newStatus)) {
      return jsonCors(409, {
        ok: false,
        error: 'invalid_status_transition',
        from: fromStatus || null,
        to: newStatus,
      });
    }

    const now = new Date().toISOString();
    const updates = {
      jobStatus: newStatus,
      status: LEGACY_STATUS[newStatus] || booking.status,
      lastTechUpdate: now,
      lastTechUpdateBy: session.techId,
      updatedAt: now,
      updatedByRole: 'technician',
      updatedBy: session.techId,
      lastAction: 'tech_status_update',
      eventLog: appendEventLog(booking, {
        action: 'tech_status_update',
        status: newStatus,
        by: 'technician',
        technicianId: session.techId,
        ...(note ? { note } : {}),
      }),
    };
    // Keep appointmentStatus confirmed while field work is active so scheduling
    // identity stays intact; jobStatus drives customer mutation policy (PDA-11).
    if (FIELD_ACTIVE.has(newStatus) && !booking.appointmentStatus) {
      updates.appointmentStatus = 'confirmed';
    }
    if (newStatus === 'en_route') updates.enRouteAt = now;
    if (newStatus === 'arrived') updates.arrivedAt = now;
    if (newStatus === 'in_progress') updates.startedAt = now;
    if (newStatus === 'paused') updates.pausedAt = now;
    if (newStatus === 'issue_reported') {
      updates.hasProblem = true;
      updates.lastProblem = note || 'Issue reported by technician';
    }
    if (note) {
      updates.techNotes = ((booking.techNotes || '') + '\n[' + now.slice(0, 16) + '] ' + note).trim();
    }

    const { ok: normOk, aggregate: base } = normalizeAggregate(booking, { allowDraft: false });
    const next = buildNextAggregate(normOk ? base : booking, updates);
    const expected = Math.max(0, Math.round(Number(booking.bookingVersion) || 0));
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: expected,
      nextAggregate: next,
      storeOverride: store,
    });
    if (!committed.ok) {
      return jsonCors(committed.statusCode || 409, {
        ok: false,
        error: committed.error || 'version_conflict',
        actualBookingVersion: committed.actualBookingVersion,
      });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      jobStatus: newStatus,
      updatedAt: now,
      bookingVersion: committed.bookingVersion,
    });
  } finally {
    setBookingStoreOverride(null);
  }
};
