/**
 * Client booking-progress snapshot for resume links.
 * Reuses localStorage (same store family as cd1_zip / cd1_bookings).
 * Never stores card numbers, Stripe tokens, or payment secrets.
 */
(function (global) {
  'use strict';

  var KEY = 'cd1_booking_progress';
  var TTL_MS = 72 * 60 * 60 * 1000;
  var CONTACT_IDS = ['f-first', 'f-last', 'f-phone', 'f-email', 'f-addr', 'f-date', 'f-notes', 'f-location', 'f-arrival-window', 'f-water', 'f-electric'];
  var CAT_LABELS = {
    cars: 'Cars & SUVs',
    boats: 'Boat Detailing',
    rvs: 'RV Detailing',
    powersports: 'Powersports',
  };

  function storageGet() {
    try {
      return global.localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function storageSet(raw) {
    try {
      global.localStorage.setItem(KEY, raw);
    } catch (e) { /* quota / private mode */ }
  }

  function storageClear() {
    try {
      global.localStorage.removeItem(KEY);
    } catch (e) { /* ignore */ }
  }

  function readContactFields(doc) {
    doc = doc || global.document;
    var fields = {};
    if (!doc) return fields;
    CONTACT_IDS.forEach(function (id) {
      var el = doc.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') fields[id] = !!el.checked;
      else fields[id] = String(el.value || '');
    });
    return fields;
  }

  function applyContactFields(fields, doc) {
    doc = doc || global.document;
    if (!doc || !fields) return;
    Object.keys(fields).forEach(function (id) {
      var el = doc.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!fields[id];
      else el.value = fields[id] == null ? '' : String(fields[id]);
    });
  }

  function snapshotFromLive() {
    var ST = global.ST || {};
    var doc = global.document;
    var zipEl = doc && doc.getElementById('bk-zip');
    var zip = zipEl ? String(zipEl.value || '').replace(/\D/g, '').slice(0, 5) : '';
    return {
      v: 1,
      savedAt: Date.now(),
      step: Number(global.currentBkStep) || 1,
      zip: zip,
      pendingCat: ST._pendingCat || '',
      forceMulti: ST._forceMultiVehicle === true,
      ST: {
        cat: ST.cat || '',
        pkgId: ST.pkgId || '',
        vehicles: Array.isArray(ST.vehicles) ? ST.vehicles : [],
        addons: Array.isArray(ST.addons) ? ST.addons : [],
        lengthFt: Number(ST.lengthFt) || 0,
        rvType: ST.rvType || '',
        boatType: ST.boatType || '',
        rvLiving: ST.rvLiving || '',
        units: Number(ST.units) || 1,
        vehicleLabel: ST.vehicleLabel || '',
        tierKey: ST.tierKey || '',
      },
      fields: readContactFields(doc),
    };
  }

  function persist() {
    if (global.ST && global.ST.bookingPersisted) {
      storageClear();
      return null;
    }
    var snap = snapshotFromLive();
    storageSet(JSON.stringify(snap));
    return snap;
  }

  function load() {
    var raw = storageGet();
    if (!raw) return null;
    try {
      var snap = JSON.parse(raw);
      if (!snap || snap.v !== 1) return null;
      if (snap.savedAt && Date.now() - Number(snap.savedAt) > TTL_MS) {
        storageClear();
        return null;
      }
      return snap;
    } catch (e) {
      return null;
    }
  }

  function hasVehicle(state) {
    var st = (state && state.ST) || {};
    if (st.vehicleLabel) return true;
    if (st.tierKey) return true;
    if (Number(st.lengthFt) >= 12) return true;
    if (Array.isArray(st.vehicles) && st.vehicles.length) return true;
    return false;
  }

  function hasRequiredContact(state) {
    var f = (state && state.fields) || {};
    return !!(String(f['f-first'] || '').trim()
      && String(f['f-last'] || '').trim()
      && String(f['f-phone'] || '').trim()
      && String(f['f-email'] || '').trim()
      && String(f['f-addr'] || '').trim()
      && String(f['f-date'] || '').trim());
  }

  /**
   * Never trust step=N. Return the highest complete step that existing state supports.
   * Request Sent (6) is success-only and is never a resume target.
   */
  function highestSafeStep(state, requested, zipOk) {
    if (zipOk === false) return 1;
    var st = (state && state.ST) || {};
    var computed = 1;
    if (st.cat) computed = 2;
    if (st.cat && st.pkgId) computed = 3;
    if (st.cat && st.pkgId && hasVehicle(state)) computed = 4;
    if (st.cat && st.pkgId && hasVehicle(state) && hasRequiredContact(state)) computed = 5;
    var want = Number(requested);
    if (!Number.isFinite(want) || want < 1) want = computed;
    if (want > 5) want = 5;
    return Math.max(1, Math.min(want, computed));
  }

  function categoryLabel(cat) {
    return CAT_LABELS[cat] || '';
  }

  function showPendingIntent(cat) {
    var doc = global.document;
    if (!doc) return;
    var banner = doc.getElementById('bk-intent-banner');
    var gate = doc.getElementById('bk-gate-msg');
    var label = categoryLabel(cat);
    if (banner) {
      if (label) {
        banner.hidden = false;
        banner.textContent = 'You selected ' + label;
      } else {
        banner.hidden = true;
        banner.textContent = '';
      }
    }
    if (gate && label && !gate.classList.contains('unlocked')) {
      gate.innerHTML = '<span class="zg-ico">📍</span><span>First, let\'s make sure we serve your location. Enter your 5-digit ZIP to continue with ' + label + '.</span>';
    }
  }

  function hidePendingIntent() {
    var doc = global.document;
    if (!doc) return;
    var banner = doc.getElementById('bk-intent-banner');
    if (banner) {
      banner.hidden = true;
      banner.textContent = '';
    }
  }

  function applySnapshot(snap) {
    if (!snap) return false;
    var ST = global.ST;
    var doc = global.document;
    if (!ST || !doc) return false;
    ST._restoring = true;
    try {
      if (snap.forceMulti) ST._forceMultiVehicle = true;
      if (snap.zip && snap.zip.length === 5) {
        var zipEl = doc.getElementById('bk-zip');
        var heroZip = doc.getElementById('hero-zip');
        if (zipEl) zipEl.value = snap.zip;
        if (heroZip) heroZip.value = snap.zip;
        try {
          global.localStorage.setItem('cd1_zip', snap.zip);
          global.sessionStorage.setItem('cd1_zip', snap.zip);
        } catch (eZip) { /* ignore */ }
        if (typeof global.onBkZipInput === 'function') global.onBkZipInput(snap.zip);
      }
      var st = snap.ST || {};
      if (st.lengthFt) ST.lengthFt = st.lengthFt;
      if (st.rvType) ST.rvType = st.rvType;
      if (st.boatType) ST.boatType = st.boatType;
      if (st.rvLiving) ST.rvLiving = st.rvLiving;
      if (st.units) ST.units = st.units;
      if (st.vehicleLabel) ST.vehicleLabel = st.vehicleLabel;
      if (st.tierKey) ST.tierKey = st.tierKey;
      if (Array.isArray(st.vehicles)) ST.vehicles = st.vehicles;
      if (Array.isArray(st.addons)) ST.addons = st.addons;
      var cat = st.cat || snap.pendingCat || '';
      if (cat && typeof global.selectCategory === 'function') {
        if (st.pkgId) ST._prefillPkgId = st.pkgId;
        ST._startStep = null;
        global.selectCategory(cat);
      }
      if (st.pkgId && ST.cat && typeof global.selectPkg === 'function') {
        global.selectPkg(st.pkgId);
      }
      applyContactFields(snap.fields, doc);
      if (typeof global.renderVehicleCart === 'function') global.renderVehicleCart();
      return true;
    } finally {
      setTimeout(function () {
        ST._restoring = false;
        persist();
      }, 250);
    }
  }

  function resumeFromQuery() {
    var params;
    try {
      params = new URLSearchParams(global.location.search || '');
    } catch (e) {
      params = null;
    }
    if (!params || params.get('resume') !== '1') return { opened: false, reason: 'not_resume' };
    var snap = load();
    var requested = Number(params.get('step') || params.get('start') || 0);
    if (typeof global.openBooking === 'function') {
      global.__cd1SkipRoutingGate = true;
      try { global.openBooking(null); }
      finally { global.__cd1SkipRoutingGate = false; }
    }
    if (!snap) {
      if (typeof global.bkGoTo === 'function') global.bkGoTo(1);
      return { opened: true, restored: false, step: 1 };
    }
    applySnapshot(snap);
    var zipOk = !!global.activeZone;
    var safe = highestSafeStep(snap, requested, zipOk);
    if (!zipOk && snap.ST && snap.ST.cat) showPendingIntent(snap.ST.cat);
    if (typeof global.bkGoTo === 'function') global.bkGoTo(safe);
    return { opened: true, restored: true, step: safe };
  }

  function bindFieldPersistence() {
    var doc = global.document;
    if (!doc || bindFieldPersistence._bound) return;
    bindFieldPersistence._bound = true;
    CONTACT_IDS.forEach(function (id) {
      var el = doc.getElementById(id);
      if (!el) return;
      el.addEventListener('change', persist);
      el.addEventListener('blur', persist);
    });
  }

  global.CD1BookingProgress = {
    KEY: KEY,
    CONTACT_IDS: CONTACT_IDS,
    CAT_LABELS: CAT_LABELS,
    persist: persist,
    load: load,
    clear: storageClear,
    highestSafeStep: highestSafeStep,
    snapshotFromLive: snapshotFromLive,
    applySnapshot: applySnapshot,
    resumeFromQuery: resumeFromQuery,
    showPendingIntent: showPendingIntent,
    hidePendingIntent: hidePendingIntent,
    categoryLabel: categoryLabel,
    bindFieldPersistence: bindFieldPersistence,
  };

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', bindFieldPersistence);
    } else {
      bindFieldPersistence();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
