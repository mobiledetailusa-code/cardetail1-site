'use strict';

/**
 * Admin-only dry-run historical financial audit.
 * Production + master + canonical host. Never mutates money, Blob, or Stripe.
 */

const { verifyAdminRequest, getSessionSecretStatus } = require('../lib/admin-security');
const { verifyCsrfToken } = require('../lib/owner-studio/authorization');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { deploymentContext } = require('../lib/stripe-mode');
const { findForbiddenBodyKeys } = require('../lib/financial-history-audit');
const { runDryRunPage, DEFAULT_LIMIT, MAX_LIMIT } = require('../lib/financial-history-audit-runtime');

const CANONICAL_HOSTS = new Set(['cardetail1.com', 'www.cardetail1.com']);

let testDeps = null;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
    body: JSON.stringify(body),
  };
}

function header(event, name) {
  const headers = (event && event.headers) || {};
  const want = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === want) return Array.isArray(value) ? value[0] : value;
  }
  return '';
}

function requestHost(event) {
  const forwarded = header(event, 'x-forwarded-host') || header(event, 'host') || '';
  return String(forwarded).split(',')[0].trim().toLowerCase();
}

function parseBody(event) {
  const raw = event && event.isBase64Encoded
    ? Buffer.from(String(event.body || ''), 'base64').toString('utf8')
    : String((event && event.body) || '');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function productionGate(event, env = process.env) {
  const ctx = deploymentContext(env);
  if (ctx.isPreview || ctx.isLocal || !ctx.isProduction) {
    return { ok: false, error: 'non_production_context' };
  }
  const branch = String(env.BRANCH || env.HEAD || 'master').toLowerCase();
  if (branch !== 'master') {
    return { ok: false, error: 'non_production_context' };
  }
  const host = requestHost(event);
  if (!CANONICAL_HOSTS.has(host)) {
    return { ok: false, error: 'non_production_context' };
  }
  return { ok: true };
}

function requireBrowserCsrf(event, session) {
  const cookie = header(event, 'cookie') || '';
  const usesCookie = /cd1_admin_session=/i.test(cookie);
  const adminHeader = header(event, 'x-admin-key');
  if (!usesCookie && adminHeader) return { ok: true };
  const secretStatus = getSessionSecretStatus();
  if (!secretStatus.ok) return { ok: false, error: 'csrf_invalid' };
  const token = header(event, 'x-csrf-token') || '';
  const sid = String(session.token || session.username || '');
  if (!verifyCsrfToken(sid, secretStatus.secret, token)) {
    return { ok: false, error: 'csrf_invalid' };
  }
  return { ok: true };
}

function sanitizeLimit(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function publicTotals(result) {
  const totals = result.totals || {};
  const byClassification = {};
  for (const [name, bucket] of Object.entries(totals.byClassification || {})) {
    byClassification[name] = {
      count: bucket.count || 0,
      approvedCents: bucket.approvedCents || 0,
      stripeGrossCapturedCents: bucket.stripeGrossCapturedCents || 0,
      netSettledCents: bucket.netSettledCents || 0,
    };
  }
  return {
    ok: true,
    dryRun: true,
    mode: 'dry-run',
    bookingsExamined: totals.bookingsExamined || 0,
    byClassification,
    oldestDivergenceAgeMs: totals.oldestDivergenceAgeMs || 0,
    paymentIntentsRetrieved: totals.paymentIntentsRetrieved || 0,
    stripeErrors: totals.stripeErrors || 0,
    pagesProcessed: totals.pagesProcessed || 0,
    garage: totals.garage || {},
    nextCursor: result.nextCursor || null,
    hasMore: !!result.hasMore,
    partial: !!result.partial,
  };
}

function containsPii(payload) {
  const text = JSON.stringify(payload);
  return /@|phone|email|address|vehicle|cus_|pi_|ch_|sk_live_|sk_test_/i.test(text)
    && /"(email|phone|address|customerName|vehicle)"\s*:/i.test(text);
}

exports.handler = async (event, context) => {
  if (!event || event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  const env = (testDeps && testDeps.env) || process.env;
  const gate = productionGate(event, env);
  if (!gate.ok) {
    return json(403, { ok: false, error: gate.error });
  }

  const verifyAdmin = (testDeps && testDeps.verifyAdminRequest) || verifyAdminRequest;
  const auth = await verifyAdmin(event.headers || {});
  if (!auth || !auth.ok) {
    const status = auth && auth.error === 'missing_admin_config' ? 503 : 401;
    return json(status, { ok: false, error: (auth && auth.error) || 'unauthorized' });
  }

  const csrf = requireBrowserCsrf(event, auth);
  if (!csrf.ok) return json(403, { ok: false, error: csrf.error });

  const enforce = (testDeps && testDeps.enforcePublicRateLimit) || enforcePublicRateLimit;
  const rate = await enforce(event, {
    endpoint: 'financial-reconciliation-audit',
    action: 'run',
    failClosed: true,
  });
  if (rate.blocked) return rate.response;

  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }
  const forbidden = findForbiddenBodyKeys(body);
  if (forbidden.length) {
    return json(400, { ok: false, error: 'write_mode_rejected' });
  }
  const mode = String(body.mode || '').trim();
  if (!mode) return json(400, { ok: false, error: 'mode_required' });
  if (mode !== 'dry-run') return json(400, { ok: false, error: 'dry_run_required' });

  const remainingMs = context && typeof context.getRemainingTimeInMillis === 'function'
    ? context.getRemainingTimeInMillis()
    : 26_000;
  const deadlineMs = Date.now() + Math.max(3_000, Math.min(20_000, remainingMs - 4_000));

  try {
    const result = await runDryRunPage({
      env,
      cursor: body.cursor || null,
      limit: sanitizeLimit(body.limit),
      deadlineMs,
      fetchImpl: (testDeps && testDeps.fetchImpl) || globalThis.fetch,
      storeFactory: (testDeps && testDeps.storeFactory) || undefined,
      prismaFactory: (testDeps && testDeps.prismaFactory) || undefined,
      stripeSecret: (testDeps && testDeps.stripeSecret) || env.STRIPE_SECRET_KEY,
    });
    if (!result.ok) {
      return json(result.statusCode || 500, { ok: false, error: result.error, partial: !!result.partial });
    }
    const payload = publicTotals(result);
    if (containsPii(payload)) {
      return json(500, { ok: false, error: 'response_redaction_failed' });
    }
    console.info('[financial-reconciliation-audit]', {
      examined: payload.bookingsExamined,
      pages: payload.pagesProcessed,
      stripeLookups: payload.paymentIntentsRetrieved,
      stripeErrors: payload.stripeErrors,
      partial: payload.partial,
    });
    return json(200, payload);
  } catch (err) {
    const message = String(err && err.message || err);
    if (message === 'write_forbidden') {
      return json(500, { ok: false, error: 'write_forbidden' });
    }
    console.warn('[financial-reconciliation-audit] failed', { error: message.slice(0, 80) });
    return json(503, { ok: false, error: 'audit_unavailable', partial: true });
  }
};

exports.__test = {
  setDeps(deps) { testDeps = deps || null; },
  productionGate,
};
