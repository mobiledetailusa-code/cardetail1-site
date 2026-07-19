/**
 * Deploy Preview DB health endpoint — must never leak connection details and
 * must fail clearly (reachable:false) rather than fail-open (reachable:true
 * without a real query succeeding).
 */
require('dotenv/config');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function noLeak(bodyText) {
  assert.doesNotMatch(bodyText, /db\.prisma\.io|accelerate\.prisma-data\.net|postgres:\/\/|api_key=/i);
}

describe('db-health function', () => {
  const prevUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (prevUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
    const { _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
    delete require.cache[require.resolve('../netlify/functions/db-health')];
  });

  beforeEach(() => {
    delete require.cache[require.resolve('../netlify/functions/db-health')];
  });

  it('OPTIONS returns 204 preflight', async () => {
    const { handler } = require('../netlify/functions/db-health');
    const res = await handler({ httpMethod: 'OPTIONS' });
    assert.equal(res.statusCode, 204);
  });

  it('POST is rejected with 405', async () => {
    const { handler } = require('../netlify/functions/db-health');
    const res = await handler({ httpMethod: 'POST' });
    assert.equal(res.statusCode, 405);
  });

  it('reports configured:false, reachable:false when DATABASE_URL is unset — never crashes, never fails open', async () => {
    process.env.DATABASE_URL = '';
    const { _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
    const { handler } = require('../netlify/functions/db-health');
    const res = await handler({ httpMethod: 'GET' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { configured: false, reachable: false });
    noLeak(res.body);
  });

  it('reports configured:true, reachable:false when the URL cannot be reached — fails clearly, no leaked error text', async () => {
    process.env.DATABASE_URL = 'postgres://baduser:badpass@nonexistent-host-xyz.invalid:5432/postgres';
    const { _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
    const { handler } = require('../netlify/functions/db-health');
    const res = await handler({ httpMethod: 'GET' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.configured, true);
    assert.equal(body.reachable, false);
    noLeak(res.body);
  });

  it(
    'reports configured:true, reachable:true against the real configured database — proves an actual query ran',
    { skip: !(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()) && 'DATABASE_URL not configured' },
    async () => {
      const { _resetPrismaForTests } = require('../netlify/lib/prisma');
      _resetPrismaForTests();
      const { handler } = require('../netlify/functions/db-health');
      const res = await handler({ httpMethod: 'GET' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body, { configured: true, reachable: true });
      noLeak(res.body);
    }
  );
});
