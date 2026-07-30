'use strict';

/**
 * Owner Studio branch-deploy authorization — mutation-origin policy, cookie vs
 * x-admin-key differentiation, and the capability contract.
 *
 * Pure unit tests (no DB, no DOM): the exact-origin allowlist lives in
 * netlify/lib/trusted-site-origin.js and the request policy + capabilities are
 * exported from netlify/functions/owner-studio-catalog.js via `_test`.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tso = require('../netlify/lib/trusted-site-origin');
const catalog = require('../netlify/functions/owner-studio-catalog');

const ALIAS = 'https://release-owner-studio-catalog--cardetail1-staging.netlify.app';
const MAIN_STAGING = 'https://cardetail1-staging.netlify.app';
const DEPLOY_URL = 'https://64abc123--cardetail1-staging.netlify.app';
const PROD = 'https://cardetail1.com';

const SAVED = {};
const ENV_KEYS = ['TRUSTED_PUBLIC_SITE_ORIGIN', 'PUBLIC_SITE_URL', 'URL', 'CONTEXT', 'BRANCH', 'DEPLOY_URL', 'DEPLOY_PRIME_URL'];

function clearLiveDeployEnv() {
  for (const k of ['CONTEXT', 'BRANCH', 'URL', 'DEPLOY_URL', 'DEPLOY_PRIME_URL']) delete process.env[k];
}
function setStagingBranchEnv() {
  clearLiveDeployEnv();
  process.env.TRUSTED_PUBLIC_SITE_ORIGIN = MAIN_STAGING; // pinned main-staging origin
  delete process.env.PUBLIC_SITE_URL;
  // On this site Functions read a build-time snapshot; branch alias = DEPLOY_PRIME_URL.
  tso.__setBakedDeployEnvForTests({
    CONTEXT: 'branch-deploy',
    BRANCH: 'release/owner-studio-catalog',
    DEPLOY_PRIME_URL: ALIAS,
    DEPLOY_URL,
    URL: PROD,
  });
}
function setProductionEnv() {
  clearLiveDeployEnv();
  process.env.TRUSTED_PUBLIC_SITE_ORIGIN = PROD;
  process.env.PUBLIC_SITE_URL = PROD;
  tso.__setBakedDeployEnvForTests({
    CONTEXT: 'production',
    BRANCH: 'master',
    DEPLOY_PRIME_URL: PROD,
    DEPLOY_URL: 'https://64prod9--cardetail1.netlify.app',
    URL: PROD,
  });
}

const ev = (origin, adminKey) => {
  const headers = {};
  if (origin) headers.origin = origin;
  if (adminKey) headers['x-admin-key'] = adminKey;
  return { headers };
};

beforeEach(() => { for (const k of ENV_KEYS) SAVED[k] = process.env[k]; });
afterEach(() => {
  tso.__setBakedDeployEnvForTests(null);
  for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
});

describe('mutation-origin allowlist — exact-origin only', () => {
  it('1. main-staging exact Origin is accepted', () => {
    setStagingBranchEnv();
    assert.equal(tso.isMutationOriginAllowed(MAIN_STAGING), true);
  });
  it('2. current DEPLOY_PRIME_URL (branch alias) exact Origin is accepted', () => {
    setStagingBranchEnv();
    assert.equal(tso.isMutationOriginAllowed(ALIAS), true);
  });
  it('3. current DEPLOY_URL exact Origin is accepted', () => {
    setStagingBranchEnv();
    assert.equal(tso.isMutationOriginAllowed(DEPLOY_URL), true);
  });
  it('4. an unrelated Netlify alias is rejected', () => {
    setStagingBranchEnv();
    assert.equal(tso.isMutationOriginAllowed('https://evil-branch--cardetail1-staging.netlify.app'), false);
  });
  it('5. a malicious suffix host is rejected', () => {
    setStagingBranchEnv();
    assert.equal(tso.isMutationOriginAllowed('https://cardetail1-staging.netlify.app.attacker.example'), false);
  });
  it('6. partial / wildcard / wrong-scheme netlify hosts are not accepted', () => {
    setStagingBranchEnv();
    assert.equal(tso.isMutationOriginAllowed('https://x.cardetail1-staging.netlify.app'), false);
    assert.equal(tso.isMutationOriginAllowed('https://cardetail1-staging.netlify.app.evil'), false);
    assert.equal(tso.isMutationOriginAllowed('http://cardetail1-staging.netlify.app'), false);
    assert.equal(tso.isMutationOriginAllowed('*'), false);
    assert.equal(tso.isMutationOriginAllowed('https://*.netlify.app'), false);
  });
  it('10. production accepts cardetail1.com and rejects staging/branch aliases', () => {
    setProductionEnv();
    assert.equal(tso.isMutationOriginAllowed(PROD), true);
    assert.equal(tso.isMutationOriginAllowed(ALIAS), false);
    assert.equal(tso.isMutationOriginAllowed(MAIN_STAGING), false);
  });
});

describe('mutation Origin enforcement — cookie vs x-admin-key', () => {
  it('7. cookie-auth mutation with NO Origin is REJECTED (origin_required)', () => {
    setStagingBranchEnv();
    assert.throws(
      () => catalog._test.assertTrustedOrigin(ev(null), /* authViaHeader */ false),
      (e) => e.code === 'origin_required' && e.statusCode === 403
    );
  });
  it('8. explicit x-admin-key automation with NO Origin remains ALLOWED', () => {
    setStagingBranchEnv();
    assert.doesNotThrow(() => catalog._test.assertTrustedOrigin(ev(null), /* authViaHeader */ true));
  });
  it('a trusted browser Origin passes; an untrusted one throws untrusted_origin', () => {
    setStagingBranchEnv();
    assert.doesNotThrow(() => catalog._test.assertTrustedOrigin(ev(ALIAS), false));
    assert.throws(
      () => catalog._test.assertTrustedOrigin(ev('https://evil--cardetail1-staging.netlify.app'), false),
      (e) => e.code === 'untrusted_origin' && e.statusCode === 403
    );
  });
  it('automation cannot use a present-but-untrusted Origin to mutate', () => {
    setStagingBranchEnv();
    assert.throws(
      () => catalog._test.assertTrustedOrigin(ev('https://evil.example'), true),
      (e) => e.code === 'untrusted_origin'
    );
  });
});

describe('capability contract reflects read/write state', () => {
  it('11. trusted browser context → canSave true, policy exact-origin', () => {
    setStagingBranchEnv();
    const mo = catalog._test.evaluateMutationOrigin(ev(ALIAS));
    assert.equal(mo.allowed, true);
    assert.equal(mo.policy, 'exact-origin');
    assert.deepEqual(catalog._test.buildCapabilities(mo.allowed), {
      canRead: true, canEdit: true, canSave: true, canResolveConflicts: true, canRestoreRevision: true,
    });
  });
  it('12. untrusted browser context → canSave false (read remains true)', () => {
    setStagingBranchEnv();
    const mo = catalog._test.evaluateMutationOrigin(ev('https://evil--cardetail1-staging.netlify.app'));
    assert.equal(mo.allowed, false);
    const caps = catalog._test.buildCapabilities(mo.allowed);
    assert.equal(caps.canRead, true);
    assert.equal(caps.canEdit, false);
    assert.equal(caps.canSave, false);
    assert.equal(caps.canResolveConflicts, false);
    assert.equal(caps.canRestoreRevision, false);
  });
  it('same-origin GET (no Origin) falls back to this deploy self-origin → allowed on the alias', () => {
    setStagingBranchEnv();
    assert.equal(catalog._test.evaluateMutationOrigin(ev(null)).allowed, true);
  });
});

describe('CSRF + Owner Studio authorization are not weakened', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'owner-studio-catalog.js'), 'utf8');
  it('9. the mutation path still enforces origin, CSRF and edit authorization', () => {
    assert.match(src, /authorizeOwnerStudio\(identity, 'edit_draft'\)/);
    assert.match(src, /assertTrustedOrigin\(event, authViaHeader\)/);
    assert.match(src, /requireCsrf\(event, session\)/);
    // A cookie-authenticated mutation with no Origin must NOT fall through unchecked.
    assert.match(src, /if \(authViaHeader\) return;[\s\S]{0,160}origin_required/);
  });
});
