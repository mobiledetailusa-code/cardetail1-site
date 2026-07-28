// Restricted Blobs health probe — admin/QA only.
// Reports configured / authorized / readable / writable / site_match.
// Never returns tokens, account IDs, store contents, or connection strings.

'use strict';

const crypto = require('crypto');
const { verifyAdminKey, jsonCors, blobsStore } = require('../lib/tech-security');

const PROBE_STORE = 'cd1-blobs-health';
const EXPECTED_SITE_IDS = {
  production: 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0',
  staging: '982e6338-4a4a-432e-855b-db532b994391',
};
const ALLOWED_SITE_IDS = new Set(Object.values(EXPECTED_SITE_IDS));

function sanitizeDetail(err) {
  return String(err && (err.message || err) || 'unknown')
    .replace(/nf[cp]_[A-Za-z0-9]+/gi, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[DB_URL]')
    .slice(0, 160);
}

function siteRoleFor(siteId) {
  if (!siteId) return null;
  if (siteId === EXPECTED_SITE_IDS.staging) return 'staging';
  if (siteId === EXPECTED_SITE_IDS.production) return 'production';
  return 'unknown';
}

async function probeBlobs() {
  const siteId = String(process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '').trim();
  const hasPat = !!String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  const configured = !!(siteId || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const context = String(process.env.CONTEXT || process.env.APP_ENV || '').toLowerCase();
  const role = siteRoleFor(siteId);
  // Fail closed: staging context must not probe production blobs.
  const stagingContext = /staging|branch-deploy|deploy-preview/.test(context)
    || process.env.APP_ENV === 'staging'
    || process.env.URL?.includes('cardetail1-staging');
  let site_match = !siteId || ALLOWED_SITE_IDS.has(siteId);
  if (stagingContext && role === 'production') site_match = false;
  if (siteId && !ALLOWED_SITE_IDS.has(siteId)) site_match = false;

  let authorized = false;
  let readable = false;
  let writable = false;
  let detail = null;

  if (!site_match) {
    return {
      configured,
      authorized: false,
      readable: false,
      writable: false,
      site_match: false,
      site_role: role,
      detail: 'site_context_rejected',
    };
  }

  try {
    const store = await blobsStore(PROBE_STORE);
    const key = `probe_${crypto.randomBytes(8).toString('hex')}`;
    const payload = { ok: true, at: new Date().toISOString(), purpose: 'health' };

    try {
      await store.setJSON(key, payload, { ttl: 120_000 });
      writable = true;
      authorized = true;
    } catch (e) {
      detail = sanitizeDetail(e);
      const msg = String(e && e.message || '');
      if (/401|403|Access Denied|Unauthorized/i.test(msg)) {
        authorized = false;
      } else {
        // Store handle obtained but write failed for another reason.
        authorized = true;
      }
      return { configured, authorized, readable, writable, site_match, site_role: role, detail };
    }

    try {
      const got = await store.get(key, { type: 'json' });
      readable = !!(got && got.ok === true);
    } catch (e) {
      detail = sanitizeDetail(e);
    }

    try {
      if (typeof store.delete === 'function') await store.delete(key);
    } catch {
      /* ignore cleanup */
    }
  } catch (e) {
    detail = sanitizeDetail(e);
    const msg = String(e && e.message || '');
    if (/401|403|Access Denied|Unauthorized|not been configured/i.test(msg)) {
      authorized = false;
    }
  }

  return {
    configured,
    authorized,
    readable,
    writable,
    site_match,
    site_role: role,
    ...(detail && !(readable && writable) ? { detail } : {}),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(401, { ok: false, error: 'unauthorized' });

  const result = await probeBlobs();
  const ok = !!(result.configured && result.authorized && result.readable && result.writable && result.site_match);
  return jsonCors(ok ? 200 : 503, {
    ok,
    configured: result.configured,
    authorized: result.authorized,
    readable: result.readable,
    writable: result.writable,
    site_match: result.site_match,
    site_role: result.site_role || null,
    context: String(process.env.CONTEXT || ''),
    ...(result.detail ? { detail: result.detail } : {}),
  });
};

exports.__test = { probeBlobs, sanitizeDetail };
