'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'my-garage.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'assets', 'my-garage.js'), 'utf8');
const dashJs = fs.readFileSync(path.join(ROOT, 'assets', 'my-garage-dashboard.js'), 'utf8');

describe('customer portal dashboard layer (Phase 3)', () => {
  it('loads dashboard assets without replacing my-garage.js', () => {
    assert.match(html, /assets\/my-garage-dashboard\.css/);
    assert.match(html, /assets\/my-garage-dashboard\.js/);
    assert.match(html, /assets\/my-garage\.js/);
    const dashIdx = html.indexOf('my-garage-dashboard.js');
    const mainIdx = html.indexOf('my-garage.js');
    assert.ok(dashIdx > -1 && mainIdx > dashIdx, 'dashboard script loads before my-garage.js');
  });

  it('exposes calendar, timeline, map shell above upcoming panel', () => {
    const panelIdx = html.indexOf('id="upcoming-panel"');
    const dashIdx = html.indexOf('id="mg-dashboard"');
    assert.ok(dashIdx > -1 && panelIdx > dashIdx, 'dashboard sits above appointment card');
    for (const id of ['mgCalStrip', 'mgTimeline', 'mgMap']) {
      assert.ok(html.includes('id="' + id + '"'), 'missing #' + id);
    }
  });

  it('keeps customer action buttons immediately after the card', () => {
    const panel = html.indexOf('id="upcoming-panel"');
    const actions = html.indexOf('id="customer-actions"');
    assert.ok(panel > -1 && actions > panel);
    for (const action of ['reschedule_request', 'address_update', 'cancellation_request']) {
      assert.ok(html.includes(action), action + ' button must remain');
    }
  });

  it('dashboard module parses and exports CD1GarageDashboard', () => {
    const ctx = { window: {} };
    assert.doesNotThrow(() => {
      vm.runInNewContext(dashJs, ctx);
    });
    assert.equal(typeof ctx.window.CD1GarageDashboard.attach, 'function');
    assert.equal(typeof ctx.window.CD1GarageDashboard.render, 'function');
  });

  it('my-garage wires dashboard after renderDashboard', () => {
    assert.match(js, /CD1GarageDashboard\.attach/);
    assert.match(js, /CD1GarageDashboard\.render\(\)/);
    assert.match(js, /contractedTotal:\s*bookingBaseTotal/);
  });

  it('does not add new portal API fetches in dashboard layer', () => {
    assert.doesNotMatch(dashJs, /fetch\(|XMLHttpRequest|\.netlify\/functions/);
  });
});
