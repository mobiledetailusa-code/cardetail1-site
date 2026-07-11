// Optional server-side HubSpot CRM adapter — disabled by default.

function hubspotEnabled() {
  return String(process.env.HUBSPOT_INTEGRATION_ENABLED || '').toLowerCase() === 'true'
    && !!String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || '').trim();
}

async function hubspotRequest(path, method, body) {
  const token = String(process.env.HUBSPOT_PRIVATE_APP_TOKEN || '').trim();
  if (!token) return { ok: false, error: 'hubspot_not_configured' };
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: 'hubspot_api_error', status: res.status, data };
  return { ok: true, data };
}

async function findContactByEmail(email) {
  if (!email) return null;
  const r = await hubspotRequest('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [{
      filters: [{ propertyName: 'email', operator: 'EQ', value: String(email).trim().toLowerCase() }],
    }],
    properties: ['email', 'phone', 'cardetail1_lead_id'],
    limit: 1,
  });
  if (!r.ok || !r.data.results || !r.data.results.length) return null;
  return r.data.results[0];
}

const { canSyncCrm } = require('./anonymous-prospect');

async function upsertContact(lead) {
  if (!hubspotEnabled()) return { ok: false, error: 'hubspot_disabled' };
  const crmGate = canSyncCrm(lead);
  if (!crmGate.ok) return { ok: false, error: crmGate.error || 'anonymous_not_synced' };
  if (!lead || !lead._private) return { ok: false, error: 'invalid_lead' };

  const email = lead._private.email;
  const phone = lead._private.phone;

  const properties = {
    cardetail1_lead_id: lead.leadId,
    cardetail1_household_id: lead.householdId || '',
    vehicle_count_band: lead.vehicleCountBand || '',
    asset_categories: (lead.assetCategories || []).join(', '),
    household_segment: lead.segment || '',
    intent_score: String(lead.intentScore || 0),
    household_value_score: String(lead.householdValueScore || 0),
    commercial_priority: lead.commercialPriority || '',
    traffic_source: lead.source || '',
    utm_campaign: lead.campaign || '',
    marketing_consent: lead.marketingConsent ? 'true' : 'false',
    sms_consent: lead.smsConsent ? 'true' : 'false',
  };
  if (email) properties.email = email;
  if (phone) properties.phone = phone;
  if (lead._private.name) {
    const parts = String(lead._private.name).trim().split(/\s+/);
    properties.firstname = parts[0] || '';
    properties.lastname = parts.slice(1).join(' ') || '';
  }

  const existing = email ? await findContactByEmail(email) : null;
  if (existing) {
    return hubspotRequest(`/crm/v3/objects/contacts/${existing.id}`, 'PATCH', { properties });
  }
  return hubspotRequest('/crm/v3/objects/contacts', 'POST', { properties });
}

async function upsertDeal(opportunity) {
  if (!hubspotEnabled()) return { ok: false, error: 'hubspot_disabled' };
  if (!opportunity || !opportunity.leadId) return { ok: false, error: 'invalid_opportunity' };
  const properties = {
    dealname: `Cardetail1 ${opportunity.opportunityId}`,
    amount: String(opportunity.estimatedValue || 0),
    cardetail1_lead_id: opportunity.leadId,
    cardetail1_household_id: opportunity.householdId || '',
    household_segment: opportunity.segment || '',
    intent_score: String(opportunity.intentScore || 0),
    household_value_score: String(opportunity.householdValueScore || 0),
    commercial_priority: opportunity.commercialPriority || '',
    last_booking_step: opportunity.lastBookingStep || '',
    estimated_value: String(opportunity.estimatedValue || 0),
    traffic_source: opportunity.source || '',
    utm_campaign: opportunity.campaign || '',
    offer_id: opportunity.offerId || '',
    next_best_action: opportunity.nextAction || '',
    lost_reason: opportunity.lostReason || '',
  };
  return hubspotRequest('/crm/v3/objects/deals', 'POST', { properties });
}

module.exports = {
  hubspotEnabled,
  upsertContact,
  upsertDeal,
};
