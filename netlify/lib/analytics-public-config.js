// Public analytics configuration. Measurement IDs are not secrets, but this
// module never invents one. An empty or malformed value leaves GA4 off.

const GA4_ID = /^G-[A-Z0-9]{4,32}$/;

function normalizeGa4MeasurementId(value) {
  const id = String(value || '').trim();
  return GA4_ID.test(id) ? id : '';
}

function publicAnalyticsConfig(env) {
  const source = env && typeof env === 'object' ? env : {};
  const ga4MeasurementId = normalizeGa4MeasurementId(
    source.GA4_MEASUREMENT_ID || source.CD1_GA4_MEASUREMENT_ID || ''
  );
  return {
    ok: true,
    ga4MeasurementId: ga4MeasurementId || null,
    configured: {
      ga4: !!ga4MeasurementId,
    },
  };
}

module.exports = {
  normalizeGa4MeasurementId,
  publicAnalyticsConfig,
};
