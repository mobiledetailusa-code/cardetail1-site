/** Build Your Garage Plan — lightweight multi-vehicle discovery flow. */
(function (global) {
  'use strict';

  var STYLE_ID = 'cd1-garage-plan-styles';
  var PHONE_TEL = '5513735668';
  var PHONE_DISPLAY = '551-373-5668';

  var ERROR_COPY = {
    validation_error: 'Please complete all required fields.',
    invalid_phone: 'Please enter a valid US phone number (10 digits).',
    invalid_zip: 'Please enter a valid 5-digit service ZIP code.',
    missing_required_fields: 'Please complete name, phone, and service ZIP.',
    transactional_consent_required: 'Service contact consent is required to submit your Garage Plan.',
    garage_plan_requires_two_vehicles: 'Garage Plan is for 2+ personal vehicles at one location.',
    fleet_quote_required: 'Fleet and commercial requests use our quote team — redirecting you now.',
    manual_review_required: 'Your ZIP may need an alternative service path. We saved your request and will follow up.',
    rate_limited: 'Too many attempts. Please wait a few minutes or call us.',
    service_unavailable: 'Our system is temporarily unavailable. Please call or text us and we will help you directly.',
    server_error: 'Something went wrong on our end. Please try again or call us.',
    invalid_json: 'Could not send your request. Please try again.',
    method_not_allowed: 'Could not send your request. Please try again.',
  };

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '.cd1-gp-ov{position:fixed;inset:0;background:rgba(2,4,10,.88);z-index:10001;display:none;align-items:center;justify-content:center;padding:16px}' +
      '.cd1-gp-ov.open{display:flex}.cd1-gp-modal{background:#0a1628;border:1px solid rgba(77,163,255,.35);border-radius:16px;max-width:520px;width:100%;max-height:90vh;overflow:auto;padding:20px;color:#e8eef5;font:14px/1.45 system-ui,sans-serif}' +
      '.cd1-gp-modal h2{margin:0 0 8px;font-size:20px}.cd1-gp-modal label{display:block;margin:10px 0 4px;font-size:12px;color:#8a9bb0}' +
      '.cd1-gp-modal input,.cd1-gp-modal select,.cd1-gp-modal textarea{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:#020a16;color:#fff}' +
      '.cd1-gp-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cd1-gp-actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}' +
      '.cd1-gp-btn{padding:10px 16px;border-radius:999px;border:none;font-weight:700;cursor:pointer}.cd1-gp-primary{background:#4da3ff;color:#000}.cd1-gp-secondary{background:transparent;border:1px solid rgba(77,163,255,.4);color:#4da3ff}' +
      '.cd1-gp-cta{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;border:1px solid rgba(77,163,255,.45);background:rgba(77,163,255,.08);color:#4da3ff;font-weight:600;font-size:13px;cursor:pointer;text-decoration:none}' +
      '.cd1-gp-cta:hover{background:rgba(77,163,255,.16)}';
    document.head.appendChild(s);
  }

  function overlayHtml() {
    return '<div class="cd1-gp-ov" id="cd1-garage-plan-ov" role="dialog" aria-labelledby="cd1-gp-title">' +
      '<div class="cd1-gp-modal" data-clarity-mask="true">' +
      '<h2 id="cd1-gp-title">Build Your Garage Plan</h2>' +
      '<p>Have 2 or more vehicles at the same location? Build a coordinated Garage Plan. <strong>One vehicle?</strong> Standard booking is always available.</p>' +
      '<label>Number of personal vehicles<input type="number" id="cd1-gp-count" min="1" max="20" value="2"></label>' +
      '<label>Vehicle categories<select id="cd1-gp-cats" multiple size="4"><option value="cars">Cars & SUVs</option><option value="boats">Boats</option><option value="rvs">RVs & Trailers</option><option value="powersports">Powersports</option></select></label>' +
      '<div class="cd1-gp-row"><label><input type="checkbox" id="cd1-gp-same-loc" checked> Same service location</label>' +
      '<label><input type="checkbox" id="cd1-gp-same-visit"> Same visit</label></div>' +
      '<label>Maintenance interest<select id="cd1-gp-maint"><option value="one-time">One-time</option><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option><option value="bi-monthly">Bi-monthly</option></select></label>' +
      '<div class="cd1-gp-row"><label>Name<input id="cd1-gp-name" autocomplete="name" data-clarity-mask="true"></label><label>Phone<input id="cd1-gp-phone" autocomplete="tel" data-clarity-mask="true"></label></div>' +
      '<label>Email<input id="cd1-gp-email" type="email" autocomplete="email" data-clarity-mask="true"></label>' +
      '<label>Service ZIP<input id="cd1-gp-zip" inputmode="numeric" maxlength="5" data-clarity-mask="true"></label>' +
      '<label><input type="checkbox" id="cd1-gp-txn-consent"> I agree to be contacted about this service request (required)</label>' +
      '<label><input type="checkbox" id="cd1-gp-mkt-consent"> Optional: send me offers and maintenance reminders</label>' +
      '<div class="cd1-gp-actions"><button type="button" class="cd1-gp-btn cd1-gp-primary" id="cd1-gp-submit">Submit Garage Plan</button>' +
      '<button type="button" class="cd1-gp-btn cd1-gp-secondary" id="cd1-gp-cancel">Cancel</button></div>' +
      '<p id="cd1-gp-msg" style="font-size:12px;color:#8a9bb0;margin-top:10px"></p></div></div>';
  }

  function selectedCategories(sel) {
    return Array.from(sel.selectedOptions).map(function (o) { return o.value; });
  }

  function pageSource() {
    return String((global.location && global.location.pathname) || 'garage_plan_modal');
  }

  function sessionAttribution() {
    var out = {};
    try {
      if (global.Cardetail1Revenue && global.Cardetail1Revenue.getSessionId) {
        out.anonymous_session_id = global.Cardetail1Revenue.getSessionId();
      }
    } catch (e) { /* ignore */ }
    try {
      var params = new URLSearchParams(global.location.search || '');
      if (params.get('utm_campaign')) out.utm_campaign = params.get('utm_campaign');
    } catch (e2) { /* ignore */ }
    return out;
  }

  function showMessage(msgEl, text, isError) {
    msgEl.innerHTML = text + ' <a href="tel:' + PHONE_TEL + '" style="color:#4da3ff;font-weight:600;text-decoration:none">Call / Text ' + PHONE_DISPLAY + '</a>';
    msgEl.style.color = isError ? '#f5a5a5' : '#8a9bb0';
  }

  function mapError(data, status) {
    if (!data || typeof data !== 'object') {
      return status >= 500 ? ERROR_COPY.service_unavailable : ERROR_COPY.server_error;
    }
    if (data.error && ERROR_COPY[data.error]) return ERROR_COPY[data.error];
    if (status >= 500) return ERROR_COPY.service_unavailable;
    if (status === 429) return ERROR_COPY.rate_limited;
    return ERROR_COPY.server_error;
  }

  function openGaragePlan() {
    injectStyles();
    if (!document.getElementById('cd1-garage-plan-ov')) {
      document.body.insertAdjacentHTML('beforeend', overlayHtml());
      document.getElementById('cd1-gp-cancel').onclick = closeGaragePlan;
      document.getElementById('cd1-gp-submit').onclick = submitGaragePlan;
    }
    document.getElementById('cd1-garage-plan-ov').classList.add('open');
    if (global.Cardetail1Revenue) {
      global.Cardetail1Revenue.track('garage_plan_started', { page_type: 'garage_plan' });
    }
  }

  function closeGaragePlan() {
    var ov = document.getElementById('cd1-garage-plan-ov');
    if (ov) ov.classList.remove('open');
  }

  function submitGaragePlan() {
    var count = Number(document.getElementById('cd1-gp-count').value || 0);
    var msg = document.getElementById('cd1-gp-msg');
    msg.textContent = '';
    msg.style.color = '#8a9bb0';

    if (count >= 7) {
      closeGaragePlan();
      global.location.href = '/fleet-services.html';
      return;
    }
    if (count < 2) {
      msg.innerHTML = 'Garage Plan is for 2+ vehicles at one location. <button type="button" class="cd1-gp-btn cd1-gp-secondary" id="cd1-gp-book-one" style="margin-top:8px">Book one vehicle instead</button>';
      var bookOne = document.getElementById('cd1-gp-book-one');
      if (bookOne) {
        bookOne.onclick = function () {
          closeGaragePlan();
          if (typeof global.openBooking === 'function') global.openBooking(null);
          else global.location.href = '/index.html';
        };
      }
      return;
    }
    if (!document.getElementById('cd1-gp-txn-consent').checked) {
      showMessage(msg, ERROR_COPY.transactional_consent_required, true);
      return;
    }

    var attribution = sessionAttribution();
    var payload = {
      vehicleCount: count,
      vehicleCategories: selectedCategories(document.getElementById('cd1-gp-cats')),
      sameServiceLocation: document.getElementById('cd1-gp-same-loc').checked,
      sameLocationSameVisit: document.getElementById('cd1-gp-same-visit').checked,
      maintenanceFrequency: document.getElementById('cd1-gp-maint').value,
      name: document.getElementById('cd1-gp-name').value.trim(),
      phone: document.getElementById('cd1-gp-phone').value.trim(),
      email: document.getElementById('cd1-gp-email').value.trim(),
      zip: document.getElementById('cd1-gp-zip').value.trim(),
      transactionalConsent: true,
      marketingConsent: document.getElementById('cd1-gp-mkt-consent').checked,
      smsConsent: document.getElementById('cd1-gp-mkt-consent').checked,
      emailConsent: document.getElementById('cd1-gp-mkt-consent').checked,
      prefillBooking: true,
      source: pageSource(),
      utm_campaign: attribution.utm_campaign || null,
      anonymous_session_id: attribution.anonymous_session_id || null,
    };

    fetch('/.netlify/functions/garage-plan-submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        return { status: r.status, data: data };
      });
    }).then(function (res) {
      var data = res.data || {};
      if (!data.ok) {
        showMessage(msg, mapError(data, res.status), true);
        return;
      }
      if (data.route === 'fleet_quote') {
        global.location.href = data.fleetUrl || '/fleet-services.html';
        return;
      }
      if (global.Cardetail1Revenue) {
        global.Cardetail1Revenue.track('garage_plan_completed', {
          vehicle_count_band: data.vehicleCountBand,
          household_segment: data.segment,
        });
        global.Cardetail1Revenue.track('lead_created', { household_segment: data.segment });
      }
      var ref = data.gpReference ? (' Reference: <strong>' + data.gpReference + '</strong>.') : '';
      if (data.route === 'manual_review' || data.manualReviewRequired) {
        showMessage(msg, 'Thank you — your Garage Plan request was received.' + ref + ' Your area may need an alternative service path, and our team will follow up shortly.', false);
        return;
      }
      showMessage(msg, 'Thank you — your Garage Plan request was received.' + ref + ' This is a request, not a confirmed appointment. We will follow up shortly.', false);
      if (typeof global.openBooking === 'function' && data.bookingPrefill) {
        setTimeout(function () {
          closeGaragePlan();
          global.openBooking(null);
        }, 1200);
      }
    }).catch(function () {
      showMessage(msg, ERROR_COPY.service_unavailable, true);
    });
  }

  function renderCompactCta(container) {
    injectStyles();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cd1-gp-cta';
    btn.innerHTML = '🚗🚙 Have 2+ vehicles? <strong>Build Your Garage Plan</strong>';
    btn.onclick = openGaragePlan;
    (container || document.body).appendChild(btn);
    return btn;
  }

  global.Cardetail1GaragePlan = {
    open: openGaragePlan,
    close: closeGaragePlan,
    renderCompactCta: renderCompactCta,
  };
})(typeof window !== 'undefined' ? window : globalThis);
