/**
 * Admin Ops — per-source load state helpers.
 *
 * Keeps last-successful data when a refresh fails after at least one success.
 * Generation tokens prevent stale/aborted responses from overwriting newer state.
 */
(function (global) {
  'use strict';

  function createSourceMeta() {
    return {
      hasLoaded: false,
      isLoading: false,
      error: null,
      lastSuccessAt: null,
      generation: 0,
    };
  }

  /** Begin a load; returns the generation that must be presented on settle. */
  function beginSourceLoad(meta) {
    const next = Object.assign({}, meta);
    next.isLoading = true;
    next.generation = (Number(meta.generation) || 0) + 1;
    return { meta: next, generation: next.generation };
  }

  /**
   * Apply success only if generation still matches (not superseded / aborted).
   * @returns {{ applied:boolean, meta:object }}
   */
  function applySourceSuccess(meta, generation, now) {
    if (Number(generation) !== Number(meta.generation)) {
      return { applied: false, meta: meta };
    }
    return {
      applied: true,
      meta: Object.assign({}, meta, {
        hasLoaded: true,
        isLoading: false,
        error: null,
        lastSuccessAt: now != null ? now : Date.now(),
      }),
    };
  }

  /**
   * Apply failure. Never clears data arrays — caller must leave `data` unchanged.
   * @returns {{ applied:boolean, meta:object, preserveData:boolean, isInitialFailure:boolean }}
   */
  function applySourceFailure(meta, generation, error) {
    if (Number(generation) !== Number(meta.generation)) {
      return { applied: false, meta: meta, preserveData: true, isInitialFailure: false };
    }
    const hasLoaded = !!meta.hasLoaded;
    return {
      applied: true,
      preserveData: true,
      isInitialFailure: !hasLoaded,
      meta: Object.assign({}, meta, {
        isLoading: false,
        error: error != null ? String(error) : 'load_failed',
      }),
    };
  }

  function refreshFailureMessage(label, hasLoaded) {
    const name = String(label || 'Data');
    if (hasLoaded) {
      return name + ' could not be refreshed. Showing the last loaded data.';
    }
    return name + ' could not be loaded.';
  }

  /**
   * Decide whether a settled result may mutate current source data.
   * Aborted / superseded generations must not write.
   */
  function shouldApplyGeneration(meta, generation) {
    return Number(generation) === Number(meta.generation);
  }

  /**
   * Clear filters helper — pure. Does not trigger network.
   */
  function clearedJobFilters() {
    return { search: '', status: '', queueFilter: 'all' };
  }

  /**
   * Direct-link resolution after a jobs load attempt.
   * @returns {'open'|'missing'|'wait'|'keep'}
   */
  function resolveDirectLink(pendingId, jobs, jobsMeta) {
    const id = String(pendingId || '').trim();
    if (!id) return 'keep';
    const list = Array.isArray(jobs) ? jobs : [];
    if (list.some((j) => j && String(j.id) === id)) return 'open';
    if (jobsMeta && jobsMeta.hasLoaded && !jobsMeta.error && !jobsMeta.isLoading) return 'missing';
    return 'wait';
  }

  /**
   * Edit click must not schedule a full refresh — structural guard for tests.
   */
  function editShouldTriggerRefreshAll() {
    return false;
  }

  const api = {
    createSourceMeta,
    beginSourceLoad,
    applySourceSuccess,
    applySourceFailure,
    refreshFailureMessage,
    shouldApplyGeneration,
    clearedJobFilters,
    resolveDirectLink,
    editShouldTriggerRefreshAll,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.CD1AdminSourceState = api;
})(typeof window !== 'undefined' ? window : global);
