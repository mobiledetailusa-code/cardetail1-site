// Safe US phone normalization and exact matching for customer authorization.

function normalizeUsPhoneDigits(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return digits.slice(1);
  return null;
}

function normalizeUsPhoneE164(raw) {
  const digits = normalizeUsPhoneDigits(raw);
  return digits ? `+1${digits}` : null;
}

/** @deprecated use normalizeUsPhoneDigits — kept for ops-db callers expecting digit string */
function normalizePhone(raw) {
  return normalizeUsPhoneDigits(raw) || '';
}

/**
 * Exact normalized 10-digit match only — no suffix/prefix partial matching.
 */
function phonesMatch(inputRaw, storedRaw) {
  const a = normalizeUsPhoneDigits(inputRaw);
  const b = normalizeUsPhoneDigits(storedRaw);
  if (!a || !b) return false;
  return a === b;
}

/**
 * Portal lookup: accept last-10 match when one side has extra country/trunk digits
 * that normalizeUsPhoneDigits rejected (e.g. 12+ digit paste).
 */
function phonesMatchForPortal(inputRaw, storedRaw) {
  if (phonesMatch(inputRaw, storedRaw)) return true;
  const a = String(inputRaw || '').replace(/\D/g, '');
  const b = String(storedRaw || '').replace(/\D/g, '');
  if (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10)) return true;
  return false;
}

module.exports = {
  normalizeUsPhoneDigits,
  normalizeUsPhoneE164,
  normalizePhone,
  phonesMatch,
  phonesMatchForPortal,
};
