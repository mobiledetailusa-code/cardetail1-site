'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  trustedSiteOrigin,
  deployEnvironmentKey,
  FALLBACK_ORIGIN,
} = require('../netlify/lib/trusted-site-origin');

const ENV_KEYS = [
  'CONTEXT',
  'PUBLIC_SITE_URL',
  'TRUSTED_PUBLIC_SITE_ORIGIN',
  'URL',
  'SITE_URL',
  'DEPLOY_URL',
  'DEPLOY_PRIME_URL',
  'BRANCH',
  'DEPLOY_ID',
  'REVIEW_ID',
];

function snapEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function clearOriginEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

test('production email origin uses cardetail1.com', () => {
  const snap = snapEnv();
  try {
    clearOriginEnv();
    process.env.CONTEXT = 'production';
    process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
    process.env.DEPLOY_URL = 'https://appointment-access-final--cardetail1.netlify.app';
    assert.equal(trustedSiteOrigin(), 'https://cardetail1.com');
    assert.equal(deployEnvironmentKey(), 'production');
  } finally {
    restoreEnv(snap);
  }
});

test('branch-deploy email uses DEPLOY_URL, not production URL/SITE_URL', () => {
  const snap = snapEnv();
  try {
    clearOriginEnv();
    process.env.CONTEXT = 'branch-deploy';
    process.env.BRANCH = 'appointment-access-final';
    process.env.URL = 'https://cardetail1.com';
    process.env.SITE_URL = 'https://cardetail1.com';
    process.env.DEPLOY_URL = 'https://appointment-access-final--cardetail1.netlify.app';
    process.env.DEPLOY_PRIME_URL = 'https://appointment-access-final--cardetail1.netlify.app';
    assert.equal(
      trustedSiteOrigin(),
      'https://appointment-access-final--cardetail1.netlify.app'
    );
    assert.equal(deployEnvironmentKey(), 'branch-deploy:appointment-access-final');
  } finally {
    restoreEnv(snap);
  }
});

test('URL or SITE_URL pointing to production does not override DEPLOY_URL in branch-deploy', () => {
  const snap = snapEnv();
  try {
    clearOriginEnv();
    process.env.CONTEXT = 'branch-deploy';
    process.env.BRANCH = 'feat/x';
    process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
    process.env.URL = 'https://cardetail1.com';
    process.env.SITE_URL = 'https://cardetail1.com';
    process.env.DEPLOY_URL = 'https://feat-x--cardetail1.netlify.app';
    assert.equal(trustedSiteOrigin(), 'https://feat-x--cardetail1.netlify.app');
  } finally {
    restoreEnv(snap);
  }
});

test('deploy-preview email uses deploy-preview origin', () => {
  const snap = snapEnv();
  try {
    clearOriginEnv();
    process.env.CONTEXT = 'deploy-preview';
    process.env.REVIEW_ID = '136';
    process.env.URL = 'https://cardetail1.com';
    process.env.DEPLOY_URL = 'https://deploy-preview-136--cardetail1.netlify.app';
    process.env.DEPLOY_PRIME_URL = 'https://deploy-preview-136--cardetail1.netlify.app';
    assert.equal(
      trustedSiteOrigin(),
      'https://deploy-preview-136--cardetail1.netlify.app'
    );
    assert.equal(deployEnvironmentKey(), 'deploy-preview:136');
  } finally {
    restoreEnv(snap);
  }
});

test('branch-deploy accepts explicit non-production PUBLIC_SITE_URL', () => {
  const snap = snapEnv();
  try {
    clearOriginEnv();
    process.env.CONTEXT = 'branch-deploy';
    process.env.PUBLIC_SITE_URL = 'https://appointment-access-final--cardetail1.netlify.app/extra';
    process.env.DEPLOY_URL = 'https://ignored--cardetail1.netlify.app';
    assert.equal(
      trustedSiteOrigin(),
      'https://appointment-access-final--cardetail1.netlify.app'
    );
  } finally {
    restoreEnv(snap);
  }
});

test('spoofed Host is irrelevant — origin ignores request headers', () => {
  const snap = snapEnv();
  try {
    clearOriginEnv();
    process.env.CONTEXT = 'production';
    process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
    // trustedSiteOrigin takes no event/host input by design
    assert.equal(trustedSiteOrigin(), 'https://cardetail1.com');
    assert.equal(FALLBACK_ORIGIN, 'https://cardetail1.com');
  } finally {
    restoreEnv(snap);
  }
});

test('strips path query fragment and userinfo from candidates', () => {
  const snap = snapEnv();
  try {
    clearOriginEnv();
    process.env.CONTEXT = 'production';
    process.env.PUBLIC_SITE_URL = 'https://user:pass@cardetail1.com/path?q=1#frag';
    // userinfo rejected
    process.env.URL = 'https://cardetail1.com/path?q=1#frag';
    assert.equal(trustedSiteOrigin(), 'https://cardetail1.com');
  } finally {
    restoreEnv(snap);
  }
});
