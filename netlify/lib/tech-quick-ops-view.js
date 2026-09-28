'use strict';

const {
  projectQuickOpsBooking,
  dollarsFromCents,
  bookingStatus,
  paidInFull,
  moneyFromBooking,
  jobCompleted,
} = require('./admin-quick-ops-view');

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
function projectTechQuickOpsBooking(booking, shared = null) {
  const full = projectQuickOpsBooking(booking, shared);
  const money = moneyFromBooking(booking, shared);
  const due = !!(full.actions && full.actions.payment);
  const cancelled = bookingStatus(booking) === 'cancelled';
  const completed = jobCompleted(booking);
  const contactRestricted = paidInFull(booking, money);
  const payoutRaw = booking && booking.techPayoutAmount;
  const payoutCents = payoutRaw != null && payoutRaw !== '' && Number.isFinite(Number(payoutRaw))
    ? Math.max(0, Math.round(Number(payoutRaw) * 100))
    : null;
  const visibleNote = contactRestricted && noteLeaksContact(full.service.note, booking)
    ? ''
    : full.service.note;
  return {
    bookingId: full.bookingId,
    bookingVersion: full.bookingVersion,
    status: full.status,
    contactRestricted,
    customer: { name: full.customer.name || 'Customer' },
    vehicle: full.vehicle,
    service: {
      package: full.service.package,
      date: full.service.date,
      window: full.service.window,
      address: contactRestricted ? '' : full.service.address,
      note: visibleNote,
    },
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
      call: !contactRestricted && !!full.telUrl && !cancelled,
      map: !contactRestricted && !!full.mapUrl,
      payment: due,
      increase: !cancelled && !completed,
      arrive: !cancelled && !completed && !!booking.techQuickOpsTokenHash,
    },
    mapUrl: contactRestricted ? '' : full.mapUrl,
    telUrl: contactRestricted ? '' : full.telUrl,
  };
}

module.exports = {
  projectTechQuickOpsBooking,
};
