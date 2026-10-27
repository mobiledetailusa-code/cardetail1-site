'use strict';

// Entirely offline: instrument the real pg.Client constructor, but replace
// connect/query/end before any socket can be opened. Live checks belong to the
// existing, dedicated-loopback settlement suite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { Client } = require('pg');

const DATABASE = 'cardetail1_square_settlement_7d';
const USER = 'cardetail1_ci';
const BASE = `postgresql://${USER}@127.0.0.1:5433/${DATABASE}`;
const SOURCE = path.join(__dirname, '../sandbox/square-settlement/database.js');
const PASSWORD = 'synthetic-7e9a:p@ss word/%';

function instrument(proof = {}, failure = '') {
  const calls = { constructed: 0, connect: 0, query: 0, end: 0 };
  let config;
  class OfflineClient extends Client {
    constructor(input) {
      super(input);
      calls.constructed++;
      config = input;
    }
    async connect() {
      calls.connect++;
      if (failure === 'connect') throw new Error('offline_connection_failure');
    }
    async query(sql) {
      calls.query++;
      assert.match(sql, /current_database\(\).*inet_server_addr\(\).*inet_server_port\(\)/);
      if (failure === 'query') throw new Error('offline_query_failure');
      return { rows: [{ database: DATABASE, address: '127.0.0.1', port: '5433', user: USER, ...proof }] };
    }
    async end() { calls.end++; }
  }
  const loaded = new Module(SOURCE, module);
  loaded.filename = SOURCE;
  loaded.paths = Module._nodeModulePaths(path.dirname(SOURCE));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (name) => name === 'pg' ? { Client: OfflineClient } : originalRequire(name);
  loaded._compile(fs.readFileSync(SOURCE, 'utf8'), SOURCE);
  return { database: loaded.exports, calls, config: () => config };
}

const rejected = [
  ['host query', `${BASE}?host=example.invalid`],
  ['port query', `${BASE}?port=6543`],
  ['database query', `${BASE}?database=other_database`],
  ['dbname query', `${BASE}?dbname=other_database`],
  ['username query', `${BASE}?user=other_user`],
  ['password query', `${BASE}?password=synthetic-rejected`],
  ['SSL query', `${BASE}?sslmode=require`],
  ['SSL certificate query', `${BASE}?sslcert=never-read.pem`],
  ['connection options query', `${BASE}?options=-c%20statement_timeout%3D0`],
  ['duplicate queries', `${BASE}?host=127.0.0.1&host=example.invalid`],
  ['encoded query name', `${BASE}?%68ost=example.invalid`],
  ['unexpected query', `${BASE}?unknown=1`],
  ['empty query', `${BASE}?`],
  ['fragment', `${BASE}#host=example.invalid`],
  ['empty fragment', `${BASE}#`],
  ['remote authority', BASE.replace('127.0.0.1', 'example.invalid')],
  ['unauthorized port', BASE.replace(':5433/', ':6543/')],
  ['missing port', BASE.replace(':5433/', '/')],
  ['noncanonical port', BASE.replace(':5433/', ':05433/')],
  ['unauthorized database', BASE.replace(DATABASE, 'other_database')],
  ['missing database', BASE.replace(DATABASE, '')],
  ['encoded database alias', BASE.replace(DATABASE, '%63ardetail1_square_settlement_7d')],
  ['socket protocol', 'socket:/tmp/postgresql?db=cardetail1_square_settlement_7d'],
  ['encoded socket authority', BASE.replace('127.0.0.1', '%2Ftmp%2Fpostgresql')],
  ['socket host query', `${BASE}?host=%2Ftmp%2Fpostgresql`],
  ['malformed URL', 'not-a-postgresql-url'],
  ['malformed escape', BASE.replace(`${USER}@`, `${USER}:synthetic%ZZ@`)],
  ['missing user', BASE.replace(`${USER}@`, '')],
  ['empty user', BASE.replace(`${USER}@`, '@')],
  ['password without user', BASE.replace(`${USER}@`, ':synthetic@')],
  ['explicit empty password', BASE.replace(`${USER}@`, `${USER}:@`)],
  ['invalid user identity', BASE.replace(USER, 'user%0Aname')],
  ['invalid password control', BASE.replace(`${USER}@`, `${USER}:synthetic%00@`)],
  ['alternative protocol', BASE.replace('postgresql:', 'https:')],
  ['multiple authorities', BASE.replace(`${USER}@`, `${USER}:synthetic@other@`)],
  ['ambiguous raw password delimiter', BASE.replace(`${USER}@`, `${USER}:synthetic:extra@`)],
  ['backslash', BASE.replace(`${USER}@`, `${USER}:synthetic\\value@`)],
  ['leading whitespace', ` ${BASE}`],
  ['embedded newline', BASE.replace(USER, `${USER}\n`)],
  ['URL object', new URL(BASE)],
  ['non-string', null],
];

for (const [name, input] of rejected) {
  test(`isolation rejects ${name} before client construction`, async () => {
    const h = instrument();
    const generic = (error) => {
      assert.equal(error.message, 'square_settlement_database_unproven');
      assert.equal(String(error.stack).includes('synthetic'), false);
      assert.equal(String(error.stack).includes(PASSWORD), false);
      return true;
    };
    assert.throws(() => h.database.assertLocalSettlementUrl(input), generic);
    await assert.rejects(h.database.connectProven(input), generic);
    assert.deepEqual(h.calls, { constructed: 0, connect: 0, query: 0, end: 0 });
    assert.equal(h.config(), undefined);
  });
}

async function assertCanonical(h, input, expected = {}) {
  const client = await h.database.connectProven(input);
  const config = h.config();
  const p = client.connectionParameters;
  assert.equal(Object.hasOwn(config, 'connectionString'), false);
  assert.equal(p.host, '127.0.0.1');
  assert.equal(p.port, expected.port || 5433);
  assert.equal(p.database, DATABASE);
  assert.equal(p.user, USER);
  assert.equal(p.isDomainSocket, false);
  assert.equal(p.ssl, false);
  assert.equal(p.sslnegotiation, 'postgres');
  assert.equal(p.client_encoding, 'UTF8');
  assert.equal(p.application_name, 'cardetail1-square-settlement');
  assert.equal(p.replication, 'false');
  assert.equal(p.options, '-c statement_timeout=8000');
  assert.equal(p.statement_timeout, 8000);
  assert.equal(config.connectionTimeoutMillis, 5000);
  assert.equal(p.connect_timeout, 5);
  assert.equal(typeof config.password, 'function');
  // Exercise pg's actual authentication resolution without opening a socket.
  await new Promise((resolve) => client._getPassword(resolve));
  assert.equal(client.password === (expected.password || ''), true);
  assert.equal(JSON.stringify(config).includes(PASSWORD), false);
  assert.equal(JSON.stringify(h.database.assertLocalSettlementUrl(input)).includes(PASSWORD), false);
  await client.end();
  assert.deepEqual(h.calls, { constructed: 1, connect: 1, query: 1, end: 1 });
}

test('canonical passwordless loopback configuration reaches the real driver unchanged', async () => {
  await assertCanonical(instrument(), BASE);
});

test('encoded authentication is decoded once and preserved without a connection string', async () => {
  const input = BASE.replace(`${USER}@`, `${USER}:${encodeURIComponent(PASSWORD)}@`);
  await assertCanonical(instrument(), input, { password: PASSWORD });
});

test('localhost is canonicalized to a loopback IP without DNS resolution', async () => {
  await assertCanonical(instrument(), BASE.replace('127.0.0.1', 'localhost'));
});

test('the CI port and postgres protocol retain explicit canonical identity', async () => {
  const input = BASE.replace('postgresql:', 'postgres:').replace(':5433/', ':5432/');
  await assertCanonical(instrument({ port: '5432' }), input, { port: 5432 });
});

test('conflicting PostgreSQL environment cannot redirect or reconfigure the client', async () => {
  const hostile = {
    PGHOST: 'example.invalid', PGHOSTADDR: '192.0.2.1', PGPORT: '6543',
    PGDATABASE: 'other_database', PGUSER: 'other_user', PGPASSWORD: 'synthetic-environment-password',
    PGPASSFILE: 'never-read.pgpass', PGSERVICE: 'never-read-service',
    PGSSLMODE: 'require', PGSSLNEGOTIATION: 'direct', PGCLIENT_ENCODING: 'SQL_ASCII',
    PGOPTIONS: '-c statement_timeout=0', PGREPLICATION: 'database',
    PGCONNECT_TIMEOUT: '999', PGAPPNAME: 'untrusted-environment',
  };
  const previous = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, hostile);
    await assertCanonical(instrument(), BASE);
    const input = BASE.replace(`${USER}@`, `${USER}:${encodeURIComponent(PASSWORD)}@`);
    await assertCanonical(instrument(), input, { password: PASSWORD });
    const h = instrument();
    await assert.rejects(h.database.connectProven(`${BASE}?host=127.0.0.1`), /square_settlement_database_unproven/);
    assert.deepEqual(h.calls, { constructed: 0, connect: 0, query: 0, end: 0 });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const [name, proof] of [
  ['database', { database: 'other_database' }],
  ['address', { address: '192.0.2.1' }],
  ['port', { port: '6543' }],
  ['user', { user: 'other_user' }],
]) {
  test(`post-connection proof rejects unexpected ${name} and closes the client`, async () => {
    const h = instrument(proof);
    await assert.rejects(h.database.connectProven(BASE), /square_settlement_database_unproven/);
    assert.deepEqual(h.calls, { constructed: 1, connect: 1, query: 1, end: 1 });
  });
}

for (const failure of ['connect', 'query']) {
  test(`a ${failure} failure closes the client`, async () => {
    const h = instrument({}, failure);
    await assert.rejects(h.database.connectProven(BASE), /offline_(connection|query)_failure/);
    assert.equal(h.calls.end, 1);
  });
}
