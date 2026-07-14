const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const PUBLIC_PAGES = [
  'index.html',
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
  'fleet-services.html',
  'multi-vehicle-detailing.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'bergen-county-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'terms-conditions.html',
];

const canonicalFooter = read('assets/partials/specialty-public-footer.html')
  .replace(/<!--[\s\S]*?-->\s*/, '')
  .replace(/\s+/g, ' ')
  .trim();

test('public pages include My Garage in top navigation', () => {
  const hubPages = PUBLIC_PAGES.filter((p) => p !== 'terms-conditions.html' && p !== 'index.html');
  for (const page of hubPages) {
    const html = read(page);
    if (!html.includes('id="nav-links"')) continue;
    assert.match(html, /nav-links[\s\S]*my-garage\.html/, `${page} missing My Garage in top nav`);
  }
});

test('every public page includes shared back-to-top assets', () => {
  for (const page of PUBLIC_PAGES) {
    const html = read(page);
    assert.match(html, /<script[^>]+assets\/back-to-top\.js/, `${page} missing back-to-top.js script tag`);
    assert.match(html, /assets\/public-surface\.css/, `${page} missing public-surface.css`);
  }
});

test('no obsolete inline #btt button on public pages', () => {
  for (const page of PUBLIC_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /<button[^>]*id="btt"/i, `${page} still has inline #btt`);
    assert.doesNotMatch(html, /function syncBtt\(/, `${page} still has syncBtt listener`);
  }
});

test('no duplicate customer portal modal DOM', () => {
  for (const page of PUBLIC_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /id="cp-ov"/, `${page} still has legacy cp-ov modal`);
    assert.doesNotMatch(html, /cd1_reviews_pending/, `${page} still has localStorage review placeholder`);
  }
});

test('public pages use canonical footer content once', () => {
  for (const page of PUBLIC_PAGES) {
    const html = read(page);
    assert.match(html, /id="cd1-public-footer"/, `${page} missing canonical footer id`);
    assert.match(html, /my-garage\.html/, `${page} missing My Garage link`);
    assert.match(html, /my-garage\.html#payments/, `${page} missing Pay a Balance link`);
    const footers = html.match(/<footer[\s\S]*?<\/footer>/gi) || [];
    assert.equal(footers.length, 1, `${page} must have exactly one footer`);
    const footerBlock = footers[0];
    assert.doesNotMatch(footerBlock, /Specialty Services/i, `${page} footer has duplicate Specialty Services column`);
    assert.doesNotMatch(footerBlock, /href="customer\.html"/, `${page} footer still links to customer.html`);
    const normalized = footerBlock.replace(/\s+/g, ' ').trim();
    assert.equal(normalized, canonicalFooter, `${page} footer differs from canonical partial`);
  }
});

test('customer.html always redirects to My Garage', () => {
  const html = read('customer.html');
  assert.doesNotMatch(html, /legacy=1/, 'customer.html must not support legacy portal flag');
  assert.doesNotMatch(html, /#s-lookup|#s-app/, 'customer.html must not contain legacy portal shell');
  assert.match(html, /my-garage\.html/, 'customer.html must redirect to my-garage');
  assert.match(html, /location\.replace/, 'customer.html must use replace redirect');
});

test('legacy=1 cannot restore old portal', () => {
  const html = read('customer.html');
  assert.doesNotMatch(html, /legacy/, 'no legacy bypass parameter');
});

test('index openPortal redirects to My Garage', () => {
  const html = read('index.html');
  assert.match(html, /function openPortal\(\)\{window\.location\.href='my-garage\.html#lookup';/);
});

test('admin-ops wires customer change requests endpoint', () => {
  const html = read('admin-ops.html');
  assert.match(html, /admin-customer-requests/, 'admin-ops must call admin-customer-requests');
  assert.match(html, /Customer Change Requests/, 'admin-ops section title');
  assert.match(html, /req-approve/, 'approve action');
  assert.match(html, /req-reject/, 'reject action');
  assert.match(html, /req-clarify/, 'clarify action');
});

test('admin-customer-requests requires admin auth', () => {
  const src = read('netlify/functions/admin-customer-requests.js');
  assert.match(src, /verifyAdminRequest/);
  assert.match(src, /unauthorized/);
  assert.doesNotMatch(src, /stripeSecret|paymentIntentId|setupIntentId/i);
});

test('back-to-top module is single-init', () => {
  const js = read('assets/back-to-top.js');
  assert.match(js, /__CD1_BTT_INIT__/);
  assert.match(js, /cd1-btt/);
  assert.match(js, /prefers-reduced-motion/);
});
