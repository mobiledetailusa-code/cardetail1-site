// Customer-facing feature flags — disabled features must not render as actionable controls.

function flag(name, defaultValue = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function getCustomerFeatureFlags() {
  return {
    giftCards: flag('CUSTOMER_GIFT_CARDS_ENABLED', false),
    subscriptions: flag('CUSTOMER_SUBSCRIPTIONS_ENABLED', false),
    flexiblePayments: flag('CUSTOMER_FLEXIBLE_PAYMENTS_ENABLED', false),
    reviews: flag('CUSTOMER_REVIEWS_ENABLED', false),
  };
}

function flagsForPortalResponse() {
  const f = getCustomerFeatureFlags();
  return {
    giftCardsEnabled: f.giftCards,
    subscriptionsEnabled: f.subscriptions,
    flexiblePaymentsEnabled: f.flexiblePayments,
    reviewsEnabled: f.reviews,
  };
}

module.exports = {
  getCustomerFeatureFlags,
  flagsForPortalResponse,
};
