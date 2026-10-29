'use strict';

const { describe, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('node:module');
const {
  LOCAL_DATABASE_NAME,
  assertLocalSettlementUrl,
  applySettlementSchema,
  connectProven,
  emptySettlementTables,
} = require('../sandbox/square-settlement/database');
const {
  ADAPTER_COMMIT,
  DEPENDS_ON_PULL_REQUEST,
  PURPOSE,
  associatePayment,
  createObligation,
  createOperation,
  ingestObservation,
  verifyAndSettle,
} = require('../sandbox/square-settlement/square-sandbox-settlement');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'EAAA_sandbox_mock_token_not_a_real_credential_00';
const PAYMENT_ID = 'sandboxPay7dOnly';
const MERCHANT_ID = 'MERCHANT_TEST_7D';
const LOCATION_ID = 'LOC_TEST_7D';

function settlementTestUrl() {
  const configured = process.env.SQUARE_SETTLEMENT_TEST_PORT;
  const port = configured == null || configured === '' ? '5433' : String(configured);
  if (port !== '5432' && port !== '5433') throw new Error('square_settlement_database_unproven');
  if (process.env.SQUARE_SETTLEMENT_TEST_HOST != null && process.env.SQUARE_SETTLEMENT_TEST_HOST !== '') {
    throw new Error('square_settlement_database_unproven');
  }
  const password = process.env.SQUARE_SETTLEMENT_TEST_PASSWORD;
  let userinfo = 'cardetail1_ci';
  if (password != null && password !== '') {
    if (typeof password !== 'string' || /[\s@:/\\]/.test(password) || /neon|amazonaws|supabase|squareup/i.test(password)) {
      throw new Error('square_settlement_database_unproven');
    }
    userinfo = `cardetail1_ci:${encodeURIComponent(password)}`;
  }
  return `postgresql://${userinfo}@127.0.0.1:${port}/${LOCAL_DATABASE_NAME}`;
}

const URL = settlementTestUrl();

function context(overrides = {}) {
  return {
    testContext: 'noncommercial-test',
    trustedSandbox: {
      merchantId: MERCHANT_ID,
      locationId: LOCATION_ID,
      locationMerchantId: MERCHANT_ID,
    },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return context({
    eventId: 'evt-7d-completed',
    eventType: 'payment.updated',
    squarePaymentId: PAYMENT_ID,
    merchantId: MERCHANT_ID,
    locationId: LOCATION_ID,
    paymentStatus: 'COMPLETED',
    amountCents: 100,
    currency: 'USD',
    observedAt: '2026-10-26T02:00:00.000Z',
    ...overrides,
  });
}

function paymentBody(overrides = {}) {
  const payment = {
    id: overrides.id || PAYMENT_ID,
    status: overrides.status || 'COMPLETED',
    location_id: overrides.locationId || LOCATION_ID,
    amount_money: {
      amount: overrides.amount == null ? 100 : overrides.amount,
      currency: overrides.currency || 'USD',
    },
  };
  assert.equal(Object.hasOwn(payment, 'merchant_id'), false);
  assert.equal(Object.hasOwn(payment, 'receipt_url'), false);
  return { payment };
}

function mockFetch(body, status = 200) {
  return async () => ({
    status,
    async text() { return JSON.stringify(body); },
  });
}

function provider(operationId, overrides = {}, bodyOverrides = {}) {
  return context({
    operationId,
    env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN },
    fetchImpl: mockFetch(paymentBody(bodyOverrides)),
    ...overrides,
  });
}

async function counts() {
  const client = await connectProven(URL);
  try {
    const result = await client.query(
      `SELECT
         (SELECT count(*)::int FROM sandbox_settlement) AS settlements,
         (SELECT count(*)::int FROM sandbox_payment_event) AS events,
         (SELECT count(*)::int FROM sandbox_payment_operation) AS operations,
         (SELECT count(*)::int FROM sandbox_payment_obligation) AS obligations,
         to_regclass('public."PaymentAttempt"') AS commercial_attempt`
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function authorizedPair(paymentId = PAYMENT_ID, key = 'sandbox-op-7d-001') {
  const obligation = await createObligation(URL, context({
    bookingRef: 'TEST-SQ-7D',
    purpose: PURPOSE,
    amountCents: 100,
    currency: 'USD',
  }));
  const operation = await createOperation(URL, context({
    obligationId: obligation.obligationId,
    idempotencyKey: key,
  }));
  const associated = await associatePayment(URL, context({
    operationId: operation.operationId,
    squarePaymentId: paymentId,
  }));
  return { obligation, operation, associated };
}

function assertUnsettled(outcome) {
  assert.equal(outcome.financiallySettled, false);
  assert.equal(outcome.settlementCommitted, false);
  assert.equal(outcome.paid, false);
  assert.equal(outcome.ledgerWrite, false);
  assert.equal(outcome.bookingWrite, false);
}

function retrievalFailure(name) {
  if (name === 'timeout') return async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('synthetic_timeout')), { once: true });
  });
  if (name === 'malformed-json') return async () => ({ status: 200, async text() { return '{invalid'; } });
  return mockFetch({ errors: [{ code: 'API_ERROR' }] }, Number(name));
}

async function inboxRows() {
  const client = await connectProven(URL);
  try {
    return (await client.query(
      'SELECT event_id, event_type, source_kind, payment_status, amount_cents, currency, processing_status FROM sandbox_payment_event ORDER BY event_id'
    )).rows;
  } finally { await client.end(); }
}

async function assertStoredAuthorization(pair) {
  const client = await connectProven(URL);
  try {
    const found = await client.query(
      `SELECT p.obligation_id, p.square_payment_id, p.expected_amount_cents, p.currency,
              o.amount_cents, o.currency AS obligation_currency
       FROM sandbox_payment_operation p JOIN sandbox_payment_obligation o USING (obligation_id)
       WHERE p.operation_id = $1`, [pair.operation.operationId]
    );
    assert.deepEqual(found.rows, [{ obligation_id: pair.obligation.obligationId, square_payment_id: PAYMENT_ID,
      expected_amount_cents: 100, currency: 'USD', amount_cents: 100, obligation_currency: 'USD' }]);
  } finally { await client.end(); }
}

function serviceWithCommitFault(mode) {
  const file = path.join(ROOT, 'sandbox/square-settlement/square-sandbox-settlement.js');
  let injections = 0;
  const database = require('../sandbox/square-settlement/database');
  const decorated = { ...database, connectProven: async (url) => {
    const client = await database.connectProven(url);
    const query = client.query.bind(client);
    let insertedSettlement = false;
    client.query = async (sql, ...args) => {
      if (sql === 'COMMIT' && insertedSettlement && injections === 0) {
        injections++;
        if (mode === 'after') await query(sql, ...args);
        const error = new Error('synthetic_commit_ack_loss');
        error.code = '08006';
        throw error;
      }
      const result = await query(sql, ...args);
      if (/INSERT INTO sandbox_settlement\b/.test(sql)) insertedSettlement = true;
      return result;
    };
    return client;
  } };
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = loaded.require.bind(loaded);
  loaded.require = (name) => name === './database' ? decorated : original(name);
  loaded._compile(fs.readFileSync(file, 'utf8'), file);
  return { api: loaded.exports, injections: () => injections };
}

async function waitForLockState(client, query, excludedPids = []) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const found = await client.query(
      `SELECT a.pid, a.query,
              EXISTS (SELECT 1 FROM pg_locks l
                      WHERE l.pid = a.pid AND l.locktype = 'advisory' AND l.granted) AS holds_advisory
       FROM pg_stat_activity a
       WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
         AND ($1::text IS NULL OR a.query = $1)
         AND NOT (a.pid = ANY($2::int[]))`,
      [query, excludedPids]
    );
    if (found.rows[0]) return found.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for PostgreSQL lock state: ${query || 'competing session'}`);
}

function serviceWithHistoryFault(mode) {
  const file = path.join(ROOT, 'sandbox/square-settlement/square-sandbox-settlement.js');
  const database = require('../sandbox/square-settlement/database');
  let injections = 0;
  let connections = 0;
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const decorated = { ...database, connectProven: async (url) => {
    connections++;
    const connectionNumber = connections;
    if (mode === 'outcome-connect' && connections === 3) {
      injections++;
      throw new Error('synthetic_history_connect_fault');
    }
    const client = await database.connectProven(url);
    const query = client.query.bind(client);
    const end = client.end.bind(client);
    let outcomeWrite = false;
    let registration = false;
    let settlementWrite = false;
    const fail = () => { injections++; const error = new Error('synthetic_history_ack_fault'); error.code = '08006'; throw error; };
    client.query = async (sql, ...args) => {
      if (mode === 'preflight-barrier' && connectionNumber === 1 && sql === 'COMMIT') {
        const answer = await query(sql, ...args);
        enter(); await barrier; return answer;
      }
      if (mode === 'insert' && injections === 0 && /INSERT INTO sandbox_payment_event/.test(sql)) fail();
      if (mode === 'inspect' && injections === 0 && /SELECT \* FROM sandbox_payment_event/.test(sql)) fail();
      const target = mode.startsWith('registration-') ? registration : outcomeWrite;
      if (sql === 'COMMIT' && injections === 0 && target && /-(before|after)$/.test(mode)) {
        if (mode.endsWith('-after')) await query(sql, ...args);
        fail();
      }
      const answer = await query(sql, ...args);
      if (/UPDATE sandbox_payment_event\s+SET payment_status/.test(sql)) outcomeWrite = true;
      if (/INSERT INTO sandbox_payment_event/.test(sql)) registration = true;
      if (/INSERT INTO sandbox_settlement\b/.test(sql)) settlementWrite = true;
      return answer;
    };
    client.end = async () => {
      await end();
      if (injections === 0 && ((mode === 'cleanup' && outcomeWrite) || (mode === 'settlement-cleanup' && settlementWrite))) fail();
    };
    return client;
  } };
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = loaded.require.bind(loaded);
  loaded.require = (name) => {
    if (name === './database') return decorated;
    if (mode === 'adapter-throw' && name.endsWith('square-sandbox-adapter-contract')) {
      return { ...original(name), retrieveSimulatedPayment: async () => {
        injections++; throw new Error('unexpected_adapter_fault');
      } };
    }
    return original(name);
  };
  loaded._compile(fs.readFileSync(file, 'utf8'), file);
  return { api: loaded.exports, injections: () => injections, entered, release };
}

async function deadlockCount(client) {
  const found = await client.query(
    'SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = current_database()'
  );
  return found.rows[0].deadlocks;
}

async function contendWithOperationRetry(pair, competing) {
  const observer = await connectProven(URL);
  const operationBlocker = await connectProven(URL);
  const obligationBlocker = await connectProven(URL);
  let retryPromise;
  let competingPromise;
  try {
    const before = await deadlockCount(observer);
    await operationBlocker.query('BEGIN');
    await operationBlocker.query(
      'SELECT operation_id FROM sandbox_payment_operation WHERE operation_id = $1 FOR UPDATE',
      [pair.operation.operationId]
    );
    await obligationBlocker.query('BEGIN');
    await obligationBlocker.query(
      'SELECT obligation_id FROM sandbox_payment_obligation WHERE obligation_id = $1 FOR UPDATE',
      [pair.obligation.obligationId]
    );
    retryPromise = createOperation(URL, context({
      obligationId: pair.obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
    }));
    const retryWait = await waitForLockState(
      observer, 'SELECT * FROM sandbox_payment_obligation WHERE obligation_id = $1 FOR UPDATE'
    );
    competingPromise = competing();
    const competingWait = await waitForLockState(observer, null, [retryWait.pid]);
    assert.notEqual(retryWait.pid, competingWait.pid);

    // On the old implementation the competitor is queued for the operation.
    // Releasing the obligation first lets the retry hold it while also queuing
    // for the operation. Releasing the operation then exposes the exact cycle.
    // The corrected implementation must make this same schedule complete safely.
    await obligationBlocker.query('COMMIT');
    await waitForLockState(
      observer, 'SELECT * FROM sandbox_payment_operation WHERE idempotency_key = $1 FOR UPDATE'
    );
    await operationBlocker.query('COMMIT');
    const [retry, other] = await Promise.all([retryPromise, competingPromise]);
    return { retry, other, deadlocksBefore: before, deadlocksAfter: await deadlockCount(observer) };
  } finally {
    await obligationBlocker.query('ROLLBACK').catch(() => {});
    await operationBlocker.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([retryPromise, competingPromise].filter(Boolean));
    await Promise.all([observer.end(), operationBlocker.end(), obligationBlocker.end()]);
  }
}

async function assertCommittedPair(pair) {
  const client = await connectProven(URL);
  try {
    const found = await client.query(
      `SELECT s.obligation_id, s.operation_id, s.square_payment_id,
              s.settled_amount_cents, s.currency,
              o.status AS obligation_status, p.status AS operation_status
       FROM sandbox_settlement s
       JOIN sandbox_payment_obligation o ON o.obligation_id = s.obligation_id
       JOIN sandbox_payment_operation p ON p.operation_id = s.operation_id`
    );
    assert.deepEqual(found.rows, [{
      obligation_id: pair.obligation.obligationId,
      operation_id: pair.operation.operationId,
      square_payment_id: PAYMENT_ID,
      settled_amount_cents: 100,
      currency: 'USD',
      obligation_status: 'settled',
      operation_status: 'settled',
    }]);
  } finally {
    await client.end();
  }
}

describe('isolated Square Sandbox settlement', { concurrency: false }, () => {
  beforeEach(async () => {
    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
  });

  test('the connection gate allows only the dedicated loopback database', () => {
    assert.equal(LOCAL_DATABASE_NAME, 'cardetail1_square_settlement_7d');
    assert.equal(assertLocalSettlementUrl(URL).database, LOCAL_DATABASE_NAME);
    assert.doesNotThrow(() => assertLocalSettlementUrl(
      'postgresql://cardetail1_ci@127.0.0.1:5432/cardetail1_square_settlement_7d'
    ));
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@127.0.0.1:5432/cardetail1_ci'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://user@ep-example.neon.tech/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@example.com:5433/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://user@ep-summer-glade.neon.tech/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://user@cardetail1.cluster.us-east-1.rds.amazonaws.com:5432/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@127.0.0.1:5434/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@127.0.0.1:5432/cardetail1_production'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@connect.squareup.com:5432/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    const databaseSource = fs.readFileSync(path.join(ROOT, 'sandbox/square-settlement/database.js'), 'utf8');
    assert.equal(databaseSource.includes('process.env'), false);
    assert.equal(ADAPTER_COMMIT, 'f68c9b46af83d747e55139eaac5fb724db0e43e4');
    assert.equal(DEPENDS_ON_PULL_REQUEST, 373);
  });

  test('the canonical client proves its loopback database, role and timeout over a real connection', async () => {
    const client = await connectProven(URL);
    try {
      assert.equal(client.connectionParameters.host, '127.0.0.1');
      assert.equal(client.connectionParameters.port, Number(new globalThis.URL(URL).port));
      assert.equal(client.connectionParameters.database, LOCAL_DATABASE_NAME);
      assert.equal(client.connectionParameters.user, 'cardetail1_ci');
      assert.equal(client.connectionParameters.ssl, false);
      assert.equal(client.connectionParameters.statement_timeout, 8000);
      const proof = await client.query(
        `SELECT current_database() AS database, current_user AS role,
                inet_server_addr()::text AS address,
                current_setting('statement_timeout') AS statement_timeout`
      );
      assert.equal(proof.rows[0].database, LOCAL_DATABASE_NAME);
      assert.equal(proof.rows[0].role, 'cardetail1_ci');
      assert.match(proof.rows[0].address, /^127\.0\.0\.1(?:\/32)?$/);
      assert.equal(proof.rows[0].statement_timeout, '8s');
    } finally {
      await client.end();
    }
  });

  test('untrusted settlement environment overrides cannot select a database', () => {
    const previous = {
      port: process.env.SQUARE_SETTLEMENT_TEST_PORT,
      host: process.env.SQUARE_SETTLEMENT_TEST_HOST,
      password: process.env.SQUARE_SETTLEMENT_TEST_PASSWORD,
      databaseUrl: process.env.DATABASE_URL,
    };
    try {
      process.env.SQUARE_SETTLEMENT_TEST_PORT = '5434';
      assert.throws(() => settlementTestUrl(), /square_settlement_database_unproven/);
      process.env.SQUARE_SETTLEMENT_TEST_PORT = '5432';
      process.env.SQUARE_SETTLEMENT_TEST_HOST = 'ep-example.neon.tech';
      assert.throws(() => settlementTestUrl(), /square_settlement_database_unproven/);
      delete process.env.SQUARE_SETTLEMENT_TEST_HOST;
      process.env.SQUARE_SETTLEMENT_TEST_PASSWORD = 'cardetail1_ci';
      process.env.DATABASE_URL = 'postgresql://user@ep-example.neon.tech/cardetail1_ci';
      const url = settlementTestUrl();
      const parsed = assertLocalSettlementUrl(url);
      assert.equal(parsed.host, '127.0.0.1');
      assert.equal(parsed.port, '5432');
      assert.equal(parsed.database, LOCAL_DATABASE_NAME);
      assert.equal(url.includes('neon'), false);
      process.env.SQUARE_SETTLEMENT_TEST_PASSWORD = 'https://ep-example.neon.tech';
      assert.throws(() => settlementTestUrl(), /square_settlement_database_unproven/);
    } finally {
      for (const [key, name] of [
        ['SQUARE_SETTLEMENT_TEST_PORT', previous.port],
        ['SQUARE_SETTLEMENT_TEST_HOST', previous.host],
        ['SQUARE_SETTLEMENT_TEST_PASSWORD', previous.password],
        ['DATABASE_URL', previous.databaseUrl],
      ]) {
        if (name == null) delete process.env[key];
        else process.env[key] = name;
      }
    }
  });

  test('the full-test job prepares a separate loopback settlement database', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/integration.yml'), 'utf8');
    assert.match(workflow, /DATABASE_URL: postgresql:\/\/cardetail1_ci:cardetail1_ci@127\.0\.0\.1:5432\/cardetail1_ci/);
    const fullTest = workflow.slice(workflow.indexOf('  full_test:'), workflow.indexOf('  financial_invariants:'));
    assert.match(fullTest, /cardetail1_square_settlement_7d/);
    assert.match(fullTest, /SQUARE_SETTLEMENT_TEST_PORT: '5432'/);
    assert.equal(fullTest.includes('SQUARE_SETTLEMENT_TEST_PASSWORD: cardetail1_ci'), false);
    assert.match(fullTest, /const password = decodeURIComponent\(commercial\.password \|\| ''\)/);
    assert.match(fullTest, /echo "::add-mask::\$SQUARE_SETTLEMENT_TEST_PASSWORD"/);
    assert.match(fullTest, /nsenter -t "\$pid" -n/);
    assert.equal(fullTest.includes('schema.sql'), false);
    assert.equal(fullTest.includes('neon.tech'), false);
    for (const marker of ['  financial_invariants:', '  portal_parity:', '  netlify_build:', '  stripe_test_mode:']) {
      assert.equal(workflow.includes(marker), true, marker);
    }
    const financial = workflow.slice(workflow.indexOf('  financial_invariants:'), workflow.indexOf('  portal_parity:'));
    const portal = workflow.slice(workflow.indexOf('  portal_parity:'), workflow.indexOf('  netlify_build:'));
    const netlify = workflow.slice(workflow.indexOf('  netlify_build:'), workflow.indexOf('  stripe_test_mode:'));
    const stripe = workflow.slice(workflow.indexOf('  stripe_test_mode:'));
    for (const section of [financial, portal, netlify, stripe]) {
      assert.equal(section.includes('cardetail1_square_settlement_7d'), false);
    }
  });

  for (const failure of ['429', '500', 'malformed-json', 'timeout']) {
    for (const delivery of ['same', 'new']) {
      test(`transient ${failure} permits ${delivery} event verification retry without losing evidence`, async () => {
        const pair = await authorizedPair();
        let calls = 0;
        const failedFetch = retrievalFailure(failure);
        const fetchImpl = async (url, init) => {
          assert.equal(init.method, 'GET');
          calls++;
          return calls === 1 ? failedFetch(url, init) : mockFetch(paymentBody())(url, init);
        };
        const input = observation({ eventId: `evt-recovery-${failure}-${delivery}`, env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN }, timeoutMs: 20, fetchImpl });
        const failed = await ingestObservation(URL, input);
        assert.equal(failed.result, 'failed');
        assert.equal(failed.retrySafe, true);
        assertUnsettled(failed);
        assert.equal((await counts()).settlements, 0);
        const before = await inboxRows();
        const attempt = before.find((row) => row.event_type === 'provider.retrieve');
        assert.ok(attempt);
        const retryInput = { ...input, eventId: delivery === 'same' ? input.eventId : `${input.eventId}-new` };
        const recovered = await ingestObservation(URL, retryInput);
        assert.equal(recovered.result, 'settled');
        assert.equal(recovered.settlementCommitted, true);
        assert.equal(calls, 2);
        await assertCommittedPair(pair);
        const after = await inboxRows();
        assert.deepEqual(after.find((row) => row.event_id === attempt.event_id), attempt);
        assert.equal(after.length, delivery === 'same' ? 3 : 4);
        const duplicate = await ingestObservation(URL, retryInput);
        assert.equal(duplicate.result, 'already_settled');
        assert.equal(duplicate.settlementCommitted, false);
        assert.equal(calls, 2);
        await assertCommittedPair(pair);
      });
    }
  }

  test('legacy unavailable retrieval history remains audit evidence after an old quarantine', async () => {
    const pair = await authorizedPair();
    const input = observation({ eventId: 'evt-legacy-recovery', env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN }, fetchImpl: retrievalFailure('500') });
    assert.equal((await ingestObservation(URL, input)).result, 'failed');
    const client = await connectProven(URL);
    try {
      await client.query("UPDATE sandbox_payment_event SET processing_status = 'inconsistent'");
      await client.query("UPDATE sandbox_payment_event SET currency = '' WHERE event_type = 'provider.retrieve'");
    } finally { await client.end(); }
    const attempt = (await inboxRows()).find((row) => row.event_type === 'provider.retrieve');
    const recovered = await ingestObservation(URL, { ...input, eventId: 'evt-legacy-recovery-new', fetchImpl: mockFetch(paymentBody()) });
    assert.equal(recovered.result, 'settled');
    assert.deepEqual((await inboxRows()).find((row) => row.event_id === attempt.event_id), attempt);
    await assertCommittedPair(pair);
  });

  for (const [name, mismatch] of [
    ['payment identity', { id: 'OtherPayment7dOnly' }],
    ['amount', { amount: 101 }],
    ['currency', { currency: 'EUR' }],
    ['location', { locationId: 'LOC_TEST_OTHER' }],
  ]) {
    test(`genuine provider ${name} conflict remains quarantined on a valid event retry`, async () => {
      const pair = await authorizedPair();
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        return mockFetch(paymentBody(calls === 1 ? mismatch : {}))();
      };
      const input = observation({ eventId: `evt-conflict-${name.replace(/ /g, '-')}`, env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN }, fetchImpl });
      const conflict = await ingestObservation(URL, input);
      assert.equal(conflict.result, 'quarantined');
      assertUnsettled(conflict);
      const retry = await ingestObservation(URL, { ...input, eventId: `${input.eventId}-new` });
      assert.equal(retry.result, 'quarantined');
      assert.equal(retry.retrySafe, false);
      assert.equal(calls, 1);
      assert.equal((await counts()).settlements, 0);
      await assertStoredAuthorization(pair);
    });
  }

  test('a caller cannot disguise conflicting observation data as retrieval failure evidence', async () => {
    await authorizedPair();
    const spoofed = await ingestObservation(URL, observation({ sourceKind: 'verified_provider_retrieval' }));
    assert.equal(spoofed.error, 'square_settlement_authentication_marker_rejected');
    assert.equal((await counts()).events, 0);
    const conflict = await ingestObservation(URL, observation({ eventType: 'provider.retrieve', amountCents: 101 }));
    assert.equal(conflict.result, 'quarantined');
    const retry = await ingestObservation(URL, observation({ eventId: 'evt-after-forged-retrieval', fetchImpl: mockFetch(paymentBody()), env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN } }));
    assert.equal(retry.result, 'quarantined');
    assert.equal((await counts()).settlements, 0);
  });

  for (const mode of ['before', 'after']) {
    test(`commit acknowledgement failure ${mode} COMMIT resolves to one matching settlement`, async () => {
      const pair = await authorizedPair();
      const injected = serviceWithCommitFault(mode);
      let calls = 0;
      const input = provider(pair.operation.operationId, { fetchImpl: async () => { calls++; return mockFetch(paymentBody())(); } });
      const first = await injected.api.verifyAndSettle(URL, input);
      assert.equal(first.result, 'failed');
      assert.equal(first.retrySafe, true);
      assertUnsettled(first);
      assert.equal(injected.injections(), 1);
      assert.equal((await counts()).settlements, mode === 'after' ? 1 : 0);
      const retry = await verifyAndSettle(URL, input);
      assert.equal(retry.result, mode === 'after' ? 'already_settled' : 'settled');
      assert.equal(calls, mode === 'after' ? 1 : 2);
      await assertCommittedPair(pair);
    });
  }

  for (const [name, status, body] of [
    ...[302, 400, 404, 409, 429, 500].map((status) => [String(status), status, paymentBody()]),
    ['decline', 200, { ...paymentBody(), errors: [{ code: 'CARD_DECLINED', category: 'PAYMENT_METHOD_ERROR' }] }],
    ['API-error', 200, { ...paymentBody(), errors: [{ code: 'API_ERROR' }] }],
  ]) {
    test(`failed retrieval ${name} cannot commit even when payment identity fields match`, async () => {
      const { operation } = await authorizedPair();
      const outcome = await verifyAndSettle(URL, provider(operation.operationId, { fetchImpl: mockFetch(body, status) }));
      assertUnsettled(outcome);
      assert.equal((await counts()).settlements, 0);
    });
  }

  test('an obligation and operation are stored before any settlement', async () => {
    const { obligation, operation, associated } = await authorizedPair();
    assert.equal(obligation.result, 'stored');
    assert.equal(operation.result, 'stored');
    assert.equal(associated.result, 'pending');
    assertUnsettled(associated);
    const state = await counts();
    assert.equal(state.settlements, 0);
    assert.equal(state.obligations, 1);
    assert.equal(state.operations, 1);
    assert.equal(state.commercial_attempt, null);
  });

  test('an unverified COMPLETED observation does not settle', async () => {
    await authorizedPair();
    const stored = await ingestObservation(URL, observation());
    assert.equal(stored.result, 'stored');
    assert.equal(stored.processingStatus, 'verification_required');
    assert.equal(stored.providerCompleted, false);
    assertUnsettled(stored);
    assert.equal((await counts()).settlements, 0);
    assert.equal((await counts()).events, 1);
  });

  test('a verified COMPLETED retrieval settles from the stored payment', async () => {
    const { obligation, operation } = await authorizedPair();
    let calls = 0;
    const settled = await verifyAndSettle(URL, provider(operation.operationId, {
      amountCents: 1,
      squarePaymentId: PAYMENT_ID,
      fetchImpl: async () => {
        calls += 1;
        return { status: 200, async text() { return JSON.stringify(paymentBody()); } };
      },
    }));
    assert.equal(calls, 1);
    assert.equal(settled.result, 'settled');
    assert.equal(settled.providerCompleted, true);
    assert.equal(settled.financiallySettled, true);
    assert.equal(settled.settlementCommitted, true);
    assert.equal(settled.paid, false);
    assert.equal(settled.operationId, operation.operationId);
    assert.equal(settled.obligationId, obligation.obligationId);
    assert.equal(settled.squarePaymentId, PAYMENT_ID);
    assert.equal(JSON.stringify(settled).includes(TOKEN), false);
    assert.equal(JSON.stringify(settled).includes('receipt'), false);
    assert.equal((await counts()).settlements, 1);
  });

  test('an unknown payment identity and a provider id mismatch do not settle', async () => {
    const { operation } = await authorizedPair();
    const missing = await verifyAndSettle(URL, provider('op-missing'));
    assert.equal(missing.error, 'square_settlement_operation_unknown');
    assertUnsettled(missing);
    const unassociated = await createOperation(URL, context({
      obligationId: (await createObligation(URL, context({
        bookingRef: 'TEST-SQ-7D-C',
        purpose: PURPOSE,
        amountCents: 100,
        currency: 'USD',
      }))).obligationId,
      idempotencyKey: 'sandbox-op-open-only',
    }));
    const open = await verifyAndSettle(URL, provider(unassociated.operationId));
    assert.equal(open.error, 'square_settlement_payment_unassociated');
    assertUnsettled(open);
    let calls = 0;
    const mismatch = await verifyAndSettle(URL, provider(operation.operationId, {
      squarePaymentId: 'sandboxPayOther',
      fetchImpl: async () => {
        calls += 1;
        return { status: 200, async text() { return JSON.stringify(paymentBody()); } };
      },
    }));
    assert.equal(calls, 0);
    assert.equal(mismatch.error, 'square_settlement_payment_id_mismatch');
    assertUnsettled(mismatch);
    const returned = await verifyAndSettle(URL, provider(operation.operationId, {}, { id: 'sandboxPayOther' }));
    assert.equal(returned.result, 'quarantined');
    assert.equal(returned.error, 'square_settlement_payment_id_mismatch');
    assertUnsettled(returned);
    assert.equal((await counts()).settlements, 0);
  });

  test('wrong amount, currency, merchant, and location do not settle', async () => {
    const { operation } = await authorizedPair();
    const cases = [
      [provider(operation.operationId, {}, { amount: 250 }), 'square_settlement_amount_mismatch'],
      [provider(operation.operationId, {}, { currency: 'EUR' }), 'square_settlement_currency_mismatch'],
      [provider(operation.operationId, {}, { locationId: 'LOC_TEST_OTHER' }), 'square_settlement_location_mismatch'],
    ];
    for (const [input, error] of cases) {
      await emptySettlementTables(URL);
      await applySettlementSchema(URL);
      const paired = await authorizedPair();
      const outcome = await verifyAndSettle(URL, { ...input, operationId: paired.operation.operationId });
      assert.equal(outcome.result, 'quarantined', error);
      assert.equal(outcome.error, error);
      assertUnsettled(outcome);
      assert.equal((await counts()).settlements, 0, error);
    }
    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
    const paired = await authorizedPair();
    const merchant = await verifyAndSettle(URL, provider(paired.operation.operationId, {
      trustedSandbox: {
        merchantId: 'MERCHANT_TEST_OTHER',
        locationId: LOCATION_ID,
        locationMerchantId: 'MERCHANT_TEST_OTHER',
      },
    }));
    assert.equal(merchant.result, 'quarantined');
    assertUnsettled(merchant);
    const observed = await ingestObservation(URL, observation({
      eventId: 'evt-7d-merchant',
      merchantId: 'MERCHANT_TEST_OTHER',
    }));
    assert.equal(observed.result, 'quarantined');
    assertUnsettled(observed);
    assert.equal((await counts()).settlements, 0);
    assert.equal((await counts()).events >= 1, true);
  });

  test('caller-forged trust markers and timestamps cannot settle', async () => {
    const { operation } = await authorizedPair();
    const forgedSource = await ingestObservation(URL, observation({ sourceKind: 'authenticated_event' }));
    const forgedMarker = await ingestObservation(URL, observation({
      eventId: 'evt-7d-marker',
      trustedSandbox: {
        configuredBy: 'server',
        merchantId: MERCHANT_ID,
        locationId: LOCATION_ID,
        locationMerchantId: MERCHANT_ID,
      },
    }));
    const forgedFlag = await verifyAndSettle(URL, provider(operation.operationId, { verified: true }));
    const future = await ingestObservation(URL, observation({
      eventId: 'evt-7d-future',
      observedAt: '2099-01-01T00:00:00.000Z',
    }));
    const past = await ingestObservation(URL, observation({
      eventId: 'evt-7d-past',
      observedAt: '2000-01-01T00:00:00.000Z',
    }));
    const missingTime = await ingestObservation(URL, observation({
      eventId: 'evt-7d-notime',
      observedAt: undefined,
    }));
    for (const outcome of [forgedSource, forgedMarker, forgedFlag, future, past, missingTime]) {
      assertUnsettled(outcome);
    }
    assert.equal(forgedSource.error, 'square_settlement_authentication_marker_rejected');
    assert.equal(forgedMarker.error, 'square_settlement_authentication_marker_rejected');
    assert.equal(forgedFlag.error, 'square_settlement_authentication_marker_rejected');
    assert.equal(future.processingStatus, 'verification_required');
    assert.equal(past.processingStatus, 'verification_required');
    assert.equal(missingTime.processingStatus, 'verification_required');
    assert.equal((await counts()).settlements, 0);
  });

  test('conflicting webhook observations stay stored and do not settle', async () => {
    const { operation } = await authorizedPair();
    const first = await ingestObservation(URL, observation({ eventId: 'evt-7d-amount-a', amountCents: 100 }));
    const second = await ingestObservation(URL, observation({
      eventId: 'evt-7d-amount-b',
      amountCents: 250,
      observedAt: '2099-01-01T00:00:00.000Z',
    }));
    assert.equal(first.processingStatus, 'verification_required');
    assert.equal(second.result, 'quarantined');
    assertUnsettled(first);
    assertUnsettled(second);
    assert.equal((await counts()).events, 2);
    assert.equal((await counts()).settlements, 0);
    const disagreed = await verifyAndSettle(URL, provider(operation.operationId, {}, { amount: 250 }));
    assert.equal(disagreed.result, 'quarantined');
    assertUnsettled(disagreed);
    const verified = await verifyAndSettle(URL, provider(operation.operationId));
    assert.equal(verified.result, 'quarantined');
    assertUnsettled(verified);
    assert.equal((await counts()).settlements, 0);
    const client = await connectProven(URL);
    try {
      const conflict = await client.query(
        "SELECT count(*)::int AS conflicts FROM sandbox_payment_event WHERE processing_status = 'inconsistent'"
      );
      assert.equal(conflict.rows[0].conflicts >= 1, true);
    } finally {
      await client.end();
    }
    assert.equal((await counts()).settlements, 0);
  });

  test('payment.created and payment.updated settle only after verification', async () => {
    const createdPair = await authorizedPair(PAYMENT_ID, 'sandbox-op-created');
    const created = await ingestObservation(URL, observation({
      eventId: 'evt-7d-created',
      eventType: 'payment.created',
    }));
    assert.equal(created.processingStatus, 'verification_required');
    assertUnsettled(created);
    const createdSettled = await ingestObservation(URL, provider(createdPair.operation.operationId, observation({
      eventId: 'evt-7d-created-ok',
      eventType: 'payment.created',
    })));
    assert.equal(createdSettled.result, 'settled');
    assert.equal(createdSettled.settlementCommitted, true);

    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
    const updatedPair = await authorizedPair(PAYMENT_ID, 'sandbox-op-updated');
    const updated = await ingestObservation(URL, observation({
      eventId: 'evt-7d-updated',
      eventType: 'payment.updated',
    }));
    assertUnsettled(updated);
    const updatedSettled = await ingestObservation(URL, provider(updatedPair.operation.operationId, observation({
      eventId: 'evt-7d-updated-ok',
      eventType: 'payment.updated',
    })));
    assert.equal(updatedSettled.result, 'settled');
    assert.equal((await counts()).settlements, 1);
  });

  test('APPROVED, PENDING, FAILED, and CANCELED do not settle', async () => {
    for (const status of ['APPROVED', 'PENDING', 'FAILED', 'CANCELED']) {
      await emptySettlementTables(URL);
      await applySettlementSchema(URL);
      const { operation } = await authorizedPair();
      const observed = await ingestObservation(URL, observation({
        eventId: `evt-7d-${status}`,
        paymentStatus: status,
      }));
      const verified = await verifyAndSettle(URL, provider(operation.operationId, {}, { status }));
      assertUnsettled(observed);
      assertUnsettled(verified);
      if (status === 'APPROVED' || status === 'PENDING') {
        assert.equal(observed.result, 'pending', status);
        assert.equal(verified.result, 'pending', status);
      } else {
        assert.equal(observed.result, 'rejected', status);
        assert.equal(verified.result, 'rejected', status);
      }
      assert.equal((await counts()).settlements, 0, status);
    }
  });

  test('duplicate and distinct events leave one settlement', async () => {
    const { operation } = await authorizedPair();
    const first = await ingestObservation(URL, observation({ eventId: 'evt-7d-a' }));
    const duplicate = await ingestObservation(URL, observation({
      eventId: 'evt-7d-a',
      paymentStatus: 'APPROVED',
    }));
    assertUnsettled(first);
    assertUnsettled(duplicate);
    assert.equal((await counts()).events, 1);
    const settled = await verifyAndSettle(URL, provider(operation.operationId));
    const otherEvent = await ingestObservation(URL, observation({
      eventId: 'evt-7d-b',
      eventType: 'payment.created',
      observedAt: '2026-10-26T02:00:00.000Z',
    }));
    assert.equal(settled.settlementCommitted, true);
    assert.equal(otherEvent.result, 'already_settled');
    assert.equal(otherEvent.financiallySettled, true);
    assert.equal(otherEvent.settlementCommitted, false);
    assert.equal((await counts()).settlements, 1);
    assert.equal((await counts()).events >= 2, true);
  });

  test('concurrent verification leaves one settlement row', async () => {
    const { operation } = await authorizedPair();
    const [left, right] = await Promise.all([
      verifyAndSettle(URL, provider(operation.operationId)),
      verifyAndSettle(URL, provider(operation.operationId)),
    ]);
    const results = [left.result, right.result].sort();
    assert.deepEqual(results, ['already_settled', 'settled']);
    assert.equal(left.financiallySettled, true);
    assert.equal(right.financiallySettled, true);
    assert.equal(left.settlementCommitted !== right.settlementCommitted, true);
    assert.equal((await counts()).settlements, 1);
  });

  test('operation retry versus verification preserves identity without a row-lock deadlock', async () => {
    const pair = await authorizedPair();
    const outcomes = await contendWithOperationRetry(pair, () =>
      verifyAndSettle(URL, provider(pair.operation.operationId))
    );
    assert.equal(outcomes.deadlocksAfter, outcomes.deadlocksBefore, 'PostgreSQL detected a deadlock');
    assert.equal(outcomes.retry.result, 'stored');
    assert.equal(outcomes.retry.operationId, pair.operation.operationId);
    assert.equal(outcomes.retry.squarePaymentId, PAYMENT_ID);
    assert.equal(outcomes.other.result, 'settled');
    assert.equal(outcomes.other.settlementCommitted, true);
    assert.equal(outcomes.other.financiallySettled, true);
    await assertCommittedPair(pair);
  });

  test('operation retry versus webhook ingestion completes without a row-lock deadlock', async () => {
    const pair = await authorizedPair();
    const outcomes = await contendWithOperationRetry(pair, () => ingestObservation(
      URL, provider(pair.operation.operationId, observation({ eventId: 'evt-7d-retry-webhook' }))
    ));
    assert.equal(outcomes.deadlocksAfter, outcomes.deadlocksBefore);
    assert.equal(outcomes.retry.result, 'stored');
    assert.equal(outcomes.retry.operationId, pair.operation.operationId);
    assert.equal(outcomes.other.result, 'settled');
    assert.equal(outcomes.other.settlementCommitted, true);
    await assertCommittedPair(pair);
  });

  test('operation retry versus payment association completes without a row-lock deadlock', async () => {
    const pair = await authorizedPair();
    const outcomes = await contendWithOperationRetry(pair, () => associatePayment(URL, context({
      operationId: pair.operation.operationId, squarePaymentId: PAYMENT_ID,
    })));
    assert.equal(outcomes.deadlocksAfter, outcomes.deadlocksBefore);
    assert.equal(outcomes.retry.result, 'stored');
    assert.equal(outcomes.retry.operationId, pair.operation.operationId);
    assert.equal(outcomes.other.result, 'pending');
    assert.equal(outcomes.other.operationId, pair.operation.operationId);
    assertUnsettled(outcomes.other);
    assert.equal((await counts()).operations, 1);
    assert.equal((await counts()).settlements, 0);
    await verifyAndSettle(URL, provider(pair.operation.operationId));
    await assertCommittedPair(pair);
  });

  test('two operation retries preserve one operation under controlled contention', async () => {
    const pair = await authorizedPair();
    const outcomes = await contendWithOperationRetry(pair, () => createOperation(URL, context({
      obligationId: pair.obligation.obligationId, idempotencyKey: 'sandbox-op-7d-001',
    })));
    assert.equal(outcomes.deadlocksAfter, outcomes.deadlocksBefore);
    for (const retry of [outcomes.retry, outcomes.other]) {
      assert.equal(retry.result, 'stored');
      assert.equal(retry.operationId, pair.operation.operationId);
      assert.equal(retry.squarePaymentId, PAYMENT_ID);
      assertUnsettled(retry);
    }
    assert.equal((await counts()).operations, 1);
    assert.equal((await counts()).settlements, 0);
  });

  test('verification versus webhook ingestion preserves the advisory-lock regression', async () => {
    const pair = await authorizedPair();
    const observer = await connectProven(URL);
    const blocker = await connectProven(URL);
    let verification;
    let webhook;
    try {
      const before = await deadlockCount(observer);
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT operation_id FROM sandbox_payment_operation WHERE operation_id = $1 FOR UPDATE',
        [pair.operation.operationId]
      );
      verification = verifyAndSettle(URL, provider(pair.operation.operationId));
      const verifier = await waitForLockState(
        observer, 'SELECT * FROM sandbox_payment_operation WHERE operation_id = $1 FOR UPDATE'
      );
      assert.equal(verifier.holds_advisory, true);
      webhook = ingestObservation(URL, provider(pair.operation.operationId, observation({
        eventId: 'evt-7d-advisory-regression',
      })));
      const receiver = await waitForLockState(
        observer, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [verifier.pid]
      );
      assert.notEqual(receiver.pid, verifier.pid);
      await blocker.query('COMMIT');
      const outcomes = await Promise.all([verification, webhook]);
      assert.deepEqual(outcomes.map((item) => item.result).sort(), ['already_settled', 'settled']);
      assert.equal(outcomes.filter((item) => item.settlementCommitted).length, 1);
      assert.equal(outcomes.every((item) => item.financiallySettled), true);
      assert.equal(await deadlockCount(observer), before);
      await assertCommittedPair(pair);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await Promise.allSettled([verification, webhook].filter(Boolean));
      await Promise.all([observer.end(), blocker.end()]);
    }
  });

  test('concurrent creation and association preserve obligation, key, and payment uniqueness', async () => {
    const obligations = await Promise.all(['A', 'B'].map((suffix) => createObligation(URL, context({
      bookingRef: `TEST-SQ-CONCURRENT-${suffix}`, purpose: PURPOSE, amountCents: 100, currency: 'USD',
    }))));
    const sharedKey = await Promise.all(obligations.map((item) => createOperation(URL, context({
      obligationId: item.obligationId, idempotencyKey: 'sandbox-op-shared-key',
    }))));
    const first = sharedKey.find((item) => item.result === 'stored');
    assert.ok(first);
    assert.equal(sharedKey.filter((item) => item.result === 'rejected').length, 1);
    const remaining = obligations.find((item) => item.obligationId !== first.obligationId);
    const sharedObligation = await Promise.all(['a', 'b'].map((suffix) => createOperation(URL, context({
      obligationId: remaining.obligationId, idempotencyKey: `sandbox-op-new-${suffix}`,
    }))));
    const second = sharedObligation.find((item) => item.result === 'stored');
    assert.ok(second);
    assert.equal(sharedObligation.filter((item) => item.result === 'rejected').length, 1);
    assert.notEqual(first.operationId, second.operationId);
    assert.equal((await counts()).operations, 2);
    const associations = await Promise.all([first, second].map((item) => associatePayment(URL, context({
      operationId: item.operationId, squarePaymentId: PAYMENT_ID,
    }))));
    const associated = associations.find((item) => item.result === 'pending');
    assert.ok(associated);
    assert.equal(associations.filter((item) => item.result === 'rejected').length, 1);
    const committed = await verifyAndSettle(URL, provider(associated.operationId));
    assert.equal(committed.result, 'settled');
    await assertCommittedPair({
      operation: { operationId: associated.operationId },
      obligation: { obligationId: associated.obligationId },
    });
  });

  test('simultaneous duplicate webhooks retain one inbox event and one settlement', async () => {
    const pair = await authorizedPair();
    const input = provider(pair.operation.operationId, observation({ eventId: 'evt-7d-concurrent-duplicate' }));
    const outcomes = await Promise.all([ingestObservation(URL, input), ingestObservation(URL, input)]);
    assert.deepEqual(outcomes.map((item) => item.result).sort(), ['already_settled', 'settled']);
    assert.equal(outcomes.filter((item) => item.settlementCommitted).length, 1);
    const client = await connectProven(URL);
    try {
      const event = await client.query(
        'SELECT count(*)::int AS count FROM sandbox_payment_event WHERE event_id = $1',
        ['evt-7d-concurrent-duplicate']
      );
      assert.equal(event.rows[0].count, 1);
    } finally {
      await client.end();
    }
    await assertCommittedPair(pair);
  });

  test('idempotent operation retries cannot rewrite financial identity or authorization', async () => {
    const pair = await authorizedPair();
    const client = await connectProven(URL);
    const sql = `SELECT operation_id, obligation_id, idempotency_key, square_payment_id,
                        expected_amount_cents, currency, expected_merchant_id, expected_location_id, status
                 FROM sandbox_payment_operation WHERE operation_id = $1`;
    try {
      const before = (await client.query(sql, [pair.operation.operationId])).rows;
      const other = await createObligation(URL, context({
        bookingRef: 'TEST-SQ-OTHER-OBLIGATION', purpose: PURPOSE, amountCents: 100, currency: 'USD',
      }));
      for (const changed of [{ amountCents: 101 }, { currency: 'EUR' }, { obligationId: other.obligationId }]) {
        const rejected = await createOperation(URL, context({
          obligationId: pair.obligation.obligationId, idempotencyKey: 'sandbox-op-7d-001', ...changed,
        }));
        assert.equal(rejected.result, 'rejected');
        assert.equal(rejected.error, 'square_settlement_idempotency_conflict');
        assertUnsettled(rejected);
      }
      // A supplied payment id is not an association command and is ignored.
      const replay = await createOperation(URL, context({
        obligationId: pair.obligation.obligationId, idempotencyKey: 'sandbox-op-7d-001',
        squarePaymentId: 'sandboxPay7dReplacement',
      }));
      assert.equal(replay.result, 'stored');
      assert.equal(replay.operationId, pair.operation.operationId);
      assert.equal(replay.squarePaymentId, PAYMENT_ID);
      assert.deepEqual((await client.query(sql, [pair.operation.operationId])).rows, before);
      assert.equal((await counts()).operations, 1);
      assert.equal((await counts()).settlements, 0);
    } finally {
      await client.end();
    }
  });

  test('a retry after settlement follows the rejected already-settled contract without reopening', async () => {
    const pair = await authorizedPair();
    await verifyAndSettle(URL, provider(pair.operation.operationId));
    const [retry, verified] = await Promise.all([
      createOperation(URL, context({
        obligationId: pair.obligation.obligationId, idempotencyKey: 'sandbox-op-7d-001',
      })),
      verifyAndSettle(URL, provider(pair.operation.operationId)),
    ]);
    assert.equal(retry.result, 'rejected');
    assert.equal(retry.error, 'square_settlement_obligation_already_settled');
    assert.equal(retry.operationId, pair.operation.operationId);
    assert.equal(retry.squarePaymentId, PAYMENT_ID);
    assert.equal(retry.financiallySettled, true);
    assert.equal(retry.settlementCommitted, false);
    assert.equal(verified.result, 'already_settled');
    assert.equal(verified.settlementCommitted, false);
    await assertCommittedPair(pair);
  });

  test('provider retrieval holds no transaction gate or financial row lock', async () => {
    const pair = await authorizedPair();
    let retry;
    const settled = await verifyAndSettle(URL, provider(pair.operation.operationId, {
      timeoutMs: 3000,
      fetchImpl: async () => {
        retry = await createOperation(URL, context({
          obligationId: pair.obligation.obligationId, idempotencyKey: 'sandbox-op-7d-001',
        }));
        return mockFetch(paymentBody())();
      },
    }));
    assert.equal(retry.result, 'stored');
    assert.equal(retry.operationId, pair.operation.operationId);
    assert.equal(settled.result, 'settled');
    await assertCommittedPair(pair);
  });

  test('association rollback releases locks and preserves the early event for recovery', async () => {
    const obligation = await createObligation(URL, context({
      bookingRef: 'TEST-SQ-ASSOCIATION-ROLLBACK', purpose: PURPOSE, amountCents: 100, currency: 'USD',
    }));
    const operation = await createOperation(URL, context({
      obligationId: obligation.obligationId, idempotencyKey: 'sandbox-op-7d-001',
    }));
    await ingestObservation(URL, observation({ eventId: 'evt-7d-association-rollback' }));
    const rolledBack = await associatePayment(URL, context({
      operationId: operation.operationId, squarePaymentId: PAYMENT_ID, fault: 'before_commit',
    }));
    assert.equal(rolledBack.error, 'square_settlement_rolled_back');
    assertUnsettled(rolledBack);
    const client = await connectProven(URL);
    try {
      const stored = await client.query(
        'SELECT square_payment_id, status FROM sandbox_payment_operation WHERE operation_id = $1',
        [operation.operationId]
      );
      assert.deepEqual(stored.rows, [{ square_payment_id: null, status: 'open' }]);
      assert.equal((await counts()).events, 1);
      assert.equal((await counts()).settlements, 0);
    } finally {
      await client.end();
    }
    const recovered = await associatePayment(URL, provider(operation.operationId, { squarePaymentId: PAYMENT_ID }));
    assert.equal(recovered.result, 'settled');
    await assertCommittedPair({ obligation, operation });
  });

  test('a second payment cannot settle an obligation, and one payment cannot bind two obligations', async () => {
    const { obligation, operation } = await authorizedPair();
    await verifyAndSettle(URL, provider(operation.operationId));
    const secondOperation = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-second',
    }));
    assert.equal(secondOperation.result, 'rejected');
    assert.equal(secondOperation.financiallySettled, true);
    assert.equal(secondOperation.settlementCommitted, false);
    assert.equal((await counts()).settlements, 1);

    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
    const first = await authorizedPair(PAYMENT_ID, 'sandbox-op-7d-one');
    const otherObligation = await createObligation(URL, context({
      bookingRef: 'TEST-SQ-7D-B',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
    }));
    const otherOperation = await createOperation(URL, context({
      obligationId: otherObligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-two',
    }));
    const stolen = await associatePayment(URL, context({
      operationId: otherOperation.operationId,
      squarePaymentId: PAYMENT_ID,
    }));
    assert.equal(stolen.result, 'rejected');
    assertUnsettled(stolen);
    const settled = await verifyAndSettle(URL, provider(first.operation.operationId));
    assert.equal(settled.obligationId, first.obligation.obligationId);
    assert.equal((await counts()).settlements, 1);
  });

  test('settlement rollback can be retried, and a conflicting row is read back', async () => {
    const { operation } = await authorizedPair();
    await ingestObservation(URL, observation({ eventId: 'evt-7d-kept' }));
    const failed = await verifyAndSettle(URL, provider(operation.operationId, { fault: 'before_commit' }));
    assert.equal(failed.result, 'failed');
    assert.equal(failed.error, 'square_settlement_rolled_back');
    assertUnsettled(failed);
    assert.equal(failed.retrySafe, true);
    assert.equal((await counts()).settlements, 0);
    // Retrieval history is now durable before settlement starts. Rollback
    // preserves that evidence while rolling back every financial mutation.
    assert.equal((await counts()).events, 2);
    assert.equal((await inboxRows()).filter((e) => e.event_type === 'provider.retrieve'
      && e.processing_status === 'verification_required').length, 1);
    const retried = await verifyAndSettle(URL, provider(operation.operationId));
    assert.equal(retried.result, 'settled');
    assert.equal(retried.settlementCommitted, true);
    const again = await verifyAndSettle(URL, provider(operation.operationId));
    assert.equal(again.result, 'already_settled');
    assert.equal(again.financiallySettled, true);
    assert.equal(again.settlementCommitted, false);
    assert.equal(again.obligationId, retried.obligationId);
    assert.equal(again.operationId, retried.operationId);
    assert.equal(again.squarePaymentId, PAYMENT_ID);
    assert.equal((await counts()).settlements, 1);

    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
    const conflicted = await authorizedPair(PAYMENT_ID, 'sandbox-op-conflict');
    const client = await connectProven(URL);
    try {
      await client.query(
        `INSERT INTO sandbox_settlement
          (settlement_id, obligation_id, operation_id, square_payment_id, settled_amount_cents, currency)
         VALUES ('stl-manual', $1, $2, $3, 50, 'USD')`,
        [conflicted.obligation.obligationId, conflicted.operation.operationId, PAYMENT_ID]
      );
    } finally {
      await client.end();
    }
    const conflict = await verifyAndSettle(URL, provider(conflicted.operation.operationId));
    assert.equal(conflict.result, 'rejected');
    assert.equal(conflict.error, 'square_settlement_conflict');
    assertUnsettled(conflict);
    assert.equal((await counts()).settlements, 1);
  });

  test('operation persistence failure does not settle, and the same key can be retried', async () => {
    const obligation = await createObligation(URL, context({
      bookingRef: 'TEST-SQ-7D',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
    }));
    const failed = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
      fault: 'operation_insert',
    }));
    assert.equal(failed.result, 'failed');
    assert.equal(failed.retrySafe, true);
    assert.equal((await counts()).operations, 0);
    const stored = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
    }));
    const replay = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
    }));
    const conflict = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
      amountCents: 250,
    }));
    assert.equal(stored.operationId, replay.operationId);
    assert.equal(conflict.error, 'square_settlement_idempotency_conflict');
    assert.equal((await counts()).operations, 1);
    assert.equal((await counts()).settlements, 0);
  });

  test('an early event waits for association and verified completion', async () => {
    const early = await ingestObservation(URL, observation({ eventId: 'evt-7d-early' }));
    assert.equal(early.result, 'stored');
    assert.equal(early.processingStatus, 'awaiting_association');
    assertUnsettled(early);
    assert.equal((await counts()).operations, 0);
    assert.equal((await counts()).settlements, 0);
    const obligation = await createObligation(URL, context({
      bookingRef: 'TEST-SQ-7D',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
    }));
    const operation = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
    }));
    const waiting = await associatePayment(URL, context({
      operationId: operation.operationId,
      squarePaymentId: PAYMENT_ID,
    }));
    assert.equal(waiting.processingStatus, 'verification_required');
    assertUnsettled(waiting);
    const associated = await associatePayment(URL, provider(operation.operationId, {
      squarePaymentId: PAYMENT_ID,
    }));
    assert.equal(associated.result, 'settled');
    assert.equal(associated.settlementCommitted, true);
    const repeated = await verifyAndSettle(URL, provider(operation.operationId));
    assert.equal(repeated.result, 'already_settled');
    assert.equal(repeated.financiallySettled, true);
    assert.equal(repeated.settlementCommitted, false);
    assert.equal((await counts()).settlements, 1);
    assert.equal((await counts()).events >= 2, true);
  });

  test('event order and forged timestamps do not regress a committed settlement', async () => {
    const { operation } = await authorizedPair();
    const pending = await ingestObservation(URL, observation({
      eventId: 'evt-7d-pending',
      paymentStatus: 'PENDING',
      observedAt: '2026-10-26T03:00:00.000Z',
    }));
    const completed = await ingestObservation(URL, observation({
      eventId: 'evt-7d-completed-later',
      observedAt: '2026-10-26T01:00:00.000Z',
    }));
    assert.equal(pending.result, 'pending');
    assert.equal(completed.processingStatus, 'verification_required');
    assertUnsettled(pending);
    assertUnsettled(completed);
    const settled = await verifyAndSettle(URL, provider(operation.operationId));
    const olderPending = await ingestObservation(URL, observation({
      eventId: 'evt-7d-old-pending',
      paymentStatus: 'PENDING',
      observedAt: '2000-01-01T00:00:00.000Z',
    }));
    const approvedLater = await ingestObservation(URL, observation({
      eventId: 'evt-7d-approved-later',
      eventType: 'payment.created',
      paymentStatus: 'APPROVED',
      observedAt: '2099-01-01T00:00:00.000Z',
    }));
    const sameTime = await ingestObservation(URL, observation({
      eventId: 'evt-7d-same-time',
      observedAt: '2026-10-26T01:00:00.000Z',
    }));
    assert.equal(settled.result, 'settled');
    assert.equal(olderPending.result, 'already_settled');
    assert.equal(approvedLater.result, 'already_settled');
    assert.equal(sameTime.result, 'already_settled');
    assert.equal(approvedLater.financiallySettled, true);
    assert.equal(approvedLater.settlementCommitted, false);
    assert.equal((await counts()).settlements, 1);
  });

  test('a provider retrieval that disagrees with the webhook does not settle', async () => {
    const { operation } = await authorizedPair();
    await ingestObservation(URL, observation({ eventId: 'evt-7d-webhook' }));
    const mismatch = await verifyAndSettle(URL, provider(operation.operationId, {
      timeoutMs: 50,
    }, { amount: 250 }));
    assert.equal(mismatch.result, 'quarantined');
    assertUnsettled(mismatch);
    assert.equal((await counts()).settlements, 0);
    assert.equal((await counts()).events >= 1, true);
  });

  test('a provider timeout does not settle', async () => {
    const { operation } = await authorizedPair();
    const timeout = await verifyAndSettle(URL, provider(operation.operationId, {
      timeoutMs: 30,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    }));
    assert.equal(timeout.result, 'failed');
    assert.equal(timeout.retrySafe, true);
    assertUnsettled(timeout);
    assert.equal((await counts()).settlements, 0);
  });

  test('settled obligation status without a settlement row is not financially settled', async () => {
    const { obligation } = await authorizedPair();
    const client = await connectProven(URL);
    try {
      await client.query(
        "UPDATE sandbox_payment_obligation SET status = 'settled' WHERE obligation_id = $1",
        [obligation.obligationId]
      );
    } finally {
      await client.end();
    }
    const outcome = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-status-only',
    }));
    assert.equal(outcome.result, 'failed');
    assert.equal(outcome.error, 'square_settlement_state_inconsistent');
    assertUnsettled(outcome);
    assert.equal((await counts()).settlements, 0);
  });

  test('commercial booking input and an unknown obligation are rejected', async () => {
    const commercial = await createObligation(URL, context({
      bookingRef: 'CD1-REAL',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
    }));
    assert.equal(commercial.result, 'rejected');
    const browser = await createObligation(URL, context({
      bookingRef: 'TEST-SQ-7D',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
      browserAmountCents: 1,
    }));
    assert.equal(browser.result, 'rejected');
    const missing = await createOperation(URL, context({
      obligationId: 'obl-missing',
      idempotencyKey: 'sandbox-op-missing',
    }));
    assert.equal(missing.error, 'square_settlement_obligation_unknown');
    const receipt = await ingestObservation(URL, observation({
      payment: { receipt_url: 'https://example.invalid/receipt' },
    }));
    assert.equal(receipt.error, 'square_settlement_receipt_not_proof');
    assertUnsettled(receipt);
    assert.equal((await counts()).settlements, 0);
  });

  for (const [name, mismatch] of [['amount', { amount: 101 }], ['identity', { id: 'DifferentPayment9j' }]]) {
    test(`P1-3 durable ${name} quarantine defeats an earlier in-flight retrieval`, async () => {
      const pair = await authorizedPair();
      let enter;
      const entered = new Promise((resolve) => { enter = resolve; });
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const earlier = ingestObservation(URL, provider(pair.operation.operationId, observation({
        eventId: 'evt-9j-earlier', timeoutMs: 10000,
        fetchImpl: async () => { enter(); await gate; return mockFetch(paymentBody())(); },
      })));
      try {
        await entered;
        const conflict = await ingestObservation(URL, provider(pair.operation.operationId,
          observation({ eventId: 'evt-9j-conflict' }), mismatch));
        assert.equal(conflict.result, 'quarantined');
        assert.equal((await inboxRows()).filter((e) => e.processing_status === 'quarantined').length, 1);
        assert.equal((await counts()).settlements, 0);
        release();
        const outcome = await earlier;
        assert.equal(outcome.result, 'quarantined');
        assertUnsettled(outcome);
        assert.equal((await counts()).settlements, 0);
        await assertStoredAuthorization(pair);
      } finally { release(); await earlier; }
    });
  }

  test('P1-3 a later conflicting event surfaces investigation without rewriting settlement', async () => {
    const pair = await authorizedPair();
    assert.equal((await verifyAndSettle(URL, provider(pair.operation.operationId))).result, 'settled');
    const late = await ingestObservation(URL, observation({ eventId: 'evt-9j-late-conflict', amountCents: 101 }));
    assert.equal(late.result, 'already_settled');
    assert.equal(late.financiallySettled, true);
    assert.equal(late.settlementCommitted, false);
    assert.equal(late.investigationRequired, true);
    assert.equal(late.error, 'square_settlement_observations_conflict');
    assert.equal((await inboxRows()).find((e) => e.event_id === 'evt-9j-late-conflict').processing_status, 'inconsistent');
    await assertCommittedPair(pair);
  });

  test('P1-4 failed outcome update leaves a durable fence that a good retry cannot erase', async () => {
    const pair = await authorizedPair();
    const client = await connectProven(URL);
    try {
      await client.query(`CREATE OR REPLACE FUNCTION fail_history_9j() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event_type = 'provider.retrieve' AND NEW.processing_status = 'quarantined'
          THEN RAISE EXCEPTION USING ERRCODE = '58000', MESSAGE = 'synthetic history fault'; END IF;
        RETURN NEW; END $$`);
      await client.query(`CREATE TRIGGER fail_history_9j BEFORE INSERT OR UPDATE ON sandbox_payment_event
        FOR EACH ROW EXECUTE FUNCTION fail_history_9j()`);
      const failed = await ingestObservation(URL, provider(pair.operation.operationId,
        observation({ eventId: 'evt-9j-history-fault' }), { amount: 101 }));
      assert.equal(failed.result, 'failed');
      assert.equal(failed.error, 'square_settlement_verification_history_unconfirmed');
      assert.equal(failed.databaseCommitState, 'rolled_back');
      assertUnsettled(failed);
      assert.equal((await counts()).settlements, 0);
      assert.equal((await inboxRows()).filter((e) => e.processing_status === 'verification_pending').length, 1);
    } finally {
      await client.query('DROP TRIGGER IF EXISTS fail_history_9j ON sandbox_payment_event');
      await client.query('DROP FUNCTION IF EXISTS fail_history_9j()');
      await client.end();
    }
    const good = await ingestObservation(URL, provider(pair.operation.operationId, observation({ eventId: 'evt-9j-good-retry' })));
    assert.equal(good.error, 'square_settlement_verification_pending');
    assertUnsettled(good);
    assert.equal((await counts()).settlements, 0);
    const rechecked = await ingestObservation(URL, provider(pair.operation.operationId,
      observation({ eventId: 'evt-9j-conflict-rechecked' }), { amount: 101 }));
    assert.equal(rechecked.result, 'quarantined');
    let calls = 0;
    const later = await ingestObservation(URL, provider(pair.operation.operationId, observation({
      eventId: 'evt-9j-after-recovery', fetchImpl: async () => { calls++; return mockFetch(paymentBody())(); },
    })));
    assert.equal(later.result, 'quarantined');
    assert.equal(calls, 0);
    assert.equal((await counts()).settlements, 0);
    await assertStoredAuthorization(pair);
  });

  test('P1-4 insertion failure stops retrieval before financial evidence can be lost', async () => {
    const pair = await authorizedPair();
    const fault = serviceWithHistoryFault('insert');
    let calls = 0;
    const failed = await fault.api.verifyAndSettle(URL, provider(pair.operation.operationId, {
      fetchImpl: async () => { calls++; return mockFetch(paymentBody({ amount: 101 }))(); },
    }));
    assert.equal(fault.injections(), 1);
    assert.equal(calls, 0);
    assert.equal(failed.result, 'failed');
    assert.equal(failed.databaseCommitState, 'rolled_back');
    assertUnsettled(failed);
    assert.equal((await inboxRows()).length, 0);
    const retry = await ingestObservation(URL, provider(pair.operation.operationId,
      observation({ eventId: 'evt-9j-insert-recovery' }), { amount: 101 }));
    assert.equal(retry.result, 'quarantined');
    assert.equal((await counts()).settlements, 0);
  });

  for (const mode of ['outcome-before', 'outcome-after', 'cleanup']) {
    test(`P1-4 ${mode} persistence fault distinguishes durable quarantine from an unresolved fence`, async () => {
      const pair = await authorizedPair();
      const fault = serviceWithHistoryFault(mode);
      const failed = await fault.api.verifyAndSettle(URL, provider(pair.operation.operationId, {}, { amount: 101 }));
      assert.equal(fault.injections(), 1);
      assert.equal(failed.result, 'failed');
      assert.equal(failed.error, 'square_settlement_verification_history_unconfirmed');
      assert.equal(failed.databaseCommitState, mode === 'cleanup' ? 'committed' : 'unknown');
      assert.equal(failed.databaseCleanupFailed, mode === 'cleanup' ? true : undefined);
      assertUnsettled(failed);
      const evidence = (await inboxRows()).filter((e) => e.event_type === 'provider.retrieve');
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].processing_status, mode === 'outcome-before' ? 'verification_pending' : 'quarantined');
      const retried = await ingestObservation(URL, provider(pair.operation.operationId,
        observation({ eventId: 'evt-9j-ack-retry' })));
      assertUnsettled(retried);
      if (mode === 'outcome-before') {
        assert.equal(retried.error, 'square_settlement_verification_pending');
        const bad = await ingestObservation(URL, provider(pair.operation.operationId,
          observation({ eventId: 'evt-9j-ack-recheck' }), { amount: 101 }));
        assert.equal(bad.result, 'quarantined');
      } else {
        assert.equal(retried.result, 'quarantined');
      }
      assert.equal((await counts()).settlements, 0);
      await assertStoredAuthorization(pair);
    });
  }

  for (const mode of ['registration-before', 'registration-after']) {
    test(`P1-4 ${mode} acknowledgement fault never starts retrieval`, async () => {
      const pair = await authorizedPair();
      const fault = serviceWithHistoryFault(mode);
      let calls = 0;
      const failed = await fault.api.verifyAndSettle(URL, provider(pair.operation.operationId, {
        fetchImpl: async () => { calls++; return mockFetch(paymentBody())(); },
      }));
      assert.equal(fault.injections(), 1);
      assert.equal(calls, 0);
      assert.equal(failed.databaseCommitState, 'unknown');
      assertUnsettled(failed);
      assert.equal((await inboxRows()).length, mode === 'registration-after' ? 1 : 0);
      const retry = await ingestObservation(URL, provider(pair.operation.operationId,
        observation({ eventId: 'evt-9j-registration-retry' })));
      if (mode === 'registration-after') {
        assert.equal(retry.error, 'square_settlement_verification_pending');
        assertUnsettled(retry);
        assert.equal((await counts()).settlements, 0);
      } else {
        assert.equal(retry.result, 'settled');
        await assertCommittedPair(pair);
      }
    });
  }

  test('P1-3 failure to inspect current evidence cannot authorize settlement', async () => {
    const pair = await authorizedPair();
    const fault = serviceWithHistoryFault('inspect');
    const failed = await fault.api.verifyAndSettle(URL, provider(pair.operation.operationId));
    assert.equal(fault.injections(), 1);
    assert.equal(failed.result, 'failed');
    assert.equal(failed.databaseCommitState, 'rolled_back');
    assertUnsettled(failed);
    assert.equal((await counts()).settlements, 0);
    const retry = await verifyAndSettle(URL, provider(pair.operation.operationId));
    assert.equal(retry.result, 'settled');
    await assertCommittedPair(pair);
  });

  test('P1-4 cleanup failure preserves the truth of an acknowledged settlement COMMIT', async () => {
    const pair = await authorizedPair();
    const fault = serviceWithHistoryFault('settlement-cleanup');
    const settled = await fault.api.verifyAndSettle(URL, provider(pair.operation.operationId));
    assert.equal(fault.injections(), 1);
    assert.equal(settled.result, 'settled');
    assert.equal(settled.financiallySettled, true);
    assert.equal(settled.settlementCommitted, true);
    assert.equal(settled.databaseCleanupFailed, true);
    assert.equal(settled.databaseCommitState, 'committed');
    await assertCommittedPair(pair);
  });

  test('P1-4 an unresolved concurrent outcome blocks an earlier valid retrieval', async () => {
    const pair = await authorizedPair();
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const earlier = verifyAndSettle(URL, provider(pair.operation.operationId, {
      timeoutMs: 10000, fetchImpl: async () => { enter(); await gate; return mockFetch(paymentBody())(); },
    }));
    try {
      await entered;
      const fault = serviceWithHistoryFault('outcome-before');
      const failed = await fault.api.verifyAndSettle(URL, provider(pair.operation.operationId, {}, { amount: 101 }));
      assert.equal(fault.injections(), 1);
      assert.equal(failed.result, 'failed');
      assertUnsettled(failed);
      release();
      const valid = await earlier;
      assert.equal(valid.error, 'square_settlement_verification_pending');
      assertUnsettled(valid);
      assert.equal((await counts()).settlements, 0);
      await assertStoredAuthorization(pair);
    } finally { release(); await earlier; }
  });

  test('P1-4 a missing provider identity is quarantined even without usable payment fields', async () => {
    const pair = await authorizedPair();
    const body = paymentBody();
    delete body.payment.id;
    const bad = await verifyAndSettle(URL, provider(pair.operation.operationId, { fetchImpl: mockFetch(body) }));
    assert.equal(bad.result, 'quarantined');
    let calls = 0;
    const retry = await ingestObservation(URL, provider(pair.operation.operationId, observation({
      eventId: 'evt-9j-missing-identity', fetchImpl: async () => { calls++; return mockFetch(paymentBody())(); },
    })));
    assert.equal(retry.result, 'quarantined');
    assert.equal(calls, 0);
    assertUnsettled(retry);
    assert.equal((await counts()).settlements, 0);
  });

  for (const mode of ['outcome-connect', 'adapter-throw']) {
    test(`P1-4 ${mode} failure preserves an unresolved fence`, async () => {
      const pair = await authorizedPair();
      const fault = serviceWithHistoryFault(mode);
      const failed = await fault.api.verifyAndSettle(URL, provider(pair.operation.operationId, {}, { amount: 101 }));
      assert.equal(fault.injections(), 1);
      assert.equal(failed.result, 'failed');
      assert.equal(failed.error, mode === 'adapter-throw' ? 'square_settlement_provider_unknown'
        : 'square_settlement_verification_history_unconfirmed');
      assertUnsettled(failed);
      assert.equal((await inboxRows()).filter((e) => e.processing_status === 'verification_pending').length, 1);
      const retry = await ingestObservation(URL, provider(pair.operation.operationId,
        observation({ eventId: 'evt-9j-unresolved-retry' })));
      assert.equal(retry.error, 'square_settlement_verification_pending');
      assertUnsettled(retry);
      assert.equal((await counts()).settlements, 0);
    });
  }

  test('P1-3 settlement between operation read and verification registration prevents a late retrieval', async () => {
    const pair = await authorizedPair();
    const delayed = serviceWithHistoryFault('preflight-barrier');
    let calls = 0;
    const later = delayed.api.verifyAndSettle(URL, provider(pair.operation.operationId, {
      fetchImpl: async () => { calls++; return mockFetch(paymentBody({ amount: 101 }))(); },
    }));
    try {
      await delayed.entered;
      const first = await verifyAndSettle(URL, provider(pair.operation.operationId));
      assert.equal(first.result, 'settled');
      delayed.release();
      const outcome = await later;
      assert.equal(outcome.result, 'already_settled');
      assert.equal(outcome.financiallySettled, true);
      assert.equal(outcome.settlementCommitted, false);
      assert.equal(calls, 0);
      await assertCommittedPair(pair);
    } finally { delayed.release(); await later; }
  });

  test('commercial financial code is not imported and the provider stays disabled', () => {
    assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
    const src = fs.readFileSync(path.join(ROOT, 'sandbox/square-settlement/square-sandbox-settlement.js'), 'utf8');
    assert.equal(src.includes(ADAPTER_COMMIT), true);
    assert.equal(src.includes("configuredBy: 'server'"), true);
    assert.doesNotMatch(src, /sourceKind === 'authenticated_event'/);
    assert.doesNotMatch(src, /trusted\.configuredBy/);
    assert.doesNotMatch(src, /require\([^)]*(payment-service|payment-authority-service|@prisma|prisma|stripe|square-sandbox-webhook)/);
    assert.doesNotMatch(src, /PaymentAttempt|LedgerEntry|booking\.paymentStatus/);
    const schema = fs.readFileSync(path.join(ROOT, 'sandbox/square-settlement/schema.sql'), 'utf8');
    assert.doesNotMatch(schema, /drop\s+table|PaymentAttempt|LedgerEntry/i);
    const migrations = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).join('\n');
    assert.equal(migrations.includes('sandbox_settlement'), false);
    for (const file of [
      'netlify/functions/submit-booking.js',
      'netlify/functions/stripe-webhook.js',
      'netlify/lib/payment-provider-adapter.js',
      'netlify/lib/payment-service.js',
      'sandbox/square-webhook/netlify/functions/square-sandbox-webhook.js',
    ]) {
      assert.equal(fs.readFileSync(path.join(ROOT, file), 'utf8').includes('square-sandbox-settlement'), false, file);
    }
    assert.match(
      fs.readFileSync(path.join(ROOT, 'netlify/lib/deploy-runtime-env.generated.js'), 'utf8'),
      /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/
    );
  });
});
