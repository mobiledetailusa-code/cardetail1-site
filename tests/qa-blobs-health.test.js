'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('qa-blobs-health is admin-gated and reports only safe booleans', () => {
  const src = read('netlify/functions/qa-blobs-health.js');
  assert.match(src, /verifyAdminKey/);
  assert.match(src, /configured/);
  assert.match(src, /authorized/);
  assert.match(src, /readable/);
  assert.match(src, /writable/);
  assert.match(src, /site_match/);
  assert.doesNotMatch(src, /NETLIFY_AUTH_TOKEN\}\s*,/);
  assert.doesNotMatch(src, /console\.log\([^)]*token/i);
  assert.match(src, /REDACTED/);
});

test('submit-booking draft blob persist failure returns controlled error', async () => {
  const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
  delete require.cache[SUBMIT_PATH];
  process.env.DRAFT_TOKEN_SECRET = process.env.DRAFT_TOKEN_SECRET || 'd'.repeat(32);
  process.env.CONTEXT = 'dev';
  const { handler, __test } = require('../netlify/functions/submit-booking');
  __test.setBlobsStoreOverride(() => ({
    async get() { return null; },
    async setJSON() {
      const err = new Error('Netlify Blobs has generated an internal error (401 status code)');
      err.name = 'BlobsInternalError';
      throw err;
    },
  }));
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.90' },
      body: JSON.stringify({
        isDraft: true,
        firstName: 'Blob',
        lastName: 'Fail',
        phone: '5513132956',
        email: 'blobfail@example.com',
        zipCode: '07650',
        address: '1 Test',
        paymentMethodPreference: 'card_onsite',
        acceptedCardOnFilePolicy: true,
        preferredDate: '2099-06-16',
        preferredTime: '10:00 AM',
        package: 'Premium Detail',
        packageId: 'full',
        vehicleCategory: 'cars',
        totalPrice: 285,
        vehicles: [{
          cat: 'cars',
          pkgId: 'full',
          pkgName: 'Premium Detail',
          tierLabel: 'Small Car',
          addons: [],
        }],
      }),
    });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'Failed to pre-register booking' });
  } finally {
    __test.setBlobsStoreOverride(null);
  }
});

test('submit-booking and appointment tokens share tech-security blobsStore', () => {
  const submit = read('netlify/functions/submit-booking.js');
  const access = read('netlify/lib/appointment-access-token.js');
  const txn = read('netlify/lib/booking-transactional-notifications.js');
  assert.match(submit, /sharedBlobsStore|tech-security/);
  assert.match(access, /blobsStore\(TOKEN_STORE\)/);
  assert.match(access, /require\('\.\/tech-security'\)/);
  assert.match(txn, /emitRequestReceived/);
});
