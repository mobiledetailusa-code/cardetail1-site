const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('index.html');
const myGarage = read('my-garage.html');
const myGarageJs = read('assets/my-garage.js');
const technician = read('technician.html');
const terms = read('terms-conditions.html');
const submit = read('netlify/functions/submit-booking.js');
const setup = read('netlify/functions/create-setup-intent.js');
const stripeConfig = read('netlify/functions/stripe-config.js');
const webhook = read('netlify/functions/stripe-webhook.js');
const lookup = read('netlify/functions/lookup-booking.js');

test('Step 5 has final copy and all payment preferences', () => {
  assert.match(index, /Secure Your Booking/);
  assert.match(index, /No charge today\. Your card is securely saved by Stripe and may only be charged according to our cancellation, no-show, access, or approved service payment policy\./);
  assert.match(index, /Payment Preference/);
  assert.match(index, /Cash on-site/);
  assert.match(index, /Card on-site/);
  assert.match(index, /Online after service/);
  assert.match(index, /Card on File Required/);
  assert.match(index, /A card on file is still required to secure the booking\./);
});

test('card-save policy notice has an opaque high-contrast treatment on every booking page', () => {
  const pages = fs.readdirSync(root)
    .filter(file => file.endsWith('.html'))
    .filter(file => read(file).includes('Before saving your card, please note:'));
  const noticeCss = read('assets/booking-summary.css');

  assert.equal(pages.length, 13, 'expected the notice on all 13 booking pages');
  for (const page of pages) {
    const html = read(page);
    assert.match(html, /class="card-save-notice"/);
    assert.match(html, /class="card-save-notice-copy"/);
    assert.match(html, /class="card-save-notice-title"/);
    assert.doesNotMatch(html, /background:rgba\(255,255,255,\.04\)/,
      `${page} still has the transparent policy notice`);
  }
  assert.match(noticeCss, /\.card-save-notice\s*\{[\s\S]*background:\s*#f8fafc/);
  assert.match(noticeCss, /\.card-save-notice-copy\s*\{[\s\S]*color:\s*#1e293b/);
  assert.match(noticeCss, /\.card-save-notice-title\s*\{[\s\S]*color:\s*#0f172a/);
  assert.match(noticeCss, /\.card-save-notice ::selection\s*\{[\s\S]*background:\s*#bfdbfe/);
});

test('Step 5 gates preference, consent, saved card, and final terms', () => {
  assert.match(index, /Please select a payment preference before continuing/);
  assert.match(index, /Please accept the card-on-file policy before continuing/);
  assert.match(index, /Please securely save a card with Stripe before continuing/);
  assert.match(index, /Please agree to the Terms & Conditions before submitting/);
});

test('card-on-file uses SetupIntent with off-session usage and bookingId metadata', () => {
  const stripeMode = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'lib', 'stripe-mode.js'), 'utf8');
  assert.match(setup, /\/v1\/setup_intents/);
  assert.match(setup, /usage:\s+'off_session'/);
  assert.match(setup, /metadata\[bookingId\]/);
  assert.match(setup, /verifyDraftSaveToken/);
  assert.match(setup, /invalid_draft_token/);
  assert.doesNotMatch(setup, /\/v1\/payment_intents/);
  assert.doesNotMatch(setup, /capture_method/);
  // Release A: local/preview live-key guard is centralized in stripe-mode.js
  assert.match(setup, /guardStripeOrReject/);
  assert.match(setup, /stripe-mode/);
  assert.match(stripeMode, /deploy-preview/);
  assert.match(stripeMode, /NETLIFY_DEV/);
  assert.match(stripeMode, /stripe_test_mode_required/);
  assert.match(index, /IS_DEPLOY_PREVIEW/);
  assert.match(index, /isLocalPreview/);
  assert.match(index, /LOCAL_DEV_FUNCTIONS_HINT/);
  assert.match(index, /loadStripeConfig/);
  assert.match(index, /BACKEND_BASE\+'\/stripe-config'/);
  assert.doesNotMatch(index, /const\s+STRIPE_PUBLISHABLE_KEY\s*=\s*'pk_(?:test|live)_/);
  assert.match(stripeConfig, /STRIPE_PUBLISHABLE_KEY/);
  assert.match(stripeConfig, /stripe_test_mode_required/);
  assert.match(stripeConfig, /NETLIFY_DEV/);
  assert.doesNotMatch(stripeConfig, /STRIPE_SECRET_KEY/);
});

test('server requires webhook-saved card and fixes booking statuses', () => {
  assert.match(submit, /existing\.cardOnFileStatus !== 'saved'/);
  assert.match(submit, /card_on_file_required/);
  assert.match(submit, /skipMismatchCheck:\s*true/);
  assert.match(submit, /isDraftRequest/);
  assert.match(submit, /draftSaveToken/);
  assert.match(submit, /getDraftTokenSecretStatus/);
  assert.match(submit, /paymentStatus:\s+'no_payment_required_yet'/);
  assert.match(submit, /appointmentStatus:\s+'pending_review'/);
  assert.match(submit, /jobStatus:\s+'pending_review'/);
  assert.match(submit, /cardOnFileRequired:\s+true/);
  assert.match(submit, /online_after_service/);
});

test('trusted webhook writes only card-on-file fields for SetupIntent success', () => {
  const succeeded = webhook.slice(
    webhook.indexOf("case 'setup_intent.succeeded'"),
    webhook.indexOf("case 'setup_intent.setup_failed'")
  );
  assert.match(succeeded, /cardOnFileStatus:\s+'saved'/);
  assert.match(succeeded, /setupIntentId:\s+si\.id/);
  assert.match(succeeded, /stripeCustomerId/);
  assert.match(succeeded, /stripePaymentMethodId/);
  assert.match(succeeded, /cardOnFileSavedAt/);
  assert.doesNotMatch(succeeded, /paymentStatus:/);
  assert.doesNotMatch(succeeded, /appointmentStatus:/);
  assert.doesNotMatch(succeeded, /triggerAuction/);
});

test('client-controlled protected fields are stripped', () => {
  for (const field of [
    'cardOnFileStatus', 'setupIntentId', 'stripeCustomerId',
    'stripePaymentMethodId', 'cardOnFileSavedAt', 'paymentStatus',
    'paymentIntentId', 'amountAuthorizedCents', 'amountCapturedCents',
    'appointmentStatus',
  ]) assert.match(submit, new RegExp(`['"]${field}['"]`));
});

test('admin and customer surfaces show required state without Stripe IDs', () => {
  assert.match(technician, /technicianConfirmation/);
  assert.match(technician, /Pending Admin Review/);
  assert.match(technician, /complete-modal/);
  assert.match(technician, /tech-complete-job/);
  assert.match(myGarage, /My Detailing Portal/);
  assert.match(myGarageJs, /submit-customer-action/);
  assert.match(myGarageJs, /request-cancellation|submitAction/);
  assert.match(read('netlify/lib/ops-schema.js'), /paymentMethodPreference/);
  assert.doesNotMatch(lookup, /setupIntentId:\s*b\./);
  assert.doesNotMatch(lookup, /stripeCustomerId:\s*b\./);
});

test('cancellation is manual and does not charge or delete', () => {
  const cancellation = read('netlify/functions/request-cancellation.js');
  assert.match(cancellation, /cancellationRequestStatus:\s+'requested'/);
  assert.match(cancellation, /No charge has been applied/);
  assert.doesNotMatch(cancellation, /payment_intents/);
  assert.doesNotMatch(cancellation, /\.delete\(/);
});

test('terms state universal card requirement and manual review', () => {
  assert.match(terms, /card on file is required for every booking request/i);
  assert.match(terms, /does not guarantee an appointment/i);
  assert.match(terms, /No charge is made when your card is saved/i);
  assert.match(terms, /handled securely by Stripe/i);
  assert.match(terms, /less than 24 hours/i);
  assert.match(terms, /No cancellation, no-show, or access fee is charged automatically/i);
});

test('temporary webhook setup and secret-transfer function is absent', () => {
  assert.equal(fs.existsSync(path.join(root, 'netlify/functions/stripe-webhook-setup.js')), false);
  const names = fs.readdirSync(path.join(root, 'netlify/functions'));
  assert.equal(names.some(name => /webhook.*setup|secret.*transfer/i.test(name)), false);
});

test('temporary qa-webhook-admin function is absent (not for Production)', () => {
  assert.equal(fs.existsSync(path.join(root, 'netlify/functions/qa-webhook-admin.js')), false);
});

test('missing and invalid webhook signatures are rejected', async () => {
  const old = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = 'test-signing-secret';
  delete require.cache[require.resolve('../netlify/functions/stripe-webhook.js')];
  const { handler } = require('../netlify/functions/stripe-webhook.js');
  const missing = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.equal(missing.statusCode, 400);
  const invalid = await handler({
    httpMethod: 'POST',
    headers: { 'stripe-signature': `t=${Math.floor(Date.now()/1000)},v1=bad` },
    body: '{}',
  });
  assert.equal(invalid.statusCode, 400);
  if (old === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = old;
});

test('inline browser scripts compile', () => {
  const jsScripts = html => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/type\s*=\s*["']application\/ld\+json["']/i.test(m[0]));
  for (const [file, html] of [['index.html', index], ['my-garage.html', myGarage], ['technician.html', technician]]) {
    const scripts = jsScripts(html);
    assert.ok(scripts.length > 0, `${file} should contain inline scripts`);
    scripts.forEach((match, i) => {
      assert.doesNotThrow(() => new Function(match[1]), `${file} inline script ${i + 1} should compile`);
    });
  }
});

test('card-on-file uses optimistic client flag with background server verify', () => {
  const confirmBlock = index.slice(
    index.indexOf('async function confirmSetupIntent'),
    index.indexOf('async function recheckCardStatus')
  );
  assert.match(confirmBlock, /ST\.cardOnFileSaved\s*=\s*true/);
  assert.match(index, /waitForVerifiedCardSave/);
  assert.match(index, /cardInitInProgress/);
  assert.match(index, /destroyStripePaymentUI/);
});

test('booking categories and vehicle card use premium photo visuals', () => {
  assert.match(index, /assets\/vehicles\/premium\/cars-suvs\.webp/);
  assert.match(index, /svc-ico-photo/);
  assert.match(index, /function setVehicleVisual/);
  assert.match(index, /const CATEGORY_VISUALS/);
});
