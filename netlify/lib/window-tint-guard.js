'use strict';

const catalog = require('../../assets/window-tinting-demo-catalog');

const ID_RE = /\bwt_(?:film|glass|cov|resource|demo)_[a-z0-9_]+\b/i;

function mentions(value, found, depth) {
  if (depth > 10 || value == null) return;
  if (typeof value === 'string') {
    if (value === 'window_tint') found.add('window_tint');
    const match = value.match(ID_RE);
    if (match) found.add(match[0].toLowerCase());
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => mentions(item, found, depth + 1));
    return;
  }
  Object.keys(value).forEach((key) => {
    if (ID_RE.test(key)) found.add(key.toLowerCase());
    if (key === 'serviceFamily' && value[key] === 'window_tint') found.add('window_tint');
    mentions(value[key], found, depth + 1);
  });
}

function windowTintBlock(value) {
  const found = new Set();
  mentions(value, found, 0);
  if (!found.size) return null;
  // Readiness comes from the server copy of the catalog. Payload flags are not read.
  if (typeof catalog.commercialReady === 'function' && catalog.commercialReady() === true) return null;
  return {
    ok: false,
    bookingCreated: false,
    paymentCreated: false,
    error: 'window_tint_disabled',
    enabled: false,
    serviceFamily: 'window_tint',
  };
}

module.exports = { windowTintBlock };
