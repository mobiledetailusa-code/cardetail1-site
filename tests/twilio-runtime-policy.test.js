'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  webhookPolicy,
  productionRuntimeAllowed,
} = require('../netlify/lib/twilio-runtime-policy');
const { __setBakedDeployEnvForTests } = require('../netlify/lib/trusted-site-origin');

const WEBHOOK_SECRETS = {
  TWILIO_AUTH_TOKEN: 'test-auth-token-for-signatures',
  TWILIO_INBOUND_WEBHOOK_URL: 'https://cardetail1.com/.netlify/functions/twilio-inbound',
  TWILIO_STATUS_CALLBACK_URL: 'https://cardetail1.com/.netlify/functions/twilio-status-callback',
};

const IDENTITY_KEYS = ['CONTEXT', 'DEPLOY_CONTEXT', 'BRANCH', 'HEAD', 'URL', 'PUBLIC_SITE_URL'];
const priorIdentity = {};

test.before(() => {
  for (const key of IDENTITY_KEYS) {
    priorIdentity[key] = process.env[key];
    delete process.env[key];
  }
});

test.after(() => {
  for (const key of IDENTITY_KEYS) {
    if (priorIdentity[key] == null) delete process.env[key];
    else process.env[key] = priorIdentity[key];
  }
});

test.afterEach(() => {
  __setBakedDeployEnvForTests(null);
});

test('webhook policy fails closed when Functions lack CONTEXT and bake is empty', () => {
  const policy = webhookPolicy('inbound', { ...WEBHOOK_SECRETS });
  assert.equal(policy.ok, false);
  assert.equal(policy.reason, 'non_production_context');
});

test('webhook policy uses baked production identity when Functions omit CONTEXT/BRANCH', () => {
  __setBakedDeployEnvForTests({
    CONTEXT: 'production',
    BRANCH: 'master',
    URL: 'https://cardetail1.com',
  });
  const policy = webhookPolicy('inbound', { ...WEBHOOK_SECRETS });
  assert.equal(policy.ok, true);
  assert.equal(policy.url, WEBHOOK_SECRETS.TWILIO_INBOUND_WEBHOOK_URL);
});

test('live deploy-preview CONTEXT still wins over a production bake', () => {
  __setBakedDeployEnvForTests({
    CONTEXT: 'production',
    BRANCH: 'master',
    URL: 'https://cardetail1.com',
  });
  const allowed = productionRuntimeAllowed({
    CONTEXT: 'deploy-preview',
    BRANCH: 'cursor/twilio-netlify-activate-2dfc',
    URL: 'https://cardetail1.com',
  });
  assert.equal(allowed.ok, false);
  assert.equal(allowed.reason, 'non_production_context');
});
