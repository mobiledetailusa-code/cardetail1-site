/**
 * Customer Identity Foundation — central account resolution service.
 *
 * CustomerAccount is the permanent ownership root. Existing Prisma Customer
 * remains a legacy/payment compatibility placeholder and is never treated as
 * a competing identity authority.
 *
 * Never trusts browser-supplied customerAccountId. Ambiguous matches never
 * auto-merge. Concurrent first-login uses an in-process identity lock plus
 * Postgres advisory locks when available so retries stay idempotent.
 */

const crypto = require('crypto');
const { normalizeUsPhoneDigits } = require('./phone-auth');
const { tryGetPrisma } = require('./prisma');

const AMBIGUOUS = 'ambiguous';
const CREATED = 'created';
const RESOLVED = 'resolved';
const UNAVAILABLE = 'unavailable';

/** Existing Prisma Customer model role (documented for Stage 1). */
const EXISTING_CUSTOMER_ROLE =
  'legacy_payment_compatibility_placeholder_not_identity_authority';

/** @type {Map<string, Promise<void>>} */
const memoryLocks = new Map();

function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function normalizePhone(raw) {
  return normalizeUsPhoneDigits(raw);
}

function displayNameFrom(parts) {
  const first = String(parts.firstName || '').trim();
  const last = String(parts.lastName || '').trim();
  const joined = [first, last].filter(Boolean).join(' ').trim();
  return joined || parts.displayName || null;
}

function lockKeyForIdentity({ normalizedEmail, normalizedPhone }) {
  return `id:${normalizedEmail || ''}|${normalizedPhone || ''}`;
}

async function withIdentityLock(key, fn) {
  const prev = memoryLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const chained = prev.then(() => gate);
  memoryLocks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (memoryLocks.get(key) === chained) memoryLocks.delete(key);
  }
}

function advisoryLockSql(key) {
  const hex = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 15);
  const n = BigInt(`0x${hex}`);
  const signed = n > 0x7fffffffffffffffn ? n - 0x10000000000000000n : n;
  return signed.toString();
}

/**
 * Emit a non-PII AuditEvent. detail must never include raw email/phone/token.
 */
async function emitIdentityAudit(prisma, {
  actor = 'system:customer-identity',
  action,
  bookingId = null,
  detail = {},
} = {}) {
  if (!prisma || !action) return null;
  const safe = { ...detail };
  delete safe.email;
  delete safe.phone;
  delete safe.token;
  delete safe.cookie;
  delete safe.address;
  delete safe.normalizedEmail;
  delete safe.normalizedPhone;
  try {
    return await prisma.auditEvent.create({
      data: {
        bookingId: bookingId || null,
        actor,
        action,
        detail: safe,
      },
    });
  } catch {
    return null;
  }
}

function prismaClient(override) {
  if (override) return override;
  return tryGetPrisma();
}

async function findAccountsByContact(prisma, { normalizedEmail, normalizedPhone }) {
  const or = [];
  if (normalizedEmail) or.push({ normalizedEmail });
  if (normalizedPhone) or.push({ normalizedPhone });
  if (!or.length) return [];

  const profiles = await prisma.customerProfile.findMany({
    where: { OR: or },
    include: { account: true },
  });

  const byId = new Map();
  for (const p of profiles) {
    if (!p.account || p.account.status === 'merged') continue;
    byId.set(p.account.id, { account: p.account, profile: p });
  }
  return [...byId.values()];
}

async function findAccountByStripe(prisma, stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const account = await prisma.customerAccount.findFirst({
    where: { stripeCustomerId: String(stripeCustomerId), status: { not: 'merged' } },
    include: { profile: true },
  });
  if (!account) return null;
  return { account, profile: account.profile };
}

async function findAccountById(prisma, customerAccountId) {
  if (!customerAccountId) return null;
  const account = await prisma.customerAccount.findUnique({
    where: { id: String(customerAccountId) },
    include: { profile: true },
  });
  if (!account || account.status === 'merged') return null;
  return { account, profile: account.profile };
}

async function findAccountByLinkedBooking(prisma, bookingId) {
  if (!bookingId) return null;
  const booking = await prisma.booking.findUnique({
    where: { id: String(bookingId) },
    select: { customerAccountId: true },
  });
  if (!booking?.customerAccountId) return null;
  return findAccountById(prisma, booking.customerAccountId);
}

/**
 * Classify contact matches without merging.
 */
function classifyContactMatches(matches, { normalizedEmail, normalizedPhone }) {
  if (!matches.length) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'one', accounts: matches };

  const emailHits = normalizedEmail
    ? matches.filter((m) => m.profile?.normalizedEmail === normalizedEmail)
    : [];
  const phoneHits = normalizedPhone
    ? matches.filter((m) => m.profile?.normalizedPhone === normalizedPhone)
    : [];

  if (normalizedEmail && normalizedPhone && emailHits.length && phoneHits.length) {
    const emailIds = new Set(emailHits.map((m) => m.account.id));
    const phoneIds = new Set(phoneHits.map((m) => m.account.id));
    const same = emailIds.size === 1 && phoneIds.size === 1
      && [...emailIds][0] === [...phoneIds][0];
    if (!same) {
      return { kind: 'ambiguous', accounts: matches, reason: 'email_phone_conflict' };
    }
  }

  return { kind: 'ambiguous', accounts: matches, reason: 'multiple_accounts' };
}

async function createAccountWithProfile(prisma, {
  normalizedEmail,
  normalizedPhone,
  email,
  phone,
  firstName,
  lastName,
  displayName,
  stripeCustomerId,
  timezone,
  preferredContactChannel,
}) {
  const run = async (tx) => {
    const account = await tx.customerAccount.create({
      data: {
        status: 'active',
        version: 1,
        stripeCustomerId: stripeCustomerId || null,
      },
    });
    const profile = await tx.customerProfile.create({
      data: {
        customerAccountId: account.id,
        firstName: firstName || null,
        lastName: lastName || null,
        displayName: displayNameFrom({ firstName, lastName, displayName }),
        email: email || null,
        normalizedEmail: normalizedEmail || null,
        phone: phone || null,
        normalizedPhone: normalizedPhone || null,
        timezone: timezone || null,
        preferredContactChannel: preferredContactChannel || null,
      },
    });
    await emitIdentityAudit(tx, {
      action: 'customer_account.created',
      detail: {
        customerAccountId: account.id,
        hasEmail: !!normalizedEmail,
        hasPhone: !!normalizedPhone,
        hasStripe: !!stripeCustomerId,
      },
    });
    return { account, profile };
  };

  if (typeof prisma.$transaction === 'function') {
    return prisma.$transaction(run);
  }
  return run(prisma);
}

/**
 * Conservatively link a booking to an account when customerAccountId is null.
 * Never overwrites a link to another account.
 */
async function linkBookingToAccount(prisma, {
  bookingId,
  customerAccountId,
  actor = 'system:customer-identity',
}) {
  if (!prisma || !bookingId || !customerAccountId) {
    return { ok: false, error: 'invalid_args' };
  }

  const existing = await prisma.booking.findUnique({
    where: { id: String(bookingId) },
    select: { id: true, customerAccountId: true },
  });

  if (!existing) {
    try {
      await prisma.booking.create({
        data: {
          id: String(bookingId),
          customerAccountId: String(customerAccountId),
          status: 'submitted',
          isDraft: false,
        },
      });
      await emitIdentityAudit(prisma, {
        actor,
        action: 'customer_account.booking_linked',
        bookingId: String(bookingId),
        detail: { customerAccountId, createdBookingRow: true },
      });
      return { ok: true, linked: true, created: true };
    } catch (err) {
      if (!String(err?.code || '').includes('P2002')
        && !/unique|duplicate/i.test(String(err?.message || ''))) {
        return { ok: false, error: 'link_failed' };
      }
    }
  } else if (existing.customerAccountId) {
    if (existing.customerAccountId === customerAccountId) {
      return { ok: true, linked: false, alreadyLinked: true };
    }
    return { ok: false, error: 'already_linked_other', existingAccountId: existing.customerAccountId };
  }

  const updated = await prisma.booking.updateMany({
    where: { id: String(bookingId), customerAccountId: null },
    data: { customerAccountId: String(customerAccountId) },
  });

  if (updated.count === 1) {
    await emitIdentityAudit(prisma, {
      actor,
      action: 'customer_account.booking_linked',
      bookingId: String(bookingId),
      detail: { customerAccountId },
    });
    return { ok: true, linked: true };
  }

  const again = await prisma.booking.findUnique({
    where: { id: String(bookingId) },
    select: { customerAccountId: true },
  });
  if (again?.customerAccountId === customerAccountId) {
    return { ok: true, linked: false, alreadyLinked: true };
  }
  return { ok: false, error: 'already_linked_other', existingAccountId: again?.customerAccountId || null };
}

async function resolveContactWithClient(prisma, {
  normalizedEmail,
  normalizedPhone,
  allowPhoneOnly,
  createIfMissing,
  input,
}) {
  if (typeof prisma.$executeRawUnsafe === 'function' && (normalizedEmail || normalizedPhone)) {
    const lockId = advisoryLockSql(lockKeyForIdentity({ normalizedEmail, normalizedPhone }));
    try {
      await prisma.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${lockId})`);
    } catch {
      // Non-transactional client or non-Postgres — in-process lock still applies.
    }
  }

  const matches = await findAccountsByContact(prisma, { normalizedEmail, normalizedPhone });

  // 4. Unambiguous verified email + phone
  if (normalizedEmail && normalizedPhone) {
    const both = matches.filter(
      (m) => m.profile?.normalizedEmail === normalizedEmail
        && m.profile?.normalizedPhone === normalizedPhone
    );
    if (both.length === 1) {
      return {
        status: RESOLVED,
        customerAccountId: both[0].account.id,
        account: both[0].account,
        profile: both[0].profile,
        resolutionPath: 'email_and_phone',
      };
    }
    const classified = classifyContactMatches(matches, { normalizedEmail, normalizedPhone });
    if (classified.kind === 'ambiguous') {
      await emitIdentityAudit(prisma, {
        action: 'customer_account.ambiguity',
        detail: {
          reason: classified.reason || 'ambiguous',
          candidateCount: classified.accounts?.length || matches.length,
          hasEmail: true,
          hasPhone: true,
        },
      });
      return {
        status: AMBIGUOUS,
        customerAccountId: null,
        ambiguity: {
          reason: classified.reason || 'ambiguous',
          candidateCount: classified.accounts?.length || matches.length,
        },
        resolutionPath: 'email_and_phone',
      };
    }
  }

  // 5. Unambiguous verified email
  if (normalizedEmail) {
    const emailOnly = matches.filter((m) => m.profile?.normalizedEmail === normalizedEmail);
    if (emailOnly.length === 1) {
      if (normalizedPhone) {
        const phoneOther = matches.filter(
          (m) => m.profile?.normalizedPhone === normalizedPhone
            && m.account.id !== emailOnly[0].account.id
        );
        if (phoneOther.length) {
          await emitIdentityAudit(prisma, {
            action: 'customer_account.ambiguity',
            detail: {
              reason: 'email_phone_conflict',
              candidateCount: emailOnly.length + phoneOther.length,
              hasEmail: true,
              hasPhone: true,
            },
          });
          return {
            status: AMBIGUOUS,
            customerAccountId: null,
            ambiguity: {
              reason: 'email_phone_conflict',
              candidateCount: emailOnly.length + phoneOther.length,
            },
            resolutionPath: 'email',
          };
        }
      }
      return {
        status: RESOLVED,
        customerAccountId: emailOnly[0].account.id,
        account: emailOnly[0].account,
        profile: emailOnly[0].profile,
        resolutionPath: 'email',
      };
    }
    if (emailOnly.length > 1) {
      await emitIdentityAudit(prisma, {
        action: 'customer_account.ambiguity',
        detail: {
          reason: 'multiple_email_matches',
          candidateCount: emailOnly.length,
          hasEmail: true,
          hasPhone: !!normalizedPhone,
        },
      });
      return {
        status: AMBIGUOUS,
        customerAccountId: null,
        ambiguity: { reason: 'multiple_email_matches', candidateCount: emailOnly.length },
        resolutionPath: 'email',
      };
    }
  }

  // 6. Unambiguous verified phone (verified login path only)
  if (normalizedPhone && allowPhoneOnly) {
    const phoneOnly = matches.filter((m) => m.profile?.normalizedPhone === normalizedPhone);
    if (phoneOnly.length === 1) {
      return {
        status: RESOLVED,
        customerAccountId: phoneOnly[0].account.id,
        account: phoneOnly[0].account,
        profile: phoneOnly[0].profile,
        resolutionPath: 'phone',
      };
    }
    if (phoneOnly.length > 1) {
      await emitIdentityAudit(prisma, {
        action: 'customer_account.ambiguity',
        detail: {
          reason: 'multiple_phone_matches',
          candidateCount: phoneOnly.length,
          hasEmail: !!normalizedEmail,
          hasPhone: true,
        },
      });
      return {
        status: AMBIGUOUS,
        customerAccountId: null,
        ambiguity: { reason: 'multiple_phone_matches', candidateCount: phoneOnly.length },
        resolutionPath: 'phone',
      };
    }
  }

  if (!createIfMissing) {
    return {
      status: RESOLVED,
      customerAccountId: null,
      account: null,
      profile: null,
      resolutionPath: 'none',
    };
  }

  if (!normalizedEmail && !(normalizedPhone && allowPhoneOnly)) {
    return {
      status: UNAVAILABLE,
      error: 'insufficient_verified_identity',
      customerAccountId: null,
    };
  }

  // 7. Create
  const created = await createAccountWithProfile(prisma, {
    normalizedEmail,
    normalizedPhone,
    email: normalizedEmail,
    phone: normalizedPhone,
    firstName: input.firstName,
    lastName: input.lastName,
    displayName: input.displayName,
    stripeCustomerId: input.stripeCustomerId ? String(input.stripeCustomerId).trim() : null,
    timezone: input.timezone,
    preferredContactChannel: input.preferredContactChannel,
  });

  return {
    status: CREATED,
    customerAccountId: created.account.id,
    account: created.account,
    profile: created.profile,
    resolutionPath: 'created',
  };
}

/**
 * Resolve or create a CustomerAccount from verified server-side identity.
 *
 * Resolution order:
 * 1. session customerAccountId
 * 2. Booking.customerAccountId
 * 3. Stripe Customer linkage
 * 4. unambiguous verified email+phone
 * 5. unambiguous verified email
 * 6. unambiguous verified phone (verified login path only)
 * 7. create new account
 *
 * Browser-supplied customerAccountId is ignored unless opts.acceptBrowserAccountId.
 */
async function resolveOrCreateCustomerAccount(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) {
    return {
      ok: false,
      status: UNAVAILABLE,
      error: 'prisma_unavailable',
      customerAccountId: null,
      ambiguity: null,
    };
  }

  const sessionAccountId = opts.trustSessionAccountId !== false
    ? (input.sessionCustomerAccountId || null)
    : null;

  // Ignore untrusted browser ids (explicit no-op so callers/tests can assert).
  void (input.browserCustomerAccountId || input.customerAccountId);

  const normalizedEmail = normalizeEmail(input.verifiedEmail || input.email);
  const normalizedPhone = normalizePhone(input.verifiedPhone || input.phone);
  const stripeCustomerId = input.stripeCustomerId ? String(input.stripeCustomerId).trim() : null;
  const bookingIds = Array.isArray(input.bookingIds)
    ? input.bookingIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const allowPhoneOnly = opts.allowPhoneOnly === true;
  const createIfMissing = opts.createIfMissing !== false;

  const finish = (result) => ({
    ok: result.status !== AMBIGUOUS && result.status !== UNAVAILABLE && !result.error,
    ...result,
  });

  // 1. Session account
  if (sessionAccountId) {
    const hit = await findAccountById(prisma, sessionAccountId);
    if (hit) {
      return finish({
        status: RESOLVED,
        customerAccountId: hit.account.id,
        account: hit.account,
        profile: hit.profile,
        resolutionPath: 'session',
      });
    }
  }

  // 2. Linked bookings
  for (const bookingId of bookingIds) {
    const hit = await findAccountByLinkedBooking(prisma, bookingId);
    if (hit) {
      return finish({
        status: RESOLVED,
        customerAccountId: hit.account.id,
        account: hit.account,
        profile: hit.profile,
        resolutionPath: 'booking_link',
        bookingId,
      });
    }
  }

  // 3. Stripe linkage
  if (stripeCustomerId) {
    const hit = await findAccountByStripe(prisma, stripeCustomerId);
    if (hit) {
      return finish({
        status: RESOLVED,
        customerAccountId: hit.account.id,
        account: hit.account,
        profile: hit.profile,
        resolutionPath: 'stripe',
      });
    }
  }

  const key = lockKeyForIdentity({ normalizedEmail, normalizedPhone });
  const args = {
    normalizedEmail,
    normalizedPhone,
    allowPhoneOnly,
    createIfMissing,
    input: { ...input, stripeCustomerId },
  };

  const contactResult = await withIdentityLock(key, async () => {
    // Hold pg_advisory_xact_lock for the duration of match+create.
    if (typeof prisma.$transaction === 'function') {
      try {
        return await prisma.$transaction((tx) => resolveContactWithClient(tx, args));
      } catch (err) {
        // If the interactive transaction path is unavailable (test doubles),
        // fall through to a direct call under the in-process lock.
        if (!/transaction|InteractiveTransaction|not a function/i.test(String(err?.message || ''))) {
          throw err;
        }
      }
    }
    return resolveContactWithClient(prisma, args);
  });

  return finish(contactResult);
}

/**
 * Backfill-on-login: link visible verified bookings whose contact matches.
 * Only sets Booking.customerAccountId when null. Idempotent.
 */
async function backfillBookingsOnLogin({
  customerAccountId,
  verifiedEmail,
  verifiedPhone,
  bookingIds = [],
  blobBookings = [],
  prisma: prismaOverride,
} = {}) {
  const prisma = prismaClient(prismaOverride);
  if (!prisma || !customerAccountId) {
    return {
      ok: false,
      linked: [],
      skipped: [],
      error: prisma ? 'missing_account' : 'prisma_unavailable',
    };
  }

  const normalizedEmail = normalizeEmail(verifiedEmail);
  const normalizedPhone = normalizePhone(verifiedPhone);
  const linked = [];
  const skipped = [];

  const candidates = new Map();
  for (const id of bookingIds) {
    if (id) candidates.set(String(id), { id: String(id), fromSession: true });
  }
  for (const b of blobBookings) {
    const id = String(b.id || b.bookingId || '').trim();
    if (!id) continue;
    const bEmail = normalizeEmail(b.email);
    const bPhone = normalizePhone(b.phone || b.customerPhone);
    const emailMatch = normalizedEmail && bEmail && bEmail === normalizedEmail;
    const phoneMatch = normalizedPhone && bPhone && bPhone === normalizedPhone;
    if (emailMatch || phoneMatch || candidates.has(id)) {
      candidates.set(id, {
        id,
        emailMatch,
        phoneMatch,
        fromSession: candidates.get(id)?.fromSession || false,
      });
    }
  }

  for (const [id] of candidates) {
    const result = await linkBookingToAccount(prisma, {
      bookingId: id,
      customerAccountId,
      actor: 'system:customer-identity:backfill',
    });
    if (result.ok && (result.linked || result.alreadyLinked || result.created)) {
      linked.push({ bookingId: id, ...result });
    } else {
      skipped.push({ bookingId: id, ...result });
    }
  }

  return { ok: true, linked, skipped };
}

async function listBookingIdsForAccount(customerAccountId, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma || !customerAccountId) return [];
  try {
    const rows = await prisma.booking.findMany({
      where: { customerAccountId: String(customerAccountId) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

async function loadCustomerAccountGraph(customerAccountId, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma || !customerAccountId) return null;
  try {
    return await prisma.customerAccount.findUnique({
      where: { id: String(customerAccountId) },
      include: {
        profile: true,
        addresses: {
          where: { archivedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        },
        consents: true,
        bookings: { select: { id: true, updatedAt: true, status: true } },
      },
    });
  } catch {
    return null;
  }
}

module.exports = {
  AMBIGUOUS,
  CREATED,
  RESOLVED,
  UNAVAILABLE,
  EXISTING_CUSTOMER_ROLE,
  normalizeEmail,
  normalizePhone,
  resolveOrCreateCustomerAccount,
  linkBookingToAccount,
  backfillBookingsOnLogin,
  listBookingIdsForAccount,
  loadCustomerAccountGraph,
  emitIdentityAudit,
  classifyContactMatches,
};
