/**
 * Owner Studio — client session gate.
 *
 * Every Owner Studio data endpoint already enforces the Admin session server-side
 * (owner-studio-status and owner-studio-catalog both return 401 without one), so
 * this is defence in depth, not the security boundary. What it adds is parity with
 * admin-ops.html: an unauthenticated visitor lands on the login page instead of
 * reading the control plane's module inventory and roadmap.
 *
 * Deliberately mirrors ensureAdminSession() in admin-ops.html, including its
 * fail-open catch — a transient network blip must not lock an operator out of their
 * own back office, and the server still refuses every request without a session.
 * No visibility gating: hiding the document until validation would trade a brief
 * flash of non-sensitive roadmap text for a permanently blank page whenever the
 * script fails to run.
 */
(function () {
  'use strict';

  var LOGIN = '/admin';

  function redirect() {
    try {
      if (window.CD1AdminSession && typeof CD1AdminSession.clearToken === 'function') {
        CD1AdminSession.clearToken();
      }
    } catch (_) { /* clearing is best-effort; the redirect is what matters */ }
    location.replace(LOGIN);
  }

  async function requireAdminSession() {
    var token = '';
    try {
      token = (window.CD1AdminSession && CD1AdminSession.getToken && CD1AdminSession.getToken()) || '';
    } catch (_) { token = ''; }

    if (!token) { redirect(); return; }

    try {
      var res = await fetch('/.netlify/functions/admin-auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': token },
        body: JSON.stringify({ action: 'validate', token: token }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!data.ok) { redirect(); return; }
      try { CD1AdminSession.syncWindowKey(); } catch (_) { /* optional */ }
    } catch (_) {
      // Network or parse failure: leave the operator on the page rather than
      // bouncing them to login. Every data call still 401s without a session.
    }
  }

  requireAdminSession();
})();
