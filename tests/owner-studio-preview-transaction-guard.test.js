'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  checkPreviewTransactionRequest,
} = require('../netlify/lib/owner-studio/preview-transaction-guard');
const submitBooking = require('../netlify/functions/submit-booking');
const createSetupIntent = require('../netlify/functions/create-setup-intent');

const ROOT = path.join(__dirname, '..');
const PREVIEW_HEADER = { 'X-Owner-Studio-Preview': '1' };

function trustedOptions(overrides = {}) {
  return {
    verifyAdminRequest: async () => ({ ok: true, username: 'owner' }),
    isMutationOriginAllowed: (origin) => origin === 'https://preview.example.test',
    authorizeOwnerStudio: () => ({ ok: true }),
    ...overrides,
  };
}

test('normal customer and Admin requests without the header remain normal', async () => {
  let verifyCalls = 0;
  const options = trustedOptions({
    verifyAdminRequest: async () => {
      verifyCalls += 1;
      return { ok: true, username: 'owner' };
    },
  });
  assert.deepEqual(await checkPreviewTransactionRequest({ headers: {} }, options), { previewRequest: false });
  assert.deepEqual(await checkPreviewTransactionRequest({ headers: { cookie: 'admin_session=opaque' } }, options), { previewRequest: false });
  assert.equal(verifyCalls, 0);
});

test('header alone without an Admin session does not activate trusted preview mode', async () => {
  const result = await checkPreviewTransactionRequest(
    { headers: { ...PREVIEW_HEADER, origin: 'https://preview.example.test' } },
    trustedOptions({ verifyAdminRequest: async () => ({ ok: false, error: 'unauthorized' }) })
  );
  assert.deepEqual(result, { previewRequest: false });
});

test('Admin verification failure is normalized without exposing account details', async () => {
  const result = await checkPreviewTransactionRequest(
    { headers: { ...PREVIEW_HEADER, origin: 'https://preview.example.test' } },
    trustedOptions({ verifyAdminRequest: async () => { throw new Error('sensitive backend detail'); } })
  );
  assert.deepEqual(result, { previewRequest: true, authorized: false, error: 'preview_auth_unavailable' });
});

test('body and query preview fields never activate preview mode', async () => {
  const options = trustedOptions();
  assert.deepEqual(await checkPreviewTransactionRequest({ headers: {}, body: '{"os_preview":true}' }, options), { previewRequest: false });
  assert.deepEqual(await checkPreviewTransactionRequest({ headers: {}, queryStringParameters: { os_preview: '1' } }, options), { previewRequest: false });
});

test('valid Admin session, exact Origin, authorization, and header identify trusted preview', async () => {
  const result = await checkPreviewTransactionRequest({
    headers: { ...PREVIEW_HEADER, origin: 'https://preview.example.test', cookie: 'admin_session=opaque' },
  }, trustedOptions());
  assert.deepEqual(result, { previewRequest: true, authorized: true });
});

test('untrusted or missing Origin rejects a cookie-authenticated preview request', async () => {
  const untrusted = await checkPreviewTransactionRequest({
    headers: { ...PREVIEW_HEADER, origin: 'https://evil.example' },
  }, trustedOptions());
  assert.deepEqual(untrusted, { previewRequest: true, authorized: false, error: 'untrusted_origin' });

  const missing = await checkPreviewTransactionRequest({ headers: PREVIEW_HEADER }, trustedOptions());
  assert.deepEqual(missing, { previewRequest: true, authorized: false, error: 'untrusted_origin' });
});

test('submit-booking rejects authorized preview before parsing or persistence', async (t) => {
  let storeCalls = 0;
  submitBooking.__test.setPreviewTransactionGuardOverride(async () => ({ previewRequest: true, authorized: true }));
  submitBooking.__test.setBlobsStoreOverride(async () => {
    storeCalls += 1;
    throw new Error('must_not_open_store');
  });
  t.after(() => {
    submitBooking.__test.setPreviewTransactionGuardOverride(null);
    submitBooking.__test.setBlobsStoreOverride(null);
  });

  const response = await submitBooking.handler({ httpMethod: 'POST', headers: PREVIEW_HEADER, body: '{invalid' });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: 'preview_transactions_disabled',
    message: 'Preview mode does not allow bookings or payments.',
  });
  assert.equal(storeCalls, 0);
});

test('create-setup-intent rejects authorized preview before Blob or Stripe calls', async (t) => {
  let storeCalls = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('must_not_call_stripe');
  };
  createSetupIntent.__test.setPreviewTransactionGuardOverride(async () => ({ previewRequest: true, authorized: true }));
  createSetupIntent.__test.setBlobsStoreOverride(async () => {
    storeCalls += 1;
    throw new Error('must_not_open_store');
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    createSetupIntent.__test.setPreviewTransactionGuardOverride(null);
    createSetupIntent.__test.setBlobsStoreOverride(null);
  });

  const response = await createSetupIntent.handler({ httpMethod: 'POST', headers: PREVIEW_HEADER, body: '{invalid' });
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).error, 'preview_transactions_disabled');
  assert.equal(storeCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('normal requests retain their pre-existing invalid-JSON behavior', async (t) => {
  const originalDraftSecret = process.env.DRAFT_TOKEN_SECRET;
  process.env.DRAFT_TOKEN_SECRET = 'preview-guard-test-secret-that-is-at-least-32-characters';
  submitBooking.__test.setPreviewTransactionGuardOverride(async () => ({ previewRequest: false }));
  createSetupIntent.__test.setPreviewTransactionGuardOverride(async () => ({ previewRequest: false }));
  t.after(() => {
    if (originalDraftSecret === undefined) delete process.env.DRAFT_TOKEN_SECRET;
    else process.env.DRAFT_TOKEN_SECRET = originalDraftSecret;
    submitBooking.__test.setPreviewTransactionGuardOverride(null);
    createSetupIntent.__test.setPreviewTransactionGuardOverride(null);
  });
  const submit = await submitBooking.handler({ httpMethod: 'POST', headers: {}, body: '{invalid' });
  const setup = await createSetupIntent.handler({ httpMethod: 'POST', headers: {}, body: '{invalid' });
  assert.equal(submit.statusCode, 400);
  assert.equal(JSON.parse(submit.body).error, 'Invalid JSON');
  assert.equal(setup.statusCode, 400);
  assert.equal(JSON.parse(setup.body).error, 'invalid_json');
});

test('client keeps early guards and conditionally emits the preview header', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /if\(OS_PREVIEW_ACTIVE\)\{ alert\('Preview mode — bookings and payments are disabled\.'\); return; \}/);
  assert.match(html, /if\(OS_PREVIEW_ACTIVE\) headers\['X-Owner-Studio-Preview'\]='1'/);
  assert.equal((html.match(/headers:bookingRequestHeaders\(\)/g) || []).length, 3);

  const match = html.match(/function bookingRequestHeaders\(\)\{([\s\S]*?)\n\}/);
  assert.ok(match);
  const build = new Function('OS_PREVIEW_ACTIVE', `${match[0]}; return bookingRequestHeaders();`);
  assert.deepEqual(build(false), { 'Content-Type': 'application/json' });
  assert.deepEqual(build(true), { 'Content-Type': 'application/json', 'X-Owner-Studio-Preview': '1' });
});
