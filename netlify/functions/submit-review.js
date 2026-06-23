// Customer job reviews — persisted to cd1-reviews, updates tech rating aggregate.
const { blobsStore, jsonCors, sanitizeText } = require('../lib/tech-security');
const { getBooking, normalizePhone, phonesMatch } = require('../lib/ops-db');
const { appendEventLog } = require('../lib/ops-workflow');

const REVIEWS_STORE = 'cd1-reviews';

function reviewId() {
  return 'REV-' + Date.now().toString(36).toUpperCase();
}

function updateTechRating(tech, stars) {
  const count = (tech.ratingCount || 0) + 1;
  const sum = (tech.ratingSum || 0) + stars;
  tech.ratingCount = count;
  tech.ratingSum = sum;
  tech.ratingAverage = Math.round((sum / count) * 10) / 10;
  return tech;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }
  const bookingId = sanitizeText(body.bookingId, 48);
  const phone = normalizePhone(body.phone || '');
  const stars = Math.min(5, Math.max(1, Math.round(Number(body.stars) || 0)));
  const comment = sanitizeText(body.comment, 2000);

  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });
  if (!phone || phone.length < 7) return jsonCors(400, { ok: false, error: 'phone_required' });
  if (!stars) return jsonCors(400, { ok: false, error: 'stars_required' });

  const booking = await getBooking(bookingId);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });

  const storedPhone = normalizePhone(booking.phone || '');
  if (!phonesMatch(phone, storedPhone)) {
    return jsonCors(403, { ok: false, error: 'verification_failed' });
  }

  const now = new Date().toISOString();
  const review = {
    id: reviewId(),
    bookingId,
    stars,
    comment,
    customerName: [booking.firstName, booking.lastName].filter(Boolean).join(' '),
    techId: booking.assignedTechId || booking.assignedTech || '',
    techName: booking.assignedTechName || '',
    status: 'pending_moderation',
    createdAt: now,
  };

  const revStore = await blobsStore(REVIEWS_STORE);
  await revStore.setJSON(review.id, review);

  const bookStore = await blobsStore('cd1-bookings');
  await bookStore.setJSON(bookingId, {
    ...booking,
    reviewLeft: true,
    reviewId: review.id,
    reviewStars: stars,
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'review_submitted', by: 'customer', stars }),
  });

  if (review.techId) {
    const techStore = await blobsStore('cd1-tech-accounts');
    const tech = await techStore.get('tech-' + review.techId, { type: 'json' }).catch(() => null);
    if (tech) {
      updateTechRating(tech, stars);
      if (stars === 1 && body.blockTechForCustomer) {
        tech.blockedCustomers = tech.blockedCustomers || [];
        const custKey = booking.email || phone;
        if (!tech.blockedCustomers.includes(custKey)) tech.blockedCustomers.push(custKey);
      }
      tech.updatedAt = now;
      await techStore.setJSON('tech-' + review.techId, tech);
    }
  }

  return jsonCors(200, { ok: true, reviewId: review.id, status: review.status });
};
