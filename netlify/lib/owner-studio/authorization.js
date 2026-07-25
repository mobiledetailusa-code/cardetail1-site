'use strict';

const crypto = require('crypto');
const { getOwnerStudioFlags } = require('./flags');
const { appendAuditEvent } = require('./audit');
const { SITE_ID } = require('./ids');

function deny(code, actor, action) {
  appendAuditEvent({
    siteId: SITE_ID,
    actor: actor || 'anonymous',
    action: `deny:${action || code}`,
    detail: { code },
  });
  const err = new Error(code);
  err.code = code;
  err.statusCode = 403;
  throw err;
}

/**
 * @param {{ authenticated?: boolean, username?: string, role?: string }} identity
 * @param {'read_status'|'edit_draft'|'publish'|'rollback'} action
 */
function authorizeOwnerStudio(identity, action) {
  const flags = getOwnerStudioFlags();
  const actor = String(identity?.username || '').trim() || 'anonymous';

  if (!identity?.authenticated) {
    deny('owner_studio_unauthenticated', actor, action);
  }

  // Staff / non-admin never
  if (identity.role === 'staff' || identity.role === 'tech' || identity.role === 'customer') {
    deny('owner_studio_staff_denied', actor, action);
  }

  if (!flags.enabled && action !== 'read_status') {
    deny('owner_studio_disabled', actor, action);
  }

  const role = identity.role || flags.role || 'owner';

  if (action === 'read_status') {
    return { ok: true, actor, role, flags };
  }

  if (action === 'edit_draft') {
    if (role === 'owner' || role === 'admin') return { ok: true, actor, role, flags };
    deny('owner_studio_edit_denied', actor, action);
  }

  if (action === 'publish' || action === 'rollback') {
    if (role === 'owner') return { ok: true, actor, role, flags };
    if (role === 'admin' && flags.adminCanPublish) return { ok: true, actor, role, flags };
    deny('owner_studio_publish_denied', actor, action);
  }

  deny('owner_studio_action_unknown', actor, action);
}

function createCsrfToken(sessionId, secret) {
  const sid = String(sessionId || '');
  const sec = String(secret || '');
  if (!sid || !sec) {
    const err = new Error('csrf_secret_missing');
    err.code = 'csrf_secret_missing';
    throw err;
  }
  return crypto.createHmac('sha256', sec).update(`os-csrf:${sid}`).digest('hex');
}

function verifyCsrfToken(sessionId, secret, token) {
  const expected = createCsrfToken(sessionId, secret);
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  authorizeOwnerStudio,
  createCsrfToken,
  verifyCsrfToken,
};
