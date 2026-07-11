/** Deterministic next-best-action — uses backend-synced Cardetail1UniversalStrategy. */
(function (global) {
  'use strict';

  var Strategy = global.Cardetail1UniversalStrategy;
  var SEG = Strategy && Strategy.SEGMENTS;

  function recommendNextAction(ctx) {
    ctx = ctx || {};
    if (!Strategy) {
      return { action: 'continue_standard_booking', reason: 'strategy_unavailable', routing: { standardBookingAllowed: true } };
    }
    var segment = ctx.segment || SEG.SINGLE_VEHICLE_NEW;
    var path = Strategy.getConversionPath(segment);
    var routing = Strategy.getRoutingControls(segment);
    var vehicleCount = Math.max(0, Number(ctx.vehicleCount || 0));
    var eligibleOffers = Strategy.getOfferEligibility(segment, { offersEnabled: !!ctx.offersEnabled });
    var categories = (ctx.assetCategories || []).map(function (c) { return String(c).toLowerCase(); });

    var base = {
      servicePath: path.servicePath,
      routing: routing,
      messaging: { headline: path.headline, subline: path.subline },
    };

    if (segment === SEG.COMMERCIAL_FLEET || vehicleCount >= 7) {
      return Object.assign({}, base, { action: 'route_fleet_quote', reason: 'commercial_or_fleet_scale', offer_id: null });
    }
    if (segment === SEG.MANUAL_REVIEW_OR_ALTERNATIVE_PATH) {
      return Object.assign({}, base, { action: 'route_manual_review', reason: 'operational_alternative_path', offer_id: null });
    }
    if (ctx.paymentStepReached) {
      return Object.assign({}, base, { action: 'immediate_high_intent_follow_up', reason: 'payment_step_reached', offer_id: null });
    }
    if (ctx.scheduleSelected && !ctx.paymentStepReached) {
      return Object.assign({}, base, { action: 'send_secure_resume_link', reason: 'schedule_without_payment', offer_id: null });
    }
    if (ctx.bookingSubmitted && Number(ctx.completedServices || 0) >= 2) {
      return Object.assign({}, base, { action: 'recommend_recurring_household_plan', reason: 'multiple_completed_services', offer_id: null });
    }
    if (ctx.bookingSubmitted || Number(ctx.completedServices || 0) >= 1 || segment === SEG.RETURNING_CUSTOMER) {
      return Object.assign({}, base, { action: 'recommend_maintenance_schedule', reason: 'returning_or_post_service', offer_id: null });
    }
    if (segment === SEG.RECURRING_MAINTENANCE_PROSPECT) {
      return Object.assign({}, base, { action: 'recommend_maintenance_schedule', reason: 'maintenance_interest_stated', offer_id: eligibleOffers[0] || null });
    }
    if (segment === SEG.SPECIALTY_ASSET_OWNER && vehicleCount <= 1) {
      return Object.assign({}, base, { action: 'recommend_specialty_booking', reason: 'specialty_asset_single', offer_id: eligibleOffers[0] || null });
    }
    if (vehicleCount >= 3) {
      return Object.assign({}, base, { action: 'recommend_full_garage_plan', reason: 'three_plus_vehicles', offer_id: eligibleOffers[0] || null, followUp: true });
    }
    if (vehicleCount === 2) {
      return Object.assign({}, base, {
        action: 'recommend_garage_pair_same_visit',
        reason: 'two_vehicle_household',
        offer_id: eligibleOffers.indexOf('multi_vehicle_same_visit') >= 0 ? 'multi_vehicle_same_visit' : null,
      });
    }
    if (categories.length >= 2) {
      return Object.assign({}, base, { action: 'recommend_multi_category_plan', reason: 'mixed_asset_categories', offer_id: null, quoteReview: true });
    }
    return Object.assign({}, base, {
      action: 'continue_standard_booking',
      reason: segment === SEG.SINGLE_VEHICLE_NEW ? 'new_single_vehicle_standard_path' : 'default_standard_path',
      offer_id: eligibleOffers.indexOf('first_booking_welcome') >= 0 ? 'first_booking_welcome' : null,
    });
  }

  global.Cardetail1NextBestAction = { recommendNextAction: recommendNextAction };
})(typeof window !== 'undefined' ? window : globalThis);
