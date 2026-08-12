// Owner Studio — release API (Stage 6).
//
// GET  ?action=current   → the release the site currently points at (manifest only)
// GET  ?action=history   → release history, newest first, current one marked
// POST {action:'publish',  expectedDraftVersion}  → publish the draft as a release
// POST {action:'rollback', releaseId}             → move the pointer to a prior release
//
// Publish and rollback are the only write paths in Owner Studio that can change what
// the public site would serve, so they carry one more gate than the catalog draft API:
//
//   1. a valid Admin session                       (verifyAdminRequest)
//   2. a same-origin mutation                      (evaluateMutationOrigin)
//   3. a CSRF token bound to that session          (verifyCsrfToken)
//   4. the Owner Studio publish grant              (authorizeOwnerStudio)
//   5. OWNER_STUDIO_PUBLISH_ENABLED, default false (flags.publishEnabled)
//
// Gate 5 exists because gates 1–4 are all satisfiable by an ordinary owner on an
// enabled site. Turning Owner Studio on for editing must not silently turn on the
// ability to change the live catalog; that has to be a separate, deliberate act.

'use strict';

const { verifyAdminRequest } = require('../lib/admin-security');
const { tryGetPrisma } = require('../lib/prisma');
const { clientIp } = require('../lib/tech-security');
const { authorizeOwnerStudio, verifyCsrfToken } = require('../lib/owner-studio/authorization');
const { getOwnerStudioFlags } = require('../lib/owner-studio/flags');
const { SITE_ID } = require('../lib/owner-studio/ids');
const { createPostgresReleaseRepository } = require('../lib/owner-studio/release-repository');
const { isMutationOriginAllowed } = require('../lib/trusted-site-origin');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function header(headers, name) {
  const src = headers || {};
  const key = Object.keys(src).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(src[key] || '').trim() : '';
}

function sessionSecret() {
  return process.env.ADMIN_SESSION_SECRET || '';
}

function buildIdentity(session, flags) {
  return {
    authenticated: true,
    username: session.username,
    role: flags.role,
  };
}

function getRepo() {
  const prisma = tryGetPrisma();
  if (!prisma) {
    const err = new Error('postgresql_required');
    err.code = 'postgresql_required';
    err.statusCode = 503;
    throw err;
  }
  return createPostgresReleaseRepository(prisma);
}

function parseBody(event) {
  try {
    return JSON.parse(event.body || '{}');
  } catch (_) {
    const err = new Error('invalid_json');
    err.code = 'invalid_json';
    err.statusCode = 400;
    throw err;
  }
}

function requireCsrf(event, session) {
  const secret = sessionSecret();
  const token = header(event.headers, 'x-csrf-token');
  const sid = String(session.token || session.username || '');
  if (!secret || !verifyCsrfToken(sid, secret, token)) {
    const err = new Error('csrf_invalid');
    err.code = 'csrf_invalid';
    err.statusCode = 403;
    throw err;
  }
}

function requireSameOrigin(event) {
  const origin = header(event.headers, 'origin');
  if (!origin || !isMutationOriginAllowed(origin)) {
    const err = new Error('untrusted_origin');
    err.code = 'untrusted_origin';
    err.statusCode = 403;
    throw err;
  }
}

/** Release rows carry full snapshots; the API returns manifests, never the payload. */
function summarizeRelease(row) {
  if (!row) return null;
  return {
    releaseId: row.releaseId,
    revisionId: row.revisionId || null,
    schemaVersion: row.schemaVersion,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy || null,
    manifest: row.manifestJson || row.manifest || null,
    current: row.current === true,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, x-csrf-token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
      body: '',
    };
  }

  try {
    const session = await verifyAdminRequest(event.headers || {});
    if (!session || !session.ok) return json(401, { ok: false, error: 'unauthorized' });

    const flags = getOwnerStudioFlags();
    const identity = buildIdentity(session, flags);
    const qs = event.queryStringParameters || {};

    if (event.httpMethod === 'GET') {
      // Reading release history is not a publish, so it needs only the read grant.
      authorizeOwnerStudio(identity, flags.enabled ? 'edit_draft' : 'read_status');
      if (!flags.enabled) return json(403, { ok: false, error: 'owner_studio_disabled' });

      const action = String(qs.action || 'current').trim();
      const repo = getRepo();

      if (action === 'current') {
        const current = await repo.getCurrentRelease(SITE_ID);
        return json(200, {
          ok: true,
          siteId: SITE_ID,
          publicContentSource: flags.publicContentSource,
          publishEnabled: flags.publishEnabled,
          release: summarizeRelease(current),
        });
      }
      if (action === 'history') {
        const releases = await repo.listReleases(SITE_ID, Number(qs.limit) || 20);
        return json(200, {
          ok: true,
          siteId: SITE_ID,
          publishEnabled: flags.publishEnabled,
          releases: releases.map(summarizeRelease),
        });
      }
      return json(400, { ok: false, error: 'unknown_action' });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'method_not_allowed' });
    }

    const body = parseBody(event);
    const action = String(body.action || qs.action || '').trim();
    if (action !== 'publish' && action !== 'rollback') {
      return json(400, { ok: false, error: 'unknown_action' });
    }

    requireSameOrigin(event);
    requireCsrf(event, session);
    // Grant check before the kill switch, so an unauthorized caller is told they are
    // unauthorized rather than learning whether publishing happens to be switched on.
    authorizeOwnerStudio(identity, action);

    if (!flags.publishEnabled) {
      return json(403, {
        ok: false,
        error: 'publication_not_enabled',
        message: 'Set OWNER_STUDIO_PUBLISH_ENABLED=true on this environment to allow releases.',
      });
    }

    const repo = getRepo();

    if (action === 'publish') {
      const result = await repo.publishRelease(SITE_ID, body.expectedDraftVersion, identity.username);
      return json(201, { ok: true, ...result });
    }

    const result = await repo.rollbackToRelease(SITE_ID, body.releaseId, identity.username);
    return json(200, { ok: true, ...result });
  } catch (err) {
    const status = Number(err && err.statusCode) || (err && err.code ? 400 : 500);
    const code = (err && err.code) || 'release_error';
    // Never echo err.message: repository errors can carry draft/version detail and
    // Prisma errors can carry connection context.
    const payload = { ok: false, error: code };
    if (err && err.actualVersion != null) payload.actualVersion = err.actualVersion;
    if (err && Array.isArray(err.errors)) payload.errors = err.errors;
    if (status >= 500) {
      console.warn('[owner-studio-release] ' + code, clientIp(event) ? '' : '');
    }
    return json(status, payload);
  }
};
