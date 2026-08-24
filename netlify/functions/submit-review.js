/**
 * Customer job review.
 *
 * Authorization goes through the same booking-ownership authority the rest of
 * the portal uses (an account session scoped to the booking, or bookingId plus
 * the phone on file). A booking id alone has never been sufficient and is not
 * sufficient here — a review is attributable, public-facing content.
 *
 * Eligibility is decided on the server: one review per *completed* booking. The
 * browser does not get to assert that a job is finished, and it cannot replay a
 * second review by re-posting.
 */

const { blobsStore, jsonCors, sanitizeText } = require('../lib/tech-security');
const { authorizeBookingAccess } = require('../lib/booking-customer-auth');
const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { appendEventLog } = require('../lib/ops-workflow');
const { auditEntry, appendAudit } = require('../lib/operations-audit');
const { setBookingStoreOverride, getBookingRecord, commitBooking } = require('../lib/booking-repository');
const { buildNextAggregate } = require('../lib/booking-aggregate');
const { evaluateReviewSubmission, postServiceState } = require('../lib/post-service-experience');
const firstPartyReviews = require('../lib/first-party-reviews');

const REVIEWS_STORE = firstPartyReviews.REVIEWS_STORE;

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

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'submit-review', cors: true });
  if (rateLimit.blocked) return rateLimit.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const auth = await authorizeBookingAccess(event, {
    bookingId: body.bookingId,
    phone: body.phone || body.customerPhone,
  });
  if (!auth.ok) {
    return jsonCors(auth.statusCode || 403, {
      ok: false,
      error: auth.error || 'verification_failed',
      message: auth.message,
    });
  }

  const booking = auth.booking;
  const bookingId = String(booking.id || booking.bookingId || '');
  if (!isVisibleSubmittedBooking(booking)) {
    return jsonCors(404, { ok: false, error: 'booking_not_found' });
  }

  const gate = evaluateReviewSubmission(booking, { stars: body.stars, comment: body.comment });
  if (!gate.ok) {
    return jsonCors(gate.statusCode || 409, {
      ok: false,
      error: gate.error,
      message: gate.message,
      postService: gate.state,
    });
  }

  const now = new Date().toISOString();
  const comment = sanitizeText(gate.comment, 2000);
  const status = firstPartyReviews.publishStatus({ stars: gate.stars, comment });
  const review = {
    id: reviewId(),
    bookingId,
    stars: gate.stars,
    comment,
    customerName: [booking.firstName, booking.lastName].filter(Boolean).join(' '),
    displayName: firstPartyReviews.displayName(booking.firstName, booking.lastName, ''),
    location: firstPartyReviews.locationLabel(booking),
    service: firstPartyReviews.serviceLabel(booking),
    techId: booking.assignedTechId || booking.assignedTech || '',
    techName: booking.assignedTechName || '',
    // Owner may hide a published card, but never edits the customer's rating or words.
    status,
    ownerResponse: null,
    source: 'customer_portal',
    createdAt: now,
  };

  const store = await blobsStore('cd1-bookings');
  setBookingStoreOverride(store);

  // Re-read under the write authority and re-check eligibility, so two taps that
  // both passed the gate above still produce exactly one review.
  const rec = await getBookingRecord(bookingId);
  const current = rec.exists ? rec.booking : booking;
  const recheck = evaluateReviewSubmission(current, { stars: gate.stars, comment: gate.comment });
  if (!recheck.ok) {
    return jsonCors(recheck.statusCode || 409, {
      ok: false,
      error: recheck.error,
      message: recheck.message,
      postService: recheck.state,
    });
  }

  const next = buildNextAggregate(current, {
    review: {
      reviewId: review.id,
      stars: review.stars,
      submittedAt: now,
      status: review.status,
    },
    reviewLeft: true,
    reviewId: review.id,
    reviewStars: review.stars,
    reviewSubmittedAt: now,
    updatedAt: now,
    eventLog: appendEventLog(current, { action: 'review_submitted', by: 'customer', stars: review.stars }),
  });

  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: Math.round(Number(current.bookingVersion) || 0),
    nextAggregate: next,
  });
  if (!committed.ok) {
    return jsonCors(committed.statusCode || 409, {
      ok: false,
      error: committed.error || 'version_conflict',
      message: 'This appointment changed while you were writing. Reload and try again.',
    });
  }

  // The booking is the authority for "a review exists". The reviews store and
  // the technician rating are downstream projections — a failure there must not
  // let the customer submit a second review.
  try {
    const revStore = await blobsStore(REVIEWS_STORE);
    await revStore.setJSON(review.id, review);
    if (review.status === 'approved') {
      const card = firstPartyReviews.cardFromBookingReview(review, booking);
      if (card) await firstPartyReviews.publishToHomepage(revStore, card);
    } else {
      await firstPartyReviews.enqueueModeration(revStore, review.id);
    }
  } catch (e) {
    console.warn('[submit-review] review store write failed:', e.message);
  }

  if (review.techId) {
    try {
      const techStore = await blobsStore('cd1-tech-accounts');
      const tech = await techStore.get('tech-' + review.techId, { type: 'json' }).catch(() => null);
      if (tech) {
        updateTechRating(tech, review.stars);
        if (review.stars === 1 && body.blockTechForCustomer) {
          tech.blockedCustomers = tech.blockedCustomers || [];
          const custKey = booking.email || booking.phone;
          if (custKey && !tech.blockedCustomers.includes(custKey)) tech.blockedCustomers.push(custKey);
        }
        tech.updatedAt = now;
        await techStore.setJSON('tech-' + review.techId, tech);
      }
    } catch (e) {
      console.warn('[submit-review] tech rating update failed:', e.message);
    }
  }

  await appendAudit(auditEntry({
    bookingId,
    actorType: 'customer',
    actorId: auth.scope === 'session' ? 'session' : 'booking_lookup',
    action: 'review_submitted',
    previousState: current,
    resultingState: committed.booking,
    reason: `stars=${review.stars}`,
    sourcePortal: 'customer',
  })).catch(() => null);

  return jsonCors(200, {
    ok: true,
    reviewId: review.id,
    status: review.status,
    published: review.status === 'approved',
    bookingVersion: committed.bookingVersion,
    postService: postServiceState(committed.booking),
  });
};
