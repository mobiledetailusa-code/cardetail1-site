/**
 * Admin Ops — per-source load state helpers + last-known-good jobs snapshot.
 *
 * Keeps last-successful data when a refresh fails after at least one success.
 * Generation tokens prevent stale/aborted responses from overwriting newer state.
 *
 * The local snapshot is DISPLAY FALLBACK ONLY. It is never written back to the
 * server and must never carry auth/payment secrets.
 */
(function (global) {
  'use strict';

  var JOBS_SNAPSHOT_KEY = 'cardetail1.admin.jobs.lastKnownGood.v1';
  var JOBS_SNAPSHOT_SCHEMA = 1;
  var JOBS_SNAPSHOT_TTL_MS = 48 * 60 * 60 * 1000; // 48h
  var JOBS_SNAPSHOT_MAX_RECORDS = 80;

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
    var next = Object.assign({}, meta);
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
    var hasLoaded = !!meta.hasLoaded;
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
    var name = String(label || 'Data');
    if (hasLoaded) {
      return name + ' could not be refreshed. Showing the last loaded data.';
    }
    return name + ' could not be loaded.';
  }

  function shouldApplyGeneration(meta, generation) {
    return Number(generation) === Number(meta.generation);
  }

  function clearedJobFilters() {
    return { search: '', status: '', queueFilter: 'all' };
  }

  function resolveDirectLink(pendingId, jobs, jobsMeta) {
    var id = String(pendingId || '').trim();
    if (!id) return 'keep';
    var list = Array.isArray(jobs) ? jobs : [];
    if (list.some(function (j) { return j && String(j.id) === id; })) return 'open';
    if (jobsMeta && jobsMeta.hasLoaded && !jobsMeta.error && !jobsMeta.isLoading) return 'missing';
    return 'wait';
  }

  function editShouldTriggerRefreshAll() {
    return false;
  }

  function pickStr(v, max) {
    if (v == null) return '';
    var s = String(v);
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  }

  /** Minimal operational projection — no tokens, Stripe, ledger, or secrets. */
  function projectJobForSnapshot(job) {
    if (!job || typeof job !== 'object') return null;
    var id = pickStr(job.id || job.bookingId, 80);
    if (!id) return null;
    var address = pickStr(
      job.serviceAddress || job.address || job.requestedAddress || '',
      240
    );
    return {
      id: id,
      bookingId: pickStr(job.bookingId || job.id, 80),
      firstName: pickStr(job.firstName, 80),
      lastName: pickStr(job.lastName, 80),
      phone: pickStr(job.phone, 40),
      package: pickStr(job.package || job.service, 120),
      vehicleLabel: pickStr(job.vehicleLabel || job.vehicle, 160),
      vehicleCount: Number(job.vehicleCount) > 0 ? Math.round(Number(job.vehicleCount)) : undefined,
      preferredDate: pickStr(job.preferredDate || job.confirmedDate, 40),
      preferredTime: pickStr(job.preferredTime || job.confirmedTime, 40),
      confirmedDate: pickStr(job.confirmedDate, 40),
      confirmedTime: pickStr(job.confirmedTime, 40),
      confirmedTimeWindow: pickStr(job.confirmedTimeWindow, 80),
      serviceAddress: address,
      issueNotes: pickStr(job.issueNotes || job.notes, 240),
      jobStatus: pickStr(job.jobStatus, 64),
      assignedTechName: pickStr(job.assignedTechName, 80),
      _projection: 'admin_snapshot',
    };
  }

  function storage() {
    try {
      if (typeof global.localStorage !== 'undefined' && global.localStorage) return global.localStorage;
    } catch (_) {}
    return null;
  }

  function saveJobsSnapshot(jobs, savedAt) {
    var store = storage();
    if (!store) return false;
    try {
      var list = Array.isArray(jobs) ? jobs : [];
      var projected = [];
      for (var i = 0; i < list.length && projected.length < JOBS_SNAPSHOT_MAX_RECORDS; i++) {
        var row = projectJobForSnapshot(list[i]);
        if (row) projected.push(row);
      }
      var payload = {
        schemaVersion: JOBS_SNAPSHOT_SCHEMA,
        savedAt: savedAt != null ? Number(savedAt) : Date.now(),
        jobs: projected,
      };
      store.setItem(JOBS_SNAPSHOT_KEY, JSON.stringify(payload));
      return true;
    } catch (_) {
      try { store.removeItem(JOBS_SNAPSHOT_KEY); } catch (_2) {}
      return false;
    }
  }

  function clearJobsSnapshot() {
    var store = storage();
    if (!store) return;
    try { store.removeItem(JOBS_SNAPSHOT_KEY); } catch (_) {}
  }

  function loadJobsSnapshot(nowMs) {
    var store = storage();
    if (!store) return null;
    var raw;
    try {
      raw = store.getItem(JOBS_SNAPSHOT_KEY);
    } catch (_) {
      return null;
    }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('shape');
      if (Number(parsed.schemaVersion) !== JOBS_SNAPSHOT_SCHEMA) throw new Error('version');
      var savedAt = Number(parsed.savedAt);
      if (!Number.isFinite(savedAt) || savedAt <= 0) throw new Error('savedAt');
      var now = nowMs != null ? Number(nowMs) : Date.now();
      if (now - savedAt > JOBS_SNAPSHOT_TTL_MS) throw new Error('expired');
      if (!Array.isArray(parsed.jobs)) throw new Error('jobs');
      var jobs = [];
      for (var i = 0; i < parsed.jobs.length && jobs.length < JOBS_SNAPSHOT_MAX_RECORDS; i++) {
        var row = projectJobForSnapshot(parsed.jobs[i]);
        if (row) jobs.push(row);
      }
      return { savedAt: savedAt, jobs: jobs, schemaVersion: JOBS_SNAPSHOT_SCHEMA };
    } catch (_) {
      try { store.removeItem(JOBS_SNAPSHOT_KEY); } catch (_2) {}
      return null;
    }
  }

  function formatSnapshotAge(savedAt, nowMs) {
    var saved = Number(savedAt);
    if (!Number.isFinite(saved) || saved <= 0) return '';
    try {
      return new Date(saved).toLocaleString();
    } catch (_) {
      return '';
    }
  }

  function staleRefreshMessage(savedAt, isRefreshing) {
    var when = formatSnapshotAge(savedAt);
    if (isRefreshing) {
      return when
        ? ('Refreshing appointments… Showing data last updated ' + when + '.')
        : 'Refreshing appointments… Showing previously loaded data.';
    }
    return when
      ? ('Unable to refresh. Showing appointments last updated at ' + when + '.')
      : 'Unable to refresh. Showing previously loaded appointments.';
  }

  var api = {
    createSourceMeta: createSourceMeta,
    beginSourceLoad: beginSourceLoad,
    applySourceSuccess: applySourceSuccess,
    applySourceFailure: applySourceFailure,
    refreshFailureMessage: refreshFailureMessage,
    shouldApplyGeneration: shouldApplyGeneration,
    clearedJobFilters: clearedJobFilters,
    resolveDirectLink: resolveDirectLink,
    editShouldTriggerRefreshAll: editShouldTriggerRefreshAll,
    JOBS_SNAPSHOT_KEY: JOBS_SNAPSHOT_KEY,
    JOBS_SNAPSHOT_SCHEMA: JOBS_SNAPSHOT_SCHEMA,
    JOBS_SNAPSHOT_TTL_MS: JOBS_SNAPSHOT_TTL_MS,
    JOBS_SNAPSHOT_MAX_RECORDS: JOBS_SNAPSHOT_MAX_RECORDS,
    projectJobForSnapshot: projectJobForSnapshot,
    saveJobsSnapshot: saveJobsSnapshot,
    loadJobsSnapshot: loadJobsSnapshot,
    clearJobsSnapshot: clearJobsSnapshot,
    formatSnapshotAge: formatSnapshotAge,
    staleRefreshMessage: staleRefreshMessage,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.CD1AdminSourceState = api;
})(typeof window !== 'undefined' ? window : global);
