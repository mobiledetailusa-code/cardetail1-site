/**
 * Browser client for the operational availability contract.
 * Resolves slots using the same rules as netlify/lib/operational-availability.js
 * when a public snapshot is loaded. Falls back to complete legacy behavior.
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
    let slots = [];
    if (!snap || !state.loaded) {
      // Complete legacy fallback
      if (p.day === 0) slots = [];
      else if (p.day === 6) slots = SAT.slice();
      else slots = WEEKDAY.slice();
    } else {
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
      } else if (p.day === 0) {
        slots = [];
      } else if (p.day === 6) {
        slots = (snap.saturdaySlots || SAT).slice();
      }
    }
    return filterSameDaySlots(p.iso, slots);
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
    filterSameDaySlots,
    nearby,
    WEEKDAY,
    SAT,
    LABEL,
    SAME_DAY_LEAD_MINUTES: DEFAULT_SAME_DAY_LEAD_MINUTES,
    get loaded() { return state.loaded; },
    get snapshot() { return state.snapshot; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
