'use strict';

/**
 * Local Square Sandbox smoke test. Not part of CI and not a Netlify function.
 *
 *   SQUARE_SANDBOX_ACCESS_TOKEN=... node scripts/square-sandbox-smoke-test.js --confirm-square-sandbox
 *
 * Prints environment, payment id, status, amount, and idempotency result.
 * Does not print the access token or card data. Does not create a booking.
 */

const crypto = require('crypto');
const { createSquareSandboxProvider, LOCAL_CONFIRMATION } = require('../netlify/lib/square-sandbox-provider');

const BLOCKED_CREDENTIALS = 'BLOCKED — SANDBOX CREDENTIALS NOT CONFIGURED';

function blockedRuntime(env) {
  const context = String(env.CONTEXT || env.NETLIFY_CONTEXT || '').trim().toLowerCase();
  if (context === 'production' || context === 'deploy-preview' || context === 'branch-deploy') return true;
  if (String(env.NETLIFY || '').trim().toLowerCase() === 'true') return true;
  if (env.AWS_LAMBDA_FUNCTION_NAME || env.LAMBDA_TASK_ROOT) return true;
  return false;
}

function printSummary(lines) {
  for (const line of lines) console.log(line);
}

async function main() {
  const env = process.env;
  if (env.CI === 'true') {
    printSummary(['BLOCKED — CI MUST NOT CALL SQUARE SANDBOX']);
    return 2;
  }
  if (blockedRuntime(env)) {
    printSummary(['BLOCKED — SANDBOX CLIENT REFUSED THIS RUNTIME']);
    return 2;
  }
  if (!process.argv.includes('--confirm-square-sandbox')) {
    printSummary(['BLOCKED — CONFIRMATION REQUIRED']);
    return 2;
  }
  if (typeof env.SQUARE_SANDBOX_ACCESS_TOKEN !== 'string' || env.SQUARE_SANDBOX_ACCESS_TOKEN.trim() === '') {
    printSummary([BLOCKED_CREDENTIALS]);
    return 2;
  }

  const provider = createSquareSandboxProvider({
    env,
    confirmation: LOCAL_CONFIRMATION,
  });
  const idempotencyKey = crypto.randomUUID();
  const request = {
    amountCents: 100,
    currency: 'USD',
    sourceId: 'cnon:card-nonce-ok',
    idempotencyKey,
  };
  const created = await provider.createPayment(request);
  if (!created.completed) {
    printSummary([
      'environment: sandbox',
      `status: ${created.status || created.error || 'not_completed'}`,
      'amountCents: 100',
      'currency: USD',
      'idempotency: not_run',
    ]);
    return 1;
  }
  const fetched = await provider.getPayment({ paymentId: created.paymentId });
  const retried = await provider.createPayment(request);
  const samePayment = Boolean(
    created.paymentId
    && fetched.paymentId === created.paymentId
    && retried.paymentId === created.paymentId
    && fetched.completed
    && retried.completed
    && fetched.amountCents === 100
    && retried.amountCents === 100
  );
  printSummary([
    'environment: sandbox',
    `paymentId: ${created.paymentId}`,
    `status: ${fetched.status || created.status}`,
    'amountCents: 100',
    'currency: USD',
    `idempotency: ${samePayment ? 'same_payment' : 'mismatch'}`,
  ]);
  return samePayment ? 0 : 1;
}

main().then((code) => {
  process.exit(code);
}).catch(() => {
  console.log('environment: sandbox');
  console.log('status: square_sandbox_unknown');
  console.log('idempotency: not_run');
  process.exit(1);
});
