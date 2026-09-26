'use strict';

const { remainingCents } = require('./booking-aggregate');
const { smsDateLabel, smsWindowLabel, smsVehicleLabel, smsServiceLabel, smsPriceLabel } = require('./sms-templates');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const { KNOWN_OPERATIONAL_SLOTS } = require('./operational-availability');

const PENDING_REQUEST = new Set(['pending', 'requested', 'open', 'submitted', 'awaiting_review']);

function dollarsFromCents(cents) {
  const n = Math.max(0, Math.round(Number(cents) || 0));
  if (n % 100 === 0) return `$${n / 100}`;
  return `$${(n / 100).toFixed(2)}`;
}

function bookingStatus(booking) {
  const appt = String(booking.appointmentStatus || '').toLowerCase();
  const js = String(booking.jobStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  if (appt === 'canceled' || appt === 'cancelled' || js === 'cancelled' || st === 'cancelled') {
    return 'cancelled';
  }
  if (appt === 'confirmed' || js === 'confirmed' || st === 'confirmed') return 'confirmed';
  if (booking.cancellationRequestStatus === 'requested') return 'cancel_requested';
  return 'pending_review';
}

function jobCompleted(booking) {
  if (!booking) return false;
  if (booking.completedAt || booking.jobCompletedAt || booking.techCompletedAt) return true;
  const js = String(booking.jobStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  return js === 'completed' || js === 'completed_paid' || js === 'closed'
    || st === 'completed' || st === 'completed_paid';
}

function paidInFull(booking, money) {
  if (!money || !(money.remainingCents <= 0)) return false;
  const pay = String(booking && booking.paymentStatus || '').toLowerCase();
  if (['paid', 'paid_cash', 'paid_card_on_site'].includes(pay)) return true;
  return Math.max(0, Math.round(Number(money.settledCents) || 0)) > 0;
}

function onSiteMethodLabel(booking) {
  const pay = String(booking && booking.paymentStatus || '').toLowerCase();
  const pwf = String(booking && booking.paymentWorkflowStatus || '').toLowerCase();
  const cashAmount = Number(booking && booking.cashReceivedAmount);
  const cardAmount = Number(booking && booking.cardOnSiteAmount);
  if (pay === 'paid_cash' || pwf === 'cash_paid' || cashAmount > 0 || booking && booking.cashReceivedAt) {
    return 'Cash';
  }
  if (pay === 'paid_card_on_site' || cardAmount > 0 || booking && booking.cardOnSiteAt) {
    return 'Card';
  }
  if (pay === 'paid') return 'Card';
  return '';
}

function dateIso(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

function pendingChangeRequest(booking) {
  const list = Array.isArray(booking.changeRequests) ? booking.changeRequests : [];
  return list.find((row) => PENDING_REQUEST.has(String(row.status || row.requestStatus || '').toLowerCase())) || null;
}

function moneyFromBooking(booking, shared = null) {
  if (shared && shared.ok && shared.projection) {
    const p = shared.projection;
    return {
      authority: shared.authority || 'postgres',
      approvedCents: Math.max(0, Math.round(Number(p.approvedCents) || 0)),
      settledCents: Math.max(0, Math.round(Number(p.settledCents != null ? p.settledCents : p.netSettledCents) || 0)),
      remainingCents: Math.max(0, Math.round(Number(p.remainingCents) || 0)),
      quoteVersion: Math.max(0, Math.round(Number(p.quoteVersion != null ? p.quoteVersion : booking.quoteVersion) || 0)),
    };
  }
  const ledger = booking.ledger || {};
  const approved = Math.max(0, Math.round(Number(ledger.approvedCents != null
    ? ledger.approvedCents
    : Number(booking.approvedFinalAmount || booking.totalPrice || 0) * 100) || 0));
  const remaining = remainingCents({
    approvedCents: approved,
    settledCents: ledger.settledCents,
    creditedCents: ledger.creditedCents,
  });
  return {
    authority: 'blob',
    approvedCents: approved,
    settledCents: Math.max(0, Math.round(Number(ledger.settledCents) || 0)),
    remainingCents: remaining,
    quoteVersion: Math.max(0, Math.round(Number(booking.quoteVersion) || 0)),
  };
}

function projectQuickOpsBooking(booking, shared = null) {
  const first = Array.isArray(booking.vehicles) ? booking.vehicles[0] || {} : {};
  const status = bookingStatus(booking);
  const money = moneyFromBooking(booking, shared);
  const pending = pendingChangeRequest(booking);
  const phone = normalizeUsPhoneE164(booking.phone || booking.customerPhone || '') || '';
  const address = String(booking.address || booking.serviceAddress || '').trim();
  const date = String(booking.confirmedDate || booking.preferredDate || '');
  const window = String(
    booking.confirmedTimeWindow
    || booking.confirmedWindow
    || booking.preferredArrivalWindow
    || booking.preferredTime
    || ''
  );
  return {
    bookingId: String(booking.id || booking.bookingId || ''),
    bookingVersion: Math.max(0, Math.round(Number(booking.bookingVersion) || 0)),
    quoteVersion: money.quoteVersion,
    status,
    customer: {
      name: [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim()
        || String(booking.customerName || '').trim(),
      phone,
    },
    vehicle: {
      year: first.year || booking.year || '',
      make: first.make || booking.make || '',
      model: first.model || booking.model || '',
      label: smsVehicleLabel(booking),
      type: first.category || first.cat || booking.vehicleCategory || '',
    },
    service: {
      package: smsServiceLabel(booking),
      date: smsDateLabel(date),
      dateIso: dateIso(date),
      window: smsWindowLabel(window),
      windowRaw: window,
      windows: [...KNOWN_OPERATIONAL_SLOTS],
      address,
      note: String(booking.notes || booking.specialInstructions || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    },
    money: {
      approvedLabel: dollarsFromCents(money.approvedCents) || smsPriceLabel(booking),
      paidLabel: dollarsFromCents(money.settledCents),
      remainingLabel: dollarsFromCents(money.remainingCents),
      remainingCents: money.remainingCents,
      settledCents: money.settledCents,
      authority: money.authority,
      methodLabel: onSiteMethodLabel(booking),
    },
    request: pending ? {
      requestId: pending.requestId || pending.id || '',
      type: pending.requestType || pending.type || '',
      summary: String(pending.changeSummary || pending.summary || pending.requestType || pending.type || 'Change request')
        .replace(/_/g, ' ')
        .slice(0, 120),
    } : null,
    cancelRequested: booking.cancellationRequestStatus === 'requested',
    paid: paidInFull(booking, money),
    completed: jobCompleted(booking),
    locked: paidInFull(booking, money) || (jobCompleted(booking) && money.remainingCents <= 0),
    actions: (() => {
      const paid = paidInFull(booking, money);
      const done = jobCompleted(booking);
      const appointmentLocked = paid || done || status === 'cancelled';
      const due = money.remainingCents > 0 && status !== 'cancelled' && !paid;
      return {
        confirm: status === 'pending_review' && !appointmentLocked,
        cancel: status !== 'cancelled' && !appointmentLocked,
        approve: !!(pending && !appointmentLocked),
        reject: !!(pending && !appointmentLocked),
        call: !!phone,
        text: !!phone,
        map: !!address,
        payment: due,
        cash: due,
        card: due,
        reschedule: !appointmentLocked,
      };
    })(),
    mapUrl: address ? `https://maps.google.com/?q=${encodeURIComponent(address)}` : '',
    telUrl: phone ? `tel:${phone}` : '',
  };
}

module.exports = {
  bookingStatus,
  pendingChangeRequest,
  moneyFromBooking,
  projectQuickOpsBooking,
  dollarsFromCents,
  jobCompleted,
  paidInFull,
  onSiteMethodLabel,
};
