// Auction dispatch integrated with cd1-tech-accounts (unified roster).
const crypto = require('crypto');
const { blobsStore } = require('./tech-security');
const { getOpsSettings, calcBidMax, bidWindowForJob } = require('./ops-config');
const { appendEventLog } = require('./ops-workflow');

function signBid(jobId, techId, secret) {
  return crypto.createHmac('sha256', secret).update(String(jobId) + '|' + String(techId)).digest('hex');
}

function award(auction) {
  if (!auction.bids || !auction.bids.length) { auction.winner = null; return auction; }
  const low = auction.bids.reduce((m, b) => (b.amount < m.amount ? b : m), auction.bids[0]);
  auction.winner = { techId: low.techId, techName: low.techName, amount: low.amount };
  return auction;
}

async function listActiveTechAccounts() {
  const store = await blobsStore('cd1-tech-accounts');
  const listing = await store.list().catch(() => ({ blobs: [] }));
  const out = [];
  for (const b of ((listing && listing.blobs) || [])) {
    if (!b.key.startsWith('tech-')) continue;
    const t = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (t && t.active) out.push(t);
  }
  return out;
}

async function syncTechRosterFromAccounts() {
  const techs = await listActiveTechAccounts();
  const roster = techs
    .filter(t => String(t.phone || '').replace(/\D/g, '').length >= 10)
    .map(t => ({
      id: t.techId || t.id,
      name: t.fullName || t.name || '',
      phone: String(t.phone || '').replace(/\D/g, ''),
      email: t.email || '',
    }));
  const store = await blobsStore('cd1-techs');
  await store.setJSON('roster', roster);
  return { count: roster.length, roster };
}

async function createAuctionForBooking(booking, options = {}) {
  const secret = process.env.BID_SECRET;
  if (!secret) return { ok: false, error: 'BID_SECRET not set' };

  const jobId = booking.id;
  const aucStore = await blobsStore('cd1-auctions');
  const existing = await aucStore.get(jobId, { type: 'json' }).catch(() => null);
  if (existing && existing.status === 'open') return { ok: true, alreadyExists: true, auction: existing };

  const settings = await getOpsSettings();
  const customerTotal = booking.totalPrice || booking.finalAmount || 0;
  const bidMax = calcBidMax(customerTotal, settings);
  const windowMin = bidWindowForJob(booking, settings);
  const now = new Date();
  const closesAt = new Date(now.getTime() + windowMin * 60 * 1000).toISOString();

  const job = {
    package: booking.package || booking.service || '',
    vehicle: booking.vehicleLabel || booking.vehicle || booking.vehicleCategory || '',
    date: booking.confirmedDate || booking.preferredDate || '',
    time: booking.confirmedTime || booking.preferredTime || booking.confirmedTimeWindow || '',
    area: booking.zone || booking.zipCode || '',
    total: customerTotal,
    addons: (booking.addons || []).map(a => a.name || a).filter(Boolean),
    serviceNotes: booking.customerNote || '',
  };

  const auction = {
    jobId,
    status: 'open',
    job,
    bids: existing && existing.bids ? existing.bids : [],
    winner: null,
    bidMax,
    bidMaxPercent: settings.bidMaxPercent != null ? settings.bidMaxPercent : 62,
    bidWindowMinutes: windowMin,
    closesAt,
    createdAt: existing && existing.createdAt ? existing.createdAt : now.toISOString(),
    postedAt: now.toISOString(),
    paymentStatus: booking.paymentStatus || 'no_payment_required_yet',
    amountAuthorizedCents: booking.amountAuthorizedCents || 0,
    notifyEmail: options.notifyEmail !== false,
    notifySms: options.notifySms !== false,
  };
  award(auction);
  await aucStore.setJSON(jobId, auction);

  const rosterSync = await syncTechRosterFromAccounts();
  const roster = rosterSync.roster || [];
  const base = process.env.SITE_URL || '';
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, RESEND_API_KEY, RESEND_FROM, ADMIN_EMAIL } = process.env;

  let notifiedSms = 0;
  let notifiedEmail = 0;

  if (options.notifySms !== false && TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM && base && roster.length) {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    await Promise.all(roster.map(t => {
      const sig = signBid(jobId, t.id, secret);
      const portalLink = `${base}/technician.html?portal=tech`;
      const bidLink = `${base}/bid.html?job=${encodeURIComponent(jobId)}&tech=${encodeURIComponent(t.id)}&sig=${sig}`;
      const body = new URLSearchParams({
        To: t.phone, From: TWILIO_FROM,
        Body: `Cardetail1 job: ${job.package} · ${job.date} · ${job.area}. Bid in portal or: ${bidLink}`,
      });
      return fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }).then(r => { if (r.ok) notifiedSms++; }).catch(() => {});
    }));
  }

  if (options.notifyEmail !== false && RESEND_API_KEY && roster.length) {
    await Promise.all(roster.filter(t => t.email).map(t => {
      const sig = signBid(jobId, t.id, secret);
      const bidLink = `${base}/bid.html?job=${encodeURIComponent(jobId)}&tech=${encodeURIComponent(t.id)}&sig=${sig}`;
      return fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
          to: [t.email],
          subject: `New Cardetail1 job — place your bid · ${jobId}`,
          text: `New job available.\n\n${job.package} · ${job.vehicle}\n${job.date} ${job.time}\n${job.area}\n\nBid window: ${windowMin} minutes.\nPortal: ${base}/technician.html?portal=tech\nDirect bid: ${bidLink}\n\nLowest bid wins. You are not required to bid.`,
        }),
      }).then(r => { if (r.ok) notifiedEmail++; }).catch(() => {});
    }));
  }

  if (ADMIN_EMAIL && RESEND_API_KEY && options.notifyAdmin !== false) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [ADMIN_EMAIL],
        subject: `Auction posted · ${jobId}`,
        text: `Auction open for ${jobId}\nBid max: ${bidMax != null ? '$' + bidMax : 'n/a'}\nCloses: ${closesAt}\nTechs notified: SMS ${notifiedSms}, email ${notifiedEmail}`,
      }),
    }).catch(() => {});
  }

  return {
    ok: true,
    auction,
    rosterCount: roster.length,
    notifiedSms,
    notifiedEmail,
    bidMax,
    closesAt,
  };
}

async function assignAuctionWinnerToBooking(jobId, adminNote) {
  const aucStore = await blobsStore('cd1-auctions');
  const auction = await aucStore.get(jobId, { type: 'json' }).catch(() => null);
  if (!auction) return { ok: false, error: 'auction_not_found' };
  if (!auction.winner || !auction.winner.techId) {
    return { ok: false, error: 'no_winning_bid' };
  }

  const techStore = await blobsStore('cd1-tech-accounts');
  const tech = await techStore.get('tech-' + auction.winner.techId, { type: 'json' }).catch(() => null);
  const techName = tech ? (tech.fullName || tech.name) : auction.winner.techName;
  const now = new Date().toISOString();

  const bookStore = await blobsStore('cd1-bookings');
  const booking = await bookStore.get(jobId, { type: 'json' }).catch(() => null);
  if (!booking) return { ok: false, error: 'booking_not_found' };

  const patchedBooking = {
    ...booking,
    assignedTechId: auction.winner.techId,
    assignedTech: auction.winner.techId,
    assignedTechName: techName,
    assignedAt: now,
    techPayoutAmount: auction.winner.amount,
    jobStatus: 'assigned',
    status: 'Scheduled',
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'auction_winner_assigned',
      by: 'admin',
      techId: auction.winner.techId,
      techName,
      bidAmount: auction.winner.amount,
      note: adminNote || '',
    }),
  };
  await bookStore.setJSON(jobId, patchedBooking);

  auction.status = 'assigned';
  auction.assignedAt = now;
  auction.assignedTechId = auction.winner.techId;
  await aucStore.setJSON(jobId, auction);

  return { ok: true, bookingId: jobId, techId: auction.winner.techId, techName, bidAmount: auction.winner.amount };
}

module.exports = {
  signBid,
  award,
  syncTechRosterFromAccounts,
  createAuctionForBooking,
  assignAuctionWinnerToBooking,
  listActiveTechAccounts,
};
