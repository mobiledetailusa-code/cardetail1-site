'use strict';

/**
 * Owner Studio Catalog Manager API (Stage 2).
 * Authenticated draft CRUD + revisions + preview. No publish/rollback.
 */

const { verifyAdminRequest } = require('../lib/admin-security');
const { getOwnerStudioFlags } = require('../lib/owner-studio/flags');
const { authorizeOwnerStudio, createCsrfToken, verifyCsrfToken } = require('../lib/owner-studio/authorization');
const { SITE_ID } = require('../lib/owner-studio/ids');
const {
  createMemoryCatalogRepository,
  createPostgresCatalogRepository,
} = require('../lib/owner-studio/catalog-repository');
const { validateCompleteCatalogDraft, validateReleaseCandidate } = require('../lib/owner-studio/schemas');
const { trustedSiteOrigin } = require('../lib/trusted-site-origin');
const { tryGetPrisma } = require('../lib/prisma');
const { probeOwnerStudioCatalogSchema } = require('../lib/owner-studio/catalog-schema-health');

const MAX_BODY_BYTES = 1_500_000;
const MUTATION_WINDOW_MS = 60_000;
const MUTATION_MAX = 30;
const mutationBuckets = new Map();

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

function assertJsonContentType(event) {
  const ct = String(header(event.headers, 'content-type') || '');
  if (!ct.toLowerCase().includes('application/json')) {
    const err = new Error('unsupported_media_type');
    err.code = 'unsupported_media_type';
    err.statusCode = 415;
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

function sessionSecret() {
  return String(process.env.ADMIN_SESSION_SECRET || '').trim();
}

function buildIdentity(session) {
  return {
    authenticated: true,
    username: session.username,
    role: 'owner',
  };
}

function assertTrustedOrigin(event) {
  const origin = String(header(event.headers, 'origin') || '');
  if (!origin) return;
  let trusted;
  try {
    trusted = trustedSiteOrigin();
  } catch {
    return;
  }
  if (trusted && origin.replace(/\/$/, '') !== String(trusted).replace(/\/$/, '')) {
    // Allow staging netlify.app when TRUSTED points there; otherwise reject mismatches.
    const err = new Error('untrusted_origin');
    err.code = 'untrusted_origin';
    err.statusCode = 403;
    throw err;
  }
}

function requireCsrf(event, session) {
  const secret = sessionSecret();
  const token = header(event.headers, 'x-csrf-token') || '';
  const sid = String(session.token || session.username || '');
  if (!secret || !verifyCsrfToken(sid, secret, token)) {
    const err = new Error('csrf_invalid');
    err.code = 'csrf_invalid';
    err.statusCode = 403;
    throw err;
  }
}

function getRepo() {
  const prisma = tryGetPrisma();
  if (!prisma) {
    const err = new Error('postgresql_required');
    err.code = 'postgresql_required';
    err.statusCode = 503;
    throw err;
  }
  return createPostgresCatalogRepository(prisma);
}

async function assertCatalogSchemaReady() {
  const schema = await probeOwnerStudioCatalogSchema(tryGetPrisma());
  if (!schema.ready) {
    const err = new Error(schema.error || 'owner_studio_catalog_schema_not_ready');
    err.code = 'owner_studio_catalog_schema_not_ready';
    err.statusCode = 503;
    err.ownerStudioCatalogSchema = schema;
    throw err;
  }
  return schema;
}

function overviewFromDraft(draft) {
  if (!draft) {
    return {
      exists: false,
      packageCount: 0,
      addOnCount: 0,
      vehicleClassCount: 0,
      draftVersion: null,
      lastSavedAt: null,
      lastSavedBy: null,
      unresolvedConflictCount: 0,
      validationErrorCount: 0,
      validationOk: null,
    };
  }
  const validation = validateReleaseCandidate(
    { packages: draft.packages, addOns: draft.addOns, vehicleClasses: draft.vehicleClasses },
    { navigation: draft.navigation, footer: draft.footer }
  );
  return {
    exists: true,
    packageCount: draft.packages.length,
    addOnCount: draft.addOns.length,
    vehicleClassCount: draft.vehicleClasses.length,
    draftVersion: draft.version,
    lastSavedAt: draft.lastSavedAt,
    lastSavedBy: draft.lastSavedBy,
    unresolvedConflictCount: (draft.priceConflicts || []).filter((c) => c.status === 'unresolved').length,
    validationErrorCount: validation.errors.length,
    validationOk: validation.ok,
  };
}

function publicError(err) {
  const status = err.statusCode || (
    err.code === 'stale_catalog_draft_version' || err.code === 'stale_draft_version' ? 409 : 400
  );
  const body = {
    ok: false,
    error: err.code || 'request_failed',
    message: String(err.message || 'request_failed').slice(0, 200),
  };
  if (err.expectedVersion != null) body.expectedVersion = err.expectedVersion;
  if (err.currentVersion != null) body.currentVersion = err.currentVersion;
  if (err.ownerStudioCatalogSchema) body.ownerStudioCatalogSchema = err.ownerStudioCatalogSchema;
  return json(status, body);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, x-csrf-token',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      },
      body: '',
    };
  }

  try {
    const session = await verifyAdminRequest(event.headers || {});
    if (!session || !session.ok) {
      return json(401, { ok: false, error: 'unauthorized' });
    }
    const identity = buildIdentity(session);
    const flags = getOwnerStudioFlags();
    const qs = event.queryStringParameters || {};
    const action = String(qs.action || (event.httpMethod === 'GET' ? 'get_draft' : '')).trim();

    // CSRF token bootstrap (authenticated GET)
    if (event.httpMethod === 'GET' && action === 'csrf') {
      authorizeOwnerStudio(identity, 'read_status');
      const secret = sessionSecret();
      if (!secret) return json(503, { ok: false, error: 'missing_admin_session_secret' });
      const token = createCsrfToken(String(session.token || session.username), secret);
      return json(200, { ok: true, csrfToken: token, siteId: SITE_ID });
    }

    if (event.httpMethod === 'GET') {
      authorizeOwnerStudio(identity, flags.enabled ? 'edit_draft' : 'read_status');
      if (!flags.enabled) {
        return json(403, { ok: false, error: 'owner_studio_disabled' });
      }
      const schema = await assertCatalogSchemaReady();
      const repo = getRepo();
      if (action === 'get_draft' || action === 'overview') {
        const draft = await repo.getCatalogDraft(SITE_ID);
        return json(200, {
          ok: true,
          siteId: SITE_ID,
          publicContentSource: flags.publicContentSource,
          publicationControls: false,
          publishAvailable: false,
          rollbackAvailable: false,
          persistence: 'postgresql',
          ownerStudioCatalogSchema: schema,
          overview: overviewFromDraft(draft),
          draft: action === 'overview' ? null : draft,
        });
      }
      if (action === 'list_entities') {
        const entities = await repo.readCatalogEntities(SITE_ID);
        return json(200, { ok: true, siteId: SITE_ID, ...entities });
      }
      if (action === 'list_revisions') {
        const revisions = await repo.listCatalogRevisions(SITE_ID, {
          limit: qs.limit,
          offset: qs.offset,
        });
        return json(200, { ok: true, siteId: SITE_ID, ...revisions });
      }
      if (action === 'get_revision') {
        const rev = await repo.getCatalogRevision(SITE_ID, qs.revisionId);
        if (!rev) return json(404, { ok: false, error: 'revision_not_found' });
        return json(200, { ok: true, siteId: SITE_ID, revision: rev });
      }
      if (action === 'preview') {
        const draft = await repo.getCatalogDraft(SITE_ID);
        if (!draft) return json(404, { ok: false, error: 'draft_not_found' });
        const validation = validateReleaseCandidate(
          { packages: draft.packages, addOns: draft.addOns, vehicleClasses: draft.vehicleClasses },
          { navigation: draft.navigation, footer: draft.footer }
        );
        return json(200, {
          ok: true,
          siteId: SITE_ID,
          previewBanner: 'DRAFT PREVIEW — NOT PUBLISHED',
          published: false,
          publicContentSource: flags.publicContentSource,
          validation,
          draft,
        });
      }
      if (action === 'validation') {
        const draft = await repo.getCatalogDraft(SITE_ID);
        if (!draft) return json(404, { ok: false, error: 'draft_not_found' });
        const validation = validateReleaseCandidate(
          { packages: draft.packages, addOns: draft.addOns, vehicleClasses: draft.vehicleClasses },
          { navigation: draft.navigation, footer: draft.footer }
        );
        return json(200, {
          ok: true,
          siteId: SITE_ID,
          validation,
          unresolvedConflicts: (draft.priceConflicts || []).filter((c) => c.status === 'unresolved'),
        });
      }
      return json(400, { ok: false, error: 'unknown_action' });
    }

    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      authorizeOwnerStudio(identity, 'edit_draft');
      if (!flags.enabled) return json(403, { ok: false, error: 'owner_studio_disabled' });
      assertTrustedOrigin(event);
      assertJsonContentType(event);
      requireCsrf(event, session);
      checkMutationRate(identity.username, clientIp(event));
      const body = parseBody(event);
      const mutation = String(body.action || action || '').trim();
      // Hard deny publish/rollback even if requested
      if (mutation === 'publish' || mutation === 'rollback' || body.publish || body.rollback) {
        return json(403, {
          ok: false,
          error: 'publication_not_available',
          message: 'Publishing will be available after transactional release integration.',
        });
      }
      await assertCatalogSchemaReady();
      const repo = getRepo();
      if (mutation === 'create_draft') {
        const draft = await repo.createCatalogDraft(SITE_ID, identity.username);
        return json(201, { ok: true, draft, overview: overviewFromDraft(draft) });
      }
      if (mutation === 'save_draft') {
        const expectedVersion = Number(body.expectedVersion);
        const payload = body.draft || body.payload || {};
        // Never accept browser siteId authority
        payload.siteId = SITE_ID;
        const result = await repo.saveCatalogDraft(SITE_ID, expectedVersion, payload, identity.username);
        return json(200, {
          ok: true,
          draft: result.draft,
          revisionId: result.revisionId,
          validation: result.validation,
          overview: overviewFromDraft(result.draft),
        });
      }
      if (mutation === 'restore_revision') {
        const result = await repo.restoreRevisionAsNewDraft(
          SITE_ID,
          body.revisionId,
          Number(body.expectedVersion),
          identity.username
        );
        return json(200, {
          ok: true,
          draft: result.draft,
          revisionId: result.revisionId,
          validation: result.validation,
          overview: overviewFromDraft(result.draft),
        });
      }
      if (mutation === 'validate_draft') {
        const payload = { ...(body.draft || body.payload || {}), siteId: SITE_ID };
        const validated = validateCompleteCatalogDraft(payload);
        const validation = validateReleaseCandidate(
          { packages: validated.packages, addOns: validated.addOns, vehicleClasses: validated.vehicleClasses },
          { navigation: validated.navigation, footer: validated.footer }
        );
        return json(200, { ok: true, validation, draft: validated });
      }
      return json(400, { ok: false, error: 'unknown_action' });
    }

    return json(405, { ok: false, error: 'method_not_allowed' });
  } catch (err) {
    return publicError(err);
  }
};

// Test helpers
exports._test = {
  createMemoryCatalogRepository,
  createPostgresCatalogRepository,
  overviewFromDraft,
  MAX_BODY_BYTES,
};
