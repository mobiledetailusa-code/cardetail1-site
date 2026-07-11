// Intent score, household value score, and commercial priority (deterministic).

const INTENT_POINTS = Object.freeze({
  service_page_view: 5,
  package_view: 10,
  return_visit_7d: 10,
  zip_check_valid: 15,
  package_selected: 20,
  booking_started: 25,
  contact_captured: 30,
  vehicle_added: 10,
  schedule_selected: 20,
  payment_step_viewed: 35,
  payment_method_saved: 50,
  booking_submitted: 100,
});

const TEMPERATURE_BANDS = Object.freeze([
  { max: 19, label: 'visitor' },
  { max: 39, label: 'interested' },
  { max: 69, label: 'warm' },
  { max: 99, label: 'hot' },
  { max: Infinity, label: 'converted' },
]);

function leadTemperature(intentScore) {
  const score = Math.max(0, Number(intentScore) || 0);
  for (const band of TEMPERATURE_BANDS) {
    if (score <= band.max) return band.label;
  }
  return 'converted';
}

function computeIntentScore(events) {
  let score = 0;
  const seen = new Set();
  for (const ev of events || []) {
    const name = String(ev.event || ev).trim();
    if (seen.has(name)) continue;
    if (INTENT_POINTS[name] != null) {
      score += INTENT_POINTS[name];
      seen.add(name);
    }
  }
  if (events && events.some(e => e.return_visit_7d)) {
    score += INTENT_POINTS.return_visit_7d;
  }
  return score;
}

function computeHouseholdValueScore(ctx) {
  const input = ctx || {};
  let score = 0;
  const explanations = [];
  const vehicleCount = Math.max(0, Number(input.vehicleCount || 0));
  const categories = new Set((input.assetCategories || []).map(c => String(c).toLowerCase()));

  if (vehicleCount >= 4) { score += 50; explanations.push('four_or_more_personal_vehicles:+50'); }
  else if (vehicleCount === 3) { score += 35; explanations.push('three_personal_vehicles:+35'); }
  else if (vehicleCount === 2) { score += 20; explanations.push('two_personal_vehicles:+20'); }

  if (categories.size >= 2) { score += 20; explanations.push('multi_category:+20'); }
  if (categories.has('boats') || categories.has('boat') || categories.has('rvs') || categories.has('rv')) {
    score += 20; explanations.push('boat_or_rv:+20');
  }
  if (categories.has('powersports') || categories.has('motorcycle') || categories.has('atv')) {
    score += 10; explanations.push('powersports:+10');
  }
  if (input.sameLocationSameVisit === true) {
    score += 15; explanations.push('same_visit:+15');
  }
  const maint = String(input.maintenanceFrequency || '').toLowerCase();
  if (maint === 'quarterly') { score += 25; explanations.push('quarterly_maintenance:+25'); }
  if (maint === 'monthly' || maint === 'bi-monthly' || maint === 'bimonthly') {
    score += 35; explanations.push('monthly_maintenance:+35');
  }
  const est = Number(input.estimatedValue || 0);
  if (est >= 1000) { score += 35; explanations.push('estimated_1000_plus:+35'); }
  else if (est >= 500) { score += 20; explanations.push('estimated_500_plus:+20'); }
  if (input.returningCustomer === true) { score += 15; explanations.push('returning:+15'); }
  if (input.priorHighSatisfaction === true) { score += 15; explanations.push('prior_high_satisfaction:+15'); }

  return { score, explanations };
}

const { followUpTier } = require('./universal-customer-strategy');

function commercialPriority(intentScore, householdValueScore, segment) {
  const intent = Math.max(0, Number(intentScore) || 0);
  const household = Math.max(0, Number(householdValueScore) || 0);
  const total = intent + household;
  const tier = followUpTier(intent, household, segment);
  let classification = 'nurture';
  if (tier === 'immediate') classification = 'immediate_follow_up';
  else if (tier === 'priority') classification = 'priority';
  else if (tier === 'scheduled') classification = 'scheduled';
  return {
    score: total,
    classification,
    follow_up_tier: tier,
    intent_score: intent,
    household_value_score: household,
    is_growth_segment: household >= 20,
  };
}

module.exports = {
  INTENT_POINTS,
  leadTemperature,
  computeIntentScore,
  computeHouseholdValueScore,
  commercialPriority,
};
