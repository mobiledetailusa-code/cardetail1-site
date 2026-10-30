'use strict';

/**
 * Offline Square-preparation authority fixture.
 * The URL is a presence token for the guard. It is not a connection string
 * the tests open.
 */
const squareAuthorityEnv = {
  CD1_POSTGRES_PAYMENT: '1',
  DATABASE_URL: 'postgres://fixture-not-contacted',
};

function projectionForBooking(bookingRecord) {
  const booking = bookingRecord && typeof bookingRecord === 'object' ? bookingRecord : {};
  const ledger = booking.ledger && typeof booking.ledger === 'object' ? booking.ledger : {};
  const approvedCents = ledger.approvedCents;
  const grossSettledCents = ledger.settledCents;
  const credited = typeof ledger.creditedCents === 'number' ? ledger.creditedCents : 0;
  let remainingCents = null;
  if (typeof approvedCents === 'number' && typeof grossSettledCents === 'number') {
    remainingCents = Math.max(0, approvedCents - grossSettledCents - credited);
  }
  const status = String(booking.jobStatus || booking.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled' || booking._historicalPaidClosed) {
    remainingCents = 0;
  }
  return {
    ok: true,
    authority: 'postgres',
    bookingId: booking.id,
    projection: {
      bookingId: booking.id,
      authority: 'postgres',
      quoteVersion: booking.quoteVersion,
      approvedCents,
      remainingCents,
      currency: ledger.currency || 'usd',
      grossSettledCents,
      refundedCents: 0,
      settledCents: grossSettledCents,
    },
  };
}

module.exports = {
  squareAuthorityEnv,
  projectionForBooking,
};
