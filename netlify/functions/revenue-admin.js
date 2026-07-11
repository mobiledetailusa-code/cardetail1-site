// Protected Revenue Operations admin API — requires admin session.

const { verifyAdminRequest } = require('../lib/admin-security');
const { jsonCors } = require('../lib/tech-security');
const { getRevenueStore, blobListKeys, blobGetJson, blobSetJson, generateOpaqueId } = require('../lib/revenue-store');
const { PIPELINE_STAGES, LOST_REASONS } = require('../lib/revenue-household');
const { createResumeToken } = require('../lib/revenue-resume');
const { enqueueRecoveryJob, cancelRecoveryForLead } = require('../lib/revenue-recovery');
const { hubspotEnabled, upsertContact } = require('../lib/hubspot-adapter');

async function auditAdminAction(adminUser, action, meta) {
  try {
    const store = await getRevenueStore('adminAudit');
    const id = generateOpaqueId('aud');
    await blobSetJson(store, id, {
      id,
      adminUser: adminUser || 'admin',
      action,
      meta: meta || {},
      at: new Date().toISOString(),
    });
  } catch { /* non-blocking */ }
}

async function listRecentEvents({ limit = 100, datePrefix } = {}) {
  const store = await getRevenueStore('events');
  const prefix = datePrefix || new Date().toISOString().slice(0, 10);
  const keys = (await blobListKeys(store, { prefix, limit: Math.min(limit, 500) })).slice(0, limit);
  const events = [];
  for (const key of keys) {
    const rec = await blobGetJson(store, key);
    if (rec) events.push({ key, ...rec });
  }
  return events;
}

async function listOpportunities({ limit = 100, segment, priority } = {}) {
  const store = await getRevenueStore('opportunities');
  const keys = (await blobListKeys(store, { limit: Math.min(limit * 2, 500) })).filter(k => k.startsWith('opp_'));
  const out = [];
  for (const key of keys) {
    const opp = await blobGetJson(store, key);
    if (!opp) continue;
    if (segment && opp.segment !== segment) continue;
    if (priority && opp.commercialPriority !== priority) continue;
    out.push(sanitizeOpportunityForAdmin(opp));
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => (b.intentScore || 0) - (a.intentScore || 0));
}

function sanitizeOpportunityForAdmin(opp) {
  return {
    opportunityId: opp.opportunityId,
    householdId: opp.householdId,
    leadId: opp.leadId,
    segment: opp.segment,
    vehicleCountBand: opp.vehicleCountBand,
    assetCategories: opp.assetCategories,
    selectedCategory: opp.selectedCategory,
    selectedPackage: opp.selectedPackage,
    estimatedValue: opp.estimatedValue,
    source: opp.source,
    campaign: opp.campaign,
    lastBookingStep: opp.lastBookingStep,
    intentScore: opp.intentScore,
    householdValueScore: opp.householdValueScore,
    commercialPriority: opp.commercialPriority,
    leadTemperature: opp.leadTemperature,
    consentStatus: opp.consentStatus,
    nextAction: opp.nextAction,
    assignedStatus: opp.assignedStatus,
    lostReason: opp.lostReason,
    stage: opp.stage,
    updatedAt: opp.updatedAt,
  };
}

async function getLeadWithIdentity(leadId) {
  const store = await getRevenueStore('leads');
  const lead = await blobGetJson(store, leadId);
  if (!lead) return null;
  return {
    leadId: lead.leadId,
    householdId: lead.householdId,
    segment: lead.segment,
    vehicleCountBand: lead.vehicleCountBand,
    assetCategories: lead.assetCategories,
    intentScore: lead.intentScore,
    commercialPriority: lead.commercialPriority,
    marketingConsent: lead.marketingConsent,
    smsConsent: lead.smsConsent,
    emailConsent: lead.emailConsent,
    name: lead._private?.name || null,
    email: lead._private?.email || null,
    phone: lead._private?.phone || null,
    zip: lead._private?.zip || null,
    updatedAt: lead.updatedAt,
  };
}

async function priorityQueue() {
  const opps = await listOpportunities({ limit: 200 });
  return opps.filter(o =>
    o.commercialPriority === 'immediate_follow_up'
    || o.commercialPriority === 'priority'
    || o.commercialPriority === 'scheduled'
    || (o.intentScore >= 40)
    || o.leadTemperature === 'hot'
    || o.segment === 'SPECIALTY_ASSET_OWNER'
    || o.segment === 'RETURNING_CUSTOMER'
    || o.segment === 'RECURRING_MAINTENANCE_PROSPECT'
    || o.vehicleCountBand === '2'
    || o.vehicleCountBand === '3-4'
    || o.vehicleCountBand === '5-6'
  ).slice(0, 50);
}

async function dashboardSummary() {
  const events = await listRecentEvents({ limit: 500 });
  const counts = {};
  for (const ev of events) {
    counts[ev.event] = (counts[ev.event] || 0) + 1;
  }
  const opps = await listOpportunities({ limit: 200 });
  const pipelineValue = opps.reduce((s, o) => s + (Number(o.estimatedValue) || 0), 0);
  return {
    eventCounts: counts,
    opportunityCount: opps.length,
    estimatedPipelineValue: pipelineValue,
    hubspotEnabled: hubspotEnabled(),
    stages: PIPELINE_STAGES,
    lostReasons: LOST_REASONS,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const admin = await verifyAdminRequest(event.headers || {});
  if (!admin.ok) return jsonCors(401, { ok: false, error: 'unauthorized' });

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    const view = String(q.view || 'summary');
    if (view === 'summary') return jsonCors(200, { ok: true, ...(await dashboardSummary()) });
    if (view === 'priority') return jsonCors(200, { ok: true, items: await priorityQueue() });
    if (view === 'opportunities') {
      return jsonCors(200, {
        ok: true,
        items: await listOpportunities({
          limit: Math.min(Number(q.limit) || 50, 100),
          segment: q.segment,
          priority: q.priority,
        }),
      });
    }
    if (view === 'lead' && q.leadId) {
      const lead = await getLeadWithIdentity(String(q.leadId));
      if (!lead) return jsonCors(404, { ok: false, error: 'not_found' });
      return jsonCors(200, { ok: true, lead });
    }
    return jsonCors(400, { ok: false, error: 'unknown_view' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || '').toLowerCase();

  if (action === 'send_resume_link') {
    const lead = await getLeadWithIdentity(body.leadId);
    if (!lead) return jsonCors(404, { ok: false, error: 'lead_not_found' });
    const resume = await createResumeToken({
      leadId: lead.leadId,
      householdId: lead.householdId,
      bookingId: body.bookingId,
      bookingStep: body.bookingStep || 4,
    });
    await auditAdminAction(admin.username, 'send_resume_link', { leadId: lead.leadId });
    return jsonCors(200, {
      ok: resume.ok,
      resumePath: resume.ok ? `/resume?token=${encodeURIComponent(resume.token)}` : null,
      expiresAt: resume.expiresAt || null,
      error: resume.error || null,
    });
  }

  if (action === 'mark_contacted') {
    const store = await getRevenueStore('opportunities');
    const opp = await blobGetJson(store, body.opportunityId);
    if (!opp) return jsonCors(404, { ok: false, error: 'not_found' });
    opp.assignedStatus = 'contacted';
    opp.updatedAt = new Date().toISOString();
    await blobSetJson(store, body.opportunityId, opp);
    await auditAdminAction(admin.username, 'mark_contacted', { opportunityId: body.opportunityId });
    return jsonCors(200, { ok: true });
  }

  if (action === 'mark_lost') {
    const reason = LOST_REASONS.includes(body.lostReason) ? body.lostReason : 'other';
    const store = await getRevenueStore('opportunities');
    const opp = await blobGetJson(store, body.opportunityId);
    if (!opp) return jsonCors(404, { ok: false, error: 'not_found' });
    opp.stage = 'Lost';
    opp.lostReason = reason;
    opp.updatedAt = new Date().toISOString();
    await blobSetJson(store, body.opportunityId, opp);
    await auditAdminAction(admin.username, 'mark_lost', { opportunityId: body.opportunityId, reason });
    return jsonCors(200, { ok: true });
  }

  if (action === 'mark_won') {
    const store = await getRevenueStore('opportunities');
    const opp = await blobGetJson(store, body.opportunityId);
    if (!opp) return jsonCors(404, { ok: false, error: 'not_found' });
    opp.stage = 'Confirmed';
    opp.updatedAt = new Date().toISOString();
    await blobSetJson(store, body.opportunityId, opp);
    await auditAdminAction(admin.username, 'mark_won', { opportunityId: body.opportunityId });
    return jsonCors(200, { ok: true });
  }

  if (action === 'enqueue_recovery') {
    const job = await enqueueRecoveryJob({
      leadId: body.leadId,
      householdId: body.householdId,
      bookingId: body.bookingId,
      contactCaptured: true,
      transactionalConsent: true,
      marketingConsent: !!body.marketingConsent,
      bookingSubmitted: false,
      bookingStep: body.bookingStep || 4,
      paymentStepReached: !!body.paymentStepReached,
      paymentMethodSaved: !!body.paymentMethodSaved,
    });
    await auditAdminAction(admin.username, 'enqueue_recovery', { leadId: body.leadId, jobId: job.jobId });
    return jsonCors(200, { ok: true, ...job });
  }

  if (action === 'cancel_recovery') {
    const r = await cancelRecoveryForLead(body.leadId, body.reason || 'admin_cancel');
    await auditAdminAction(admin.username, 'cancel_recovery', { leadId: body.leadId });
    return jsonCors(200, { ok: true, ...r });
  }

  if (action === 'sync_hubspot' && hubspotEnabled()) {
    const lead = await blobGetJson(await getRevenueStore('leads'), body.leadId);
    if (!lead) return jsonCors(404, { ok: false, error: 'not_found' });
    const r = await upsertContact(lead);
    await auditAdminAction(admin.username, 'sync_hubspot', { leadId: body.leadId });
    return jsonCors(200, { ok: r.ok, error: r.error || null });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};
