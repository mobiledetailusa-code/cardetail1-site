'use strict';

/**
 * Server-authoritative maintenance eligibility.
 * Based on completed-service history — not account age, membership, or saved card.
 */

const DEFAULT_RULES = {
  ruleVersion: 'maint-rules-v1',
  windows: {
    eligibleMaxDays: 45,
    recurringMaxDays: 90,
    graceMaxDays: 120,
  },
  requireCompletedInitialDetail: true,
  sameVehicleRequired: true,
  packageCompatibilityRequired: false,
  manualReviewInGrace: true,
  pricingTiers: {
    eligible: 'maintenance',
    recurring: 'recurring_maintenance',
    grace: 'standard_manual_review',
    expired: 'standard',
  },
};

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && (h.completedAtUtc || h.completedAt))
    .map((h) => ({
      completedAtUtc: h.completedAtUtc || h.completedAt,
      vehicleId: h.vehicleId || null,
      packageId: h.packageId || h.packId || null,
      bookingId: h.bookingId || null,
      status: h.status || 'completed',
    }))
    .filter((h) => String(h.status).toLowerCase() === 'completed')
    .sort((x, y) => String(y.completedAtUtc).localeCompare(String(x.completedAtUtc)));
}

function evaluateMaintenanceEligibility(input = {}) {
  const rules = { ...DEFAULT_RULES, ...(input.configuredRules || {}) };
  rules.windows = { ...DEFAULT_RULES.windows, ...(input.configuredRules?.windows || {}) };
  const requestedAtUtc = input.requestedAtUtc || input.requestedAppointmentAtUtc || new Date().toISOString();
  const history = normalizeHistory(input.completedServiceHistory);
  const membershipStatus = input.membershipStatus || 'none';

  if (!history.length) {
    return {
      eligible: false,
      reason: 'no_completed_service',
      pricingTier: rules.pricingTiers.expired,
      lastCompletedServiceAtUtc: null,
      daysSinceLastCompletedService: null,
      qualifyingVehicleId: null,
      qualifyingPackageId: null,
      membershipStatus,
      manualReviewRequired: false,
      ruleVersion: rules.ruleVersion,
    };
  }

  let candidate = history[0];
  if (rules.sameVehicleRequired && input.vehicleId) {
    candidate = history.find((h) => h.vehicleId && h.vehicleId === input.vehicleId) || null;
    if (!candidate) {
      return {
        eligible: false,
        reason: 'different_vehicle',
        pricingTier: rules.pricingTiers.expired,
        lastCompletedServiceAtUtc: history[0].completedAtUtc,
        daysSinceLastCompletedService: daysBetween(history[0].completedAtUtc, requestedAtUtc),
        qualifyingVehicleId: null,
        qualifyingPackageId: null,
        membershipStatus,
        manualReviewRequired: false,
        ruleVersion: rules.ruleVersion,
      };
    }
  }

  if (
    rules.packageCompatibilityRequired
    && input.requestedPackageId
    && candidate.packageId
    && candidate.packageId !== input.requestedPackageId
  ) {
    return {
      eligible: false,
      reason: 'incompatible_package',
      pricingTier: rules.pricingTiers.expired,
      lastCompletedServiceAtUtc: candidate.completedAtUtc,
      daysSinceLastCompletedService: daysBetween(candidate.completedAtUtc, requestedAtUtc),
      qualifyingVehicleId: candidate.vehicleId,
      qualifyingPackageId: candidate.packageId,
      membershipStatus,
      manualReviewRequired: true,
      ruleVersion: rules.ruleVersion,
    };
  }

  const days = daysBetween(candidate.completedAtUtc, requestedAtUtc);
  const { eligibleMaxDays, recurringMaxDays, graceMaxDays } = rules.windows;

  if (days != null && days <= eligibleMaxDays) {
    return {
      eligible: true,
      reason: 'eligible_recent_completed_service',
      pricingTier: rules.pricingTiers.eligible,
      lastCompletedServiceAtUtc: candidate.completedAtUtc,
      daysSinceLastCompletedService: days,
      qualifyingVehicleId: candidate.vehicleId,
      qualifyingPackageId: candidate.packageId,
      membershipStatus,
      manualReviewRequired: false,
      ruleVersion: rules.ruleVersion,
    };
  }

  if (days != null && days <= recurringMaxDays) {
    return {
      eligible: true,
      reason: 'eligible_recent_completed_service',
      pricingTier: rules.pricingTiers.recurring,
      lastCompletedServiceAtUtc: candidate.completedAtUtc,
      daysSinceLastCompletedService: days,
      qualifyingVehicleId: candidate.vehicleId,
      qualifyingPackageId: candidate.packageId,
      membershipStatus,
      manualReviewRequired: Boolean(rules.manualReviewInGrace),
      ruleVersion: rules.ruleVersion,
    };
  }

  if (days != null && days <= graceMaxDays) {
    return {
      eligible: false,
      reason: 'grace_period_manual_review',
      pricingTier: rules.pricingTiers.grace,
      lastCompletedServiceAtUtc: candidate.completedAtUtc,
      daysSinceLastCompletedService: days,
      qualifyingVehicleId: candidate.vehicleId,
      qualifyingPackageId: candidate.packageId,
      membershipStatus,
      note: membershipStatus === 'active' ? 'membership_active_standard_price' : undefined,
      manualReviewRequired: true,
      ruleVersion: rules.ruleVersion,
    };
  }

  return {
    eligible: false,
    reason: days == null ? 'no_completed_service' : 'outside_maintenance_window',
    pricingTier: rules.pricingTiers.expired,
    lastCompletedServiceAtUtc: candidate.completedAtUtc,
    daysSinceLastCompletedService: days,
    qualifyingVehicleId: candidate.vehicleId,
    qualifyingPackageId: candidate.packageId,
    membershipStatus,
    manualReviewRequired: false,
    ruleVersion: rules.ruleVersion,
    requalificationRequired: true,
  };
}

module.exports = {
  DEFAULT_RULES,
  evaluateMaintenanceEligibility,
  normalizeHistory,
  daysBetween,
};
