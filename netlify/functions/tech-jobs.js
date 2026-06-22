// netlify/functions/tech-jobs.js
// Technician-only: view assigned jobs with minimized data.
// Auth: x-tech-token header (tech session token).
// Returns only operationally necessary fields — no payment, Stripe, or admin-only data.
//
// GET (with x-tech-token header) → { ok, jobs }

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-tech-token',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

async function getStore(name) {
  const { getStore: gs } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? gs({ name, siteID, token }) : gs(name);
}

async function securityLog(entry) {
  try {
    const store = await getStore('cd1-security-log');
    const key = 'log-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    await store.setJSON(key, { ...entry, at: new Date().toISOString() });
  } catch (_) {}
}

async function validateTechSession(token) {
  if (!token || token.length < 32) return null;
  const sessStore = await getStore('cd1-tech-sessions');
  const key = 'tsess-' + token.slice(0, 16);
  const s = await sessStore.get(key, { type: 'json' }).catch(() => null);
  if (!s || Date.now() > s.expiresAt) return null;
  if (!crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token))) return null;

  // Verify tech is still active
  const techStore = await getStore('cd1-tech-accounts');
  const tech = await techStore.get('tech-' + s.techId, { type: 'json' }).catch(() => null);
  if (!tech || !tech.active) return null;
  return s;
}

// Strip booking to operationally necessary fields only
function minimizeForTech(b) {
  const firstName = b.firstName || '';
  const lastInitial = (b.lastName || '').charAt(0);
  const customerName = lastInitial ? `${firstName} ${lastInitial}.` : firstName;

  return {
    id: b.id,
    customerName,
    phone: b.phone || '',
    address: b.address || '',
    zipCode: b.zipCode || '',
    preferredDate: b.preferredDate || '',
    preferredTime: b.preferredTime || '',
    confirmedDate: b.confirmedDate || '',
    confirmedTime: b.confirmedTime || '',
    confirmedTimeWindow: b.confirmedTimeWindow || '',
    vehicle: b.vehicleLabel || b.vehicle || b.vehicleCategory || '',
    package: b.package || b.service || '',
    addons: (b.addons || []).map(a => ({ name: a.name, qty: a.qty || 1 })),
    customerNote: b.customerNote || '',
    status: b.status || 'Pending Review',
    jobStatus: b.jobStatus || '',
    assignedTech: b.assignedTech || b.assignedTechName || '',
    techNotes: b.techNotes || '',
    zone: b.zone || '',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });

  const h = event.headers || {};
  const token = (h['x-tech-token'] || h['X-Tech-Token'] || '').trim();
  const session = await validateTechSession(token);
  if (!session) {
    await securityLog({ type: 'tech_jobs_unauthorized', ip: (h['x-forwarded-for'] || '').slice(0, 45) });
    return json(401, { ok: false, error: 'unauthorized' });
  }

  try {
    const store = await getStore('cd1-bookings');
    const listing = await store.list();
    const blobs = (listing && listing.blobs) || [];
    const all = (await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(Boolean);

    // Only return jobs assigned to this technician
    const techId = session.techId;
    const techName = session.techName;
    const assigned = all.filter(b => {
      if (b.isDraft || b.isTest || b.archived) return false;
      const at = (b.assignedTech || b.assignedTechName || '').toLowerCase();
      return at === techId.toLowerCase() || at === techName.toLowerCase();
    });

    // Sort by date, newest first
    assigned.sort((a, b) => String(b.preferredDate || '').localeCompare(String(a.preferredDate || '')));

    const jobs = assigned.map(minimizeForTech);
    return json(200, { ok: true, count: jobs.length, jobs });
  } catch (e) {
    return json(500, { ok: false, error: 'failed_to_load_jobs' });
  }
};
