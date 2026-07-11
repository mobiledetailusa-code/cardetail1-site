/** Cardetail1 Revenue event layer — first-party + optional GTM/Clarity adapters. */
(function (global) {
  'use strict';

  var SESSION_KEY = 'cd1_rev_session';
  var ATTR_KEY = 'cd1_rev_attr';
  var SENT_KEY = 'cd1_rev_sent';
  var BACKEND = '/.netlify/functions/revenue-event';

  var APPROVED_PROPS = {
    event_id: 1, anonymous_session_id: 1, timestamp: 1, source_page: 1, landing_page: 1,
    page_type: 1, category: 1, package_id: 1, estimated_value: 1, currency: 1,
    vehicle_count_band: 1, asset_category_count: 1, zip_zone: 1, booking_step: 1,
    vehicle_type: 1, device_type: 1, utm_source: 1, utm_medium: 1, utm_campaign: 1,
    utm_content: 1, referrer_domain: 1, lead_temperature: 1, household_segment: 1,
    error_code: 1, offer_id: 1, multi_vehicle_band: 1,
  };

  var GA4_MAP = {
    lead_created: 'generate_lead', lead_qualified: 'qualify_lead', lead_lost: 'close_unconvert_lead',
    lead_contacted: 'working_lead', booking_confirmed: 'close_convert_lead', service_completed: 'close_convert_lead',
    package_view: 'view_item', package_selected: 'select_item', offer_viewed: 'view_promotion',
    promotion_selected: 'select_promotion', booking_started: 'begin_checkout',
    payment_method_saved: 'add_payment_info',
  };

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'evt_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function getSessionId() {
    try {
      var s = sessionStorage.getItem(SESSION_KEY);
      if (s) return s;
      s = 'sess_' + uuid();
      sessionStorage.setItem(SESSION_KEY, s);
      return s;
    } catch (e) {
      return 'sess_fallback';
    }
  }

  function parseQuery() {
    var q = {};
    try {
      global.location.search.slice(1).split('&').forEach(function (pair) {
        var p = pair.split('=');
        if (p[0]) q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
    } catch (e) { /* ignore */ }
    return q;
  }

  function captureAttribution() {
    try {
      var existing = JSON.parse(localStorage.getItem(ATTR_KEY) || 'null');
      var q = parseQuery();
      var now = new Date().toISOString();
      var ref = document.referrer || '';
      var refDomain = '';
      try { refDomain = ref ? new URL(ref).hostname : ''; } catch (e) { refDomain = ''; }

      var touch = {
        utm_source: q.utm_source || null,
        utm_medium: q.utm_medium || null,
        utm_campaign: q.utm_campaign || null,
        utm_content: q.utm_content || null,
        referrer_domain: refDomain || null,
        landing_page: global.location.pathname,
        first_seen_at: existing && existing.first_seen_at ? existing.first_seen_at : now,
        last_seen_at: now,
      };

      // Advertising click IDs stored first-party only — never sent to GA4/Clarity
      var clickIds = {
        gclid: q.gclid || (existing && existing.gclid) || null,
        gbraid: q.gbraid || (existing && existing.gbraid) || null,
        wbraid: q.wbraid || (existing && existing.wbraid) || null,
        msclkid: q.msclkid || (existing && existing.msclkid) || null,
        fbclid: q.fbclid || (existing && existing.fbclid) || null,
      };

      var merged = Object.assign({}, existing || {}, touch, clickIds);
      if (!existing || !existing.first_touch) {
        merged.first_touch = Object.assign({}, touch, clickIds);
      }
      merged.last_touch = Object.assign({}, touch, clickIds);
      localStorage.setItem(ATTR_KEY, JSON.stringify(merged));
      return merged;
    } catch (e) {
      return {};
    }
  }

  function sanitizeProps(props) {
    var out = {};
    Object.keys(props || {}).forEach(function (k) {
      if (!APPROVED_PROPS[k]) return;
      var v = props[k];
      if (v == null) return;
      if (typeof v === 'string') out[k] = v.slice(0, 256);
      else if (typeof v === 'number' && isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean') out[k] = v;
    });
    return out;
  }

  function alreadySent(eventId) {
    try {
      var sent = JSON.parse(sessionStorage.getItem(SENT_KEY) || '{}');
      return !!sent[eventId];
    } catch (e) { return false; }
  }

  function markSent(eventId) {
    try {
      var sent = JSON.parse(sessionStorage.getItem(SENT_KEY) || '{}');
      sent[eventId] = 1;
      sessionStorage.setItem(SENT_KEY, JSON.stringify(sent));
    } catch (e) { /* ignore */ }
  }

  function pushDataLayer(eventName, props) {
    if (!global.dataLayer) global.dataLayer = [];
    var ga4 = GA4_MAP[eventName];
    if (ga4) {
      global.dataLayer.push({ event: ga4, cardetail1_event: eventName, params: props });
    }
    global.dataLayer.push({ event: 'cardetail1_' + eventName, cardetail1_event: eventName, params: props });
  }

  function pushClarity(eventName, props) {
    if (typeof global.clarity !== 'function') return;
    try { global.clarity('event', eventName); } catch (e) { /* ignore */ }
    ['page_type', 'category', 'package_id', 'booking_step', 'household_segment', 'lead_temperature', 'vehicle_count_band'].forEach(function (k) {
      if (props[k] != null) {
        try { global.clarity('set', k, String(props[k])); } catch (e2) { /* ignore */ }
      }
    });
  }

  function sendFirstParty(eventName, eventId, props) {
    var payload = {
      event: eventName,
      event_id: eventId,
      anonymous_session_id: getSessionId(),
      properties: props,
    };
    try {
      fetch(BACKEND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () { /* fail safe */ });
    } catch (e) { /* ignore */ }
  }

  function initAdapters() {
    var consent = global.Cardetail1Consent ? global.Cardetail1Consent.getConsent() : { analytics: false, marketing: false };
    var gtmId = global.CD1_GTM_CONTAINER_ID || '';
    var gaId = global.CD1_GA4_MEASUREMENT_ID || '';
    var clarityId = global.CD1_CLARITY_PROJECT_ID || '';

    if (consent.analytics && gtmId && !document.getElementById('cd1-gtm')) {
      global.dataLayer = global.dataLayer || [];
      var s = document.createElement('script');
      s.id = 'cd1-gtm';
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(gtmId);
      document.head.appendChild(s);
    } else if (consent.analytics && gaId && !global.gtag && !gtmId) {
      var g = document.createElement('script');
      g.async = true;
      g.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gaId);
      document.head.appendChild(g);
      global.dataLayer = global.dataLayer || [];
      global.gtag = function () { global.dataLayer.push(arguments); };
      global.gtag('js', new Date());
      global.gtag('config', gaId, { anonymize_ip: true });
    }

    if (consent.analytics && clarityId && !document.getElementById('cd1-clarity')) {
      var c = document.createElement('script');
      c.id = 'cd1-clarity';
      c.async = true;
      c.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(clarityId);
      document.head.appendChild(c);
    }
  }

  function track(eventName, properties) {
    try {
      if (!eventName) return;
      var eventId = (properties && properties.event_id) || uuid();
      if (alreadySent(eventId)) return;

      var attr = captureAttribution();
      var props = sanitizeProps(Object.assign({}, properties || {}, {
        event_id: eventId,
        anonymous_session_id: getSessionId(),
        timestamp: new Date().toISOString(),
        source_page: global.location.pathname,
        landing_page: (attr.first_touch && attr.first_touch.landing_page) || attr.landing_page || global.location.pathname,
        utm_source: attr.utm_source || undefined,
        utm_medium: attr.utm_medium || undefined,
        utm_campaign: attr.utm_campaign || undefined,
        utm_content: attr.utm_content || undefined,
        referrer_domain: attr.referrer_domain || undefined,
        device_type: global.innerWidth <= 768 ? 'mobile' : 'desktop',
      }));

      markSent(eventId);
      sendFirstParty(eventName, eventId, props);

      var consent = global.Cardetail1Consent ? global.Cardetail1Consent.getConsent() : { analytics: false, marketing: false };
      if (consent.analytics) {
        pushDataLayer(eventName, props);
        pushClarity(eventName, props);
      }
    } catch (e) {
      /* never break booking */
    }
  }

  function initPageView(pageType) {
    captureAttribution();
    var ev = 'page_view';
    if (pageType === 'service') ev = 'service_page_view';
    else if (pageType === 'city') ev = 'city_page_view';
    else if (pageType === 'hub') ev = 'hub_page_view';
    track(ev, { page_type: pageType || 'home' });
  }

  global.Cardetail1Revenue = {
    track: track,
    initAdapters: initAdapters,
    initPageView: initPageView,
    captureAttribution: captureAttribution,
    getSessionId: getSessionId,
  };
})(typeof window !== 'undefined' ? window : globalThis);
