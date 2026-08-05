const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const stateHubs = [
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
];

const approvedH1 = {
  'new-jersey-hub.html': 'Mobile Car Detailing in New Jersey',
  'ny-metro-hub.html': 'Mobile Car Detailing in New York City & Nearby Suburbs',
  'connecticut-hub.html': 'Mobile Car Detailing in Connecticut',
  'pennsylvania-hub.html': 'Mobile Car Detailing in Eastern Pennsylvania',
};

const accordionGroupCounts = {
  'new-jersey-hub.html': 6,
  'ny-metro-hub.html': 4,
  'connecticut-hub.html': 1,
  'pennsylvania-hub.html': 1,
};

const fleetBranch = 'ux-remove-fleet-from-booking';

function extractFleetCityLinks(file) {
  try {
    const html = execSync(`git show ${fleetBranch}:${file}`, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const links = [];
    const re = /<a class="cd1-cidades-atendidas__link" href="([^"]+)">([^<]+)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      links.push({ href: m[1], text: m[2].trim() });
    }
    return links;
  } catch {
    return [];
  }
}

function extractAccordionCityLinks(html) {
  const links = [];
  const re = /<ul class="service-area-links">([\s\S]*?)<\/ul>/g;
  let block;
  while ((block = re.exec(html)) !== null) {
    const inner = block[1];
    const linkRe = /<a href="([^"]+)">([^<]+)<\/a>/g;
    let m;
    while ((m = linkRe.exec(inner)) !== null) {
      links.push({ href: m[1], text: m[2].trim() });
    }
  }
  return links;
}

function countH1(html) {
  return (html.match(/<h1\b/gi) || []).length;
}

for (const page of stateHubs) {
  test(`${page} has exactly one H1`, () => {
    assert.equal(countH1(read(page)), 1);
  });

  test(`${page} uses approved location-specific H1`, () => {
    const html = read(page);
    const h1Match = html.match(/<h1>([^<]*)<\/h1>/);
    assert.ok(h1Match, 'missing h1');
    const h1Text = h1Match[1].replace(/&amp;/g, '&').trim();
    assert.equal(h1Text, approvedH1[page]);
  });

  test(`${page} service-area accordions are collapsed by default`, () => {
    const html = read(page);
    assert.match(html, /class="service-area-accordion"/);
    assert.doesNotMatch(html, /<details class="service-area-accordion"[^>]*\sopen[\s=>]/);
    assert.doesNotMatch(html, /<details class="service-area-accordion" open>/);
  });

  test(`${page} has expected accordion group count`, () => {
    const html = read(page);
    const count = (html.match(/class="service-area-accordion"/g) || []).length;
    assert.equal(count, accordionGroupCounts[page]);
  });

  test(`${page} city links remain anchor elements with href`, () => {
    const html = read(page);
    const section = html.match(/<section class="service-area-section"[\s\S]*?<\/section>/);
    assert.ok(section, 'service-area-section missing');
    assert.doesNotMatch(section[0], /<button[^>]*class="service-area/);
    const links = extractAccordionCityLinks(html);
    assert.ok(links.length > 0, 'expected city links in accordion HTML');
    for (const link of links) {
      assert.match(link.href, /^\/[a-z0-9-]+\.html(#.+)?$/i);
      assert.ok(link.text.length > 0);
    }
  });

  test(`${page} accordion summaries are keyboard-accessible details/summary`, () => {
    const html = read(page);
    assert.match(html, /<details class="service-area-accordion"[^>]*>\s*<summary>/);
  });
}

test('homepage uses the new clear H1', () => {
  const html = read('index.html');
  assert.match(html, /<h1>Mobile Car Detailing at Your Home or Office<\/h1>/);
  assert.equal(countH1(html), 1);
});

test('homepage title matches Bergen County pattern', () => {
  const html = read('index.html');
  assert.match(html, /<title>Mobile Car Detailing in Bergen County, NJ \| Cardetail1<\/title>/);
});

test('fleet-branch city URLs preserved on NJ/NY/CT state hubs', (t) => {
  for (const page of ['new-jersey-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html']) {
    const fleetLinks = extractFleetCityLinks(page);
    if (!fleetLinks.length) {
      t.skip(`reference branch ${fleetBranch} is unavailable in this checkout`);
      return;
    }
    const currentLinks = extractAccordionCityLinks(read(page));
    assert.equal(currentLinks.length, fleetLinks.length, `${page} link count`);
    for (let i = 0; i < fleetLinks.length; i++) {
      assert.equal(currentLinks[i].href, fleetLinks[i].href, `${page} href[${i}]`);
      assert.equal(currentLinks[i].text, fleetLinks[i].text, `${page} text[${i}]`);
    }
  }
});

test('PA hub keeps footer-derived service area links', () => {
  const html = read('pennsylvania-hub.html');
  const links = extractAccordionCityLinks(html);
  const texts = links.map((l) => l.text);
  assert.deepEqual(texts, ['Philadelphia', 'Allentown', 'King of Prussia', 'Scranton']);
  for (const link of links) {
    assert.equal(link.href, '/pennsylvania-hub.html#eastern-pennsylvania');
  }
});

test('single-open accordion script is wired on state hubs', () => {
  const js = read('assets/service-area-accordion.js');
  assert.match(js, /data-single-open/);
  assert.match(js, /addEventListener\('toggle'/);
  for (const page of stateHubs) {
    const html = read(page);
    assert.match(html, /data-single-open/);
    assert.match(html, /service-area-accordion\.js/);
  }
});

test('hub heroes use shared brand gradient without background images', () => {
  const css = read('assets/hub-styles.css');
  assert.match(css, /radial-gradient\(circle at 82% 20%, rgba\(77, 163, 255, 0\.12\), transparent 34%\)/);
  assert.match(css, /linear-gradient\(135deg, #07111d 0%, #0a1725 55%, #07101a 100%\)/);
  assert.match(css, /#ffffff !important/);
  assert.doesNotMatch(css, /background-image:\s*url\(/);
});

test('state hubs load luxury theme stylesheet', () => {
  for (const page of stateHubs) {
    const html = read(page);
    assert.match(html, /luxury-theme\.css/);
    assert.match(html, /STATE HUB LUXURY THEME/);
    assert.match(html, /--bg0:#12181f/);
    assert.match(html, /class="luxury-surface"/);
    assert.match(html, /hero--hub-brand/);
    assert.doesNotMatch(html, /hero-bg-desktop/);
    assert.doesNotMatch(html, /luxury-hero-glow/);
  }
});

test('homepage restores master cars-suvs hero image with PR #96 copy', () => {
  const index = read('index.html');
  assert.match(index, /class="luxury-surface"/);
  assert.match(index, /--bg0:#12181f/);
  assert.match(index, /luxury-theme\.css/);
  assert.doesNotMatch(index, /hub-styles\.css/);
  assert.doesNotMatch(index, /hero--home/);
  assert.doesNotMatch(index, /hero-bg-desktop/);
  assert.match(index, /url\("assets\/vehicles\/premium\/cars-suvs\.webp"\) center right\/cover no-repeat/);
  assert.match(index, /<h1>Mobile Car Detailing at Your Home or Office<\/h1>/);
  assert.match(read('assets/luxury-theme.css'), /body\.luxury-surface/);
  assert.doesNotMatch(read('assets/luxury-theme.css'), /hero--home/);
});

const revisedHubPages = [
  ...stateHubs,
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

test('revised hub pages remove hero background image layers from markup', () => {
  for (const page of revisedHubPages) {
    const html = read(page);
    assert.doesNotMatch(html, /hero-bg-desktop/);
    assert.doesNotMatch(html, /hero-bg-mobile/);
    assert.match(html, /hero--hub-brand/);
  }
});

test('city hub pages drop hero-mobile-detailing background URLs', () => {
  for (const page of [
    'newark-mobile-detailing.html',
    'trenton-mobile-detailing.html',
    'westchester-mobile-detailing.html',
    'template-city.html',
  ]) {
    const html = read(page);
    assert.doesNotMatch(html, /hero-mobile-detailing/);
    assert.match(html, /assets\/hub-styles\.css/);
  }
});

test('state hub city links use readable colors on luxury dark surface', () => {
  const css = read('assets/service-area-accordion.css');
  assert.match(css, /\.service-area-links a\{[^}]*color:#9aa8b8/);
  assert.match(read('assets/luxury-theme.css'), /#d4b896/);
  for (const page of stateHubs) {
    const html = read(page);
    assert.match(html, /class="service-area-links"/);
  }
});

test('state hubs keep hero--contrast with high-contrast white headline on brand hero', () => {
  const css = read('assets/hub-styles.css');
  for (const page of stateHubs) {
    const html = read(page);
    assert.match(html, /hero--contrast/);
  }
  assert.match(css, /#ffffff !important/);
});

test('header navigation remains visible on hub pages', () => {
  for (const page of stateHubs) {
    const html = read(page);
    assert.match(html, /class="nav"/);
    assert.match(html, /nav-menu-btn/);
    assert.match(html, /nav-link/);
  }
  const navCss = read('assets/hub-styles.css');
  assert.match(navCss, /rgba\(23,\s*33,\s*47,\s*0\.96\)/);
});

test('no Netlify Function files changed in this UX scope', () => {
  const diff = execSync('git diff --name-only e9ebbe0', { cwd: root, encoding: 'utf8' });
  const changed = diff.split('\n').filter(Boolean);
  const functionChanges = changed.filter((file) => /^netlify\/functions\//.test(file));
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
    'netlify/functions/tech-complete-job.js',
    'netlify/functions/tech-jobs.js',
    'netlify/functions/customer-portal-action.js',
    'netlify/functions/evaluate-booking-offer.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/qa-opscore-lifecycle.js',
    // Release A — canonical aggregate / payments
    'netlify/functions/create-payment-intent.js',
    'netlify/functions/create-payment-link.js',
    'netlify/functions/capture-payment.js',
    'netlify/functions/customer-subscription-checkout.js',
    'netlify/functions/customer-bookings.js',
    // Customer identity security prerequisites — revoke orphan public subscription actions.
    'netlify/functions/subscriptions-ops.js',
    'netlify/functions/customer-portal-pay.js',
    'netlify/functions/stripe-webhook.js',
    'netlify/functions/list-bookings.js',
    // Phase 2/3 Postgres foundation — additive, non-sensitive health endpoint.
    'netlify/functions/db-health.js',
    // Operational Postgres payment wiring.
    'netlify/functions/customer-balance-payment-intent.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/functions/admin-ops-jobs.js',
    // Stage 2A — authenticated profile + address management
    'netlify/functions/customer-portal-profile.js',
    // Post-release hardening — disabled-by-default identity smoke harness
    'netlify/functions/qa-customer-identity-smoke.js',
    // Appointment direct access + transactional notifications
    'netlify/functions/customer-appointment-access.js',
    'netlify/functions/update-booking.js',
    'netlify/functions/qa-appointment-access-mint.js',
    'netlify/functions/qa-blobs-health.js',
    // Owner Studio Stage 1 — protected read-only status endpoint (flags off by default)
    'netlify/functions/owner-studio-status.js',
    // Existing PR #157 operational surfaces.
    'netlify/functions/booking-availability.js',
    'netlify/functions/customer-receipt.js',
    'netlify/functions/ops-settings.js',
    'netlify/functions/submit-review.js',
    'netlify/functions/tech-accounts.js',
  ]);
  for (const file of functionChanges) {
    assert.ok(allowed.has(file), `unexpected function change: ${file}`);
  }
});

test('package IDs and prices remain unchanged on index', () => {
  const index = read('index.html');
  assert.ok(index.includes('refresh:320, premium:385'));
  assert.ok(index.includes('refresh:360, premium:470'));
});

test('fleet-removal behavior remains on hub pages', () => {
  for (const page of stateHubs) {
    const html = read(page);
    assert.doesNotMatch(html, /openBooking\('fleet'\)/);
    assert.match(html, /openCommercialInquiry/);
  }
});

test('mobile layout guards against horizontal overflow', () => {
  const css = read('assets/service-area-accordion.css');
  assert.match(read('index.html'), /overflow-x:hidden/);
  assert.match(css, /minmax\(120px,\s*1fr\)/);
  assert.match(css, /overflow-wrap:anywhere/);
});

test('ZIP query behavior helpers remain on state hubs', () => {
  for (const page of stateHubs) {
    const html = read(page);
    assert.match(html, /function syncBookingZipFromHero/);
    assert.match(html, /id="hero-zip"/);
  }
});

const scopePages = [
  ...stateHubs,
  'index.html',
  'bergen-county-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

test('scoped pages each have exactly one H1', () => {
  for (const page of scopePages) {
    assert.equal(countH1(read(page)), 1, page);
  }
});

test('county hubs use Mobile Car Detailing in <County> pattern', () => {
  const expected = {
    'bergen-county-hub.html': 'Mobile Car Detailing in Bergen County',
    'essex-county-hub.html': 'Mobile Car Detailing in Essex County',
    'hudson-county-hub.html': 'Mobile Car Detailing in Hudson County',
    'passaic-county-hub.html': 'Mobile Car Detailing in Passaic County',
  };
  for (const [page, h1] of Object.entries(expected)) {
    assert.match(read(page), new RegExp(`<h1>${h1}</h1>`));
  }
});

test('city pages use Mobile Car Detailing in <Location> pattern', () => {
  assert.match(read('newark-mobile-detailing.html'), /<h1>Mobile Car Detailing in Newark<\/h1>/);
  assert.match(read('trenton-mobile-detailing.html'), /<h1>Mobile Car Detailing in Trenton<\/h1>/);
  assert.match(read('westchester-mobile-detailing.html'), /<h1>Mobile Car Detailing in Westchester<\/h1>/);
  assert.match(read('template-city.html'), /<h1>Mobile Car Detailing in \{CITY_NAME\}<\/h1>/);
});
