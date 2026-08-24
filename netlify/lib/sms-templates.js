'use strict';

const { PROGRAM_NAME } = require('./sms-program');

const BRAND = PROGRAM_NAME;
const TEMPLATE_VERSION = 'sms-v2-2026-08-23';
const COMPLIANCE = 'Reply STOP or HELP';

const TEMPLATE_KEYS = Object.freeze({
  REQUEST_RECEIVED: 'booking.request_received',
  CONFIRMED: 'booking.confirmed',
  ACTION_REQUIRED: 'booking.customer_action_required',
  TECH_AUCTION: 'auction.tech_invite',
  ADMIN_BOOKING: 'ops.booking_alert',
  ADMIN_INQUIRY: 'ops.inquiry_alert',
  RECOVERY: 'recovery.followup',
});

function text(value, max = 180) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function withCompliance(message) {
  const body = text(message, 520);
  return `${body} ${COMPLIANCE}`.trim().slice(0, 600);
}

function renderSmsTemplate(templateKey, data = {}) {
  const url = text(data.url, 240);
  let body = '';
  switch (templateKey) {
    case TEMPLATE_KEYS.REQUEST_RECEIVED:
      body = `${BRAND}: Booking request received.`
        + (url ? ` ${url}` : '');
      break;
    case TEMPLATE_KEYS.CONFIRMED:
      body = `${BRAND}: Appointment confirmed${data.when ? ` ${text(data.when, 80)}` : ''}.`
        + (url ? ` ${url}` : '');
      break;
    case TEMPLATE_KEYS.ACTION_REQUIRED:
      body = `${BRAND}: Action needed on your appointment.`
        + (url ? ` ${url}` : '');
      break;
    case TEMPLATE_KEYS.TECH_AUCTION:
      body = `${BRAND}: Job ${text(data.service, 100)} - ${text(data.date, 40)} - ${text(data.area, 40)}.`
        + (url ? ` Bid: ${url}` : '');
      break;
    case TEMPLATE_KEYS.ADMIN_BOOKING:
      body = `${BRAND}: Booking alert ${text(data.bookingRef, 50)} - ${text(data.customerName, 80)}`
        + (data.customerPhone ? ` - ${text(data.customerPhone, 30)}` : '');
      break;
    case TEMPLATE_KEYS.ADMIN_INQUIRY:
      body = `${BRAND}: Customer question from ${text(data.customerName, 80)}`
        + (data.customerPhone ? ` (${text(data.customerPhone, 30)})` : '')
        + (data.message ? `: ${text(data.message, 220)}` : '');
      break;
    case TEMPLATE_KEYS.RECOVERY:
      body = `${BRAND}: ${text(data.message, 360)}` + (url ? ` ${url}` : '');
      break;
    default:
      return { ok: false, error: 'unknown_sms_template' };
  }
  return {
    ok: true,
    body: withCompliance(body),
    templateKey,
    templateVersion: TEMPLATE_VERSION,
  };
}

function bookingTemplateData(eventType, booking = {}, accessUrl = '') {
  if (eventType === TEMPLATE_KEYS.CONFIRMED) {
    const when = [
      booking.confirmedDate || booking.preferredDate,
      booking.confirmedTime || booking.preferredTime || booking.confirmedTimeWindow,
    ].filter(Boolean).join(' ');
    return { when, url: accessUrl };
  }
  return { url: accessUrl };
}

module.exports = {
  BRAND,
  TEMPLATE_VERSION,
  COMPLIANCE,
  TEMPLATE_KEYS,
  renderSmsTemplate,
  bookingTemplateData,
};
