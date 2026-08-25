'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyGmailRole,
  emailContractSnapshot,
  envPresence,
  qaHarnessAllowed,
  buildSyntheticAdminEmail,
  prepareControlledOwnerSms,
  maskEmail,
  LEGACY_GMAIL,
} = require('../netlify/lib/notification-qa');

test('legacy gmail role classification distinguishes sender vs recipient', () => {
  assert.equal(
    classifyGmailRole({ adminEmail: LEGACY_GMAIL, resendFrom: 'Cardetail1 <bookings@cardetail1.com>' }).role,
    'recipient'
  );
  assert.equal(
    classifyGmailRole({
      adminEmail: 'ops@cardetail1.com',
      resendFrom: `Cardetail1 <${LEGACY_GMAIL}>`,
    }).role,
    'sender_only'
  );
  assert.equal(
    classifyGmailRole({
      adminEmail: LEGACY_GMAIL,
      resendFrom: `Cardetail1 <${LEGACY_GMAIL}>`,
    }).role,
    'both'
  );
});

test('email contract snapshot never invents canonical admin address', () => {
  const snap = emailContractSnapshot({
    ADMIN_EMAIL: 'ops@example.com',
    RESEND_FROM: 'Cardetail1 <bookings@example.com>',
  });
  assert.equal(snap.ADMIN_RECIPIENT, 'ops@example.com');
  assert.equal(snap.ADMIN_FROM_ADDRESS, 'bookings@example.com');
  assert.match(snap.notes.join(' '), /cardtel1/);
});

test('qa harness is fail-closed without NOTIFICATION_QA_ENABLED', () => {
  assert.equal(qaHarnessAllowed({}).ok, false);
  assert.equal(qaHarnessAllowed({ NOTIFICATION_QA_ENABLED: 'true' }).ok, true);
});

test('synthetic admin email only targets ADMIN_EMAIL', () => {
  const built = buildSyntheticAdminEmail({
    env: {
      ADMIN_EMAIL: 'owner@example.com',
      RESEND_API_KEY: 're_test',
      RESEND_FROM: 'Cardetail1 <from@example.com>',
    },
    correlationId: 'QA-1',
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.payload.to, ['owner@example.com']);
  assert.match(built.payload.text, /No customer booking was created or changed/);
  assert.equal(built.meta.toMasked, maskEmail('owner@example.com'));
});

test('controlled owner SMS prepare does not claim send', () => {
  const prepared = prepareControlledOwnerSms({
    env: { ADMIN_SMS: '+15515550123' },
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.sent, false);
  assert.equal(prepared.destinationMasked, '***0123');
  assert.match(prepared.note, /READY FOR CONTROLLED OWNER SMS TEST/);
});

test('env presence reports boolean gates without leaking secrets', () => {
  const snap = envPresence({
    TWILIO_ENABLED: 'false',
    TWILIO_OUTBOX_ENABLED: 'true',
    TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_API_SECRET: 'secret-value-should-not-appear',
  });
  assert.equal(snap.booleans.TWILIO_ENABLED, false);
  assert.equal(snap.booleans.TWILIO_OUTBOX_ENABLED, true);
  assert.equal(snap.provider.TWILIO_ACCOUNT_SID, true);
  assert.equal(snap.provider.TWILIO_API_SECRET, true);
  assert.equal(JSON.stringify(snap).includes('secret-value'), false);
});

test('qa notification function is admin-gated and mode-limited', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../netlify/functions/qa-notification-pipeline.js'),
    'utf8'
  );
  assert.match(src, /verifyAdminKey/);
  assert.match(src, /NOTIFICATION_QA_ENABLED|notification_qa_disabled/);
  assert.match(src, /email_send/);
  assert.match(src, /sms_prepare/);
  assert.doesNotMatch(src, /to:\s*\[body\./);
  assert.doesNotMatch(src, /createBooking|submit-booking|PaymentIntent/);
});

test('submit-booking implements both admin and customer SMS paths separately', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../netlify/functions/submit-booking.js'),
    'utf8'
  );
  assert.match(src, /adminSms/);
  assert.match(src, /audience:\s*'admin'/);
  assert.match(src, /ADMIN_SMS_CONSENT_GRANTED/);
  assert.match(src, /emitRequestReceived/);
});
