'use strict';

/**
 * Behavioral concurrency tests for appointment-access token consumption.
 * Forces interleaving to prove Blob CAS admits exactly one session winner.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');

process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
process.env.CONTEXT = 'production';
process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';

const {
  createAppointmentAccessToken,
  consumeAppointmentAccessToken,
  loadTokenRecord,
  CONSUME_RESULT,
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');

function installStores() {
  process.env.CONTEXT = 'production';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  const tokenStore = createCasMemoryStore();
  const focusStore = createCasMemoryStore();
  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => focusStore,
  });
  return { tokenStore, focusStore };
}

test.afterEach(() => {
  resetAppointmentAccessStoreFactories();
  process.env.CONTEXT = 'production';
});

test('two simultaneous exchanges: exactly one consumed_successfully', async () => {
  const { tokenStore } = installStores();
  const created = await createAppointmentAccessToken({
    bookingId: 'CD1-RACE-2',
    customerAccountId: 'acct_race',
    email: 'race@example.com',
  });

  let releaseGet;
  const gate = new Promise((resolve) => { releaseGet = resolve; });
  let gets = 0;
  tokenStore.installConsumeHook({
    afterGet: async () => {
      gets += 1;
      if (gets === 1) {
        // Hold first reader until second reader also observes unconsumed record.
        await new Promise((r) => setTimeout(r, 5));
      } else if (gets === 2) {
        releaseGet();
      }
      await gate;
    },
  });

  const [a, b] = await Promise.all([
    consumeAppointmentAccessToken(created.token),
    consumeAppointmentAccessToken(created.token),
  ]);

  const winners = [a, b].filter((r) => r.classification === CONSUME_RESULT.CONSUMED_SUCCESSFULLY);
  const losers = [a, b].filter((r) => r.classification === CONSUME_RESULT.ALREADY_CONSUMED);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(winners[0].ok, true);
  assert.equal(losers[0].ok, false);

  const final = await loadTokenRecord(created.token, { allowConsumed: true });
  assert.ok(final.record.consumedAt);
});

test('ten simultaneous exchanges: exactly one new session winner', async () => {
  installStores();
  const created = await createAppointmentAccessToken({
    bookingId: 'CD1-RACE-10',
    customerAccountId: 'acct_10',
    email: 'ten@example.com',
  });

  const results = await Promise.all(
    Array.from({ length: 10 }, () => consumeAppointmentAccessToken(created.token))
  );
  const winners = results.filter((r) => r.classification === CONSUME_RESULT.CONSUMED_SUCCESSFULLY);
  const consumed = results.filter((r) => r.classification === CONSUME_RESULT.ALREADY_CONSUMED);
  assert.equal(winners.length, 1);
  assert.equal(consumed.length, 9);
});

test('two different valid tokens may succeed independently', async () => {
  installStores();
  const a = await createAppointmentAccessToken({
    bookingId: 'CD1-A',
    customerAccountId: 'acct_a',
    email: 'a@example.com',
    supersede: false,
  });
  const b = await createAppointmentAccessToken({
    bookingId: 'CD1-B',
    customerAccountId: 'acct_b',
    email: 'b@example.com',
    supersede: false,
  });
  const [ra, rb] = await Promise.all([
    consumeAppointmentAccessToken(a.token),
    consumeAppointmentAccessToken(b.token),
  ]);
  assert.equal(ra.classification, CONSUME_RESULT.CONSUMED_SUCCESSFULLY);
  assert.equal(rb.classification, CONSUME_RESULT.CONSUMED_SUCCESSFULLY);
});

test('expired token cannot win the race', async () => {
  const { tokenStore } = installStores();
  const created = await createAppointmentAccessToken({
    bookingId: 'CD1-EXP-RACE',
    customerAccountId: 'acct_exp',
    email: 'exp@example.com',
    ttlMs: 60_000,
  });
  // Expire stored record.
  for (const [k, entry] of tokenStore._data.entries()) {
    if (!k.startsWith('tok_')) continue;
    const rec = JSON.parse(entry.value);
    rec.expiresAt = new Date(Date.now() - 1000).toISOString();
    tokenStore._data.set(k, { value: JSON.stringify(rec), etag: entry.etag });
  }
  const result = await consumeAppointmentAccessToken(created.token);
  assert.equal(result.ok, false);
  assert.equal(result.classification, CONSUME_RESULT.EXPIRED);
});

test('consumed token without session cannot create another consume win', async () => {
  installStores();
  const created = await createAppointmentAccessToken({
    bookingId: 'CD1-ONCE-2',
    customerAccountId: 'acct_once',
    email: 'once@example.com',
  });
  const first = await consumeAppointmentAccessToken(created.token);
  assert.equal(first.classification, CONSUME_RESULT.CONSUMED_SUCCESSFULLY);
  const second = await consumeAppointmentAccessToken(created.token);
  assert.equal(second.classification, CONSUME_RESULT.ALREADY_CONSUMED);
  assert.equal(second.ok, false);
});

test('storage failure does not mark the token consumed', async () => {
  const { tokenStore } = installStores();
  const created = await createAppointmentAccessToken({
    bookingId: 'CD1-STOR',
    customerAccountId: 'acct_stor',
    email: 'stor@example.com',
  });
  const originalSet = tokenStore.setJSON.bind(tokenStore);
  tokenStore.setJSON = async () => {
    throw new Error('blob_unavailable');
  };
  const failed = await consumeAppointmentAccessToken(created.token);
  assert.equal(failed.classification, CONSUME_RESULT.STORAGE_UNAVAILABLE);
  assert.equal(failed.ok, false);

  tokenStore.setJSON = originalSet;
  const stillOpen = await loadTokenRecord(created.token);
  assert.equal(stillOpen.ok, true);
  assert.equal(!!stillOpen.record.consumedAt, false);

  const later = await consumeAppointmentAccessToken(created.token);
  assert.equal(later.classification, CONSUME_RESULT.CONSUMED_SUCCESSFULLY);
});

test('no token value in consume error shapes', async () => {
  installStores();
  const created = await createAppointmentAccessToken({
    bookingId: 'CD1-LOG',
    customerAccountId: 'acct_log',
    email: 'log@example.com',
  });
  await consumeAppointmentAccessToken(created.token);
  const replay = await consumeAppointmentAccessToken(created.token);
  const dumped = JSON.stringify(replay);
  assert.doesNotMatch(dumped, new RegExp(created.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(replay.record?.tokenHash != null, true);
});

test('previous race reproduces without CAS (control proves test harness)', async () => {
  // Non-CAS store: get then unconditional set — classic race.
  const map = new Map();
  let etag = 0;
  const racy = {
    async getWithMetadata(key) {
      if (!map.has(key)) return null;
      return { data: JSON.parse(JSON.stringify(map.get(key))), etag: `e${etag}`, metadata: {} };
    },
    async get(key, opts) {
      if (!map.has(key)) return null;
      return opts && opts.type === 'json' ? JSON.parse(JSON.stringify(map.get(key))) : map.get(key);
    },
    async setJSON(key, value) {
      // Ignore onlyIfMatch — simulates the pre-fix race.
      map.set(key, JSON.parse(JSON.stringify(value)));
      etag += 1;
      return { modified: true, etag: `e${etag}` };
    },
  };
  setAppointmentAccessStoreFactories({
    tokenStore: () => racy,
    focusStore: () => createCasMemoryStore(),
  });
  const created = await createAppointmentAccessToken({
    bookingId: 'CD1-CONTROL',
    customerAccountId: 'acct_c',
    email: 'c@example.com',
  });

  let release;
  const gate = new Promise((r) => { release = r; });
  let reads = 0;
  const origGet = racy.getWithMetadata;
  racy.getWithMetadata = async (key) => {
    const result = await origGet(key);
    reads += 1;
    if (reads >= 2) release();
    await gate;
    return result;
  };

  const [a, b] = await Promise.all([
    consumeAppointmentAccessToken(created.token),
    consumeAppointmentAccessToken(created.token),
  ]);
  // Without CAS both "succeed" — documents the bug the fix prevents.
  const winners = [a, b].filter((r) => r.classification === CONSUME_RESULT.CONSUMED_SUCCESSFULLY);
  assert.equal(winners.length, 2);
});
