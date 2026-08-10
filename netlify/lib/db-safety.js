'use strict';

/**
 * Refuse to hand a test run a client pointed at the production database.
 *
 * 21 test files call require('dotenv/config'), and the repository's .env has
 * DIRECT_URL on db.prisma.io — production. Sixteen of them write: they create
 * bookings, quotes, payment attempts and ledger entries, then deleteMany them.
 * `npm test` in a checkout with that .env mutates production money tables.
 *
 * The guard only engages inside a test process, so nothing about production
 * runtime behaviour changes. Point the run at a staging database, or set
 * CD1_ALLOW_PRODUCTION_DB_IN_TESTS=i-understand-this-writes-to-production if a
 * read-only investigation genuinely needs the production host.
 */

const PRODUCTION_HOST_MARKERS = Object.freeze([
  'db.prisma.io',
  'accelerate.prisma-data.net',
]);

const OVERRIDE_ENV = 'CD1_ALLOW_PRODUCTION_DB_IN_TESTS';
const OVERRIDE_VALUE = 'i-understand-this-writes-to-production';

/** node --test sets NODE_TEST_CONTEXT in every test child process. */
function isTestProcess(env = process.env) {
  return !!env.NODE_TEST_CONTEXT || String(env.NODE_ENV || '').toLowerCase() === 'test';
}

function productionMarkerIn(url) {
  const value = String(url || '');
  if (!value) return null;
  return PRODUCTION_HOST_MARKERS.find((marker) => value.includes(marker)) || null;
}

/**
 * @returns {{ blocked: boolean, marker?: string, variable?: string, reason?: string }}
 */
function inspectDatabaseTarget(env = process.env) {
  if (!isTestProcess(env)) return { blocked: false, reason: 'not_a_test_process' };
  if (env[OVERRIDE_ENV] === OVERRIDE_VALUE) return { blocked: false, reason: 'explicit_override' };

  for (const variable of ['DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL']) {
    const marker = productionMarkerIn(env[variable]);
    if (marker) return { blocked: true, marker, variable };
  }
  return { blocked: false, reason: 'no_production_marker' };
}

/** Throws inside a test process aimed at production. Never prints the URL. */
function assertNotProductionDatabase(env = process.env) {
  const verdict = inspectDatabaseTarget(env);
  if (!verdict.blocked) return verdict;
  throw new Error(
    `Refusing to run tests against the production database: ${verdict.variable} points at ` +
    `${verdict.marker}. These suites create and delete bookings, quotes, payment attempts and ` +
    `ledger entries. Point the run at a staging database, or set ` +
    `${OVERRIDE_ENV}=${OVERRIDE_VALUE} if you accept writing to production.`
  );
}

module.exports = {
  PRODUCTION_HOST_MARKERS,
  OVERRIDE_ENV,
  OVERRIDE_VALUE,
  isTestProcess,
  productionMarkerIn,
  inspectDatabaseTarget,
  assertNotProductionDatabase,
};
