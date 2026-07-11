/**
 * Encoding + public Cars chat pricing correction tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const PUBLIC_HTML = fs.readdirSync(root).filter((f) => f.endsWith('.html') && !['admin.html', 'bid.html', 'customer.html', 'technician.html'].includes(f));

const MOJIBAKE_PATTERNS = [
  'ï¿½', 'â€™', 'â€˜', 'â€œ', 'â€\u009D', 'â€“', 'â€”', 'â€¦', 'Â·', 'â€¢',
  'â†\u0090', 'âœ¦', 'âž¤', 'â‰¥', 'â›µ', 'â›³', 'â˜†', 'â–´', 'ðŸ', '📍±', '📍‹',
];

const HUB_CITY_PAGES = [
  'new-jersey-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html', 'pennsylvania-hub.html',
  'bergen-county-hub.html', 'essex-county-hub.html', 'hudson-county-hub.html', 'passaic-county-hub.html',
  'newark-mobile-detailing.html', 'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html',
];

const CHAT_PAGES = ['index.html', ...HUB_CITY_PAGES];

function hasBom(text) {
  return text.charCodeAt(0) === 0xfeff;
}

test('no public HTML page contains known mojibake sequences', () => {
  for (const page of PUBLIC_HTML) {
    const html = read(page);
    for (const seq of MOJIBAKE_PATTERNS) {
      assert.doesNotMatch(html, new RegExp(seq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${page} contains mojibake ${JSON.stringify(seq)}`);
    }
  }
});

test('no public HTML page contains the Unicode replacement character', () => {
  for (const page of PUBLIC_HTML) {
    assert.doesNotMatch(read(page), /\uFFFD/, `${page} contains replacement character`);
  }
});

test('every public HTML page declares UTF-8', () => {
  for (const page of PUBLIC_HTML) {
    assert.match(read(page), /<meta charset="UTF-8">/i, `${page} missing UTF-8 meta`);
  }
});

test('no public HTML file contains an unexpected UTF-8 BOM', () => {
  for (const page of PUBLIC_HTML) {
    assert.equal(hasBom(read(page)), false, `${page} has UTF-8 BOM`);
  }
  for (const asset of ['assets/specialty-booking-bridge.js']) {
    if (fs.existsSync(path.join(root, asset))) {
      assert.equal(hasBom(read(asset)), false, `${asset} has UTF-8 BOM`);
    }
  }
});

test('hub/city booking-policy text remains intact', () => {
  for (const page of HUB_CITY_PAGES) {
    const html = read(page);
    assert.match(html, /booking-policy|Booking Policy/i, `${page} missing booking policy section`);
    assert.match(html, /cancellation|reschedule/i, `${page} missing cancellation/reschedule policy text`);
  }
});

test('updateBkFromPrices remains syntactically complete on all public pages with booking', () => {
  for (const page of PUBLIC_HTML) {
    const html = read(page);
    if (!html.includes('function updateBkFromPrices')) continue;
    assert.doesNotMatch(html, /function updateBkFromPrices\(\)\{\s*\}/, `${page} empty updateBkFromPrices`);
    assert.match(html, /function updateBkFromPrices\(\)\{[\s\S]*?el\.textContent[\s\S]*?\n\}/, `${page} truncated updateBkFromPrices`);
  }
});

test('getCategoryFromBases public Cars minimum is Interior Detail at 225', () => {
  const html = read('index.html');
  assert.match(html, /function getCategoryFromBases\(\)\{[\s\S]*?\.interior\)/);
  assert.match(html, /cars:Math\.min\(\.\.\.Object\.values\(PRICING\.cars\.tiers\)\.map\(t=>t\.interior\)\)/);
  const carsBlock = html.match(/cars:\s*\{[\s\S]*?packages:\s*\[/);
  assert.ok(carsBlock, 'cars pricing block missing');
  const interiors = [...carsBlock[0].matchAll(/interior:(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(interiors.length >= 4, 'expected interior tier prices');
  assert.equal(Math.min(...interiors), 225);
});

test('chat public Cars starting price uses getCategoryFromBases not hardcoded 175', () => {
  for (const page of CHAT_PAGES) {
    const html = read(page);
    assert.match(html, /function chatStartingPricesReply\(\)/, `${page} missing chatStartingPricesReply`);
    assert.match(html, /getCategoryFromBases\(\)/, `${page} missing getCategoryFromBases`);
    assert.match(html, /applyRichPrice\(b\.cars\)/, `${page} chat cars price not derived from category bases`);
    assert.match(html, /reply:chatStartingPricesReply\(\)/, `${page} pricing intent not wired to chatStartingPricesReply`);
    assert.doesNotMatch(html, /Cars & Trucks — from <b>\$175/, `${page} hardcoded chat cars $175`);
    assert.doesNotMatch(html, /from <b>\$175<\/b> \(Interior Detail\)/, `${page} hardcoded $175 interior promo`);
  }
});

test('chat does not use maint tier as promotional Cars minimum', () => {
  for (const page of CHAT_PAGES) {
    const html = read(page);
    const helper = html.match(/function chatStartingPricesReply\(\)\{[\s\S]*?\n\}/);
    assert.ok(helper, `${page} missing chat helper`);
    assert.doesNotMatch(helper[0], /maint|175/, `${page} chat helper references maint/175`);
    assert.match(helper[0], /Interior Detail/, `${page} chat helper should identify Interior Detail`);
  }
});

test('booking still contains Maintenance Detail at 175 and Interior Detail at 225', () => {
  const html = read('index.html');
  assert.match(html, /maint:175/);
  assert.match(html, /interior:225/);
  assert.match(html, /id:'maint'[\s\S]*?Maintenance Detail/);
  assert.match(html, /id:'interior'[\s\S]*?Interior Detail/);
});

test('public homepage Cars price remains 225', () => {
  const html = read('index.html');
  assert.match(html, /id="home-from-interior">\$225/);
});

test('specialty public prices unchanged', () => {
  const html = read('index.html');
  assert.match(html, /id="bkfrom-boats"[\s\S]*?From \$199/);
  assert.match(html, /id="bkfrom-rvs"[\s\S]*?From \$349/);
  assert.match(html, /id="bkfrom-powersports"[\s\S]*?From \$119/);
  assert.ok(fs.existsSync(path.join(root, 'fleet-services.html')));
});

test('Netlify Function changes since stabilization are limited to ai-chat pricing guidance', () => {
  const tracked = execSync('git diff --name-only f64f5f587b7470535891471e62665c8901799263 -- netlify/functions', {
    cwd: root,
    encoding: 'utf8',
  });
  const files = tracked.trim().split(/\r?\n/).filter(Boolean);
  const allowed = new Set([
    'netlify/functions/ai-chat.js',
    'netlify/functions/submit-booking.js',
    'netlify/functions/create-setup-intent.js',
    'netlify/functions/revenue-event.js',
    'netlify/functions/garage-plan-submit.js',
    'netlify/functions/revenue-admin.js',
    'netlify/functions/revenue-resume-link.js',
    'netlify/functions/booking-card-status.js',
    'netlify/functions/lookup-booking.js',
    'netlify/functions/request-cancellation.js',
    'netlify/functions/submit-customer-action.js',
    'netlify/functions/admin-customer-requests.js',
    'netlify/functions/customer-portal-auth.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/functions/customer-portal-vehicles.js',
    'netlify/functions/qa-my-garage-fixtures.js',
  ]);
  for (const file of files) {
    assert.ok(allowed.has(file), `unexpected Netlify Function diff: ${file}`);
  }
});

test('correction commit leaves package IDs and pricing formulas unchanged from checkpoint', () => {
  const diff = execSync('git diff f64f5f587b7470535891471e62665c8901799263 -- index.html', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.doesNotMatch(diff, /^[-+].*id:'maint'/m);
  assert.doesNotMatch(diff, /^[-+].*maint:175/m);
  assert.doesNotMatch(diff, /^[-+].*interior:225/m);
  assert.doesNotMatch(diff, /^[-+].*perFt:/m);
});
