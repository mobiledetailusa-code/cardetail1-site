'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('financial migration preserves every historical StripeEvent payload', () => {
  const migration = read('prisma/migrations/20260805090000_financial_invariants_pr1/migration.sql');
  assert.doesNotMatch(migration, /UPDATE\s+"StripeEvent"/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+"StripeEvent"/i);
  assert.match(migration, /Historical StripeEvent payloads are deliberately preserved/);
  assert.match(read('netlify/lib/db/stripe-event-data.js'), /sanitizeStripeEventPayload/);
});

test('database preflight is read-only and emits aggregate evidence only', () => {
  const preflight = read('scripts/financial-preflight.mjs');
  assert.match(preflight, /BEGIN READ ONLY/);
  assert.match(preflight, /ROLLBACK/);
  assert.doesNotMatch(preflight, /prisma migrate deploy|UPDATE\s+"StripeEvent"|DELETE\s+FROM\s+"StripeEvent"/i);
  assert.doesNotMatch(preflight, /SELECT\s+"payload"\s+FROM/i);
});

test('@cursor/sdk is development-only and fast-uri is pinned to a patched line', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.dependencies['@cursor/sdk'], undefined);
  assert.equal(pkg.devDependencies['@cursor/sdk'], '^1.0.22');
  assert.equal(pkg.overrides['fast-uri'], '^3.1.5');
  assert.equal(lock.packages['node_modules/@cursor/sdk'].dev, true);
  assert.ok(
    Number(lock.packages['node_modules/fast-uri'].version.split('.')[2]) >= 5,
    `unexpected fast-uri ${lock.packages['node_modules/fast-uri'].version}`
  );
});
