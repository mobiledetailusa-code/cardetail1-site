/**
 * In-memory Prisma-shaped store for Customer Identity Foundation unit tests.
 * Supports the subset of APIs used by customer-account-service.
 *
 * $transaction snapshots Maps and rolls back on throw so mid-transaction
 * failures leave no partial CustomerAccount / Profile / Booking / Audit rows.
 */

const crypto = require('crypto');

function cuid() {
  return `c${crypto.randomBytes(12).toString('hex')}`;
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function snapshotMaps(db) {
  const out = {};
  for (const [name, map] of Object.entries(db)) {
    out[name] = new Map([...map.entries()].map(([k, v]) => [k, clone(v)]));
  }
  return out;
}

function restoreMaps(db, snap) {
  for (const name of Object.keys(db)) {
    db[name].clear();
    for (const [k, v] of snap[name].entries()) {
      db[name].set(k, clone(v));
    }
  }
}

function matchesWhere(row, where) {
  if (!where || typeof where !== 'object') return true;
  if (where.OR) return where.OR.some((clause) => matchesWhere(row, clause));
  if (where.AND) return where.AND.every((clause) => matchesWhere(row, clause));
  for (const [key, expected] of Object.entries(where)) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, 'not')) {
        if (expected.not === null) {
          if (row[key] == null) return false;
        } else if (row[key] === expected.not) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(expected, 'in')) {
        if (!expected.in.includes(row[key])) return false;
        continue;
      }
    }
    if (row[key] !== expected) return false;
  }
  return true;
}

function createIdentityMemoryPrisma(options = {}) {
  const db = {
    customerAccount: new Map(),
    customerProfile: new Map(),
    customerAddress: new Map(),
    customerVehicle: new Map(),
    customerConsent: new Map(),
    booking: new Map(),
    auditEvent: new Map(),
    vehicle: new Map(),
  };

  const meta = {
    transactionCalls: 0,
    advisoryLockCalls: 0,
    advisoryLockIds: [],
    resolveContactDirectCalls: 0,
    failNextTransaction: null,
    failInsideTransactionAfter: null,
    failInsideTransactionRemaining: 0,
  };

  /** Serialize interactive transactions so concurrent callers cannot corrupt shared Maps. */
  let txnChain = Promise.resolve();

  const api = {
    _db: db,
    _meta: meta,
    /**
     * Test hooks — inject next $transaction failure (outer) or mid-callback failure.
     */
    failNextTransactionWith(err) {
      meta.failNextTransaction = err;
    },
    failInsideNextTransactionAfter(opsBeforeThrow, err) {
      meta.failInsideTransactionAfter = {
        ops: Math.max(0, Number(opsBeforeThrow) || 0),
        err: err || new Error('forced mid-transaction failure'),
      };
      meta.failInsideTransactionRemaining = meta.failInsideTransactionAfter.ops;
    },
    async $transaction(fn) {
      const run = async () => {
        meta.transactionCalls += 1;
        if (meta.failNextTransaction) {
          const err = meta.failNextTransaction;
          meta.failNextTransaction = null;
          throw err;
        }
        const snap = snapshotMaps(db);
        const txMeta = {
          opCount: 0,
          failAfter: meta.failInsideTransactionAfter,
        };
        meta.failInsideTransactionAfter = null;

        const tx = wrapTransactionalClient(api, db, txMeta);
        try {
          return await fn(tx);
        } catch (err) {
          restoreMaps(db, snap);
          throw err;
        }
      };
      const queued = txnChain.then(run, run);
      txnChain = queued.then(() => undefined, () => undefined);
      return queued;
    },
    async $executeRawUnsafe(sql) {
      const text = String(sql || '');
      if (/pg_advisory_xact_lock/i.test(text)) {
        meta.advisoryLockCalls += 1;
        const m = text.match(/pg_advisory_xact_lock\((-?\d+)\)/i);
        if (m) meta.advisoryLockIds.push(m[1]);
      }
      return 1;
    },
    customerAccount: modelHandlers('customerAccount'),
    customerProfile: modelHandlers('customerProfile'),
    customerAddress: modelHandlers('customerAddress'),
    customerVehicle: modelHandlers('customerVehicle'),
    customerConsent: modelHandlers('customerConsent'),
    booking: modelHandlers('booking'),
    auditEvent: modelHandlers('auditEvent'),
    vehicle: modelHandlers('vehicle'),
  };

  function noteWriteOp(txMeta) {
    if (!txMeta || !txMeta.failAfter) return;
    txMeta.opCount += 1;
    if (txMeta.opCount > txMeta.failAfter.ops) {
      const err = txMeta.failAfter.err;
      txMeta.failAfter = null;
      throw err;
    }
  }

  function modelHandlers(name) {
    return buildModelApi(name, db, null, noteWriteOp);
  }

  function wrapTransactionalClient(root, database, txMeta) {
    // Interactive tx client: no $transaction (mirrors Prisma). Writes share Maps
    // until outer $transaction rolls back on throw.
    return {
      _db: database,
      _meta: root._meta,
      _txMeta: txMeta,
      async $executeRawUnsafe(sql) {
        return root.$executeRawUnsafe(sql);
      },
      customerAccount: buildModelApi('customerAccount', database, txMeta, noteWriteOp),
      customerProfile: buildModelApi('customerProfile', database, txMeta, noteWriteOp),
      customerAddress: buildModelApi('customerAddress', database, txMeta, noteWriteOp),
      customerVehicle: buildModelApi('customerVehicle', database, txMeta, noteWriteOp),
      customerConsent: buildModelApi('customerConsent', database, txMeta, noteWriteOp),
      booking: buildModelApi('booking', database, txMeta, noteWriteOp),
      auditEvent: buildModelApi('auditEvent', database, txMeta, noteWriteOp),
      vehicle: buildModelApi('vehicle', database, txMeta, noteWriteOp),
    };
  }

  function hydrateAccount(row, include) {
    const out = clone(row);
    if (!include) return out;
    if (include.profile) {
      out.profile = null;
      for (const p of db.customerProfile.values()) {
        if (p.customerAccountId === row.id) {
          out.profile = clone(p);
          break;
        }
      }
    }
    if (include.addresses) {
      const addrWhere = include.addresses.where || { archivedAt: null };
      out.addresses = [...db.customerAddress.values()]
        .filter((a) => a.customerAccountId === row.id && matchesWhere(a, addrWhere))
        .map(clone);
      const orderBy = include.addresses.orderBy;
      if (Array.isArray(orderBy) && orderBy.length) {
        out.addresses.sort((a, b) => {
          for (const clause of orderBy) {
            const [key, dir] = Object.entries(clause)[0] || [];
            if (!key) continue;
            const av = a[key];
            const bv = b[key];
            if (av === bv) continue;
            const cmp = av > bv ? 1 : -1;
            return dir === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
      }
    }
    if (include.vehicles) {
      const vehWhere = include.vehicles.where || { archivedAt: null };
      out.vehicles = [...db.customerVehicle.values()]
        .filter((v) => v.customerAccountId === row.id && matchesWhere(v, vehWhere))
        .map(clone);
      const orderBy = include.vehicles.orderBy;
      if (Array.isArray(orderBy) && orderBy.length) {
        out.vehicles.sort((a, b) => {
          for (const clause of orderBy) {
            const [key, dir] = Object.entries(clause)[0] || [];
            if (!key) continue;
            const av = a[key];
            const bv = b[key];
            if (av === bv) continue;
            const cmp = av > bv ? 1 : -1;
            return dir === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
      }
    }
    if (include.consents) {
      out.consents = [...db.customerConsent.values()]
        .filter((c) => c.customerAccountId === row.id)
        .map(clone);
    }
    if (include.bookings) {
      const sel = include.bookings.select || null;
      out.bookings = [...db.booking.values()]
        .filter((b) => b.customerAccountId === row.id)
        .map((b) => {
          if (!sel) return clone(b);
          const item = {};
          for (const k of Object.keys(sel)) item[k] = b[k];
          return item;
        });
    }
    return out;
  }

  function buildModelApi(name, database, txMeta, onWrite) {
    const handlers = {
      customerAccount: {
        async create({ data }) {
          onWrite(txMeta);
          const id = data.id || cuid();
          const row = {
            id,
            status: data.status || 'active',
            version: data.version == null ? 1 : data.version,
            stripeCustomerId: data.stripeCustomerId || null,
            mergedIntoAccountId: data.mergedIntoAccountId || null,
            vehiclesImportedAt: data.vehiclesImportedAt || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          database.customerAccount.set(id, row);
          return clone(row);
        },
        async findUnique({ where, include }) {
          const row = database.customerAccount.get(where.id);
          if (!row) return null;
          return hydrateAccount(row, include);
        },
        async findFirst({ where, include }) {
          for (const row of database.customerAccount.values()) {
            if (matchesWhere(row, where)) return hydrateAccount(row, include);
          }
          return null;
        },
        async update({ where, data }) {
          onWrite(txMeta);
          const row = database.customerAccount.get(where.id);
          if (!row) {
            const err = new Error('Record to update not found');
            err.code = 'P2025';
            throw err;
          }
          const next = {
            ...row,
            ...data,
            updatedAt: data.updatedAt || new Date().toISOString(),
          };
          database.customerAccount.set(row.id, next);
          return clone(next);
        },
        async updateMany({ where, data }) {
          onWrite(txMeta);
          let count = 0;
          for (const [id, row] of database.customerAccount.entries()) {
            if (!matchesWhere(row, where)) continue;
            database.customerAccount.set(id, {
              ...row,
              ...data,
              updatedAt: data.updatedAt || new Date().toISOString(),
            });
            count += 1;
          }
          return { count };
        },
        async count({ where } = {}) {
          let n = 0;
          for (const row of database.customerAccount.values()) {
            if (matchesWhere(row, where)) n += 1;
          }
          return n;
        },
      },
      customerProfile: {
        async create({ data }) {
          onWrite(txMeta);
          const id = data.id || cuid();
          const row = {
            id,
            customerAccountId: data.customerAccountId,
            firstName: data.firstName || null,
            lastName: data.lastName || null,
            displayName: data.displayName || null,
            email: data.email || null,
            normalizedEmail: data.normalizedEmail || null,
            phone: data.phone || null,
            normalizedPhone: data.normalizedPhone || null,
            preferredContactChannel: data.preferredContactChannel || null,
            timezone: data.timezone || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          for (const existing of database.customerProfile.values()) {
            if (existing.customerAccountId === row.customerAccountId) {
              const err = new Error('Unique constraint failed on customerAccountId');
              err.code = 'P2002';
              throw err;
            }
          }
          database.customerProfile.set(id, row);
          return clone(row);
        },
        async findMany({ where, include }) {
          const out = [];
          for (const row of database.customerProfile.values()) {
            if (!matchesWhere(row, where)) continue;
            const item = clone(row);
            if (include?.account) {
              item.account = clone(database.customerAccount.get(row.customerAccountId) || null);
            }
            out.push(item);
          }
          return out;
        },
        async findUnique({ where }) {
          if (where.id) {
            const row = database.customerProfile.get(where.id);
            return row ? clone(row) : null;
          }
          if (where.customerAccountId) {
            for (const row of database.customerProfile.values()) {
              if (row.customerAccountId === where.customerAccountId) return clone(row);
            }
          }
          return null;
        },
        async update({ where, data }) {
          onWrite(txMeta);
          let row = null;
          if (where.id) row = database.customerProfile.get(where.id);
          else if (where.customerAccountId) {
            for (const p of database.customerProfile.values()) {
              if (p.customerAccountId === where.customerAccountId) {
                row = p;
                break;
              }
            }
          }
          if (!row) {
            const err = new Error('Record to update not found');
            err.code = 'P2025';
            throw err;
          }
          const next = {
            ...row,
            ...data,
            updatedAt: data.updatedAt || new Date().toISOString(),
          };
          database.customerProfile.set(row.id, next);
          return clone(next);
        },
        async count({ where } = {}) {
          let n = 0;
          for (const row of database.customerProfile.values()) {
            if (matchesWhere(row, where)) n += 1;
          }
          return n;
        },
      },
      customerAddress: {
        async create({ data }) {
          onWrite(txMeta);
          const id = data.id || cuid();
          const row = {
            id,
            customerAccountId: data.customerAccountId,
            label: data.label || null,
            line1: data.line1,
            line2: data.line2 || null,
            city: data.city || null,
            state: data.state || null,
            postalCode: data.postalCode || null,
            country: data.country || 'US',
            isDefault: !!data.isDefault,
            archivedAt: data.archivedAt || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          database.customerAddress.set(id, row);
          return clone(row);
        },
        async findUnique({ where }) {
          const row = database.customerAddress.get(where.id);
          return row ? clone(row) : null;
        },
        async findMany({ where }) {
          return [...database.customerAddress.values()].filter((r) => matchesWhere(r, where)).map(clone);
        },
        async update({ where, data }) {
          onWrite(txMeta);
          const row = database.customerAddress.get(where.id);
          if (!row) {
            const err = new Error('Record to update not found');
            err.code = 'P2025';
            throw err;
          }
          const next = {
            ...row,
            ...data,
            updatedAt: data.updatedAt || new Date().toISOString(),
          };
          database.customerAddress.set(row.id, next);
          return clone(next);
        },
        async updateMany({ where, data }) {
          onWrite(txMeta);
          let count = 0;
          for (const [id, row] of database.customerAddress.entries()) {
            if (!matchesWhere(row, where)) continue;
            database.customerAddress.set(id, {
              ...row,
              ...data,
              updatedAt: data.updatedAt || new Date().toISOString(),
            });
            count += 1;
          }
          return { count };
        },
        async count({ where } = {}) {
          let n = 0;
          for (const row of database.customerAddress.values()) {
            if (matchesWhere(row, where || {})) n += 1;
          }
          return n;
        },
      },
      customerVehicle: {
        async create({ data }) {
          onWrite(txMeta);
          const id = data.id || cuid();
          if (data.legacySourceId) {
            for (const existing of database.customerVehicle.values()) {
              if (
                existing.customerAccountId === data.customerAccountId
                && existing.legacySourceId === data.legacySourceId
              ) {
                const err = new Error('Unique constraint failed on customerAccountId_legacySourceId');
                err.code = 'P2002';
                throw err;
              }
            }
          }
          const row = {
            id,
            customerAccountId: data.customerAccountId,
            label: data.label || null,
            category: data.category || null,
            year: data.year || null,
            make: data.make || null,
            model: data.model || null,
            color: data.color || null,
            notes: data.notes || null,
            isDefault: !!data.isDefault,
            archivedAt: data.archivedAt || null,
            legacySourceId: data.legacySourceId || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          database.customerVehicle.set(id, row);
          return clone(row);
        },
        async findUnique({ where }) {
          const row = database.customerVehicle.get(where.id);
          return row ? clone(row) : null;
        },
        async findFirst({ where }) {
          for (const row of database.customerVehicle.values()) {
            if (matchesWhere(row, where)) return clone(row);
          }
          return null;
        },
        async findMany({ where }) {
          return [...database.customerVehicle.values()].filter((r) => matchesWhere(r, where)).map(clone);
        },
        async update({ where, data }) {
          onWrite(txMeta);
          const row = database.customerVehicle.get(where.id);
          if (!row) {
            const err = new Error('Record to update not found');
            err.code = 'P2025';
            throw err;
          }
          const next = {
            ...row,
            ...data,
            updatedAt: data.updatedAt || new Date().toISOString(),
          };
          database.customerVehicle.set(row.id, next);
          return clone(next);
        },
        async updateMany({ where, data }) {
          onWrite(txMeta);
          let count = 0;
          for (const [id, row] of database.customerVehicle.entries()) {
            if (!matchesWhere(row, where)) continue;
            database.customerVehicle.set(id, {
              ...row,
              ...data,
              updatedAt: data.updatedAt || new Date().toISOString(),
            });
            count += 1;
          }
          return { count };
        },
        async count({ where } = {}) {
          let n = 0;
          for (const row of database.customerVehicle.values()) {
            if (matchesWhere(row, where || {})) n += 1;
          }
          return n;
        },
        async deleteMany({ where } = {}) {
          onWrite(txMeta);
          let count = 0;
          for (const [id, row] of [...database.customerVehicle.entries()]) {
            if (!matchesWhere(row, where || {})) continue;
            database.customerVehicle.delete(id);
            count += 1;
          }
          return { count };
        },
      },
      customerConsent: {
        async create({ data }) {
          onWrite(txMeta);
          const id = data.id || cuid();
          for (const existing of database.customerConsent.values()) {
            if (existing.customerAccountId === data.customerAccountId && existing.channel === data.channel) {
              const err = new Error('Unique constraint failed on customerAccountId_channel');
              err.code = 'P2002';
              throw err;
            }
          }
          const row = {
            id,
            status: data.status || 'pending',
            grantedAt: data.grantedAt || null,
            revokedAt: data.revokedAt || null,
            source: data.source || null,
            consentTextVersion: data.consentTextVersion || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            customerAccountId: data.customerAccountId,
            channel: data.channel,
          };
          database.customerConsent.set(id, row);
          return clone(row);
        },
        async findMany({ where }) {
          return [...database.customerConsent.values()].filter((r) => matchesWhere(r, where)).map(clone);
        },
      },
      booking: {
        async create({ data }) {
          onWrite(txMeta);
          if (database.booking.has(data.id)) {
            const err = new Error('Unique constraint failed on id');
            err.code = 'P2002';
            throw err;
          }
          const row = {
            id: data.id,
            customerId: data.customerId || null,
            customerAccountId: data.customerAccountId || null,
            bookingVersion: data.bookingVersion == null ? 0 : data.bookingVersion,
            status: data.status || 'draft',
            isDraft: data.isDraft == null ? true : data.isDraft,
            archived: !!data.archived,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          database.booking.set(row.id, row);
          return clone(row);
        },
        async findUnique({ where, select }) {
          const row = database.booking.get(where.id);
          if (!row) return null;
          if (select) {
            const out = {};
            for (const k of Object.keys(select)) out[k] = row[k];
            return out;
          }
          return clone(row);
        },
        async findMany({ where, select }) {
          const out = [];
          for (const row of database.booking.values()) {
            if (!matchesWhere(row, where)) continue;
            if (select) {
              const item = {};
              for (const k of Object.keys(select)) item[k] = row[k];
              out.push(item);
            } else out.push(clone(row));
          }
          return out;
        },
        async updateMany({ where, data }) {
          onWrite(txMeta);
          let count = 0;
          for (const [id, row] of database.booking.entries()) {
            if (!matchesWhere(row, where)) continue;
            database.booking.set(id, { ...row, ...data, updatedAt: new Date().toISOString() });
            count += 1;
          }
          return { count };
        },
        async count({ where } = {}) {
          let n = 0;
          for (const row of database.booking.values()) {
            if (matchesWhere(row, where)) n += 1;
          }
          return n;
        },
      },
      auditEvent: {
        async create({ data }) {
          onWrite(txMeta);
          const id = data.id || cuid();
          const row = {
            id,
            bookingId: data.bookingId || null,
            actor: data.actor,
            action: data.action,
            detail: data.detail || null,
            createdAt: new Date().toISOString(),
          };
          database.auditEvent.set(id, row);
          return clone(row);
        },
        async findMany({ where } = {}) {
          return [...database.auditEvent.values()].filter((r) => matchesWhere(r, where || {})).map(clone);
        },
        async count({ where } = {}) {
          let n = 0;
          for (const row of database.auditEvent.values()) {
            if (matchesWhere(row, where || {})) n += 1;
          }
          return n;
        },
        async deleteMany({ where } = {}) {
          let count = 0;
          for (const [id, row] of [...database.auditEvent.entries()]) {
            if (!matchesWhere(row, where || {})) continue;
            database.auditEvent.delete(id);
            count += 1;
          }
          return { count };
        },
      },
      vehicle: {
        async count({ where } = {}) {
          let n = 0;
          for (const row of database.vehicle.values()) {
            if (matchesWhere(row, where)) n += 1;
          }
          return n;
        },
      },
    };
    return handlers[name];
  }

  // Fix hydrateAccount to use the shared database reference from closure
  // (already uses `db`). Expose options for future hooks.
  void options;

  return api;
}

module.exports = { createIdentityMemoryPrisma };
