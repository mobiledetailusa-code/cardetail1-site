'use strict';

/**
 * Membership foundation — access-fee plan config (staging proposal).
 * Does NOT create Stripe Products, Prices, or live Subscriptions.
 * Distinct from service-subscription (monthly detailing entitlement).
 */

const PRIORITY_MEMBERSHIP_PLAN = {
  planId: 'dz-priority-membership-v1',
  planName: 'Detailing Zone Priority Membership',
  planType: 'priority_membership',
  billingModel: 'access_fee',
  billingInterval: 'month',
  interval: 'month',
  priceCents: 999,
  currency: 'USD',
  active: true,
  includedDetailingCount: 0,
  automaticMaintenancePricing: false,
  benefits: {
    priorityScheduling: true,
    earlyAccess: true,
    cancellationWaitlistPriority: true,
    selectedReschedulingFlexibility: true,
    selectedMemberCommunication: true,
    selectedBookingWindows: true,
    futureEarnedAddonCredit: false,
    futureLoyaltyBenefits: false,
  },
  exclusions: {
    freeDetailing: true,
    guaranteedSameDay: false,
    automaticMaintenancePricing: false,
    unlimitedRescheduling: false,
    unlimitedDiscounts: false,
    priorityOverConfirmedAppointments: false,
    waivedTravelCharges: false,
    waivedMarketZoneAdjustments: false,
  },
  priorityLevel: 1,
  gracePeriodDays: 7,
  trialPolicy: 'none',
  cancellationPolicy: 'end_of_period',
  renewalPolicy: 'manual_or_future_billing',
  serviceEntitlements: [],
  addOnCredits: [],
  maintenancePriceRelationship: 'none',
  minimumCommitmentMonths: 0,
  ruleVersion: 'membership-plan-v1',
  liveStripeBillingEnabled: false,
};

const BILLING_MODELS = Object.freeze({
  ACCESS_FEE: 'access_fee',
  SERVICE_SUBSCRIPTION: 'service_subscription',
  PREPAID_BUNDLE: 'prepaid_bundle',
  MAINTENANCE_PRICING: 'maintenance_pricing',
});

function defaultMembershipDraftPayload() {
  return {
    siteId: 'detailing-zone',
    maintenanceRules: {
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
    },
    membershipPlans: [PRIORITY_MEMBERSHIP_PLAN],
    simulatorAssumptions: {
      membersAt25: 25,
      membersAt50: 50,
      membersAt100: 100,
      expectedServiceFrequencyPerYear: 4,
      benefitCostCentsPerMemberMonth: 150,
      addonCreditExposureCentsPerMemberMonth: 50,
    },
  };
}

function assertNoLiveMembershipBilling({ appEnv, allowLiveBilling } = {}) {
  const env = String(appEnv || process.env.APP_ENV || process.env.CONTEXT || '').toLowerCase();
  const isProd = env === 'production' || env === 'prod';
  if (allowLiveBilling === true && !isProd) {
    return { ok: true };
  }
  if (isProd || allowLiveBilling !== true) {
    return {
      ok: false,
      error: 'membership_live_billing_denied',
      message: 'Live membership billing is disabled. Access-fee plans are configuration-only in this stage.',
      statusCode: 403,
    };
  }
  return { ok: true };
}

function simulateMembershipRevenue(assumptions = {}, plan = PRIORITY_MEMBERSHIP_PLAN) {
  const price = Math.max(0, Math.round(Number(plan.priceCents) || 999));
  const benefit = Math.max(0, Math.round(Number(assumptions.benefitCostCentsPerMemberMonth) || 0));
  const credit = Math.max(0, Math.round(Number(assumptions.addonCreditExposureCentsPerMemberMonth) || 0));
  const scenarios = [25, 50, 100].map((n) => {
    const members = Math.round(Number(assumptions[`membersAt${n}`]) || n);
    const gross = members * price;
    const net = gross - members * (benefit + credit);
    return {
      members,
      monthlyGrossCents: gross,
      monthlyNetCents: net,
      annualGrossCents: gross * 12,
      annualNetCents: net * 12,
      disclaimer: 'Assumption-based estimate only — not a forecast guarantee.',
    };
  });
  return {
    planId: plan.planId,
    billingModel: plan.billingModel,
    priceCents: price,
    currency: plan.currency || 'USD',
    scenarios,
  };
}

module.exports = {
  PRIORITY_MEMBERSHIP_PLAN,
  BILLING_MODELS,
  defaultMembershipDraftPayload,
  assertNoLiveMembershipBilling,
  simulateMembershipRevenue,
};
