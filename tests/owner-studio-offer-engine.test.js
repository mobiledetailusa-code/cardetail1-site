'use strict';

/**
 * Offers stage O1 — resolution engine.
 *
 * Nothing reads this engine yet. These tests are the contract it will be held to
 * when stage O2 runs it in shadow mode beside the existing booking-offers.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveOffers, validateOffer, eligibleBaseCents, percentOf,
} = require('../netlify/lib/owner-studio/offers/offer-engine');

const NOW = '2026-08-12T12:00:00.000Z';

function offer(over = {}) {
  return Object.assign({
    offerId: 'off_welcome',
    offerVersion: 'v1',
    name: 'Welcome 10%',
    kind: 'percent',
    percentBps: 1000,
    appliesTo: 'order_subtotal',
    trigger: 'automatic',
    active: true,
  }, over);
}

function ctx(over = {}) {
  return Object.assign({
    subtotalCents: 24000,
    nowIso: NOW,
    customerIdentityKey: 'cust_1',
    lines: [
      { packageId: 'pkg_full', category: 'cars', amountCents: 20000 },
      { addOnId: 'addon_ozone', category: 'cars', amountCents: 4000 },
    ],
  }, over);
}

const run = (offers, over = {}) => resolveOffers(Object.assign({ offers, context: ctx() }, over));

describe('money is integer cents and basis points', () => {
  it('rounds a percent half up on the cent', () => {
    assert.equal(percentOf(1, 2000), 0);       // 0.2 -> 0
    assert.equal(percentOf(3, 2000), 1);       // 0.6 -> 1
    assert.equal(percentOf(24000, 1000), 2400);
    assert.equal(percentOf(999, 3333), 333);   // 332.97 -> 333
  });

  it('never returns more than the base', () => {
    assert.equal(percentOf(500, 10000), 500);
  });

  it('rejects a float percentage outright', () => {
    const bad = validateOffer(offer({ percentBps: 12.5 }));
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.code === 'invalid_percent_bps'));
  });

  it('rejects an offer that is both percent and fixed', () => {
    const bad = validateOffer(offer({ amountCents: 500 }));
    assert.ok(bad.errors.some((e) => e.code === 'percent_offer_has_amount'));
  });

  it('requires scope ids for a scoped offer', () => {
    const bad = validateOffer(offer({ appliesTo: 'addon' }));
    assert.ok(bad.errors.some((e) => e.code === 'scope_ids_required'));
  });

  it('rejects an offer that stacks with itself', () => {
    const bad = validateOffer(offer({ combinesWith: ['off_welcome'] }));
    assert.ok(bad.errors.some((e) => e.code === 'combines_with_self'));
  });
});

describe('scope decides what a discount may touch', () => {
  it('order_subtotal sees the whole cart', () => {
    assert.equal(eligibleBaseCents(validateOffer(offer()).offer, ctx()), 24000);
  });

  it('an add-on offer cannot reach the package', () => {
    const scoped = validateOffer(offer({ appliesTo: 'addon', scopeIds: ['addon_ozone'] })).offer;
    assert.equal(eligibleBaseCents(scoped, ctx()), 4000);
    const out = run([offer({ appliesTo: 'addon', scopeIds: ['addon_ozone'] })]);
    assert.equal(out.totalDiscountCents, 400, '10% of the add-on only');
  });

  it('reports an offer whose scope matches nothing', () => {
    const out = run([offer({ appliesTo: 'package', scopeIds: ['pkg_absent'] })]);
    assert.equal(out.totalDiscountCents, 0);
    assert.equal(out.rejected[0].reason, 'nothing_in_scope');
  });
});

describe('eligibility', () => {
  it('honours the window', () => {
    const out = run([offer({ startsAt: '2026-09-01T00:00:00.000Z' })]);
    assert.equal(out.rejected[0].reason, 'outside_window');
  });

  it('treats endsAt as exclusive', () => {
    assert.equal(run([offer({ endsAt: NOW })]).totalDiscountCents, 0);
    assert.equal(run([offer({ endsAt: '2026-08-12T12:00:00.001Z' })]).totalDiscountCents, 2400);
  });

  it('honours a minimum subtotal', () => {
    const out = run([offer({ minSubtotalCents: 30000 })]);
    assert.equal(out.rejected[0].reason, 'below_minimum_subtotal');
  });

  it('skips an inactive offer', () => {
    assert.equal(run([offer({ active: false })]).rejected[0].reason, 'inactive');
  });
});

describe('caps are counted from the ledger, never a counter', () => {
  const ledger = (n, over = {}) => Array.from({ length: n }, (_, i) => Object.assign({
    offerId: 'off_welcome', customerIdentityKey: 'cust_1', discountCents: 1000,
  }, over, { redemptionId: 'r' + i }));

  it('stops at the global redemption cap', () => {
    const out = run([offer({ maxRedemptions: 2 })], { redemptions: ledger(2) });
    assert.equal(out.rejected[0].reason, 'redemption_cap_reached');
  });

  it('stops at the per-customer cap while others may still redeem', () => {
    const mine = run([offer({ maxPerCustomer: 1 })], { redemptions: ledger(1) });
    assert.equal(mine.rejected[0].reason, 'customer_cap_reached');
    const theirs = resolveOffers({
      offers: [offer({ maxPerCustomer: 1 })],
      redemptions: ledger(1, { customerIdentityKey: 'cust_other' }),
      context: ctx(),
    });
    assert.equal(theirs.totalDiscountCents, 2400);
  });

  it('stops when the budget is exhausted', () => {
    const out = run([offer({ budgetCents: 2000 })], { redemptions: ledger(2) });
    assert.equal(out.rejected[0].reason, 'budget_exhausted');
  });

  it('clamps the last discount to the budget remaining', () => {
    const out = run([offer({ budgetCents: 2500 })], { redemptions: ledger(1) });
    assert.equal(out.totalDiscountCents, 1500, '2400 wanted, 1500 of budget left');
  });
});

describe('codes', () => {
  const codeOffer = offer({ offerId: 'off_spring', name: 'Spring', trigger: 'code', percentBps: 2000 });
  const codes = [{ code: 'SPRING20', offerId: 'off_spring', active: true }];

  it('never applies a code-triggered offer unaided', () => {
    assert.equal(run([codeOffer], { codes }).totalDiscountCents, 0);
  });

  it('applies it when the code is supplied, case-insensitively', () => {
    const out = resolveOffers({
      offers: [codeOffer], codes, context: ctx({ submittedCodes: ['  spring20 '] }),
    });
    assert.equal(out.totalDiscountCents, 4800);
    assert.equal(out.applied[0].code, 'SPRING20');
  });

  /** A customer who typed a real code must be told why it did not apply. */
  it('reports an unknown, inactive or expired code rather than ignoring it', () => {
    const unknown = resolveOffers({ offers: [codeOffer], codes, context: ctx({ submittedCodes: ['NOPE'] }) });
    assert.equal(unknown.rejected[0].reason, 'unknown_code');

    const off = resolveOffers({
      offers: [codeOffer], codes: [{ code: 'SPRING20', offerId: 'off_spring', active: false }],
      context: ctx({ submittedCodes: ['SPRING20'] }),
    });
    assert.equal(off.rejected[0].reason, 'code_inactive');

    const expired = resolveOffers({
      offers: [codeOffer], codes: [{ code: 'SPRING20', offerId: 'off_spring', active: true, endsAt: '2026-01-01T00:00:00.000Z' }],
      context: ctx({ submittedCodes: ['SPRING20'] }),
    });
    assert.equal(expired.rejected[0].reason, 'code_expired');
  });
});

describe('stacking is mutual consent and non-transitive', () => {
  const A = offer({ offerId: 'off_a', percentBps: 1000, combinesWith: ['off_b'] });
  const B = offer({ offerId: 'off_b', kind: 'fixed_amount', percentBps: undefined, amountCents: 500, combinesWith: ['off_a', 'off_c'] });
  const C = offer({ offerId: 'off_c', kind: 'fixed_amount', percentBps: undefined, amountCents: 300, combinesWith: ['off_b'] });

  it('defaults to exclusive — the best one wins alone', () => {
    const out = run([offer({ offerId: 'off_x', percentBps: 1000 }), offer({ offerId: 'off_y', percentBps: 500 })]);
    assert.equal(out.applied.length, 1);
    assert.equal(out.applied[0].offerId, 'off_x');
    assert.equal(out.rejected.find((r) => r.offerId === 'off_y').reason, 'does_not_stack');
  });

  it('stacks when both sides name each other', () => {
    const out = run([A, B]);
    assert.equal(out.applied.length, 2);
    assert.equal(out.totalDiscountCents, 2900);
  });

  it('refuses one-way consent', () => {
    const oneWay = offer({ offerId: 'off_b2', kind: 'fixed_amount', percentBps: undefined, amountCents: 500, combinesWith: ['off_a'] });
    const out = run([offer({ offerId: 'off_a', percentBps: 1000 }), oneWay]); // A does not name B2
    assert.equal(out.applied.length, 1);
  });

  /**
   * The property most implementations get wrong. A↔B and B↔C must not imply A↔C.
   */
  it('does not let consent travel through a third offer', () => {
    const out = run([A, B, C]);
    const ids = out.applied.map((a) => a.offerId).sort();
    assert.deepEqual(ids, ['off_a', 'off_b'], 'C never named A, so C cannot join');
    assert.equal(out.rejected.find((r) => r.offerId === 'off_c').reason, 'does_not_stack');
  });
});

describe('the total is bounded and deterministic', () => {
  it('can reach zero but never goes negative', () => {
    const big = offer({ offerId: 'off_big', kind: 'fixed_amount', percentBps: undefined, amountCents: 999999 });
    const out = run([big]);
    assert.equal(out.totalDiscountCents, 24000);
    assert.equal(out.finalSubtotalCents, 0);
  });

  it('clamps a stacked pair at the subtotal', () => {
    const a = offer({ offerId: 'off_a', kind: 'fixed_amount', percentBps: undefined, amountCents: 20000, combinesWith: ['off_b'] });
    const b = offer({ offerId: 'off_b', kind: 'fixed_amount', percentBps: undefined, amountCents: 20000, combinesWith: ['off_a'] });
    const out = run([a, b]);
    assert.equal(out.totalDiscountCents, 24000);
    assert.equal(out.finalSubtotalCents, 0);
    assert.equal(out.rejected.find((r) => r.reason === 'nothing_left_to_discount'), undefined,
      'the second offer is clamped, not rejected');
  });

  it('is order-independent', () => {
    const a = offer({ offerId: 'off_a', percentBps: 1000, combinesWith: ['off_b'] });
    const b = offer({ offerId: 'off_b', kind: 'fixed_amount', percentBps: undefined, amountCents: 500, combinesWith: ['off_a'] });
    assert.deepEqual(run([a, b]), run([b, a]));
  });

  it('breaks equal discounts by offerId, not by input order', () => {
    const one = offer({ offerId: 'off_zzz', percentBps: 1000 });
    const two = offer({ offerId: 'off_aaa', percentBps: 1000 });
    assert.equal(run([one, two]).applied[0].offerId, 'off_aaa');
    assert.equal(run([two, one]).applied[0].offerId, 'off_aaa');
  });

  it('handles an empty cart without inventing a discount', () => {
    const out = resolveOffers({ offers: [offer()], context: ctx({ subtotalCents: 0, lines: [] }) });
    assert.equal(out.totalDiscountCents, 0);
    assert.equal(out.finalSubtotalCents, 0);
  });

  it('returns priced lines, never the rule itself', () => {
    const out = run([offer()]);
    assert.deepEqual(Object.keys(out.applied[0]).sort(),
      ['code', 'discountCents', 'name', 'offerId', 'offerVersion'].sort());
    assert.equal(out.applied[0].offer, undefined, 'callers get a line, not the offer definition');
  });

  it('reports an invalid offer instead of silently skipping it', () => {
    const out = run([offer({ kind: 'bogus' })]);
    assert.equal(out.rejected[0].reason, 'invalid_offer');
    assert.ok(out.rejected[0].errors.some((e) => e.code === 'invalid_kind'));
  });
});
