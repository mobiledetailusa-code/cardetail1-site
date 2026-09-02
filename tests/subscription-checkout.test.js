const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  rejectClientPriceFields,
  verifyCustomer,
  resolveMonthlyCents,
  stripePriceEnvKey,
  buildCheckoutLineItemParams,
} = require('../netlify/lib/subscription-checkout');

describe('subscription-checkout', () => {
  it('rejects client-submitted price fields', () => {
    assert.deepEqual(rejectClientPriceFields({ packId: 'maint' }), { ok: true });
    const bad = rejectClientPriceFields({ monthlyPrice: 157.5 });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'client_price_not_allowed');
    assert.equal(bad.field, 'monthlyPrice');
  });

  it('verifyCustomer requires email and phone', () => {
    assert.equal(verifyCustomer({ email: 'a@b.com', phone: '2015550177' }).ok, true);
    assert.equal(verifyCustomer({ email: 'bad', phone: '2015550177' }).error, 'valid_email_required');
    assert.equal(verifyCustomer({ email: 'a@b.com', phone: '123' }).error, 'phone_required');
  });

  it('resolveMonthlyCents applies 10% discount', () => {
    const p = resolveMonthlyCents('maint', null);
    assert.equal(p.dollars, 157.5);
    assert.equal(p.cents, 15750);
  });

  it('resolveMonthlyCents supports fleet plans', () => {
    const p = resolveMonthlyCents('maint', 'fleet-2');
    assert.equal(p.dollars, 289.8);
    assert.equal(p.fleet.id, 'fleet-2');
  });

  it('stripePriceEnvKey maps pack and fleet to env var names', () => {
    assert.equal(stripePriceEnvKey('maint', null), 'STRIPE_PRICE_SUB_MAINT');
    assert.equal(stripePriceEnvKey('full', 'fleet-3'), 'STRIPE_PRICE_SUB_FLEET_3_FULL');
  });

  it('buildCheckoutLineItemParams uses price id when configured', () => {
    const pricing = resolveMonthlyCents('maint', null);
    const dynamic = buildCheckoutLineItemParams(pricing, 'maint', null, 'Maintenance · Monthly', null);
    assert.equal(dynamic['line_items[0][price_data][unit_amount]'], '15750');
    const env = buildCheckoutLineItemParams(pricing, 'maint', null, 'Maintenance · Monthly', 'price_test123');
    assert.equal(env['line_items[0][price]'], 'price_test123');
    assert.equal(env['line_items[0][quantity]'], '1');
  });
});
