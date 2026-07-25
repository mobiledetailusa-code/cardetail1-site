'use strict';

const { getOwnerStudioFlags } = require('../lib/owner-studio/flags');
const { resolveCurrentRelease } = require('../lib/owner-studio/release-service');
const { validateReleaseCandidateFromDraft } = require('../lib/owner-studio/release-service');
const { SITE_ID } = require('../lib/owner-studio/ids');
const { verifyAdminRequest } = require('../lib/admin-security');

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'method_not_allowed' });
  }

  const session = await verifyAdminRequest(event.headers || {});
  if (!session || !session.ok) {
    return json(401, { error: 'unauthorized', message: 'Admin session required' });
  }

  const flags = getOwnerStudioFlags();
  let currentReleaseId = null;
  let draftValidation = 'disabled';

  if (flags.enabled) {
    const release = resolveCurrentRelease(SITE_ID);
    currentReleaseId = release?.releaseId || null;
    try {
      const v = validateReleaseCandidateFromDraft(SITE_ID);
      draftValidation = v.ok ? 'ready' : `invalid:${v.errors.length}`;
    } catch (e) {
      draftValidation = `error:${e.code || e.message}`;
    }
  }

  return json(200, {
    siteId: SITE_ID,
    enabled: flags.enabled,
    publicContentSource: flags.publicContentSource,
    currentReleaseId,
    draftValidation,
    role: flags.role,
    editingControls: false,
    publicationControls: false,
  });
};
