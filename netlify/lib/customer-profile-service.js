/**
 * Customer Profile service (Stage 2A).
 *
 * Loads and updates editable profile preferences scoped to the authenticated
 * CustomerAccount. Email/phone are read-only here — a future verified-contact
 * change flow must re-verify before those fields can change identity resolution.
 *
 * Never trusts browser-supplied customerAccountId. Optimistic concurrency via
 * CustomerAccount.version. Material updates emit non-PII AuditEvent rows.
 */

const { tryGetPrisma } = require('./prisma');
const {
  emitIdentityAudit,
  loadCustomerAccountGraph,
  assertCustomerPortalAccountActive,
} = require('./customer-account-service');
const {
  projectCustomerIdentity,
  assertSafeCustomerProjection,
} = require('./customer-identity-projection');

const PREFERRED_CONTACT_CHANNELS = Object.freeze(['email', 'phone', 'sms', 'any']);
const MAX_NAME_LEN = 80;
const MAX_DISPLAY_NAME_LEN = 120;
const MAX_TIMEZONE_LEN = 64;

const VERSION_CONFLICT = 'version_conflict';
const VALIDATION_ERROR = 'validation_error';
const NOT_FOUND = 'not_found';
const UNAVAILABLE = 'unavailable';
const CONTACT_CHANGE_REQUIRES_VERIFICATION = 'contact_change_requires_verification';

/** @type {any} */
let prismaOverrideForTests = null;

function setPrismaForTests(client) {
  prismaOverrideForTests = client || null;
}

function prismaClient(override) {
  if (override) return override;
  if (prismaOverrideForTests) return prismaOverrideForTests;
  return tryGetPrisma();
}

function asPlainText(raw, maxLen) {
  if (raw == null) return null;
  // Treat HTML/script as plain text — strip tags, collapse whitespace, trim.
  let s = String(raw)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function isValidIanaTimezone(tz) {
  if (!tz) return true;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and normalize editable Stage 2A profile fields.
 * Rejects any attempt to set email/phone through this path.
 */
function normalizeEditableProfilePatch(input = {}) {
  const forbidden = [
    'email', 'phone', 'normalizedEmail', 'normalizedPhone',
    'customerAccountId', 'status', 'stripeCustomerId', 'mergedIntoAccountId',
  ];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
      return {
        ok: false,
        error: CONTACT_CHANGE_REQUIRES_VERIFICATION,
        message: 'Email and phone changes require a verified contact-change flow.',
        field: key,
      };
    }
  }

  const patch = {};

  if (Object.prototype.hasOwnProperty.call(input, 'firstName')) {
    patch.firstName = asPlainText(input.firstName, MAX_NAME_LEN);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'lastName')) {
    patch.lastName = asPlainText(input.lastName, MAX_NAME_LEN);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'displayName')) {
    patch.displayName = asPlainText(input.displayName, MAX_DISPLAY_NAME_LEN);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'preferredContactChannel')) {
    const raw = input.preferredContactChannel;
    if (raw == null || raw === '') {
      patch.preferredContactChannel = null;
    } else {
      const channel = String(raw).trim().toLowerCase();
      if (!PREFERRED_CONTACT_CHANNELS.includes(channel)) {
        return {
          ok: false,
          error: VALIDATION_ERROR,
          message: 'preferredContactChannel must be one of: email, phone, sms, any.',
          field: 'preferredContactChannel',
        };
      }
      patch.preferredContactChannel = channel;
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'timezone')) {
    const raw = input.timezone;
    if (raw == null || raw === '') {
      patch.timezone = null;
    } else {
      const tz = String(raw).trim().slice(0, MAX_TIMEZONE_LEN);
      if (!isValidIanaTimezone(tz)) {
        return {
          ok: false,
          error: VALIDATION_ERROR,
          message: 'timezone must be a supported IANA timezone name.',
          field: 'timezone',
        };
      }
      patch.timezone = tz;
    }
  }

  if (!Object.keys(patch).length) {
    return {
      ok: false,
      error: VALIDATION_ERROR,
      message: 'No editable profile fields provided.',
    };
  }

  return { ok: true, patch };
}

function profileFieldsEqual(profile, patch) {
  if (!profile) return false;
  for (const [k, v] of Object.entries(patch)) {
    const cur = profile[k] == null || profile[k] === '' ? null : profile[k];
    const next = v == null || v === '' ? null : v;
    if (cur !== next) return false;
  }
  return true;
}

async function loadSafeProjection(customerAccountId, prisma) {
  const graph = await loadCustomerAccountGraph(customerAccountId, { prisma });
  if (!graph) return null;
  return assertSafeCustomerProjection(projectCustomerIdentity(graph));
}

/**
 * Load profile projection for the authenticated account only.
 * Disabled and merged accounts return the same not_found as missing accounts.
 */
async function getProfile(customerAccountId, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };
  if (!customerAccountId) return { ok: false, error: NOT_FOUND };

  // Ignore any caller-supplied alternate account id.
  void opts.browserCustomerAccountId;
  void opts.requestedCustomerAccountId;

  const graph = await loadCustomerAccountGraph(customerAccountId, { prisma });
  const gate = assertCustomerPortalAccountActive(graph);
  if (!gate.ok) return gate;

  const customer = assertSafeCustomerProjection(projectCustomerIdentity(graph));
  return { ok: true, customer };
}

/**
 * Update editable profile fields with optimistic concurrency.
 *
 * @param {{
 *   customerAccountId: string,
 *   expectedVersion: number,
 *   patch: object,
 *   requestId?: string,
 *   actor?: string,
 * }} input
 */
async function updateProfile(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };

  void input.browserCustomerAccountId;
  void input.customerAccountIdFromBrowser;

  const customerAccountId = String(input.customerAccountId || '').trim();
  if (!customerAccountId) return { ok: false, error: NOT_FOUND };

  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return {
      ok: false,
      error: VALIDATION_ERROR,
      message: 'expectedVersion is required.',
      field: 'expectedVersion',
    };
  }

  const normalized = normalizeEditableProfilePatch(input.patch || input);
  if (!normalized.ok) return normalized;
  const { patch } = normalized;
  const requestId = input.requestId ? String(input.requestId).trim().slice(0, 80) : null;
  const actor = input.actor || 'customer:portal';

  // Idempotent retry: same requestId already applied for this account.
  if (requestId) {
    try {
      const prior = await prisma.auditEvent.findMany({
        where: {
          actor,
          action: 'customer_profile_updated',
        },
      });
      const hit = prior.find((row) => {
        const d = row.detail || {};
        return d.requestId === requestId && d.customerAccountId === customerAccountId;
      });
      if (hit) {
        const graph = await loadCustomerAccountGraph(customerAccountId, { prisma });
        const gate = assertCustomerPortalAccountActive(graph);
        if (!gate.ok) return gate;
        const customer = assertSafeCustomerProjection(projectCustomerIdentity(graph));
        return {
          ok: true,
          idempotent: true,
          customer,
          accountVersion: customer?.accountVersion,
        };
      }
    } catch {
      // Fall through to transactional update.
    }
  }

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({
        where: { id: customerAccountId },
        include: { profile: true },
      });
      const gate = assertCustomerPortalAccountActive(account);
      if (!gate.ok) return gate;
      if (account.version !== expectedVersion) {
        return {
          ok: false,
          error: VERSION_CONFLICT,
          actualVersion: account.version,
          message: 'Profile was updated elsewhere. Reload and try again.',
        };
      }

      // No-op patch against current values: still succeed without bumping version
      // when the client retries an already-applied change under the new version.
      if (profileFieldsEqual(account.profile, patch)) {
        return {
          ok: true,
          unchanged: true,
          accountVersion: account.version,
        };
      }

      if (!account.profile) {
        return { ok: false, error: NOT_FOUND, message: 'profile_missing' };
      }

      await tx.customerProfile.update({
        where: { customerAccountId },
        data: {
          ...patch,
          updatedAt: new Date().toISOString(),
        },
      });

      const nextVersion = account.version + 1;
      const bumped = await tx.customerAccount.updateMany({
        where: { id: customerAccountId, version: account.version },
        data: {
          version: nextVersion,
          updatedAt: new Date().toISOString(),
        },
      });
      if (!bumped || bumped.count !== 1) {
        const err = new Error('version_conflict');
        err.code = VERSION_CONFLICT;
        err.actualVersion = null;
        throw err;
      }

      await emitIdentityAudit(tx, {
        actor,
        action: 'customer_profile_updated',
        detail: {
          customerAccountId,
          requestId,
          fields: Object.keys(patch),
          fromVersion: account.version,
          toVersion: nextVersion,
        },
      });

      return { ok: true, accountVersion: nextVersion };
    });

    if (!result.ok) return result;

    const customer = await loadSafeProjection(customerAccountId, prisma);
    return {
      ok: true,
      unchanged: !!result.unchanged,
      customer,
      accountVersion: result.accountVersion,
    };
  } catch (err) {
    if (err && err.code === VERSION_CONFLICT) {
      return {
        ok: false,
        error: VERSION_CONFLICT,
        actualVersion: err.actualVersion,
        message: 'Profile was updated elsewhere. Reload and try again.',
      };
    }
    return {
      ok: false,
      error: UNAVAILABLE,
      message: 'profile_update_failed',
    };
  }
}

module.exports = {
  PREFERRED_CONTACT_CHANNELS,
  VERSION_CONFLICT,
  VALIDATION_ERROR,
  NOT_FOUND,
  UNAVAILABLE,
  CONTACT_CHANGE_REQUIRES_VERIFICATION,
  normalizeEditableProfilePatch,
  isValidIanaTimezone,
  getProfile,
  updateProfile,
  setPrismaForTests,
};
