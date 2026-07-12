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

module.exports = {
  normalizeUsPhoneDigits,
  normalizeUsPhoneE164,
  normalizePhone,
  phonesMatch,
};
