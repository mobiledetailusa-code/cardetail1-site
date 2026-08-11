'use strict';

const adminSecurity = require('../admin-security');
const { authorizeOwnerStudio } = require('./authorization');
const { isMutationOriginAllowed } = require('../trusted-site-origin');

const PREVIEW_HEADER = 'x-owner-studio-preview';

function readHeader(headers, name) {
  const source = headers || {};
  const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(source[key] || '').trim() : '';
}

async function checkPreviewTransactionRequest(event, options = {}) {
  const headers = event?.headers || {};
  if (readHeader(headers, PREVIEW_HEADER) !== '1') {
    return { previewRequest: false };
  }

  const verifyAdmin = options.verifyAdminRequest || adminSecurity.verifyAdminRequest.bind(adminSecurity);
  let session;
  try {
    session = await verifyAdmin(headers);
  } catch (_) {
    return { previewRequest: true, authorized: false, error: 'preview_auth_unavailable' };
  }
  if (!session?.ok) {
    // The header alone cannot opt a public caller into an Admin-only path.
    return { previewRequest: false };
  }

  const origin = readHeader(headers, 'origin');
  const originAllowed = options.isMutationOriginAllowed || isMutationOriginAllowed;
  if (!origin || !originAllowed(origin)) {
    return { previewRequest: true, authorized: false, error: 'untrusted_origin' };
  }

  const authorize = options.authorizeOwnerStudio || authorizeOwnerStudio;
  try {
    authorize({ authenticated: true, username: session.username, role: 'owner' }, 'edit_draft');
  } catch (_) {
    return { previewRequest: true, authorized: false, error: 'owner_studio_denied' };
  }

  return { previewRequest: true, authorized: true };
}

module.exports = {
  PREVIEW_HEADER,
  checkPreviewTransactionRequest,
};
