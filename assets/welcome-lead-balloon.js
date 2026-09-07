/** First-visit WELCOME10 floating balloon — email capture, first visit only. */
(function (global) {
  'use strict';

  var STYLE_ID = 'cd1-wlb-styles';
  var ROOT_ID = 'cd1-wlb';
  var CLAIM_KEY = 'cd1_welcome10';
  var DISMISS_KEY = 'cd1_welcome10_dismissed';
  var SHOW_DELAY_MS = 8000;
  var SCROLL_RATIO = 0.28;
  var DISMISS_DAYS = 30;
  var shownTracked = false;

  function backend() {
    return (global.BACKEND_BASE || '/.netlify/functions');
  }

  function readJson(key) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeJson(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function existingClaim() {
    var c = readJson(CLAIM_KEY);
    return c && c.email ? c : null;
  }

  function wasDismissed() {
    var d = readJson(DISMISS_KEY);
    if (!d || !d.at) return false;
    var age = Date.now() - Date.parse(d.at);
    if (!Number.isFinite(age) || age < 0) return true;
    return age < DISMISS_DAYS * 86400000;
  }

  function shouldSkipPage() {
    var path = String((global.location && global.location.pathname) || '');
    if (/admin|technician|customer\.html|authorize|receipt|bid\.html|resume/i.test(path)) return true;
    if (document.body && document.body.classList.contains('cd1-booking-embed')) return true;
    return false;
  }

  function bookingOpen() {
    var ov = document.getElementById('bk-ov');
    if (!ov) return false;
    var style = global.getComputedStyle ? global.getComputedStyle(ov) : ov.style;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    if (ov.hidden) return false;
    return ov.classList.contains('open') || ov.style.display === 'flex' || ov.getAttribute('style') && /display:\s*flex/.test(ov.getAttribute('style'));
  }

  function chatOpen() {
    var chat = document.getElementById('cd-chat');
    return !!(chat && chat.classList.contains('open'));
  }

  function track(name, props) {
    try {
      if (global.Cardetail1Revenue && typeof global.Cardetail1Revenue.track === 'function') {
        global.Cardetail1Revenue.track(name, props || {});
      }
    } catch (e) { /* non-blocking */ }
  }

  function persistClaim(email) {
    var claim = {
      email: email,
      claimedAt: new Date().toISOString(),
      source: 'first_visit_balloon',
      offerId: 'first_booking_welcome',
    };
    writeJson(CLAIM_KEY, claim);
    if (!global.ST) global.ST = {};
    global.ST.offerApplied = true;
    global.ST.welcomeOfferSource = 'first_visit_balloon';
    global.ST.welcomeLeadEmail = email;
    var emailEl = document.getElementById('f-email');
    if (emailEl && !emailEl.value) emailEl.value = email;
    return claim;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent =
      '#cd1-wlb{position:fixed;right:20px;bottom:calc(96px + var(--cd1-wlb-consent,0px));z-index:970;font-family:var(--fb,"DM Sans",system-ui,sans-serif);width:64px;pointer-events:none}' +
      '#cd1-wlb.cd1-wlb-on{pointer-events:auto}' +
      '#cd1-wlb.cd1-wlb-open{width:min(332px,calc(100vw - 28px))}' +
      '#cd1-wlb[hidden],body.cd1-booking-embed #cd1-wlb,#cd1-wlb.cd1-wlb-hide{display:none!important}' +
      '.cd1-wlb-card{display:none;background:#121a24;border:1px solid rgba(212,184,150,.32);border-radius:18px;padding:16px 16px 14px;color:#ece8e1;box-shadow:0 16px 40px rgba(0,0,0,.42);position:relative}' +
      '#cd1-wlb.cd1-wlb-open .cd1-wlb-card{display:block}' +
      '.cd1-wlb-kicker{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#d4b896;margin:0 0 6px}' +
      '.cd1-wlb-title{font-size:18px;line-height:1.25;font-weight:700;margin:0 0 6px;color:#fff}' +
      '.cd1-wlb-copy{font-size:13px;line-height:1.5;color:#b8c4d0;margin:0 0 12px}' +
      '.cd1-wlb-row{display:flex;gap:8px}' +
      '.cd1-wlb-row input[type=email]{flex:1;min-width:0;min-height:44px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#0b1118;color:#fff;padding:10px 12px;font:inherit;font-size:14px}' +
      '.cd1-wlb-row input[type=email]:focus{outline:2px solid #4da3ff;outline-offset:1px;border-color:#4da3ff}' +
      '.cd1-wlb-go{min-height:44px;padding:0 14px;border:none;border-radius:12px;background:#4da3ff;color:#041018;font-weight:700;cursor:pointer;white-space:nowrap}' +
      '.cd1-wlb-go:disabled{opacity:.65;cursor:wait}' +
      '.cd1-wlb-opt{display:flex;align-items:flex-start;gap:8px;margin:10px 0 0;font-size:11.5px;line-height:1.4;color:#8a9bb0;cursor:pointer}' +
      '.cd1-wlb-opt input{margin-top:2px;flex:0 0 auto}' +
      '.cd1-wlb-fine{margin:8px 0 0;font-size:11px;line-height:1.4;color:#7d8b9c}' +
      '.cd1-wlb-fine a{color:#7eb3e8}' +
      '.cd1-wlb-msg{margin:8px 0 0;font-size:12px;color:#f0b4b4;min-height:0}' +
      '.cd1-wlb-x{position:absolute;top:8px;right:8px;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:#8a9bb0;cursor:pointer;font-size:18px;line-height:1}' +
      '.cd1-wlb-x:hover,.cd1-wlb-x:focus-visible{color:#fff;outline:2px solid #4da3ff}' +
      '.cd1-wlb-fab{position:relative;width:64px;height:64px;margin-left:auto;border:0;border-radius:50%;background:radial-gradient(circle at 30% 25%,#f3e0c4,#c4a574 62%,#9a7548);color:#1a140c;font-weight:800;font-size:15px;letter-spacing:-.02em;cursor:pointer;box-shadow:0 10px 24px rgba(196,165,116,.38);display:flex;align-items:center;justify-content:center;flex-direction:column;line-height:1.05}' +
      '.cd1-wlb-fab-x{position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;border:0;background:#1a140c;color:#f3e0c4;font-size:13px;line-height:22px;cursor:pointer;z-index:2}' +
      '.cd1-wlb-fab small{font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.8}' +
      '.cd1-wlb-fab::after{content:"";position:absolute;right:10px;bottom:-8px;width:14px;height:14px;background:#c4a574;transform:rotate(45deg);border-radius:2px}' +
      '#cd1-wlb.cd1-wlb-open .cd1-wlb-fab,#cd1-wlb.cd1-wlb-open .cd1-wlb-fab-x{display:none}' +
      '#cd1-wlb:not(.cd1-wlb-open) .cd1-wlb-card{display:none}' +
      '.cd1-wlb-pulse{position:absolute;inset:-6px;border-radius:50%;border:2px solid rgba(196,165,116,.55);animation:cd1WlbPulse 2.2s ease-out infinite;pointer-events:none}' +
      '@keyframes cd1WlbPulse{0%{transform:scale(.92);opacity:.7}100%{transform:scale(1.28);opacity:0}}' +
      '.cd1-wlb-hp{position:absolute;left:-9999px;height:0;width:0;opacity:0}' +
      '.cd1-wlb-success .cd1-wlb-title{color:#b7e3c0}' +
      '.cd1-wlb-book{display:inline-flex;margin-top:10px;min-height:44px;align-items:center;padding:0 16px;border:0;border-radius:999px;background:#4da3ff;color:#041018;font-weight:700;cursor:pointer}' +
      '@media(max-width:640px){#cd1-wlb,#cd1-wlb:not(.cd1-wlb-open){right:14px;bottom:calc(132px + var(--cd1-wlb-consent,0px))}}' +
      '@media(prefers-reduced-motion:reduce){.cd1-wlb-pulse{display:none}}';
    document.head.appendChild(s);
  }

  function cardFormHtml() {
    return '<div class="cd1-wlb-card" role="dialog" aria-labelledby="cd1-wlb-title" data-clarity-mask="true">' +
      '<button type="button" class="cd1-wlb-x" id="cd1-wlb-close" aria-label="Close offer">×</button>' +
      '<p class="cd1-wlb-kicker">First visit</p>' +
      '<h2 class="cd1-wlb-title" id="cd1-wlb-title">Get 10% off your first detail</h2>' +
      '<p class="cd1-wlb-copy">Enter your email. We apply 10% off eligible service (up to $40) on your first qualifying booking.</p>' +
      '<form id="cd1-wlb-form">' +
      '<label class="cd1-wlb-hp">Company<input type="text" name="website" tabindex="-1" autocomplete="off"></label>' +
      '<div class="cd1-wlb-row">' +
      '<input type="email" id="cd1-wlb-email" name="email" required autocomplete="email" inputmode="email" placeholder="you@email.com" aria-label="Email">' +
      '<button type="submit" class="cd1-wlb-go" id="cd1-wlb-submit">Unlock 10%</button>' +
      '</div>' +
      '<label class="cd1-wlb-opt"><input type="checkbox" id="cd1-wlb-mkt" checked> Email me this offer and occasional detailing tips. Unsubscribe anytime.</label>' +
      '</form>' +
      '<p class="cd1-wlb-fine">New customers only. One redemption per household. <a href="/terms-conditions#welcome-offer" target="_blank" rel="noopener noreferrer">Terms apply</a>.</p>' +
      '<p class="cd1-wlb-msg" id="cd1-wlb-msg" role="status"></p>' +
      '</div>';
  }

  function successHtml(email) {
    return '<div class="cd1-wlb-card cd1-wlb-success" role="status">' +
      '<button type="button" class="cd1-wlb-x" id="cd1-wlb-close" aria-label="Close">×</button>' +
      '<p class="cd1-wlb-kicker">You\'re in</p>' +
      '<h2 class="cd1-wlb-title" id="cd1-wlb-title">10% off is ready</h2>' +
      '<p class="cd1-wlb-copy">Use <strong>' + String(email).replace(/[<>&]/g, '') + '</strong> when you book. The welcome offer applies automatically — no promo code.</p>' +
      '<button type="button" class="cd1-wlb-book" id="cd1-wlb-book">Check price &amp; availability</button>' +
      '<p class="cd1-wlb-fine"><a href="/terms-conditions#welcome-offer" target="_blank" rel="noopener noreferrer">Offer terms</a></p></div>';
  }

  function ensureRoot() {
    var el = document.getElementById(ROOT_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = ROOT_ID;
    el.hidden = true;
    el.innerHTML = '<button type="button" class="cd1-wlb-fab" id="cd1-wlb-fab" aria-expanded="false" aria-controls="cd1-wlb-form" aria-label="Open 10 percent first-visit offer"><span class="cd1-wlb-pulse" aria-hidden="true"></span>10%<small>OFF</small></button>' +
      '<button type="button" class="cd1-wlb-fab-x" id="cd1-wlb-fab-dismiss" aria-label="Dismiss 10 percent offer">×</button>' +
      cardFormHtml();
    document.body.appendChild(el);
    return el;
  }

  function setOpen(open) {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.classList.toggle('cd1-wlb-open', !!open);
    var fab = document.getElementById('cd1-wlb-fab');
    if (fab) fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && !shownTracked) {
      shownTracked = true;
      track('offer_viewed', { offer_id: 'first_booking_welcome', source_page: 'first_visit_balloon' });
    }
  }

  function reveal() {
    var root = ensureRoot();
    root.hidden = false;
    root.classList.add('cd1-wlb-on');
    bind();
    layoutBalloon();
  }

  function layoutBalloon() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    var banner = document.getElementById('cd1-consent-banner');
    var extra = 0;
    if (banner && banner.offsetHeight && global.getComputedStyle(banner).display !== 'none') {
      extra = Math.round(banner.offsetHeight) + 10;
    }
    root.style.setProperty('--cd1-wlb-consent', extra + 'px');
  }

  function hideForOverlays() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    var block = bookingOpen() || chatOpen();
    root.classList.toggle('cd1-wlb-hide', !!block);
    layoutBalloon();
  }

  function dismiss() {
    writeJson(DISMISS_KEY, { at: new Date().toISOString() });
    var root = document.getElementById(ROOT_ID);
    if (root) root.remove();
  }

  function bind() {
    var root = document.getElementById(ROOT_ID);
    if (!root || root.dataset.bound) return;
    root.dataset.bound = '1';
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === 'cd1-wlb-fab' || (t.closest && t.closest('#cd1-wlb-fab'))) setOpen(true);
      if (t.id === 'cd1-wlb-fab-dismiss') {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
        return;
      }
      if (t.id === 'cd1-wlb-close' || (t.closest && t.closest('#cd1-wlb-close'))) {
        if (existingClaim()) {
          var n = document.getElementById(ROOT_ID);
          if (n) n.remove();
          return;
        }
        setOpen(false);
      }
      if (t && t.id === 'cd1-wlb-book') {
        var n2 = document.getElementById(ROOT_ID);
        if (n2) n2.remove();
        if (typeof global.openBooking === 'function') global.openBooking(null);
      }
    });
    document.addEventListener('submit', onSubmit, true);
  }

  function onSubmit(e) {
    var form = e.target;
    if (!form || form.id !== 'cd1-wlb-form') return;
    e.preventDefault();
    submitForm(form);
  }

  function showSuccess(email) {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    var fab = document.getElementById('cd1-wlb-fab');
    if (fab) fab.remove();
    var fabX = document.getElementById('cd1-wlb-fab-dismiss');
    if (fabX) fabX.remove();
    var old = root.querySelector('.cd1-wlb-card');
    if (old) old.outerHTML = successHtml(email);
    root.classList.add('cd1-wlb-open', 'cd1-wlb-on');
    root.hidden = false;
  }

  async function submitForm(form) {
    var emailEl = document.getElementById('cd1-wlb-email');
    var msg = document.getElementById('cd1-wlb-msg');
    var btn = document.getElementById('cd1-wlb-submit');
    var email = emailEl ? String(emailEl.value || '').trim().toLowerCase() : '';
    var hp = form.querySelector('input[name="website"]');
    if (msg) msg.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (msg) msg.textContent = 'Enter a valid email.';
      return;
    }
    if (btn) btn.disabled = true;
    var payload = {
      email: email,
      source: 'first_visit_balloon',
      landingPage: String((global.location && global.location.pathname) || '/'),
      marketingConsent: !!(document.getElementById('cd1-wlb-mkt') && document.getElementById('cd1-wlb-mkt').checked),
      website: hp ? hp.value : '',
    };
    try {
      var params = new URLSearchParams(global.location.search || '');
      if (params.get('utm_campaign')) payload.utm_campaign = params.get('utm_campaign');
    } catch (e1) { /* ignore */ }
    try {
      var res = await fetch(backend() + '/welcome-lead-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 429) {
        if (msg) msg.textContent = 'Too many tries. Please wait a few minutes.';
        if (btn) btn.disabled = false;
        return;
      }
      if (!res.ok || !data.ok) {
        if (msg) msg.textContent = 'Could not save that email. Try again or call 551-373-5668.';
        if (btn) btn.disabled = false;
        return;
      }
      persistClaim(email);
      track('contact_captured', { offer_id: 'first_booking_welcome', source_page: 'first_visit_balloon' });
      track('promotion_selected', { offer_id: 'first_booking_welcome' });
      showSuccess(email);
    } catch (err) {
      if (msg) msg.textContent = 'Network error. Please try again.';
      if (btn) btn.disabled = false;
    }
  }

  function maybeReveal() {
    if (existingClaim() || wasDismissed() || shouldSkipPage()) return;
    reveal();
    setOpen(false);
  }

  function init() {
    if (global.__CD1_WLB_INIT__) return;
    global.__CD1_WLB_INIT__ = true;
    if (shouldSkipPage()) return;
    injectStyles();

    if (existingClaim()) {
      persistClaim(existingClaim().email);
      return;
    }
    if (wasDismissed()) return;

    var revealed = false;
    function onceReveal() {
      if (revealed) return;
      revealed = true;
      maybeReveal();
    }

    global.setTimeout(onceReveal, SHOW_DELAY_MS);
    global.addEventListener('scroll', function () {
      var root = document.scrollingElement || document.documentElement;
      var max = Math.max(1, (root.scrollHeight || 1) - (global.innerHeight || 0));
      if ((root.scrollTop || global.scrollY || 0) / max >= SCROLL_RATIO) onceReveal();
    }, { passive: true });

    global.setInterval(hideForOverlays, 400);
    document.addEventListener('cd1:consent-changed', layoutBalloon);
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('.booking-popup-trigger')) {
        global.setTimeout(hideForOverlays, 50);
      }
    }, true);
  }

  global.Cardetail1WelcomeBalloon = {
    init: init,
    persistClaim: persistClaim,
    revealForTest: maybeReveal,
    CLAIM_KEY: CLAIM_KEY,
    DISMISS_KEY: DISMISS_KEY,
    SHOW_DELAY_MS: SHOW_DELAY_MS,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
