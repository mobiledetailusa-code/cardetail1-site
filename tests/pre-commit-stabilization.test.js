/**
 * Pre-commit stabilization checks — focused release blockers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const SPECIALTY_PAGES = ['boats-detailing.html', 'rv-detailing.html', 'powersports-detailing.html'];
const HUB_PAGES = [
  'new-jersey-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html', 'pennsylvania-hub.html',
  'bergen-county-hub.html', 'essex-county-hub.html', 'hudson-county-hub.html', 'passaic-county-hub.html',
  'newark-mobile-detailing.html', 'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html',
  'template-city.html', 'index.html',
];
const PACKAGE_MAP = {
  'boats-detailing.html': { cat: 'boats', pkgs: ['maint', 'full', 'premium'] },
  'rv-detailing.html': { cat: 'rvs', pkgs: ['maint_light', 'interior', 'full', 'premium'] },
  'powersports-detailing.html': { cat: 'powersports', pkgs: ['wash', 'full', 'premium'] },
};

function sitemapUrls() {
  const xml = read('sitemap.xml');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

function sitemapToFile(url) {
  const pathPart = url.replace('https://cardetail1.com/', '').replace(/\/$/, '');
  return pathPart || 'index.html';
}

function extractHomeServiceLinks(html) {
  const section = html.match(/<section class="home-service-areas"[\s\S]*?<\/section>/);
  if (!section) return [];
  const links = [];
  const re = /<a class="service-area-(?:city|hub)-link"\s+href="([^"]+)">([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(section[0])) !== null) {
    links.push({ href: m[1], text: m[2].trim() });
  }
  return links;
}

function resolveHref(href) {
  const [file, hash] = href.replace(/^\//, '').split('#');
  const filePath = path.join(root, file);
  assert.ok(fs.existsSync(filePath), `missing destination for ${href}`);
  if (hash) {
    const html = read(file);
    assert.match(html, new RegExp(`id="${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  return file;
}

test('sitemap reported count equals actual URL entries (18)', () => {
  const urls = sitemapUrls();
  assert.equal(urls.length, 18);
});

test('every sitemap route file exists on disk', () => {
  for (const url of sitemapUrls()) {
    const file = sitemapToFile(url);
    assert.ok(fs.existsSync(path.join(root, file)), `${url} -> ${file}`);
  }
});

test('no public booking page contains empty updateBkFromPrices stub', () => {
  for (const page of HUB_PAGES) {
    const html = read(page);
    if (!html.includes('function updateBkFromPrices')) continue;
    assert.doesNotMatch(
      html,
      /function updateBkFromPrices\(\)\{\s*\}/,
      `${page} has empty updateBkFromPrices stub`
    );
    if (html.includes('id="bkfrom-boats"')) {
      assert.match(html, /LENGTH_PRICING\.boats\.packages\.maint\.min/, `${page} missing boats price source`);
    }
  }
});

test('Boats RV Powersports share identical specialty-public-footer structure', () => {
  const canonical = read('assets/partials/specialty-public-footer.html')
    .replace(/<!--[\s\S]*?-->\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const page of SPECIALTY_PAGES) {
    const html = read(page);
    assert.match(html, /class="specialty-public-footer"/);
    assert.match(html, /Boats &amp; Marine/);
    assert.match(html, /RVs &amp; Trailers/);
    assert.match(html, /Motorcycles &amp; Powersports/);
    assert.match(html, /Commercial &amp; Fleet/);
    assert.match(html, /my-garage\.html/);
    assert.match(html, /terms-conditions\.html/);
    const footer = html.match(/<footer class="specialty-public-footer"[\s\S]*?<\/footer>/);
    assert.ok(footer, `${page} missing shared footer`);
    const normalized = footer[0].replace(/\s+/g, ' ').trim();
    assert.equal(normalized, canonical, `${page} footer differs from canonical partial`);
  }
});

test('booking bridge never redirects to homepage on failure', () => {
  const js = read('assets/specialty-booking-bridge.js');
  assert.doesNotMatch(js, /navigateToHomepageBooking/);
  assert.doesNotMatch(js, /location\.assign\s*\(\s*['"]index\.html/);
  assert.doesNotMatch(js, /window\.location\s*=\s*['"]\/?['"]/);
  assert.match(js, /We could not load this booking option/);
  assert.match(js, /551-313-2956/);
  assert.match(js, /categoryId === 'cars'/);
  assert.doesNotMatch(js, /fallback.*cars|default.*cars/i);
});

test('every specialty package CTA maps to valid package IDs', () => {
  const index = read('index.html');
  for (const [page, cfg] of Object.entries(PACKAGE_MAP)) {
    const html = read(page);
    for (const pkg of cfg.pkgs) {
      assert.match(
        html,
        new RegExp(`data-booking-category="${cfg.cat}"[^>]*data-booking-package="${pkg}"|data-booking-package="${pkg}"[^>]*data-booking-category="${cfg.cat}"`)
      );
      const catBlock = index.match(new RegExp(`${cfg.cat}:\\s*\\{[\\s\\S]*?packages:\\[([\\s\\S]*?)\\],\\s*addons:`));
      assert.ok(catBlock, `missing ${cfg.cat} packages in index`);
      assert.match(catBlock[1], new RegExp(`id:'${pkg}'`));
    }
  }
});

test('every homepage service-area link resolves to an existing file and anchor', () => {
  const links = extractHomeServiceLinks(read('index.html'));
  assert.ok(links.length >= 8 && links.length <= 12);
  for (const link of links) {
    resolveHref(link.href);
  }
});

test('homepage has compact specialty switcher and no oversized duplicate block', () => {
  const html = read('index.html');
  assert.match(html, /class="specialty-service-nav"/);
  assert.doesNotMatch(html, /id="specialty-services"/);
  assert.doesNotMatch(html, /More than cars/i);
  assert.doesNotMatch(html, /Featured boat page/i);
  const switchers = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/g) || [];
  assert.equal(switchers.length, 1);
});

test('accidental local QA server file is not in working tree', () => {
  assert.ok(!fs.existsSync(path.join(root, 'scripts/_qa-server.mjs')));
});

test('Netlify Function changes vs production master are limited to approved RevOps additions', () => {
  let diff = '';
  try {
    diff = execSync('git diff --name-only 4474151ed2d41647e2b61cdbca66bb497b5d3403 -- netlify/functions netlify/lib', {
      cwd: root,
      encoding: 'utf8',
    });
  } catch (e) {
    diff = e.stdout || '';
  }
  const changed = diff.trim().split(/\r?\n/).filter(Boolean);
  const allowed = new Set([
    'netlify/functions/revenue-event.js',
    'netlify/functions/garage-plan-submit.js',
    'netlify/functions/revenue-admin.js',
    'netlify/functions/revenue-resume-link.js',
    'netlify/functions/submit-booking.js',
    'netlify/functions/create-setup-intent.js',
    'netlify/lib/public-rate-limit.js',
    'netlify/lib/revenue-event-schema.js',
    'netlify/lib/revenue-store.js',
    'netlify/lib/revenue-segments.js',
    'netlify/lib/revenue-scoring.js',
    'netlify/lib/revenue-offers.js',
    'netlify/lib/booking-offers.js',
    'netlify/functions/evaluate-booking-offer.js',
    'netlify/lib/revenue-resume.js',
    'netlify/lib/revenue-recovery.js',
    'netlify/lib/revenue-household.js',
    'netlify/lib/hubspot-adapter.js',
    'netlify/lib/google-ads-export.js',
    'netlify/lib/recovery-communications.js',
    'netlify/lib/next-best-action.js',
    'netlify/lib/universal-customer-strategy.js',
    'netlify/lib/universal-customer-strategy-logic.js',
    'netlify/lib/universal-customer-strategy-config.json',
    'netlify/lib/anonymous-prospect.js',
    'netlify/lib/booking-routing-validation.js',
    'netlify/lib/garage-plan-validation.js',
    'netlify/functions/booking-card-status.js',
    'netlify/functions/lookup-booking.js',
    'netlify/functions/request-cancellation.js',
    'netlify/functions/submit-customer-action.js',
    'netlify/functions/admin-customer-requests.js',
    'netlify/functions/customer-portal-auth.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/functions/customer-portal-vehicles.js',
    'netlify/lib/ops-db.js',
    'netlify/lib/phone-auth.js',
    'netlify/lib/booking-customer-auth.js',
    'netlify/lib/customer-session.js',
    'netlify/lib/appointment-status-policy.js',
    'netlify/lib/customer-change-requests.js',
    'netlify/lib/customer-vehicles.js',
    'netlify/lib/admin-security.js',
    'netlify/lib/admin-booking-mutations.js',
    'netlify/lib/notification-delivery.js',
    'netlify/functions/tech-complete-job.js',
    'netlify/functions/tech-jobs.js',
    'netlify/functions/customer-portal-action.js',
    'netlify/functions/evaluate-booking-offer.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/lib/operations-lifecycle.js',
    'netlify/lib/operations-audit.js',
    'netlify/lib/customer-completion-link.js',
    'netlify/lib/customer-feature-flags.js',
    'netlify/lib/ops-workflow.js',
    'netlify/lib/revenue-store.js',
    'netlify/lib/revops-dashboard.js',
    'netlify/functions/qa-opscore-lifecycle.js',
    'netlify/lib/booking-price-catalog.js',
    'netlify/lib/rv-type-catalog.js',
    'netlify/lib/travel-fee.js',
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
    'netlify/lib/booking-visibility.js',
    'netlify/lib/historical-adapter.js',
    'netlify/lib/booking-aggregate.js',
    'netlify/lib/booking-repository.js',
    'netlify/lib/canonical-quote.js',
    'netlify/lib/stripe-mode.js',
    'netlify/lib/payment-service.js',
    'netlify/lib/booking-commands.js',
    'netlify/lib/portal-money-sync.js',
    'netlify/lib/ops-schema.js',
    'netlify/lib/customer-catalog.js',
    'netlify/lib/length-pricing.js',
    'netlify/lib/booking-schedule.js',
    'netlify/lib/draft-save-token.js',
    // Prisma dual-write mirror + card-on-file hardening (already shipped;
    // allowlist was never updated for them — see docs/audit/phase2-gate-report.md).
    'netlify/lib/booking-prisma-mirror.js',
    'netlify/lib/prisma.js',
    'netlify/lib/card-on-file.js',
    'netlify/lib/tech-security.js',
    // Phase 2/3 Postgres foundation — additive, not wired into live traffic.
    'netlify/functions/db-health.js',
    'netlify/functions/customer-balance-payment-intent.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/stripe-webhook.js',
    'netlify/lib/db/repositories.js',
    'netlify/lib/db/foundation-services.js',
    'netlify/lib/db/financial-projection.js',
    'netlify/lib/db/payment-authority-service.js',
    'netlify/lib/db/webhook-inbox.js',
    'netlify/lib/db/ensure-booking-financial.js',
    'netlify/lib/db/operational-payment.js',
    // Stage 1 — authoritative add-on financial mutations
    'netlify/lib/addon-financial-mutation.js',
    // Stage 2 — canonical add-on catalog serializer for My Garage
    'netlify/lib/canonical-addon-catalog.js',
    // Package Stage 1 — authoritative pre-settlement package mutations
    'netlify/lib/package-financial-mutation.js',
    // Package Stage 2 — customer package catalog serializer
    'netlify/lib/canonical-package-catalog.js',
    // Customer Identity Foundation Stage 1 — account resolution + safe projections
    'netlify/lib/customer-account-service.js',
    'netlify/lib/customer-identity-projection.js',
    // Stage 2A — authenticated profile + address management
    'netlify/lib/customer-profile-service.js',
    'netlify/lib/customer-address-service.js',
    'netlify/functions/customer-portal-profile.js',
    'netlify/lib/public-rate-limit.js',
  ]);
  for (const file of changed) {
    assert.ok(allowed.has(file), `unexpected backend diff: ${file}`);
  }
});

test('package IDs in index PRICING unchanged for specialty categories', () => {
  const html = read('index.html');
  assert.match(html, /boats:[\s\S]*?id:'maint'/);
  assert.match(html, /rvs:[\s\S]*?id:'maint_light'/);
  assert.match(html, /powersports:[\s\S]*?id:'wash'/);
});

test('LENGTH_PRICING formulas (boat maint min 199, rv maint_light min 229)', () => {
  const html = read('index.html');
  assert.match(html, /boats:[\s\S]*?maint:\s*\{perFt:\s*12,\s*min:\s*199\}/);
  assert.match(html, /rvs:[\s\S]*?maint_light:\s*\{ base: 250, ratePerFoot: 16 \}/);
  assert.match(html, /rvs:[\s\S]*?maint:\s*\{ base: 150, ratePerFoot: 10 \}/);
  assert.match(html, /rvs:[\s\S]*?full:\s*\{ base: 400, ratePerFoot: 36 \}/);
});

test('no secrets in public HTML/JS specialty surface', () => {
  const patterns = [
    /sk_live_[A-Za-z0-9]+/,
    /STRIPE_SECRET_KEY\s*=\s*['"][^'"]+['"]/,
    /ADMIN_DASH_PASSWORD\s*=\s*['"][^'"]+['"]/,
    /ADMIN_SESSION_SECRET\s*=\s*['"][^'"]+['"]/,
    /whsec_[A-Za-z0-9]+/,
  ];
  const files = [...SPECIALTY_PAGES, 'assets/specialty-booking-bridge.js', 'index.html'];
  for (const f of files) {
    const content = read(f);
    for (const re of patterns) {
      assert.doesNotMatch(content, re, `${f} may expose secret`);
    }
  }
});

test('cars public carousel uses interior minimum not maint in getCategoryFromBases', () => {
  const html = read('index.html');
  assert.match(html, /getCategoryFromBases\(\)[\s\S]*?cars:Math\.min\([\s\S]*?\.interior\)/);
  assert.doesNotMatch(html, /getCategoryFromBases\(\)[\s\S]*?cars:Math\.min\([\s\S]*?\.maint\)/);
});

test('updateBkFromPrices does not overwrite cars category note with maint price', () => {
  const html = read('index.html');
  const fn = html.match(/function updateBkFromPrices\(\)\{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(fn, /cars:/);
  assert.match(html, /id="bkfrom-cars"[\s\S]*?Packages shown after ZIP check/);
});
