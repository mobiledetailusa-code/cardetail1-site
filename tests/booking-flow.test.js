const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('index.html');
const customer = read('customer.html');
const technician = read('technician.html');
const terms = read('terms-conditions.html');
const submit = read('netlify/functions/submit-booking.js');
const setup = read('netlify/functions/create-setup-intent.js');
const cardStatus = read('netlify/functions/booking-card-status.js');
const paymentLink = read('netlify/functions/create-payment-link.js');
const security = read('netlify/functions/_security.js');
const stripeConfig = read('netlify/functions/stripe-config.js');
const webhook = read('netlify/functions/stripe-webhook.js');
const lookup = read('netlify/functions/lookup-booking.js');

test('Step 5 has final copy and all payment preferences', () => {
  assert.match(index, /Secure Your Booking/);
  assert.match(index, /Choose how you prefer to pay, then save a card to secure your appointment request\. No charge today\./);
  assert.match(index, /Payment Preference/);
  assert.match(index, /Cash on-site/);
  assert.match(index, /Card on-site/);
  assert.match(index, /Online after service/);
  assert.match(index, /Card on File Required/);
  assert.match(index, /A card on file is still required to secure the booking\./);
});

test('Step 5 gates preference, consent, saved card, and final terms', () => {
  assert.match(index, /Please select a payment preference before continuing/);
  assert.match(index, /Please accept the card-on-file policy before continuing/);
  assert.match(index, /Please securely save a card with Stripe before continuing/);
  assert.match(index, /Please agree to the Terms & Conditions before submitting/);
});

test('card-on-file uses SetupIntent with off-session usage and bookingId metadata', () => {
  assert.match(setup, /\/v1\/setup_intents/);
  assert.match(setup, /usage:\s+'off_session'/);
  assert.match(setup, /metadata\[bookingId\]/);
  assert.doesNotMatch(setup, /\/v1\/payment_intents/);
  assert.doesNotMatch(setup, /capture_method/);
  assert.match(setup, /CONTEXT === 'deploy-preview'/);
  assert.match(setup, /DEPLOY_PRIME_URL/);
  assert.match(setup, /stripe_test_mode_required/);
  assert.match(index, /IS_DEPLOY_PREVIEW/);
  assert.match(index, /loadStripeConfig/);
  assert.match(index, /\/\.netlify\/functions\/stripe-config/);
  assert.doesNotMatch(index, /const\s+STRIPE_PUBLISHABLE_KEY\s*=\s*'pk_(?:test|live)_/);
  assert.match(stripeConfig, /STRIPE_PUBLISHABLE_KEY/);
  assert.match(stripeConfig, /stripe_test_mode_required/);
  assert.doesNotMatch(stripeConfig, /STRIPE_SECRET_KEY/);
});

test('server requires webhook-saved card and fixes booking statuses', () => {
  assert.match(submit, /existing\.cardOnFileStatus !== 'saved'/);
  assert.match(submit, /card_on_file_required/);
  assert.match(submit, /paymentStatus:\s+'no_payment_required_yet'/);
  assert.match(submit, /appointmentStatus:\s+'pending_review'/);
  assert.match(submit, /jobStatus:\s+'not_started'/);
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
  assert.match(technician, /Payment Preference/);
  assert.match(technician, /Card on File/);
  assert.match(technician, /Pending Review/);
  assert.match(technician, /Cancellation Request/);
  assert.match(customer, /Card on file saved/i);
  assert.match(customer, /No charge has been made today/i);
  assert.match(customer, /Payment Preference/);
  assert.match(customer, /Pending confirmation/);
  assert.match(customer, /Request Cancellation/);
  assert.match(lookup, /paymentMethodPreference/);
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

test('hardened endpoints require verification and admin-only sensitive actions', () => {
  assert.match(security, /function phonesMatchExact/);
  assert.match(security, /a === b/);
  assert.doesNotMatch(security, /slice\(-minLen\)|slice\(-n\)/);
  assert.match(setup, /phone_required/);
  assert.match(setup, /phonesMatchExact\(p\.phone, booking\.phone\)/);
  assert.match(cardStatus, /phone_required/);
  assert.match(cardStatus, /phonesMatchExact\(body\.phone, booking\.phone\)/);
  assert.match(paymentLink, /requireAdmin\(event\)/);
  assert.doesNotMatch(paymentLink, /queryStringParameters.*key/);
});

test('front-end escapes stored data and validates payment links', () => {
  assert.match(index, /function esc\(s\)/);
  assert.match(index, /function safePayLink/);
  assert.match(index, /safePayLink\(b\.payLink\)/);
  assert.doesNotMatch(index, /href="\$\{b\.payLink/);
  assert.doesNotMatch(index, /href="'\+b\.payLink/);
  assert.match(technician, /function esc\(s\)/);
  assert.match(customer, /function safeImgSrc/);
});

test('admin keys are not accepted through query strings', () => {
  const functions = fs.readdirSync(path.join(root, 'netlify/functions'))
    .filter(name => name.endsWith('.js'))
    .map(name => read(path.join('netlify/functions', name)).replace(/\n/g, ' '));
  for (const source of functions) {
    assert.doesNotMatch(source, /queryStringParameters\s*&&[^;]*\.key/);
    assert.doesNotMatch(source, /p\.adminKey/);
  }
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
  for (const [file, html] of [['index.html', index], ['customer.html', customer], ['technician.html', technician]]) {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0, `${file} should contain inline scripts`);
    scripts.forEach((match, i) => {
      assert.doesNotThrow(() => new Function(match[1]), `${file} inline script ${i + 1} should compile`);
    });
  }
});
