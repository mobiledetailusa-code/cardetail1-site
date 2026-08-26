'use strict';

const { PROGRAM_NAME } = require('./sms-program');

const BRAND = PROGRAM_NAME;
const TEMPLATE_VERSION = 'sms-v2-2026-08-23';
const COMPLIANCE = 'Reply STOP or HELP';

const TEMPLATE_KEYS = Object.freeze({
  // CUSTOMER_BOOKING_SMS_WITH_ACCESS — only when verified phone authorizes /a?t=
  REQUEST_RECEIVED: 'booking.request_received',
  CONFIRMED: 'booking.confirmed',
  ACTION_REQUIRED: 'booking.customer_action_required',
  CHANGE_REQUESTED: 'booking.change_requested',
  CANCELLATION_REQUESTED: 'booking.cancellation_requested',
  RESCHEDULED: 'booking.rescheduled',
  CANCELLED: 'booking.cancelled',
  // CUSTOMER_BOOKING_SMS_SAFE_CONFIRMATION — consent true, phone mismatch: no private link
  SAFE_CONFIRMATION: 'booking.safe_confirmation',
  TECH_AUCTION: 'auction.tech_invite',
  ADMIN_BOOKING: 'ops.booking_alert',
  ADMIN_INQUIRY: 'ops.inquiry_alert',
  ADMIN_CHANGE_REQUEST: 'ops.change_request_alert',
  ADMIN_CUSTOMER_CANCEL: 'ops.customer_cancel_alert',
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
    case TEMPLATE_KEYS.SAFE_CONFIRMATION:
      // No url/token — SMS consent alone must not deliver private account access.
      body = `${BRAND}: We received your booking request.`
        + ` We'll send service and appointment updates to this number.`;
      break;
    case TEMPLATE_KEYS.CONFIRMED:
      body = `${BRAND}: Your appointment is confirmed`
        + (data.date || data.when ? ` for ${text(data.date || data.when, 80)}` : '')
        + (data.window ? `, arrival window ${text(data.window, 40)}` : '')
        + '.'
        + (url ? ` ${url}` : '');
      break;
    case TEMPLATE_KEYS.CHANGE_REQUESTED:
      body = `${BRAND}: We received your appointment change request.`
        + ` Your current appointment remains unchanged until the new time is confirmed.`;
      break;
    case TEMPLATE_KEYS.CANCELLATION_REQUESTED:
      body = `${BRAND}: We received your cancellation request.`
        + ` Your appointment remains scheduled until it is confirmed canceled.`;
      break;
    case TEMPLATE_KEYS.RESCHEDULED:
      body = `${BRAND}: Your appointment has been rescheduled`
        + (data.date || data.when ? ` to ${text(data.date || data.when, 80)}` : '')
        + (data.window ? `, arrival window ${text(data.window, 40)}` : '')
        + '.';
      break;
    case TEMPLATE_KEYS.CANCELLED:
      body = `${BRAND}: Your appointment`
        + (data.date || data.when ? ` for ${text(data.date || data.when, 80)}` : '')
        + ` has been canceled.`;
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
    case TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST:
      body = `${BRAND}: Customer requested an appointment change`
        + (data.date ? ` for ${text(data.date, 40)}` : '')
        + (data.bookingRef ? ` (${text(data.bookingRef, 24)})` : '')
        + '.';
      break;
    case TEMPLATE_KEYS.ADMIN_CUSTOMER_CANCEL:
      body = `${BRAND}: Customer canceled appointment`
        + (data.bookingRef ? ` ${text(data.bookingRef, 24)}` : '')
        + (data.date ? ` for ${text(data.date, 40)}` : '')
        + (data.window ? `, ${text(data.window, 40)}` : '')
        + '.';
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

function scheduleFingerprint(booking = {}) {
  const date = String(booking.confirmedDate || booking.preferredDate || '').trim();
  const window = String(
    booking.confirmedTimeWindow
    || booking.confirmedWindow
    || booking.confirmedTime
    || booking.preferredTime
    || ''
  ).trim();
  return `${date}|${window}`;
}

function bookingTemplateData(eventType, booking = {}, accessUrl = '') {
  const date = booking.confirmedDate || booking.preferredDate || '';
  const window = booking.confirmedTimeWindow
    || booking.confirmedWindow
    || booking.confirmedTime
    || booking.preferredTime
    || '';
  const when = [date, window].filter(Boolean).join(' ');
  const fingerprint = scheduleFingerprint(booking);
  if (
    eventType === TEMPLATE_KEYS.CONFIRMED
    || eventType === TEMPLATE_KEYS.RESCHEDULED
    || eventType === TEMPLATE_KEYS.CANCELLED
    || eventType === TEMPLATE_KEYS.CHANGE_REQUESTED
    || eventType === TEMPLATE_KEYS.CANCELLATION_REQUESTED
  ) {
    return {
      date,
      window,
      when,
      scheduleFingerprint: fingerprint,
      previousDate: booking.previousConfirmedDate || booking.previousPreferredDate || '',
      url: accessUrl,
    };
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
  scheduleFingerprint,
};
