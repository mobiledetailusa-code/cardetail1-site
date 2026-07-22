/**
 * Customer Address service (Stage 2A).
 *
 * Account-scoped service addresses. Soft-archive via archivedAt — never hard
 * delete. Exactly zero or one active default per account, enforced inside
 * PostgreSQL transactions. Browser-supplied account/address ownership is
 * ignored; address IDs must belong to the authenticated account.
 *
 * Archiving the default address leaves no automatic replacement (deterministic).
 */

const crypto = require('crypto');
const { tryGetPrisma } = require('./prisma');
const {
  emitIdentityAudit,
  loadCustomerAccountGraph,
} = require('./customer-account-service');
const {
  projectCustomerIdentity,
  projectAddresses,
  assertSafeCustomerProjection,
} = require('./customer-identity-projection');

const VERSION_CONFLICT = 'version_conflict';
const VALIDATION_ERROR = 'validation_error';
const NOT_FOUND = 'not_found';
const UNAVAILABLE = 'unavailable';
const FORBIDDEN = 'forbidden';

const MAX_LABEL = 60;
const MAX_LINE = 120;
const MAX_CITY = 80;
const MAX_STATE = 40;
const MAX_POSTAL = 20;
const MAX_COUNTRY = 2;

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
  let s = String(raw)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function normalizeAddressFields(input = {}, { partial = false } = {}) {
  const out = {};

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'label')) {
    out.label = asPlainText(input.label, MAX_LABEL);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'line1')) {
    const line1 = asPlainText(input.line1, MAX_LINE);
    if (!line1) {
      return { ok: false, error: VALIDATION_ERROR, message: 'line1 is required.', field: 'line1' };
    }
    out.line1 = line1;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'line2')) {
    out.line2 = asPlainText(input.line2, MAX_LINE);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'city')) {
    out.city = asPlainText(input.city, MAX_CITY);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'state')) {
    out.state = asPlainText(input.state, MAX_STATE);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'postalCode')) {
    out.postalCode = asPlainText(input.postalCode, MAX_POSTAL);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'country')) {
    const country = asPlainText(input.country, MAX_COUNTRY);
    out.country = (country || 'US').toUpperCase();
    if (!/^[A-Z]{2}$/.test(out.country)) {
      return { ok: false, error: VALIDATION_ERROR, message: 'country must be a 2-letter code.', field: 'country' };
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'isDefault')) {
    out.isDefault = !!input.isDefault;
  }

  return { ok: true, fields: out };
}

function addressFingerprint(fields) {
  const parts = [
    fields.label || '',
    fields.line1 || '',
    fields.line2 || '',
    fields.city || '',
    fields.state || '',
    fields.postalCode || '',
    fields.country || 'US',
  ].map((p) => String(p).trim().toLowerCase());
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

async function loadSafeProjection(customerAccountId, prisma) {
  const graph = await loadCustomerAccountGraph(customerAccountId, { prisma });
  if (!graph) return null;
  return assertSafeCustomerProjection(projectCustomerIdentity(graph));
}

async function requireOwnedAddress(tx, { customerAccountId, addressId, includeArchived = false }) {
  const row = await tx.customerAddress.findUnique({ where: { id: String(addressId) } });
  if (!row || row.customerAccountId !== customerAccountId) {
    // Generic not-found for cross-account access — do not reveal ownership.
    return { ok: false, error: NOT_FOUND };
  }
  if (!includeArchived && row.archivedAt) {
    return { ok: false, error: NOT_FOUND };
  }
  return { ok: true, address: row };
}

function versionConflictError(actualVersion = null) {
  const err = new Error('version_conflict');
  err.code = VERSION_CONFLICT;
  err.actualVersion = actualVersion;
  return err;
}

async function claimNextAccountVersion(tx, account) {
  const nextVersion = account.version + 1;
  const bumped = await tx.customerAccount.updateMany({
    where: { id: account.id, version: account.version },
    data: {
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    },
  });
  if (!bumped || bumped.count !== 1) {
    throw versionConflictError(null);
  }
  return nextVersion;
}

function mapTxnError(err, fallbackMessage) {
  if (err && err.code === VERSION_CONFLICT) {
    return {
      ok: false,
      error: VERSION_CONFLICT,
      actualVersion: err.actualVersion,
      message: 'Account changed elsewhere. Reload and try again.',
    };
  }
  return { ok: false, error: UNAVAILABLE, message: fallbackMessage };
}

async function clearOtherDefaults(tx, customerAccountId, exceptId) {
  const active = await tx.customerAddress.findMany({
    where: {
      customerAccountId,
      archivedAt: null,
      isDefault: true,
    },
  });
  for (const row of active) {
    if (exceptId && row.id === exceptId) continue;
    await tx.customerAddress.update({
      where: { id: row.id },
      data: { isDefault: false, updatedAt: new Date().toISOString() },
    });
  }
}

async function listAddresses(customerAccountId, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };
  if (!customerAccountId) return { ok: false, error: NOT_FOUND };
  void opts.browserCustomerAccountId;

  const rows = await prisma.customerAddress.findMany({
    where: { customerAccountId: String(customerAccountId), archivedAt: null },
  });
  // Stable order: default first, then createdAt.
  rows.sort((a, b) => {
    if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? -1 : 1;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });

  const customer = await loadSafeProjection(customerAccountId, prisma);
  return {
    ok: true,
    addresses: projectAddresses(rows),
    defaultAddressId: rows.find((a) => a.isDefault)?.id || null,
    accountVersion: customer?.accountVersion || null,
    customer,
  };
}

async function createAddress(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };

  void input.browserCustomerAccountId;
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

  const normalized = normalizeAddressFields(input.address || input, { partial: false });
  if (!normalized.ok) return normalized;
  const fields = normalized.fields;
  const wantDefault = fields.isDefault === true;
  delete fields.isDefault;

  const requestId = input.requestId ? String(input.requestId).trim().slice(0, 80) : null;
  const actor = input.actor || 'customer:portal';
  const fingerprint = addressFingerprint(fields);

  if (requestId) {
    try {
      const prior = await prisma.auditEvent.findMany({
        where: { actor, action: 'customer_address_created' },
      });
      const hit = prior.find((row) => {
        const d = row.detail || {};
        return d.requestId === requestId && d.customerAccountId === customerAccountId;
      });
      if (hit?.detail?.addressId) {
        const customer = await loadSafeProjection(customerAccountId, prisma);
        return {
          ok: true,
          idempotent: true,
          addressId: hit.detail.addressId,
          customer,
          accountVersion: customer?.accountVersion,
        };
      }
    } catch { /* continue */ }
  }

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId } });
      if (!account || account.status === 'merged' || account.status === 'disabled') {
        return { ok: false, error: NOT_FOUND };
      }
      if (account.version !== expectedVersion) {
        throw versionConflictError(account.version);
      }

      // Exact active duplicate → return existing (retry-safe without version bump).
      const active = await tx.customerAddress.findMany({
        where: { customerAccountId, archivedAt: null },
      });
      const dup = active.find((a) => addressFingerprint(a) === fingerprint);
      if (dup) {
        if (wantDefault && !dup.isDefault) {
          await clearOtherDefaults(tx, customerAccountId, dup.id);
          await tx.customerAddress.update({
            where: { id: dup.id },
            data: { isDefault: true, updatedAt: new Date().toISOString() },
          });
          const nextVersion = await claimNextAccountVersion(tx, account);
          await emitIdentityAudit(tx, {
            actor,
            action: 'customer_address_default_set',
            detail: {
              customerAccountId,
              addressId: dup.id,
              requestId,
              fromVersion: account.version,
              toVersion: nextVersion,
            },
          });
          return { ok: true, addressId: dup.id, accountVersion: nextVersion, deduped: true };
        }
        return { ok: true, addressId: dup.id, accountVersion: account.version, deduped: true, unchanged: true };
      }

      const makeDefault = wantDefault || active.length === 0;
      if (makeDefault) {
        await clearOtherDefaults(tx, customerAccountId, null);
      }

      const created = await tx.customerAddress.create({
        data: {
          customerAccountId,
          ...fields,
          isDefault: makeDefault,
        },
      });

      const nextVersion = await claimNextAccountVersion(tx, account);
      await emitIdentityAudit(tx, {
        actor,
        action: 'customer_address_created',
        detail: {
          customerAccountId,
          addressId: created.id,
          requestId,
          fingerprint,
          isDefault: makeDefault,
          fromVersion: account.version,
          toVersion: nextVersion,
        },
      });

      return { ok: true, addressId: created.id, accountVersion: nextVersion };
    });

    if (!result.ok) return result;
    const customer = await loadSafeProjection(customerAccountId, prisma);
    return {
      ok: true,
      addressId: result.addressId,
      deduped: !!result.deduped,
      unchanged: !!result.unchanged,
      customer,
      accountVersion: result.accountVersion,
    };
  } catch (err) {
    return mapTxnError(err, 'address_create_failed');
  }
}

async function updateAddress(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };

  void input.browserCustomerAccountId;
  const customerAccountId = String(input.customerAccountId || '').trim();
  const addressId = String(input.addressId || '').trim();
  if (!customerAccountId || !addressId) return { ok: false, error: NOT_FOUND };

  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return {
      ok: false,
      error: VALIDATION_ERROR,
      message: 'expectedVersion is required.',
      field: 'expectedVersion',
    };
  }

  const normalized = normalizeAddressFields(input.address || input, { partial: true });
  if (!normalized.ok) return normalized;
  const fields = { ...normalized.fields };
  const wantDefault = Object.prototype.hasOwnProperty.call(fields, 'isDefault')
    ? fields.isDefault === true
    : null;
  delete fields.isDefault;

  if (!Object.keys(fields).length && wantDefault == null) {
    return { ok: false, error: VALIDATION_ERROR, message: 'No address fields to update.' };
  }

  const requestId = input.requestId ? String(input.requestId).trim().slice(0, 80) : null;
  const actor = input.actor || 'customer:portal';

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId } });
      if (!account || account.status === 'merged' || account.status === 'disabled') {
        return { ok: false, error: NOT_FOUND };
      }
      if (account.version !== expectedVersion) {
        throw versionConflictError(account.version);
      }

      const owned = await requireOwnedAddress(tx, { customerAccountId, addressId });
      if (!owned.ok) return owned;

      if (Object.keys(fields).length) {
        await tx.customerAddress.update({
          where: { id: addressId },
          data: { ...fields, updatedAt: new Date().toISOString() },
        });
      }

      if (wantDefault === true) {
        await clearOtherDefaults(tx, customerAccountId, addressId);
        await tx.customerAddress.update({
          where: { id: addressId },
          data: { isDefault: true, updatedAt: new Date().toISOString() },
        });
      }

      const nextVersion = await claimNextAccountVersion(tx, account);
      await emitIdentityAudit(tx, {
        actor,
        action: 'customer_address_updated',
        detail: {
          customerAccountId,
          addressId,
          requestId,
          fields: Object.keys(fields),
          setDefault: wantDefault === true,
          fromVersion: account.version,
          toVersion: nextVersion,
        },
      });

      return { ok: true, addressId, accountVersion: nextVersion };
    });

    if (!result.ok) return result;
    const customer = await loadSafeProjection(customerAccountId, prisma);
    return {
      ok: true,
      addressId: result.addressId,
      customer,
      accountVersion: result.accountVersion,
    };
  } catch (err) {
    return mapTxnError(err, 'address_update_failed');
  }
}

/**
 * Soft-archive. If the archived address was default, no replacement is selected
 * automatically (deterministic Stage 2A policy).
 */
async function archiveAddress(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };

  void input.browserCustomerAccountId;
  const customerAccountId = String(input.customerAccountId || '').trim();
  const addressId = String(input.addressId || '').trim();
  if (!customerAccountId || !addressId) return { ok: false, error: NOT_FOUND };

  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return {
      ok: false,
      error: VALIDATION_ERROR,
      message: 'expectedVersion is required.',
      field: 'expectedVersion',
    };
  }

  const requestId = input.requestId ? String(input.requestId).trim().slice(0, 80) : null;
  const actor = input.actor || 'customer:portal';

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId } });
      if (!account || account.status === 'merged' || account.status === 'disabled') {
        return { ok: false, error: NOT_FOUND };
      }
      if (account.version !== expectedVersion) {
        throw versionConflictError(account.version);
      }

      const owned = await requireOwnedAddress(tx, {
        customerAccountId,
        addressId,
        includeArchived: true,
      });
      if (!owned.ok) return owned;

      if (owned.address.archivedAt) {
        return {
          ok: true,
          addressId,
          accountVersion: account.version,
          unchanged: true,
          wasDefault: false,
        };
      }

      const wasDefault = !!owned.address.isDefault;
      await tx.customerAddress.update({
        where: { id: addressId },
        data: {
          archivedAt: new Date().toISOString(),
          isDefault: false,
          updatedAt: new Date().toISOString(),
        },
      });

      // Deterministic: do NOT auto-promote another address as default.
      const nextVersion = await claimNextAccountVersion(tx, account);
      await emitIdentityAudit(tx, {
        actor,
        action: 'customer_address_archived',
        detail: {
          customerAccountId,
          addressId,
          requestId,
          wasDefault,
          replacementPolicy: 'none',
          fromVersion: account.version,
          toVersion: nextVersion,
        },
      });

      return { ok: true, addressId, accountVersion: nextVersion, wasDefault };
    });

    if (!result.ok) return result;
    const customer = await loadSafeProjection(customerAccountId, prisma);
    return {
      ok: true,
      addressId: result.addressId,
      wasDefault: !!result.wasDefault,
      unchanged: !!result.unchanged,
      customer,
      accountVersion: result.accountVersion,
    };
  } catch (err) {
    return mapTxnError(err, 'address_archive_failed');
  }
}

async function setDefaultAddress(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };

  void input.browserCustomerAccountId;
  const customerAccountId = String(input.customerAccountId || '').trim();
  const addressId = String(input.addressId || '').trim();
  if (!customerAccountId || !addressId) return { ok: false, error: NOT_FOUND };

  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return {
      ok: false,
      error: VALIDATION_ERROR,
      message: 'expectedVersion is required.',
      field: 'expectedVersion',
    };
  }

  const requestId = input.requestId ? String(input.requestId).trim().slice(0, 80) : null;
  const actor = input.actor || 'customer:portal';

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId } });
      if (!account || account.status === 'merged' || account.status === 'disabled') {
        return { ok: false, error: NOT_FOUND };
      }
      if (account.version !== expectedVersion) {
        throw versionConflictError(account.version);
      }

      const owned = await requireOwnedAddress(tx, { customerAccountId, addressId });
      if (!owned.ok) return owned;

      if (owned.address.isDefault) {
        return { ok: true, addressId, accountVersion: account.version, unchanged: true };
      }

      // Claim version first so concurrent set-default losers roll back cleanly.
      const nextVersion = await claimNextAccountVersion(tx, account);

      await clearOtherDefaults(tx, customerAccountId, addressId);
      await tx.customerAddress.update({
        where: { id: addressId },
        data: { isDefault: true, updatedAt: new Date().toISOString() },
      });

      await emitIdentityAudit(tx, {
        actor,
        action: 'customer_address_default_set',
        detail: {
          customerAccountId,
          addressId,
          requestId,
          fromVersion: account.version,
          toVersion: nextVersion,
        },
      });

      return { ok: true, addressId, accountVersion: nextVersion };
    });

    if (!result.ok) return result;
    const customer = await loadSafeProjection(customerAccountId, prisma);
    return {
      ok: true,
      addressId: result.addressId,
      unchanged: !!result.unchanged,
      customer,
      accountVersion: result.accountVersion,
    };
  } catch (err) {
    return mapTxnError(err, 'address_default_failed');
  }
}

module.exports = {
  VERSION_CONFLICT,
  VALIDATION_ERROR,
  NOT_FOUND,
  UNAVAILABLE,
  FORBIDDEN,
  normalizeAddressFields,
  listAddresses,
  createAddress,
  updateAddress,
  archiveAddress,
  setDefaultAddress,
  setPrismaForTests,
};
