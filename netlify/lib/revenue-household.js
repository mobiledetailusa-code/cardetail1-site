// Household / lead / opportunity private first-party model.

const crypto = require('crypto');
const { getRevenueStore, blobGetJson, blobSetJson, generateOpaqueId, retentionExpiresAt } = require('./revenue-store');
const { classifySegment, vehicleCountBand } = require('./revenue-segments');
const { computeIntentScore, computeHouseholdValueScore, commercialPriority, leadTemperature } = require('./revenue-scoring');

const PIPELINE_STAGES = Object.freeze([
  'Anonymous Visitor', 'Engaged Visitor', 'Lead Captured', 'Qualified Lead',
  'Multi-Vehicle Opportunity', 'High-Intent Opportunity', 'Quote Required',
  'Quote Sent', 'Booking Started', 'Booking Requested', 'Awaiting Confirmation',
  'Confirmed', 'Completed', 'Maintenance Opportunity', 'Rebooking Opportunity', 'Lost',
]);

const LOST_REASONS = Object.freeze([
  'price', 'distance', 'date_unavailable', 'no_response', 'payment_friction',
  'service_unavailable', 'unsafe_access', 'selected_competitor', 'out_of_service_area',
  'research_only', 'duplicate', 'cancelled', 'other',
]);

function addressDedupSecret() {
  const s = String(process.env.HOUSEHOLD_DEDUP_SECRET || process.env.ADMIN_SESSION_SECRET || '').trim();
  if (s.length >= 32) return s;
  return '';
}

function normalizeAddressForDedup(address, zip) {
  return String(address || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) + '|' + String(zip || '').replace(/\D/g, '').slice(0, 5);
}

function addressDedupHash(address, zip) {
  const secret = addressDedupSecret();
  if (!secret) return null;
  const payload = normalizeAddressForDedup(address, zip);
  if (!payload || payload === '|') return null;
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

const { validateLeadCreation } = require('./anonymous-prospect');

async function createLead(input) {
  const validation = validateLeadCreation(input);
  if (!validation.ok) {
    const err = new Error(validation.error);
    err.code = validation.error;
    throw err;
  }
  const leadId = generateOpaqueId('lead');
  const now = new Date().toISOString();
  const segmentResult = classifySegment(input);
  const lead = {
    leadId,
    householdId: input.householdId || null,
    segment: segmentResult.segment,
    segmentReasons: segmentResult.reasons,
    vehicleCount: Number(input.vehicleCount || 0),
    vehicleCountBand: vehicleCountBand(input.vehicleCount),
    assetCategories: input.assetCategories || [],
    source: input.source || 'website',
    campaign: input.utm_campaign || null,
    marketingConsent: !!input.marketingConsent,
    smsConsent: !!input.smsConsent,
    emailConsent: !!input.emailConsent,
    transactionalConsent: !!input.transactionalConsent,
    intentScore: 0,
    householdValueScore: 0,
    commercialPriority: 'standard',
    createdAt: now,
    updatedAt: now,
    expiresAt: retentionExpiresAt('leads'),
    // PII stored server-side only — never sent to analytics
    _private: {
      name: input.name || null,
      email: input.email ? String(input.email).trim().toLowerCase() : null,
      phone: input.phone ? String(input.phone).replace(/\D/g, '').slice(-10) : null,
      zip: input.zip ? String(input.zip).replace(/\D/g, '').slice(0, 5) : null,
    },
  };
  const store = await getRevenueStore('leads');
  await blobSetJson(store, leadId, lead);
  if (lead._private.email) await blobSetJson(store, `email:${lead._private.email}`, { leadId });
  if (lead._private.phone) await blobSetJson(store, `phone:${lead._private.phone}`, { leadId });
  return lead;
}

async function createHousehold(input) {
  const householdId = generateOpaqueId('hh');
  const now = new Date().toISOString();
  const hv = computeHouseholdValueScore(input);
  const household = {
    householdId,
    leadId: input.leadId || null,
    customerId: input.customerId || null,
    vehicleCount: Number(input.vehicleCount || 0),
    assetCategories: input.assetCategories || [],
    vehicleRefs: input.vehicleRefs || [],
    addressRef: input.addressRef || null,
    addressDedupHash: addressDedupHash(input.address, input.zip),
    previousServices: Number(input.previousServices || 0),
    estimatedAnnualOpportunity: Number(input.estimatedAnnualOpportunity || 0),
    opportunityStage: input.opportunityStage || 'Lead Captured',
    intentScore: Number(input.intentScore || 0),
    householdValueScore: hv.score,
    householdValueExplanations: hv.explanations,
    commercialPriority: commercialPriority(input.intentScore || 0, hv.score).classification,
    marketingConsent: !!input.marketingConsent,
    smsConsent: !!input.smsConsent,
    emailConsent: !!input.emailConsent,
    lastActivity: now,
    nextRecommendedAction: input.nextRecommendedAction || null,
    createdAt: now,
    updatedAt: now,
    expiresAt: retentionExpiresAt('households'),
  };
  const store = await getRevenueStore('households');
  await blobSetJson(store, householdId, household);
  if (household.addressDedupHash) {
    await blobSetJson(store, `addr:${household.addressDedupHash}`, { householdId });
  }
  return household;
}

async function createOpportunity(input) {
  const opportunityId = generateOpaqueId('opp');
  const now = new Date().toISOString();
  const segmentResult = classifySegment(input);
  const hv = computeHouseholdValueScore(input);
  const intent = Number(input.intentScore || computeIntentScore(input.events || []));
  const priority = commercialPriority(intent, hv.score);
  const opp = {
    opportunityId,
    householdId: input.householdId || null,
    leadId: input.leadId || null,
    segment: segmentResult.segment,
    vehicleCountBand: vehicleCountBand(input.vehicleCount),
    assetCategories: input.assetCategories || [],
    selectedCategory: input.selectedCategory || null,
    selectedPackage: input.selectedPackage || null,
    estimatedValue: Number(input.estimatedValue || 0),
    source: input.source || null,
    campaign: input.utm_campaign || null,
    lastBookingStep: input.lastBookingStep || null,
    intentScore: intent,
    householdValueScore: hv.score,
    commercialPriority: priority.classification,
    leadTemperature: leadTemperature(intent),
    consentStatus: {
      marketing: !!input.marketingConsent,
      sms: !!input.smsConsent,
      email: !!input.emailConsent,
      transactional: !!input.transactionalConsent,
    },
    nextAction: input.nextAction || null,
    assignedStatus: input.assignedStatus || 'unassigned',
    isGaragePlan: !!input.isGaragePlan,
    garagePlanStatus: input.garagePlanStatus || null,
    lostReason: null,
    stage: input.stage || 'Lead Captured',
    createdAt: now,
    updatedAt: now,
    expiresAt: retentionExpiresAt('opportunities'),
  };
  const store = await getRevenueStore('opportunities');
  await blobSetJson(store, opportunityId, opp);
  return opp;
}

async function findLeadByEmailOrPhone(email, phone) {
  const store = await getRevenueStore('leads');
  const e = email ? String(email).trim().toLowerCase() : '';
  const p = phone ? String(phone).replace(/\D/g, '').slice(-10) : '';
  if (e) {
    const ref = await blobGetJson(store, `email:${e}`);
    if (ref && ref.leadId) return blobGetJson(store, ref.leadId);
  }
  if (p) {
    const ref = await blobGetJson(store, `phone:${p}`);
    if (ref && ref.leadId) return blobGetJson(store, ref.leadId);
  }
  return null;
}

module.exports = {
  PIPELINE_STAGES,
  LOST_REASONS,
  addressDedupHash,
  createLead,
  createHousehold,
  createOpportunity,
  findLeadByEmailOrPhone,
};
