/**
 * Asks the server whether customer Stripe payments are on.
 * Fail closed. Stripe.js is inserted only after stripe-config returns
 * customerPaymentsEnabled === true. A false body, non-JSON response, error,
 * or timeout leaves the script unloaded. Query, cookie, and host cannot enable it.
 */
(function (global) {
  'use strict';

  var STRIPE_JS = 'https://js.stripe.com/v3/';

  function apply(enabled) {
    var api = global.Cardetail1BookingReview;
    if (api && typeof api.setCustomerPaymentsEnabled === 'function') {
      api.setCustomerPaymentsEnabled(enabled === true);
    }
  }

  function stripeScripts() {
    var doc = global.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    return doc.querySelectorAll('script[src="' + STRIPE_JS + '"]');
  }

  function removeStripeScripts() {
    var nodes = stripeScripts();
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  function loadStripeJs() {
    return new Promise(function (resolve, reject) {
      if (typeof global.Stripe === 'function') {
        resolve(true);
        return;
      }
      var doc = global.document;
      if (!doc || typeof doc.createElement !== 'function') {
        reject(new Error('no_document'));
        return;
      }
      var script = doc.createElement('script');
      script.src = STRIPE_JS;
      script.async = true;
      var settled = false;
      function finish(err) {
        if (settled) return;
        settled = true;
        if (err) {
          if (script.parentNode) script.parentNode.removeChild(script);
          reject(err);
          return;
        }
        resolve(true);
      }
      var timer = setTimeout(function () { finish(new Error('stripe_js_timeout')); }, 8000);
      script.onload = function () {
        clearTimeout(timer);
        finish(null);
      };
      script.onerror = function () {
        clearTimeout(timer);
        finish(new Error('stripe_js_error'));
      };
      (doc.head || doc.documentElement).appendChild(script);
    });
  }

  apply(false);
  removeStripeScripts();

  var fetcher = typeof global.fetch === 'function' ? global.fetch.bind(global) : null;
  if (!fetcher) return;

  var fetchOpts = {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'Cache-Control': 'no-store' },
  };
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      fetchOpts.signal = AbortSignal.timeout(8000);
    }
  } catch (eSignal) { /* older browsers */ }

  fetcher('/.netlify/functions/stripe-config', fetchOpts).then(function (res) {
    if (!res || typeof res.json !== 'function') return null;
    var ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
    if (!ct.includes('json')) return null;
    return res.json();
  }).then(function (data) {
    if (!(data && data.customerPaymentsEnabled === true)) {
      apply(false);
      return null;
    }
    return loadStripeJs().then(function () { apply(true); });
  }).catch(function () {
    apply(false);
    removeStripeScripts();
  });
}(typeof window !== 'undefined' ? window : globalThis));
