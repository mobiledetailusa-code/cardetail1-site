// POST /.netlify/functions/garage-plan-submit — Garage Plan lead capture (no card data).

const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { createLead, createHousehold, createOpportunity } = require('../lib/revenue-household');
const { classifySegment, vehicleCountBand } = require('../lib/revenue-segments');
const { computeHouseholdValueScore, commercialPriority } = require('../lib/revenue-scoring');
const { recommendNextAction } = require('../lib/next-best-action');
const { hubspotEnabled, upsertContact, upsertDeal } = require('../lib/hubspot-adapter');
const { createResumeToken } = require('../lib/revenue-resume');
const { getOfferConfig } = require('../lib/revenue-offers');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function sanitizeText(v, max = 200) {
  return String(v || '').trim().slice(0, max);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
  }

  const rate = await enforcePublicRateLimit(event, 'garage-plan-submit', 'submit');
  if (!rate.ok) {
    return { statusCode: 429, headers: cors, body: JSON.stringify({ ok: false, error: 'rate_limited' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'invalid_json' }) }; }

  const vehicleCount = Math.max(0, Number(body.vehicleCount || body.personalVehicleCount || 0));
  const isCommercial = body.isCommercial === true || body.ownership === 'business' || vehicleCount >= 7;

  if (isCommercial) {
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: true,
        route: 'fleet_quote',
        message: 'Commercial and fleet inquiries are routed to our quote team.',
        fleetUrl: '/fleet-services.html',
      }),
    };
  }

  if (vehicleCount < 2) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ ok: false, error: 'garage_plan_requires_two_vehicles' }),
    };
  }

  if (!body.transactionalConsent) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'transactional_consent_required' }) };
  }

  const name = sanitizeText(body.name, 120);
  const email = sanitizeText(body.email, 120);
  const phone = sanitizeText(body.phone, 32);
  const zip = sanitizeText(body.zip || body.serviceZip, 10);
  if (!name || !phone || !zip) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'missing_required_fields' }) };
  }

  try {
    const segmentResult = classifySegment({
      vehicleCount,
      assetCategories: body.vehicleCategories || body.categories || [],
      sameLocationSameVisit: body.sameLocationSameVisit,
      maintenanceFrequency: body.maintenanceFrequency,
    });

    const hv = computeHouseholdValueScore({
      vehicleCount,
      assetCategories: body.vehicleCategories || [],
      sameLocationSameVisit: body.sameLocationSameVisit,
      maintenanceFrequency: body.maintenanceFrequency,
      estimatedValue: body.estimatedValue,
    });

    const lead = await createLead({
      name,
      email,
      phone,
      zip,
      vehicleCount,
      assetCategories: body.vehicleCategories || [],
      source: body.source || 'garage_plan',
      utm_campaign: body.utm_campaign,
      marketingConsent: !!body.marketingConsent,
      smsConsent: !!body.smsConsent,
      emailConsent: !!body.emailConsent,
      transactionalConsent: true,
      isCommercial: false,
    });
    lead.householdValueScore = hv.score;
    lead.intentScore = 30;

    const household = await createHousehold({
      leadId: lead.leadId,
      vehicleCount,
      assetCategories: body.vehicleCategories || [],
      address: body.address,
      zip,
      intentScore: 30,
      marketingConsent: !!body.marketingConsent,
      smsConsent: !!body.smsConsent,
      emailConsent: !!body.emailConsent,
      opportunityStage: 'Multi-Vehicle Opportunity',
    });

    const offers = getOfferConfig();
    const nextAction = recommendNextAction({
      segment: segmentResult.segment,
      vehicleCount,
      assetCategories: body.vehicleCategories || [],
      offersEnabled: offers.multiVehicle.enabled || offers.firstBooking.enabled,
    });

    const opportunity = await createOpportunity({
      leadId: lead.leadId,
      householdId: household.householdId,
      vehicleCount,
      assetCategories: body.vehicleCategories || [],
      selectedCategory: body.packageInterest || null,
      estimatedValue: Number(body.estimatedValue || 0),
      source: body.source || 'garage_plan',
      utm_campaign: body.utm_campaign,
      lastBookingStep: null,
      intentScore: 30,
      marketingConsent: !!body.marketingConsent,
      smsConsent: !!body.smsConsent,
      emailConsent: !!body.emailConsent,
      transactionalConsent: true,
      stage: vehicleCount >= 3 ? 'Multi-Vehicle Opportunity' : 'Qualified Lead',
      nextAction: nextAction.action,
    });

    let resume = null;
    if (body.prefillBooking) {
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

    const priority = commercialPriority(30, hv.score, segmentResult.segment);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: true,
        route: 'garage_plan',
        leadId: lead.leadId,
        householdId: household.householdId,
        opportunityId: opportunity.opportunityId,
        segment: segmentResult.segment,
        vehicleCountBand: vehicleCountBand(vehicleCount),
        commercialPriority: priority.classification,
        nextAction: nextAction.action,
        resumePath: resume && resume.ok ? `/resume?token=${encodeURIComponent(resume.token)}` : null,
        bookingPrefill: body.prefillBooking ? {
          vehicleCount,
          categories: body.vehicleCategories || [],
          zip,
          sameLocationSameVisit: !!body.sameLocationSameVisit,
        } : null,
      }),
    };
  } catch (err) {
    console.error('[garage-plan-submit]', err.message);
    return { statusCode: 503, headers: cors, body: JSON.stringify({ ok: false, error: 'service_unavailable' }) };
  }
};
