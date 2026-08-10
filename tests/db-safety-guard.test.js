'use strict';

/**
 * The repository .env has DIRECT_URL on db.prisma.io — production. 21 test files
 * load it via dotenv/config and 16 of them create and delete bookings, quotes,
 * payment attempts and ledger entries. Before this guard, `npm test` in such a
 * checkout wrote to the production money tables.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  OVERRIDE_ENV,
  OVERRIDE_VALUE,
  isTestProcess,
  productionMarkerIn,
  inspectDatabaseTarget,
  assertNotProductionDatabase,
} = require('../netlify/lib/db-safety');

const PROD_ACCELERATE = 'prisma+postgres://accelerate.prisma-data.net/?api_key=redacted';
const PROD_DIRECT = 'postgres://user:pw@db.prisma.io:5432/postgres?sslmode=require';
const STAGING = 'postgres://user:pw@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require';

/** A test process, per node --test. */
const testEnv = (over = {}) => ({ NODE_TEST_CONTEXT: 'child-v8', ...over });

describe('production database guard', () => {
  it('recognises the test process node --test creates', () => {
    assert.equal(isTestProcess({ NODE_TEST_CONTEXT: 'child-v8' }), true);
    assert.equal(isTestProcess({ NODE_ENV: 'test' }), true);
    assert.equal(isTestProcess({}), false);
  });

  it('spots both production hosts', () => {
    assert.equal(productionMarkerIn(PROD_DIRECT), 'db.prisma.io');
    assert.equal(productionMarkerIn(PROD_ACCELERATE), 'accelerate.prisma-data.net');
    assert.equal(productionMarkerIn(STAGING), null);
    assert.equal(productionMarkerIn(''), null);
    assert.equal(productionMarkerIn(undefined), null);
  });

  it('blocks a test run pointed at production, whichever variable carries it', () => {
    for (const variable of ['DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL']) {
      const verdict = inspectDatabaseTarget(testEnv({ [variable]: PROD_DIRECT }));
      assert.equal(verdict.blocked, true, `${variable} must be checked`);
      assert.equal(verdict.variable, variable);
    }
  });

  it('lets a staging database through', () => {
    const verdict = inspectDatabaseTarget(testEnv({ DATABASE_URL: STAGING, DIRECT_URL: STAGING }));
    assert.equal(verdict.blocked, false);
  });

  it('does not interfere outside a test process', () => {
    // Production runtime must be untouched by this guard.
    const verdict = inspectDatabaseTarget({ DATABASE_URL: PROD_ACCELERATE, DIRECT_URL: PROD_DIRECT });
    assert.equal(verdict.blocked, false);
    assert.equal(verdict.reason, 'not_a_test_process');
  });

  it('honours an explicit, self-describing override', () => {
    const env = testEnv({ DIRECT_URL: PROD_DIRECT, [OVERRIDE_ENV]: OVERRIDE_VALUE });
    assert.equal(inspectDatabaseTarget(env).blocked, false);
    // A truthy-but-wrong value must not open the door.
    const sloppy = testEnv({ DIRECT_URL: PROD_DIRECT, [OVERRIDE_ENV]: '1' });
    assert.equal(inspectDatabaseTarget(sloppy).blocked, true);
  });

  it('explains itself without printing the connection string', () => {
    const env = testEnv({ DIRECT_URL: PROD_DIRECT });
    assert.throws(
      () => assertNotProductionDatabase(env),
      (err) => {
        assert.match(err.message, /Refusing to run tests against the production database/);
        assert.match(err.message, /DIRECT_URL/);
        assert.match(err.message, /db\.prisma\.io/);
        assert.doesNotMatch(err.message, /user:pw/, 'credentials must never be echoed');
        return true;
      }
    );
  });

  it('is wired into the Prisma client factory', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'netlify/lib/prisma.js'), 'utf8');
    assert.match(src, /require\('\.\/db-safety'\)\.assertNotProductionDatabase\(\)/);
  });
});
