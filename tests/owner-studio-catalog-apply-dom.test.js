'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'admin-owner-studio-catalog.html'), 'utf8');
const INLINE_APP = [...HTML.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter((source) => source.trim())
  .pop();
const HTML_NO_SCRIPTS = HTML.replace(/<script[\s\S]*?<\/script>/g, '');

const DRAFT = {
  version: 31,
  vehicleClasses: [
    { vehicleClassId: 'vc_sedan', label: 'Sedan', category: 'cars', active: true, displayOrder: 1 },
  ],
  packages: [
    {
      packageId: 'pkg_full_detail', legacyKey: 'full', category: 'cars', name: 'Full Detail',
      slug: 'full-detail', active: true, displayOrder: 1, features: [],
      compatibleVehicleClassIds: ['vc_sedan'], compatibleAddOnIds: [],
      prices: [{ packageId: 'pkg_full_detail', vehicleClassId: 'vc_sedan', currency: 'usd', amountCents: 28500, priceModel: 'flat' }],
    },
  ],
  addOns: [],
  priceConflicts: [],
};

function response(body) {
  return { ok: true, status: 200, headers: { get: () => '' }, json: async () => body };
}

async function boot() {
  const browserErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => browserErrors.push(String(error.message || error)));
  const dom = new JSDOM(HTML_NO_SCRIPTS, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
    url: 'https://deploy-preview-145--cardetail1-staging.netlify.app/admin/owner-studio/catalog',
  });
  const { window } = dom;
  window.CatalogUxLogic = require(path.join(ROOT, 'netlify/lib/owner-studio-catalog-ux-logic.js'));
  window.CD1AdminSession = { getToken: () => 'test-token', onSessionEvent: () => {}, clearToken: () => {} };
  window.fetch = async (url) => {
    const target = String(url);
    if (target.includes('action=csrf')) return response({ ok: true, csrfToken: 'csrf-test' });
    if (target.includes('action=list_revisions')) return response({ ok: true, items: [] });
    if (target.includes('action=get_draft') || target.includes('action=overview')) {
      return response({
        ok: true,
        draft: structuredClone(DRAFT),
        capabilities: { canRead: true, canEdit: true, canSave: true, canResolveConflicts: true, canRestoreRevision: true },
        mutationOrigin: { allowed: true, policy: 'exact-origin' },
      });
    }
    return response({ ok: true });
  };
  window.confirm = () => true;
  window.open = () => {};
  const uncaught = [];
  window.addEventListener('error', (event) => uncaught.push(String(event.message || event.error)));
  window.addEventListener('unhandledrejection', (event) => uncaught.push(String(event.reason?.message || event.reason)));
  vm.runInContext(INLINE_APP, dom.getInternalVMContext());
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (/Draft loaded/.test(window.document.getElementById('status-banner').textContent)) break;
  }
  return { dom, window, document: window.document, uncaught, browserErrors };
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

test('Catalog boot and Package Apply use the defined pending-edits predicate', async () => {
  assert.doesNotMatch(HTML, /hasPendingWork/);
  assert.match(HTML, /!hasPendingLocalEdits\(\)/);

  const { dom, window, document, uncaught, browserErrors } = await boot();
  assert.match(document.getElementById('status-banner').textContent, /Draft loaded/);
  assert.deepEqual(uncaught, []);
  assert.deepEqual(browserErrors, []);

  click(window, document.querySelector('#package-list button.list-btn'));
  const price = document.querySelector('#price-matrix input[data-vc]');
  price.value = '299.00';
  price.dispatchEvent(new window.Event('input', { bubbles: true }));
  click(window, document.getElementById('btn-apply-pkg'));

  assert.equal(document.getElementById('btn-save').disabled, false);
  assert.equal(document.getElementById('dirty').hidden, false);
  assert.deepEqual(uncaught, []);
  dom.window.close();
});
