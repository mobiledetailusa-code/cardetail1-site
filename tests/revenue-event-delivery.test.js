const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const CLIENT_PATH = path.join(root, 'assets', 'revenue-events.js');
const HANDLER_PATH = require.resolve('../netlify/functions/revenue-event');
const RATE_LIMIT_PATH = require.resolve('../netlify/lib/public-rate-limit');
const STORE_PATH = require.resolve('../netlify/lib/revenue-store');
const RealDate = Date;

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    clear() { data.clear(); },
    _data: data,
  };
}

function response(status, headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return normalized[String(name).toLowerCase()] ?? null; } },
  };
}

function clientHarness({ outcomes = [], sessionStorage, localStorage, consent = false } = {}) {
  const session = sessionStorage || memoryStorage();
  const local = localStorage || memoryStorage();
  const timers = [];
  const fetchCalls = [];
  const logs = [];
  let clock = RealDate.parse('2026-08-22T12:00:00.000Z');
  let timerId = 0;
  let uuidCounter = 0;

  function FakeDate(...args) {
    return new RealDate(...(args.length ? args : [clock]));
  }
  FakeDate.now = () => clock;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  const window = {
    crypto: { randomUUID: () => `uuid-${++uuidCounter}` },
    location: { pathname: '/', search: '' },
    innerWidth: 1200,
    Cardetail1Consent: { getConsent: () => ({ analytics: consent, marketing: false }) },
    console: {
      debug: (...args) => logs.push(['debug', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    setTimeout(fn, delay) {
      const item = { id: ++timerId, at: clock + Math.max(0, Number(delay) || 0), fn };
      timers.push(item);
      return item.id;
    },
    fetch(url, options) {
      fetchCalls.push({ url, options, body: JSON.parse(options.body) });
      const outcome = outcomes.length ? outcomes.shift() : response(200);
      if (outcome instanceof Error) return Promise.reject(outcome);
      if (typeof outcome === 'function') return Promise.resolve().then(() => outcome());
      return Promise.resolve(outcome);
    },
  };

  const sandbox = {
    window,
    globalThis: window,
    sessionStorage: session,
    localStorage: local,
    document: { referrer: '', head: { appendChild() {} }, getElementById() { return null; }, createElement() { return {}; } },
    URL,
    Date: FakeDate,
    Promise,
    JSON,
    Object,
    Math,
    Number,
    String,
    Boolean,
    Array,
    isFinite,
    setTimeout: window.setTimeout,
    console: window.console,
  };
  vm.runInNewContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: CLIENT_PATH });

  async function runNextTimer() {
    if (!timers.length) return false;
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const item = timers.shift();
    clock = Math.max(clock, item.at);
    await item.fn();
    await Promise.resolve();
    return true;
  }

  async function runAllTimers(limit = 30) {
    // Let an immediately initiated fetch outcome schedule its retry first.
    await Promise.resolve();
    await Promise.resolve();
    let count = 0;
    while (timers.length && count < limit) {
      await runNextTimer();
      count += 1;
    }
    assert.ok(count < limit, 'timer queue did not settle within the bounded test limit');
  }

  return {
    revenue: window.Cardetail1Revenue,
    sessionStorage: session,
    localStorage: local,
    fetchCalls,
    timers,
    logs,
    runNextTimer,
    runAllTimers,
    async flushNetwork() {
      await Promise.resolve();
      await Promise.resolve();
    },
    now: () => clock,
  };
}

test('client HTTP 200 marks SENT exactly once and never retries success', async () => {
  const h = clientHarness({ outcomes: [response(200)] });
  const id = h.revenue.track('page_view', { event_id: 'evt_http_200', page_type: 'home' });
  assert.equal(h.revenue.getDeliveryStatus(id).state, 'PENDING');
  assert.equal(h.fetchCalls.length, 1, 'keepalive delivery starts before an immediate navigation can unload the page');
  await h.runAllTimers();
  assert.equal(h.revenue.getDeliveryStatus(id).state, 'SENT');
  assert.equal(h.fetchCalls.length, 1);
  h.revenue.track('page_view', { event_id: id, page_type: 'home' });
  await h.runAllTimers();
  assert.equal(h.fetchCalls.length, 1);
});

test('client HTTP 204 is a successful terminal delivery outcome', async () => {
  const h = clientHarness({ outcomes: [response(204)] });
  const id = h.revenue.track('page_view', { event_id: 'evt_http_204' });
  await h.runAllTimers();
  assert.equal(h.revenue.getDeliveryStatus(id).state, 'SENT');
  assert.equal(h.fetchCalls.length, 1);
});

test('client HTTP 400 is terminal and does not enter a retry loop', async () => {
  const h = clientHarness({ outcomes: [response(400), response(200)] });
  const id = h.revenue.track('page_view', { event_id: 'evt_http_400' });
  await h.runAllTimers();
  const status = h.revenue.getDeliveryStatus(id);
  assert.equal(status.state, 'TERMINAL_FAILURE');
  assert.equal(status.failure, 'http_400');
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.timers.length, 0);
});

test('client HTTP 429 is retryable and honors Retry-After without changing event ID', async () => {
  const h = clientHarness({ outcomes: [response(429, { 'Retry-After': '7' }), response(200)] });
  const id = h.revenue.track('page_view', { event_id: 'evt_http_429' });
  await h.runNextTimer();
  const retry = h.revenue.getDeliveryStatus(id);
  assert.equal(retry.state, 'RETRYABLE_FAILURE');
  assert.equal(retry.next_attempt_at - h.now(), 7000);
  await h.runAllTimers();
  assert.equal(h.revenue.getDeliveryStatus(id).state, 'SENT');
  assert.deepEqual(h.fetchCalls.map((call) => call.body.event_id), [id, id]);
  assert.equal(h.fetchCalls[0].body.properties.timestamp, h.fetchCalls[1].body.properties.timestamp);
});

test('client repeated HTTP 429 responses are capped and cannot create a retry storm', async () => {
  const h = clientHarness({ outcomes: Array(6).fill(response(429, { 'Retry-After': '1' })) });
  const id = h.revenue.track('page_view', { event_id: 'evt_http_429_bounded' });
  await h.runAllTimers();
  const status = h.revenue.getDeliveryStatus(id);
  assert.equal(status.state, 'TERMINAL_FAILURE');
  assert.equal(status.attempts, h.revenue._deliveryTest.maxAttempts);
  assert.equal(h.fetchCalls.length, h.revenue._deliveryTest.maxAttempts);
  assert.equal(h.timers.length, 0);
});

for (const code of [500, 503]) {
  test(`client HTTP ${code} retries with a hard cap`, async () => {
    const h = clientHarness({ outcomes: Array(6).fill(response(code)) });
    const id = h.revenue.track('page_view', { event_id: `evt_http_${code}` });
    await h.runAllTimers();
    const status = h.revenue.getDeliveryStatus(id);
    assert.equal(status.state, 'TERMINAL_FAILURE');
    assert.match(status.failure, /^retry_exhausted:http_/);
    assert.equal(status.attempts, h.revenue._deliveryTest.maxAttempts);
    assert.equal(h.fetchCalls.length, h.revenue._deliveryTest.maxAttempts);
  });
}

test('client network rejection is retryable, bounded, and reload-resumable', async () => {
  const session = memoryStorage();
  const first = clientHarness({ outcomes: [new Error('offline')], sessionStorage: session });
  const id = first.revenue.track('page_view', { event_id: 'evt_network_reload' });
  await first.flushNetwork();
  assert.equal(first.revenue.getDeliveryStatus(id).state, 'RETRYABLE_FAILURE');

  const second = clientHarness({ outcomes: [response(200)], sessionStorage: session });
  await second.runAllTimers();
  assert.equal(second.revenue.getDeliveryStatus(id).state, 'SENT');
  assert.equal(second.fetchCalls[0].body.event_id, id);
});

test('client unknown event is terminal locally and never sent', async () => {
  const h = clientHarness();
  const id = h.revenue.track('checkout_opened', { event_id: 'evt_unknown_client' });
  await h.runAllTimers();
  assert.equal(h.revenue.getDeliveryStatus(id).state, 'TERMINAL_FAILURE');
  assert.equal(h.revenue.getDeliveryStatus(id).failure, 'unknown_event');
  assert.equal(h.fetchCalls.length, 0);
});

test('client property allowlist excludes PII from queue and wire payload', async () => {
  const h = clientHarness({ outcomes: [response(200)] });
  h.revenue.track('page_view', {
    event_id: 'evt_no_pii', category: 'cars', email: 'customer@example.com',
    phone: '555-555-0100', card_data: 'never', address: '123 Main',
  });
  await h.runAllTimers();
  const props = h.fetchCalls[0].body.properties;
  assert.equal(props.category, 'cars');
  for (const key of ['email', 'phone', 'card_data', 'address']) assert.equal(props[key], undefined);
});

test('client/server event and property allowlists are exactly equal', () => {
  const h = clientHarness();
  const schema = require('../netlify/lib/revenue-event-schema');
  const contract = h.revenue.getContract();
  assert.deepEqual(contract.events, [...schema.APPROVED_EVENTS].sort());
  assert.deepEqual(contract.properties, [...schema.APPROVED_PROPERTIES].sort());
});

test('analytics failure never blocks booking open, navigation, or submission callbacks', async () => {
  const h = clientHarness({ outcomes: [new Error('offline'), new Error('offline'), new Error('offline')] });
  const actions = [];
  assert.doesNotThrow(() => {
    h.revenue.track('booking_started', { event_id: 'evt_nonblock_open' });
    actions.push('opened');
    h.revenue.track('booking_step_viewed', { event_id: 'evt_nonblock_step', booking_step: 2 });
    actions.push('navigated');
    h.revenue.track('booking_submitted', { event_id: 'evt_nonblock_submit' });
    actions.push('submitted');
  });
  assert.deepEqual(actions, ['opened', 'navigated', 'submitted']);
  assert.equal(h.fetchCalls.length, 3, 'requests start without awaiting or blocking UI work');

  await h.flushNetwork();
  assert.equal(h.revenue.getDeliveryStatus('evt_nonblock_open').state, 'RETRYABLE_FAILURE');
  assert.doesNotThrow(() => {
    actions.push('navigated_after_rejection');
    actions.push('submitted_after_rejection');
  });
  assert.deepEqual(actions.slice(-2), ['navigated_after_rejection', 'submitted_after_rejection']);
});

function validPayload(eventId = 'evt_server_1', overrides = {}) {
  return {
    event: 'page_view',
    event_id: eventId,
    anonymous_session_id: 'sess_server_1',
    properties: { timestamp: '2026-08-22T23:59:59.000Z', page_type: 'home' },
    ...overrides,
  };
}

function serverHarness() {
  const rl = require(RATE_LIMIT_PATH);
  const revenueStore = require(STORE_PATH);
  const originals = {
    enforcePublicRateLimit: rl.enforcePublicRateLimit,
    getRevenueStore: revenueStore.getRevenueStore,
    blobGetJsonStrict: revenueStore.blobGetJsonStrict,
    blobCreateJson: revenueStore.blobCreateJson,
  };
  const stores = { eventIdempotency: new Map(), events: new Map() };
  const writes = [];
  const controls = { failRead: false, failEventWrites: 0, failReservationWrites: 0 };

  rl.enforcePublicRateLimit = async () => ({ blocked: false, allowed: true });
  revenueStore.getRevenueStore = async (name) => ({ name });
  revenueStore.blobGetJsonStrict = async (store, key) => {
    if (controls.failRead) throw new Error('synthetic_strict_read_failure');
    return stores[store.name].get(key) || null;
  };
  revenueStore.blobCreateJson = async (store, key, value) => {
    if (store.name === 'eventIdempotency' && controls.failReservationWrites > 0) {
      controls.failReservationWrites -= 1;
      throw new Error('synthetic_reservation_failure');
    }
    if (store.name === 'events' && controls.failEventWrites > 0) {
      controls.failEventWrites -= 1;
      throw new Error('synthetic_event_failure');
    }
    if (stores[store.name].has(key)) return { created: false, etag: null };
    stores[store.name].set(key, value);
    writes.push({ store: store.name, key, value });
    return { created: true, etag: `etag-${writes.length}` };
  };

  delete require.cache[HANDLER_PATH];
  const handler = require(HANDLER_PATH).handler;
  rl.enforcePublicRateLimit = originals.enforcePublicRateLimit;
  Object.assign(revenueStore, {
    getRevenueStore: originals.getRevenueStore,
    blobGetJsonStrict: originals.blobGetJsonStrict,
    blobCreateJson: originals.blobCreateJson,
  });

  async function post(payload) {
    return handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.90' },
      body: JSON.stringify(payload),
    });
  }
  return { post, stores, writes, controls };
}

test('Blob create helper uses the atomic onlyIfNew conditional', async () => {
  const { blobCreateJson } = require('../netlify/lib/revenue-store');
  let captured;
  const result = await blobCreateJson({
    async set(key, value, options) {
      captured = { key, value, options };
      return { modified: false };
    },
  }, 'evt:key', { ok: true });
  assert.equal(captured.options.onlyIfNew, true);
  assert.equal(result.created, false);
});

test('server duplicate and lost-response replay create one logical event', async () => {
  const h = serverHarness();
  const first = await h.post(validPayload('evt_replay'));
  assert.equal(first.statusCode, 200);
  const replay = await h.post(validPayload('evt_replay'));
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(JSON.parse(replay.body), { ok: true, duplicate: true });
  assert.equal(h.stores.eventIdempotency.size, 1);
  assert.equal(h.stores.events.size, 1);
});

test('server repairs reservation-only partial persistence with the same event key', async () => {
  const h = serverHarness();
  h.controls.failEventWrites = 1;
  const failed = await h.post(validPayload('evt_partial'));
  assert.equal(failed.statusCode, 503);
  assert.equal(h.stores.eventIdempotency.size, 1);
  assert.equal(h.stores.events.size, 0);
  const replay = await h.post(validPayload('evt_partial'));
  assert.equal(replay.statusCode, 200);
  assert.equal(h.stores.events.size, 1);
  const reservation = h.stores.eventIdempotency.get('evt:evt_partial');
  assert.ok(h.stores.events.has(reservation.storeKey));
});

test('two concurrent same-ID requests create one reservation and one logical event', async () => {
  const h = serverHarness();
  const results = await Promise.all([
    h.post(validPayload('evt_concurrent')),
    h.post(validPayload('evt_concurrent')),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode), [200, 200]);
  assert.equal(h.stores.eventIdempotency.size, 1);
  assert.equal(h.stores.events.size, 1);
  assert.equal(results.filter((r) => JSON.parse(r.body).duplicate === true).length, 1);
});

test('same-ID replay across UTC midnight uses the first reservation key', async () => {
  const RealGlobalDate = global.Date;
  let current = '2026-08-22T23:59:59.900Z';
  global.Date = class extends RealGlobalDate {
    constructor(...args) { super(...(args.length ? args : [current])); }
    static now() { return new RealGlobalDate(current).getTime(); }
  };
  try {
    const h = serverHarness();
    const first = await h.post(validPayload('evt_midnight'));
    assert.equal(first.statusCode, 200);
    current = '2026-08-23T00:00:01.000Z';
    const replay = await h.post(validPayload('evt_midnight'));
    assert.equal(replay.statusCode, 200);
    assert.equal(h.stores.events.size, 1);
    assert.ok([...h.stores.events.keys()][0].startsWith('2026-08-22/'));
  } finally {
    global.Date = RealGlobalDate;
  }
});

test('idempotency strict-read failure returns 503 and cannot create another event', async () => {
  const h = serverHarness();
  assert.equal((await h.post(validPayload('evt_read_fail'))).statusCode, 200);
  h.controls.failRead = true;
  const replay = await h.post(validPayload('evt_read_fail'));
  assert.equal(replay.statusCode, 503);
  assert.equal(h.stores.events.size, 1);
  assert.equal(h.stores.eventIdempotency.size, 1);
});

test('same event ID with a conflicting semantic payload is terminal 409', async () => {
  const h = serverHarness();
  assert.equal((await h.post(validPayload('evt_conflict'))).statusCode, 200);
  const conflict = await h.post(validPayload('evt_conflict', {
    properties: { timestamp: '2026-08-23T00:00:00.000Z', page_type: 'hub' },
  }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.body).error, 'event_id_conflict');
  assert.equal(h.stores.events.size, 1);
});

test('server unknown event remains rejected without persistence', async () => {
  const h = serverHarness();
  const res = await h.post(validPayload('evt_server_unknown', { event: 'secret_customer_dump' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'unknown_event');
  assert.equal(h.stores.eventIdempotency.size, 0);
  assert.equal(h.stores.events.size, 0);
});

test('retention representation is truthful and event/idempotency targets match', () => {
  const store = require('../netlify/lib/revenue-store');
  assert.equal(store.RETENTION_DAYS.events, 400);
  assert.equal(store.RETENTION_DAYS.eventIdempotency, 400);
  assert.equal(store.RETENTION_ENFORCEMENT.automaticTtl, false);
  const source = fs.readFileSync(HANDLER_PATH, 'utf8');
  assert.doesNotMatch(source, /expiresAt\s*:/);
});
