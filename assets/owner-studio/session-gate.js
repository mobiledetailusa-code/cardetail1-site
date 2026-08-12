/**
 * Owner Studio — client session gate.
 *
 * Every Owner Studio data endpoint already enforces the Admin session server-side
 * (owner-studio-status and owner-studio-catalog both return 401 without one), so
 * this is defence in depth, not the security boundary. What it adds is parity with
 * admin-ops.html: an unauthenticated visitor lands on the login page instead of
 * reading the control plane's module inventory and roadmap.
 *
 * CRITICAL — the local token is not the authority on whether a tab is signed in.
 * CD1AdminSession stores it in sessionStorage, which is per-tab, while the server
 * also accepts the HttpOnly admin cookie shared across same-origin tabs
 * (readAdminTokenFromHeaders in admin-security.js). A second tab therefore has NO
 * local token and IS authenticated — that is exactly what the browser-scoped
 * session cookie was introduced for. Treating an empty token as "signed out" would
 * bounce a legitimate operator every time they open Owner Studio in a new tab.
 *
 * So: always ask the server with credentials, and redirect only when the SERVER
 * rejects. `validate` falls back to the cookie (body.token || header || cookie).
 *
 * Deliberately does not hide the document while validating — that would trade a
 * brief flash of non-sensitive roadmap text for a permanently blank page whenever
 * this script fails to run.
 */
(function () {
  'use strict';

  var LOGIN = '/admin';

  async function requireAdminSession() {
    var token = '';
    try {
      token = (window.CD1AdminSession && CD1AdminSession.getToken && CD1AdminSession.getToken()) || '';
    } catch (_) { token = ''; }

    var headers = { 'Content-Type': 'application/json' };
    // Send the header only when this tab actually holds a token; otherwise the
    // request rides on the HttpOnly cookie alone.
    if (token) headers['x-admin-key'] = token;

    var payload = { action: 'validate' };
    if (token) payload.token = token;

    try {
      var res = await fetch('/.netlify/functions/admin-auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: headers,
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (data.ok) {
        try { CD1AdminSession.syncWindowKey(); } catch (_) { /* optional */ }
        return;
      }
      // The server refused this session. Clearing broadcasts a logout to sibling
      // tabs, which is correct here and only here — the session really is dead.
      try {
        if (window.CD1AdminSession && typeof CD1AdminSession.clearToken === 'function') {
          CD1AdminSession.clearToken();
        }
      } catch (_) { /* best effort; the redirect is what matters */ }
      location.replace(LOGIN);
    } catch (_) {
      // Network or parse failure: leave the operator on the page rather than
      // bouncing them to login. Every data call still 401s without a session.
    }
  }

  requireAdminSession();
})();
