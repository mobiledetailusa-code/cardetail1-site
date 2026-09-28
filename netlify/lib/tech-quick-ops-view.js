'use strict';

const {
  projectQuickOpsBooking,
  dollarsFromCents,
  bookingStatus,
} = require('./admin-quick-ops-view');

/**
 * Basic technician view. Address, customer name, vehicle, balance, and payout.
 * No confirm/cancel, no ceramic internals, no customer email.
 */
function projectTechQuickOpsBooking(booking, shared = null) {
  const full = projectQuickOpsBooking(booking, shared);
  const payoutCents = booking && booking.techPayoutAmount != null && Number.isFinite(Number(booking.techPayoutAmount))
    ? Math.max(0, Math.round(Number(booking.techPayoutAmount) * 100))
    : null;
  const due = !!(full.actions && full.actions.payment);
  const cancelled = bookingStatus(booking) === 'cancelled';
  return {
    bookingId: full.bookingId,
    bookingVersion: full.bookingVersion,
    quoteVersion: full.quoteVersion,
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
    money: {
      approvedLabel: full.money.approvedLabel,
      approvedCents: full.money.approvedCents,
      paidLabel: full.money.paidLabel,
      remainingLabel: full.money.remainingLabel,
      remainingCents: full.money.remainingCents,
      methodLabel: full.money.methodLabel,
      payoutCents,
      payoutLabel: payoutCents == null ? 'Not set' : dollarsFromCents(payoutCents),
    },
    paid: full.paid,
    completed: full.completed,
    actions: {
      call: !!full.telUrl && !cancelled,
      map: !!full.mapUrl,
      payment: due,
      cash: due,
      card: due,
      adjust: !cancelled,
    },
    mapUrl: full.mapUrl,
    telUrl: full.telUrl,
  };
}

module.exports = {
  projectTechQuickOpsBooking,
};
