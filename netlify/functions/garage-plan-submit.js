// POST /.netlify/functions/garage-plan-submit — Garage Plan lead capture (no card data).

const publicRateLimit = require('../lib/public-rate-limit');
const {
  createLead,
  createHousehold,
  createOpportunity,
  findLeadByEmailOrPhone,
} = require('../lib/revenue-household');
const { classifySegment, vehicleCountBand } = require('../lib/revenue-segments');
const { computeHouseholdValueScore, commercialPriority } = require('../lib/revenue-scoring');
const { recommendNextAction } = require('../lib/next-best-action');
const { hubspotEnabled, upsertContact, upsertDeal } = require('../lib/hubspot-adapter');
const { createResumeToken } = require('../lib/revenue-resume');
const { getOfferConfig } = require('../lib/revenue-offers');
const { validateGaragePlanInput } = require('../lib/garage-plan-validation');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(status, body) {
  return { statusCode: status, headers: cors, body: JSON.stringify(body) };
}

function buildSuccessResponse({
  validated,
  segmentResult,
  lead,
  household,
  opportunity,
  nextAction,
  resume,
  idempotent,
}) {
  const priority = commercialPriority(30, lead.householdValueScore || 0, segmentResult.segment);
  const route = validated.manualReviewRequired ? 'manual_review' : 'garage_plan';
  const gpReference = 'GP-' + String(opportunity.opportunityId || '').replace(/^opp_?/i, '').slice(-10).toUpperCase();
  return json(200, {
    ok: true,
    route,
    idempotent: !!idempotent,
    leadId: lead.leadId,
    householdId: household.householdId,
    opportunityId: opportunity.opportunityId,
    gpReference,
    segment: segmentResult.segment,
    vehicleCountBand: vehicleCountBand(validated.vehicleCount),
    commercialPriority: priority.classification,
    nextAction: nextAction.action,
    manualReviewRequired: validated.manualReviewRequired,
    resumePath: resume && resume.ok ? `/resume?token=${encodeURIComponent(resume.token)}` : null,
    bookingPrefill: validated.prefillBooking ? {
      vehicleCount: validated.vehicleCount,
      categories: validated.categories,
      zip: validated.zip,
      sameLocationSameVisit: validated.sameLocationSameVisit,
    } : null,
    fleetUrl: route === 'fleet_quote' ? '/fleet-services.html' : null,
  });
}

async function persistGaragePlanLead(validated) {
  const segmentResult = classifySegment({
    vehicleCount: validated.vehicleCount,
    assetCategories: validated.categories,
    unsupportedZip: validated.manualReviewRequired,
    sameLocationSameVisit: validated.sameLocationSameVisit,
    maintenanceFrequency: validated.maintenanceFrequency,
    isCommercial: false,
  });

  const hv = computeHouseholdValueScore({
    vehicleCount: validated.vehicleCount,
    assetCategories: validated.categories,
    sameLocationSameVisit: validated.sameLocationSameVisit,
    maintenanceFrequency: validated.maintenanceFrequency,
    estimatedValue: validated.estimatedValue,
  });

  const lead = await createLead({
    name: validated.name,
    email: validated.email,
    phone: validated.phone,
    zip: validated.zip,
    vehicleCount: validated.vehicleCount,
    assetCategories: validated.categories,
    source: validated.source,
    utm_campaign: validated.utm_campaign,
    marketingConsent: validated.marketingConsent,
    smsConsent: validated.smsConsent,
    emailConsent: validated.emailConsent,
    transactionalConsent: true,
    isCommercial: false,
  });
  lead.householdValueScore = hv.score;
  lead.intentScore = 30;

  const household = await createHousehold({
    leadId: lead.leadId,
    vehicleCount: validated.vehicleCount,
    assetCategories: validated.categories,
    zip: validated.zip,
    intentScore: 30,
    marketingConsent: validated.marketingConsent,
    smsConsent: validated.smsConsent,
    emailConsent: validated.emailConsent,
    opportunityStage: 'Multi-Vehicle Opportunity',
  });

  const offers = getOfferConfig();
  const nextAction = recommendNextAction({
    segment: segmentResult.segment,
    vehicleCount: validated.vehicleCount,
    assetCategories: validated.categories,
    offersEnabled: offers.multiVehicle.enabled || offers.firstBooking.enabled,
  });

  const opportunity = await createOpportunity({
    leadId: lead.leadId,
    householdId: household.householdId,
    vehicleCount: validated.vehicleCount,
    assetCategories: validated.categories,
    selectedCategory: validated.packageInterest || null,
    estimatedValue: validated.estimatedValue,
    source: validated.source || 'garage_plan',
    utm_campaign: validated.utm_campaign,
    intentScore: 30,
    marketingConsent: validated.marketingConsent,
    smsConsent: validated.smsConsent,
    emailConsent: validated.emailConsent,
    transactionalConsent: true,
    stage: validated.vehicleCount >= 3 ? 'Multi-Vehicle Opportunity' : 'Qualified Lead',
    nextAction: nextAction.action,
    isGaragePlan: true,
    garagePlanStatus: 'new',
    notificationStatus: 'recorded',
    customerName: validated.name,
    customerPhone: validated.phone,
    customerEmail: validated.email,
    zip: validated.zip,
    sameLocationSameVisit: validated.sameLocationSameVisit,
    maintenanceFrequency: validated.maintenanceFrequency,
  });

  const leadStore = await require('../lib/revenue-store').getRevenueStore('leads');
  await require('../lib/revenue-store').blobSetJson(leadStore, lead.leadId, {
    ...lead,
    householdId: household.householdId,
    opportunityId: opportunity.opportunityId,
    updatedAt: new Date().toISOString(),
  });

  let resume = null;
  if (validated.prefillBooking) {
    resume = await createResumeToken({
      leadId: lead.leadId,
      householdId: household.householdId,
      bookingStep: 1,
      garagePlanId: opportunity.opportunityId,
    });
  }

  if (hubspotEnabled()) {
    await upsertContact({ ...lead, householdId: household.householdId }).catch(() => null);
    await upsertDeal({ ...opportunity, offerId: nextAction.offer_id }).catch(() => null);
  }

  return { segmentResult, lead, household, opportunity, nextAction, resume };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  const rate = await publicRateLimit.enforcePublicRateLimit(event, {
    endpoint: 'garage-plan-submit',
    action: 'submit',
    cors: true,
  });
  if (rate.blocked) {
    return rate.response || json(429, { ok: false, error: 'rate_limited' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const validated = validateGaragePlanInput(body);
  if (!validated.ok) {
    if (validated.error === 'fleet_quote_required') {
      return json(200, {
        ok: true,
        route: 'fleet_quote',
        message: 'Commercial and fleet inquiries are routed to our quote team.',
        fleetUrl: '/fleet-services.html',
      });
    }
    const status = validated.error === 'rate_limited' ? 429 : 400;
    return json(status, {
      ok: false,
      error: validated.error,
      field: validated.field || null,
      route: validated.route || null,
    });
  }

  try {
    const existing = await findLeadByEmailOrPhone(validated.email, validated.phone);
    if (existing && existing.leadId) {
      const segmentResult = classifySegment({
        vehicleCount: validated.vehicleCount,
        assetCategories: validated.categories,
        unsupportedZip: validated.manualReviewRequired,
      });
      const offers = getOfferConfig();
      const nextAction = recommendNextAction({
        segment: segmentResult.segment,
        vehicleCount: validated.vehicleCount,
        assetCategories: validated.categories,
        offersEnabled: offers.multiVehicle.enabled || offers.firstBooking.enabled,
      });
      return buildSuccessResponse({
        validated,
        segmentResult,
        lead: existing,
        household: { householdId: existing.householdId || null },
        opportunity: { opportunityId: existing.opportunityId || null },
        nextAction,
        resume: null,
        idempotent: true,
      });
    }

    const persisted = await persistGaragePlanLead(validated);
    return buildSuccessResponse({
      validated,
      ...persisted,
      idempotent: false,
    });
  } catch (err) {
    const message = String(err && err.message || '');
    const code = err.code || message || 'server_error';
    console.error('[garage-plan-submit]', code, message.slice(0, 240));
    if (code === 'anonymous_not_identified' || code === 'transactional_consent_required') {
      return json(400, { ok: false, error: code });
    }
    // Match real storage failures — do not treat any stack path containing "blobs" as unavailable.
    const blobFailure = (err && err.code === 'service_unavailable')
      || /blob store|blobs api|failed to (get|set|list) blob|netlify blobs/i.test(message);
    const ctx = String(process.env.CONTEXT || '').toLowerCase();
    const allowDebug = ctx !== 'production';
    if (blobFailure) {
      const body = { ok: false, error: 'service_unavailable' };
      if (allowDebug) body.debug = String(message || code).slice(0, 180);
      return json(503, body);
    }
    const body = { ok: false, error: 'server_error' };
    if (allowDebug) body.debug = String(message || code).slice(0, 180);
    return json(500, body);
  }
};

exports.__test = {
  validateGaragePlanInput,
  persistGaragePlanLead,
  buildSuccessResponse,
};
