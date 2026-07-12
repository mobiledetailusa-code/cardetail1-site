// POST /.netlify/functions/evaluate-booking-offer — server-authoritative WELCOME10 preview.

const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { applyServerTravelAndTotal } = require('../lib/travel-fee');
const { evaluateBookingOfferPreview, stripClientOfferFields } = require('../lib/booking-offers');

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'evaluate-booking-offer' });
  if (rateLimit.blocked) return rateLimit.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const booking = { ...body };
  stripClientOfferFields(booking);

  const travel = applyServerTravelAndTotal(booking, { skipMismatchCheck: true });
  if (!travel.ok) {
    return json(400, { ok: false, error: travel.error || 'invalid_booking' });
  }

  const preview = await evaluateBookingOfferPreview(booking, {
    sourceTrigger: body.sourceTrigger || body.offerSource || null,
  });

  return json(200, {
    ok: true,
    offer: preview.offer,
    serviceSubtotal: travel.serviceSubtotal,
    travelFee: booking.travelFeeAmount || 0,
    estimatedTotal: Math.max(
      0,
      Math.round(((travel.serviceSubtotal || 0) + (booking.travelFeeAmount || 0)
        - (preview.offer.discount_amount || 0) / 100) * 100) / 100
    ),
  });
};
