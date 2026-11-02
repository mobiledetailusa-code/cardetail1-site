'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bridgeSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'assets', 'hub-booking-bridge.js'),
  'utf8'
);

function loadBridge(pathname) {
  const sandbox = {
    location: { pathname, search: '' },
    document: {
      body: { classList: { contains: () => false } },
      readyState: 'loading',
      addEventListener() {},
    },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(bridgeSource, sandbox, { filename: 'hub-booking-bridge.js' });
  return sandbox.CD1HubBookingBridge;
}

test('hub booking bridge activates on Netlify clean URLs', () => {
  for (const pathname of [
    '/new-jersey-hub',
    '/essex-county-hub',
    '/bergen-county-hub/',
    '/newark-mobile-detailing',
    '/template-city',
  ]) {
    assert.ok(loadBridge(pathname), `${pathname} must delegate to the canonical booking modal`);
  }
});

test('hub booking bridge preserves legacy .html URL support', () => {
  for (const pathname of [
    '/new-jersey-hub.html',
    '/newark-mobile-detailing.html',
    '/template-city.html',
  ]) {
    assert.ok(loadBridge(pathname), `${pathname} must keep delegating`);
  }
});

test('hub booking bridge stays inactive on homepage and specialty pages', () => {
  for (const pathname of ['/', '/index.html', '/boats-detailing', '/powersports-detailing']) {
    assert.equal(loadBridge(pathname), undefined, `${pathname} must use its own booking entry path`);
  }
});
