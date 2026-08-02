// Admin platform settings — dispatch rules, bid max, auto-confirm, operational availability.
const { jsonCors, verifyAdminKey } = require('../lib/tech-security');
const {
  getOpsSettings, saveOpsSettings, DEFAULT_SETTINGS, MAINTENANCE_PLAN_TEMPLATES,
  getOperationalAvailability, saveOperationalAvailability,
} = require('../lib/ops-config');
const {
  normalizeAvailabilityConfig,
  normalizeDateOverride,
  projectAdminAvailability,
  isoDateParts,
  WEEKEND_MODES,
  CONTRACT_VERSION,
  DEFAULT_BUSINESS_TIMEZONE,
} = require('../lib/operational-availability');
const { syncTechRosterFromAccounts } = require('../lib/auction-ops');

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
    const [settings, availability] = await Promise.all([
      getOpsSettings(),
      getOperationalAvailability(),
    ]);
    return jsonCors(200, {
      ok: true,
      settings,
      defaults: DEFAULT_SETTINGS,
      maintenancePlanTemplates: MAINTENANCE_PLAN_TEMPLATES,
      availability: projectAdminAvailability(availability),
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
    const availability = await getOperationalAvailability();
    return jsonCors(200, { ok: true, availability: projectAdminAvailability(availability) });
  }

  if (action === 'update_availability') {
    const current = await getOperationalAvailability();
    if (body.expectedUpdatedAt != null && body.expectedUpdatedAt !== ''
      && current.updatedAt && String(body.expectedUpdatedAt) !== String(current.updatedAt)) {
      return jsonCors(409, {
        ok: false,
        error: 'version_conflict',
        userMessage: 'Availability was updated elsewhere. Reload Settings and try again.',
        availability: projectAdminAvailability(current),
      });
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

    const availability = await saveOperationalAvailability(next, { updatedBy: actor });
    return jsonCors(200, { ok: true, availability });
  }

  if (action === 'upsert_date_override') {
    const date = String(body.date || '').trim();
    const parts = isoDateParts(date);
    if (!parts) return jsonCors(400, { ok: false, error: 'invalid_date' });
    const normalized = normalizeDateOverride(body.override || body);
    if (!normalized) return jsonCors(400, { ok: false, error: 'invalid_override' });

    const current = await getOperationalAvailability();
    if (body.expectedUpdatedAt != null && body.expectedUpdatedAt !== ''
      && current.updatedAt && String(body.expectedUpdatedAt) !== String(current.updatedAt)) {
      return jsonCors(409, {
        ok: false,
        error: 'version_conflict',
        availability: projectAdminAvailability(current),
      });
    }
    const dateOverrides = { ...(current.dateOverrides || {}) };
    dateOverrides[parts.iso] = normalized;
    const availability = await saveOperationalAvailability({
      ...current,
      dateOverrides,
    }, { updatedBy: actor });
    return jsonCors(200, { ok: true, availability, date: parts.iso });
  }

  if (action === 'remove_date_override') {
    const date = String(body.date || '').trim();
    const parts = isoDateParts(date);
    if (!parts) return jsonCors(400, { ok: false, error: 'invalid_date' });
    const current = await getOperationalAvailability();
    const dateOverrides = { ...(current.dateOverrides || {}) };
    delete dateOverrides[parts.iso];
    const availability = await saveOperationalAvailability({
      ...current,
      dateOverrides,
    }, { updatedBy: actor });
    return jsonCors(200, { ok: true, availability });
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
