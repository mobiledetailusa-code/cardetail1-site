// Deterministic next-best-action — universal paths with explicit routing controls.

const { SEGMENTS } = require('./revenue-segments');
const { getConversionPath, getRoutingControls, getOfferEligibility } = require('./universal-customer-strategy');

function recommendNextAction(ctx) {
  const input = ctx || {};
  const segment = input.segment || SEGMENTS.SINGLE_VEHICLE_NEW;
  const path = getConversionPath(segment);
  const routing = getRoutingControls(segment);
  const vehicleCount = Math.max(0, Number(input.vehicleCount || 0));
  const paymentStepReached = !!input.paymentStepReached;
  const scheduleSelected = !!input.scheduleSelected;
  const bookingSubmitted = !!input.bookingSubmitted;
  const completedServices = Math.max(0, Number(input.completedServices || 0));
  const offersEnabled = !!input.offersEnabled;
  const eligibleOffers = getOfferEligibility(segment, { offersEnabled });
  const categories = new Set((input.assetCategories || []).map(c => String(c).toLowerCase()));

  const base = {
    servicePath: path.servicePath,
    routing,
    messaging: { headline: path.headline, subline: path.subline },
  };

  if (segment === SEGMENTS.COMMERCIAL_FLEET || vehicleCount >= 7) {
    return { ...base, action: 'route_fleet_quote', reason: 'commercial_or_fleet_scale', offer_id: null };
  }

  if (segment === SEGMENTS.MANUAL_REVIEW_OR_ALTERNATIVE_PATH) {
    return { ...base, action: 'route_manual_review', reason: 'operational_alternative_path', offer_id: null };
  }

  if (paymentStepReached) {
    return { ...base, action: 'immediate_high_intent_follow_up', reason: 'payment_step_reached', offer_id: null };
  }
  if (scheduleSelected && !paymentStepReached) {
    return { ...base, action: 'send_secure_resume_link', reason: 'schedule_without_payment', offer_id: null };
  }

  if (bookingSubmitted && completedServices >= 2) {
    return { ...base, action: 'recommend_recurring_household_plan', reason: 'multiple_completed_services', offer_id: null };
  }
  if (bookingSubmitted || completedServices >= 1 || segment === SEGMENTS.RETURNING_CUSTOMER) {
    return { ...base, action: 'recommend_maintenance_schedule', reason: 'returning_or_post_service', offer_id: null };
  }
  if (segment === SEGMENTS.RECURRING_MAINTENANCE_PROSPECT) {
    return { ...base, action: 'recommend_maintenance_schedule', reason: 'maintenance_interest_stated', offer_id: eligibleOffers[0] || null };
  }
  if (segment === SEGMENTS.SPECIALTY_ASSET_OWNER && vehicleCount <= 1) {
    return { ...base, action: 'recommend_specialty_booking', reason: 'specialty_asset_single', offer_id: eligibleOffers[0] || null };
  }
  if (vehicleCount >= 3) {
    return { ...base, action: 'recommend_full_garage_plan', reason: 'three_plus_vehicles', offer_id: eligibleOffers[0] || null, followUp: true };
  }
  if (vehicleCount === 2) {
    return {
      ...base,
      action: 'recommend_garage_pair_same_visit',
      reason: 'two_vehicle_household',
      offer_id: eligibleOffers.indexOf('multi_vehicle_same_visit') >= 0 ? 'multi_vehicle_same_visit' : null,
    };
  }
  if (categories.size >= 2) {
    return { ...base, action: 'recommend_multi_category_plan', reason: 'mixed_asset_categories', offer_id: null, quoteReview: true };
  }

  return {
    ...base,
    action: 'continue_standard_booking',
    reason: segment === SEGMENTS.SINGLE_VEHICLE_NEW ? 'new_single_vehicle_standard_path' : 'default_standard_path',
    offer_id: eligibleOffers.indexOf('first_booking_welcome') >= 0 ? 'first_booking_welcome' : null,
  };
}

module.exports = { recommendNextAction };
