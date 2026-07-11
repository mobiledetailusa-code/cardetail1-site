const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const sharedConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'shared/universal-customer-strategy-config.json'), 'utf8')
);
const backend = require('../netlify/lib/universal-customer-strategy');
const { createUniversalStrategy } = require('../netlify/lib/universal-customer-strategy-logic');
const {
  validateLeadCreation,
  canEnterRecoveryQueue,
  canSyncCrm,
  canReceiveCommunication,
  isIdentifiedLead,
  anonymousProspectRecord,
} = require('../netlify/lib/anonymous-prospect');
const { recommendNextAction } = require('../netlify/lib/next-best-action');
const { SEGMENTS } = require('../netlify/lib/revenue-segments');

function loadFrontendStrategy() {
  const generated = fs.readFileSync(
    path.join(root, 'assets/universal-customer-strategy.generated.js'),
    'utf8'
  );
  const sandbox = { window: {}, globalThis: {} };
  sandbox.window = sandbox.globalThis = sandbox;
  vm.runInNewContext(generated, sandbox);
  return sandbox.Cardetail1UniversalStrategy;
}

function loadFrontendConfig() {
  const generated = fs.readFileSync(
    path.join(root, 'assets/universal-customer-strategy.generated.js'),
    'utf8'
  );
  const sandbox = { window: {}, globalThis: {} };
  sandbox.window = sandbox.globalThis = sandbox;
  vm.runInNewContext(generated, sandbox);
  return sandbox.Cardetail1StrategyConfig;
}

// ── 1. Segment rename ───────────────────────────────────────────────────────

test('MANUAL_REVIEW_OR_ALTERNATIVE_PATH replaces LOW_FIT_OR_OUT_OF_AREA', () => {
  assert.ok(sharedConfig.segmentIds.MANUAL_REVIEW_OR_ALTERNATIVE_PATH);
  assert.equal(sharedConfig.segmentIds.LOW_FIT_OR_OUT_OF_AREA, undefined);
  assert.ok(SEGMENTS.MANUAL_REVIEW_OR_ALTERNATIVE_PATH);
  assert.equal(SEGMENTS.LOW_FIT_OR_OUT_OF_AREA, undefined);
});

test('unsupported ZIP classifies as manual review alternative path', () => {
  const { classifySegment } = require('../netlify/lib/revenue-segments');
  const r = classifySegment({ unsupportedZip: true, vehicleCount: 1 });
  assert.equal(r.segment, SEGMENTS.MANUAL_REVIEW_OR_ALTERNATIVE_PATH);
  assert.deepEqual(r.reasons, ['operational_alternative_path']);
});

// ── 2. Routing property model ───────────────────────────────────────────────

test('routing controls exist for every segment', () => {
  Object.keys(sharedConfig.segmentIds).forEach((key) => {
    const routing = backend.getRoutingControls(key);
    assert.equal(typeof routing.catalogVisible, 'boolean', key);
    assert.equal(typeof routing.standardBookingAllowed, 'boolean', key);
    assert.equal(typeof routing.quoteRequired, 'boolean', key);
    assert.equal(typeof routing.manualReviewRequired, 'boolean', key);
    assert.equal(typeof routing.discardLead, 'boolean', key);
    assert.equal(routing.discardLead, false, key);
  });
});

test('single-vehicle routing allows standard booking', () => {
  const r = backend.getRoutingControls(SEGMENTS.SINGLE_VEHICLE_NEW);
  assert.equal(r.catalogVisible, true);
  assert.equal(r.standardBookingAllowed, true);
  assert.equal(r.quoteRequired, false);
  assert.equal(r.manualReviewRequired, false);
});

// ── 3. Fleet routing ────────────────────────────────────────────────────────

test('commercial fleet requires quote and blocks standard booking', () => {
  const r = backend.getRoutingControls(SEGMENTS.COMMERCIAL_FLEET);
  assert.equal(r.catalogVisible, true);
  assert.equal(r.standardBookingAllowed, false);
  assert.equal(r.quoteRequired, true);
  assert.equal(r.manualReviewRequired, false);
  const n = recommendNextAction({ segment: SEGMENTS.COMMERCIAL_FLEET, vehicleCount: 10 });
  assert.equal(n.action, 'route_fleet_quote');
  assert.equal(n.routing.standardBookingAllowed, false);
});

// ── 4. Manual-review routing ────────────────────────────────────────────────

test('manual review alternative path blocks standard booking', () => {
  const r = backend.getRoutingControls(SEGMENTS.MANUAL_REVIEW_OR_ALTERNATIVE_PATH);
  assert.equal(r.catalogVisible, true);
  assert.equal(r.standardBookingAllowed, false);
  assert.equal(r.quoteRequired, false);
  assert.equal(r.manualReviewRequired, true);
  const n = recommendNextAction({ segment: SEGMENTS.MANUAL_REVIEW_OR_ALTERNATIVE_PATH });
  assert.equal(n.action, 'route_manual_review');
  assert.equal(n.routing.standardBookingAllowed, false);
});

// ── 5. Frontend/backend parity ──────────────────────────────────────────────

test('frontend and backend config are identical', () => {
  const frontendConfig = loadFrontendConfig();
  assert.equal(JSON.stringify(frontendConfig), JSON.stringify(sharedConfig));
});

test('frontend and backend routing parity for all segments', () => {
  const frontend = loadFrontendStrategy();
  Object.keys(sharedConfig.segmentIds).forEach((seg) => {
    assert.equal(
      JSON.stringify(frontend.getRoutingControls(seg)),
      JSON.stringify(backend.getRoutingControls(seg)),
      `routing mismatch: ${seg}`
    );
    assert.equal(
      JSON.stringify(frontend.getConversionPath(seg)),
      JSON.stringify(backend.getConversionPath(seg)),
      `path mismatch: ${seg}`
    );
  });
});

test('frontend and backend followUpTier parity matrix', () => {
  const frontend = loadFrontendStrategy();
  const segments = Object.keys(sharedConfig.segmentIds);
  const intents = [0, 25, 45, 75];
  const households = [0, 20, 50];
  for (const seg of segments) {
    for (const intent of intents) {
      for (const hh of households) {
        assert.equal(
          frontend.followUpTier(intent, hh, seg),
          backend.followUpTier(intent, hh, seg),
          `followUpTier mismatch: ${seg} intent=${intent} hh=${hh}`
        );
      }
    }
  }
});

test('frontend and backend offer eligibility parity', () => {
  const frontend = loadFrontendStrategy();
  Object.keys(sharedConfig.segmentIds).forEach((seg) => {
    assert.equal(
      JSON.stringify(frontend.getOfferEligibility(seg, { offersEnabled: true })),
      JSON.stringify(backend.getOfferEligibility(seg, { offersEnabled: true })),
      `offer mismatch: ${seg}`
    );
  });
});

test('generated bundle is in sync with shared config version', () => {
  const frontend = loadFrontendStrategy();
  assert.equal(frontend.CONFIG_VERSION, sharedConfig.version);
  assert.equal(backend.CONFIG_VERSION, sharedConfig.version);
});

// ── 6. Anonymous vs identified ──────────────────────────────────────────────

test('anonymous prospect is not an identified lead', () => {
  assert.equal(isIdentifiedLead({ anonymous_session_id: 'sess_1', intentScore: 80 }), false);
  assert.equal(isIdentifiedLead({ leadId: 'lead_abc' }), true);
});

test('anonymous prospect cannot create lead without contact', () => {
  const v = validateLeadCreation({ anonymous_session_id: 'sess_1', intentScore: 50 });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'anonymous_not_identified');
});

test('identified contact can validate for lead creation', () => {
  const v = validateLeadCreation({
    name: 'Test User',
    phone: '5513132956',
    email: 'test@example.com',
    transactionalConsent: true,
  });
  assert.equal(v.ok, true);
});

test('anonymous prospect is not placed in recovery queue', () => {
  const r = canEnterRecoveryQueue({ contactCaptured: true, transactionalConsent: true, intentScore: 90 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'anonymous_abandonment');
});

test('identified lead with consent can enter recovery queue', () => {
  const r = canEnterRecoveryQueue({
    leadId: 'lead_1',
    name: 'Test',
    phone: '5513132956',
    transactionalConsent: true,
    contactCaptured: true,
  });
  assert.equal(r.ok, true);
});

test('anonymous prospect cannot receive communications', () => {
  const r = canReceiveCommunication({ intentScore: 99, segment: 'SINGLE_VEHICLE_NEW' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'anonymous_no_communications');
});

test('anonymous prospect is not synced to CRM', () => {
  const r = canSyncCrm({ intentScore: 80, segmentHypothesis: 'SINGLE_VEHICLE_NEW' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'anonymous_not_synced');
});

test('identified lead can sync to CRM when contact present', () => {
  const r = canSyncCrm({
    leadId: 'lead_1',
    _private: { email: 'a@b.com', phone: '5513132956', name: 'A B' },
  });
  assert.equal(r.ok, true);
});

test('anonymous prospect record has no lead_id', () => {
  const rec = anonymousProspectRecord('sess_xyz', { segment: 'SINGLE_VEHICLE_NEW', intentScore: 75 });
  assert.equal(rec.leadId, null);
  assert.equal(rec.identified, false);
  assert.equal(rec.type, 'anonymous_prospect');
  assert.equal(rec.anonymous_session_id, 'sess_xyz');
});

test('createLead rejects anonymous input', async () => {
  const { createLead } = require('../netlify/lib/revenue-household');
  await assert.rejects(
    () => createLead({ intentScore: 50 }),
    (err) => err.code === 'anonymous_not_identified'
  );
});

test('high-intent anonymous session does not infer identity', () => {
  const rec = anonymousProspectRecord('sess_hot', { intentScore: 95, leadTemperature: 'hot' });
  assert.equal(rec.leadId, null);
  assert.equal(isIdentifiedLead(rec), false);
});

test('logic factory matches backend exports for segment identifiers', () => {
  const fromFactory = createUniversalStrategy(sharedConfig);
  assert.deepEqual(fromFactory.SEGMENTS, backend.SEGMENTS);
});
