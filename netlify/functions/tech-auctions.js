// Open auctions for logged-in technicians — portal bidding (no magic link required).
const { jsonCors, validateTechSession } = require('../lib/tech-security');
const { blobsStore } = require('../lib/tech-security');
const { getOpsSettings } = require('../lib/ops-config');
const { award } = require('../lib/auction-ops');

function techAuctionView(a, techId) {
  const mine = (a.bids || []).find(b => b.techId === techId);
  const j = a.job || {};
  const closesAt = a.closesAt ? new Date(a.closesAt) : null;
  const expired = closesAt && closesAt < new Date();
  return {
    jobId: a.jobId,
    status: expired && a.status === 'open' ? 'expired' : a.status,
    job: {
      package: j.package,
      vehicle: j.vehicle,
      date: j.date,
      time: j.time,
      area: j.area,
      addons: j.addons || [],
      serviceNotes: j.serviceNotes || '',
    },
    bidMax: a.bidMax,
    closesAt: a.closesAt,
    bidCount: (a.bids || []).length,
    lowest: a.winner ? a.winner.amount : null,
    youWin: !!(a.winner && a.winner.techId === techId),
    yourBid: mine ? mine.amount : null,
    bidWindowMinutes: a.bidWindowMinutes,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const session = await validateTechSession(event.headers || {});
  if (!session) return jsonCors(401, { ok: false, error: 'invalid_session' });

  const tech = session.tech;
  const techId = tech.techId || tech.id;
  const techName = tech.fullName || tech.name || techId;
  const settings = await getOpsSettings();

  if ((tech.ratingAverage || 5) < (settings.minTechRatingToBid || 0) && (tech.ratingCount || 0) > 0) {
    return jsonCors(403, { ok: false, error: 'rating_too_low_to_bid' });
  }

  const ob = tech.onboarding || {};
  if (!ob.completed) {
    return jsonCors(403, { ok: false, error: 'onboarding_required' });
  }

  const aucStore = await blobsStore('cd1-auctions');

  if (event.httpMethod === 'GET' || (event.httpMethod === 'POST' && !event.body)) {
    const listing = await aucStore.list().catch(() => ({ blobs: [] }));
    const auctions = (await Promise.all(
      ((listing && listing.blobs) || []).map(b => aucStore.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(a => a && a.status === 'open');
    auctions.sort((a, b) => String(b.postedAt || b.createdAt).localeCompare(String(a.postedAt || a.createdAt)));
    return jsonCors(200, {
      ok: true,
      auctions: auctions.map(a => techAuctionView(a, techId)),
      bidDisclaimer: 'Lowest bid wins when the window closes. Rating and acceptance history also matter for repeat customers.',
    });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || 'bid');
  const jobId = String(body.jobId || body.job || '').trim();
  if (!jobId) return jsonCors(400, { ok: false, error: 'jobId_required' });

  const auction = await aucStore.get(jobId, { type: 'json' }).catch(() => null);
  if (!auction) return jsonCors(404, { ok: false, error: 'auction_not_found' });
  if (auction.status !== 'open') return jsonCors(409, { ok: false, error: 'auction_closed' });

  if (auction.closesAt && new Date(auction.closesAt) < new Date()) {
    auction.status = 'expired';
    await aucStore.setJSON(jobId, auction);
    return jsonCors(409, { ok: false, error: 'bid_window_closed' });
  }

  if (action === 'bid') {
    const amount = Math.round(Number(body.amount) * 100) / 100;
    if (!(amount > 0)) return jsonCors(400, { ok: false, error: 'invalid_amount' });
    if (auction.bidMax != null && amount > auction.bidMax) {
      return jsonCors(400, {
        ok: false,
        error: 'bid_exceeds_max',
        bidMax: auction.bidMax,
        userMessage: `Bid cannot exceed $${auction.bidMax} (admin payout cap).`,
      });
    }

    const hay = [auction.job && auction.job.package, auction.job && auction.job.vehicle].join(' ').toLowerCase();
    if (/boat|rv|motorhome|trailer/.test(hay) && !ob.hasOwnLadder) {
      return jsonCors(400, { ok: false, error: 'ladder_required', userMessage: 'Boat/RV jobs require your own ladder on profile.' });
    }
    if (/compound|correction|polish/.test(hay) && settings.requireCompoundExperience && !(ob.experience && ob.experience.compound)) {
      return jsonCors(400, { ok: false, error: 'compound_experience_required' });
    }

    auction.bids = auction.bids || [];
    const existing = auction.bids.find(b => b.techId === techId);
    if (existing) {
      existing.amount = amount;
      existing.at = new Date().toISOString();
      existing.techName = techName;
    } else {
      auction.bids.push({
        techId, techName, amount,
        at: new Date().toISOString(),
        source: 'portal',
      });
    }
    award(auction);
    await aucStore.setJSON(jobId, auction);
    return jsonCors(200, { ok: true, ...techAuctionView(auction, techId) });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};
