/** Intent score, household value score, commercial priority — client-side deterministic scoring. */
(function (global) {
  'use strict';

  var INTENT_POINTS = {
    service_page_view: 5, package_view: 10, return_visit_7d: 10, zip_check_valid: 15,
    package_selected: 20, booking_started: 25, contact_captured: 30, vehicle_added: 10,
    schedule_selected: 20, payment_step_viewed: 35, payment_method_saved: 50, booking_submitted: 100,
  };

  function leadTemperature(score) {
    var s = Math.max(0, Number(score) || 0);
    if (s <= 19) return 'visitor';
    if (s <= 39) return 'interested';
    if (s <= 69) return 'warm';
    if (s <= 99) return 'hot';
    return 'converted';
  }

  function computeIntentScore(events) {
    var score = 0;
    var seen = {};
    (events || []).forEach(function (ev) {
      var name = String(ev.event || ev).trim();
      if (seen[name]) return;
      if (INTENT_POINTS[name] != null) { score += INTENT_POINTS[name]; seen[name] = 1; }
    });
    return score;
  }

  function computeHouseholdValueScore(ctx) {
    ctx = ctx || {};
    var score = 0;
    var explanations = [];
    var n = Math.max(0, Number(ctx.vehicleCount || 0));
    var cats = {};
    (ctx.assetCategories || []).forEach(function (c) { cats[String(c).toLowerCase()] = 1; });

    if (n >= 4) { score += 50; explanations.push('four_or_more_personal_vehicles:+50'); }
    else if (n === 3) { score += 35; explanations.push('three_personal_vehicles:+35'); }
    else if (n === 2) { score += 20; explanations.push('two_personal_vehicles:+20'); }
    if (Object.keys(cats).length >= 2) { score += 20; explanations.push('multi_category:+20'); }
    if (cats.boats || cats.boat || cats.rvs || cats.rv) { score += 20; explanations.push('boat_or_rv:+20'); }
    if (cats.powersports || cats.motorcycle || cats.atv) { score += 10; explanations.push('powersports:+10'); }
    if (ctx.sameLocationSameVisit) { score += 15; explanations.push('same_visit:+15'); }
    var m = String(ctx.maintenanceFrequency || '').toLowerCase();
    if (m === 'quarterly') { score += 25; explanations.push('quarterly_maintenance:+25'); }
    if (m === 'monthly' || m === 'bi-monthly' || m === 'bimonthly') { score += 35; explanations.push('monthly_maintenance:+35'); }
    var est = Number(ctx.estimatedValue || 0);
    if (est >= 1000) { score += 35; explanations.push('estimated_1000_plus:+35'); }
    else if (est >= 500) { score += 20; explanations.push('estimated_500_plus:+20'); }
    if (ctx.returningCustomer) { score += 15; explanations.push('returning:+15'); }
    return { score: score, explanations: explanations };
  }

  function commercialPriority(intentScore, householdValueScore, segment) {
    var intent = Math.max(0, Number(intentScore) || 0);
    var household = Math.max(0, Number(householdValueScore) || 0);
    var total = intent + household;
    var followUp = global.Cardetail1UniversalStrategy
      ? global.Cardetail1UniversalStrategy.followUpTier(intent, household, segment)
      : (intent >= 70 ? 'immediate' : intent >= 40 ? 'priority' : intent >= 20 ? 'scheduled' : 'nurture');
    var classification = 'standard_follow_up';
    if (followUp === 'immediate') classification = 'immediate_follow_up';
    else if (followUp === 'priority') classification = 'priority';
    else if (followUp === 'scheduled') classification = 'scheduled';
    else classification = 'nurture';
    return {
      score: total,
      classification: classification,
      follow_up_tier: followUp,
      intent_score: intent,
      household_value_score: household,
      is_growth_segment: household >= 20,
    };
  }

  global.Cardetail1LeadScore = {
    INTENT_POINTS: INTENT_POINTS,
    leadTemperature: leadTemperature,
    computeIntentScore: computeIntentScore,
    computeHouseholdValueScore: computeHouseholdValueScore,
    commercialPriority: commercialPriority,
  };
})(typeof window !== 'undefined' ? window : globalThis);
