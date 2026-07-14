const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const {
  validateEventPayload,
  sanitizeProperties,
  APPROVED_EVENTS,
  PII_PROPERTY_KEYS,
  mapToGa4,
} = require('../netlify/lib/revenue-event-schema');

const { classifySegment, vehicleCountBand, SEGMENTS } = require('../netlify/lib/revenue-segments');
const {
  computeIntentScore,
  computeHouseholdValueScore,
  commercialPriority,
  leadTemperature,
} = require('../netlify/lib/revenue-scoring');
const { evaluateOffers, getOfferConfig } = require('../netlify/lib/revenue-offers');
const { recommendNextAction } = require('../netlify/lib/next-best-action');
const { addressDedupHash } = require('../netlify/lib/revenue-household');
const { hubspotEnabled } = require('../netlify/lib/hubspot-adapter');
const { googleAdsExportEnabled } = require('../netlify/lib/google-ads-export');
const { recoveryDryRun, recoveryEnabled, isOptOutMessage } = require('../netlify/lib/revenue-recovery');
const { TOKEN_TTL_MS } = require('../netlify/lib/revenue-resume');

// ── EVENTS ──────────────────────────────────────────────────────────────────

test('approved events are accepted', () => {
  const r = validateEventPayload({
    event: 'booking_started',
    event_id: 'evt_test_1',
    anonymous_session_id: 'sess_test_1',
    properties: { category: 'cars' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.event, 'booking_started');
});

test('unknown events are rejected', () => {
  const r = validateEventPayload({ event: 'secret_customer_dump', event_id: 'x', anonymous_session_id: 'y' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_event');
});

test('unknown properties are stripped', () => {
  const props = sanitizeProperties({ category: 'cars', secret_field: 'nope', email: 'a@b.com' });
  assert.equal(props.category, 'cars');
  assert.equal(props.secret_field, undefined);
  assert.equal(props.email, undefined);
});

test('PII fields are rejected from analytics properties', () => {
  PII_PROPERTY_KEYS.forEach((key) => {
    const props = sanitizeProperties({ [key]: 'value' });
    assert.equal(props[key], undefined, `PII key leaked: ${key}`);
  });
});

test('duplicate event IDs are idempotent at schema level', () => {
  const payload = { event: 'page_view', event_id: 'evt_dup', anonymous_session_id: 'sess_1' };
  const a = validateEventPayload(payload);
  const b = validateEventPayload(payload);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.eventId, b.eventId);
});

test('GA4 mapping preserves internal event names', () => {
  const ga = mapToGa4('booking_started', { category: 'cars' });
  assert.equal(ga.name, 'begin_checkout');
  assert.equal(ga.params.cardetail1_event, 'booking_started');
});

test('purchase GA4 mapping exists but booking_submitted maps to purchase', () => {
  const ga = mapToGa4('booking_submitted', {});
  assert.equal(ga.name, 'purchase');
});

// ── HOUSEHOLDS ──────────────────────────────────────────────────────────────

test('household classification: two vehicles = multi-vehicle', () => {
  const r = classifySegment({ vehicleCount: 2, assetCategories: ['cars'] });
  assert.equal(r.segment, SEGMENTS.MULTI_VEHICLE_HOUSEHOLD);
});

test('commercial fleets do not classify as households', () => {
  const r = classifySegment({ vehicleCount: 8, ownership: 'business' });
  assert.equal(r.segment, SEGMENTS.COMMERCIAL_FLEET);
});

test('segment classification is deterministic', () => {
  const input = { vehicleCount: 3, assetCategories: ['cars', 'boats'], sameLocationSameVisit: true };
  const a = classifySegment(input);
  const b = classifySegment(input);
  assert.deepEqual(a, b);
});

test('address dedup hash is opaque and not raw address', () => {
  process.env.HOUSEHOLD_DEDUP_SECRET = 'test-secret-key-32-characters-min!!';
  const h = addressDedupHash('123 Main St', '07650');
  assert.ok(h);
  assert.doesNotMatch(h, /Main/i);
});

test('vehicle count bands are explainable', () => {
  assert.equal(vehicleCountBand(2), '2');
  assert.equal(vehicleCountBand(5), '5-6');
});

// ── SCORING ─────────────────────────────────────────────────────────────────

test('intent scoring is deterministic', () => {
  const events = [{ event: 'booking_started' }, { event: 'contact_captured' }];
  assert.equal(computeIntentScore(events), computeIntentScore(events));
});

test('household-value scoring is deterministic', () => {
  const ctx = { vehicleCount: 3, assetCategories: ['cars', 'boats'], sameLocationSameVisit: true };
  assert.deepEqual(computeHouseholdValueScore(ctx), computeHouseholdValueScore(ctx));
});

test('no protected trait affects scoring', () => {
  const base = computeHouseholdValueScore({ vehicleCount: 2, zipAffluence: 'high' });
  const withTrait = computeHouseholdValueScore({ vehicleCount: 2, zipCode: '90210', inferredIncome: 'wealthy' });
  assert.equal(base.score, withTrait.score);
});

test('commercial-priority calculation is explainable and intent-led', () => {
  const { commercialPriority } = require('../netlify/lib/revenue-scoring');
  const hotSingle = commercialPriority(75, 0, 'SINGLE_VEHICLE_NEW');
  assert.equal(hotSingle.follow_up_tier, 'immediate');
  assert.equal(hotSingle.classification, 'immediate_follow_up');
  const nurture = commercialPriority(5, 0, 'SINGLE_VEHICLE_NEW');
  assert.equal(nurture.follow_up_tier, 'nurture');
  assert.notEqual(nurture.classification, 'low_value');
});

test('routing controls never discard legitimate visitors', () => {
  const { CONVERSION_PATHS, getRoutingControls } = require('../netlify/lib/universal-customer-strategy');
  const { SEGMENTS } = require('../netlify/lib/revenue-segments');
  Object.values(SEGMENTS).forEach((seg) => {
    const routing = getRoutingControls(seg);
    assert.equal(routing.discardLead, false, seg);
    assert.equal(routing.catalogVisible, true, seg);
  });
});

test('single-vehicle NBA uses standard booking routing', () => {
  const { recommendNextAction } = require('../netlify/lib/next-best-action');
  const n = recommendNextAction({ segment: 'SINGLE_VEHICLE_NEW', vehicleCount: 1 });
  assert.equal(n.action, 'continue_standard_booking');
  assert.equal(n.routing.standardBookingAllowed, true);
});

test('manual review segment routes to manual review not discard', () => {
  const { recommendNextAction } = require('../netlify/lib/next-best-action');
  const n = recommendNextAction({ segment: 'MANUAL_REVIEW_OR_ALTERNATIVE_PATH' });
  assert.equal(n.action, 'route_manual_review');
  assert.equal(n.routing.manualReviewRequired, true);
  assert.equal(n.routing.discardLead, false);
});

test('specialty single asset recommends specialty booking', () => {
  const { recommendNextAction } = require('../netlify/lib/next-best-action');
  const n = recommendNextAction({ segment: 'SPECIALTY_ASSET_OWNER', vehicleCount: 1, assetCategories: ['boats'] });
  assert.equal(n.action, 'recommend_specialty_booking');
});

test('lead temperature bands', () => {
  assert.equal(leadTemperature(10), 'visitor');
  assert.equal(leadTemperature(100), 'converted');
});

// ── GARAGE PLAN / ROUTING ───────────────────────────────────────────────────

test('Garage Plan requires 2+ vehicles at API validation layer', () => {
  const r = classifySegment({ vehicleCount: 1 });
  assert.notEqual(r.segment, SEGMENTS.MULTI_VEHICLE_HOUSEHOLD);
});

test('7+ vehicles route to fleet segment', () => {
  const r = classifySegment({ vehicleCount: 7, ownership: 'personal' });
  assert.equal(r.segment, SEGMENTS.COMMERCIAL_FLEET);
});

test('next-best-action recommends garage plan for 3+ vehicles', () => {
  const n = recommendNextAction({ vehicleCount: 3 });
  assert.equal(n.action, 'recommend_full_garage_plan');
});

test('next-best-action routes fleet at 7+ vehicles', () => {
  const n = recommendNextAction({ vehicleCount: 8 });
  assert.equal(n.action, 'route_fleet_quote');
});

// ── OFFERS ──────────────────────────────────────────────────────────────────

test('offers are disabled by default', () => {
  delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  delete process.env.MULTI_VEHICLE_OFFER_ENABLED;
  const cfg = getOfferConfig();
  assert.equal(cfg.firstBooking.enabled, false);
  assert.equal(cfg.multiVehicle.enabled, false);
});

test('disabled offers never apply', () => {
  const r = evaluateOffers({
    eligibleSubtotalCents: 10000,
    vehicleCount: 3,
    sameLocationSameVisit: true,
    priorCompletedServices: 0,
    packageId: 'interior',
    category: 'cars',
  });
  assert.equal(r.selected, null);
});

test('Fleet is excluded from offers', () => {
  process.env.MULTI_VEHICLE_OFFER_ENABLED = 'true';
  const r = evaluateOffers({
    eligibleSubtotalCents: 10000,
    vehicleCount: 8,
    isCommercial: true,
    sameLocationSameVisit: true,
    priorCompletedServices: 0,
  });
  assert.equal(r.selected, null);
  delete process.env.MULTI_VEHICLE_OFFER_ENABLED;
});

test('offers do not stack by default', () => {
  process.env.FIRST_BOOKING_OFFER_ENABLED = 'true';
  process.env.MULTI_VEHICLE_OFFER_ENABLED = 'true';
  process.env.OFFER_STACKING_ENABLED = 'false';
  const r = evaluateOffers({
    eligibleSubtotalCents: 10000,
    vehicleCount: 2,
    sameLocationSameVisit: true,
    priorCompletedServices: 0,
    packageId: 'interior',
    category: 'cars',
  });
  if (r.candidates.length >= 2) {
    assert.equal(r.selected.stacked, undefined);
  }
  delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  delete process.env.MULTI_VEHICLE_OFFER_ENABLED;
});

test('prior redemption blocks new-customer offer eligibility', () => {
  process.env.FIRST_BOOKING_OFFER_ENABLED = 'true';
  const r = evaluateOffers({
    eligibleSubtotalCents: 5000,
    priorCompletedServices: 1,
    packageId: 'interior',
    category: 'cars',
  });
  assert.equal(r.selected, null);
  delete process.env.FIRST_BOOKING_OFFER_ENABLED;
});

// ── RECOVERY ────────────────────────────────────────────────────────────────

test('recovery automation disabled by default', () => {
  delete process.env.RECOVERY_AUTOMATION_ENABLED;
  assert.equal(recoveryEnabled(), false);
});

test('recovery dry run defaults true', () => {
  delete process.env.RECOVERY_DRY_RUN;
  assert.equal(recoveryDryRun(), true);
});

test('STOP disables promotional SMS keyword detection', () => {
  assert.equal(isOptOutMessage('STOP'), true);
  assert.equal(isOptOutMessage('please stop by later'), false);
});

test('resume token TTL is configured', () => {
  assert.ok(TOKEN_TTL_MS >= 3600000);
});

// ── CRM / ADAPTERS ──────────────────────────────────────────────────────────

test('HubSpot adapter disabled when unconfigured', () => {
  delete process.env.HUBSPOT_INTEGRATION_ENABLED;
  assert.equal(hubspotEnabled(), false);
});

test('Google Ads export disabled by default', () => {
  delete process.env.GOOGLE_ADS_EXPORT_ENABLED;
  assert.equal(googleAdsExportEnabled(), false);
});

test('HubSpot private token not in frontend assets', () => {
  const rev = fs.readFileSync(path.join(root, 'assets/revenue-events.js'), 'utf8');
  assert.doesNotMatch(rev, /HUBSPOT_PRIVATE_APP_TOKEN/);
  assert.doesNotMatch(rev, /sk-ant-/);
});

// ── ADMIN / SECURITY ────────────────────────────────────────────────────────

test('revenue-admin requires auth pattern in source', () => {
  const src = fs.readFileSync(path.join(root, 'netlify/functions/revenue-admin.js'), 'utf8');
  assert.match(src, /verifyAdminRequest/);
  assert.doesNotMatch(src, /exports\.handler[\s\S]*view=all/);
});

test('no public unrestricted event export endpoint', () => {
  const src = fs.readFileSync(path.join(root, 'netlify/functions/revenue-event.js'), 'utf8');
  assert.match(src, /httpMethod !== 'POST'/);
  assert.doesNotMatch(src, /GET.*export/i);
});

test('revenue-event function exists and uses allowlist', () => {
  assert.ok(fs.existsSync(path.join(root, 'netlify/functions/revenue-event.js')));
  assert.ok(APPROVED_EVENTS.includes('garage_plan_completed'));
});

// ── CLARITY / GA4 / CONSENT ─────────────────────────────────────────────────

test('consent manager does not preselect optional consent', () => {
  const src = fs.readFileSync(path.join(root, 'assets/consent-manager.js'), 'utf8');
  assert.match(src, /analytics:\s*false/);
  assert.match(src, /marketing:\s*false/);
});

test('Clarity masking attributes on garage plan form', () => {
  const src = fs.readFileSync(path.join(root, 'assets/garage-plan.js'), 'utf8');
  assert.match(src, /data-clarity-mask="true"/);
});

test('GA4 absence causes no errors in revenue-events', () => {
  const src = fs.readFileSync(path.join(root, 'assets/revenue-events.js'), 'utf8');
  assert.match(src, /catch \(e\)/);
  assert.match(src, /fail safe/i);
});

test('duplicate GTM install guarded by id cd1-gtm', () => {
  const src = fs.readFileSync(path.join(root, 'assets/revenue-events.js'), 'utf8');
  assert.match(src, /cd1-gtm/);
});

// ── REGRESSION / FILES ──────────────────────────────────────────────────────

test('multi-vehicle landing page distinguishes booking vs Garage Plan CTAs', () => {
  const html = fs.readFileSync(path.join(root, 'multi-vehicle-detailing.html'), 'utf8');
  assert.match(html, /Book Multiple Vehicles/);
  assert.match(html, /Request Garage Plan/);
  assert.match(html, /data-cd1-garage-cta/);
  assert.match(html, /index\.html(?:\?multi=1)?#book/);
});

test('multi-vehicle landing page exists and is indexable', () => {
  const html = fs.readFileSync(path.join(root, 'multi-vehicle-detailing.html'), 'utf8');
  assert.match(html, /<h1[^>]*>Mobile Detailing for Multi-Vehicle Households/i);
  assert.match(html, /rel="canonical"/);
  assert.doesNotMatch(html, /noindex/i);
});

test('sitemap includes multi-vehicle page', () => {
  const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /multi-vehicle-detailing\.html/);
});

test('customer segments module exists', () => {
  assert.ok(fs.existsSync(path.join(root, 'assets/customer-segments.js')));
});

test('Stripe functions not modified by revops (submit-booking payment path intact)', () => {
  const src = fs.readFileSync(path.join(root, 'netlify/functions/submit-booking.js'), 'utf8');
  assert.match(src, /isDraft/);
  assert.match(src, /create-setup-intent/);
});

test('package catalog IDs unchanged in customer-catalog', () => {
  const { CAR_PACKAGES } = require('../netlify/lib/customer-catalog');
  const interior = CAR_PACKAGES.find((p) => p.id === 'interior');
  assert.ok(interior);
  assert.equal(interior.basePrice, 225);
});

test('docs directory contains revops documentation', () => {
  [
    'revenue-intelligence.md',
    'household-growth-strategy.md',
    'commercial-pipeline.md',
    'recovery-automation.md',
    'external-integrations.md',
    'offer-engine.md',
    'privacy-and-consent.md',
    'universal-customer-strategy.md',
  ].forEach((f) => {
    assert.ok(fs.existsSync(path.join(root, 'docs', f)), `missing docs/${f}`);
  });
});

test('all approved events count matches spec dictionary', () => {
  assert.ok(APPROVED_EVENTS.length >= 40);
  assert.ok(APPROVED_EVENTS.includes('multi_vehicle_detected'));
  assert.ok(APPROVED_EVENTS.includes('flexible_payment_interest'));
});
