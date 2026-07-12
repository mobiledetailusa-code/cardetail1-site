// Branch-only RevOps QA seed/cleanup — operations-core-job-lifecycle deploy only.
const { verifyAdminKey, jsonCors } = require('../lib/tech-security');
const { getRevenueStore, blobSetJson, blobListKeys, generateOpaqueId } = require('../lib/revenue-store');
const { createLead, createHousehold, createOpportunity } = require('../lib/revenue-household');

const QA_PREFIX = 'QA-REVOPS';
const OPS_BRANCH = 'operations-core-job-lifecycle';

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

async function cleanupQa() {
  const stores = ['events', 'opportunities', 'leads', 'households'];
  let removed = 0;
  for (const name of stores) {
    const store = await getRevenueStore(name);
    const keys = await blobListKeys(store, { prefix: QA_PREFIX, limit: 500 }).catch(() => []);
    for (const key of keys) {
      await store.delete(key).catch(() => null);
      removed++;
    }
    const allKeys = await blobListKeys(store, { limit: 500 }).catch(() => []);
    for (const key of allKeys) {
      if (!String(key).includes(QA_PREFIX)) continue;
      await store.delete(key).catch(() => null);
      removed++;
    }
  }
  return removed;
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

  if (action === 'seed') {
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    const eventStore = await getRevenueStore('events');

    const events = [
      { event: 'page_view', properties: { source: 'qa', page_type: 'homepage' } },
      { event: 'booking_started', properties: { category: 'cars' } },
      { event: 'contact_captured', properties: { category: 'cars' } },
      { event: 'payment_step_reached', properties: { category: 'cars' } },
      { event: 'garage_plan_completed', properties: { source: 'garage_plan' } },
    ];
    for (let i = 0; i < events.length; i++) {
      const id = `${QA_PREFIX}-evt-${i}`;
      await blobSetJson(eventStore, `${day}/${id}`, {
        ...events[i],
        receivedAt: now,
        qaFixture: true,
      });
    }

    const lead = await createLead({
      name: `${QA_PREFIX} Lead`,
      email: `${QA_PREFIX.toLowerCase()}@example.com`,
      phone: '2015550199',
      zip: '07030',
      vehicleCount: 2,
      assetCategories: ['cars'],
      source: 'garage_plan',
      marketingConsent: true,
      transactionalConsent: true,
      emailConsent: true,
    });
    lead.leadId = `${QA_PREFIX}-${lead.leadId}`;
    const leadStore = await getRevenueStore('leads');
    await blobSetJson(leadStore, lead.leadId, { ...lead, qaFixture: true });

    const household = await createHousehold({
      leadId: lead.leadId,
      vehicleCount: 2,
      assetCategories: ['cars'],
      zip: '07030',
      intentScore: 45,
      marketingConsent: true,
    });
    household.householdId = `${QA_PREFIX}-${household.householdId}`;

    const opp = await createOpportunity({
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
      lastBookingStep: 4,
      marketingConsent: true,
      transactionalConsent: true,
    });
    opp.opportunityId = `${QA_PREFIX}-${opp.opportunityId}`;
    const oppStore = await getRevenueStore('opportunities');
    await blobSetJson(oppStore, opp.opportunityId, { ...opp, qaFixture: true });

    return jsonCors(200, {
      ok: true,
      prefix: QA_PREFIX,
      leadId: lead.leadId,
      opportunityId: opp.opportunityId,
      eventsSeeded: events.length,
    });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};

exports.__test = { isQaBranchDeploy, QA_PREFIX };
