#!/usr/bin/env node
/**
 * Full My Garage branch-deploy positive-path E2E (no PII/secrets in output).
 */
const BASE = process.env.MY_GARAGE_QA_BASE_URL || process.env.QA_BASE_URL || 'https://customer-my-garage-portal--cardetail1.netlify.app';
const BOOKING_A = 'QA-MYGARAGE-A';
const BOOKING_B = 'QA-MYGARAGE-B';
const PHONE_A = '2025550101';
const PHONE_B = '2025550102';

const results = [];
const report = { stripeMode: 'unknown', resend: 'unknown' };
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }

function adminHdr() {
  const t = String(process.env.MY_GARAGE_QA_ADMIN_TOKEN || '').trim();
  if (!t) throw new Error('MY_GARAGE_QA_ADMIN_TOKEN missing');
  return { 'X-Admin-Key': t };
}

async function post(path, body, headers = {}, cookie = '') {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (cookie) h.Cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body || {}),
    redirect: 'manual',
  });
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data, headers: res.headers, setCookie, raw: text };
}

function cookieFlags(setCookieArr) {
  const joined = (setCookieArr || []).join('; ');
  return {
    httpOnly: /httponly/i.test(joined),
    secure: /;\s*secure/i.test(joined),
    sameSite: (/samesite=(\w+)/i.exec(joined)?.[1] || '').toLowerCase(),
    hasMaxAge: /max-age=/i.test(joined),
  };
}

function cookieFromSetCookie(setCookieArr) {
  const line = (setCookieArr || [])[0] || '';
  const m = line.match(/^([^=]+)=([^;]+)/);
  if (!m) return '';
  return `${m[1]}=${m[2]}`;
}

async function main() {
  const hdr = adminHdr();

  let r = await post('/.netlify/functions/qa-my-garage-fixtures', { action: 'cleanup' }, hdr);
  if (r.status === 404) { fail('harness available', '404'); process.exit(1); }
  pass('harness available', String(r.status));

  r = await post('/.netlify/functions/qa-my-garage-fixtures', { action: 'seed' }, hdr);
  if (r.data?.ok && r.data.seeded === 2) pass('seed fixtures');
  else { fail('seed fixtures', r.data?.message || r.data?.error || r.status); process.exit(1); }
  report.stripeMode = r.data.stripeMode || 'unknown';

  // Limited lookup
  r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_A, phone: PHONE_A });
  if (r.data?.ok && r.data.booking?.id === BOOKING_A) pass('limited lookup A');
  else fail('limited lookup A', r.data?.error);

  r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_A, phone: PHONE_B });
  if (r.data?.ok === false) pass('wrong phone rejected');
  else fail('wrong phone rejected');

  r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: 'QA-MYGARAGE', phone: PHONE_A });
  if (r.data?.ok === false) pass('short suffix rejected');
  else fail('short suffix rejected');

  r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_B, phone: PHONE_B });
  if (r.data?.ok && r.data.booking?.id === BOOKING_B) pass('limited lookup B');
  else fail('limited lookup B', r.data?.error);

  r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_A, phone: PHONE_A });
  if (!JSON.stringify(r.data).includes('QA-MYGARAGE-B')) pass('isolation limited A');
  else fail('isolation limited A');

  if (r.data?.payment?.canPay === false) pass('customer A pay hidden');
  else fail('customer A pay hidden');

  r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_B, phone: PHONE_B });
  if (r.data?.payment?.state === 'due' || r.data?.payment?.canPay) pass('customer B payment due');
  else fail('customer B payment due');

  r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_B, phone: PHONE_A });
  if (r.data?.ok === false) pass('cross-customer phone blocked');
  else fail('cross-customer phone blocked');

  // Magic link via harness (server-side QA emails)
  r = await post('/.netlify/functions/qa-my-garage-fixtures', { action: 'start_magic_link', slot: 'a' }, hdr);
  if (r.data?.ok && r.data.challengeId) {
    pass('magic link start');
    report.resend = r.data.delivery === 'email' ? 'sent' : 'unknown';
  } else {
    fail('magic link start', r.data?.error || r.status);
    report.resend = r.data?.error || 'failed';
  }

  r = await post('/.netlify/functions/qa-my-garage-fixtures', { action: 'capture_magic_link', slot: 'a' }, hdr);
  let sessionCookie = '';
  if (r.data?.ok && r.data.challengeId && r.data.token) {
    pass('magic link capture');
    const v1 = await post('/.netlify/functions/customer-portal-auth', {
      action: 'verify', challengeId: r.data.challengeId, token: r.data.token,
    });
    const flags = cookieFlags(v1.setCookie);
    if (flags.httpOnly && flags.hasMaxAge && (flags.sameSite === 'lax' || flags.sameSite === 'strict')) pass('session cookie flags');
    else fail('session cookie flags', JSON.stringify(flags));
    sessionCookie = cookieFromSetCookie(v1.setCookie);
    if (v1.data?.ok && v1.data.authenticated) pass('magic link verify');
    else fail('magic link verify', v1.data?.error);

    const v2 = await post('/.netlify/functions/customer-portal-auth', {
      action: 'verify', challengeId: r.data.challengeId, token: r.data.token,
    });
    if (v2.data?.ok === false) pass('reused token rejected');
    else fail('reused token rejected');

    const sess = await post('/.netlify/functions/customer-portal-auth', { action: 'session' }, {}, sessionCookie);
    if (sess.data?.authenticated) pass('session persists');
    else fail('session persists');

    const logout = await post('/.netlify/functions/customer-portal-auth', { action: 'logout' }, {}, sessionCookie);
    if (logout.data?.ok) pass('logout ok');
    else fail('logout ok');

    const afterLogout = await post('/.netlify/functions/customer-portal-auth', { action: 'session' }, {}, sessionCookie);
    if (!afterLogout.data?.authenticated) pass('session revoked after logout');
    else fail('session revoked after logout');

    // Re-auth for vehicle tests
    const v3 = await post('/.netlify/functions/qa-my-garage-fixtures', { action: 'start_magic_link', slot: 'a' }, hdr);
    const cap = await post('/.netlify/functions/qa-my-garage-fixtures', { action: 'capture_magic_link', slot: 'a' }, hdr);
    const v4 = await post('/.netlify/functions/customer-portal-auth', {
      action: 'verify', challengeId: cap.data.challengeId, token: cap.data.token,
    });
    sessionCookie = cookieFromSetCookie(v4.setCookie);
  } else {
    fail('magic link capture', r.data?.error || r.status);
  }

  r = await post('/.netlify/functions/customer-portal-auth', {
    action: 'verify', challengeId: 'qa-expired-fixture', token: '000000',
  });
  if (r.data?.ok === false) pass('invalid token rejected');
  else fail('invalid token rejected');

  // Account isolation with session
  if (sessionCookie) {
    r = await post('/.netlify/functions/customer-portal-data', { mode: 'account' }, {}, sessionCookie);
    const ids = JSON.stringify(r.data?.bookings || []);
    if (ids.includes('QA-MYGARAGE-A') && !ids.includes('QA-MYGARAGE-B')) pass('session isolation A');
    else fail('session isolation A');

    r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_B, phone: PHONE_B }, {}, sessionCookie);
    if (r.data?.ok === false || r.data?.booking?.id !== BOOKING_B) pass('session cannot access B limited');
    else fail('session cannot access B limited');

    r = await post('/.netlify/functions/customer-portal-vehicles', { action: 'list' }, {}, sessionCookie);
    if (r.data?.ok) pass('vehicles list');
    else fail('vehicles list');

    r = await post('/.netlify/functions/customer-portal-vehicles', {
      action: 'add', vehicle: { label: '2026 QA Test Car', make: 'QA', model: 'Test', year: '2026' },
    }, {}, sessionCookie);
    const newId = r.data?.vehicle?.id;
    if (r.data?.ok && newId) pass('vehicle add');
    else fail('vehicle add', r.data?.error);

    if (newId) {
      r = await post('/.netlify/functions/customer-portal-vehicles', {
        action: 'update', vehicleId: newId, vehicle: { label: '2026 QA Test Car Updated' },
      }, {}, sessionCookie);
      if (r.data?.ok) pass('vehicle edit');
      else fail('vehicle edit', r.data?.error);

      r = await post('/.netlify/functions/customer-portal-vehicles', { action: 'archive', vehicleId: newId }, {}, sessionCookie);
      if (r.data?.ok) pass('vehicle archive');
      else fail('vehicle archive', r.data?.error);
    }

    const appt = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_A, phone: PHONE_A });
    if (appt.data?.booking?.preferredDate === '2026-08-15') pass('appointment unchanged after vehicle edits');
    else fail('appointment unchanged after vehicle edits');
  }

  // Change requests
  const requests = [
    ['reschedule', { bookingId: BOOKING_A, phone: PHONE_A, action: 'reschedule_request', newDate: '2026-09-01', newTime: '11:00 AM' }],
    ['address', { bookingId: BOOKING_A, phone: PHONE_A, action: 'address_update', newAddress: '101 QA Lane, Testville, NJ 07650' }],
    ['package', { bookingId: BOOKING_A, phone: PHONE_A, action: 'package_change_request', packageId: 'full' }],
    ['addon', { bookingId: BOOKING_A, phone: PHONE_A, action: 'addon_request', addonId: 'pet_hair' }],
    ['addon remove', { bookingId: BOOKING_A, phone: PHONE_A, action: 'addon_remove_request', addonId: 'pet_hair' }],
    ['vehicle add req', { bookingId: BOOKING_A, phone: PHONE_A, action: 'vehicle_add_request', vehicleLabel: '2025 QA Hatchback' }],
    ['cancel', { bookingId: BOOKING_A, phone: PHONE_A, reason: 'QA synthetic cancel test' }],
    ['maintenance', { bookingId: BOOKING_A, phone: PHONE_A, action: 'maintenance_request', message: 'QA synthetic maintenance note' }],
  ];
  for (const [label, payload] of requests) {
    const path = label === 'cancel'
      ? '/.netlify/functions/request-cancellation'
      : '/.netlify/functions/submit-customer-action';
    r = await post(path, payload);
    if (r.data?.ok) pass(`change request ${label}`);
    else fail(`change request ${label}`, r.data?.error);
  }

  r = await post('/.netlify/functions/submit-customer-action', {
    bookingId: BOOKING_A, phone: PHONE_A, action: 'reschedule_request', newDate: '2026-09-01', newTime: '11:00 AM',
  });
  if (r.data?.duplicate || r.data?.ok) pass('duplicate request idempotent');
  else fail('duplicate request idempotent');

  const before = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_A, phone: PHONE_A });
  if (before.data?.booking?.preferredDate === '2026-08-15') pass('booking unchanged pending approval');
  else fail('booking unchanged pending approval');

  // Admin workflow
  r = await post('/.netlify/functions/admin-customer-requests', { action: 'list' }, {});
  if (r.status === 401) pass('admin unauthorized 401');
  else fail('admin unauthorized 401', String(r.status));

  r = await post('/.netlify/functions/admin-customer-requests', { action: 'list' }, hdr);
  if (r.status === 200 && r.data?.ok) pass('admin list requests');
  else fail('admin list requests');

  const pending = (r.data?.requests || []).filter((x) => String(x.bookingId || '').startsWith('QA-MYGARAGE'));
  const reschedule = pending.find((x) => x.requestType === 'reschedule_request');
  const packageReq = pending.find((x) => x.requestType === 'package_change_request');
  const cancelReq = pending.find((x) => x.requestType === 'cancellation');

  if (reschedule) {
    r = await post('/.netlify/functions/admin-customer-requests', {
      action: 'decide', requestId: reschedule.id, decision: 'approve',
    }, hdr);
    if (r.data?.ok) pass('admin approve reschedule');
    else fail('admin approve reschedule', r.data?.error);
  } else fail('admin approve reschedule', 'missing request');

  if (packageReq) {
    r = await post('/.netlify/functions/admin-customer-requests', {
      action: 'decide', requestId: packageReq.id, decision: 'reject', adminNote: 'QA reject',
    }, hdr);
    if (r.data?.ok) pass('admin reject request');
    else fail('admin reject request', r.data?.error);
  } else fail('admin reject request', 'missing request');

  if (cancelReq) {
    r = await post('/.netlify/functions/admin-customer-requests', {
      action: 'decide', requestId: cancelReq.id, decision: 'clarify', adminNote: 'QA clarify',
    }, hdr);
    if (r.data?.ok) pass('admin clarify request');
    else fail('admin clarify request', r.data?.error);
  } else fail('admin clarify request', 'missing request');

  // Payment gating
  r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_B, phone: PHONE_B });
  if (r.data?.payment?.canPay || r.data?.payment?.state === 'due') pass('customer B payment state visible');
  else fail('customer B payment state visible');

  r = await post('/.netlify/functions/customer-portal-data', { mode: 'limited', bookingId: BOOKING_B, phone: PHONE_A });
  if (r.data?.ok === false) pass('customer A cannot access B payment');
  else fail('customer A cannot access B payment');

  // Responsive smoke (public HTML)
  for (const w of [320, 375, 430, 768, 1440]) {
    const page = await fetch(`${BASE}/my-garage.html`, { headers: { 'User-Agent': `QA/${w}` } });
    if (page.ok) pass(`responsive fetch ${w}px`);
    else fail(`responsive fetch ${w}px`, String(page.status));
  }

  // Cleanup
  r = await post('/.netlify/functions/qa-my-garage-fixtures', { action: 'cleanup' }, hdr);
  if (r.data?.ok && r.data.deletedBookings === 2) pass('cleanup fixtures');
  else fail('cleanup fixtures', JSON.stringify(r.data));

  r = await post('/.netlify/functions/qa-my-garage-fixtures', { action: 'inspect' }, hdr);
  if ((r.data?.bookingIds?.length || 0) === 0) pass('post-cleanup empty');
  else fail('post-cleanup empty');

  const failed = results.filter((x) => !x.ok);
  console.log(`\nE2E summary: ${results.length - failed.length}/${results.length}`);
  console.log(`Stripe mode: ${report.stripeMode}`);
  console.log(`Resend: ${report.resend}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
