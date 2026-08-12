'use strict';

/**
 * A minimal Prisma double with real transaction semantics.
 *
 * Only exists so the Stage 6 atomicity invariants can be *proved* rather than
 * asserted: $transaction applies writes to a scratch copy and commits it only if
 * the callback resolves. If the callback throws, the scratch copy is discarded and
 * committed state is untouched — which is exactly the property a half-published
 * release would violate.
 *
 * Deliberately not a general Prisma emulator. It supports the handful of
 * operations release-repository uses, and throws loudly on anything else so a new
 * call site cannot silently pass against a stub that ignores it.
 */

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

const MODELS = {
  osSite: 'siteId',
  osCatalogDraft: 'siteId',
  osCatalogRevision: 'revisionId',
  osPublishedRelease: 'releaseId',
  osCurrentReleasePointer: 'siteId',
  osAuditLog: 'id',
};

function createFakePrisma(seed = {}) {
  // Fault injection, keyed "model.op". Set via __failOn so a test can make a step
  // *inside* a transaction fail — patching the outer client cannot reach the tx
  // client, which is built fresh per transaction.
  const faults = new Map();
  // committed state: model -> Map(pk -> row)
  const committed = {};
  for (const model of Object.keys(MODELS)) {
    committed[model] = new Map();
    for (const row of seed[model] || []) committed[model].set(row[MODELS[model]], clone(row));
  }
  let autoId = 0;

  function snapshot(state) {
    const copy = {};
    for (const model of Object.keys(MODELS)) copy[model] = new Map(state[model]);
    return copy;
  }

  function modelApi(state, model) {
    const pk = MODELS[model];
    const table = () => state[model];
    const check = (op) => {
      const fault = faults.get(`${model}.${op}`);
      if (fault) throw fault;
    };
    const api = {
      async findUnique({ where }) {
        const key = where[pk];
        if (key === undefined) throw new Error(`fake-prisma: ${model}.findUnique needs ${pk}`);
        return clone(table().get(key)) || null;
      },
      async findMany({ where = {}, orderBy, take, select } = {}) {
        let rows = [...table().values()].filter((r) => Object.entries(where)
          .every(([k, v]) => r[k] === v));
        if (orderBy) {
          const [field, dir] = Object.entries(orderBy)[0];
          rows.sort((a, b) => {
            const av = a[field]; const bv = b[field];
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === 'desc' ? -cmp : cmp;
          });
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => {
          const c = clone(r);
          if (!select) return c;
          const out = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = c[k];
          return out;
        });
      },
      async create({ data }) {
        const row = clone(data);
        if (row[pk] === undefined) row[pk] = `${model}_${++autoId}`;
        if (table().has(row[pk])) {
          const e = new Error(`fake-prisma: duplicate ${model}.${pk}`);
          e.code = 'P2002';
          throw e;
        }
        table().set(row[pk], row);
        return clone(row);
      },
      async upsert({ where, create, update }) {
        const key = where[pk];
        const existing = table().get(key);
        if (existing) {
          const merged = Object.assign({}, existing, clone(update));
          table().set(key, merged);
          return clone(merged);
        }
        const row = clone(create);
        if (row[pk] === undefined) row[pk] = key;
        table().set(row[pk], row);
        return clone(row);
      },
      async update({ where, data }) {
        const key = where[pk];
        const existing = table().get(key);
        if (!existing) {
          const e = new Error(`fake-prisma: ${model} not found`);
          e.code = 'P2025';
          throw e;
        }
        const merged = Object.assign({}, existing, clone(data));
        table().set(key, merged);
        return clone(merged);
      },
    };
    // Wrap every operation so an injected fault fires before it touches state.
    for (const op of Object.keys(api)) {
      const fn = api[op];
      api[op] = async (...args) => { check(op); return fn(...args); };
    }
    return api;
  }

  function clientFor(state) {
    const api = {};
    for (const model of Object.keys(MODELS)) api[model] = modelApi(state, model);
    return api;
  }

  const client = clientFor(committed);

  client.$transaction = async (fn) => {
    if (typeof fn !== 'function') {
      throw new Error('fake-prisma: only the interactive $transaction(fn) form is supported');
    }
    const scratch = snapshot(committed);
    const result = await fn(clientFor(scratch));
    // Commit only on success — a throw leaves `committed` exactly as it was.
    for (const model of Object.keys(MODELS)) {
      committed[model].clear();
      for (const [k, v] of scratch[model]) committed[model].set(k, v);
    }
    return result;
  };

  /** Test-only view of committed state. */
  client.__committed = (model) => [...committed[model].values()].map(clone);

  /** Test-only: make `model.op` throw, inside transactions too. Pass null to clear. */
  client.__failOn = (modelOp, error) => {
    if (!MODELS[String(modelOp).split('.')[0]]) {
      throw new Error(`fake-prisma: unknown model in "${modelOp}"`);
    }
    if (error) faults.set(modelOp, error); else faults.delete(modelOp);
  };

  return client;
}

module.exports = { createFakePrisma };
