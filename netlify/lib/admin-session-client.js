// Browser admin session helper — sessionStorage with TTL (matches server 8h admin session).
(function (global) {
  const SESS_KEY = 'cd1_admin_sess';
  const LEGACY_KEY = 'cd1_admin_key';
  const TTL_MS = 8 * 60 * 60 * 1000;

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

  function clearToken() {
    try {
      sessionStorage.removeItem(SESS_KEY);
      sessionStorage.removeItem(LEGACY_KEY);
    } catch (_) {}
  }

  function syncWindowKey() {
    if (typeof global !== 'undefined') global._adminKey = getToken();
  }

  syncWindowKey();

  global.CD1AdminSession = { getToken, setToken, clearToken, syncWindowKey, SESS_KEY, LEGACY_KEY, TTL_MS };
})(typeof window !== 'undefined' ? window : global);
