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

test('Step 5 offers Pay online later and requires a card only for that option', () => {
  assert.match(index, /Step 05 — Review &amp; Submit/);
  assert.match(index, /No payment is collected when you submit this booking request\./);
  assert.match(index, /Choose Pay online later to save a card securely \(nothing charged today\)\./);
  assert.doesNotMatch(index, /bk-pay-rec-badge/);
  assert.doesNotMatch(index, /recommended payment method|Pay online later \(recommended\)|Recommended: Pay online/i);
  assert.match(index, /Request first · No charge today/);
  assert.doesNotMatch(index, /Request first · Pay online · No charge today/);
  assert.doesNotMatch(index, /Preferred payment<\/span><span class="ov" id="c-pay-method"/);
  assert.match(index, /id="bk-online-card-wrap"[^>]*hidden/);
  assert.match(index, /id="cof-policy-ok"/);
  assert.match(index, /id="stripe-auth-btn"/);
  assert.doesNotMatch(index, />Secure Your Booking</i);
  assert.doesNotMatch(index, /A card on file is still required to submit the booking request\./i);
});

test('Pay online later card panel stays readable in the light booking modal', () => {
  const light = read('assets/booking-modal-light.css');
  const review = read('assets/booking-review.css');
  assert.match(review, /\.bk-cof-policy-box\s*\{/);
  assert.match(review, /\.bk-online-card-body\s*\{/);
  assert.match(light, /\.booking-modal \.bk-online-rec-msg[\s\S]*?color:\s*var\(--ink,\s*#0f172a\)\s*!important/s);
  assert.match(light, /\.booking-modal \.bk-cof-policy-copy strong[\s\S]*?color:\s*var\(--ink,\s*#0f172a\)\s*!important/s);
  assert.match(light, /\.booking-modal \.bk-cof-policy-box\s*\{[^}]*background:\s*#ffffff/s);
  // Scope to the card-save panel only — later success copy still uses theme tokens.
  const start = index.indexOf('id="bk-online-card-wrap"');
  const end = index.indexOf('id="stripe-status"', start);
  assert.ok(start > -1 && end > start, 'online card wrap block missing');
  const block = index.slice(start, end);
  assert.doesNotMatch(block, /color:var\(--white\)/);
  assert.doesNotMatch(block, /rgba\(255,255,255,\.04\)/);
  assert.match(block, /class="bk-cof-policy-box"/);
  assert.match(block, /class="bk-online-card-body"/);
});

test('booking steps use site theme atmosphere (hero photo too dark for readable step bg)', () => {
  const light = read('assets/booking-modal-light.css');
  assert.match(light, /Homepage hero photo is too dark for in-step backgrounds/);
  assert.match(light, /rgba\(196,\s*165,\s*116/);
  assert.match(light, /\.booking-modal\s*\{[\s\S]*?radial-gradient\(ellipse 90% 55% at 100%/);
  assert.match(light, /\.booking-modal \.bprog\s*\{[\s\S]*?rgba\(196,\s*165,\s*116/);
  assert.doesNotMatch(light, /\.booking-modal[\s\S]{0,400}url\(['\"]?[^'\"]*homepage-hero/);
  assert.doesNotMatch(light, /\.bcontent[\s\S]{0,200}url\(['\"]?[^'\"]*homepage-hero/);
});

test('initial booking pages keep card-save UI gated behind Pay online later', () => {
  const pages = fs.readdirSync(root)
    .filter(file => file.endsWith('.html'))
    .filter(file => read(file).includes('id="bk-ov"'));

  assert.equal(pages.length, 13, 'expected all 13 booking surfaces');
  for (const page of pages) {
    const html = read(page);
    assert.match(html, /id="bk-online-card-wrap"/, `${page} missing online card wrap`);
    assert.match(html, /id="cof-policy-ok"/, `${page} missing card consent`);
    assert.match(html, /id="stripe-auth-btn"/, `${page} missing card save CTA`);
    assert.match(html, /Before saving your card, please note:/, `${page} missing card-save notice`);
  }
});

test('initial submission gates final terms but not payment or saved card', () => {
  const continueBlock = index.slice(index.indexOf('function goToConfirmFromTerms'), index.indexOf('function bkScrollToConfirm'));
  const submitBlock = index.slice(index.indexOf('async function submitBooking'), index.indexOf('function readSiteAccessFields'));
  assert.doesNotMatch(continueBlock, /payMethod|cardOnFileSaved|cof-policy-ok/);
  assert.doesNotMatch(submitBlock, /confirmSetupIntent|create-setup-intent|cardOnFileSaved|cof-policy-ok/);
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

test('server keeps strict saved-card flow and permits explicit no-card drafts', () => {
  assert.match(submit, /existing\.cardOnFileStatus !== 'saved'/);
  assert.match(submit, /card_on_file_required/);
  assert.match(submit, /skipMismatchCheck:\s*true/);
  assert.match(submit, /isDraftRequest/);
  assert.match(submit, /draftSaveToken/);
  assert.match(submit, /getDraftTokenSecretStatus/);
  assert.match(submit, /paymentStatus:\s+'no_payment_required_yet'/);
  assert.match(submit, /appointmentStatus:\s+'pending_review'/);
  assert.match(submit, /jobStatus:\s+'pending_review'/);
  assert.match(submit, /resolveCardOnFileRequired/);
  assert.match(submit, /cardOnFileStatus:\s*'not_collected'/);
  assert.match(submit, /paymentWorkflowStatus:\s*'no_payment_required_yet'/);
  assert.match(submit, /online_after_service/);
});

test('trusted webhook writes only card-on-file fields for SetupIntent success', () => {
  const succeeded = webhook.slice(
    webhook.indexOf("case 'setup_intent.succeeded'"),
    webhook.indexOf("case 'setup_intent.setup_failed'")
  );
  assert.match(succeeded, /updateSetupIntentState\(evt,\s*si,\s*'saved'\)/);
  const updater = webhook.slice(
    webhook.indexOf('async function updateSetupIntentState'),
    webhook.indexOf('function signBid')
  );
  assert.match(updater, /cardOnFileStatus:\s*'saved'/);
  assert.match(updater, /setupIntentId:\s+setupIntent\.id/);
  assert.match(updater, /stripeCustomerId/);
  assert.match(updater, /stripePaymentMethodId/);
  assert.match(updater, /cardOnFileSavedAt/);
  assert.match(updater, /expectedBookingVersion/);
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

test('terms state no-card initial request, optional saved cards, and manual review', () => {
  assert.match(terms, /No card or payment method is required to submit an initial booking request/i);
  assert.match(terms, /does not guarantee an appointment/i);
  assert.match(terms, /Optional saved-card authorization/i);
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
