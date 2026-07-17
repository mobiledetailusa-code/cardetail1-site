// Authenticated customer portal data — bookings, vehicles, payments (safe fields only).

const { jsonCors } = require('../lib/tech-security');
const { listRawBookings } = require('../lib/ops-db');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { authorizeBookingAccess } = require('../lib/booking-customer-auth');
const { validateCustomerSession } = require('../lib/customer-session');
const { phonesMatch, normalizeUsPhoneDigits } = require('../lib/phone-auth');
const { listVehiclesForOwner } = require('../lib/customer-vehicles');
const { listRequestsForBooking } = require('../lib/customer-change-requests');
const { canPayBalance } = require('../lib/appointment-status-policy');
const { catalogForClient } = require('../lib/customer-catalog');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

function computeDue(booking) {
  const paid = Number(booking.amountPaid || booking.paidAmount || 0);
  const approved = Number(
    booking.approvedFinalAmount != null
      ? booking.approvedFinalAmount
      : (booking.totalPrice || booking.finalAmount || 0)
  );
  if (booking.amountDueApproved != null) return Math.max(0, Number(booking.amountDueApproved));
  if (booking.balanceDue != null) return Math.max(0, Number(booking.balanceDue));
  return Math.max(0, Math.round((approved - paid) * 100) / 100);
}

function safePaymentState(booking) {
  const due = computeDue(booking);
  const payAllowed = canPayBalance(booking);
  let state = 'not_due';
  if (booking.paymentWorkflowStatus === 'payment_succeeded' || booking.paymentStatus === 'paid') state = 'paid';
  else if (booking.paymentStatus === 'failed') state = 'failed';
  else if (booking.paymentStatus === 'processing') state = 'processing';
  else if (due > 0) state = 'due';
  else if (booking.payLink) state = 'due';
  return {
    state,
    amountDueApproved: due,
    approvedTotal: Number(booking.approvedFinalAmount != null ? booking.approvedFinalAmount : (booking.totalPrice || 0)),
    amountPaid: Number(booking.amountPaid || booking.paidAmount || 0),
    payLink: booking.payLink || '',
    canPay: !!(payAllowed.ok && due > 0),
    canCreatePayLink: !!(payAllowed.ok && due > 0),
  };
}

function isVisibleCustomerBooking(b) {
  if (!b) return false;
  if (b.isDraft) return false;
  if (b.archived || b.isTest) return false;
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'lookup-booking', cors: true });
  if (rateLimit.blocked) return rateLimit.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'validation_error' }); }

  const mode = String(body.mode || 'limited').toLowerCase();
  const catalog = catalogForClient();

  if (mode === 'limited') {
    const auth = await authorizeBookingAccess(event, {
      bookingId: body.bookingId,
      phone: body.phone || body.customerPhone,
    });
    if (!auth.ok) {
      return jsonCors(auth.statusCode || 200, {
        ok: false,
        error: auth.error || 'authentication_failed',
        message: auth.message,
      });
    }
    if (!isVisibleCustomerBooking(auth.booking)) {
      return jsonCors(200, {
        ok: false,
        error: 'booking_not_ready',
        message: 'This booking is still being finalized. Complete checkout first, or call/text 551-313-2956.',
      });
    }
    const projected = projectBookingForCustomer(auth.booking);
    const payment = safePaymentState(auth.booking);
    return jsonCors(200, {
      ok: true,
      scope: 'booking',
      booking: projected,
      payment,
      catalog,
      changeRequests: await listRequestsForBooking(auth.booking.id || auth.booking.bookingId),
    });
  }

  const session = await validateCustomerSession(event);
  if (!session.ok) {
    return jsonCors(401, { ok: false, error: 'authentication_failed', message: 'Sign in required.' });
  }

  const all = await listRawBookings();
  const phoneDigits = session.phoneDigits;
  const bookings = all.filter((b) => {
    if (!isVisibleCustomerBooking(b)) return false;
    if (session.bookingIds?.length && session.bookingIds.includes(b.id || b.bookingId)) return true;
    const bPhone = normalizeUsPhoneDigits(b.phone || b.customerPhone || '');
    return phoneDigits && bPhone && phonesMatch(phoneDigits, bPhone);
  });

  const projected = bookings.map((b) => projectBookingForCustomer(b));
  const vehicles = phoneDigits ? await listVehiclesForOwner(phoneDigits) : [];
  const upcoming = projected.find((b) => !['Paid', 'Cancelled', 'Canceled'].includes(b.status)) || projected[0] || null;
  const payment = upcoming
    ? safePaymentState(bookings.find((b) => (b.id || b.bookingId) === upcoming.id) || {})
    : { state: 'not_due', amountDueApproved: 0, canPay: false, payLink: '' };

  let changeRequests = [];
  if (upcoming?.id) {
    try { changeRequests = await listRequestsForBooking(upcoming.id); } catch { changeRequests = []; }
  }

  return jsonCors(200, {
    ok: true,
    scope: 'account',
    bookings: projected,
    upcoming,
    vehicles,
    payment,
    catalog,
    changeRequests,
    sections: {
      appointments: projected.length > 0,
      vehicles: vehicles.length > 0,
      history: projected.some((b) => ['Paid', 'Completed'].includes(b.status)),
      maintenancePlans: projected.some((b) => b.maintenanceRequested || b.maintenancePeriod),
      payments: !!(payment.canPay || payment.payLink || projected.some((b) => Number(b.amountDueApproved || 0) > 0)),
      communicationPreferences: false,
    },
  });
};
