'use strict';

function assertIntegerCents(value, field = 'amountCents') {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    const err = new Error(`${field}_not_integer`);
    err.code = 'money_not_integer';
    err.field = field;
    throw err;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const err = new Error(`${field}_invalid`);
    err.code = 'money_invalid';
    err.field = field;
    throw err;
  }
  if (value < 0) {
    const err = new Error(`${field}_negative`);
    err.code = 'money_negative';
    err.field = field;
    throw err;
  }
  return value;
}

function assertCurrency(currency) {
  const c = String(currency || '').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(c)) {
    const err = new Error('invalid_currency');
    err.code = 'invalid_currency';
    throw err;
  }
  return c;
}

/** Convert legacy whole-dollar catalog numbers to cents. Rejects non-finite / fractional dollars. */
function dollarsToCents(dollars) {
  if (typeof dollars !== 'number' || !Number.isFinite(dollars)) {
    const err = new Error('dollars_invalid');
    err.code = 'dollars_invalid';
    throw err;
  }
  if (!Number.isInteger(dollars)) {
    // Allow .0 only via integer check after scale; reject true floats like 19.99 ambiguity from legacy
    const scaled = dollars * 100;
    if (!Number.isInteger(scaled) && Math.abs(scaled - Math.round(scaled)) > 1e-9) {
      const err = new Error('dollars_not_cent_safe');
      err.code = 'dollars_not_cent_safe';
      throw err;
    }
  }
  const cents = Math.round(dollars * 100);
  return assertIntegerCents(cents);
}

function rejectFloatingMoney(value) {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    const err = new Error('floating_point_money_forbidden');
    err.code = 'floating_point_money_forbidden';
    throw err;
  }
}

module.exports = {
  assertIntegerCents,
  assertCurrency,
  dollarsToCents,
  rejectFloatingMoney,
};
