/**
 * Asks the server whether customer Stripe payments are on.
 * Fail closed. Only customerPaymentsEnabled === true from stripe-config opens
 * the card-online choice. Query, cookie, and host cannot enable it.
 */
(function (global) {
  'use strict';

  function apply(enabled) {
    var api = global.Cardetail1BookingReview;
    if (api && typeof api.setCustomerPaymentsEnabled === 'function') {
      api.setCustomerPaymentsEnabled(enabled === true);
    }
  }

  apply(false);

  var fetcher = typeof global.fetch === 'function' ? global.fetch.bind(global) : null;
  if (!fetcher) return;

  fetcher('/.netlify/functions/stripe-config', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'Cache-Control': 'no-store' },
  }).then(function (res) {
    var ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
    if (!ct.includes('json')) return null;
    return res.json();
  }).then(function (data) {
    apply(!!(data && data.customerPaymentsEnabled === true));
  }).catch(function () {
    apply(false);
  });
}(typeof window !== 'undefined' ? window : globalThis));
