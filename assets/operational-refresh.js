// Shared near-real-time refresh for Admin, Technician, and My Garage portals.
(function (global) {
  'use strict';

  const DEFAULT_ACTIVE_POLL_MS = 2500;
  const DEFAULT_POLL_MS = 15000;
  const DEFAULT_MAX_BACKOFF_MS = 60000;
  const MIN_POLL_MS = 1000;
  const controllers = new Map();

  function positiveMs(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= MIN_POLL_MS ? Math.round(n) : fallback;
  }

  function normalizeRefreshResult(value) {
    if (value === false) return { ok: false, error: 'refresh_failed' };
    if (!value || typeof value !== 'object') return { ok: true, changed: true };
    return {
      ...value,
      ok: value.ok !== false,
      changed: value.changed !== false && value.notModified !== true,
    };
  }

  function statusOf(value) {
    const n = Number(value && (value.status || value.statusCode));
    return Number.isFinite(n) ? n : 0;
  }

  function retryAfterMsOf(value) {
    const direct = Number(value && value.retryAfterMs);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const seconds = Number(value && value.retryAfterSec);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }

  function createRefreshController(options) {
    options = options || {};
    const controllerKey = String(options.controllerKey || 'default');
    if (controllers.has(controllerKey)) return controllers.get(controllerKey);

    const win = options.window || global;
    const doc = options.document || win.document || { hidden: false, addEventListener: function () {} };
    const nav = options.navigator || win.navigator || { onLine: true };
    const setTimer = options.setTimeout || win.setTimeout.bind(win);
    const clearTimer = options.clearTimeout || win.clearTimeout.bind(win);
    const now = options.now || function () { return Date.now(); };
    const random = options.random || Math.random;
    const onRefresh = options.onRefresh || (async function () {});
    const onUpdated = options.onUpdated || function () {};
    const onStateChange = options.onStateChange || function () {};
    const onError = options.onError || function () {};
    const shouldPoll = options.shouldPoll || function () { return true; };
    const isPending = options.isPending || function () { return false; };
    const activePollMs = positiveMs(options.activePollMs, DEFAULT_ACTIVE_POLL_MS);
    const stablePollMs = positiveMs(options.stablePollMs || options.pollMs, DEFAULT_POLL_MS);
    const maxBackoffMs = positiveMs(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS);
    const requestTimeoutMs = positiveMs(options.requestTimeoutMs, 25000);

    let inflight = null;
    let abortController = null;
    let pollTimer = null;
    let pollDueAt = 0;
    let lastUpdated = null;
    let failures = 0;
    let generation = 0;
    let bound = false;
    let polling = false;
    let destroyed = false;
    let boostUntil = 0;
    let state = 'idle';
    let lastResult = null;
    const listeners = [];

    function online() {
      return nav.onLine !== false;
    }

    function visible() {
      return doc.hidden !== true && doc.visibilityState !== 'hidden';
    }

    function pending() {
      try { return now() < boostUntil || isPending() === true; }
      catch (_) { return now() < boostUntil; }
    }

    function notify(next, detail) {
      state = next;
      try {
        onStateChange({
          state: next,
          lastUpdated,
          failures,
          pending: pending(),
          ...(detail || {}),
        });
      } catch (_) { /* presentation callbacks cannot stop synchronization */ }
    }

    function stopTimer() {
      if (pollTimer) clearTimer(pollTimer);
      pollTimer = null;
      pollDueAt = 0;
    }

    function successDelay() {
      return pending() ? activePollMs : stablePollMs;
    }

    function errorDelay(errorLike) {
      const retryAfter = retryAfterMsOf(errorLike);
      if (retryAfter) return Math.min(maxBackoffMs, Math.max(MIN_POLL_MS, retryAfter));
      const base = Math.min(maxBackoffMs, successDelay() * Math.pow(2, Math.max(0, failures - 1)));
      const jitter = 0.8 + (Math.max(0, Math.min(1, Number(random()) || 0)) * 0.4);
      return Math.min(maxBackoffMs, Math.max(MIN_POLL_MS, Math.round(base * jitter)));
    }

    function schedule(delayMs) {
      stopTimer();
      if (!polling || destroyed || !online() || !visible()) return;
      if (!shouldPoll()) {
        notify('paused', { reason: 'should_not_poll' });
        return;
      }
      const delay = positiveMs(delayMs, successDelay());
      pollDueAt = now() + delay;
      pollTimer = setTimer(function () {
        pollTimer = null;
        pollDueAt = 0;
        refresh('poll');
      }, delay);
    }

    async function refresh(reason, refreshOptions) {
      refreshOptions = refreshOptions || {};
      const why = String(reason || 'manual');
      const supersede = refreshOptions.supersede === true;

      if (destroyed) return { ok: false, aborted: true, error: 'destroyed' };
      if (!online()) {
        notify('offline', { reason: why });
        stopTimer();
        return { ok: false, offline: true, status: 0 };
      }
      if (!visible() && why === 'poll') {
        notify('paused', { reason: 'hidden' });
        stopTimer();
        return { ok: false, paused: true };
      }

      if (inflight && !supersede) return inflight;
      if (inflight) {
        if (abortController) {
          try { abortController.abort(); } catch (_) { /* ignore */ }
        }
      }

      generation += 1;
      // A manual/focus refresh owns the next schedule; remove the previous due
      // timer so auth failures cannot leave an old automatic retry armed.
      stopTimer();
      const runGeneration = generation;
      const runAbortController = typeof win.AbortController === 'function'
        ? new win.AbortController()
        : null;
      abortController = runAbortController;
      let timedOut = false;
      const requestTimer = runAbortController ? setTimer(function () {
        timedOut = true;
        try { runAbortController.abort(); } catch (_) { /* ignore */ }
      }, requestTimeoutMs) : null;
      notify('updating', { reason: why });

      const run = (async function () {
        try {
          const raw = await onRefresh({
            reason: why,
            signal: runAbortController && runAbortController.signal,
            attempt: failures + 1,
          });
          if (runGeneration !== generation) return { ok: false, aborted: true, stale: true };

          const result = normalizeRefreshResult(raw);
          if (!result.ok) {
            const failure = new Error(result.error || 'refresh_failed');
            Object.assign(failure, result);
            throw failure;
          }

          failures = 0;
          lastResult = result;
          lastUpdated = new Date(now());
          try { onUpdated(lastUpdated, result); } catch (_) { /* ignore */ }
          notify('current', { reason: why, changed: result.changed, notModified: !!result.notModified });
          schedule(successDelay());
          return result;
        } catch (error) {
          if (runGeneration !== generation || ((error && error.name === 'AbortError') && !timedOut)) {
            return { ok: false, aborted: true };
          }

          if (timedOut) {
            error = new Error('timeout');
            error.status = 408;
          }

          failures += 1;
          const status = statusOf(error);
          const terminalAuth = status === 401 || status === 403;
          const delay = terminalAuth ? 0 : errorDelay(error);
          lastResult = { ok: false, error: error && error.message, status, retryAfterMs: delay };
          notify(terminalAuth ? 'unauthorized' : (online() ? 'retrying' : 'offline'), {
            reason: why,
            error: error && error.message,
            status,
            retryAfterMs: delay,
          });
          try { onError(error, { status, retryAfterMs: delay, failures }); } catch (_) { /* ignore */ }
          if (!terminalAuth) schedule(delay);
          return lastResult;
        } finally {
          if (requestTimer) clearTimer(requestTimer);
          if (inflight === run) {
            inflight = null;
            abortController = null;
          }
        }
      })();
      inflight = run;
      return run;
    }

    function startPolling() {
      polling = true;
      schedule(successDelay());
    }

    function stopPolling() {
      polling = false;
      stopTimer();
    }

    function addListener(target, type, handler) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler);
      listeners.push([target, type, handler]);
    }

    function bindLifecycle() {
      if (bound) return;
      bound = true;
      addListener(win, 'focus', function () {
        if (visible() && online()) refresh('focus', { supersede: true });
      });
      addListener(doc, 'visibilitychange', function () {
        if (!visible()) {
          stopTimer();
          if (abortController) {
            try { abortController.abort(); } catch (_) { /* ignore */ }
          }
          notify('paused', { reason: 'hidden' });
          return;
        }
        if (online()) refresh('visibility', { supersede: true });
      });
      addListener(win, 'online', function () {
        refresh('online', { supersede: true });
      });
      addListener(win, 'offline', function () {
        stopTimer();
        if (abortController) {
          try { abortController.abort(); } catch (_) { /* ignore */ }
        }
        notify('offline', { reason: 'offline' });
      });
      startPolling();
    }

    function markPending(durationMs) {
      const duration = positiveMs(durationMs, 30000);
      boostUntil = Math.max(boostUntil, now() + duration);
      if (polling && online() && visible()) {
        const delay = activePollMs;
        if (!pollTimer || !pollDueAt || pollDueAt - now() > delay) schedule(delay);
      }
    }

    function destroy() {
      destroyed = true;
      stopPolling();
      generation += 1;
      if (abortController) {
        try { abortController.abort(); } catch (_) { /* ignore */ }
      }
      listeners.forEach(function (entry) {
        if (entry[0] && typeof entry[0].removeEventListener === 'function') {
          entry[0].removeEventListener(entry[1], entry[2]);
        }
      });
      listeners.length = 0;
      if (controllers.get(controllerKey) === controller) controllers.delete(controllerKey);
    }

    const controller = {
      refresh,
      startPolling,
      stopPolling,
      bindLifecycle,
      markPending,
      destroy,
      getLastUpdated: function () { return lastUpdated; },
      getState: function () {
        return { state, failures, lastUpdated, lastResult, pending: pending(), pollDueAt };
      },
    };
    controllers.set(controllerKey, controller);
    return controller;
  }

  const api = {
    createRefreshController,
    normalizeRefreshResult,
    DEFAULT_ACTIVE_POLL_MS,
    DEFAULT_POLL_MS,
    DEFAULT_MAX_BACKOFF_MS,
  };
  global.CD1OperationalRefresh = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
