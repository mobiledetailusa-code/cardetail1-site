/**
 * Browser client for the operational availability contract.
 * Resolves slots using the same rules as netlify/lib/operational-availability.js
 * once the public snapshot is loaded.
 *
 * Fail closed: until the snapshot loads, and whenever it cannot be loaded or
 * the server reports the schedule as unavailable, no date is offered
 * (slotsForDate returns []). The server stays the final authority.
 */
(function (root) {
  const WEEKDAY = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];
  const SAT = ['8:00 AM', '10:00 AM'];
  const LABEL = 'Limited weekend availability';
  const DEFAULT_TZ = 'America/New_York';
  const DEFAULT_SAME_DAY_LEAD_MINUTES = 120;
  const SLOT_START_MINUTES = {
    '8:00 AM': 480,
    '10:00 AM': 600,
    '12:00 PM': 720,
    '2:00 PM': 840,
    '4:00 PM': 960,
  };

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

  function toIsoLocal(date) {
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return y + '-' + mo + '-' + day;
  }

  function businessTodayIso(timezone, now) {
    const tz = String(timezone || DEFAULT_TZ).trim() || DEFAULT_TZ;
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now || new Date());
    } catch (_) {
      return toIsoLocal(now || new Date());
    }
  }

  function businessMinutesNow(timezone, now) {
    const tz = String(timezone || DEFAULT_TZ).trim() || DEFAULT_TZ;
    const at = now || new Date();
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(at);
      const hour = Number((parts.find((p) => p.type === 'hour') || {}).value || 0);
      const minute = Number((parts.find((p) => p.type === 'minute') || {}).value || 0);
      return (hour * 60) + minute;
    } catch (_) {
      return (at.getHours() * 60) + at.getMinutes();
    }
  }

  function sameDayLeadMinutes() {
    const snap = state.snapshot;
    const n = snap && Number(snap.sameDayLeadMinutes);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SAME_DAY_LEAD_MINUTES;
  }

  function filterSameDaySlots(iso, slots, now) {
    const list = Array.isArray(slots) ? slots.slice() : [];
    const p = isoParts(iso);
    if (!p || !list.length) return list;
    const tz = (state.snapshot && state.snapshot.businessTimezone) || DEFAULT_TZ;
    const today = (state.snapshot && state.snapshot.today) || businessTodayIso(tz, now || new Date());
    if (p.iso !== today) return list;
    const cutoff = businessMinutesNow(tz, now || new Date()) + sameDayLeadMinutes();
    return list.filter((slot) => {
      const start = SLOT_START_MINUTES[slot];
      return start != null && start >= cutoff;
    });
  }

  const UNAVAILABLE_MSG = 'Live scheduling is temporarily unavailable, so no dates can be offered right now. Please try again in a minute, or call or text (551) 389-3986 and we will book you directly.';
  const RETRY_DELAY_MS = 800;

  const state = {
    loaded: false,
    snapshot: null,
    loadError: null,
    // 'loading' until the first answer, then 'available' or 'unavailable'.
    status: 'loading',
    unavailableMessage: null,
    closed: null,
  };

  function markUnavailable(reason, message) {
    state.loaded = false;
    state.snapshot = null;
    state.closed = null;
    state.status = 'unavailable';
    state.loadError = reason || 'availability_unavailable';
    state.unavailableMessage = message || UNAVAILABLE_MSG;
  }

  function applySnapshot(snap) {
    if (!snap || snap.ok === false) {
      markUnavailable((snap && snap.error) || 'availability_unavailable', snap && snap.userMessage);
      return;
    }
    state.snapshot = snap;
    state.closed = new Set(Array.isArray(snap.closedDates) ? snap.closedDates : []);
    state.loaded = true;
    state.status = 'available';
    state.loadError = null;
    state.unavailableMessage = null;
  }

  async function fetchSnapshot() {
    const res = await fetch('/.netlify/functions/booking-availability', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      const err = new Error((data && data.error) || ('availability_http_' + res.status));
      err.userMessage = data && data.userMessage;
      throw err;
    }
    return data;
  }

  async function load(opts) {
    const attempts = Math.max(1, Number(opts && opts.attempts) || 2);
    state.status = 'loading';
    let lastErr = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const data = await fetchSnapshot();
        applySnapshot(data);
        return data;
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    markUnavailable(String(lastErr && lastErr.message || lastErr), lastErr && lastErr.userMessage);
    return null;
  }

  function withinHorizon(iso) {
    const snap = state.snapshot;
    if (!snap || !snap.horizonEnd) return false;
    return iso >= (snap.horizonStart || snap.today || '') && iso <= snap.horizonEnd;
  }

  /** Known closed date (explicit closure or protected holiday) inside the published horizon. */
  function isClosedDate(iso) {
    const p = isoParts(iso);
    return !!(p && state.closed && state.closed.has(p.iso));
  }

  /** The live schedule explicitly opened this holiday. */
  function isHolidayOpening(iso) {
    const p = isoParts(iso);
    const ov = p && state.snapshot && state.snapshot.dateOverrides && state.snapshot.dateOverrides[p.iso];
    return !!(ov && ov.enabled && ov.holidayOpening === true);
  }

  function mode() {
    return (state.snapshot && state.snapshot.weekendMode) || 'legacy';
  }

  function customerWeekendLabel() {
    return (state.snapshot && state.snapshot.customerWeekendLabel) || null;
  }

  function earliestBookable() {
    if (state.snapshot && state.snapshot.earliestBookable) return state.snapshot.earliestBookable;
    const advance = state.snapshot && Number.isFinite(Number(state.snapshot.minAdvanceDays))
      ? Number(state.snapshot.minAdvanceDays)
      : 0;
    const tz = (state.snapshot && state.snapshot.businessTimezone) || DEFAULT_TZ;
    const today = businessTodayIso(tz, new Date());
    const p = isoParts(today);
    if (!p) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + advance);
      return toIsoLocal(d);
    }
    const d = new Date(p.y, p.mo - 1, p.d);
    d.setDate(d.getDate() + advance);
    return toIsoLocal(d);
  }

  function slotsForDate(iso) {
    const p = isoParts(iso);
    if (!p) return [];
    const snap = state.snapshot;
    // Fail closed: never guess a calendar the server did not confirm.
    if (!snap || !state.loaded) return [];
    // Explicit closures and protected holidays published by the server.
    if (state.closed && state.closed.has(p.iso)) return [];
    let slots = [];
    const ov = snap.dateOverrides && snap.dateOverrides[p.iso];
    if (ov) {
      if (!ov.enabled) return [];
      if (Array.isArray(ov.arrivalWindows) && ov.arrivalWindows.length) {
        slots = ov.arrivalWindows.slice();
      } else if (p.day === 0 || p.day === 6) {
        slots = (snap.saturdaySlots || SAT).slice();
      } else {
        slots = (snap.weekdaySlots || WEEKDAY).slice();
      }
    } else if (p.day >= 1 && p.day <= 5) {
      slots = (snap.weekdaySlots || WEEKDAY).slice();
    } else if (snap.weekendMode === 'supervised') {
      slots = [];
    } else if (p.day === 6) {
      slots = (snap.saturdaySlots || SAT).slice();
    }
    return filterSameDaySlots(p.iso, slots);
  }

  function appendDemand(params, demand) {
    const minutes = demand && Number(demand.durationMinutes);
    if (minutes > 0) params.set('durationMinutes', String(Math.round(minutes)));
    if (demand && demand.companionInterior) params.set('companionInterior', '1');
  }

  async function nearby(fromDate, limit, demand) {
    try {
      const params = new URLSearchParams({
        action: 'nearby',
        fromDate: String(fromDate || ''),
        limit: String(limit || 6),
      });
      appendDemand(params, demand);
      const res = await fetch('/.netlify/functions/booking-availability?' + params.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!res.ok) {
        if (data && data.error === 'availability_unavailable') markUnavailable(data.error, data.userMessage);
        return { ok: false, openings: [], error: (data && data.error) || ('nearby_http_' + res.status), userMessage: data && data.userMessage };
      }
      return data || { ok: false, openings: [] };
    } catch (_) {
      return { ok: false, openings: [] };
    }
  }

  async function selection(date, windowVal, demand) {
    try {
      const params = new URLSearchParams({
        action: 'selection',
        preferredDate: String(date || ''),
        preferredArrivalWindow: String(windowVal || ''),
      });
      appendDemand(params, demand);
      const res = await fetch('/.netlify/functions/booking-availability?' + params.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!res.ok) {
        if (data && data.error === 'availability_unavailable') markUnavailable(data.error, data.userMessage);
        return { ok: false, error: data && data.error, userMessage: data && data.userMessage };
      }
      return data || { ok: false };
    } catch (_) {
      return { ok: false };
    }
  }

  root.BkAvailability = {
    load,
    applySnapshot,
    mode,
    customerWeekendLabel,
    earliestBookable,
    slotsForDate,
    filterSameDaySlots,
    nearby,
    selection,
    isClosedDate,
    isHolidayOpening,
    withinHorizon,
    UNAVAILABLE_MSG,
    WEEKDAY,
    SAT,
    LABEL,
    SAME_DAY_LEAD_MINUTES: DEFAULT_SAME_DAY_LEAD_MINUTES,
    get loaded() { return state.loaded; },
    get snapshot() { return state.snapshot; },
    get status() { return state.status; },
    get unavailableMessage() { return state.unavailableMessage; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
