// Protected Revenue Operations admin API — requires admin session.

const { verifyAdminRequest } = require('../lib/admin-security');
const { jsonCors } = require('../lib/tech-security');
const { getRevenueStore, blobGetJson, blobSetJson, generateOpaqueId } = require('../lib/revenue-store');
const { LOST_REASONS } = require('../lib/revenue-household');
const { createResumeToken } = require('../lib/revenue-resume');
const { enqueueRecoveryJob, cancelRecoveryForLead } = require('../lib/revenue-recovery');
const { hubspotEnabled, upsertContact } = require('../lib/hubspot-adapter');
const {
  buildRevopsDashboard,
  loadOpportunities,
  buildPriorityQueue,
  sanitizeOpportunityForAdmin,
  GARAGE_PLAN_STATUSES,
  newRequestId,
} = require('../lib/revops-dashboard');

const REVOPS_HEADERS = {
  'Cache-Control': 'no-store',
};

function revopsJson(status, body) {
  return jsonCors(status, body, REVOPS_HEADERS);
}

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

exports.handler = async (event) => {
  const requestId = newRequestId();

  if (event.httpMethod === 'OPTIONS') return revopsJson(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return revopsJson(405, { ok: false, error: 'method_not_allowed' });
  }

  try {
    const admin = await verifyAdminRequest(event.headers || {});
    if (!admin.ok) return revopsJson(401, { ok: false, error: 'unauthorized' });

    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const view = String(q.view || 'dashboard').toLowerCase();

      if (view === 'dashboard' || view === 'summary') {
        const dashboard = await buildRevopsDashboard(q);
        return revopsJson(200, dashboard);
      }

      if (view === 'priority') {
        const { items } = await loadOpportunities({ limit: 200 });
        return revopsJson(200, { ok: true, items: buildPriorityQueue(items) });
      }

      if (view === 'opportunities') {
        const { items } = await loadOpportunities({
          limit: Math.min(Number(q.limit) || 50, 100),
          segment: q.segment,
          priority: q.priority,
        });
        return revopsJson(200, { ok: true, items });
      }

      if (view === 'lead' && q.leadId) {
        const lead = await getLeadWithIdentity(String(q.leadId));
        if (!lead) return revopsJson(404, { ok: false, error: 'not_found' });
        return revopsJson(200, { ok: true, lead });
      }

      return revopsJson(400, { ok: false, error: 'unknown_view' });
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return revopsJson(400, { ok: false, error: 'invalid_json' }); }

    const action = String(body.action || '').toLowerCase();

    if (action === 'send_resume_link') {
      const lead = await getLeadWithIdentity(body.leadId);
      if (!lead) return revopsJson(404, { ok: false, error: 'lead_not_found' });
      const resume = await createResumeToken({
        leadId: lead.leadId,
        householdId: lead.householdId,
        bookingId: body.bookingId,
        bookingStep: body.bookingStep || 4,
      });
      await auditAdminAction(admin.username, 'send_resume_link', { leadId: lead.leadId });
      return revopsJson(200, {
        ok: resume.ok,
        resumePath: resume.ok ? `/resume?token=${encodeURIComponent(resume.token)}` : null,
        expiresAt: resume.expiresAt || null,
        error: resume.error || null,
      });
    }

    if (action === 'mark_contacted' || action === 'garage_plan_contacted') {
      const store = await getRevenueStore('opportunities');
      const opp = await blobGetJson(store, body.opportunityId);
      if (!opp) return revopsJson(404, { ok: false, error: 'not_found' });
      opp.assignedStatus = 'contacted';
      if (opp.isGaragePlan || body.garagePlanStatus) {
        opp.garagePlanStatus = 'contacted';
      }
      opp.updatedAt = new Date().toISOString();
      await blobSetJson(store, body.opportunityId, opp);
      await auditAdminAction(admin.username, action, { opportunityId: body.opportunityId });
      return revopsJson(200, { ok: true, opportunity: sanitizeOpportunityForAdmin(opp) });
    }

    if (action === 'garage_plan_status') {
      const status = String(body.status || '').toLowerCase();
      if (!GARAGE_PLAN_STATUSES.includes(status)) {
        return revopsJson(400, { ok: false, error: 'invalid_garage_plan_status' });
      }
      const store = await getRevenueStore('opportunities');
      const opp = await blobGetJson(store, body.opportunityId);
      if (!opp) return revopsJson(404, { ok: false, error: 'not_found' });
      opp.garagePlanStatus = status;
      opp.isGaragePlan = true;
      if (status === 'won') opp.stage = 'Confirmed';
      if (status === 'lost') {
        opp.stage = 'Lost';
        opp.lostReason = LOST_REASONS.includes(body.lostReason) ? body.lostReason : 'other';
      }
      if (status === 'converted_to_booking') opp.stage = 'Booking Started';
      opp.updatedAt = new Date().toISOString();
      await blobSetJson(store, body.opportunityId, opp);
      await auditAdminAction(admin.username, 'garage_plan_status', { opportunityId: body.opportunityId, status });
      return revopsJson(200, { ok: true, opportunity: sanitizeOpportunityForAdmin(opp) });
    }

    if (action === 'mark_lost') {
      const reason = LOST_REASONS.includes(body.lostReason) ? body.lostReason : 'other';
      const store = await getRevenueStore('opportunities');
      const opp = await blobGetJson(store, body.opportunityId);
      if (!opp) return revopsJson(404, { ok: false, error: 'not_found' });
      opp.stage = 'Lost';
      opp.lostReason = reason;
      opp.updatedAt = new Date().toISOString();
      await blobSetJson(store, body.opportunityId, opp);
      await auditAdminAction(admin.username, 'mark_lost', { opportunityId: body.opportunityId, reason });
      return revopsJson(200, { ok: true });
    }

    if (action === 'mark_won') {
      const store = await getRevenueStore('opportunities');
      const opp = await blobGetJson(store, body.opportunityId);
      if (!opp) return revopsJson(404, { ok: false, error: 'not_found' });
      opp.stage = 'Confirmed';
      if (opp.isGaragePlan) opp.garagePlanStatus = 'won';
      opp.updatedAt = new Date().toISOString();
      await blobSetJson(store, body.opportunityId, opp);
      await auditAdminAction(admin.username, 'mark_won', { opportunityId: body.opportunityId });
      return revopsJson(200, { ok: true });
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
      return revopsJson(200, { ok: true, ...job });
    }

    if (action === 'cancel_recovery') {
      const r = await cancelRecoveryForLead(body.leadId, body.reason || 'admin_cancel');
      await auditAdminAction(admin.username, 'cancel_recovery', { leadId: body.leadId });
      return revopsJson(200, { ok: true, ...r });
    }

    if (action === 'sync_hubspot' && hubspotEnabled()) {
      const lead = await blobGetJson(await getRevenueStore('leads'), body.leadId);
      if (!lead) return revopsJson(404, { ok: false, error: 'not_found' });
      const r = await upsertContact(lead);
      await auditAdminAction(admin.username, 'sync_hubspot', { leadId: body.leadId });
      return revopsJson(200, { ok: r.ok, error: r.error || null });
    }

    return revopsJson(400, { ok: false, error: 'unknown_action' });
  } catch (err) {
    const msg = String(err && err.message || '');
    console.error('[revenue-admin]', requestId, msg);
    const blobFailure = /blob|not been configured|getStore/i.test(msg);
    return revopsJson(blobFailure ? 503 : 503, {
      ok: false,
      error: 'revops_temporarily_unavailable',
      requestId,
      retryable: true,
    });
  }
};

exports.__test = {
  getLeadWithIdentity,
  auditAdminAction,
};
