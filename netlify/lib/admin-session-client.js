// Browser admin session helper.
// Authentication itself rides on the server-set HttpOnly `cd1_admin_session` cookie
// (shared across all same-origin tabs). This sessionStorage token is a same-tab
// convenience/back-compat copy only — it is NOT the sole auth mechanism, and a new
// tab with empty sessionStorage still authenticates via the cookie. A BroadcastChannel
// carries the non-secret "logout occurred" signal so other tabs can show a signed-out state.
(function (global) {
  const SESS_KEY = 'cd1_admin_sess';
  const LEGACY_KEY = 'cd1_admin_key';
  const TTL_MS = 8 * 60 * 60 * 1000;

  let channel = null;
  try {
    channel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('cd1-admin-session') : null;
  } catch (_) { channel = null; }

  function broadcastSession(type) {
    try { if (channel) channel.postMessage({ type: type }); } catch (_) {}
  }

  // Subscribe to non-secret cross-tab session events ({type:'logout'}). Returns an unsubscribe fn.
  function onSessionEvent(cb) {
    if (!channel || typeof cb !== 'function') return function () {};
    const handler = (ev) => { try { cb((ev && ev.data) || {}); } catch (_) {} };
    channel.addEventListener('message', handler);
    return function () { try { channel.removeEventListener('message', handler); } catch (_) {} };
  }

  function readSession() {
    try {
      const raw = sessionStorage.getItem(SESS_KEY);
      if (raw) {
        const sess = JSON.parse(raw);
        if (sess && sess.token && sess.expiresAt > Date.now()) return sess;
        sessionStorage.removeItem(SESS_KEY);
      }
      const legacy = sessionStorage.getItem(LEGACY_KEY);
      if (legacy && (legacy.startsWith('v1.') || /^[a-f0-9]{64}$/.test(legacy))) {
        const migrated = { token: legacy, expiresAt: Date.now() + TTL_MS };
        sessionStorage.setItem(SESS_KEY, JSON.stringify(migrated));
        sessionStorage.removeItem(LEGACY_KEY);
        return migrated;
      }
    } catch (_) {}
    return null;
  }

  function getToken() {
    const sess = readSession();
    return sess ? sess.token : '';
  }

  function setToken(token) {
    if (!token) return;
    try {
      sessionStorage.setItem(SESS_KEY, JSON.stringify({ token, expiresAt: Date.now() + TTL_MS }));
      sessionStorage.removeItem(LEGACY_KEY);
    } catch (_) {}
  }

  function clearToken(opts) {
    try {
      sessionStorage.removeItem(SESS_KEY);
      sessionStorage.removeItem(LEGACY_KEY);
    } catch (_) {}
    syncWindowKey();
    // Tell other same-origin tabs to sign out too (unless this is a silent, receiver-side clear).
    if (!(opts && opts.silent)) broadcastSession('logout');
  }

  function syncWindowKey() {
    if (typeof global !== 'undefined') global._adminKey = getToken();
  }

  syncWindowKey();

  global.CD1AdminSession = { getToken, setToken, clearToken, syncWindowKey, onSessionEvent, SESS_KEY, LEGACY_KEY, TTL_MS };
})(typeof window !== 'undefined' ? window : global);
