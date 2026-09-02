'use strict';

const {
  CUSTOMER_SMS_BRAND,
  ADMIN_SMS_BRAND,
} = require('./sms-program');

// Customer-facing SMS sender identity is the registered DBA (Cardetail1).
// Legal EIN-backed A2P Brand remains Detailing Zone L.L.C. in sms-program.js.
// Admin operational alerts use a distinct prefix so they are not confused
// with customer traffic.
const BRAND = CUSTOMER_SMS_BRAND;
const TEMPLATE_VERSION = 'sms-v5-2026-09-02';
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
  PAYMENT_RECEIVED: 'booking.payment_received',
  DETAILS_UPDATED: 'booking.details_updated',
  // CUSTOMER_BOOKING_SMS_SAFE_CONFIRMATION — consent true, phone mismatch: no private link
  SAFE_CONFIRMATION: 'booking.safe_confirmation',
  TECH_AUCTION: 'auction.tech_invite',
  ADMIN_BOOKING: 'ops.booking_alert',
  ADMIN_INQUIRY: 'ops.inquiry_alert',
  ADMIN_INBOUND_SMS: 'ops.inbound_sms_alert',
  ADMIN_CHANGE_REQUEST: 'ops.change_request_alert',
  ADMIN_CUSTOMER_CANCEL: 'ops.customer_cancel_alert',
  RECOVERY: 'recovery.followup',
});

const ADMIN_TEMPLATE_KEYS = new Set([
  TEMPLATE_KEYS.ADMIN_BOOKING,
  TEMPLATE_KEYS.ADMIN_INQUIRY,
  TEMPLATE_KEYS.ADMIN_INBOUND_SMS,
  TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST,
  TEMPLATE_KEYS.ADMIN_CUSTOMER_CANCEL,
]);

function smsBrandForTemplate(templateKey) {
  return ADMIN_TEMPLATE_KEYS.has(templateKey) ? ADMIN_SMS_BRAND : CUSTOMER_SMS_BRAND;
}

function smsPrefix(templateKey) {
  return `${smsBrandForTemplate(templateKey)}:`;
}

const MONTHS = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

// GSM-7 default alphabet (3GPP TS 23.038). Extended chars cost two septets.
const GSM7_BASIC = new Set([
  '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r',
  'Å', 'å', 'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ',
  ' ', 'Æ', 'æ', 'ß', 'É',
  '!', '"', '#', '¤', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  ':', ';', '<', '=', '>', '?', '¡',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'Ä', 'Ö', 'Ñ', 'Ü', '§', '¿',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'ä', 'ö', 'ñ', 'ü', 'à',
]);
const GSM7_EXTENDED = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

function asciiSms(value) {
  return String(value == null ? '' : value)
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\t\n\r\x20-\x7e]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function gsmSeptetLength(body) {
  let n = 0;
  for (const ch of String(body || '')) {
    if (GSM7_EXTENDED.has(ch)) n += 2;
    else if (GSM7_BASIC.has(ch)) n += 1;
    else return null;
  }
  return n;
}

function measureSms(body) {
  const textBody = String(body || '');
  const septets = gsmSeptetLength(textBody);
  if (septets != null) {
    return {
      encoding: 'GSM-7',
      characterCount: [...textBody].length,
      septetCount: septets,
      segmentCount: septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }
  const utf16Units = Buffer.from(textBody, 'utf16le').length / 2;
  return {
    encoding: 'UCS-2',
    characterCount: utf16Units,
    septetCount: null,
    segmentCount: utf16Units <= 70 ? 1 : Math.ceil(utf16Units / 67),
  };
}

function smsDateLabel(raw) {
  const s = asciiSms(raw);
  if (!s) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const month = MONTHS[Number(iso[2]) - 1];
    const day = Number(iso[3]);
    if (month && day >= 1 && day <= 31) return `${month} ${day}, ${iso[1]}`;
  }
  return s.slice(0, 40);
}

function smsWindowLabel(raw) {
  const s = asciiSms(raw);
  if (!s) return '';
  if (/^anytime$/i.test(s) || /^any time that day$/i.test(s)) return 'Any time that day';
  try {
    const { arrivalWindowLabel, normalizeArrivalWindow } = require('./arrival-windows');
    const normalized = normalizeArrivalWindow(s);
    if (normalized) return asciiSms(arrivalWindowLabel(normalized));
  } catch (_) { /* keep SMS render isolated from catalog load failures */ }
  return s.slice(0, 40);
}

function looksLikeInternalId(value) {
  const s = String(value || '').trim();
  if (!s) return true;
  if (/^(pkg_|addon_|cd1-|aptr_|aat_|pi_|cus_)/i.test(s)) return true;
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(s) && !/\s/.test(s)) return true;
  return false;
}

function smsServiceLabel(bookingOrRaw) {
  if (bookingOrRaw == null) return '';
  if (typeof bookingOrRaw !== 'object') {
    const direct = asciiSms(bookingOrRaw);
    return looksLikeInternalId(direct) ? '' : direct.slice(0, 40);
  }
  const vehicles = Array.isArray(bookingOrRaw.vehicles) ? bookingOrRaw.vehicles : [];
  const first = vehicles[0] && typeof vehicles[0] === 'object' ? vehicles[0] : {};
  const candidates = [
    bookingOrRaw.package,
    bookingOrRaw.packageName,
    bookingOrRaw.serviceLabel,
    bookingOrRaw.service,
    first.packageName,
    first.pkgName,
    first.package,
    bookingOrRaw.serviceName,
  ];
  for (const candidate of candidates) {
    const s = asciiSms(candidate);
    if (!s || looksLikeInternalId(s)) continue;
    return s.slice(0, 40);
  }
  return '';
}

function viewLink(url) {
  return url ? ` View: ${url}` : '';
}

function serviceClause(data, url) {
  if (url) return '';
  const service = asciiSms(data.service).slice(0, 40);
  return service ? ` ${service}.` : '';
}

function requestSummary(data, { includeService = true } = {}) {
  const date = smsDateLabel(data.date || data.when);
  const service = includeService ? asciiSms(data.service).slice(0, 40) : '';
  const window = smsWindowLabel(data.window || data.arrivalPreference);
  let body = `${smsPrefix(TEMPLATE_KEYS.REQUEST_RECEIVED)} Booking request received`;
  if (date && service) body += ` for ${date} - ${service}`;
  else if (date) body += ` for ${date}`;
  else if (service) body += ` for ${service}`;
  body += '.';
  if (window) body += ` Arrival preference: ${window}.`;
  body += " We'll notify you when it's confirmed.";
  return body;
}

function renderSmsTemplate(templateKey, data = {}) {
  const url = text(data.url, 240);
  let body = '';
  switch (templateKey) {
    case TEMPLATE_KEYS.REQUEST_RECEIVED:
      body = requestSummary(data, { includeService: !url }) + viewLink(url);
      break;
    case TEMPLATE_KEYS.SAFE_CONFIRMATION:
      // No url/token — SMS consent alone must not deliver private account access.
      body = requestSummary(data, { includeService: true });
      break;
    case TEMPLATE_KEYS.CONFIRMED: {
      const date = smsDateLabel(data.date || data.when);
      const window = smsWindowLabel(data.window);
      body = `${smsPrefix(templateKey)} Your appointment is confirmed`
        + (date ? ` for ${date}` : '')
        + (window ? `, ${window}` : '')
        + '.'
        + serviceClause(data, url)
        + viewLink(url);
      break;
    }
    case TEMPLATE_KEYS.CHANGE_REQUESTED:
      body = `${smsPrefix(templateKey)} We received your request to change your appointment.`
        + ` Current appointment is unchanged.`
        + viewLink(url);
      break;
    case TEMPLATE_KEYS.CANCELLATION_REQUESTED:
      body = `${smsPrefix(templateKey)} We received your cancellation request.`
        + ` Your appointment remains scheduled.`
        + viewLink(url);
      break;
    case TEMPLATE_KEYS.RESCHEDULED: {
      const date = smsDateLabel(data.date || data.when);
      const window = smsWindowLabel(data.window);
      body = `${smsPrefix(templateKey)} Your appointment has been rescheduled`
        + (date ? ` to ${date}` : '')
        + (window ? `, ${window}` : '')
        + '.'
        + viewLink(url);
      break;
    }
    case TEMPLATE_KEYS.CANCELLED: {
      const date = smsDateLabel(data.date || data.when);
      body = `${smsPrefix(templateKey)} Your appointment`
        + (date ? ` for ${date}` : '')
        + ` has been canceled.`;
      break;
    }
    case TEMPLATE_KEYS.ACTION_REQUIRED: {
      const date = smsDateLabel(data.date || data.when);
      body = `${smsPrefix(templateKey)} Action needed on your appointment`
        + (date ? ` for ${date}` : '')
        + '.'
        + viewLink(url);
      break;
    }
    case TEMPLATE_KEYS.PAYMENT_RECEIVED: {
      const date = smsDateLabel(data.date || data.when);
      const remaining = Math.max(0, Math.round(Number(data.remainingCents) || 0));
      body = `${smsPrefix(templateKey)} Payment received`
        + (date ? ` for ${date}` : '')
        + '.'
        + (remaining > 0 ? ' Balance remains.' : '')
        + viewLink(url);
      break;
    }
    case TEMPLATE_KEYS.DETAILS_UPDATED: {
      const date = smsDateLabel(data.date || data.when);
      body = `${smsPrefix(templateKey)} Your appointment was updated`
        + (date ? ` for ${date}` : '')
        + '.'
        + viewLink(url);
      break;
    }
    case TEMPLATE_KEYS.TECH_AUCTION:
      body = `${smsPrefix(templateKey)} Job ${text(data.service, 100)} - ${text(data.date, 40)} - ${text(data.area, 40)}.`
        + (url ? ` Bid: ${url}` : '');
      break;
    case TEMPLATE_KEYS.ADMIN_BOOKING:
      body = `${smsPrefix(templateKey)} Booking alert ${text(data.bookingRef, 50)} - ${text(data.customerName, 80)}`
        + (data.customerPhone ? ` - ${text(data.customerPhone, 30)}` : '');
      break;
    case TEMPLATE_KEYS.ADMIN_INQUIRY:
      body = `${smsPrefix(templateKey)} Customer question from ${text(data.customerName, 80)}`
        + (data.customerPhone ? ` (${text(data.customerPhone, 30)})` : '')
        + (data.message ? `: ${text(data.message, 220)}` : '');
      break;
    case TEMPLATE_KEYS.ADMIN_INBOUND_SMS:
      body = `${smsPrefix(templateKey)} Inbound text from ${text(data.customerPhone, 30)}`
        + (data.message ? `: ${text(data.message, 220)}` : '');
      break;
    case TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST:
      body = `${smsPrefix(templateKey)} Customer requested an appointment change`
        + (data.date ? ` for ${text(data.date, 40)}` : '')
        + (data.bookingRef ? ` (${text(data.bookingRef, 24)})` : '')
        + '.';
      break;
    case TEMPLATE_KEYS.ADMIN_CUSTOMER_CANCEL:
      body = `${smsPrefix(templateKey)} Customer canceled appointment`
        + (data.bookingRef ? ` ${text(data.bookingRef, 24)}` : '')
        + (data.date ? ` for ${text(data.date, 40)}` : '')
        + (data.window ? `, ${text(data.window, 40)}` : '')
        + '.';
      break;
    case TEMPLATE_KEYS.RECOVERY:
      body = `${smsPrefix(templateKey)} ${text(data.message, 360)}` + (url ? ` ${url}` : '');
      break;
    default:
      return { ok: false, error: 'unknown_sms_template' };
  }
  const rendered = withCompliance(body);
  const measure = measureSms(rendered);
  return {
    ok: true,
    body: rendered,
    templateKey,
    templateVersion: TEMPLATE_VERSION,
    encoding: measure.encoding,
    characterCount: measure.characterCount,
    segmentCount: measure.segmentCount,
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

function smsDateForEvent(eventType, booking = {}) {
  if (
    eventType === TEMPLATE_KEYS.CONFIRMED
    || eventType === TEMPLATE_KEYS.RESCHEDULED
  ) {
    return String(booking.confirmedDate || '').trim();
  }
  if (
    eventType === TEMPLATE_KEYS.REQUEST_RECEIVED
    || eventType === TEMPLATE_KEYS.SAFE_CONFIRMATION
  ) {
    return String(booking.preferredDate || '').trim();
  }
  return String(booking.confirmedDate || booking.preferredDate || '').trim();
}

function smsWindowForEvent(eventType, booking = {}) {
  if (
    eventType === TEMPLATE_KEYS.CONFIRMED
    || eventType === TEMPLATE_KEYS.RESCHEDULED
  ) {
    return String(
      booking.confirmedTimeWindow
      || booking.confirmedWindow
      || booking.confirmedTime
      || ''
    ).trim();
  }
  if (
    eventType === TEMPLATE_KEYS.REQUEST_RECEIVED
    || eventType === TEMPLATE_KEYS.SAFE_CONFIRMATION
  ) {
    const preferred = String(booking.preferredArrivalWindow || '').trim();
    if (preferred) return preferred;
    return String(booking.preferredTime || '').trim();
  }
  return String(
    booking.confirmedTimeWindow
    || booking.confirmedWindow
    || booking.confirmedTime
    || booking.preferredTime
    || ''
  ).trim();
}

function bookingTemplateData(eventType, booking = {}, accessUrl = '') {
  const date = smsDateForEvent(eventType, booking);
  const window = smsWindowForEvent(eventType, booking);
  const when = [date, window].filter(Boolean).join(' ');
  const fingerprint = scheduleFingerprint(booking);
  const service = smsServiceLabel(booking);
  const data = {};
  if (
    eventType === TEMPLATE_KEYS.CONFIRMED
    || eventType === TEMPLATE_KEYS.RESCHEDULED
    || eventType === TEMPLATE_KEYS.CANCELLED
    || eventType === TEMPLATE_KEYS.CHANGE_REQUESTED
    || eventType === TEMPLATE_KEYS.CANCELLATION_REQUESTED
    || eventType === TEMPLATE_KEYS.REQUEST_RECEIVED
    || eventType === TEMPLATE_KEYS.SAFE_CONFIRMATION
    || eventType === TEMPLATE_KEYS.ACTION_REQUIRED
    || eventType === TEMPLATE_KEYS.PAYMENT_RECEIVED
    || eventType === TEMPLATE_KEYS.DETAILS_UPDATED
  ) {
    data.date = date;
    data.window = window;
    data.when = when;
    data.scheduleFingerprint = fingerprint;
    data.previousDate = booking.previousConfirmedDate || booking.previousPreferredDate || '';
    if (service) data.service = service;
  }
  if (eventType === TEMPLATE_KEYS.PAYMENT_RECEIVED) {
    const payment = booking.__paymentEvent || {};
    if (payment.remainingCents != null) data.remainingCents = payment.remainingCents;
  }
  const url = String(accessUrl || '').trim();
  if (url) data.url = url;
  return data;
}

module.exports = {
  BRAND,
  TEMPLATE_VERSION,
  COMPLIANCE,
  TEMPLATE_KEYS,
  ADMIN_TEMPLATE_KEYS,
  smsBrandForTemplate,
  smsPrefix,
  renderSmsTemplate,
  bookingTemplateData,
  scheduleFingerprint,
  measureSms,
  smsDateLabel,
  smsWindowLabel,
  smsServiceLabel,
  asciiSms,
};
