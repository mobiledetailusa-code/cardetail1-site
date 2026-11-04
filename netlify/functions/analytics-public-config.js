/**
 * Public GA4 measurement-id lookup.
 *
 * GET /.netlify/functions/analytics-public-config
 * 200 { ga4MeasurementId: "G-..." | null }
 *
 * Classic (v1) handler on purpose: production releases may publish prebuilt
 * function zips, which carry no build metadata. A v2 (default-export)
 * function deployed that way is invoked as a v1 Lambda and fails with
 * "error decoding lambda response" (502), which leaves GA4 off site-wide.
 */

const { publicAnalyticsConfig } = require('../lib/analytics-public-config');

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

exports.handler = async (event) => {
  const method = String((event && event.httpMethod) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
  }
  const body = publicAnalyticsConfig({
    GA4_MEASUREMENT_ID: process.env.GA4_MEASUREMENT_ID || '',
    CD1_GA4_MEASUREMENT_ID: process.env.CD1_GA4_MEASUREMENT_ID || '',
  });
  if (method === 'HEAD') return { statusCode: 200, headers, body: '' };
  return { statusCode: 200, headers, body: JSON.stringify(body) };
};
