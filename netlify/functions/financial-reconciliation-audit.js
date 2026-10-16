'use strict';

/**
 * Admin-only dry-run historical financial audit.
 * Production + master + canonical host. Never mutates money, Blob, or Stripe.
 *
 * Authentication (unambiguous):
 *
 * 1. Browser admin session (preferred)
 *    - HttpOnly cookie `cd1_admin_session`
 *    - matching `x-csrf-token`
 *    - do not send `x-admin-key`
 *
 * 2. Static admin key (automation inside an already-configured process)
 *    - header `x-admin-key` receives only ADMIN_DASH_PASSWORD
 *    - never a session token (`v1.` or legacy 64-hex)
 *    - the function runtime already has ADMIN_DASH_PASSWORD in its environment;
 *      do not paste the value into a shell command (that writes secrets into
 *      history). Example shape only:
 *        curl -X POST "$AUDIT_URL" \
 *          -H "x-admin-key: ${ADMIN_DASH_PASSWORD}" \
 *          -H "content-type: application/json" \
 *          --data '{"mode":"dry-run"}'
 *      The variable must already be loaded in that process. Do not prefix the
 *      command with ADMIN_DASH_PASSWORD=secret.
 *
 * Sending cookie and x-admin-key together is rejected.
 * Preview / non-master / non-canonical hosts are blocked before I/O.
 */

const crypto = require('crypto');
const {
  getAdminConfig,
  getSessionSecretStatus,
  validateAdminToken,
  parseAdminCookies,
  ADMIN_COOKIE_NAME,
  TOKEN_PREFIX,
  LEGACY_TOKEN_LEN,
} = require('../lib/admin-security');
const { verifyCsrfToken } = require('../lib/owner-studio/authorization');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { deploymentContext } = require('../lib/stripe-mode');
const {
  findForbiddenBodyKeys,
  findCoverageOverrideChannels,
  coverageWindow,
  FinancialAuditConfigurationError,
} = require('../lib/financial-history-audit');
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

function timingSafeEqualText(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function looksLikeSessionToken(value) {
  const token = String(value || '').trim();
  if (token.startsWith(TOKEN_PREFIX)) return true;
  if (token.length === LEGACY_TOKEN_LEN && /^[a-f0-9]+$/.test(token)) return true;
  return false;
}

async function authenticateAuditRequest(event, env = process.env) {
  const hdrKey = String(header(event, 'x-admin-key') || '').trim();
  const cookies = parseAdminCookies(event && event.headers);
  const cookieToken = String(cookies[ADMIN_COOKIE_NAME] || '').trim();

  if (hdrKey && cookieToken) {
    return { ok: false, error: 'conflicting_credentials', status: 401 };
  }

  if (hdrKey) {
    if (looksLikeSessionToken(hdrKey)) {
      return { ok: false, error: 'admin_key_invalid', status: 401 };
    }
    const cfg = getAdminConfig();
    if (!cfg.configured) return { ok: false, error: 'missing_admin_config', status: 503 };
    if (hdrKey.length < 16 || !timingSafeEqualText(hdrKey, cfg.password)) {
      return { ok: false, error: 'unauthorized', status: 401 };
    }
    return { ok: true, method: 'admin_key' };
  }

  if (cookieToken) {
    const session = await validateAdminToken(cookieToken);
    if (!session) return { ok: false, error: 'unauthorized', status: 401 };
    const secretStatus = getSessionSecretStatus();
    if (!secretStatus.ok) return { ok: false, error: 'csrf_invalid', status: 403 };
    const csrf = header(event, 'x-csrf-token') || '';
    const sid = String(session.token || session.username || '');
    if (!verifyCsrfToken(sid, secretStatus.secret, csrf)) {
      return { ok: false, error: 'csrf_invalid', status: 403 };
    }
    return { ok: true, method: 'session', token: session.token, username: session.username };
  }

  return { ok: false, error: 'unauthorized', status: 401 };
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
  const candidates = Array.isArray(result.candidates)
    ? result.candidates.map((row) => ({
      auditRef: row.auditRef,
      primaryClassification: row.primaryClassification,
      reasonCodes: row.reasonCodes || [],
      values: {
        approved: row.values && row.values.approved || 0,
        stripeCaptured: row.values && row.values.stripeCaptured || 0,
        ledgerSettled: row.values && row.values.ledgerSettled || 0,
        refunded: row.values && row.values.refunded || 0,
        netSettled: row.values && row.values.netSettled || 0,
        remaining: row.values && row.values.remaining || 0,
      },
      paymentIntentCount: row.paymentIntentCount || 0,
      settlementCount: row.settlementCount || 0,
      requiresManualReview: row.requiresManualReview !== false,
    }))
    : [];
  return {
    ok: true,
    dryRun: true,
    mode: 'dry-run',
    bookingsExamined: totals.bookingsExamined || 0,
    byClassification,
    byReasonOverlapping: totals.byReasonOverlapping || {},
    reasonCountsOverlap: true,
    oldestDivergenceAgeMs: totals.oldestDivergenceAgeMs || 0,
    paymentIntentsRetrieved: totals.paymentIntentsRetrieved || 0,
    stripeErrors: totals.stripeErrors || 0,
    postgresErrors: totals.postgresErrors || 0,
    blobErrors: totals.blobErrors || 0,
    unclassifiedCount: totals.unclassifiedCount || 0,
    pagesProcessed: totals.pagesProcessed || 0,
    garage: totals.garage || {},
    sources: totals.sources || {},
    candidates,
    nextCursor: result.nextCursor || null,
    hasMore: !!result.hasMore,
    partial: !!result.partial,
    scanComplete: !!result.scanComplete,
    localCoverageComplete: !!result.localCoverageComplete,
    providerCoverageComplete: !!result.providerCoverageComplete,
    providerCoverage: result.providerCoverage || 'partial',
    localCoverage: result.localCoverage || 'partial',
    coverageStartedAt: result.coverageStartedAt || null,
    coverageEndedAt: result.coverageEndedAt || null,
  };
}

function containsPii(payload) {
  const text = JSON.stringify(payload);
  if (/"bookingId"\s*:|"paymentIntentId"\s*:|"email"\s*:|"phone"\s*:|"address"\s*:|"customerName"\s*:|"vehicle"\s*:/i.test(text)) {
    return true;
  }
  if (/"((pi|ch|cus)_[A-Za-z0-9_]+|sk_(live|test)_[A-Za-z0-9]+)"/.test(text)) {
    return true;
  }
  return false;
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

  const authenticate = (testDeps && testDeps.authenticateAuditRequest) || authenticateAuditRequest;
  const auth = await authenticate(event, env);
  if (!auth || !auth.ok) {
    const status = (auth && auth.status) || (auth && auth.error === 'missing_admin_config' ? 503 : 401);
    return json(status, { ok: false, error: (auth && auth.error) || 'unauthorized' });
  }

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

  const overrideHits = findCoverageOverrideChannels({
    ...event,
    __parsedBody: body,
  });
  if (overrideHits.length) {
    return json(400, { ok: false, error: 'write_mode_rejected' });
  }

  const nowMs = (testDeps && Number.isFinite(testDeps.nowMs)) ? testDeps.nowMs : Date.now();
  try {
    coverageWindow(env, nowMs);
  } catch (err) {
    const reason = err && err.reason ? String(err.reason) : 'coverage_start_invalid';
    if (err && (err.name === 'FinancialAuditConfigurationError' || err instanceof FinancialAuditConfigurationError)) {
      console.warn('[financial-reconciliation-audit]', { error: reason });
      return json(503, { ok: false, error: 'financial_audit_not_configured' });
    }
    throw err;
  }

  const remainingMs = context && typeof context.getRemainingTimeInMillis === 'function'
    ? context.getRemainingTimeInMillis()
    : 26_000;
  const deadlineMs = nowMs + Math.max(3_000, Math.min(20_000, remainingMs - 4_000));

  try {
    const result = await runDryRunPage({
      env,
      cursor: body.cursor || null,
      limit: sanitizeLimit(body.limit),
      nowMs,
      deadlineMs,
      clock: () => nowMs,
      fetchImpl: (testDeps && testDeps.fetchImpl) || globalThis.fetch,
      storeFactory: (testDeps && testDeps.storeFactory) || undefined,
      prismaFactory: (testDeps && testDeps.prismaFactory) || undefined,
      stripeSecret: (testDeps && testDeps.stripeSecret) || env.STRIPE_SECRET_KEY,
    });
    if (!result.ok) {
      const error = result.error === 'cursor_execution_mismatch' ? 'invalid_cursor' : result.error;
      return json(result.statusCode || 500, { ok: false, error, partial: !!result.partial });
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
      postgresErrors: payload.postgresErrors,
      blobErrors: payload.blobErrors,
      partial: payload.partial,
      scanComplete: payload.scanComplete,
      providerCoverage: payload.providerCoverage,
    });
    return json(200, payload);
  } catch (err) {
    if (err && (err.name === 'FinancialAuditConfigurationError' || err instanceof FinancialAuditConfigurationError)) {
      console.warn('[financial-reconciliation-audit]', { error: String(err.reason || 'coverage_start_invalid') });
      return json(503, { ok: false, error: 'financial_audit_not_configured' });
    }
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
  authenticateAuditRequest,
  looksLikeSessionToken,
  publicTotals,
  containsPii,
};
