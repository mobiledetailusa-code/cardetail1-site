// Technician profile + contractor onboarding (insurance, vehicle, experience).
const { blobsStore, jsonCors, validateTechSession, sanitizeText } = require('../lib/tech-security');
const { getOpsSettings } = require('../lib/ops-config');

const ONBOARDING_VERSION = 'v1';

function projectTechProfile(tech) {
  const ob = tech.onboarding || {};
  return {
    techId: tech.techId || tech.id,
    fullName: tech.fullName || tech.name,
    email: tech.email,
    phone: tech.phone,
    serviceArea: tech.serviceArea || '',
    capabilities: tech.capabilities || [],
    ratingAverage: tech.ratingAverage || null,
    ratingCount: tech.ratingCount || 0,
    onboardingComplete: !!ob.completed,
    onboarding: {
      companyName: ob.companyName || '',
      taxIdType: ob.taxIdType || '',
      taxIdLast4: ob.taxIdLast4 || '',
      insuranceCarrier: ob.insuranceCarrier || '',
      insuranceExpiresAt: ob.insuranceExpiresAt || '',
      workVehicle: ob.workVehicle || '',
      hasWaterAccess: !!ob.hasWaterAccess,
      hasPowerAccess: !!ob.hasPowerAccess,
      hasOwnLadder: !!ob.hasOwnLadder,
      experience: ob.experience || {},
      termsAcceptedAt: ob.termsAcceptedAt || null,
      photosRequiredAck: !!ob.photosRequiredAck,
    },
    contractorAgreementVersion: tech.contractorAgreementVersion || ONBOARDING_VERSION,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const session = await validateTechSession(event.headers || {});
  if (!session) return jsonCors(401, { ok: false, error: 'invalid_session' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || 'get');
  const techStore = await blobsStore('cd1-tech-accounts');
  const tech = session.tech;
  const key = 'tech-' + (tech.techId || tech.id);

  if (action === 'get') {
    const settings = await getOpsSettings();
    return jsonCors(200, {
      ok: true,
      profile: projectTechProfile(tech),
      platformTerms: {
        version: settings.contractorAgreementVersion || ONBOARDING_VERSION,
        bidDisclaimer: 'Jobs are awarded by bid amount AND your rating/acceptance history — not price alone.',
        notRequiredToBid: 'You are never required to place a bid. If you win, you must complete the job or cancel 24+ hours before appointment.',
        photosRequired: 'Before and after photos are required on every completed job.',
        compoundRequiresExperience: settings.requireCompoundExperience,
      },
    });
  }

  if (action === 'submit_onboarding') {
    if (!body.termsAccepted) {
      return jsonCors(400, { ok: false, error: 'terms_required' });
    }
    const taxRaw = String(body.taxId || '').replace(/\D/g, '');
    const taxIdType = body.taxIdType === 'ssn' ? 'ssn' : 'ein';
    if (taxRaw.length < 4) {
      return jsonCors(400, { ok: false, error: 'tax_id_required', userMessage: 'Provide EIN or SSN (last 4 stored for verification).' });
    }
    if (!sanitizeText(body.insuranceCarrier, 120)) {
      return jsonCors(400, { ok: false, error: 'insurance_required' });
    }
    if (!sanitizeText(body.workVehicle, 120)) {
      return jsonCors(400, { ok: false, error: 'work_vehicle_required' });
    }

    const settings = await getOpsSettings();
    const exp = body.experience || {};
    if (settings.requireCompoundExperience && body.offersCompound && !exp.compound) {
      return jsonCors(400, { ok: false, error: 'compound_experience_required' });
    }

    const now = new Date().toISOString();
    tech.onboarding = {
      completed: true,
      completedAt: now,
      companyName: sanitizeText(body.companyName, 120),
      taxIdType,
      taxIdLast4: taxRaw.slice(-4),
      taxIdVerified: false,
      insuranceCarrier: sanitizeText(body.insuranceCarrier, 120),
      insurancePolicyNumber: sanitizeText(body.insurancePolicyNumber, 64),
      insuranceExpiresAt: sanitizeText(body.insuranceExpiresAt, 32),
      workVehicle: sanitizeText(body.workVehicle, 120),
      hasWaterAccess: !!body.hasWaterAccess,
      hasPowerAccess: !!body.hasPowerAccess,
      hasOwnLadder: !!body.hasOwnLadder,
      experience: {
        boats: !!exp.boats,
        rvs: !!exp.rvs,
        orbital: !!exp.orbital,
        compound: !!exp.compound,
        buffer: !!exp.buffer,
        extraction: !!exp.extraction,
        deepClean: !!exp.deepClean,
      },
      termsAcceptedAt: now,
      photosRequiredAck: !!body.photosRequiredAck,
      emergencyPolicyAck: !!body.emergencyPolicyAck,
    };
    tech.contractorAgreementVersion = settings.contractorAgreementVersion || ONBOARDING_VERSION;
    tech.updatedAt = now;
    await techStore.setJSON(key, tech);

    return jsonCors(200, { ok: true, profile: projectTechProfile(tech) });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};
