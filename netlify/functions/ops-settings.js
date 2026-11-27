// Admin platform settings — dispatch rules, bid max, auto-confirm, operational availability.
const { jsonCors, verifyAdminKey } = require('../lib/tech-security');
const {
  getOpsSettings, saveOpsSettings, DEFAULT_SETTINGS, MAINTENANCE_PLAN_TEMPLATES,
  loadOperationalAvailability, saveOperationalAvailability,
} = require('../lib/ops-config');
const {
  normalizeAvailabilityConfig,
  normalizeDateOverride,
  projectAdminAvailability,
  projectEffectiveCalendar,
  horizonIsoDates,
  isClosedHoliday,
  businessTodayIso,
  isoDateParts,
  WEEKEND_MODES,
  CONTRACT_VERSION,
  DEFAULT_BUSINESS_TIMEZONE,
} = require('../lib/operational-availability');
const { planBulkAvailability, previewPayload, MAX_BULK_DAYS } = require('../lib/availability-bulk');
const { syncTechRosterFromAccounts } = require('../lib/auction-ops');

const ADMIN_AVAILABILITY_UNAVAILABLE = 'Availability settings could not be read, so nothing was shown or changed. Reload in a minute. Customers cannot book online until it reads again.';

function header(event, name) {
  const headers = (event && event.headers) || {};
  const want = String(name || '').toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return '';
}

/** Same-origin / trusted-host gate for Admin Ops mutations (token is still required). */
function allowedAdminOrigin(event) {
  const origin = header(event, 'origin') || header(event, 'referer');
  if (!origin) {
    const host = (header(event, 'x-forwarded-host') || header(event, 'host') || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (!host) return false;
    return (
      host === 'cardetail1.com'
      || host === 'www.cardetail1.com'
      || host.endsWith('.netlify.app')
      || host === 'localhost'
      || host.startsWith('localhost:')
      || host === '127.0.0.1'
      || host.startsWith('127.0.0.1:')
    );
  }
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (host === 'cardetail1.com' || host === 'www.cardetail1.com') return true;
    if (host.endsWith('.netlify.app')) return true;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    return false;
  } catch {
    return false;
  }
}

function availabilityUnavailableResponse(loaded) {
  return jsonCors(503, {
    ok: false,
    error: 'availability_unavailable',
    reason: (loaded && loaded.reason) || 'read_failed',
    userMessage: ADMIN_AVAILABILITY_UNAVAILABLE,
  });
}

/** Stale-tab guard: expectedRevision (Phase 1) or the legacy expectedUpdatedAt. */
function staleAvailabilityEdit(body, current) {
  if (body.expectedRevision != null && body.expectedRevision !== '') {
    return Math.floor(Number(body.expectedRevision)) !== Math.floor(Number(current.revision || 0));
  }
  return body.expectedUpdatedAt != null && body.expectedUpdatedAt !== ''
    && !!current.updatedAt && String(body.expectedUpdatedAt) !== String(current.updatedAt);
}

function versionConflictResponse(current) {
  return jsonCors(409, {
    ok: false,
    error: 'version_conflict',
    userMessage: 'Availability was updated elsewhere. Reload Settings and try again.',
    availability: current ? projectAdminAvailability(current) : null,
  });
}

/** Conditional write against the exact blob version that was read. */
async function persistAvailability(next, loaded, actor) {
  const saved = await saveOperationalAvailability(next, {
    updatedBy: actor,
    etag: loaded.etag,
    expectNew: loaded.source === 'default',
    baseRevision: loaded.config.revision || 0,
  });
  if (!saved.ok) {
    const fresh = await loadOperationalAvailability();
    return { response: versionConflictResponse(fresh.ok ? fresh.config : null) };
  }
  return { saved };
}

async function reservationsFor(dates) {
  const { indexedReservationsForDates } = require('../lib/slot-index');
  return indexedReservationsForDates(dates);
}

function bulkRangeDates(req) {
  const from = isoDateParts(req && req.from);
  const to = isoDateParts(req && req.to);
  if (!from || !to || to.iso < from.iso) return [];
  return horizonIsoDates(from.iso, MAX_BULK_DAYS + 1).filter((iso) => iso <= to.iso);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) {
    return jsonCors(
      auth.error === 'missing_admin_password_config' || auth.error === 'missing_admin_config' ? 503 : 401,
      { ok: false, error: auth.error }
    );
  }

  if (event.httpMethod === 'GET') {
    const [settings, loaded] = await Promise.all([
      getOpsSettings(),
      loadOperationalAvailability(),
    ]);
    return jsonCors(200, {
      ok: true,
      settings,
      defaults: DEFAULT_SETTINGS,
      maintenancePlanTemplates: MAINTENANCE_PLAN_TEMPLATES,
      // Never show legacy defaults in place of a configuration we could not read.
      availability: loaded.ok ? projectAdminAvailability(loaded.config) : null,
      availabilityStatus: loaded.ok
        ? { ok: true, source: loaded.source }
        : {
          ok: false,
          error: 'availability_unavailable',
          reason: loaded.reason,
          userMessage: ADMIN_AVAILABILITY_UNAVAILABLE,
        },
    });
  }

  // Mutations require trusted browser origin in addition to admin session token.
  if (!allowedAdminOrigin(event)) {
    return jsonCors(403, { ok: false, error: 'origin_not_allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || 'update');
  const actor = auth.username || auth.email || auth.admin || 'admin';

  if (action === 'sync_tech_roster') {
    const result = await syncTechRosterFromAccounts();
    return jsonCors(200, { ok: true, ...result });
  }

  if (action === 'get_availability') {
    const loaded = await loadOperationalAvailability();
    if (!loaded.ok) return availabilityUnavailableResponse(loaded);
    return jsonCors(200, {
      ok: true,
      availability: projectAdminAvailability(loaded.config),
      source: loaded.source,
    });
  }

  if (action === 'effective_calendar') {
    const loaded = await loadOperationalAvailability();
    if (!loaded.ok) return availabilityUnavailableResponse(loaded);
    const days = Math.min(120, Math.max(7, Math.floor(Number(body.days)) || 56));
    const today = businessTodayIso(loaded.config.businessTimezone);
    const fromParts = isoDateParts(body.from);
    const from = fromParts && fromParts.iso >= today ? fromParts.iso : today;
    const reservations = await reservationsFor(horizonIsoDates(from, days));
    const calendar = projectEffectiveCalendar(loaded.config, {
      from,
      days,
      occupancy: reservations.ok ? reservations.occupancy : {},
    });
    for (const day of calendar.days) {
      day.reservations = reservations.ok ? (reservations.bookingsByDate[day.date] || 0) : null;
    }
    return jsonCors(200, {
      ok: true,
      calendar,
      reservationsVerified: !!reservations.ok,
      availability: projectAdminAvailability(loaded.config),
    });
  }

  if (action === 'preview_bulk_availability' || action === 'apply_bulk_availability') {
    const loaded = await loadOperationalAvailability();
    if (!loaded.ok) return availabilityUnavailableResponse(loaded);
    const req = body.request && typeof body.request === 'object' ? body.request : body;
    const reservations = await reservationsFor(bulkRangeDates(req));
    if (!reservations.ok) {
      // Fail closed: a bulk change must know which dates already hold bookings.
      return jsonCors(503, {
        ok: false,
        error: 'reservations_unverified',
        userMessage: 'Existing reservations could not be checked, so no preview was produced. Nothing was changed. Try again in a minute.',
      });
    }
    const plan = planBulkAvailability(loaded.config, req, {
      reservationsByDate: reservations.bookingsByDate,
    });
    if (!plan.ok) return jsonCors(400, plan);
    if (action === 'preview_bulk_availability') {
      return jsonCors(200, { ok: true, preview: previewPayload(plan) });
    }
    if (!body.planHash || String(body.planHash) !== plan.planHash) {
      return jsonCors(409, {
        ok: false,
        error: 'preview_stale',
        userMessage: 'Availability or reservations changed since this preview. Review the updated preview, then confirm again.',
        preview: previewPayload(plan),
      });
    }
    if (plan.requiresReservationAck && body.acknowledgeReservations !== true) {
      return jsonCors(400, {
        ok: false,
        error: 'reservation_ack_required',
        userMessage: 'Some dates you are closing already have reservations. Those bookings stay booked; confirm that you understand before applying.',
        preview: previewPayload(plan),
      });
    }
    if (plan.overrideLimitExceeded) {
      return jsonCors(400, {
        ok: false,
        error: 'too_many_overrides',
        userMessage: 'This would exceed the limit of future date exceptions. Use a shorter range; recurring schedules arrive in Phase 2.',
      });
    }
    if (!plan.changes.length) {
      return jsonCors(200, {
        ok: true,
        applied: 0,
        availability: projectAdminAvailability(loaded.config),
        summary: plan.summary,
      });
    }
    const persisted = await persistAvailability(
      { ...loaded.config, dateOverrides: plan.nextOverrides },
      loaded,
      actor
    );
    if (persisted.response) return persisted.response;
    console.log('[availability] bulk_applied', {
      actor,
      action: plan.request.action,
      from: plan.request.from,
      to: plan.request.to,
      changes: plan.changes.length,
      protectedIncluded: plan.summary.protectedIncluded,
      closingWithReservations: plan.summary.closingWithReservations,
      revision: persisted.saved.config.revision,
    });
    return jsonCors(200, {
      ok: true,
      applied: plan.changes.length,
      availability: persisted.saved.availability,
      summary: plan.summary,
    });
  }

  if (action === 'update_availability') {
    const loaded = await loadOperationalAvailability();
    if (!loaded.ok) return availabilityUnavailableResponse(loaded);
    const current = loaded.config;
    // Stale tabs are refused (expectedRevision, or legacy expectedUpdatedAt).
    if (staleAvailabilityEdit(body, current)) {
      return versionConflictResponse(current);
    }
    const next = {
      version: CONTRACT_VERSION,
      businessTimezone: body.businessTimezone != null
        ? String(body.businessTimezone).trim()
        : current.businessTimezone || DEFAULT_BUSINESS_TIMEZONE,
      weekendMode: body.weekendMode != null
        ? String(body.weekendMode).trim()
        : current.weekendMode,
      supervisedEffectiveDate: body.supervisedEffectiveDate !== undefined
        ? (body.supervisedEffectiveDate
          ? String(body.supervisedEffectiveDate).trim()
          : null)
        : current.supervisedEffectiveDate,
      dateOverrides: body.dateOverrides !== undefined
        ? body.dateOverrides
        : current.dateOverrides,
    };

    if (!WEEKEND_MODES.includes(next.weekendMode)) {
      return jsonCors(400, { ok: false, error: 'invalid_weekend_mode' });
    }
    if (next.weekendMode === 'supervised') {
      const parts = isoDateParts(next.supervisedEffectiveDate);
      if (!parts) {
        return jsonCors(400, {
          ok: false,
          error: 'supervised_effective_date_required',
          userMessage: 'Supervised weekend mode requires an explicit effective date. It will not activate until that date.',
        });
      }
      next.supervisedEffectiveDate = parts.iso;
    }

    try {
      Intl.DateTimeFormat('en-US', { timeZone: next.businessTimezone }).format(new Date());
    } catch (_) {
      return jsonCors(400, { ok: false, error: 'invalid_business_timezone' });
    }

    const overrides = {};
    if (next.dateOverrides && typeof next.dateOverrides === 'object') {
      for (const [key, value] of Object.entries(next.dateOverrides)) {
        const parts = isoDateParts(key);
        if (!parts) continue;
        const normalized = normalizeDateOverride(value);
        if (normalized) overrides[parts.iso] = normalized;
      }
    }
    next.dateOverrides = overrides;

    const preview = normalizeAvailabilityConfig(next);
    if (next.weekendMode === 'supervised' && preview.weekendMode !== 'supervised') {
      return jsonCors(400, { ok: false, error: 'invalid_availability_config' });
    }

    const persisted = await persistAvailability(next, loaded, actor);
    if (persisted.response) return persisted.response;
    return jsonCors(200, { ok: true, availability: persisted.saved.availability });
  }

  if (action === 'upsert_date_override') {
    const date = String(body.date || '').trim();
    const parts = isoDateParts(date);
    if (!parts) return jsonCors(400, { ok: false, error: 'invalid_date' });
    const normalized = normalizeDateOverride(body.override || body);
    if (!normalized) return jsonCors(400, { ok: false, error: 'invalid_override' });
    if (normalized.enabled && isClosedHoliday(parts.iso) && normalized.holidayOpening !== true) {
      return jsonCors(400, {
        ok: false,
        error: 'holiday_opening_confirmation_required',
        userMessage: 'This date is a protected holiday. Tick "Open this holiday" to open it explicitly.',
      });
    }

    const loaded = await loadOperationalAvailability();
    if (!loaded.ok) return availabilityUnavailableResponse(loaded);
    const current = loaded.config;
    if (staleAvailabilityEdit(body, current)) {
      return versionConflictResponse(current);
    }
    const dateOverrides = { ...(current.dateOverrides || {}) };
    dateOverrides[parts.iso] = normalized;
    const persisted = await persistAvailability({ ...current, dateOverrides }, loaded, actor);
    if (persisted.response) return persisted.response;
    return jsonCors(200, { ok: true, availability: persisted.saved.availability, date: parts.iso });
  }

  if (action === 'remove_date_override') {
    const date = String(body.date || '').trim();
    const parts = isoDateParts(date);
    if (!parts) return jsonCors(400, { ok: false, error: 'invalid_date' });
    const loaded = await loadOperationalAvailability();
    if (!loaded.ok) return availabilityUnavailableResponse(loaded);
    const current = loaded.config;
    if (staleAvailabilityEdit(body, current)) {
      return versionConflictResponse(current);
    }
    const dateOverrides = { ...(current.dateOverrides || {}) };
    delete dateOverrides[parts.iso];
    const persisted = await persistAvailability({ ...current, dateOverrides }, loaded, actor);
    if (persisted.response) return persisted.response;
    return jsonCors(200, { ok: true, availability: persisted.saved.availability });
  }

  const ALLOWED = [
    'autoConfirmAppointments', 'autoPostToAuctionOnConfirm', 'dispatchMode',
    'bidMaxPercent', 'bidMaxOverride', 'bidWindowMinutes', 'bidWindowMinutesBoatRv',
    'requireCompoundExperience', 'minTechRatingToBid', 'maintenancePlansEnabled',
  ];
  const patches = {};
  for (const k of ALLOWED) {
    if (body[k] !== undefined) patches[k] = body[k];
  }
  if (patches.bidMaxPercent != null) {
    patches.bidMaxPercent = Math.min(100, Math.max(1, Number(patches.bidMaxPercent) || 85));
  }
  if (patches.bidMaxOverride === '' || patches.bidMaxOverride === null) patches.bidMaxOverride = null;
  if (patches.minTechRatingToBid != null) {
    patches.minTechRatingToBid = Math.min(5, Math.max(0, Number(patches.minTechRatingToBid) || 0));
  }

  const settings = await saveOpsSettings(patches);
  return jsonCors(200, { ok: true, settings });
};
