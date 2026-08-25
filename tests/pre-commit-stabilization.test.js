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

test('sitemap reported count equals actual URL entries (19)', () => {
  const urls = sitemapUrls();
  assert.equal(urls.length, 19);
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
    'netlify/functions/ai-chat.js',
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
    'netlify/lib/tech-list-modes.js',
    'netlify/functions/tech-accounts.js',
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
    // PostgreSQL payment authority and minimized Stripe webhook inbox.
    'netlify/functions/db-health.js',
    'netlify/functions/customer-balance-payment-intent.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/stripe-webhook.js',
    'netlify/lib/db/repositories.js',
    'netlify/lib/db/foundation-services.js',
    'netlify/lib/db/financial-projection.js',
    'netlify/lib/db/payment-authority-service.js',
    'netlify/lib/db/stripe-event-data.js',
    'netlify/lib/db/webhook-inbox.js',
    'netlify/lib/db/ensure-booking-financial.js',
    'netlify/lib/db/operational-payment.js',
    // Stage 1 — authoritative add-on financial mutations
    'netlify/lib/addon-financial-mutation.js',
    // Stage 2 — canonical add-on catalog serializer for My Garage
    'netlify/lib/canonical-addon-catalog.js',
    // Package Stage 1 — authoritative pre-settlement package mutations
    'netlify/lib/package-financial-mutation.js',
    // Customer/Admin PR4 — stable retries and authoritative vehicle operations.
    'netlify/lib/operation-idempotency.js',
    'netlify/lib/vehicle-financial-mutation.js',
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
    // Post-release hardening — disabled-by-default identity smoke harness
    'netlify/functions/qa-customer-identity-smoke.js',
    // Appointment direct access + transactional notifications
    'netlify/functions/customer-appointment-access.js',
    'netlify/functions/update-booking.js',
    'netlify/functions/qa-appointment-access-mint.js',
    'netlify/functions/qa-blobs-health.js',
    // Owner Studio Stage 2 Phase A — browser-scoped admin session (HttpOnly cookie)
    // so a second/new tab authenticates without the per-tab sessionStorage token.
    'netlify/functions/admin-auth.js',
    'netlify/lib/admin-session-client.js',
    // Owner Studio Stage 1 — protected read-only status endpoint (flags off by default)
    'netlify/functions/owner-studio-status.js',
    'netlify/functions/owner-studio-catalog.js',
    'netlify/functions/owner-studio-release.js',
    // Owner Studio Stage 4B storefront preview (authenticated, presentation-only).
    'netlify/functions/owner-studio-catalog-preview.js',
    'netlify/lib/owner-studio/storefront-preview.js',
    'netlify/lib/owner-studio/storefront-preview-adapter.js',
    // Catalog Manager UX hardening — shared browser+node logic module.
    'netlify/lib/owner-studio-catalog-ux-logic.js',
    'netlify/lib/owner-studio/audit.js',
    'netlify/lib/owner-studio/authorization.js',
    'netlify/lib/owner-studio/booking-snapshot.js',
    'netlify/lib/owner-studio/catalog-read.js',
    'netlify/lib/owner-studio/catalog-repository.js',
    'netlify/lib/owner-studio/catalog-schema-health.js',
    'netlify/lib/owner-studio/content-read.js',
    'netlify/lib/owner-studio/draft-service.js',
    'netlify/lib/owner-studio/flags.js',
    'netlify/lib/owner-studio/ids.js',
    'netlify/lib/owner-studio/importer.js',
    'netlify/lib/owner-studio/index.js',
    'netlify/lib/owner-studio/money.js',
    'netlify/lib/owner-studio/preview-transaction-guard.js',
    'netlify/lib/owner-studio/release-repository.js',
    'netlify/lib/owner-studio/release-service.js',
    'netlify/lib/owner-studio/schemas.js',
    'netlify/lib/owner-studio/snapshot.js',
    'netlify/lib/owner-studio/store.js',
    'netlify/lib/appointment-access-token.js',
    'netlify/lib/appointment-booking-linkage.js',
    'netlify/lib/booking-transactional-notifications.js',
    'netlify/lib/booking-customer-status.js',
    'netlify/lib/booking-confirm.js',
    'netlify/lib/trusted-site-origin.js',
    'netlify/lib/deploy-runtime-env.generated.js',
    'netlify/lib/ops-schema.js',
    'tests/helpers/cas-memory-store.js',
    // Booking conversion production readiness — operational availability + flexibility
    'netlify/functions/booking-availability.js',
    'netlify/functions/ops-settings.js',
    'netlify/functions/customer-receipt.js',
    'netlify/functions/submit-review.js',
    'netlify/functions/public-reviews.js',
    'netlify/functions/admin-reviews.js',
    'netlify/lib/first-party-reviews.js',
    'netlify/lib/operational-availability.js',
    'netlify/lib/schedule-flexibility.js',
    'netlify/lib/arrival-windows.js',
    'netlify/lib/ops-config.js',
    'netlify/lib/site-access.js',
    'netlify/lib/site-access-client.js',
    'netlify/lib/sync-response.js',
    // Existing PR #157 Admin/payment/post-service implementation.
    'netlify/lib/admin-change-request-projection.js',
    'netlify/lib/data/service-area-zip-coords.js',
    'netlify/lib/package-details-resolve.js',
    'netlify/lib/payment-method-policy.js',
    'netlify/lib/post-service-experience.js',
    'netlify/lib/price-adjustments.js',
    'netlify/lib/receipt-projection.js',
    'netlify/lib/service-issue-notifications.js',
    // PR5 Twilio readiness — post-commit outbox and signed webhooks.
    'netlify/functions/customer-portal-profile.js',
    'netlify/functions/stripe-webhook.js',
    'netlify/functions/submit-booking.js',
    'netlify/functions/submit-inquiry.js',
    'netlify/functions/twilio-inbound.js',
    'netlify/functions/twilio-outbox-worker.js',
    'netlify/functions/twilio-status-callback.js',
    'netlify/lib/auction-ops.js',
    'netlify/lib/booking-transactional-notifications.js',
    'netlify/lib/customer-session.js',
    'netlify/lib/notification-delivery.js',
    'netlify/lib/recovery-communications.js',
    'netlify/lib/sms-consent-service.js',
    'netlify/lib/sms-outbox.js',
    'netlify/lib/sms-program.js',
    'netlify/lib/sms-templates.js',
    'netlify/lib/twilio-provider.js',
    'netlify/lib/twilio-runtime-policy.js',
    'netlify/lib/twilio-webhook.js',
    // Booking-store scan removal: indexed lookups on the request paths that
    // outgrew a full cd1-bookings hydration (offer history, slot occupancy,
    // customer portal, booking resolution by id).
    'netlify/functions/customer-portal-auth.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/functions/customer-subscription-checkout.js',
    'netlify/lib/booking-history.js',
    'netlify/lib/booking-offers.js',
    'netlify/lib/booking-prisma-mirror.js',
    'netlify/lib/booking-repository.js',
    'netlify/lib/ops-db.js',
    'netlify/lib/slot-index.js',
    'netlify/lib/tech-security.js',
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

test('LENGTH_PRICING formulas (boat maint min 170, rv maint_light min 383)', () => {
  const html = read('index.html');
  assert.match(html, /boats:[\s\S]*?maint:\s*\{perFt:\s*10,\s*min:\s*170\}/);
  assert.match(html, /rvs:[\s\S]*?maint_light:\s*\{ base: 215, ratePerFoot: 14 \}/);
  assert.match(html, /rvs:[\s\S]*?maint:\s*\{ base: 130, ratePerFoot: 9 \}/);
  assert.match(html, /rvs:[\s\S]*?full:\s*\{ base: 340, ratePerFoot: 31 \}/);
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
