'use strict';

const {
  projectQuickOpsBooking,
  dollarsFromCents,
  bookingStatus,
  paidInFull,
  moneyFromBooking,
  jobCompleted,
} = require('./admin-quick-ops-view');
const { quickOpsPiiDecision } = require('./tech-dispatch-privacy');

function digitsOf(value) {
  return String(value || '').replace(/\D/g, '');
}

function noteLeaksContact(note, booking) {
  const text = String(note || '');
  const folded = text.toLowerCase();
  const address = String(booking.address || booking.serviceAddress || '').replace(/\s+/g, ' ').trim();
  if (address.length >= 6 && folded.includes(address.toLowerCase())) return true;
  const phone = digitsOf(booking.phone || booking.customerPhone || '');
  const ten = phone.length >= 10 ? phone.slice(-10) : '';
  if (ten && digitsOf(text).includes(ten)) return true;
  return false;
}

/**
 * Basic technician view. Address, customer name, and vehicle only.
 * The job total stays off this projection. Payment is a customer link.
 * No confirm/cancel, no cash/card, no ceramic internals, no customer email.
 */
function projectTechQuickOpsBooking(booking, shared = null, { nowMs = Date.now() } = {}) {
  const full = projectQuickOpsBooking(booking, shared);
  // Same server-side policy as the technician portal: customer name, address,
  // phone, notes and access details only inside the 12-hour Eastern window
  // before arrival, never on a cancelled/completed job (any status field),
  // and never when the schedule is missing or inconsistent. Assignment is
  // checked by the caller (signed link session bound to booking + phone).
  const pii = quickOpsPiiDecision(booking, nowMs);
  const locked = !pii.allowed;
  const money = moneyFromBooking(booking, shared);
  const due = !!(full.actions && full.actions.payment);
  const cancelled = bookingStatus(booking) === 'cancelled';
  const completed = jobCompleted(booking);
  const contactRestricted = completed && paidInFull(booking, money);
  const payoutRaw = booking && booking.techPayoutAmount;
  const payoutCents = payoutRaw != null && payoutRaw !== '' && Number.isFinite(Number(payoutRaw))
    ? Math.max(0, Math.round(Number(payoutRaw) * 100))
    : null;
  const visibleNote = contactRestricted && noteLeaksContact(full.service.note, booking)
    ? ''
    : full.service.note;
  // Same job sheet as the admin page. After a paid, completed job the
  // technician loses access details (gate codes) and any note naming contact.
  const sheet = full.jobSheet;
  let jobSheet = contactRestricted
    ? {
      ...sheet,
      customerNote: noteLeaksContact(sheet.customerNote, booking) ? '' : sheet.customerNote,
      accessNotes: '',
    }
    : sheet;
  if (locked) jobSheet = { ...jobSheet, customerNote: '', accessNotes: '', serviceLocation: '' };
  return {
    bookingId: full.bookingId,
    bookingVersion: full.bookingVersion,
    status: full.status,
    contactRestricted,
    piiLocked: locked,
    piiLockReason: locked ? pii.reason : '',
    piiUnlocksAt: pii.unlocksAt || '',
    piiLockMessage: locked ? pii.message : '',
    customer: { name: locked ? 'Customer' : (full.customer.name || 'Customer') },
    vehicle: full.vehicle,
    service: {
      package: full.service.package,
      date: full.service.date,
      window: full.service.window,
      durationMinutes: full.service.durationMinutes,
      address: contactRestricted || locked ? '' : full.service.address,
      note: locked ? '' : visibleNote,
    },
    jobSheet,
    yourPay: {
      set: payoutCents != null,
      label: payoutCents == null ? '' : dollarsFromCents(payoutCents),
    },
    arrival: {
      recorded: !!(booking && booking.arrivedAt),
      at: booking && booking.arrivedAt ? String(booking.arrivedAt) : '',
      delivery: String(booking && booking.arrivalNotifyStatus || ''),
    },
    paymentDue: due,
    actions: {
      call: !locked && !contactRestricted && !!full.telUrl && !cancelled,
      map: !locked && !contactRestricted && !!full.mapUrl,
      payment: due,
      increase: !cancelled && !completed,
      arrive: !cancelled && !completed && !!booking.techQuickOpsTokenHash,
      // Assigned technician, already on site, balance still due. The page does
      // not print the customer total; the server settles the remaining balance.
      collectCash: !cancelled && !completed && due && !!booking.arrivedAt && !!booking.techQuickOpsTokenHash,
      collectCard: !cancelled && !completed && due && !!booking.arrivedAt && !!booking.techQuickOpsTokenHash,
    },
    mapUrl: contactRestricted || locked ? '' : full.mapUrl,
    telUrl: contactRestricted || locked ? '' : full.telUrl,
  };
}

module.exports = {
  projectTechQuickOpsBooking,
};
