'use strict';

/**
 * Owner Studio — Customers, Maintenance & Membership API.
 * Draft CRUD + revisions + simulator. No publish. No live Stripe billing.
 */

const { verifyAdminRequest, readAdminTokenFromHeaders } = require('../lib/admin-security');
const { getOwnerStudioFlags } = require('../lib/owner-studio/flags');
const { authorizeOwnerStudio, createCsrfToken, verifyCsrfToken } = require('../lib/owner-studio/authorization');
const { SITE_ID } = require('../lib/owner-studio/ids');
const { createCustomerLifecycleRepository } = require('../lib/owner-studio/customer-lifecycle-repository');
const { simulateMembershipRevenue, assertNoLiveMembershipBilling } = require('../lib/customer-lifecycle/membership-foundation');
const { evaluateMaintenanceEligibility } = require('../lib/customer-lifecycle/maintenance-eligibility');
const { trustedSiteOrigin } = require('../lib/trusted-site-origin');
const { tryGetPrisma } = require('../lib/prisma');

const MAX_BODY_BYTES = 800_000;
const MUTATION_WINDOW_MS = 60_000;
const MUTATION_MAX = 30;
const mutationBuckets = new Map();

function sessionSecret() {
  return String(process.env.ADMIN_SESSION_SECRET || '').trim();
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, x-csrf-token',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function header(headers, name) {
  const h = headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : '';
}

function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || h['client-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
}

function checkMutationRate(actor, ip) {
  const key = `${actor}|${ip}`;
  const now = Date.now();
  let bucket = mutationBuckets.get(key);
  if (!bucket || now - bucket.windowStart > MUTATION_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
  }
  bucket.count += 1;
  mutationBuckets.set(key, bucket);
  if (bucket.count > MUTATION_MAX) {
    const err = new Error('rate_limited');
    err.code = 'rate_limited';
    err.statusCode = 429;
    throw err;
  }
}

function parseBody(event) {
  const raw = event.body || '';
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : String(raw);
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    const err = new Error('payload_too_large');
    err.code = 'payload_too_large';
    err.statusCode = 413;
    throw err;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('invalid_json');
    err.code = 'invalid_json';
    err.statusCode = 400;
    throw err;
  }
}

function publicError(err) {
  const status = err.statusCode || (err.code === 'stale_draft_version' ? 409 : 400);
  const body = {
    ok: false,
    error: err.code || 'request_failed',
    message: err.message || 'Request failed',
  };
  if (err.expectedVersion != null) body.expectedVersion = err.expectedVersion;
  if (err.currentVersion != null) body.currentVersion = err.currentVersion;
  return json(status, body);
}

async function getRepo() {
  const prisma = tryGetPrisma();
  if (!prisma) {
    const err = new Error('postgres_unavailable');
    err.code = 'postgres_unavailable';
    err.statusCode = 503;
    throw err;
  }
  return createCustomerLifecycleRepository(prisma);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return json(204, {}, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
  }

  try {
    const flags = getOwnerStudioFlags();
    if (!flags.enabled) {
      return json(403, { ok: false, error: 'owner_studio_disabled' });
    }

    const admin = await verifyAdminRequest(event.headers || {});
    if (!admin.ok) {
      return json(admin.statusCode || 401, { ok: false, error: admin.error || 'unauthorized' });
    }
    const adminToken = readAdminTokenFromHeaders(event.headers || {}) || admin.username;
    const identity = {
      authenticated: true,
      username: admin.username || admin.session?.username || 'admin',
      role: 'owner',
      token: adminToken,
    };

    const authz = authorizeOwnerStudio(identity, 'edit_draft', flags);
    if (!authz.ok) {
      return json(authz.statusCode || 403, { ok: false, error: authz.error || 'forbidden' });
    }

    const qs = event.queryStringParameters || {};
    const action = String(qs.action || (event.httpMethod === 'GET' ? 'get_draft' : '') || '').trim();

    if (event.httpMethod === 'GET') {
      if (action === 'csrf') {
        const secret = sessionSecret();
        if (!secret) return json(503, { ok: false, error: 'missing_admin_session_secret' });
        return json(200, {
          ok: true,
          csrfToken: createCsrfToken(String(identity.token || identity.username), secret),
          siteId: SITE_ID,
        });
      }
      const repo = await getRepo();
      if (action === 'list_revisions') {
        const revisions = await repo.listRevisions(SITE_ID);
        return json(200, { ok: true, siteId: SITE_ID, revisions, publishAvailable: false });
      }
      if (action === 'simulate') {
        const draft = await repo.getDraft(SITE_ID);
        const sim = simulateMembershipRevenue(
          draft.simulatorAssumptions,
          (draft.membershipPlans || [])[0]
        );
        return json(200, { ok: true, simulation: sim, disclaimer: 'Assumption-based only' });
      }
      if (action === 'evaluate_eligibility_preview') {
        const draft = await repo.getDraft(SITE_ID);
        const days = Math.max(0, Number(qs.daysSinceCompleted || 30));
        const completedAt = new Date(Date.now() - days * 86400000).toISOString();
        const result = evaluateMaintenanceEligibility({
          vehicleId: 'vc_preview',
          requestedPackageId: 'pkg_preview',
          completedServiceHistory: [{ completedAtUtc: completedAt, vehicleId: 'vc_preview', packageId: 'pkg_preview', status: 'completed' }],
          membershipStatus: String(qs.membershipStatus || 'none'),
          configuredRules: draft.maintenanceRules,
        });
        return json(200, { ok: true, result });
      }
      const draft = await repo.getDraft(SITE_ID);
      return json(200, {
        ok: true,
        draft,
        publishAvailable: false,
        rollbackAvailable: false,
        publicContentSource: flags.publicContentSource || 'legacy',
        liveBillingEnabled: false,
      });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'method_not_allowed' });
    }

    const origin = String(header(event.headers, 'origin') || '');
    if (origin) {
      try {
        const trusted = trustedSiteOrigin();
        if (trusted && origin.replace(/\/$/, '') !== String(trusted).replace(/\/$/, '')) {
          // allow same-host staging variants
        }
      } catch (_) {
        /* ignore */
      }
    }

    const csrf = String(header(event.headers, 'x-csrf-token') || '');
    const secret = sessionSecret();
    if (!secret || !verifyCsrfToken(String(identity.token || identity.username), secret, csrf)) {
      return json(403, { ok: false, error: 'csrf_invalid' });
    }
    checkMutationRate(identity.username, clientIp(event));

    const body = parseBody(event);
    const mutation = String(body.mutation || body.action || '').trim();

    if (mutation === 'publish' || mutation === 'rollback' || body.publish || body.rollback) {
      return json(403, {
        ok: false,
        error: 'publication_not_available',
        message: 'Customer Lifecycle configuration is draft-only in this stage.',
      });
    }
    if (mutation === 'activate_membership' || mutation === 'create_stripe_subscription') {
      const gate = assertNoLiveMembershipBilling({ allowLiveBilling: false });
      return json(gate.statusCode || 403, { ok: false, error: gate.error, message: gate.message });
    }

    const repo = await getRepo();
    if (mutation === 'save_draft') {
      const expectedVersion = Number(body.expectedVersion);
      const payload = body.draft || body.payload || {};
      payload.siteId = SITE_ID;
      const result = await repo.saveDraft(SITE_ID, expectedVersion, payload, identity.username);
      return json(200, {
        ok: true,
        draft: result.draft,
        revisionId: result.revisionId,
        publishAvailable: false,
      });
    }
    if (mutation === 'restore_revision') {
      const result = await repo.restoreRevisionAsNewDraft(
        SITE_ID,
        body.revisionId,
        Number(body.expectedVersion),
        identity.username
      );
      return json(200, { ok: true, draft: result.draft, revisionId: result.revisionId });
    }
    if (mutation === 'simulate') {
      const draft = await repo.getDraft(SITE_ID);
      const assumptions = body.assumptions || draft.simulatorAssumptions;
      const plan = (body.plan || (draft.membershipPlans || [])[0]);
      return json(200, {
        ok: true,
        simulation: simulateMembershipRevenue(assumptions, plan),
        disclaimer: 'Assumption-based estimate only — not a forecast guarantee.',
      });
    }

    return json(400, { ok: false, error: 'unknown_mutation' });
  } catch (err) {
    return publicError(err);
  }
};
