/**
 * Authenticated Customer Portal — saved vehicles (Stage 2B).
 *
 * Session cookie is the sole account authority. Browser-supplied
 * customerAccountId / phone ownership is ignored. Mutations require
 * expectedVersion and return 409 on conflict.
 */

const { jsonCors } = require('../lib/tech-security');
const { validateCustomerSession } = require('../lib/customer-session');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const vehicleService = require('../lib/customer-vehicle-service');

const MAX_BODY_BYTES = 16 * 1024;
const MUTATING_ACTIONS = new Set(['add', 'update', 'archive', 'set_default']);
const READ_ACTIONS = new Set(['list']);

function header(event, name) {
  const h = event?.headers || {};
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (String(k).toLowerCase() === want) return String(v || '');
  }
  return '';
}

function allowedBrowserOrigin(event) {
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

function mapServiceError(result) {
  if (!result || result.ok) return null;
  const err = result.error;
  if (err === vehicleService.VERSION_CONFLICT) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'version_conflict',
        message: result.message || 'This account was updated elsewhere. Reload and try again.',
        actualVersion: result.actualVersion,
      },
    };
  }
  if (err === 'validation_error') {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'validation_error',
        message: result.message || 'Invalid request.',
        field: result.field || null,
      },
    };
  }
  if (err === 'not_found' || err === 'forbidden') {
    return {
      status: 404,
      body: {
        ok: false,
        error: 'not_found',
        message: 'Resource not found.',
      },
    };
  }
  if (err === vehicleService.TEMPORARILY_UNAVAILABLE || err === 'temporarily_unavailable') {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'temporarily_unavailable',
        message: result.message || 'Vehicle garage is temporarily unavailable. Try again shortly.',
      },
    };
  }
  if (err === vehicleService.UNAVAILABLE || err === 'unavailable') {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'temporarily_unavailable',
        message: result.message || 'Vehicle garage is temporarily unavailable. Try again shortly.',
      },
    };
  }
  if (err === vehicleService.SCHEMA_UNAVAILABLE || err === 'schema_unavailable') {
    const correlationId = `veh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    console.error(JSON.stringify({
      scope: 'customer_portal_vehicles',
      error: 'schema_unavailable',
      correlationId,
      causeCode: result.causeCode || null,
    }));
    return {
      status: 500,
      body: {
        ok: false,
        error: 'server_error',
        message: 'Vehicle garage is temporarily unavailable. Try again shortly.',
        correlationId,
      },
    };
  }
  const correlationId = `veh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  console.error(JSON.stringify({
    scope: 'customer_portal_vehicles',
    error: 'unexpected_service_error',
    correlationId,
    serviceError: String(err || 'unknown').slice(0, 64),
  }));
  return {
    status: 500,
    body: {
      ok: false,
      error: 'server_error',
      message: 'Unable to complete this request right now.',
      correlationId,
    },
  };
}

function parseJsonBody(event) {
  const raw = event.body || '';
  const bytes = Buffer.byteLength(String(raw), 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    return { error: jsonCors(413, { ok: false, error: 'payload_too_large' }) };
  }
  try {
    return { body: JSON.parse(raw || '{}') };
  } catch {
    return { error: jsonCors(400, { ok: false, error: 'invalid_json' }) };
  }
}

function vehiclePayload(body) {
  const src = body.vehicle && typeof body.vehicle === 'object' ? body.vehicle : body;
  const out = {};
  for (const key of ['label', 'category', 'year', 'make', 'model', 'color', 'notes', 'isDefault']) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
  }
  // Compatibility aliases from older My Garage modal.
  if (src.vehicleLabel != null && out.label == null) out.label = src.vehicleLabel;
  if (src.vehicleCategory != null && out.category == null) out.category = src.vehicleCategory;
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const parsed = parseJsonBody(event);
  if (parsed.error) return parsed.error;
  const body = parsed.body || {};

  // Ignore any browser-supplied account / phone ownership — session is authoritative.
  void body.customerAccountId;
  void body.browserCustomerAccountId;
  void body.phone;
  void body.phoneDigits;
  void body.ownerKey;

  const action = String(body.action || 'list').trim().toLowerCase();
  if (!READ_ACTIONS.has(action) && !MUTATING_ACTIONS.has(action)) {
    return jsonCors(400, { ok: false, error: 'unknown_action' });
  }

  const rate = await enforcePublicRateLimit(event, {
    scope: 'customer_portal_vehicles',
    max: 40,
    windowMs: 60_000,
  });
  if (rate?.blocked) {
    return jsonCors(429, { ok: false, error: 'rate_limited', message: 'Too many requests. Try again shortly.' });
  }

  const session = await validateCustomerSession(event);
  if (!session.ok || session.scope !== 'account' || !session.customerAccountId) {
    return jsonCors(401, {
      ok: false,
      error: 'authentication_failed',
      message: 'Account sign-in required.',
    });
  }

  if (MUTATING_ACTIONS.has(action) && !allowedBrowserOrigin(event)) {
    return jsonCors(403, { ok: false, error: 'origin_forbidden' });
  }

  const customerAccountId = String(session.customerAccountId);
  const expectedVersion = body.expectedVersion;
  const requestId = body.requestId;

  let result;
  if (action === 'list') {
    result = await vehicleService.listVehicles(customerAccountId, {
      phoneDigits: session.phoneDigits || null,
    });
  } else if (action === 'add') {
    result = await vehicleService.createVehicle({
      customerAccountId,
      vehicle: vehiclePayload(body),
      expectedVersion,
      requestId,
    });
  } else if (action === 'update') {
    result = await vehicleService.updateVehicle({
      customerAccountId,
      vehicleId: body.vehicleId || body.id,
      vehicle: vehiclePayload(body),
      expectedVersion,
      requestId,
    });
  } else if (action === 'archive') {
    result = await vehicleService.archiveVehicle({
      customerAccountId,
      vehicleId: body.vehicleId || body.id,
      expectedVersion,
      requestId,
    });
  } else if (action === 'set_default') {
    result = await vehicleService.setDefaultVehicle({
      customerAccountId,
      vehicleId: body.vehicleId || body.id,
      expectedVersion,
      requestId,
    });
  }

  const mapped = mapServiceError(result);
  if (mapped) {
    if (mapped.status >= 500) {
      console.error(JSON.stringify({
        scope: 'customer_portal_vehicles',
        action,
        status: mapped.status,
        error: mapped.body?.error || null,
        serviceError: result?.error || null,
        causeCode: result?.causeCode || null,
        correlationId: mapped.body?.correlationId || null,
      }));
    }
    return jsonCors(mapped.status, mapped.body);
  }

  if (action === 'list') {
    return jsonCors(200, {
      ok: true,
      vehicles: result.vehicles || [],
      defaultVehicleId: result.defaultVehicleId || null,
      accountVersion: result.accountVersion,
    });
  }

  // After mutation, return fresh list for UI refresh compatibility.
  const listed = await vehicleService.listVehicles(customerAccountId);
  return jsonCors(200, {
    ok: true,
    vehicleId: result.vehicleId || null,
    vehicle: result.vehicle || null,
    vehicles: listed.ok ? listed.vehicles : (result.vehicles || []),
    defaultVehicleId: listed.ok ? listed.defaultVehicleId : null,
    accountVersion: result.accountVersion || listed.accountVersion,
    promotedDefaultId: result.promotedDefaultId || null,
    unchanged: !!result.unchanged,
  });
};
