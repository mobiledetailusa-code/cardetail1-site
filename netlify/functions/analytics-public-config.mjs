import { publicAnalyticsConfig } from '../lib/analytics-public-config.js';

function readEnv(name) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
      const value = Netlify.env.get(name);
      if (value) return value;
    }
  } catch {
    /* local unit tests and `netlify dev` can fall through to process.env */
  }
  return process.env[name] || '';
}

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
      status: 405,
      headers,
    });
  }
  const body = publicAnalyticsConfig({
    GA4_MEASUREMENT_ID: readEnv('GA4_MEASUREMENT_ID'),
    CD1_GA4_MEASUREMENT_ID: readEnv('CD1_GA4_MEASUREMENT_ID'),
  });
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(JSON.stringify(body), { status: 200, headers });
};
