'use strict';

/**
 * Technician tip helpers — charged with the customer balance PaymentIntent.
 * Tip is optional, server-clamped, and never mutates the approved invoice total.
 * Suggested presets are percentages of the remaining balance.
 */

const SUGGESTED_TIP_PERCENTS = Object.freeze([15, 18, 20]);
const MAX_TIP_PERCENT = 40;
const MAX_TIP_CENTS = 50_000; // $500 hard cap

function roundCents(n) {
  return Math.max(0, Math.round(Number(n) || 0));
}

function suggestedTipOptions(balanceCents) {
  const balance = roundCents(balanceCents);
  return SUGGESTED_TIP_PERCENTS.map((percent) => ({
    percent,
    tipCents: balance > 0 ? Math.round(balance * (percent / 100)) : 0,
  }));
}

/**
 * Resolve a customer tip selection into clamped tip cents.
 * Prefer explicit tipCents when provided; otherwise derive from tipPercent.
 */
function resolveTechnicianTip({
  balanceCents,
  tipCents = null,
  tipPercent = null,
} = {}) {
  const balance = roundCents(balanceCents);
  if (!(balance > 0)) {
    return {
      ok: true,
      tipCents: 0,
      tipPercent: 0,
      balanceCents: 0,
      chargeCents: 0,
    };
  }

  let resolved = 0;
  let percent = 0;

  if (tipCents != null && tipCents !== '') {
    resolved = roundCents(tipCents);
    percent = resolved > 0 ? Math.round((resolved / balance) * 1000) / 10 : 0;
  } else if (tipPercent != null && tipPercent !== '') {
    percent = Number(tipPercent);
    if (!Number.isFinite(percent) || percent < 0) {
      return { ok: false, error: 'invalid_tip_percent' };
    }
    if (percent > MAX_TIP_PERCENT) {
      return { ok: false, error: 'tip_percent_too_high', maxPercent: MAX_TIP_PERCENT };
    }
    resolved = Math.round(balance * (percent / 100));
  }

  if (resolved < 0) {
    return { ok: false, error: 'invalid_tip_cents' };
  }
  if (resolved > MAX_TIP_CENTS) {
    return { ok: false, error: 'tip_too_high', maxTipCents: MAX_TIP_CENTS };
  }
  const maxFromBalance = Math.round(balance * (MAX_TIP_PERCENT / 100));
  if (resolved > maxFromBalance) {
    return {
      ok: false,
      error: 'tip_exceeds_balance_cap',
      maxTipCents: maxFromBalance,
      maxPercent: MAX_TIP_PERCENT,
    };
  }

  return {
    ok: true,
    tipCents: resolved,
    tipPercent: percent,
    balanceCents: balance,
    chargeCents: balance + resolved,
  };
}

function tipFromPaymentIntentMetadata(paymentIntent) {
  const meta = paymentIntent && paymentIntent.metadata && typeof paymentIntent.metadata === 'object'
    ? paymentIntent.metadata
    : {};
  const tipCents = roundCents(meta.tipCents || meta.tip_cents || 0);
  const balanceCents = roundCents(meta.balanceCents || meta.balance_cents || 0);
  const tipPercent = Number(meta.tipPercent || meta.tip_percent || 0) || 0;
  return { tipCents, balanceCents, tipPercent };
}

module.exports = {
  SUGGESTED_TIP_PERCENTS,
  MAX_TIP_PERCENT,
  MAX_TIP_CENTS,
  suggestedTipOptions,
  resolveTechnicianTip,
  tipFromPaymentIntentMetadata,
};
