// Branch-only RevOps QA seed/cleanup — operations-core-job-lifecycle deploy only.
const { verifyAdminKey, jsonCors } = require('../lib/tech-security');
const { getRevenueStore, blobSetJson, blobListKeys, blobGetJson } = require('../lib/revenue-store');
const { createLead, createHousehold, createOpportunity } = require('../lib/revenue-household');

const QA_PREFIX = 'QA-REVOPS';
const OPS_BRANCH = 'operations-core-job-lifecycle';
const QA_TTL_MS = 24 * 60 * 60 * 1000;

function isQaBranchDeploy(event) {
  const host = String(
    event.headers?.['x-forwarded-host'] || event.headers?.Host || event.headers?.host || ''
  ).toLowerCase();
  if (host.startsWith(`${OPS_BRANCH}--`)) return true;
  const branch = String(process.env.BRANCH || process.env.COMMIT_REF || '').trim();
  return branch === OPS_BRANCH && String(process.env.CONTEXT || '').toLowerCase() !== 'production';
}

function qaDisabled() {
  return jsonCors(404, { ok: false, error: 'not_found' });
}

function qaExpiresAt() {
  return new Date(Date.now() + QA_TTL_MS).toISOString();
}

async function cleanupQa() {
  const stores = ['events', 'opportunities', 'leads', 'households'];
  let removed = 0;
  for (const name of stores) {
    const store = await getRevenueStore(name);
    const keys = await blobListKeys(store, { limit: 2000 }).catch(() => []);
    for (const key of keys) {
      if (!String(key).includes(QA_PREFIX)) continue;
      await store.delete(key).catch(() => null);
      removed++;
    }
  }
  return removed;
}

async function tagAndSaveOpportunity(store, baseInput, overrides = {}) {
  const created = await createOpportunity(baseInput);
  const opp = {
    ...created,
    ...overrides,
    opportunityId: created.opportunityId,
    qaFixture: true,
    qaTag: QA_PREFIX,
    qaExpiresAt: qaExpiresAt(),
  };
  await blobSetJson(store, created.opportunityId, opp);
  return opp;
}

async function seedQaFixtures() {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const eventStore = await getRevenueStore('events');
  const oppStore = await getRevenueStore('opportunities');
  const leadStore = await getRevenueStore('leads');
  const householdStore = await getRevenueStore('households');

  const events = [
    { event: 'page_view', properties: { source: 'qa_direct', page_type: 'homepage', anonymous: true } },
    { event: 'package_selected', properties: { source: 'qa_direct', category: 'cars', anonymous: true } },
    { event: 'booking_started', properties: { source: 'qa_referral', category: 'cars' } },
    { event: 'contact_captured', properties: { source: 'qa_referral', category: 'cars' } },
    { event: 'payment_step_reached', properties: { source: 'qa_referral', category: 'cars' } },
    { event: 'booking_submitted', properties: { source: 'qa_referral', category: 'cars' } },
    { event: 'garage_plan_started', properties: { source: 'garage_plan' } },
    { event: 'garage_plan_completed', properties: { source: 'garage_plan' } },
    { event: 'booking_confirmed', properties: { source: 'qa_referral', category: 'cars' } },
    { event: 'service_completed', properties: { source: 'qa_referral', category: 'cars' } },
  ];
  for (let i = 0; i < events.length; i++) {
    const id = `${QA_PREFIX}-evt-${i}`;
    await blobSetJson(eventStore, `${day}/${id}`, {
      ...events[i],
      receivedAt: now,
      qaFixture: true,
      qaTag: QA_PREFIX,
      qaExpiresAt: qaExpiresAt(),
    });
  }

  const lead = await createLead({
    name: `${QA_PREFIX} Lead`,
    email: `${QA_PREFIX.toLowerCase()}@example.invalid`,
    phone: '2015550199',
    zip: '07030',
    vehicleCount: 2,
    assetCategories: ['cars'],
    source: 'qa_referral',
    marketingConsent: true,
    transactionalConsent: true,
    emailConsent: true,
  });
  const taggedLead = {
    ...lead,
    leadId: lead.leadId,
    qaFixture: true,
    qaTag: QA_PREFIX,
    qaExpiresAt: qaExpiresAt(),
  };
  await blobSetJson(leadStore, lead.leadId, taggedLead);

  const household = await createHousehold({
    leadId: lead.leadId,
    vehicleCount: 2,
    assetCategories: ['cars'],
    zip: '07030',
    intentScore: 45,
    marketingConsent: true,
  });
  const taggedHousehold = {
    ...household,
    qaTag: QA_PREFIX,
    qaFixture: true,
    qaExpiresAt: qaExpiresAt(),
  };
  await blobSetJson(householdStore, household.householdId, taggedHousehold);

  const garagePlan = await tagAndSaveOpportunity(oppStore, {
    leadId: lead.leadId,
    householdId: household.householdId,
    vehicleCount: 2,
    assetCategories: ['cars'],
    estimatedValue: 450,
    intentScore: 55,
    source: 'garage_plan',
    stage: 'Multi-Vehicle Opportunity',
    isGaragePlan: true,
    garagePlanStatus: 'new',
    marketingConsent: true,
    transactionalConsent: true,
    nextAction: 'contact_customer',
    notificationStatus: 'sent',
  });

  const paymentAbandon = await tagAndSaveOpportunity(oppStore, {
    leadId: lead.leadId,
    householdId: household.householdId,
    vehicleCount: 1,
    assetCategories: ['cars'],
    estimatedValue: 220,
    intentScore: 42,
    source: 'qa_referral',
    stage: 'Booking Started',
    lastBookingStep: 4,
    marketingConsent: true,
    transactionalConsent: true,
  });

  const multiVehicle = await tagAndSaveOpportunity(oppStore, {
    leadId: lead.leadId,
    householdId: household.householdId,
    vehicleCount: 3,
    assetCategories: ['cars'],
    estimatedValue: 680,
    intentScore: 48,
    source: 'qa_referral',
    stage: 'Qualified Lead',
    segment: 'MULTI_VEHICLE_HOUSEHOLD',
    marketingConsent: true,
    transactionalConsent: true,
  });

  const failedNotification = await tagAndSaveOpportunity(oppStore, {
    leadId: lead.leadId,
    householdId: household.householdId,
    vehicleCount: 1,
    assetCategories: ['cars'],
    estimatedValue: 199,
    intentScore: 65,
    source: 'qa_referral',
    stage: 'Lead Captured',
    marketingConsent: true,
    transactionalConsent: true,
    notificationStatus: 'failed',
    nextAction: 'retry_customer_notification',
  });

  const convertedGarage = await tagAndSaveOpportunity(oppStore, {
    leadId: lead.leadId,
    householdId: household.householdId,
    vehicleCount: 2,
    assetCategories: ['cars'],
    estimatedValue: 500,
    intentScore: 35,
    source: 'garage_plan',
    stage: 'Booking Requested',
    isGaragePlan: true,
    garagePlanStatus: 'converted_to_booking',
    marketingConsent: true,
    transactionalConsent: true,
  });

  const completedBooking = await tagAndSaveOpportunity(oppStore, {
    leadId: lead.leadId,
    householdId: household.householdId,
    vehicleCount: 1,
    assetCategories: ['cars'],
    estimatedValue: 175,
    intentScore: 10,
    source: 'qa_referral',
    stage: 'Confirmed',
    marketingConsent: true,
    transactionalConsent: true,
  });

  return {
    prefix: QA_PREFIX,
    leadId: lead.leadId,
    householdId: household.householdId,
    eventsSeeded: events.length,
    opportunities: {
      garagePlan: garagePlan.opportunityId,
      paymentAbandon: paymentAbandon.opportunityId,
      multiVehicle: multiVehicle.opportunityId,
      failedNotification: failedNotification.opportunityId,
      convertedGarage: convertedGarage.opportunityId,
      completedBooking: completedBooking.opportunityId,
    },
  };
}

async function seedMalformedRecord() {
  const oppStore = await getRevenueStore('opportunities');
  const key = `opp_${QA_PREFIX.replace(/-/g, '_')}_malformed`;
  await oppStore.set(key, '{ invalid json', { metadata: { qaTag: QA_PREFIX } });
  return { key };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return qaDisabled();
  if (!isQaBranchDeploy(event)) return qaDisabled();

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(401, { ok: false, error: 'unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || '').toLowerCase();

  if (action === 'cleanup') {
    const removed = await cleanupQa();
    return jsonCors(200, { ok: true, removed });
  }

  if (action === 'seed_malformed') {
    const result = await seedMalformedRecord();
    return jsonCors(200, { ok: true, ...result });
  }

  if (action === 'seed') {
    const result = await seedQaFixtures();
    return jsonCors(200, { ok: true, ...result });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};

exports.__test = { isQaBranchDeploy, QA_PREFIX, seedQaFixtures, cleanupQa };
