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
const TEMPLATE_VERSION = 'sms-v6-2026-09-16';
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
  CHANGE_APPROVED: 'booking.change_approved',
  CHANGE_REJECTED: 'booking.change_rejected',
  REVIEW_REQUESTED: 'booking.review_requested',
  // CUSTOMER_BOOKING_SMS_SAFE_CONFIRMATION — consent true, phone mismatch: no private link
  SAFE_CONFIRMATION: 'booking.safe_confirmation',
  TECH_AUCTION: 'auction.tech_invite',
  ADMIN_BOOKING: 'ops.booking_alert',
  ADMIN_INQUIRY: 'ops.inquiry_alert',
  ADMIN_INBOUND_SMS: 'ops.inbound_sms_alert',
  ADMIN_CHANGE_REQUEST: 'ops.change_request_alert',
  ADMIN_CANCELLATION_REQUESTED: 'ops.cancellation_request_alert',
  ADMIN_CUSTOMER_CANCEL: 'ops.customer_cancel_alert',
  RECOVERY: 'recovery.followup',
});

const ADMIN_TEMPLATE_KEYS = new Set([
  TEMPLATE_KEYS.ADMIN_BOOKING,
  TEMPLATE_KEYS.ADMIN_INQUIRY,
  TEMPLATE_KEYS.ADMIN_INBOUND_SMS,
  TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST,
  TEMPLATE_KEYS.ADMIN_CANCELLATION_REQUESTED,
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

function smsFirstName(booking = {}) {
  return asciiSms(booking.firstName || booking.customerFirstName || '').slice(0, 20);
}

function smsVehicleLabel(bookingOrRaw) {
  if (bookingOrRaw == null) return '';
  if (typeof bookingOrRaw !== 'object') {
    const direct = asciiSms(bookingOrRaw);
    return looksLikeInternalId(direct) ? '' : direct.slice(0, 36);
  }
  const vehicles = Array.isArray(bookingOrRaw.vehicles) ? bookingOrRaw.vehicles : [];
  const first = vehicles[0] && typeof vehicles[0] === 'object' ? vehicles[0] : {};
  const labeled = asciiSms(
    bookingOrRaw.vehicleLabel
    || first.vehicleLabel
    || ''
  );
  if (labeled && !looksLikeInternalId(labeled)) return labeled.slice(0, 36);
  const parts = [
    first.year || bookingOrRaw.year,
    first.make || bookingOrRaw.make,
    first.model || bookingOrRaw.model,
  ].filter(Boolean);
  const joined = asciiSms(parts.join(' '));
  if (joined) return joined.slice(0, 36);
  const raw = bookingOrRaw.vehicle;
  if (raw && typeof raw !== 'object') {
    const s = asciiSms(raw);
    if (s && !looksLikeInternalId(s)) return s.slice(0, 36);
  }
  return '';
}

function smsPriceLabel(booking = {}) {
  const ledgerCents = booking.ledger && booking.ledger.approvedCents != null
    ? Number(booking.ledger.approvedCents)
    : null;
  const amount = booking.approvedFinalAmount != null
    ? booking.approvedFinalAmount
    : booking.totalPrice;
  const cents = ledgerCents != null && Number.isFinite(ledgerCents)
    ? Math.round(ledgerCents)
    : Math.round(Number(amount || 0) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return '';
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function smsCityLabel(booking = {}) {
  const direct = asciiSms(booking.city || booking.serviceCity || booking.town || '');
  if (direct && !/\d/.test(direct) && !looksLikeInternalId(direct)) {
    return direct.slice(0, 22);
  }
  const address = asciiSms(booking.address || booking.serviceAddress || '');
  if (!address) return '';
  const parts = address.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const last = parts[parts.length - 1];
  if (/^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/i.test(last) || /^\d{5}(-\d{4})?$/.test(last)) {
    const city = asciiSms(parts[parts.length - 2]);
    if (city && !/\d/.test(city)) return city.slice(0, 22);
  }
  return '';
}

function viewLink(url) {
  return url ? ` View: ${url}` : '';
}

function joinSmsBits(parts) {
  return parts.map((part) => asciiSms(part)).filter(Boolean).join(', ');
}

function requestSummary(data) {
  const firstName = asciiSms(data.firstName).slice(0, 20);
  const vehicle = asciiSms(data.vehicle).slice(0, 36);
  const service = asciiSms(data.service).slice(0, 40);
  const date = smsDateLabel(data.date || data.when);
  const window = smsWindowLabel(data.window || data.arrivalPreference);
  const when = [date, window].filter(Boolean).join(' ');
  const bits = joinSmsBits([firstName, vehicle, service, when]);
  let body = `${smsPrefix(TEMPLATE_KEYS.REQUEST_RECEIVED)} Request received`;
  if (bits) body += ` - ${bits}`;
  body += '. Under review.';
  return body;
}

function renderSmsTemplate(templateKey, data = {}) {
  const url = text(data.url, 240);
  let body = '';
  switch (templateKey) {
    case TEMPLATE_KEYS.REQUEST_RECEIVED:
      // Customer appointment link is included when authorized (/a?t=).
      body = requestSummary(data) + viewLink(url);
      break;
    case TEMPLATE_KEYS.SAFE_CONFIRMATION:
      // No url/token — SMS consent alone must not deliver private account access.
      body = requestSummary(data);
      break;
    case TEMPLATE_KEYS.CONFIRMED: {
      const date = smsDateLabel(data.date || data.when);
      const window = smsWindowLabel(data.window);
      const when = [date, window].filter(Boolean).join(', ');
      const service = asciiSms(data.service).slice(0, 40);
      const price = asciiSms(data.price || data.total).slice(0, 12);
      const bits = joinSmsBits([when, service, price]);
      body = `${smsPrefix(templateKey)} Confirmed`
        + (bits ? ` - ${bits}` : '')
        + '.'
        + viewLink(url);
      break;
    }
    case TEMPLATE_KEYS.CHANGE_REQUESTED:
      if (String(data.changeKind || '').toLowerCase() === 'reschedule') {
        body = `${smsPrefix(templateKey)} We received your reschedule request.`
          + ` Your current appointment remains unchanged while we review it.`
          + viewLink(url);
      } else {
        body = `${smsPrefix(templateKey)} We received your request to change your appointment.`
          + ` Current appointment is unchanged.`
          + viewLink(url);
      }
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
      // Keep concise: package/add-on itemization belongs on CHANGE_APPROVED.
      const date = smsDateLabel(data.date || data.when);
      body = `${smsPrefix(templateKey)} Your appointment was updated`
        + (date ? ` for ${date}` : '')
        + '.'
        + viewLink(url);
      break;
    }
    case TEMPLATE_KEYS.CHANGE_APPROVED: {
      const service = asciiSms(data.service || data.packageName || '').slice(0, 40);
      const addon = asciiSms(data.addOnLabel || '').slice(0, 40);
      const total = asciiSms(data.total || '').slice(0, 20);
      body = `${smsPrefix(templateKey)} Your change was approved.`
        + (addon ? ` Add-on: ${addon}.` : '')
        + (service ? ` Package: ${service}.` : '')
        + (total ? ` Updated total: ${total}.` : '')
        + ' Appointment remains as planned.'
        + viewLink(url);
      break;
    }
    case TEMPLATE_KEYS.CHANGE_REJECTED: {
      const service = asciiSms(data.service || data.packageName || '').slice(0, 40);
      const total = asciiSms(data.total || '').slice(0, 20);
      body = `${smsPrefix(templateKey)} Your requested change was not approved.`
        + ' Current booking remains unchanged.'
        + (service ? ` Package: ${service}.` : '')
        + (total ? ` Total: ${total}.` : '')
        + viewLink(url);
      break;
    }
    case TEMPLATE_KEYS.REVIEW_REQUESTED:
      body = `${smsPrefix(templateKey)} How was your detail? Leave a review.`
        + viewLink(url);
      break;
    case TEMPLATE_KEYS.TECH_AUCTION:
      body = `${smsPrefix(templateKey)} Job ${text(data.service, 100)} - ${text(data.date, 40)} - ${text(data.area, 40)}.`
        + (url ? ` Bid: ${url}` : '');
      break;
    case TEMPLATE_KEYS.ADMIN_BOOKING: {
      const name = asciiSms(data.customerName).slice(0, 32);
      const vehicle = asciiSms(data.vehicle).slice(0, 28);
      const service = asciiSms(data.service || data.packageName).slice(0, 28);
      const price = asciiSms(data.price || data.total).slice(0, 12);
      const when = [smsDateLabel(data.date), smsWindowLabel(data.window)].filter(Boolean).join(' ');
      const city = asciiSms(data.city).slice(0, 20);
      const details = joinSmsBits([name, vehicle, service, price, when, city]);
      if (details) {
        body = `${smsPrefix(templateKey)} New request ${details}`;
      } else {
        body = `${smsPrefix(templateKey)} New request`
          + (data.bookingRef ? ` ${text(data.bookingRef, 24)}` : '')
          + (data.customerPhone ? ` - ${text(data.customerPhone, 30)}` : '');
      }
      break;
    }
    case TEMPLATE_KEYS.ADMIN_INQUIRY:
      body = `${smsPrefix(templateKey)} Customer question from ${text(data.customerName, 80)}`
        + (data.customerPhone ? ` (${text(data.customerPhone, 30)})` : '')
        + (data.message ? `: ${text(data.message, 220)}` : '');
      break;
    case TEMPLATE_KEYS.ADMIN_INBOUND_SMS:
      body = `${smsPrefix(templateKey)} Inbound text from ${text(data.customerPhone, 30)}`
        + (data.message ? `: ${text(data.message, 220)}` : '');
      break;
    case TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST: {
      const name = asciiSms(data.customerName).slice(0, 32);
      const change = asciiSms(String(data.changeSummary || '').replace(/→/g, '->'))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 70);
      const type = asciiSms(data.requestTypeLabel).slice(0, 32);
      const bookingRef = asciiSms(data.bookingRef).slice(0, 24);
      const date = text(data.date, 40);
      const vehicle = asciiSms(data.vehicle).slice(0, 24);
      const currentWhen = asciiSms(data.currentWhen).slice(0, 36);
      const requestedWhen = asciiSms(data.requestedWhen).slice(0, 36);
      const requestType = asciiSms(data.requestType || data.requestTypeLabel).toLowerCase();
      const isReschedule = String(data.changeKind || '').toLowerCase() === 'reschedule'
        || requestType.includes('reschedule')
        || !!(currentWhen && requestedWhen);
      if (isReschedule && (name || currentWhen || requestedWhen || vehicle)) {
        const shift = currentWhen && requestedWhen
          ? `${currentWhen} -> ${requestedWhen}`
          : (requestedWhen || currentWhen);
        body = `${smsPrefix(templateKey)} Reschedule request`
          + (name ? ` ${name}` : '')
          + (shift ? `, ${shift}` : '')
          + (vehicle ? `, ${vehicle}` : '')
          + '.';
      } else if (!name && !change && !type) {
        body = `${smsPrefix(templateKey)} Customer requested an appointment change`
          + (date ? ` for ${date}` : '')
          + (bookingRef ? ` (${bookingRef})` : '')
          + '.';
      } else {
        body = `${smsPrefix(templateKey)} Change request`
          + (name ? ` from ${name}` : '')
          + (bookingRef ? ` - ${bookingRef}` : '')
          + '.'
          + (change ? ` ${change}.` : (type ? ` ${type}.` : ' Customer requested an appointment change.'))
          + ' Review in Admin.';
      }
      break;
    }
    case TEMPLATE_KEYS.ADMIN_CANCELLATION_REQUESTED: {
      const name = asciiSms(data.customerName).slice(0, 32);
      const vehicle = asciiSms(data.vehicle).slice(0, 24);
      const when = [smsDateLabel(data.date), smsWindowLabel(data.window)].filter(Boolean).join(' ');
      const bookingRef = asciiSms(data.bookingRef).slice(0, 24);
      body = `${smsPrefix(templateKey)} Cancel request`
        + (name ? ` ${name}` : '')
        + (vehicle ? `, ${vehicle}` : '')
        + (when ? `, ${when}` : '')
        + (bookingRef ? ` (${bookingRef})` : '')
        + '. Still scheduled.';
      break;
    }
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
    || eventType === TEMPLATE_KEYS.CHANGE_APPROVED
    || eventType === TEMPLATE_KEYS.CHANGE_REJECTED
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
    const firstName = smsFirstName(booking);
    if (firstName) data.firstName = firstName;
    const vehicle = smsVehicleLabel(booking);
    if (vehicle) data.vehicle = vehicle;
  }
  if (eventType === TEMPLATE_KEYS.CONFIRMED) {
    const price = smsPriceLabel(booking);
    if (price) data.price = price;
  }
  if (eventType === TEMPLATE_KEYS.CHANGE_REQUESTED && booking.__changeKind) {
    data.changeKind = String(booking.__changeKind);
  }
  if (
    eventType === TEMPLATE_KEYS.CHANGE_APPROVED
    || eventType === TEMPLATE_KEYS.CHANGE_REJECTED
  ) {
    const pkg = asciiSms(
      booking.__approvedPackageName
      || booking.__currentPackageName
      || booking.package
      || booking.service
      || service
      || ''
    ).slice(0, 40);
    if (pkg) {
      data.service = pkg;
      data.packageName = pkg;
    }
    const addon = asciiSms(booking.__approvedAddOnLabel || '').slice(0, 40);
    if (addon) data.addOnLabel = addon;
    // Authoritative post-commit total only — never recompute in notification code.
    const cents = booking.approvedCents != null
      ? Number(booking.approvedCents)
      : Math.round(Number(booking.approvedFinalAmount != null
        ? booking.approvedFinalAmount
        : 0) * 100);
    if (Number.isFinite(cents) && cents > 0) {
      data.total = `$${(cents / 100).toFixed(2)}`;
    }
  }
  if (eventType === TEMPLATE_KEYS.PAYMENT_RECEIVED) {
    const payment = booking.__paymentEvent || {};
    if (payment.remainingCents != null) data.remainingCents = payment.remainingCents;
  }
  const url = String(accessUrl || '').trim();
  if (url) data.url = url;
  return data;
}

function formatSmsWhen(dateRaw, windowRaw) {
  return [smsDateLabel(dateRaw), smsWindowLabel(windowRaw)].filter(Boolean).join(' ');
}

function adminBookingTemplateData(booking = {}, extras = {}) {
  const name = asciiSms(
    extras.customerName
    || [booking.firstName, booking.lastName].filter(Boolean).join(' ')
    || booking.customerName
    || ''
  ).slice(0, 32);
  const data = {
    bookingRef: asciiSms(extras.bookingRef || booking.id || booking.bookingId || '').slice(0, 24),
  };
  if (name) data.customerName = name;
  const vehicle = smsVehicleLabel(booking);
  if (vehicle) data.vehicle = vehicle;
  const service = smsServiceLabel(booking);
  if (service) data.service = service;
  const price = smsPriceLabel(booking);
  if (price) data.price = price;
  const date = extras.date || booking.preferredDate || booking.confirmedDate || '';
  const window = extras.window
    || booking.preferredArrivalWindow
    || booking.preferredTime
    || booking.confirmedTimeWindow
    || '';
  if (date) data.date = date;
  if (window) data.window = window;
  const city = smsCityLabel(booking);
  if (city) data.city = city;
  if (extras.customerPhone) data.customerPhone = asciiSms(extras.customerPhone).slice(0, 20);
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
  adminBookingTemplateData,
  scheduleFingerprint,
  measureSms,
  smsDateLabel,
  smsWindowLabel,
  smsServiceLabel,
  smsVehicleLabel,
  smsPriceLabel,
  smsCityLabel,
  smsFirstName,
  formatSmsWhen,
  asciiSms,
};
