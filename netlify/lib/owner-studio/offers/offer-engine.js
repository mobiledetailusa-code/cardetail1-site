'use strict';

/**
 * Owner Studio — Offers & Discounts resolution engine (stage O1).
 *
 * Pure and total: given the same offers, codes, redemption ledger and context, it
 * returns the same result, always. No IO, no clock of its own, no database, no
 * Stripe. Nothing reads it yet — see docs/owner-studio-offers-design.md for the
 * five-stage rollout, whose second stage runs this in shadow mode beside the
 * existing booking-offers.js before anyone is charged differently.
 *
 * Design commitments, each of which a test pins:
 *
 *  - **Integer cents and basis points only.** A percentage is `percentBps`
 *    (2000 = 20%), never a float, for the same reason prices are cents: no rounding
 *    can enter through the rule itself.
 *  - **The caller supplies a subtotal; the engine never prices anything.** It
 *    decides which offers apply and how much they take off, and it can never
 *    invent a line item or reach past the subtotal it was handed.
 *  - **Stacking is mutual consent, and non-transitive.** A stacks with B and B with
 *    C does not imply A stacks with C. Every already-taken offer must list the
 *    candidate, and the candidate must list every already-taken offer.
 *  - **Caps come from a redemption ledger, not a counter.** The caller passes the
 *    rows; the engine counts them. A counter can drift from reality, a ledger cannot.
 *  - **A discount can bring a subtotal to zero, never below.**
 *  - **Ties break deterministically** — larger discount first, then `offerId`
 *    ascending — so two runs on the same input cannot disagree.
 */

const KINDS = new Set(['percent', 'fixed_amount']);
const SCOPES = new Set(['order_subtotal', 'category', 'package', 'addon']);
const TRIGGERS = new Set(['automatic', 'code']);

function isInt(v) {
  return Number.isInteger(v) && Number.isSafeInteger(v);
}

/**
 * Percent discounts round HALF UP on the cent, then clamp to the eligible base.
 * Documented rather than incidental: 20% of 1 cent is 0.2 and has to become an
 * integer somewhere, and an operator reading "20% off" should never see the
 * customer charged more than the arithmetic implies.
 */
function percentOf(baseCents, percentBps) {
  const raw = (baseCents * percentBps) / 10000;
  return Math.min(baseCents, Math.floor(raw + 0.5));
}

function normalizeOffer(offer) {
  const o = offer || {};
  return {
    offerId: String(o.offerId || ''),
    offerVersion: String(o.offerVersion || '1'),
    name: String(o.name || ''),
    kind: o.kind,
    percentBps: isInt(o.percentBps) ? o.percentBps : null,
    amountCents: isInt(o.amountCents) ? o.amountCents : null,
    appliesTo: o.appliesTo || 'order_subtotal',
    scopeIds: Array.isArray(o.scopeIds) ? o.scopeIds.slice() : [],
    minSubtotalCents: isInt(o.minSubtotalCents) ? o.minSubtotalCents : 0,
    combinesWith: Array.isArray(o.combinesWith) ? o.combinesWith.slice() : [],
    startsAt: o.startsAt || null,
    endsAt: o.endsAt || null,
    maxRedemptions: isInt(o.maxRedemptions) ? o.maxRedemptions : null,
    maxPerCustomer: isInt(o.maxPerCustomer) ? o.maxPerCustomer : null,
    budgetCents: isInt(o.budgetCents) ? o.budgetCents : null,
    trigger: TRIGGERS.has(o.trigger) ? o.trigger : 'automatic',
    active: o.active !== false,
  };
}

/**
 * Structural validation. Returns errors rather than throwing so a caller can report
 * every problem with an offer at once instead of one per save.
 */
function validateOffer(offer) {
  const o = normalizeOffer(offer);
  const errors = [];
  if (!o.offerId) errors.push({ code: 'offer_id_required' });
  if (!KINDS.has(o.kind)) errors.push({ code: 'invalid_kind', kind: offer && offer.kind });
  if (o.kind === 'percent') {
    if (!isInt(o.percentBps) || o.percentBps <= 0 || o.percentBps > 10000) {
      errors.push({ code: 'invalid_percent_bps' });
    }
    if (o.amountCents != null) errors.push({ code: 'percent_offer_has_amount' });
  }
  if (o.kind === 'fixed_amount') {
    if (!isInt(o.amountCents) || o.amountCents <= 0) errors.push({ code: 'invalid_amount_cents' });
    if (o.percentBps != null) errors.push({ code: 'fixed_offer_has_percent' });
  }
  if (!SCOPES.has(o.appliesTo)) errors.push({ code: 'invalid_scope' });
  if (o.appliesTo !== 'order_subtotal' && !o.scopeIds.length) {
    errors.push({ code: 'scope_ids_required', appliesTo: o.appliesTo });
  }
  if (o.minSubtotalCents < 0) errors.push({ code: 'invalid_min_subtotal' });
  if (o.budgetCents != null && o.budgetCents < 0) errors.push({ code: 'invalid_budget' });
  if (o.startsAt && o.endsAt && String(o.endsAt) <= String(o.startsAt)) {
    errors.push({ code: 'window_ends_before_start' });
  }
  if (o.combinesWith.includes(o.offerId)) errors.push({ code: 'combines_with_self' });
  return errors.length ? { ok: false, errors } : { ok: true, offer: o };
}

function withinWindow(offer, nowIso) {
  if (offer.startsAt && String(nowIso) < String(offer.startsAt)) return false;
  if (offer.endsAt && String(nowIso) >= String(offer.endsAt)) return false;
  return true;
}

/**
 * The cents an offer may take a discount from. `order_subtotal` sees everything;
 * a scoped offer sees only the lines it names, which is what stops a
 * "20% off add-ons" rule from discounting a package.
 */
function eligibleBaseCents(offer, context) {
  const lines = Array.isArray(context.lines) ? context.lines : [];
  if (offer.appliesTo === 'order_subtotal') return Math.max(0, Number(context.subtotalCents) || 0);
  const wanted = new Set(offer.scopeIds);
  const key = offer.appliesTo === 'category' ? 'category'
    : offer.appliesTo === 'package' ? 'packageId'
      : 'addOnId';
  return lines.reduce((sum, line) => {
    if (!line || !wanted.has(line[key])) return sum;
    const cents = Number(line.amountCents);
    return sum + (isInt(cents) && cents > 0 ? cents : 0);
  }, 0);
}

function countRedemptions(redemptions, offerId, customerKey) {
  let total = 0;
  let mine = 0;
  let spentCents = 0;
  for (const r of redemptions || []) {
    if (!r || r.offerId !== offerId) continue;
    total += 1;
    spentCents += isInt(r.discountCents) ? r.discountCents : 0;
    if (customerKey && r.customerIdentityKey === customerKey) mine += 1;
  }
  return { total, mine, spentCents };
}

/** Why an offer did not apply. Callers surface these; they are not thrown. */
function ineligibility(offer, context, redemptions) {
  if (!offer.active) return 'inactive';
  if (!withinWindow(offer, context.nowIso)) return 'outside_window';
  const subtotal = Math.max(0, Number(context.subtotalCents) || 0);
  if (subtotal < offer.minSubtotalCents) return 'below_minimum_subtotal';
  const counts = countRedemptions(redemptions, offer.offerId, context.customerIdentityKey);
  if (offer.maxRedemptions != null && counts.total >= offer.maxRedemptions) return 'redemption_cap_reached';
  if (offer.maxPerCustomer != null && counts.mine >= offer.maxPerCustomer) return 'customer_cap_reached';
  if (offer.budgetCents != null && counts.spentCents >= offer.budgetCents) return 'budget_exhausted';
  if (eligibleBaseCents(offer, context) <= 0) return 'nothing_in_scope';
  return null;
}

function rawDiscountCents(offer, context) {
  const base = eligibleBaseCents(offer, context);
  if (base <= 0) return 0;
  if (offer.kind === 'percent') return percentOf(base, offer.percentBps);
  return Math.min(base, offer.amountCents);
}

/** Remaining budget for an offer, or Infinity when it has none. */
function budgetRoomCents(offer, redemptions) {
  if (offer.budgetCents == null) return Infinity;
  const { spentCents } = countRedemptions(redemptions, offer.offerId, null);
  return Math.max(0, offer.budgetCents - spentCents);
}

/**
 * Mutual consent. Both directions are required, which is what keeps stacking
 * non-transitive: A↔B and B↔C never implies A↔C, because C never named A.
 */
function stacksWith(candidate, taken) {
  return taken.every((t) => (
    t.offer.combinesWith.includes(candidate.offerId)
    && candidate.combinesWith.includes(t.offer.offerId)
  ));
}

/**
 * Resolve which offers apply to a cart and what they take off.
 *
 * @param {object} input
 * @param {Array}  input.offers        candidate offer definitions
 * @param {Array}  [input.codes]       {code, offerId, active, endsAt, maxRedemptions}
 * @param {Array}  [input.redemptions] immutable redemption ledger rows
 * @param {object} input.context       {subtotalCents, lines[], nowIso, customerIdentityKey, submittedCodes[]}
 * @returns {{applied: Array, rejected: Array, totalDiscountCents: number, finalSubtotalCents: number}}
 */
function resolveOffers(input) {
  const inp = input || {};
  const context = inp.context || {};
  const redemptions = inp.redemptions || [];
  const subtotal = Math.max(0, Number(context.subtotalCents) || 0);
  const submitted = (context.submittedCodes || []).map((c) => String(c || '').trim().toUpperCase()).filter(Boolean);

  const valid = [];
  const rejected = [];
  for (const raw of inp.offers || []) {
    const check = validateOffer(raw);
    if (!check.ok) {
      rejected.push({ offerId: (raw && raw.offerId) || null, reason: 'invalid_offer', errors: check.errors });
      continue;
    }
    valid.push(check.offer);
  }

  // Codes are matched case-insensitively and must themselves be live. A code that
  // points at a missing or inactive offer is reported, never silently ignored —
  // a customer who typed a real code deserves to know it did not apply.
  const codeByOffer = new Map();
  for (const code of submitted) {
    const row = (inp.codes || []).find((c) => c && String(c.code || '').trim().toUpperCase() === code);
    if (!row) { rejected.push({ code, reason: 'unknown_code' }); continue; }
    if (row.active === false) { rejected.push({ code, reason: 'code_inactive' }); continue; }
    if (row.endsAt && String(context.nowIso) >= String(row.endsAt)) {
      rejected.push({ code, reason: 'code_expired' }); continue;
    }
    const offer = valid.find((o) => o.offerId === row.offerId);
    if (!offer) { rejected.push({ code, reason: 'code_offer_missing' }); continue; }
    codeByOffer.set(offer.offerId, code);
  }

  const candidates = [];
  for (const offer of valid) {
    const viaCode = codeByOffer.has(offer.offerId);
    if (offer.trigger === 'code' && !viaCode) continue; // never applies unaided
    const why = ineligibility(offer, context, redemptions);
    if (why) {
      if (viaCode || offer.trigger === 'automatic') {
        rejected.push({ offerId: offer.offerId, code: codeByOffer.get(offer.offerId) || null, reason: why });
      }
      continue;
    }
    const discountCents = Math.min(rawDiscountCents(offer, context), budgetRoomCents(offer, redemptions));
    if (discountCents <= 0) {
      rejected.push({ offerId: offer.offerId, reason: 'no_discount_available' });
      continue;
    }
    candidates.push({ offer, discountCents, code: codeByOffer.get(offer.offerId) || null });
  }

  // Largest first, then offerId ascending — a total order, so the result cannot
  // depend on the order the caller happened to pass the offers in.
  candidates.sort((a, b) => (
    b.discountCents - a.discountCents || (a.offer.offerId < b.offer.offerId ? -1 : a.offer.offerId > b.offer.offerId ? 1 : 0)
  ));

  const taken = [];
  let totalDiscountCents = 0;
  for (const candidate of candidates) {
    if (taken.length && !stacksWith(candidate.offer, taken)) {
      rejected.push({ offerId: candidate.offer.offerId, code: candidate.code, reason: 'does_not_stack' });
      continue;
    }
    // A booking can reach zero, never negative, no matter how many offers stack.
    const room = Math.max(0, subtotal - totalDiscountCents);
    const applied = Math.min(candidate.discountCents, room);
    if (applied <= 0) {
      rejected.push({ offerId: candidate.offer.offerId, code: candidate.code, reason: 'nothing_left_to_discount' });
      continue;
    }
    totalDiscountCents += applied;
    taken.push({
      offer: candidate.offer,
      offerId: candidate.offer.offerId,
      offerVersion: candidate.offer.offerVersion,
      name: candidate.offer.name,
      code: candidate.code,
      discountCents: applied,
    });
  }

  return {
    // `offer` is dropped from the public shape: callers get a priced line, not the rule.
    applied: taken.map(({ offer, ...line }) => line),
    rejected,
    totalDiscountCents,
    finalSubtotalCents: Math.max(0, subtotal - totalDiscountCents),
  };
}

module.exports = {
  resolveOffers,
  validateOffer,
  normalizeOffer,
  eligibleBaseCents,
  percentOf,
};
