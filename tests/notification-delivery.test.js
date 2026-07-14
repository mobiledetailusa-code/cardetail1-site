'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  normalizeDeliveryResult,
  initNotificationDelivery,
  sendNotificationsDecoupled,
} = require('../netlify/lib/notification-delivery');

test('notification delivery tracks sent and failed independently', async () => {
  const delivery = await sendNotificationsDecoupled({ id: 'CD1-TEST' }, {
    adminEmail: async () => ({ sent: true }),
    customerEmail: async () => ({ sent: false, reason: 'invalid_email' }),
    adminSms: async () => ({ skipped: true, reason: 'not_configured' }),
  });
  assert.equal(delivery.adminEmail.status, 'sent');
  assert.equal(delivery.customerEmail.status, 'failed');
  assert.equal(delivery.adminSms.status, 'suppressed');
});

test('submit-booking persists notification delivery', () => {
  const src = read('netlify/functions/submit-booking.js');
  assert.match(src, /sendNotificationsDecoupled/);
  assert.match(src, /notificationDelivery/);
  assert.match(src, /attachDeliveryToBooking/);
});

test('invalid customer email does not block booking storage path', () => {
  const src = read('netlify/functions/submit-booking.js');
  assert.match(src, /booking_store_failed/);
  assert.doesNotMatch(src, /customerEmail\.sent.*return json\(500/);
});

test('initNotificationDelivery defaults to pending', () => {
  const d = initNotificationDelivery({});
  assert.equal(d.adminEmail.status, 'pending');
  assert.equal(d.customerEmail.status, 'pending');
});

test('normalizeDeliveryResult handles missing result', () => {
  const r = normalizeDeliveryResult(null, 'adminEmail');
  assert.equal(r.status, 'suppressed');
});
