'use strict';

/**
 * Owner Studio — authenticated storefront catalog preview API (Stage 4B-1).
 *
 * GET /.netlify/functions/owner-studio-catalog-preview
 *
 * Presentation-only. Does not mutate drafts, publish, quote, book, or charge.
 */

const adminSecurity = require('../lib/admin-security');
const { getOwnerStudioFlags } = require('../lib/owner-studio/flags');
const { authorizeOwnerStudio } = require('../lib/owner-studio/authorization');
const { SITE_ID } = require('../lib/owner-studio/ids');
const {
  createMemoryCatalogRepository,
  createPostgresCatalogRepository,
} = require('../lib/owner-studio/catalog-repository');
const { buildStorefrontPreviewCatalog } = require('../lib/owner-studio/storefront-preview');
const { tryGetPrisma } = require('../lib/prisma');
const { probeOwnerStudioCatalogSchema } = require('../lib/owner-studio/catalog-schema-health');

const CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

/** @type {null | (() => { getCatalogDraft: Function })} */
let testRepoFactory = null;
/** @type {null | ((headers: object) => Promise<object>)} */
let testVerifyAdmin = null;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CACHE_HEADERS },
    body: JSON.stringify(body),
  };
}

function buildIdentity(session) {
  return {
    authenticated: true,
    username: session.username,
    role: 'owner',
  };
}

function getRepo() {
  if (typeof testRepoFactory === 'function') {
    return testRepoFactory();
  }
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
  if (typeof testRepoFactory === 'function') {
    return { configured: true, ready: true, requiredTablesPresent: true, source: 'test' };
  }
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

function publicError(err) {
  const status = err.statusCode || 400;
  const body = {
    ok: false,
    preview: false,
    error: err.code || 'request_failed',
    message: String(err.message || 'request_failed').slice(0, 200),
  };
  if (err.ownerStudioCatalogSchema) body.ownerStudioCatalogSchema = err.ownerStudioCatalogSchema;
  return json(status, body);
}

function wantsIncludeInactive(qs) {
  const raw = String(qs.includeInactive || qs.include_inactive || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: { ...CACHE_HEADERS },
      body: '',
    };
  }

  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, preview: false, error: 'method_not_allowed' });
  }

  try {
    const verifyAdmin = testVerifyAdmin || adminSecurity.verifyAdminRequest.bind(adminSecurity);
    const session = await verifyAdmin(event.headers || {});
    if (!session || !session.ok) {
      return json(401, { ok: false, preview: false, error: 'unauthorized' });
    }

    const identity = buildIdentity(session);
    const flags = getOwnerStudioFlags();

    // Same Owner Studio gate as Catalog Manager reads: enabled + edit_draft for owners.
    authorizeOwnerStudio(identity, flags.enabled ? 'edit_draft' : 'read_status');
    if (!flags.enabled) {
      return json(403, { ok: false, preview: false, error: 'owner_studio_disabled' });
    }

    await assertCatalogSchemaReady();
    const repo = getRepo();
    const draft = await repo.getCatalogDraft(SITE_ID);
    const qs = event.queryStringParameters || {};
    const payload = buildStorefrontPreviewCatalog(draft, {
      includeInactive: wantsIncludeInactive(qs),
    });

    return json(200, payload);
  } catch (err) {
    return publicError(err);
  }
};

exports._test = {
  buildStorefrontPreviewCatalog,
  createMemoryCatalogRepository,
  setRepoFactory(fn) {
    testRepoFactory = typeof fn === 'function' ? fn : null;
  },
  setVerifyAdmin(fn) {
    testVerifyAdmin = typeof fn === 'function' ? fn : null;
  },
  reset() {
    testRepoFactory = null;
    testVerifyAdmin = null;
  },
};
