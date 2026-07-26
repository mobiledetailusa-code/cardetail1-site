'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  REQUIRED_OS_TABLES,
  probeOwnerStudioCatalogSchema,
} = require('../netlify/lib/owner-studio/catalog-schema-health');

describe('owner-studio catalog schema readiness', () => {
  it('requires OsCatalogDraft among Stage 2 tables', () => {
    assert.ok(REQUIRED_OS_TABLES.includes('OsCatalogDraft'));
    const migration = fs.readFileSync(
      path.join(__dirname, '..', 'prisma', 'migrations', '20260725180000_owner_studio_foundation', 'migration.sql'),
      'utf8'
    );
    assert.match(migration, /CREATE TABLE "OsCatalogDraft"/);
    const stage2 = fs.readFileSync(
      path.join(__dirname, '..', 'prisma', 'migrations', '20260726120000_owner_studio_catalog_draft_version', 'migration.sql'),
      'utf8'
    );
    assert.match(stage2, /ALTER TABLE "OsCatalogDraft" ADD COLUMN "version"/);
  });

  it('staging env writer forces DATABASE_URL onto staging direct identity', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'owner-studio-staging-netlify-env.js'),
      'utf8'
    );
    assert.match(src, /toSet\.DATABASE_URL = stagingDb/);
    assert.match(src, /mismatched/);
  });

  it('catalog API refuses memory fallback and requires schema readiness', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'netlify', 'functions', 'owner-studio-catalog.js'),
      'utf8'
    );
    assert.match(src, /postgresql_required/);
    assert.match(src, /assertCatalogSchemaReady/);
    assert.match(src, /persistence: 'postgresql'/);
    assert.doesNotMatch(src, /createMemoryCatalogRepository\(\)/);
  });

  it('probe reports not ready when prisma missing', async () => {
    const r = await probeOwnerStudioCatalogSchema(null);
    assert.equal(r.configured, false);
    assert.equal(r.ready, false);
    assert.equal(r.error, 'prisma_unavailable');
  });

  it('probe reports missing tables without exposing identifiers', async () => {
    const fake = {
      async $queryRawUnsafe() {
        return [{ tablename: 'OsSite' }];
      },
      osCatalogDraft: {
        async findFirst() {
          throw new Error('should_not_run');
        },
      },
    };
    const r = await probeOwnerStudioCatalogSchema(fake);
    assert.equal(r.requiredTablesPresent, false);
    assert.equal(r.ready, false);
    assert.equal(r.error, 'required_tables_missing');
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'tables'), false);
  });
});
