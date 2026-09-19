'use strict';

const {
  TOKEN_PREFIX,
  looksLikeToken,
  loadTechQuickOpsToken,
  createTechQuickOpsSession,
  loadTechQuickOpsSession,
  sessionCookieHeader,
  isLocalDev,
  verifyTechQuickOpsCsrf,
} = require('../lib/tech-quick-ops-token');
const {
  loadProjectedBooking,
  updateTechFieldStatus,
  completeTechJob,
} = require('../lib/tech-quick-ops-actions');
const { neutralExpiredPage, techQuickOpsPage } = require('../lib/tech-quick-ops-html');

const FIELD_ACTIONS = {
  accept: 'accepted',
  en_route: 'en_route',
  arrived: 'arrived',
  in_progress: 'in_progress',
  paused: 'paused',
  issue_reported: 'issue_reported',
};

const FIELD_MESSAGES = {
  accepted: 'Job accepted',
  en_route: 'En route',
  arrived: 'Arrived on site',
  in_progress: 'Job started',
  paused: 'Job paused',
  issue_reported: 'Issue reported',
};

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

function pathFrom(event) {
  try {
    if (event.rawUrl) return new URL(event.rawUrl).pathname;
  } catch { /* ignore */ }
  return String(event.path || '');
}

function tokenFromEvent(event) {
  const path = pathFrom(event);
  const parts = path.split('/').filter(Boolean);
  const qIdx = parts.lastIndexOf('q');
  if (qIdx >= 0 && parts[qIdx + 1]) return parts[qIdx + 1];
  const last = parts[parts.length - 1] || '';
  if (looksLikeToken(last)) return last;
  const query = event.queryStringParameters || {};
  const raw = String(query.t || query.token || '').trim();
  return raw || '';
}

function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(String(event.body || ''), 'base64').toString('utf8')
    : String(event.body || '');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function wantsJson(event) {
  const accept = String(event.headers?.accept || event.headers?.Accept || '').toLowerCase();
  const xhr = String(event.headers?.['x-requested-with'] || event.headers?.['X-Requested-With'] || '');
  return accept.includes('application/json') || xhr === 'XMLHttpRequest';
}

async function handleGet(event) {
  const token = tokenFromEvent(event);
  if (token) {
    const loaded = await loadTechQuickOpsToken(token);
    if (!loaded.ok) {
      return wantsJson(event)
        ? json(loaded.statusCode || 400, { ok: false, error: 'invalid' })
        : neutralExpiredPage('ops');
    }
    const session = await createTechQuickOpsSession({ bookingId: loaded.bookingId });
    if (!session.ok) {
      return wantsJson(event)
        ? json(503, { ok: false, error: 'session_unavailable' })
        : neutralExpiredPage('ops');
    }
    const cookie = sessionCookieHeader(session.sessionId, { secure: !isLocalDev(event) });
    return {
      statusCode: 302,
      headers: {
        Location: '/tech/q',
        'Set-Cookie': cookie,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
      body: '',
    };
  }

  const session = await loadTechQuickOpsSession(event);
  if (!session.ok) {
    return wantsJson(event)
      ? json(401, { ok: false, error: 'invalid' })
      : neutralExpiredPage('ops');
  }
  const projected = await loadProjectedBooking(session.bookingId);
  if (!projected.ok) {
    return wantsJson(event)
      ? json(400, { ok: false, error: 'invalid' })
      : neutralExpiredPage('ops');
  }
  if (wantsJson(event)) {
    return json(200, {
      ok: true,
      view: projected.view,
      csrfToken: session.csrfToken,
      bookingReads: projected.reads,
    });
  }
  return techQuickOpsPage(projected.view, session.csrfToken);
}

async function handlePost(event) {
  const session = await loadTechQuickOpsSession(event);
  if (!session.ok) return json(401, { ok: false, error: 'invalid' });
  if (!verifyTechQuickOpsCsrf(event, session)) {
    return json(403, { ok: false, error: 'csrf' });
  }
  const body = parseBody(event);
  const action = String(body.action || '').trim();
  const loaded = await loadProjectedBooking(session.bookingId);
  if (!loaded.ok) return json(400, { ok: false, error: 'invalid' });
  const booking = loaded.booking;
  const view = loaded.view || {};
  const actions = view.actions || {};
  const expectedBookingVersion = body.bookingVersion != null ? body.bookingVersion : booking.bookingVersion;

  if (FIELD_ACTIONS[action]) {
    const status = FIELD_ACTIONS[action];
    if (!actions[action]) {
      return json(409, {
        ok: false,
        error: view.locked ? 'locked' : 'invalid_status_transition',
        message: view.locked ? 'Job completed — locked' : 'That field action is not available',
      });
    }
    const result = await updateTechFieldStatus(booking, status, {
      expectedBookingVersion,
      note: body.note,
    });
    return json(result.ok ? 200 : (result.statusCode || 409), {
      ok: !!result.ok,
      idempotent: !!result.idempotent,
      reload: !!result.ok,
      jobStatus: result.jobStatus || status,
      message: result.ok
        ? (result.idempotent ? 'Already updated' : (FIELD_MESSAGES[status] || 'Updated'))
        : (result.error === 'locked' ? 'Job completed — locked' : (result.error || 'update_failed')),
    });
  }

  if (action === 'complete') {
    if (!actions.complete) {
      return json(409, {
        ok: false,
        error: view.locked ? 'locked' : 'not_ready_to_complete',
        message: view.locked ? 'Job completed — locked' : 'Arrive or start the job first',
      });
    }
    const result = await completeTechJob(booking, { expectedBookingVersion });
    return json(result.ok ? 200 : (result.statusCode || 409), {
      ok: !!result.ok,
      idempotent: !!result.idempotent,
      reload: !!result.ok,
      jobStatus: result.jobStatus || null,
      message: result.ok
        ? (result.idempotent ? 'Already marked done' : 'Job marked done')
        : (result.error || 'complete_failed'),
    });
  }

  return json(400, { ok: false, error: 'unknown_action' });
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  }
  if (event.httpMethod === 'GET') return handleGet(event);
  if (event.httpMethod === 'POST') return handlePost(event);
  return { statusCode: 405, body: '' };
};

exports.tokenFromEvent = tokenFromEvent;
exports.TOKEN_PREFIX = TOKEN_PREFIX;
