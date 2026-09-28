'use strict';

const {
  projectQuickOpsBooking,
  dollarsFromCents,
  bookingStatus,
} = require('./admin-quick-ops-view');

/**
 * Basic technician view. Address, customer name, and vehicle only.
 * The job total stays off this projection. Payment is a customer link.
 * No confirm/cancel, no cash/card, no ceramic internals, no customer email.
 */
function projectTechQuickOpsBooking(booking, shared = null) {
  const full = projectQuickOpsBooking(booking, shared);
  const due = !!(full.actions && full.actions.payment);
  const cancelled = bookingStatus(booking) === 'cancelled';
  const payoutCents = booking && booking.techPayoutAmount != null && Number.isFinite(Number(booking.techPayoutAmount))
    ? Math.max(0, Math.round(Number(booking.techPayoutAmount) * 100))
    : null;
  return {
    bookingId: full.bookingId,
    bookingVersion: full.bookingVersion,
    status: full.status,
    customer: { name: full.customer.name || 'Customer' },
    vehicle: full.vehicle,
    service: {
      package: full.service.package,
      date: full.service.date,
      window: full.service.window,
      address: full.service.address,
      note: full.service.note,
    },
    yourPay: {
      set: payoutCents != null,
      label: payoutCents == null ? '' : dollarsFromCents(payoutCents),
    },
    paymentDue: due,
    actions: {
      call: !!full.telUrl && !cancelled,
      map: !!full.mapUrl,
      payment: due,
      increase: !cancelled,
    },
    mapUrl: full.mapUrl,
    telUrl: full.telUrl,
  };
}

module.exports = {
  projectTechQuickOpsBooking,
};
