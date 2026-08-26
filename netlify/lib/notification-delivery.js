// Notification delivery tracking — decoupled from booking persistence.
const DELIVERY_STATUSES = ['pending', 'accepted', 'sent', 'delivered', 'failed', 'suppressed'];

function normalizeDeliveryResult(result, channel) {
  const now = new Date().toISOString();
  if (!result) return { channel, status: 'suppressed', at: now, reason: 'not_configured' };
  if (result.accepted === true || result.queued === true) {
    return { channel, status: 'accepted', at: now, reason: null, outboxId: result.outboxId || null };
  }
  if (result.sent === true) return { channel, status: 'sent', at: now, reason: null };
  if (result.skipped) return { channel, status: 'suppressed', at: now, reason: result.reason || 'skipped' };
  return { channel, status: 'failed', at: now, reason: result.reason || 'send_failed' };
}

function initNotificationDelivery(booking) {
  const existing = booking.notificationDelivery && typeof booking.notificationDelivery === 'object'
    ? booking.notificationDelivery
    : {};
  return {
    adminEmail: existing.adminEmail || { status: 'pending', at: null, reason: null },
    customerEmail: existing.customerEmail || { status: 'pending', at: null, reason: null },
    adminSms: existing.adminSms || { status: 'pending', at: null, reason: null },
    customerSms: existing.customerSms || { status: 'pending', at: null, reason: null },
    updatedAt: existing.updatedAt || null,
  };
}

function applyDeliveryUpdate(delivery, channel, result) {
  const next = { ...delivery, updatedAt: new Date().toISOString() };
  const normalized = normalizeDeliveryResult(result, channel);
  next[channel] = normalized;
  return next;
}

function attachDeliveryToBooking(booking, delivery) {
  return { ...booking, notificationDelivery: delivery };
}

function deliveryChannelRetryable(channel) {
  const status = channel && channel.status;
  return !status || status === 'pending' || status === 'failed';
}

/**
 * True when booking-created admin/customer channels have not reached a terminal
 * decision. Failed remains retryable; suppressed (e.g. consent=false) does not.
 */
function bookingCreatedNotificationsIncomplete(booking) {
  const delivery = initNotificationDelivery(booking);
  const ledger = booking && booking.transactionalNotifications;
  const ledgerEmpty = !ledger || typeof ledger !== 'object' || !Object.keys(ledger).length;
  if (!delivery.updatedAt && ledgerEmpty) return true;
  return deliveryChannelRetryable(delivery.adminEmail)
    || deliveryChannelRetryable(delivery.adminSms)
    || deliveryChannelRetryable(delivery.customerEmail)
    || deliveryChannelRetryable(delivery.customerSms);
}

async function sendNotificationsDecoupled(booking, senders) {
  const delivery = initNotificationDelivery(booking);
  const tasks = [];

  function alreadySent(channel) {
    const cur = delivery[channel];
    return cur && (
      cur.status === 'accepted'
      || cur.status === 'sent'
      || cur.status === 'delivered'
      || cur.status === 'suppressed'
    );
  }

  if (senders.adminEmail && !alreadySent('adminEmail')) {
    tasks.push(senders.adminEmail(booking).then((r) => {
      Object.assign(delivery, applyDeliveryUpdate(delivery, 'adminEmail', r));
    }));
  }
  if (senders.customerEmail && !alreadySent('customerEmail')) {
    tasks.push(senders.customerEmail(booking).then((r) => {
      Object.assign(delivery, applyDeliveryUpdate(delivery, 'customerEmail', r));
    }));
  }
  if (senders.adminSms && !alreadySent('adminSms')) {
    tasks.push(senders.adminSms(booking).then((r) => {
      Object.assign(delivery, applyDeliveryUpdate(delivery, 'adminSms', r));
    }));
  }
  if (senders.customerSms && !alreadySent('customerSms')) {
    tasks.push(senders.customerSms(booking).then((r) => {
      Object.assign(delivery, applyDeliveryUpdate(delivery, 'customerSms', r));
    }));
  }

  await Promise.allSettled(tasks);
  delivery.updatedAt = new Date().toISOString();
  return delivery;
}

module.exports = {
  DELIVERY_STATUSES,
  normalizeDeliveryResult,
  initNotificationDelivery,
  applyDeliveryUpdate,
  attachDeliveryToBooking,
  sendNotificationsDecoupled,
  deliveryChannelRetryable,
  bookingCreatedNotificationsIncomplete,
};
