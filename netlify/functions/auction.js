// netlify/functions/auction.js
// Reverse-auction job board for technicians. One booking → one auction.
// Techs receive a per-job magic link by SMS, open it, and place a bid (their
// payout). Lowest bid wins automatically. Bids live in Netlify Blobs so every
// device sees the same auction. No npm deps — Node 18 fetch + crypto.
//
// Actions (POST JSON {action, ...} or GET ?action=...):
//   get   {job, tech, sig}            → tech view of one auction (job + lowest)
//   get   {job, adminKey}             → full admin view (all bids)
//   bid   {job, tech, sig, amount}    → place/update a bid; auto-awards lowest
//   list  {adminKey}                  → all auctions (admin)
//
// Env (Netlify): BID_SECRET (required, HMAC key for magic links),
//                ADMIN_DASH_PASSWORD (for admin actions).

const crypto = require('crypto');

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

function sign(jobId, techId, secret) {
  return crypto.createHmac('sha256', secret).update(String(jobId) + '|' + String(techId)).digest('hex');
}
function safeEq(a, b) {
  const ba = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function store() {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name: 'cd1-auctions', siteID, token }) : getStore('cd1-auctions');
}

// Recompute the winner = the lowest current bid.
function award(auction) {
  if (!auction.bids || !auction.bids.length) { auction.winner = null; return auction; }
  const low = auction.bids.reduce((m, b) => (b.amount < m.amount ? b : m), auction.bids[0]);
  auction.winner = { techId: low.techId, techName: low.techName, amount: low.amount };
  return auction;
}

// Tech-facing projection. Techs NEVER see the customer's total — only the job
// details and bid amounts (like nationaldetailpros). Also don't leak other
// techs' identities beyond the current lowest bid.
function techView(a, techId) {
  const mine = (a.bids || []).find(b => b.techId === techId);
  const j = a.job || {};
  return {
    jobId: a.jobId, status: a.status,
    job: { package: j.package, vehicle: j.vehicle, date: j.date, time: j.time, area: j.area }, // no `total`
    bidCount: (a.bids || []).length,
    lowest: a.winner ? a.winner.amount : null,
    youWin: !!(a.winner && a.winner.techId === techId),
    yourBid: mine ? mine.amount : null,
    checkedIn: !!(mine && mine.checkedInAt),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  const secret = process.env.BID_SECRET;
  if (!secret) return json(503, { ok: false, error: 'BID_SECRET not set on server' });

  let p = {};
  if (event.httpMethod === 'POST') { try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'bad json' }); } }
  else { p = event.queryStringParameters || {}; }

  const action = p.action || 'get';
  const adminKey = (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) || p.adminKey || '';
  const isAdmin = adminKey && process.env.ADMIN_DASH_PASSWORD && safeEq(adminKey, process.env.ADMIN_DASH_PASSWORD);

  try {
    const s = await store();

    if (action === 'list') {
      if (!isAdmin) return json(401, { ok: false, error: 'unauthorized' });
      const listing = await s.list();
      const blobs = (listing && listing.blobs) || [];
      const auctions = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)))).filter(Boolean);
      auctions.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return json(200, { ok: true, auctions });
    }

    const jobId = p.job;
    if (!jobId) return json(400, { ok: false, error: 'missing job' });
    const auction = await s.get(jobId, { type: 'json' });
    if (!auction) return json(404, { ok: false, error: 'auction not found' });

    if (action === 'get') {
      if (isAdmin) return json(200, { ok: true, auction });
      if (!safeEq(p.sig, sign(jobId, p.tech, secret))) return json(401, { ok: false, error: 'invalid link' });
      return json(200, { ok: true, auction: techView(auction, p.tech) });
    }

    if (action === 'bid') {
      if (!safeEq(p.sig, sign(jobId, p.tech, secret))) return json(401, { ok: false, error: 'invalid link' });
      if (auction.status !== 'open') return json(409, { ok: false, error: 'auction closed' });
      const amount = Math.round(Number(p.amount) * 100) / 100;
      if (!(amount > 0)) return json(400, { ok: false, error: 'invalid amount' });
      auction.bids = auction.bids || [];
      const existing = auction.bids.find(b => b.techId === p.tech);
      if (existing) { existing.amount = amount; existing.at = new Date().toISOString(); }
      else { auction.bids.push({ techId: p.tech, techName: p.techName || p.tech, amount, at: new Date().toISOString() }); }
      award(auction);
      await s.setJSON(jobId, auction);
      return json(200, { ok: true, ...techView(auction, p.tech) });
    }

    if (action === 'checkin') {
      if (!safeEq(p.sig, sign(jobId, p.tech, secret))) return json(401, { ok: false, error: 'invalid link' });
      const mine = (auction.bids || []).find(b => b.techId === p.tech);
      if (!mine) return json(409, { ok: false, error: 'no bid on this job' });
      if (!auction.winner || auction.winner.techId !== p.tech) return json(409, { ok: false, error: 'only the winning tech can check in' });
      mine.checkedInAt = new Date().toISOString();
      if (p.lat && p.lng) mine.checkin = { lat: p.lat, lng: p.lng };
      await s.setJSON(jobId, auction);
      return json(200, { ok: true, ...techView(auction, p.tech) });
    }

    return json(400, { ok: false, error: 'unknown action' });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};

// Exported for submit-booking.js to create an auction + sign magic links.
exports._sign = sign;
exports._store = store;
exports._award = award;
