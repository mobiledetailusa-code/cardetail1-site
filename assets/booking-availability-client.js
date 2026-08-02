/**
 * Browser client for the operational availability contract.
 * Resolves slots using the same rules as netlify/lib/operational-availability.js
 * when a public snapshot is loaded. Falls back to complete legacy behavior.
 */
(function (root) {
  const WEEKDAY = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];
  const SAT = ['8:00 AM', '10:00 AM'];
  const LABEL = 'Limited weekend availability';

  function isoParts(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) return null;
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    const date = new Date(y, mo - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return { y, mo, d, day: date.getDay(), iso: m[1] + '-' + m[2] + '-' + m[3] };
  }

  const state = {
    loaded: false,
    snapshot: null,
    loadError: null,
  };

  function applySnapshot(snap) {
    if (!snap || snap.ok === false) {
      state.loaded = false;
      state.snapshot = null;
      return;
    }
    state.snapshot = snap;
    state.loaded = true;
    state.loadError = null;
  }

  async function load() {
    try {
      const res = await fetch('/.netlify/functions/booking-availability', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('availability_http_' + res.status);
      const data = await res.json();
      applySnapshot(data);
      return data;
    } catch (err) {
      state.loadError = String(err && err.message || err);
      state.loaded = false;
      state.snapshot = null;
      return null;
    }
  }

  function mode() {
    return (state.snapshot && state.snapshot.weekendMode) || 'legacy';
  }

  function customerWeekendLabel() {
    return (state.snapshot && state.snapshot.customerWeekendLabel) || null;
  }

  function earliestBookable() {
    if (state.snapshot && state.snapshot.earliestBookable) return state.snapshot.earliestBookable;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + mo + '-' + day;
  }

  function slotsForDate(iso) {
    const p = isoParts(iso);
    if (!p) return [];
    const snap = state.snapshot;
    if (!snap || !state.loaded) {
      // Complete legacy fallback
      if (p.day === 0) return [];
      if (p.day === 6) return SAT.slice();
      return WEEKDAY.slice();
    }
    const ov = snap.dateOverrides && snap.dateOverrides[p.iso];
    if (ov) {
      if (!ov.enabled) return [];
      if (Array.isArray(ov.arrivalWindows) && ov.arrivalWindows.length) return ov.arrivalWindows.slice();
      if (p.day === 0 || p.day === 6) return (snap.saturdaySlots || SAT).slice();
      return (snap.weekdaySlots || WEEKDAY).slice();
    }
    if (p.day >= 1 && p.day <= 5) return (snap.weekdaySlots || WEEKDAY).slice();
    if (snap.weekendMode === 'supervised') return [];
    if (p.day === 0) return [];
    if (p.day === 6) return (snap.saturdaySlots || SAT).slice();
    return [];
  }

  async function nearby(fromDate, limit) {
    try {
      const params = new URLSearchParams({
        action: 'nearby',
        fromDate: String(fromDate || ''),
        limit: String(limit || 6),
      });
      const res = await fetch('/.netlify/functions/booking-availability?' + params.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('nearby_http_' + res.status);
      return await res.json();
    } catch (_) {
      return { ok: false, openings: [] };
    }
  }

  root.BkAvailability = {
    load,
    applySnapshot,
    mode,
    customerWeekendLabel,
    earliestBookable,
    slotsForDate,
    nearby,
    WEEKDAY,
    SAT,
    LABEL,
    get loaded() { return state.loaded; },
    get snapshot() { return state.snapshot; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
