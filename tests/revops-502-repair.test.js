'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  buildRevopsDashboard,
  buildPriorityQueue,
  sanitizeOpportunityForAdmin,
  parseDateRange,
} = require('../netlify/lib/revops-dashboard');

const revenueStore = require('../netlify/lib/revenue-store');
const handler = require('../netlify/functions/revenue-admin.js').handler;

test('blobListKeys uses paginated or legacy list API, not invalid for-await on Promise', () => {
  const src = read('netlify/lib/revenue-store.js');
  assert.match(src, /paginate:\s*true/);
  assert.match(src, /listing\.blobs/);
  assert.doesNotMatch(src, /for await \(const entry of store\.list\(\{ prefix, limit \}\)\)/);
});

test('empty RevOps dashboard returns 200-shaped payload', async () => {
  const origList = revenueStore.blobListKeys;
  revenueStore.blobListKeys = async () => [];
  try {
    const dash = await buildRevopsDashboard({});
    assert.equal(dash.ok, true);
    assert.equal(dash.summary.bookingStarts, 0);
    assert.ok(Array.isArray(dash.priorityQueue));
    assert.ok(Array.isArray(dash.funnel));
    assert.ok(Array.isArray(dash.garagePlanOpportunities));
  } finally {
    revenueStore.blobListKeys = origList;
  }
});

test('malformed opportunity records are skipped without crashing aggregation', async () => {
  const src = read('netlify/lib/revops-dashboard.js');
  assert.match(src, /skipped_malformed_opportunities/);
  const origList = revenueStore.blobListKeys;
  const origGet = revenueStore.blobGetJson;
  const origStore = revenueStore.getRevenueStore;
  revenueStore.getRevenueStore = async () => ({ list: async () => ({ blobs: [] }) });
  revenueStore.blobListKeys = async () => ['opp_good', 'opp_bad'];
  revenueStore.blobGetJson = async (_store, key) => {
    if (key === 'opp_good') {
      return {
        opportunityId: 'opp_good',
        segment: 'MULTI_VEHICLE_HOUSEHOLD',
        intentScore: 55,
        commercialPriority: 'priority',
        stage: 'Qualified Lead',
        isGaragePlan: true,
        garagePlanStatus: 'new',
        estimatedValue: 400,
        vehicleCountBand: '2',
        assetCategories: ['cars'],
        source: 'garage_plan',
      };
    }
    return null;
  };
  try {
    const dash = await buildRevopsDashboard({});
    assert.equal(dash.ok, true);
    assert.ok(dash.garagePlanOpportunities.length >= 1);
    assert.ok((dash.warnings || []).some((w) => String(w).startsWith('skipped_malformed_opportunities:')));
  } finally {
    revenueStore.blobListKeys = origList;
    revenueStore.blobGetJson = origGet;
    revenueStore.getRevenueStore = origStore;
  }
});

test('priority queue includes garage plan and payment-step abandonment signals', () => {
  const items = buildPriorityQueue([
    sanitizeOpportunityForAdmin({
      opportunityId: 'opp_a',
      segment: 'MULTI_VEHICLE_HOUSEHOLD',
      isGaragePlan: true,
      garagePlanStatus: 'new',
      intentScore: 30,
      commercialPriority: 'standard',
      stage: 'Qualified Lead',
      vehicleCountBand: '2',
      estimatedValue: 300,
      source: 'garage_plan',
    }),
    sanitizeOpportunityForAdmin({
      opportunityId: 'opp_b',
      segment: 'STANDARD',
      intentScore: 20,
      commercialPriority: 'standard',
      stage: 'Booking Started',
      lastBookingStep: 4,
      vehicleCountBand: '1',
      estimatedValue: 200,
    }),
    sanitizeOpportunityForAdmin({
      opportunityId: 'opp_c',
      segment: 'STANDARD',
      intentScore: 5,
      commercialPriority: 'standard',
      stage: 'Lost',
      vehicleCountBand: '1',
    }),
  ].filter(Boolean));

  assert.ok(items.some((i) => i.attentionReason === 'garage_plan_request'));
  assert.ok(items.some((i) => i.attentionReason === 'payment_step_abandonment'));
  assert.equal(items.find((i) => i.opportunityId === 'opp_c'), undefined);
});

test('date range validation caps excessive spans', () => {
  const range = parseDateRange({
    from: '2020-01-01',
    to: '2026-07-12',
  });
  const days = (new Date(range.to) - new Date(range.from)) / 86400000;
  assert.ok(days <= 90.1);
});

test('revenue-admin unauthenticated GET returns 401 not 502', async () => {
  const res = await handler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { view: 'dashboard' },
  });
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'unauthorized');
});

test('revenue-admin handler returns controlled error contract on failure', () => {
  const src = read('netlify/functions/revenue-admin.js');
  assert.match(src, /revops_temporarily_unavailable/);
  assert.match(src, /retryable:\s*true/);
  assert.match(src, /newRequestId/);
});

test('revenue-admin sets Cache-Control no-store', async () => {
  const res = await handler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { view: 'summary' },
  });
  assert.match(res.headers['Cache-Control'] || '', /no-store/);
});

test('admin UI uses single dashboard loader with loading and error states', () => {
  const ui = read('admin-ops.html');
  assert.match(ui, /view=dashboard/);
  assert.match(ui, /revopsLoading/);
  assert.match(ui, /revopsError/);
  assert.match(ui, /revopsInflight/);
  assert.match(ui, /revopsGarage/);
  assert.match(ui, /tab\.dataset\.tab === 'revops'/);
  assert.match(ui, /visibilitychange/);
  assert.doesNotMatch(ui, /RevOps load failed: '\+e\.message\); toast/);
});

test('garage plan submit marks opportunities as garage plan', () => {
  const src = read('netlify/functions/garage-plan-submit.js');
  assert.match(src, /isGaragePlan:\s*true/);
  assert.match(src, /garagePlanStatus:\s*'new'/);
});

test('revenue-admin module imports successfully', () => {
  assert.ok(fs.existsSync(path.join(root, 'netlify/functions/revenue-admin.js')));
  assert.ok(fs.existsSync(path.join(root, 'netlify/lib/revops-dashboard.js')));
});

test('response contract includes funnel and warnings arrays', async () => {
  const origList = revenueStore.blobListKeys;
  revenueStore.blobListKeys = async () => [];
  try {
    const dash = await buildRevopsDashboard({});
    assert.ok(Array.isArray(dash.funnel));
    assert.ok(Array.isArray(dash.warnings));
    assert.ok(dash.generatedAt);
    assert.ok(dash.range);
  } finally {
    revenueStore.blobListKeys = origList;
  }
});
