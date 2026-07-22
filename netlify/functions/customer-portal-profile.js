/**
 * Authenticated Customer Portal — profile & service address management (Stage 2A).
 *
 * Session cookie is the sole account authority. Browser-supplied customerAccountId
 * is ignored. Mutations require expectedVersion and return 409 on conflict.
 */

const { jsonCors } = require('../lib/tech-security');
const { validateCustomerSession } = require('../lib/customer-session');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const profileService = require('../lib/customer-profile-service');
const addressService = require('../lib/customer-address-service');

const MAX_BODY_BYTES = 16 * 1024;
const MUTATING_ACTIONS = new Set([
  'update_profile',
  'create_address',
  'update_address',
  'archive_address',
  'set_default_address',
]);

const READ_ACTIONS = new Set(['get_profile', 'list_addresses']);

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
    // Same-origin navigations / some clients may omit Origin; allow when Host is ours.
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
  if (err === profileService.VERSION_CONFLICT || err === addressService.VERSION_CONFLICT) {
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
  if (err === profileService.CONTACT_CHANGE_REQUIRES_VERIFICATION) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'contact_change_requires_verification',
        message: result.message || 'Email and phone cannot be changed here.',
        field: result.field || null,
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
  return {
    status: 503,
    body: {
      ok: false,
      error: 'service_unavailable',
      message: 'Unable to complete this request right now.',
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const parsed = parseJsonBody(event);
  if (parsed.error) return parsed.error;
  const body = parsed.body || {};

  // Ignore any browser-supplied account identity — session is authoritative.
  void body.customerAccountId;
  void body.browserCustomerAccountId;

  const action = String(body.action || '').trim().toLowerCase();
  if (!READ_ACTIONS.has(action) && !MUTATING_ACTIONS.has(action)) {
    return jsonCors(400, { ok: false, error: 'unknown_action' });
  }

  if (MUTATING_ACTIONS.has(action) && !allowedBrowserOrigin(event)) {
    return jsonCors(403, { ok: false, error: 'origin_not_allowed' });
  }

  const rate = await enforcePublicRateLimit(event, {
    endpoint: 'customer-portal-profile',
    action: MUTATING_ACTIONS.has(action) ? 'mutate' : 'read',
    cors: true,
  });
  if (rate.blocked) return rate.response;

  const session = await validateCustomerSession(event);
  if (!session.ok) {
    return jsonCors(401, {
      ok: false,
      error: 'authentication_failed',
      message: 'Sign in required.',
    });
  }

  const customerAccountId = session.customerAccountId;
  if (!customerAccountId) {
    return jsonCors(401, {
      ok: false,
      error: 'authentication_failed',
      message: 'Sign in required.',
    });
  }

  // Signed session must agree with stored account id (already validated in session).
  if (session.customerAccountId && customerAccountId !== session.customerAccountId) {
    return jsonCors(401, { ok: false, error: 'authentication_failed' });
  }

  const requestId = body.requestId ? String(body.requestId).trim().slice(0, 80) : null;

  if (action === 'get_profile') {
    const result = await profileService.getProfile(customerAccountId);
    const mapped = mapServiceError(result);
    if (mapped) return jsonCors(mapped.status, mapped.body);
    return jsonCors(200, { ok: true, customer: result.customer });
  }

  if (action === 'list_addresses') {
    const result = await addressService.listAddresses(customerAccountId);
    const mapped = mapServiceError(result);
    if (mapped) return jsonCors(mapped.status, mapped.body);
    return jsonCors(200, {
      ok: true,
      addresses: result.addresses,
      defaultAddressId: result.defaultAddressId,
      accountVersion: result.accountVersion,
      customer: result.customer,
    });
  }

  if (action === 'update_profile') {
    const result = await profileService.updateProfile({
      customerAccountId,
      expectedVersion: body.expectedVersion,
      patch: body.patch || body.profile || body,
      requestId,
      browserCustomerAccountId: body.customerAccountId,
    });
    const mapped = mapServiceError(result);
    if (mapped) return jsonCors(mapped.status, mapped.body);
    return jsonCors(200, {
      ok: true,
      customer: result.customer,
      accountVersion: result.accountVersion,
      unchanged: !!result.unchanged,
      idempotent: !!result.idempotent,
    });
  }

  if (action === 'create_address') {
    const result = await addressService.createAddress({
      customerAccountId,
      expectedVersion: body.expectedVersion,
      address: body.address || body,
      requestId,
      browserCustomerAccountId: body.customerAccountId,
    });
    const mapped = mapServiceError(result);
    if (mapped) return jsonCors(mapped.status, mapped.body);
    return jsonCors(200, {
      ok: true,
      addressId: result.addressId,
      customer: result.customer,
      accountVersion: result.accountVersion,
      deduped: !!result.deduped,
      unchanged: !!result.unchanged,
      idempotent: !!result.idempotent,
    });
  }

  if (action === 'update_address') {
    const result = await addressService.updateAddress({
      customerAccountId,
      addressId: body.addressId,
      expectedVersion: body.expectedVersion,
      address: body.address || body,
      requestId,
      browserCustomerAccountId: body.customerAccountId,
    });
    const mapped = mapServiceError(result);
    if (mapped) return jsonCors(mapped.status, mapped.body);
    return jsonCors(200, {
      ok: true,
      addressId: result.addressId,
      customer: result.customer,
      accountVersion: result.accountVersion,
    });
  }

  if (action === 'archive_address') {
    const result = await addressService.archiveAddress({
      customerAccountId,
      addressId: body.addressId,
      expectedVersion: body.expectedVersion,
      requestId,
      browserCustomerAccountId: body.customerAccountId,
    });
    const mapped = mapServiceError(result);
    if (mapped) return jsonCors(mapped.status, mapped.body);
    return jsonCors(200, {
      ok: true,
      addressId: result.addressId,
      wasDefault: !!result.wasDefault,
      customer: result.customer,
      accountVersion: result.accountVersion,
      unchanged: !!result.unchanged,
    });
  }

  if (action === 'set_default_address') {
    const result = await addressService.setDefaultAddress({
      customerAccountId,
      addressId: body.addressId,
      expectedVersion: body.expectedVersion,
      requestId,
      browserCustomerAccountId: body.customerAccountId,
    });
    const mapped = mapServiceError(result);
    if (mapped) return jsonCors(mapped.status, mapped.body);
    return jsonCors(200, {
      ok: true,
      addressId: result.addressId,
      customer: result.customer,
      accountVersion: result.accountVersion,
      unchanged: !!result.unchanged,
    });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};

// Test seams
exports.allowedBrowserOrigin = allowedBrowserOrigin;
exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
