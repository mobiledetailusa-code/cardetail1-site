/** Cardetail1 Revenue event layer — first-party + optional GTM/Clarity adapters. */
(function (global) {
  'use strict';

  var SESSION_KEY = 'cd1_rev_session';
  var ATTR_KEY = 'cd1_rev_attr';
  var DELIVERY_KEY = 'cd1_rev_delivery_v2';
  var BACKEND = '/.netlify/functions/revenue-event';

  var DELIVERY_STATES = {
    PENDING: 'PENDING',
    SENT: 'SENT',
    TERMINAL_FAILURE: 'TERMINAL_FAILURE',
    RETRYABLE_FAILURE: 'RETRYABLE_FAILURE',
  };
  var MAX_ATTEMPTS = 4;
  var MAX_ACTIVE_EVENTS = 50;
  var MAX_STATE_EVENTS = 200;
  var MAX_RETRY_AFTER_MS = 120000;
  var RETRY_DELAYS_MS = [1000, 5000, 15000];
  var scheduled = {};
  var memoryState = { events: {} };

  // This list mirrors netlify/lib/revenue-event-schema.js. A parity test fails if
  // either side changes independently. Keeping unknown names client-terminal
  // prevents the browser from treating a guaranteed server rejection as sent.
  var APPROVED_EVENTS = {
    page_view: 1, service_page_view: 1, city_page_view: 1, hub_page_view: 1,
    offer_viewed: 1, promotion_selected: 1, package_view: 1, package_selected: 1,
    zip_check_started: 1, zip_check_valid: 1, zip_check_rejected: 1,
    booking_started: 1, booking_step_viewed: 1, booking_step_completed: 1,
    contact_captured: 1, vehicle_added: 1, multi_vehicle_detected: 1,
    garage_plan_started: 1, garage_plan_completed: 1,
    schedule_selected: 1, payment_step_viewed: 1, payment_method_saved: 1,
    booking_submitted: 1, booking_confirmed: 1, booking_error: 1, booking_closed: 1,
    booking_resumed: 1, quote_requested: 1, fleet_quote_requested: 1,
    click_call: 1, click_text: 1, chat_opened: 1, chat_pricing_question: 1,
    lead_created: 1, lead_qualified: 1, lead_contacted: 1, lead_lost: 1,
    service_completed: 1, maintenance_interest: 1, rebooking_started: 1,
    rebooking_completed: 1, referral_interest: 1, gift_card_interest: 1,
    flexible_payment_interest: 1,
    utilities_completed: 1, date_selected: 1, flexibility_selected: 1,
    weekend_date_selected: 1, selected_slot_unavailable: 1, nearby_slots_opened: 1,
    booking_review_reached: 1, setup_intent_started: 1,
    booking_submit_attempted: 1, booking_submit_succeeded: 1, booking_submit_failed: 1,
    arrival_window_selected: 1,
  };

  var APPROVED_PROPS = {
    event_id: 1, anonymous_session_id: 1, timestamp: 1, source_page: 1, landing_page: 1,
    page_type: 1, category: 1, package_id: 1, estimated_value: 1, currency: 1,
    vehicle_count_band: 1, asset_category_count: 1, zip_zone: 1, booking_step: 1,
    vehicle_type: 1, device_type: 1, utm_source: 1, utm_medium: 1, utm_campaign: 1,
    utm_content: 1, utm_term: 1, referrer_domain: 1, traffic_type: 1, first_seen_at: 1,
    booking_reference: 1, lead_temperature: 1, household_segment: 1,
    error_code: 1, offer_id: 1, multi_vehicle_band: 1, flexibility_mode: 1,
    weekend_selected: 1, funnel_step: 1, failure_code: 1, service_category: 1,
  };

  // Booking request, approval, and completed service stay distinct custom events.
  // A persisted request is not a GA4 purchase and is not a captured payment.
  var GA4_MAP = {
    lead_created: 'generate_lead', lead_qualified: 'qualify_lead', lead_lost: 'close_unconvert_lead',
    lead_contacted: 'working_lead',
    booking_confirmed: 'booking_confirmed', service_completed: 'service_completed',
    booking_submitted: 'booking_submitted',
    package_view: 'view_item', package_selected: 'select_item', offer_viewed: 'view_promotion',
    promotion_selected: 'select_promotion', booking_started: 'begin_checkout',
    payment_method_saved: 'add_payment_info',
  };

  var THIRD_PARTY_OMIT = {
    booking_reference: 1, gclid: 1, gbraid: 1, wbraid: 1, msclkid: 1, fbclid: 1,
    email: 1, phone: 1, name: 1, first_name: 1, last_name: 1, address: 1, notes: 1,
    customer_notes: 1, zip: 1, zip_code: 1,
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

  function decodeQueryPart(value) {
    try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); }
    catch (e) { return ''; }
  }

  function cleanAttr(value) {
    if (value == null) return null;
    var s = String(value).trim();
    return s ? s.slice(0, 256) : null;
  }

  function parseQuery() {
    var q = {};
    try {
      global.location.search.slice(1).split('&').forEach(function (pair) {
        if (!pair) return;
        var p = pair.split('=');
        if (p[0]) q[decodeQueryPart(p[0])] = decodeQueryPart(p.slice(1).join('='));
      });
    } catch (e) { /* ignore */ }
    return q;
  }

  function isOwnHost(host) {
    var h = String(host || '').toLowerCase();
    if (!h) return true;
    return h === 'cardetail1.com' || h === 'www.cardetail1.com'
      || h === 'localhost' || h === '127.0.0.1' || h.endsWith('.netlify.app');
  }

  function keepAttr(existing, key, incoming) {
    return cleanAttr(incoming) || cleanAttr(existing && existing[key]) || null;
  }

  function trafficType(attr) {
    attr = attr || {};
    var medium = String(attr.utm_medium || '').toLowerCase();
    var hasClick = !!(cleanAttr(attr.gclid) || cleanAttr(attr.gbraid) || cleanAttr(attr.wbraid));
    if (hasClick || medium === 'cpc' || medium === 'ppc' || medium === 'paid' || medium === 'paid_social') {
      return 'paid';
    }
    if (medium === 'organic') return 'organic';
    var ref = String(attr.referrer_domain || '').toLowerCase();
    if (/google\.|bing\.|yahoo\.|duckduckgo\./.test(ref)) return 'organic';
    if (ref || attr.utm_source || attr.utm_medium || attr.utm_campaign) return 'referral';
    return 'direct';
  }

  function captureAttribution() {
    try {
      var existing = null;
      try { existing = JSON.parse(localStorage.getItem(ATTR_KEY) || 'null'); } catch (eRead) { existing = null; }
      if (!existing || typeof existing !== 'object') existing = {};
      var q = parseQuery();
      var now = new Date().toISOString();
      var refDomain = '';
      try { refDomain = document.referrer ? new URL(document.referrer).hostname : ''; } catch (eRef) { refDomain = ''; }
      var externalRef = refDomain && !isOwnHost(refDomain) ? refDomain : null;
      var path = cleanAttr(global.location && global.location.pathname) || '/';

      // Internal navigations have no campaign query. Keep the stored touch
      // instead of writing null over utm_*, landing page, or the external referrer.
      // Click IDs stay in this object only and are omitted from GA4/Clarity.
      var merged = Object.assign({}, existing);
      merged.utm_source = keepAttr(existing, 'utm_source', q.utm_source);
      merged.utm_medium = keepAttr(existing, 'utm_medium', q.utm_medium);
      merged.utm_campaign = keepAttr(existing, 'utm_campaign', q.utm_campaign);
      merged.utm_content = keepAttr(existing, 'utm_content', q.utm_content);
      merged.utm_term = keepAttr(existing, 'utm_term', q.utm_term);
      merged.referrer_domain = cleanAttr(existing.referrer_domain) || externalRef || null;
      merged.landing_page = cleanAttr(existing.landing_page) || path;
      merged.first_seen_at = cleanAttr(existing.first_seen_at) || now;
      merged.last_seen_at = now;
      merged.gclid = keepAttr(existing, 'gclid', q.gclid);
      merged.gbraid = keepAttr(existing, 'gbraid', q.gbraid);
      merged.wbraid = keepAttr(existing, 'wbraid', q.wbraid);
      merged.msclkid = keepAttr(existing, 'msclkid', q.msclkid);
      merged.fbclid = keepAttr(existing, 'fbclid', q.fbclid);

      if (!existing.first_touch) {
        merged.first_touch = {
          utm_source: merged.utm_source,
          utm_medium: merged.utm_medium,
          utm_campaign: merged.utm_campaign,
          utm_content: merged.utm_content,
          utm_term: merged.utm_term,
          referrer_domain: merged.referrer_domain,
          landing_page: merged.landing_page,
          gclid: merged.gclid,
          gbraid: merged.gbraid,
          wbraid: merged.wbraid,
          first_seen_at: merged.first_seen_at,
        };
      }
      var hasNewCampaign = !!(cleanAttr(q.utm_source) || cleanAttr(q.utm_medium) || cleanAttr(q.utm_campaign)
        || cleanAttr(q.utm_content) || cleanAttr(q.utm_term) || cleanAttr(q.gclid) || cleanAttr(q.gbraid) || cleanAttr(q.wbraid));
      if (hasNewCampaign || !existing.last_touch) {
        merged.last_touch = {
          utm_source: cleanAttr(q.utm_source),
          utm_medium: cleanAttr(q.utm_medium),
          utm_campaign: cleanAttr(q.utm_campaign),
          utm_content: cleanAttr(q.utm_content),
          utm_term: cleanAttr(q.utm_term),
          referrer_domain: externalRef,
          landing_page: path,
          gclid: cleanAttr(q.gclid),
          gbraid: cleanAttr(q.gbraid),
          wbraid: cleanAttr(q.wbraid),
          seen_at: now,
        };
      }
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

  function nowMs() {
    return Date.now ? Date.now() : new Date().getTime();
  }

  function loadDeliveryState() {
    try {
      var raw = sessionStorage.getItem(DELIVERY_KEY);
      if (!raw) return memoryState;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.events || typeof parsed.events !== 'object') {
        return memoryState;
      }
      memoryState = parsed;
      return parsed;
    } catch (e) {
      return memoryState;
    }
  }

  function isActive(entry) {
    return !!entry && (entry.state === DELIVERY_STATES.PENDING || entry.state === DELIVERY_STATES.RETRYABLE_FAILURE);
  }

  function pruneDeliveryState(state) {
    var ids = Object.keys(state.events || {});
    if (ids.length <= MAX_STATE_EVENTS) return;
    ids.sort(function (a, b) {
      return Number(state.events[a].updatedAt || state.events[a].createdAt || 0)
        - Number(state.events[b].updatedAt || state.events[b].createdAt || 0);
    });
    ids.forEach(function (id) {
      if (Object.keys(state.events).length <= MAX_STATE_EVENTS) return;
      if (!isActive(state.events[id])) delete state.events[id];
    });
  }

  function saveDeliveryState(state) {
    memoryState = state;
    pruneDeliveryState(state);
    try {
      sessionStorage.setItem(DELIVERY_KEY, JSON.stringify(state));
    } catch (e) { /* fail safe: memory fallback keeps checkout non-blocking */ }
  }

  function deliveryStatus(eventId) {
    var entry = loadDeliveryState().events[eventId];
    if (!entry) return null;
    return {
      event_id: entry.eventId,
      event: entry.eventName,
      state: entry.state,
      attempts: entry.attempts || 0,
      next_attempt_at: entry.nextAttemptAt || null,
      failure: entry.lastFailure || null,
    };
  }

  function deliverySnapshot() {
    var counts = {};
    counts[DELIVERY_STATES.PENDING] = 0;
    counts[DELIVERY_STATES.SENT] = 0;
    counts[DELIVERY_STATES.TERMINAL_FAILURE] = 0;
    counts[DELIVERY_STATES.RETRYABLE_FAILURE] = 0;
    var state = loadDeliveryState();
    Object.keys(state.events).forEach(function (id) {
      var status = state.events[id] && state.events[id].state;
      if (counts[status] != null) counts[status] += 1;
    });
    return counts;
  }

  function safeLog(level, message, entry) {
    try {
      var logger = global.console && global.console[level];
      if (typeof logger !== 'function') return;
      logger.call(global.console, message, {
        event: entry && entry.eventName,
        event_id: entry && entry.eventId,
        attempts: entry && entry.attempts,
        failure: entry && entry.lastFailure,
      });
    } catch (e) { /* no customer-facing failure */ }
  }

  function thirdPartyProps(props) {
    var out = {};
    Object.keys(props || {}).forEach(function (k) {
      if (THIRD_PARTY_OMIT[k]) return;
      out[k] = props[k];
    });
    return out;
  }

  function pushDataLayer(eventName, props) {
    if (!global.dataLayer) global.dataLayer = [];
    var safe = thirdPartyProps(props);
    var ga4 = GA4_MAP[eventName];
    if (ga4 && ga4 !== eventName && ga4 !== 'purchase') {
      global.dataLayer.push({ event: ga4, cardetail1_event: eventName, params: safe });
    }
    global.dataLayer.push({ event: 'cardetail1_' + eventName, cardetail1_event: eventName, params: safe });
  }

  function pushGa4(eventName, props) {
    // gtag config already records the automatic page view. A second page_view
    // would double-count the visit. Direct GA4 is skipped when GTM is present.
    if (eventName === 'page_view') return;
    var consent = global.Cardetail1Consent ? global.Cardetail1Consent.getConsent() : { analytics: false };
    if (!consent || !consent.analytics) return;
    if (global.CD1_GTM_CONTAINER_ID) return;
    if (!global.CD1_GA4_MEASUREMENT_ID || !global.__cd1Ga4Configured) return;
    var ga4Name = GA4_MAP[eventName] || eventName;
    if (!ga4Name || ga4Name === 'purchase') return;
    ensureGtag();
    global.gtag('event', ga4Name, thirdPartyProps(props));
  }

  function pushClarity(eventName, props) {
    if (typeof global.clarity !== 'function') return;
    var safe = thirdPartyProps(props);
    try { global.clarity('event', eventName); } catch (e) { /* ignore */ }
    ['page_type', 'category', 'package_id', 'booking_step', 'household_segment', 'lead_temperature', 'vehicle_count_band', 'traffic_type'].forEach(function (k) {
      if (safe[k] != null) {
        try { global.clarity('set', k, String(safe[k])); } catch (e2) { /* ignore */ }
      }
    });
  }

  function isGa4MeasurementId(value) {
    return /^G-[A-Z0-9]{4,32}$/.test(String(value || '').trim());
  }

  function requestAnalyticsConfig() {
    if (isGa4MeasurementId(global.CD1_GA4_MEASUREMENT_ID)) return Promise.resolve();
    if (global.__cd1AnalyticsConfigPromise) return global.__cd1AnalyticsConfigPromise;
    if (typeof global.fetch !== 'function') {
      global.__cd1AnalyticsConfigPromise = Promise.resolve();
      return global.__cd1AnalyticsConfigPromise;
    }
    global.__cd1AnalyticsConfigPromise = Promise.resolve().then(function () {
      return global.fetch('/.netlify/functions/analytics-public-config', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    }).then(function (res) {
      if (!res || !res.ok || typeof res.json !== 'function') return null;
      return res.json();
    }).then(function (body) {
      var id = body && body.ga4MeasurementId;
      if (!global.CD1_GA4_MEASUREMENT_ID && isGa4MeasurementId(id)) {
        global.CD1_GA4_MEASUREMENT_ID = String(id).trim();
      }
    }).catch(function () { /* GA4 stays off when the id is absent or the request fails */ });
    return global.__cd1AnalyticsConfigPromise;
  }

  function parseRetryAfter(value) {
    if (value == null || value === '') return null;
    var seconds = Number(value);
    var delay;
    if (isFinite(seconds) && seconds >= 0) {
      delay = seconds * 1000;
    } else {
      var at = Date.parse(String(value));
      if (!isFinite(at)) return null;
      delay = Math.max(0, at - nowMs());
    }
    return Math.max(1000, Math.min(MAX_RETRY_AFTER_MS, Math.round(delay)));
  }

  function retryDelay(entry, response) {
    if (response && response.status === 429 && response.headers && typeof response.headers.get === 'function') {
      var retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      if (retryAfter != null) return retryAfter;
    }
    var index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Number(entry.attempts || 1) - 1));
    return RETRY_DELAYS_MS[index];
  }

  function scheduleDelivery(eventId, delayMs) {
    if (scheduled[eventId]) return;
    var delay = Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Number(delayMs) || 0));
    if (typeof global.setTimeout !== 'function') return;
    scheduled[eventId] = global.setTimeout(function () {
      delete scheduled[eventId];
      return attemptDelivery(eventId);
    }, delay);
  }

  function finishSent(eventId) {
    var state = loadDeliveryState();
    var entry = state.events[eventId];
    if (!entry || entry.state === DELIVERY_STATES.SENT) return;
    entry.state = DELIVERY_STATES.SENT;
    entry.updatedAt = nowMs();
    entry.nextAttemptAt = null;
    entry.lastFailure = null;
    delete entry.payload;
    saveDeliveryState(state);
  }

  function finishTerminal(eventId, reason) {
    var state = loadDeliveryState();
    var entry = state.events[eventId];
    if (!entry) return;
    entry.state = DELIVERY_STATES.TERMINAL_FAILURE;
    entry.updatedAt = nowMs();
    entry.nextAttemptAt = null;
    entry.lastFailure = reason || 'terminal_failure';
    delete entry.payload;
    saveDeliveryState(state);
    safeLog('warn', '[revenue-events] terminal delivery failure', entry);
  }

  function finishRetryable(eventId, reason, response) {
    var state = loadDeliveryState();
    var entry = state.events[eventId];
    if (!entry) return;
    if (Number(entry.attempts || 0) >= MAX_ATTEMPTS) {
      finishTerminal(eventId, 'retry_exhausted:' + reason);
      return;
    }
    var delay = retryDelay(entry, response);
    entry.state = DELIVERY_STATES.RETRYABLE_FAILURE;
    entry.updatedAt = nowMs();
    entry.nextAttemptAt = nowMs() + delay;
    entry.lastFailure = reason;
    saveDeliveryState(state);
    safeLog('debug', '[revenue-events] retryable delivery failure', entry);
    scheduleDelivery(eventId, delay);
  }

  function classifyResponse(response) {
    var status = Number(response && response.status) || 0;
    if (status >= 200 && status < 300) return 'success';
    if (status === 408 || status === 429 || status >= 500) return 'retryable';
    return 'terminal';
  }

  function attemptDelivery(eventId) {
    var state = loadDeliveryState();
    var entry = state.events[eventId];
    if (!entry || entry.state === DELIVERY_STATES.SENT || entry.state === DELIVERY_STATES.TERMINAL_FAILURE) {
      return Promise.resolve(deliveryStatus(eventId));
    }
    if (entry.nextAttemptAt && entry.nextAttemptAt > nowMs()) {
      scheduleDelivery(eventId, entry.nextAttemptAt - nowMs());
      return Promise.resolve(deliveryStatus(eventId));
    }

    entry.state = DELIVERY_STATES.PENDING;
    entry.attempts = Number(entry.attempts || 0) + 1;
    entry.updatedAt = nowMs();
    entry.nextAttemptAt = null;
    saveDeliveryState(state);

    var request;
    try {
      if (typeof global.fetch !== 'function') throw new Error('fetch_unavailable');
      request = global.fetch(BACKEND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.payload),
        keepalive: true,
      });
    } catch (e) {
      finishRetryable(eventId, 'network_rejection', null);
      return Promise.resolve(deliveryStatus(eventId));
    }

    return Promise.resolve(request).then(function (response) {
      var outcome = classifyResponse(response);
      if (outcome === 'success') finishSent(eventId);
      else if (outcome === 'retryable') finishRetryable(eventId, 'http_' + response.status, response);
      else finishTerminal(eventId, 'http_' + response.status);
      return deliveryStatus(eventId);
    }).catch(function () {
      finishRetryable(eventId, 'network_rejection', null);
      return deliveryStatus(eventId);
    });
  }

  function activeDeliveryCount(state) {
    return Object.keys(state.events).reduce(function (count, id) {
      return count + (isActive(state.events[id]) ? 1 : 0);
    }, 0);
  }

  function recordClientTerminal(eventName, eventId, reason) {
    var state = loadDeliveryState();
    state.events[eventId] = {
      eventId: eventId,
      eventName: eventName,
      state: DELIVERY_STATES.TERMINAL_FAILURE,
      attempts: 0,
      createdAt: nowMs(),
      updatedAt: nowMs(),
      nextAttemptAt: null,
      lastFailure: reason,
    };
    saveDeliveryState(state);
    safeLog('warn', '[revenue-events] client-terminal analytics event', state.events[eventId]);
  }

  function enqueueFirstParty(eventName, eventId, props) {
    var state = loadDeliveryState();
    if (state.events[eventId]) return eventId;
    if (activeDeliveryCount(state) >= MAX_ACTIVE_EVENTS) {
      recordClientTerminal(eventName, eventId, 'queue_full');
      return eventId;
    }
    state.events[eventId] = {
      eventId: eventId,
      eventName: eventName,
      state: DELIVERY_STATES.PENDING,
      attempts: 0,
      createdAt: nowMs(),
      updatedAt: nowMs(),
      nextAttemptAt: nowMs(),
      lastFailure: null,
      payload: {
        event: eventName,
        event_id: eventId,
        anonymous_session_id: getSessionId(),
        properties: props,
      },
    };
    saveDeliveryState(state);
    // Start the keepalive request in this task so an immediate navigation or
    // tab close cannot happen before delivery is initiated. The Promise is
    // deliberately not awaited, so product interactions stay non-blocking.
    attemptDelivery(eventId);
    return eventId;
  }

  function resumePendingDeliveries() {
    var state = loadDeliveryState();
    Object.keys(state.events).forEach(function (eventId) {
      var entry = state.events[eventId];
      if (!isActive(entry)) return;
      scheduleDelivery(eventId, Math.max(0, Number(entry.nextAttemptAt || 0) - nowMs()));
    });
  }

  function ensureGtag() {
    global.dataLayer = global.dataLayer || [];
    if (typeof global.gtag !== 'function') {
      global.gtag = function () { global.dataLayer.push(arguments); };
    }
  }

  function hasGtagScript() {
    return !!(document.getElementById('cd1-gtag-ga4') || document.getElementById('cd1-gtag-ads'));
  }

  function loadGtagJs(tagId, scriptId) {
    if (document.getElementById(scriptId) || hasGtagScript()) return;
    var g = document.createElement('script');
    g.id = scriptId;
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(tagId);
    document.head.appendChild(g);
  }

  // Consent Mode v2: load Ads tag on every page so Google receives tag pings, while
  // ad cookies stay denied until Marketing opt-in (fixes "conversion never received data").
  function syncGtagConsentMode(consent) {
    ensureGtag();
    if (!global.__cd1GtagConsentDefaulted) {
      global.gtag('consent', 'default', {
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        analytics_storage: 'denied',
        wait_for_update: 500,
      });
      global.__cd1GtagConsentDefaulted = true;
    }
    var marketing = !!(consent && consent.marketing);
    var analytics = !!(consent && consent.analytics);
    global.gtag('consent', 'update', {
      ad_storage: marketing ? 'granted' : 'denied',
      ad_user_data: marketing ? 'granted' : 'denied',
      ad_personalization: marketing ? 'granted' : 'denied',
      analytics_storage: analytics ? 'granted' : 'denied',
    });
  }

  function isProductionAdsHost() {
    try {
      var loc = global.location || {};
      var host = loc.hostname ? String(loc.hostname) : '';
      if (!host && loc.href) {
        host = String(loc.href).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].split(':')[0];
      }
      host = host.toLowerCase();
      return host === 'cardetail1.com' || host === 'www.cardetail1.com';
    } catch (eHost) {
      return false;
    }
  }

  function initGoogleAds(consent) {
    if (!isProductionAdsHost()) return;
    var adsId = global.CD1_GOOGLE_ADS_ID || 'AW-11321647982';
    if (!adsId) return;
    var adsPageViewSendTo = global.CD1_GOOGLE_ADS_PAGE_VIEW_SEND_TO || 'AW-11321647982/r6SRCJeL998YEO7GypYq';

    syncGtagConsentMode(consent);
    loadGtagJs(adsId, 'cd1-gtag-ads');
    if (!global.__cd1GtagBootstrapped) {
      global.gtag('js', new Date());
      global.__cd1GtagBootstrapped = true;
    }
    if (!global.__cd1GoogleAdsConfigured) {
      global.gtag('config', adsId);
      global.__cd1GoogleAdsConfigured = true;
    }
    // Official Page view conversion snippet — fires once per page load.
    // With Consent Mode denied, Google still gets cookieless pings for diagnostics/modeling.
    if (!global.__cd1GoogleAdsPageViewFired) {
      global.gtag('event', 'conversion', { send_to: adsPageViewSendTo });
      global.__cd1GoogleAdsPageViewFired = true;
    }
  }

  /**
   * Google Ads "Booking submitted" conversion — fires only after finalize evidence
   * that a booking was durably persisted (ok + bookingCreated + not a draft +
   * durable id + backend approvedFinalAmount). Cash, card, and Ceramic
   * pay-at-service share this same conversion. Payment capture is a separate
   * financial event and is not required to count the reservation.
   *
   * send_to is the Google-provided booking conversion label (not Page view).
   * transaction_id = durable booking ID. The same id is remembered in
   * sessionStorage and localStorage so a retry, a second click, reopening the
   * confirmation, or a later payment does not emit again. Never awaits network;
   * never throws into checkout.
   */
  var ADS_BOOKING_TX_STORAGE_KEY = 'cd1_ads_booking_tx_ids';

  function adsBookingTxReadStore(store, into) {
    try {
      if (!store) return;
      var raw = store.getItem(ADS_BOOKING_TX_STORAGE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (id) {
        if (id) into[String(id)] = true;
      });
    } catch (eLoad) { /* ignore storage */ }
  }

  function adsBookingTxSeen(txId) {
    if (!txId) return true;
    try {
      if (!global.__cd1GoogleAdsBookingTxIds) {
        global.__cd1GoogleAdsBookingTxIds = Object.create(null);
        adsBookingTxReadStore(global.sessionStorage, global.__cd1GoogleAdsBookingTxIds);
        adsBookingTxReadStore(global.localStorage, global.__cd1GoogleAdsBookingTxIds);
      }
      return !!global.__cd1GoogleAdsBookingTxIds[String(txId)];
    } catch (e) {
      return false;
    }
  }

  function adsBookingTxMark(txId) {
    if (!txId) return;
    try {
      if (!global.__cd1GoogleAdsBookingTxIds) global.__cd1GoogleAdsBookingTxIds = Object.create(null);
      global.__cd1GoogleAdsBookingTxIds[String(txId)] = true;
      try {
        var ids = Object.keys(global.__cd1GoogleAdsBookingTxIds);
        if (ids.length > 40) ids = ids.slice(-40);
        var serialized = JSON.stringify(ids);
        if (global.sessionStorage) global.sessionStorage.setItem(ADS_BOOKING_TX_STORAGE_KEY, serialized);
        if (global.localStorage) global.localStorage.setItem(ADS_BOOKING_TX_STORAGE_KEY, serialized);
      } catch (eStore) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  function resolveAuthoritativeBookingValue(opts) {
    opts = opts || {};
    // Strict: only backend approvedFinalAmount — never value/totalPrice/client cart.
    if (opts.approvedFinalAmount == null || opts.approvedFinalAmount === '') return null;
    var n = Number(opts.approvedFinalAmount);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  function trackGoogleAdsBookingConversion(opts) {
    opts = opts || {};
    var inFlightKey = null;
    try {
      // Prefer explicit booking send_to; fall back to legacy PURCHASE env name.
      if (!isProductionAdsHost()) return false;
      var sendTo = global.CD1_GOOGLE_ADS_BOOKING_SEND_TO
        || global.CD1_GOOGLE_ADS_PURCHASE_SEND_TO
        || 'AW-11321647982/yrODCJGL998YEO7GypYq';
      if (!sendTo || sendTo === global.CD1_GOOGLE_ADS_PAGE_VIEW_SEND_TO) return false;

      var txId = opts.transaction_id || opts.bookingId || opts.id || null;
      if (!txId) return false;
      txId = String(txId);

      // Strict durable-persist evidence — missing `ok` is not success.
      if (opts.ok !== true) return false;
      if (opts.bookingCreated !== true) return false;
      if (opts.isDraft === true) return false;

      var value = resolveAuthoritativeBookingValue(opts);
      if (value == null) return false;

      if (adsBookingTxSeen(txId)) return false;

      // Synchronous in-flight guard (double-click) without permanently marking
      // the tx until gtag returns without throwing.
      if (!global.__cd1GoogleAdsBookingTxInFlight) {
        global.__cd1GoogleAdsBookingTxInFlight = Object.create(null);
      }
      if (global.__cd1GoogleAdsBookingTxInFlight[txId]) return false;
      global.__cd1GoogleAdsBookingTxInFlight[txId] = true;
      inFlightKey = txId;

      var consent = global.Cardetail1Consent
        ? global.Cardetail1Consent.getConsent()
        : { analytics: false, marketing: false };
      initGoogleAds(consent);
      ensureGtag();

      global.gtag('event', 'conversion', {
        send_to: sendTo,
        value: value,
        currency: opts.currency || 'USD',
        transaction_id: txId,
      });
      // Persist as emitted only after gtag accepted/queued the call.
      adsBookingTxMark(txId);
      global.__cd1GoogleAdsBookingConversionFired = true;
      return true;
    } catch (e) {
      return false;
    } finally {
      try {
        if (inFlightKey && global.__cd1GoogleAdsBookingTxInFlight) {
          delete global.__cd1GoogleAdsBookingTxInFlight[inFlightKey];
        }
      } catch (eClear) { /* ignore */ }
    }
  }

  function initTagAdapters(consent) {
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
    } else if (consent.analytics && isGa4MeasurementId(gaId) && !gtmId && !global.__cd1Ga4Configured) {
      ensureGtag();
      syncGtagConsentMode(consent);
      loadGtagJs(gaId, 'cd1-gtag-ga4');
      if (!global.__cd1GtagBootstrapped) {
        global.gtag('js', new Date());
        global.__cd1GtagBootstrapped = true;
      }
      global.gtag('config', gaId, { anonymize_ip: true, send_page_view: true });
      global.__cd1Ga4Configured = true;
    }

    // Clarity stays off unless a project id is already configured AND analytics
    // consent is granted. Booking fields are not masked, so this does not
    // invent or fetch a Clarity id.
    if (consent.analytics && clarityId && !document.getElementById('cd1-clarity')) {
      var c = document.createElement('script');
      c.id = 'cd1-clarity';
      c.async = true;
      c.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(clarityId);
      document.head.appendChild(c);
    }
  }

  function initAdapters() {
    var consent = global.Cardetail1Consent ? global.Cardetail1Consent.getConsent() : { analytics: false, marketing: false };
    initGoogleAds(consent);
    initTagAdapters(consent);
    requestAnalyticsConfig().then(function () {
      var latest = global.Cardetail1Consent ? global.Cardetail1Consent.getConsent() : consent;
      initTagAdapters(latest || consent);
    });
  }

  if (
    typeof document !== 'undefined'
    && document
    && typeof document.addEventListener === 'function'
    && !global.__cd1ConsentListenerBound
  ) {
    global.__cd1ConsentListenerBound = true;
    document.addEventListener('cd1:consent-changed', function (ev) {
      try {
        syncGtagConsentMode(ev && ev.detail ? ev.detail : (global.Cardetail1Consent && global.Cardetail1Consent.getConsent()));
      } catch (e) { /* never block */ }
    });
  }

  function isSharedPreviewHost() {
    try {
      var loc = global.location || {};
      var host = loc.hostname ? String(loc.hostname) : '';
      host = host.toLowerCase();
      return /^deploy-preview-\d+--[a-z0-9-]+\.netlify\.app$/.test(host)
        || /^[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/.test(host);
    } catch (ePreview) {
      return false;
    }
  }

  function track(eventName, properties) {
    try {
      if (isSharedPreviewHost()) return null;
      eventName = String(eventName || '').trim().slice(0, 128);
      if (!eventName) return null;
      var eventId = (properties && properties.event_id) || uuid();
      var existing = loadDeliveryState().events[eventId];
      if (existing) return eventId;
      if (!APPROVED_EVENTS[eventName]) {
        recordClientTerminal(eventName, eventId, 'unknown_event');
        return eventId;
      }

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
        utm_term: attr.utm_term || undefined,
        referrer_domain: attr.referrer_domain || undefined,
        traffic_type: trafficType(attr),
        first_seen_at: attr.first_seen_at || undefined,
        device_type: global.innerWidth <= 768 ? 'mobile' : 'desktop',
      }));

      enqueueFirstParty(eventName, eventId, props);

      var consent = global.Cardetail1Consent ? global.Cardetail1Consent.getConsent() : { analytics: false, marketing: false };
      if (consent.analytics) {
        pushDataLayer(eventName, props);
        pushGa4(eventName, props);
        pushClarity(eventName, props);
      }
      return eventId;
    } catch (e) {
      /* never break booking */
      return null;
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
    getDeliveryStatus: deliveryStatus,
    getDeliverySnapshot: deliverySnapshot,
    trackGoogleAdsBookingConversion: trackGoogleAdsBookingConversion,
    getContract: function () {
      return {
        events: Object.keys(APPROVED_EVENTS).sort(),
        properties: Object.keys(APPROVED_PROPS).sort(),
      };
    },
    _deliveryTest: {
      states: DELIVERY_STATES,
      attempt: attemptDelivery,
      resume: resumePendingDeliveries,
      parseRetryAfter: parseRetryAfter,
      maxAttempts: MAX_ATTEMPTS,
    },
  };
  resumePendingDeliveries();
})(typeof window !== 'undefined' ? window : globalThis);
