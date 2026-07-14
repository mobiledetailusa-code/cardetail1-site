// Shared near-real-time refresh for Admin, Technician, and My Garage portals.
(function (global) {
  const DEFAULT_POLL_MS = 20000;
  let inflight = null;
  let pollTimer = null;
  let lastUpdated = null;

  function createRefreshController(options) {
    const pollMs = options.pollMs || DEFAULT_POLL_MS;
    const onRefresh = options.onRefresh || (async () => {});
    const onUpdated = options.onUpdated || (() => {});
    const shouldPoll = options.shouldPoll || (() => true);

    async function refresh(reason) {
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          await onRefresh(reason || 'manual');
          lastUpdated = new Date();
          onUpdated(lastUpdated);
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    }

    function startPolling() {
      stopPolling();
      pollTimer = setInterval(() => {
        if (document.hidden) return;
        if (!shouldPoll()) return;
        refresh('poll');
      }, pollMs);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function bindLifecycle() {
      global.addEventListener('focus', () => refresh('focus'));
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refresh('visibility');
      });
      startPolling();
    }

    return { refresh, startPolling, stopPolling, bindLifecycle, getLastUpdated: () => lastUpdated };
  }

  global.CD1OperationalRefresh = { createRefreshController, DEFAULT_POLL_MS };
})(typeof window !== 'undefined' ? window : global);
