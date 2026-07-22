/**
 * In-memory Prisma-shaped store for Customer Identity Foundation unit tests.
 * Supports the subset of APIs used by customer-account-service.
 */

const crypto = require('crypto');

function cuid() {
  return `c${crypto.randomBytes(12).toString('hex')}`;
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
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

function createIdentityMemoryPrisma() {
  const db = {
    customerAccount: new Map(),
    customerProfile: new Map(),
    customerAddress: new Map(),
    customerConsent: new Map(),
    booking: new Map(),
    auditEvent: new Map(),
    vehicle: new Map(),
  };

  const api = {
    _db: db,
    async $transaction(fn) {
      return fn(api);
    },
    async $executeRawUnsafe() {
      return 1;
    },
    customerAccount: {
      async create({ data }) {
        const id = data.id || cuid();
        const row = {
          id,
          status: data.status || 'active',
          version: data.version == null ? 1 : data.version,
          stripeCustomerId: data.stripeCustomerId || null,
          mergedIntoAccountId: data.mergedIntoAccountId || null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        db.customerAccount.set(id, row);
        return clone(row);
      },
      async findUnique({ where, include }) {
        const row = db.customerAccount.get(where.id);
        if (!row) return null;
        return hydrateAccount(row, include);
      },
      async findFirst({ where, include }) {
        for (const row of db.customerAccount.values()) {
          if (matchesWhere(row, where)) return hydrateAccount(row, include);
        }
        return null;
      },
      async count({ where } = {}) {
        let n = 0;
        for (const row of db.customerAccount.values()) {
          if (matchesWhere(row, where)) n += 1;
        }
        return n;
      },
    },
    customerProfile: {
      async create({ data }) {
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
        // Enforce one profile per account
        for (const existing of db.customerProfile.values()) {
          if (existing.customerAccountId === row.customerAccountId) {
            const err = new Error('Unique constraint failed on customerAccountId');
            err.code = 'P2002';
            throw err;
          }
        }
        db.customerProfile.set(id, row);
        return clone(row);
      },
      async findMany({ where, include }) {
        const out = [];
        for (const row of db.customerProfile.values()) {
          if (!matchesWhere(row, where)) continue;
          const item = clone(row);
          if (include?.account) {
            item.account = clone(db.customerAccount.get(row.customerAccountId) || null);
          }
          out.push(item);
        }
        return out;
      },
      async count({ where } = {}) {
        let n = 0;
        for (const row of db.customerProfile.values()) {
          if (matchesWhere(row, where)) n += 1;
        }
        return n;
      },
    },
    customerAddress: {
      async create({ data }) {
        const id = data.id || cuid();
        const row = {
          id,
          ...data,
          country: data.country || 'US',
          isDefault: !!data.isDefault,
          archivedAt: data.archivedAt || null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        db.customerAddress.set(id, row);
        return clone(row);
      },
      async findMany({ where }) {
        return [...db.customerAddress.values()].filter((r) => matchesWhere(r, where)).map(clone);
      },
    },
    customerConsent: {
      async create({ data }) {
        const id = data.id || cuid();
        for (const existing of db.customerConsent.values()) {
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
        db.customerConsent.set(id, row);
        return clone(row);
      },
      async findMany({ where }) {
        return [...db.customerConsent.values()].filter((r) => matchesWhere(r, where)).map(clone);
      },
    },
    booking: {
      async create({ data }) {
        if (db.booking.has(data.id)) {
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
        db.booking.set(row.id, row);
        return clone(row);
      },
      async findUnique({ where, select }) {
        const row = db.booking.get(where.id);
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
        for (const row of db.booking.values()) {
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
        let count = 0;
        for (const [id, row] of db.booking.entries()) {
          if (!matchesWhere(row, where)) continue;
          db.booking.set(id, { ...row, ...data, updatedAt: new Date().toISOString() });
          count += 1;
        }
        return { count };
      },
      async count({ where } = {}) {
        let n = 0;
        for (const row of db.booking.values()) {
          if (matchesWhere(row, where)) n += 1;
        }
        return n;
      },
    },
    auditEvent: {
      async create({ data }) {
        const id = data.id || cuid();
        const row = {
          id,
          bookingId: data.bookingId || null,
          actor: data.actor,
          action: data.action,
          detail: data.detail || null,
          createdAt: new Date().toISOString(),
        };
        db.auditEvent.set(id, row);
        return clone(row);
      },
      async findMany({ where } = {}) {
        return [...db.auditEvent.values()].filter((r) => matchesWhere(r, where || {})).map(clone);
      },
    },
    vehicle: {
      async count({ where } = {}) {
        let n = 0;
        for (const row of db.vehicle.values()) {
          if (matchesWhere(row, where)) n += 1;
        }
        return n;
      },
    },
  };

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
      out.addresses = [...db.customerAddress.values()]
        .filter((a) => a.customerAccountId === row.id && !a.archivedAt)
        .map(clone);
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

  return api;
}

module.exports = { createIdentityMemoryPrisma };
