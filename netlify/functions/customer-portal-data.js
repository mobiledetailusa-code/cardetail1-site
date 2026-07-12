// Authenticated customer portal data — bookings, vehicles, payments (safe fields only).

const { jsonCors } = require('../lib/tech-security');
const { listRawBookings, getBooking } = require('../lib/ops-db');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { authorizeBookingAccess, normalizeBookingId } = require('../lib/booking-customer-auth');
const { validateCustomerSession } = require('../lib/customer-session');
const { phonesMatch, normalizeUsPhoneDigits } = require('../lib/phone-auth');
const { listVehiclesForOwner } = require('../lib/customer-vehicles');
const { listRequestsForBooking } = require('../lib/customer-change-requests');
const { canPayBalance, classifyStatus } = require('../lib/appointment-status-policy');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

function safePaymentState(booking) {
  const phase = classifyStatus(booking);
  const due = Number(booking.amountDueApproved || booking.balanceDue || 0);
  let state = 'not_due';
  if (booking.paymentWorkflowStatus === 'payment_succeeded' || phase === 'paid') state = 'paid';
  else if (booking.paymentStatus === 'failed') state = 'failed';
  else if (booking.paymentStatus === 'processing') state = 'processing';
  else if (due > 0 && booking.payLink) state = 'due';
  return { state, amountDueApproved: due > 0 ? due : 0, payLink: state === 'due' ? (booking.payLink || '') : '' };
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
    const projected = projectBookingForCustomer(auth.booking);
    const payment = safePaymentState(auth.booking);
    const payAllowed = canPayBalance(auth.booking);
    return jsonCors(200, {
      ok: true,
      scope: 'booking',
      booking: projected,
      payment: {
        ...payment,
        canPay: payAllowed.ok && payment.state === 'due',
      },
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
    if (session.bookingIds?.length && session.bookingIds.includes(b.id || b.bookingId)) return true;
    const bPhone = normalizeUsPhoneDigits(b.phone || b.customerPhone || '');
    return phoneDigits && bPhone && phonesMatch(phoneDigits, bPhone);
  });

  const projected = bookings.map((b) => projectBookingForCustomer(b));
  const vehicles = phoneDigits ? await listVehiclesForOwner(phoneDigits) : [];

  const upcoming = projected.find((b) => !['Paid', 'Cancelled', 'Canceled'].includes(b.status)) || projected[0] || null;

  return jsonCors(200, {
    ok: true,
    scope: 'account',
    bookings: projected,
    upcoming,
    vehicles,
    sections: {
      appointments: projected.length > 0,
      vehicles: vehicles.length > 0,
      history: projected.some((b) => ['Paid', 'Completed'].includes(b.status)),
      maintenancePlans: false,
      payments: projected.some((b) => b.payLink || b.paymentWorkflowStatus?.includes('payment')),
      communicationPreferences: false,
    },
  });
};
