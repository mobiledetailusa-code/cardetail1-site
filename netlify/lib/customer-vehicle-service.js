/**
 * Customer Vehicle service (Stage 2B).
 *
 * Account-scoped saved garage vehicles. Soft-archive via archivedAt — never
 * hard delete. Exactly zero or one active default per account, enforced inside
 * PostgreSQL transactions. Browser-supplied account/vehicle ownership is
 * ignored; vehicle IDs must belong to the authenticated account.
 *
 * Default policy: archiving the current default promotes the oldest remaining
 * active vehicle (createdAt ASC). If none remain, the account has no default.
 *
 * Legacy Blob (cd1-customer-vehicles) is a read-only import source. After
 * vehiclesImportedAt is set, PostgreSQL is the sole live authority. Blob
 * records are never deleted or written by this service.
 */

const crypto = require('crypto');
const { tryGetPrisma } = require('./prisma');
const {
  emitIdentityAudit,
  loadCustomerAccountGraph,
  assertCustomerPortalAccountActive,
  normalizePhone,
} = require('./customer-account-service');
const {
  ALLOWED_CATEGORIES,
  LEGACY_SOURCE_UNAVAILABLE,
  normalizeLegacyVehicleFields,
  readLegacyVehiclesForPhone,
} = require('./customer-vehicles-legacy');

const VERSION_CONFLICT = 'version_conflict';
const VALIDATION_ERROR = 'validation_error';
const NOT_FOUND = 'not_found';
const UNAVAILABLE = 'unavailable';
const TEMPORARILY_UNAVAILABLE = 'temporarily_unavailable';

const MAX_LABEL = 120;
const MAX_COLOR = 40;
const MAX_NOTES = 500;
const MAX_YEAR = 4;
const MAX_MAKE = 60;
const MAX_MODEL = 60;

/** @type {any} */
let prismaOverrideForTests = null;
/** @type {null | ((phone: string) => Promise<{ ok: boolean, vehicles: any[] }>)} */
let legacyReaderForTests = null;

function setPrismaForTests(client) {
  prismaOverrideForTests = client || null;
}

function setLegacyReaderForTests(fn) {
  legacyReaderForTests = typeof fn === 'function' ? fn : null;
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

function advisoryLockSql(key) {
  const hex = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 15);
  const n = BigInt(`0x${hex}`);
  const signed = n > 0x7fffffffffffffffn ? n - 0x10000000000000000n : n;
  return signed.toString();
}

function legacySourceIdFor(legacyId) {
  const id = String(legacyId || '').trim().slice(0, 80);
  if (!id) return null;
  return `blob:${id}`;
}

function normalizeVehicleFields(input = {}, { partial = false } = {}) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};

  if (!partial || Object.prototype.hasOwnProperty.call(src, 'label')
    || Object.prototype.hasOwnProperty.call(src, 'vehicleLabel')) {
    out.label = asPlainText(src.label ?? src.vehicleLabel, MAX_LABEL);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(src, 'category')
    || Object.prototype.hasOwnProperty.call(src, 'vehicleCategory')) {
    const category = String(src.category || src.vehicleCategory || 'car').toLowerCase().trim();
    out.category = ALLOWED_CATEGORIES.has(category) ? category : 'car';
  }
  if (!partial || Object.prototype.hasOwnProperty.call(src, 'color')) {
    out.color = asPlainText(src.color, MAX_COLOR);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(src, 'notes')) {
    out.notes = asPlainText(src.notes, MAX_NOTES);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(src, 'year')) {
    const year = asPlainText(src.year, MAX_YEAR);
    if (year && !/^\d{4}$/.test(year)) {
      return { ok: false, error: VALIDATION_ERROR, message: 'year must be a 4-digit year.', field: 'year' };
    }
    out.year = year;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(src, 'make')) {
    out.make = asPlainText(src.make, MAX_MAKE);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(src, 'model')) {
    out.model = asPlainText(src.model, MAX_MODEL);
  }
  if (Object.prototype.hasOwnProperty.call(src, 'isDefault')) {
    out.isDefault = !!src.isDefault;
  }

  return { ok: true, fields: out };
}

function requireIdentityFields(fields) {
  if (fields.label || (fields.make && fields.model)) return null;
  return {
    ok: false,
    error: VALIDATION_ERROR,
    message: 'Vehicle label or make/model is required.',
    field: 'label',
  };
}

function projectVehicle(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label || null,
    category: row.category || null,
    year: row.year || null,
    make: row.make || null,
    model: row.model || null,
    color: row.color || null,
    notes: row.notes || null,
    isDefault: !!row.isDefault,
    archivedAt: row.archivedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

/**
 * Chronological compare for Prisma DateTime values (Date or ISO string).
 * Invalid/unparseable timestamps sort last (never NaN-unstable).
 * Tie-break: id ascending.
 */
function createdAtTimestamp(value) {
  if (value == null || value === '') return Number.POSITIVE_INFINITY;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function compareCreatedAtAsc(a, b) {
  const timeA = createdAtTimestamp(a?.createdAt);
  const timeB = createdAtTimestamp(b?.createdAt);
  if (timeA !== timeB) return timeA - timeB;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

/**
 * Active list UI contract: default first, then createdAt ASC, id ASC.
 */
function sortActiveVehicles(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a, b) => {
    if (!!a.isDefault !== !!b.isDefault) return a.isDefault ? -1 : 1;
    return compareCreatedAtAsc(a, b);
  });
  return list;
}

async function requireOwnedVehicle(tx, { customerAccountId, vehicleId, includeArchived = false }) {
  const row = await tx.customerVehicle.findUnique({ where: { id: String(vehicleId) } });
  if (!row || row.customerAccountId !== customerAccountId) {
    return { ok: false, error: NOT_FOUND };
  }
  if (!includeArchived && row.archivedAt) {
    return { ok: false, error: NOT_FOUND };
  }
  return { ok: true, vehicle: row };
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
  if (err && err.code === LEGACY_SOURCE_UNAVAILABLE) {
    return {
      ok: false,
      error: TEMPORARILY_UNAVAILABLE,
      message: 'Vehicle garage is temporarily unavailable. Try again shortly.',
    };
  }
  return { ok: false, error: UNAVAILABLE, message: fallbackMessage };
}

async function clearOtherDefaults(tx, customerAccountId, exceptId) {
  const active = await tx.customerVehicle.findMany({
    where: {
      customerAccountId,
      archivedAt: null,
      isDefault: true,
    },
  });
  for (const row of active) {
    if (exceptId && row.id === exceptId) continue;
    await tx.customerVehicle.update({
      where: { id: row.id },
      data: { isDefault: false, updatedAt: new Date().toISOString() },
    });
  }
}

/**
 * Promote oldest remaining active vehicle after default archive.
 * Deterministic: createdAt ASC, then id ASC (DB orderBy + in-memory safety net).
 */
async function promoteOldestActiveDefault(tx, customerAccountId) {
  const remaining = await tx.customerVehicle.findMany({
    where: { customerAccountId, archivedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!remaining.length) return null;
  // Safety net for test doubles / drivers that ignore orderBy.
  remaining.sort(compareCreatedAtAsc);
  const next = remaining[0];
  await clearOtherDefaults(tx, customerAccountId, null);
  await tx.customerVehicle.update({
    where: { id: next.id },
    data: { isDefault: true, updatedAt: new Date().toISOString() },
  });
  return next.id;
}

async function readLegacyForImport(phoneDigits) {
  if (legacyReaderForTests) {
    return legacyReaderForTests(phoneDigits);
  }
  return readLegacyVehiclesForPhone(phoneDigits);
}

/**
 * Idempotent migrate-on-access. Sets vehiclesImportedAt even when Blob is empty
 * or phone is missing (nothing to import). Never writes Blob.
 */
async function importLegacyVehiclesForAccount(customerAccountId, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };
  if (!customerAccountId) return { ok: false, error: NOT_FOUND };

  const account = await prisma.customerAccount.findUnique({
    where: { id: String(customerAccountId) },
    include: { profile: true },
  });
  const gate = assertCustomerPortalAccountActive(account);
  if (!gate.ok) return gate;

  if (account.vehiclesImportedAt) {
    return {
      ok: true,
      imported: false,
      alreadyImported: true,
      importedCount: 0,
      accountVersion: account.version,
    };
  }

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.customerAccount.findUnique({
        where: { id: String(customerAccountId) },
        include: { profile: true },
      });
      const g2 = assertCustomerPortalAccountActive(locked);
      if (!g2.ok) return g2;

      if (typeof tx.$executeRawUnsafe === 'function') {
        const lockId = advisoryLockSql(`vehicle-import:${customerAccountId}`);
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${lockId})`);
      }

      const again = await tx.customerAccount.findUnique({ where: { id: String(customerAccountId) } });
      if (again?.vehiclesImportedAt) {
        return {
          ok: true,
          imported: false,
          alreadyImported: true,
          importedCount: 0,
          accountVersion: again.version,
        };
      }

      const phoneDigits = normalizePhone(locked.profile?.normalizedPhone || locked.profile?.phone || '')
        || normalizePhone(opts.phoneDigits || '');

      let legacyVehicles = [];
      if (phoneDigits) {
        // Propagate Blob source failures so the transaction rolls back and
        // vehiclesImportedAt is NOT committed (retry on next access).
        const legacy = await readLegacyForImport(phoneDigits);
        if (!legacy || legacy.ok === false) {
          const err = new Error(LEGACY_SOURCE_UNAVAILABLE);
          err.code = LEGACY_SOURCE_UNAVAILABLE;
          err.causeCode = legacy?.error || 'legacy_reader_failed';
          throw err;
        }
        legacyVehicles = Array.isArray(legacy.vehicles) ? legacy.vehicles : [];
      }

      let importedCount = 0;
      let firstActiveId = null;
      for (const raw of legacyVehicles) {
        if (!raw || raw.archived || raw.archivedAt) continue;
        const legacyId = String(raw.id || '').trim();
        const sourceId = legacySourceIdFor(legacyId);
        if (!sourceId) continue;

        const existing = await tx.customerVehicle.findFirst({
          where: { customerAccountId: String(customerAccountId), legacySourceId: sourceId },
        });
        if (existing) {
          if (!existing.archivedAt && !firstActiveId) firstActiveId = existing.id;
          continue;
        }

        const normalized = normalizeLegacyVehicleFields(raw);
        if (!normalized.label && !(normalized.make && normalized.model)) continue;

        const created = await tx.customerVehicle.create({
          data: {
            customerAccountId: String(customerAccountId),
            label: normalized.label || null,
            category: normalized.category || 'car',
            year: normalized.year || null,
            make: normalized.make || null,
            model: normalized.model || null,
            color: normalized.color || null,
            notes: normalized.notes || null,
            isDefault: false,
            archivedAt: null,
            legacySourceId: sourceId,
          },
        });
        importedCount += 1;
        if (!firstActiveId) firstActiveId = created.id;
      }

      const activeDefaults = await tx.customerVehicle.findMany({
        where: {
          customerAccountId: String(customerAccountId),
          archivedAt: null,
          isDefault: true,
        },
      });
      if (!activeDefaults.length && firstActiveId) {
        await tx.customerVehicle.update({
          where: { id: firstActiveId },
          data: { isDefault: true, updatedAt: new Date().toISOString() },
        });
      }

      const nextVersion = await claimNextAccountVersion(tx, again || locked);
      await tx.customerAccount.update({
        where: { id: String(customerAccountId) },
        data: {
          vehiclesImportedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      await emitIdentityAudit(tx, {
        actor: opts.actor || 'system:vehicle-import',
        action: 'customer_vehicle.legacy_imported',
        detail: {
          customerAccountId: String(customerAccountId),
          importedCount,
          hadPhone: !!phoneDigits,
        },
      });

      return {
        ok: true,
        imported: importedCount > 0,
        alreadyImported: false,
        importedCount,
        accountVersion: nextVersion,
      };
    });

    return result;
  } catch (err) {
    return mapTxnError(err, 'vehicle_import_failed');
  }
}

async function ensureVehiclesImported(customerAccountId, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma || !customerAccountId) return { ok: false, error: NOT_FOUND };
  const account = await prisma.customerAccount.findUnique({
    where: { id: String(customerAccountId) },
  });
  const gate = assertCustomerPortalAccountActive(account);
  if (!gate.ok) return gate;
  if (account.vehiclesImportedAt) {
    return { ok: true, alreadyImported: true, accountVersion: account.version };
  }
  return importLegacyVehiclesForAccount(customerAccountId, opts);
}

/**
 * Mutations must not be bricked when legacy Blob import is temporarily down.
 * Import remains best-effort migrate-on-access for list/read; writes may proceed
 * and import will retry on a later successful read.
 */
async function ensureVehiclesImportedForMutation(customerAccountId, opts = {}) {
  const ensured = await ensureVehiclesImported(customerAccountId, opts);
  if (ensured.ok) return ensured;
  if (
    ensured.error === TEMPORARILY_UNAVAILABLE
    || ensured.error === UNAVAILABLE
    || ensured.error === 'temporarily_unavailable'
    || ensured.error === 'unavailable'
  ) {
    return {
      ok: true,
      skippedImport: true,
      accountVersion: ensured.accountVersion || null,
    };
  }
  return ensured;
}

async function listVehicles(customerAccountId, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };
  if (!customerAccountId) return { ok: false, error: NOT_FOUND };
  void opts.browserCustomerAccountId;

  const ensured = await ensureVehiclesImported(customerAccountId, opts);
  let importSoftSkipped = false;
  if (!ensured.ok) {
    // Blob import outage: still return PostgreSQL vehicles so the garage remains usable.
    if (
      ensured.error === TEMPORARILY_UNAVAILABLE
      || ensured.error === UNAVAILABLE
      || ensured.error === 'temporarily_unavailable'
      || ensured.error === 'unavailable'
    ) {
      importSoftSkipped = true;
    } else {
      return ensured;
    }
  }

  const graph = await loadCustomerAccountGraph(customerAccountId, { prisma });
  const gate = assertCustomerPortalAccountActive(graph);
  if (!gate.ok) return gate;

  const rows = await prisma.customerVehicle.findMany({
    where: { customerAccountId: String(customerAccountId), archivedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  const vehicles = sortActiveVehicles(rows).map(projectVehicle);
  return {
    ok: true,
    vehicles,
    defaultVehicleId: vehicles.find((v) => v.isDefault)?.id || null,
    accountVersion: graph.version,
    import: {
      completed: !importSoftSkipped && (
        !!graph.vehiclesImportedAt || !!ensured.alreadyImported || ensured.imported === true
        || ensured.alreadyImported === true
      ),
      softSkipped: importSoftSkipped || undefined,
    },
  };
}

async function createVehicle(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };

  void input.browserCustomerAccountId;
  const customerAccountId = String(input.customerAccountId || '').trim();
  if (!customerAccountId) return { ok: false, error: NOT_FOUND };

  const ensured = await ensureVehiclesImportedForMutation(customerAccountId, opts);
  if (!ensured.ok) return ensured;

  const normalized = normalizeVehicleFields(input.vehicle || input, { partial: false });
  if (!normalized.ok) return normalized;
  const identityErr = requireIdentityFields(normalized.fields);
  if (identityErr) return identityErr;

  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return {
      ok: false,
      error: VALIDATION_ERROR,
      message: 'expectedVersion is required.',
      field: 'expectedVersion',
    };
  }

  const actor = input.actor || 'customer:portal';
  const requestId = input.requestId ? String(input.requestId).trim().slice(0, 80) : null;

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      if (requestId) {
        // Best-effort idempotency via audit scan is not required; requestId is logged only.
      }
      const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId } });
      const gate = assertCustomerPortalAccountActive(account);
      if (!gate.ok) return gate;
      if (account.version !== expectedVersion) {
        throw versionConflictError(account.version);
      }

      const activeCount = await tx.customerVehicle.findMany({
        where: { customerAccountId, archivedAt: null },
      });
      const wantDefault = normalized.fields.isDefault === true || activeCount.length === 0;

      const nextVersion = await claimNextAccountVersion(tx, account);
      if (wantDefault) {
        await clearOtherDefaults(tx, customerAccountId, null);
      }

      const created = await tx.customerVehicle.create({
        data: {
          customerAccountId,
          label: normalized.fields.label || null,
          category: normalized.fields.category || 'car',
          year: normalized.fields.year || null,
          make: normalized.fields.make || null,
          model: normalized.fields.model || null,
          color: normalized.fields.color || null,
          notes: normalized.fields.notes || null,
          isDefault: wantDefault,
          archivedAt: null,
          legacySourceId: null,
        },
      });

      await emitIdentityAudit(tx, {
        actor,
        action: 'customer_vehicle.created',
        detail: {
          customerAccountId,
          vehicleId: created.id,
          category: created.category,
          isDefault: created.isDefault,
          requestId,
        },
      });

      return {
        ok: true,
        vehicleId: created.id,
        vehicle: projectVehicle(created),
        accountVersion: nextVersion,
      };
    });

    if (!result.ok) return result;
    return {
      ok: true,
      vehicleId: result.vehicleId,
      vehicle: result.vehicle,
      accountVersion: result.accountVersion,
    };
  } catch (err) {
    return mapTxnError(err, 'vehicle_create_failed');
  }
}

async function updateVehicle(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };

  void input.browserCustomerAccountId;
  const customerAccountId = String(input.customerAccountId || '').trim();
  const vehicleId = String(input.vehicleId || input.id || '').trim();
  if (!customerAccountId || !vehicleId) return { ok: false, error: NOT_FOUND };

  const ensured = await ensureVehiclesImportedForMutation(customerAccountId, opts);
  if (!ensured.ok) return ensured;

  const normalized = normalizeVehicleFields(input.vehicle || input, { partial: true });
  if (!normalized.ok) return normalized;

  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return {
      ok: false,
      error: VALIDATION_ERROR,
      message: 'expectedVersion is required.',
      field: 'expectedVersion',
    };
  }

  const actor = input.actor || 'customer:portal';

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId } });
      const gate = assertCustomerPortalAccountActive(account);
      if (!gate.ok) return gate;
      if (account.version !== expectedVersion) {
        throw versionConflictError(account.version);
      }

      const owned = await requireOwnedVehicle(tx, { customerAccountId, vehicleId });
      if (!owned.ok) return owned;

      const merged = {
        label: Object.prototype.hasOwnProperty.call(normalized.fields, 'label')
          ? normalized.fields.label : owned.vehicle.label,
        make: Object.prototype.hasOwnProperty.call(normalized.fields, 'make')
          ? normalized.fields.make : owned.vehicle.make,
        model: Object.prototype.hasOwnProperty.call(normalized.fields, 'model')
          ? normalized.fields.model : owned.vehicle.model,
      };
      const identityErr = requireIdentityFields(merged);
      if (identityErr) return identityErr;

      const data = { updatedAt: new Date().toISOString() };
      for (const key of ['label', 'category', 'year', 'make', 'model', 'color', 'notes']) {
        if (Object.prototype.hasOwnProperty.call(normalized.fields, key)) {
          data[key] = normalized.fields[key];
        }
      }

      const setDefault = normalized.fields.isDefault === true;
      const nextVersion = await claimNextAccountVersion(tx, account);
      if (setDefault) {
        await clearOtherDefaults(tx, customerAccountId, vehicleId);
        data.isDefault = true;
      }

      const updated = await tx.customerVehicle.update({
        where: { id: vehicleId },
        data,
      });

      await emitIdentityAudit(tx, {
        actor,
        action: 'customer_vehicle.updated',
        detail: {
          customerAccountId,
          vehicleId,
          fields: Object.keys(data).filter((k) => k !== 'updatedAt'),
        },
      });

      return {
        ok: true,
        vehicleId,
        vehicle: projectVehicle(updated),
        accountVersion: nextVersion,
      };
    });

    if (!result.ok) return result;
    return result;
  } catch (err) {
    return mapTxnError(err, 'vehicle_update_failed');
  }
}

async function archiveVehicle(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };

  void input.browserCustomerAccountId;
  const customerAccountId = String(input.customerAccountId || '').trim();
  const vehicleId = String(input.vehicleId || input.id || '').trim();
  if (!customerAccountId || !vehicleId) return { ok: false, error: NOT_FOUND };

  const ensured = await ensureVehiclesImportedForMutation(customerAccountId, opts);
  if (!ensured.ok) return ensured;

  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return {
      ok: false,
      error: VALIDATION_ERROR,
      message: 'expectedVersion is required.',
      field: 'expectedVersion',
    };
  }

  const actor = input.actor || 'customer:portal';

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId } });
      const gate = assertCustomerPortalAccountActive(account);
      if (!gate.ok) return gate;
      if (account.version !== expectedVersion) {
        throw versionConflictError(account.version);
      }

      const owned = await requireOwnedVehicle(tx, {
        customerAccountId,
        vehicleId,
        includeArchived: true,
      });
      if (!owned.ok) return owned;

      if (owned.vehicle.archivedAt) {
        return {
          ok: true,
          vehicleId,
          accountVersion: account.version,
          unchanged: true,
          promotedDefaultId: null,
        };
      }

      const wasDefault = !!owned.vehicle.isDefault;
      const nextVersion = await claimNextAccountVersion(tx, account);
      await tx.customerVehicle.update({
        where: { id: vehicleId },
        data: {
          archivedAt: new Date().toISOString(),
          isDefault: false,
          updatedAt: new Date().toISOString(),
        },
      });

      let promotedDefaultId = null;
      if (wasDefault) {
        promotedDefaultId = await promoteOldestActiveDefault(tx, customerAccountId);
      }

      await emitIdentityAudit(tx, {
        actor,
        action: 'customer_vehicle.archived',
        detail: {
          customerAccountId,
          vehicleId,
          wasDefault,
          promotedDefaultId,
        },
      });

      return {
        ok: true,
        vehicleId,
        accountVersion: nextVersion,
        wasDefault,
        promotedDefaultId,
      };
    });

    return result;
  } catch (err) {
    return mapTxnError(err, 'vehicle_archive_failed');
  }
}

async function setDefaultVehicle(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, error: UNAVAILABLE };

  void input.browserCustomerAccountId;
  const customerAccountId = String(input.customerAccountId || '').trim();
  const vehicleId = String(input.vehicleId || input.id || '').trim();
  if (!customerAccountId || !vehicleId) return { ok: false, error: NOT_FOUND };

  const ensured = await ensureVehiclesImportedForMutation(customerAccountId, opts);
  if (!ensured.ok) return ensured;

  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return {
      ok: false,
      error: VALIDATION_ERROR,
      message: 'expectedVersion is required.',
      field: 'expectedVersion',
    };
  }

  const actor = input.actor || 'customer:portal';

  if (typeof prisma.$transaction !== 'function') {
    return { ok: false, error: UNAVAILABLE, message: 'transaction_unavailable' };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({ where: { id: customerAccountId } });
      const gate = assertCustomerPortalAccountActive(account);
      if (!gate.ok) return gate;
      if (account.version !== expectedVersion) {
        throw versionConflictError(account.version);
      }

      const owned = await requireOwnedVehicle(tx, { customerAccountId, vehicleId });
      if (!owned.ok) return owned;

      if (owned.vehicle.isDefault) {
        return {
          ok: true,
          vehicleId,
          accountVersion: account.version,
          unchanged: true,
        };
      }

      const nextVersion = await claimNextAccountVersion(tx, account);
      await clearOtherDefaults(tx, customerAccountId, vehicleId);
      await tx.customerVehicle.update({
        where: { id: vehicleId },
        data: { isDefault: true, updatedAt: new Date().toISOString() },
      });

      await emitIdentityAudit(tx, {
        actor,
        action: 'customer_vehicle.default_set',
        detail: { customerAccountId, vehicleId },
      });

      return { ok: true, vehicleId, accountVersion: nextVersion };
    });

    return result;
  } catch (err) {
    return mapTxnError(err, 'vehicle_set_default_failed');
  }
}

module.exports = {
  VERSION_CONFLICT,
  VALIDATION_ERROR,
  NOT_FOUND,
  UNAVAILABLE,
  TEMPORARILY_UNAVAILABLE,
  LEGACY_SOURCE_UNAVAILABLE,
  ALLOWED_CATEGORIES,
  setPrismaForTests,
  setLegacyReaderForTests,
  ensureVehiclesImported,
  ensureVehiclesImportedForMutation,
  normalizeVehicleFields,
  projectVehicle,
  createdAtTimestamp,
  compareCreatedAtAsc,
  sortActiveVehicles,
  listVehicles,
  createVehicle,
  updateVehicle,
  archiveVehicle,
  setDefaultVehicle,
  importLegacyVehiclesForAccount,
  legacySourceIdFor,
};
