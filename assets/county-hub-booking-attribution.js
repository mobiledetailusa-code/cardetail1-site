/** Keep the ad query on the existing homepage booking handoff. */
(function (global) {
  'use strict';

  var KEYS = [
    'gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  ];

  function currentAttribution() {
    var src = new URLSearchParams(global.location.search || '');
    var extra = new URLSearchParams();
    KEYS.forEach(function (key) {
      var value = src.get(key);
      if (value) extra.set(key, value);
    });
    return extra;
  }

  function isBookingHandoff(url) {
    if (url.origin !== global.location.origin) return false;
    return url.pathname === '/' && !!url.searchParams.get('book');
  }

  function decorateLinks(extra) {
    document.querySelectorAll('a[href]').forEach(function (link) {
      var raw = link.getAttribute('href');
      if (!raw || raw.charAt(0) === '#') return;
      var url;
      try { url = new URL(raw, global.location.href); } catch (e) { return; }
      if (!isBookingHandoff(url)) return;
      extra.forEach(function (value, key) {
        if (!url.searchParams.get(key)) url.searchParams.set(key, value);
      });
      link.setAttribute('href', url.pathname + url.search + url.hash);
    });
  }

  function decorateForms(extra) {
    document.querySelectorAll('form[action="/"]').forEach(function (form) {
      extra.forEach(function (value, key) {
        if (form.querySelector('[name="' + key + '"]')) return;
        var input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = value;
        form.appendChild(input);
      });
    });
  }

  function apply() {
    var extra = currentAttribution();
    if (!extra.toString()) return;
    decorateLinks(extra);
    decorateForms(extra);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})(typeof window !== 'undefined' ? window : globalThis);
