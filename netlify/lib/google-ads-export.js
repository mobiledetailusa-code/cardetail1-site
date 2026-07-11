// Google Ads offline conversion export adapter — disabled until explicitly enabled.

function googleAdsExportEnabled() {
  return String(process.env.GOOGLE_ADS_EXPORT_ENABLED || '').toLowerCase() === 'true'
    && !!String(process.env.GOOGLE_ADS_CUSTOMER_ID || '').trim();
}

function hashIdentifier(value) {
  const crypto = require('crypto');
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function buildConversionRecord(input) {
  return {
    gclid: input.gclid || null,
    gbraid: input.gbraid || null,
    wbraid: input.wbraid || null,
    conversionAction: input.conversionAction || null,
    conversionDateTime: input.conversionDateTime || new Date().toISOString(),
    conversionValue: Number(input.conversionValue || 0),
    currencyCode: input.currency || 'USD',
    orderId: input.orderId || input.opportunityId || input.leadId || null,
    consentAdUserData: input.consentAdUserData || 'DENIED',
    consentAdPersonalization: input.consentAdPersonalization || 'DENIED',
    hashedEmail: input.email ? hashIdentifier(input.email) : null,
    hashedPhone: input.phone ? hashIdentifier(String(input.phone).replace(/\D/g, '')) : null,
    status: 'pending_upload',
    createdAt: new Date().toISOString(),
  };
}

async function queueConversionExport(record) {
  if (!googleAdsExportEnabled()) {
    return { ok: false, error: 'google_ads_export_disabled' };
  }
  if (!record.gclid && !record.gbraid && !record.wbraid) {
    return { ok: false, error: 'missing_click_id' };
  }
  const { getRevenueStore, blobSetJson, generateOpaqueId } = require('./revenue-store');
  const store = await getRevenueStore('events');
  const id = generateOpaqueId('gads');
  await blobSetJson(store, `gads:${id}`, record);
  return { ok: true, exportId: id, dryRun: true };
}

module.exports = {
  googleAdsExportEnabled,
  buildConversionRecord,
  queueConversionExport,
  hashIdentifier,
};
