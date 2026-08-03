const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin-ops.html'), 'utf8');

// Boot admin-ops.html far enough to bind the navigation handlers, without any
// network. The inline IIFE needs CD1AdminSession/SiteAccess to exist before it
// runs, and every backend call is stubbed so this asserts UI wiring only.
function boot() {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/admin-ops.html',
    beforeParse(window) {
      window.CD1AdminSession = {
        SESS_KEY: 'cd1_admin',
        getToken: () => 'test-token',
        clearToken: () => {},
        syncWindowKey: () => {},
        refreshFailureMessage: (label, stale) => `${label} could not be refreshed.`,
        editShouldTriggerRefreshAll: () => false,
      };
      window.SiteAccess = { adminSection: () => '' };
      window.fetch = () => new Promise(() => {});
      window.alert = () => {};
      window.confirm = () => true;
      window.prompt = () => null;
      window.scrollTo = () => {};
      window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
    },
  });
  return { dom, doc: dom.window.document, errors };
}

test('navigation controls meet the 44px touch target rule', () => {
  assert.match(html, /\.tab,\.tab-more\{min-height:44px\}/);
});

if (JSDOM) {
test('primary navigation is exactly Jobs, Requests, Payments, Settings', () => {
  const { doc } = boot();
  const primary = [...doc.querySelectorAll('#tabs > .tab')].map((b) => b.dataset.tab);
  assert.deepEqual(primary, ['jobs', 'requests', 'payments', 'settings']);
});

test('Jobs is the initially selected tab and the only visible panel', () => {
  const { doc } = boot();
  const on = [...doc.querySelectorAll('.panel.on')];
  assert.equal(on.length, 1, 'exactly one panel may be visible');
  assert.equal(on[0].id, 'p-jobs');
  const selected = [...doc.querySelectorAll('#tabs .tab[aria-selected="true"]')];
  assert.equal(selected.length, 1);
  assert.equal(selected[0].dataset.tab, 'jobs');
});

test('More is collapsed on load and reveals secondary tabs when opened', () => {
  const { doc } = boot();
  const toggle = doc.querySelector('#tabsMoreToggle');
  const more = doc.querySelector('#tabsMore');
  assert.ok(toggle && more);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(more.hasAttribute('hidden'), true, 'More must start collapsed');
  assert.equal(toggle.getAttribute('aria-controls'), 'tabsMore');

  toggle.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(more.hasAttribute('hidden'), false);

  toggle.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(more.hasAttribute('hidden'), true);
});

test('every legacy Admin capability survives under More', () => {
  const { doc } = boot();
  const secondary = [...doc.querySelectorAll('#tabsMore .tab')].map((b) => b.dataset.tab);
  assert.deepEqual(secondary, [
    'overview', 'techs', 'assign', 'completed', 'issues',
    'auctions', 'subscriptions', 'maintenance', 'events', 'revops',
  ]);
  for (const id of secondary) {
    assert.ok(doc.querySelector(`#p-${id}`), `panel p-${id} was deleted`);
  }
});

test('switching to Payments shows only the Payments panel', () => {
  const { doc } = boot();
  const tab = doc.querySelector('#tabs .tab[data-tab="payments"]');
  tab.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const on = [...doc.querySelectorAll('.panel.on')];
  assert.equal(on.length, 1);
  assert.equal(on[0].id, 'p-payments');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
});

test('opening a secondary tab from More still switches panels', () => {
  const { doc } = boot();
  doc.querySelector('#tabsMoreToggle').dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const events = doc.querySelector('#tabsMore .tab[data-tab="events"]');
  events.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  const on = [...doc.querySelectorAll('.panel.on')];
  assert.equal(on.length, 1);
  assert.equal(on[0].id, 'p-events');
});

test('booting the Admin shell raises no uncaught errors', () => {
  const { errors } = boot();
  assert.deepEqual(errors, []);
});
}
