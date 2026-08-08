/**
 * Portal refresh stability.
 *
 * Reported symptom: with several vehicles booked under one email, the portal
 * "fica atualizando constantemente, alternando os bookings" — it repainted
 * itself every few seconds and kept swapping which appointment was on screen,
 * and a Subaru that had just been paid for stopped being shown.
 *
 * Three independent causes, all reproduced below:
 *
 *  1. The sync version is a hash of the whole response payload, and
 *     postServiceState() embedded a millisecond countdown and a serverTime
 *     echo. Both changed on every request, so the hash never matched, the
 *     conditional-response short-circuit could never fire, and the client
 *     re-rendered the dashboard on every single poll.
 *
 *  2. selectUpcoming() re-runs on every poll. Settling a payment moves a
 *     booking from actionable to terminal, so paying for the appointment you
 *     were looking at handed the hero slot to a different one.
 *
 *  3. A focus ref resolves through a Blob lookup that can miss transiently.
 *     One miss during a background poll permanently cleared the focus — and
 *     raised "That appointment link could not be opened." at a customer who
 *     had not clicked anything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const { postServiceState } = require('../netlify/lib/post-service-experience');
const { syncVersionFor } = require('../netlify/lib/sync-response');
const garageJs = read('assets/my-garage.js');
const portalDataSrc = read('netlify/functions/customer-portal-data.js');

/** The real selectUpcoming, evaluated from source (module-private). */
function loadSelectUpcoming() {
  const ctx = { module: { exports: {} }, exports: {}, require, console, Date };
  vm.createContext(ctx);
  const slice = portalDataSrc.slice(
    portalDataSrc.indexOf('function upcomingSortKey'),
    portalDataSrc.indexOf('/** Test / inspect seam')
  );
  vm.runInContext(`${slice}\nthis.selectUpcoming = selectUpcoming;`, ctx);
  return ctx.selectUpcoming;
}

/* ── 1. The response hash must not move on its own ───────────────────────── */

function accountPayload(booking, now) {
  const ps = postServiceState(booking, now);
  return { ok: true, scope: 'account', bookings: [booking], postService: ps, postServiceByBooking: { X: ps } };
}

test('an unchanged account payload keeps the same sync version across polls', () => {
  // Offset off the hour boundary: hoursRemaining legitimately ticks once an
  // hour, and a fixture sitting exactly on that edge would flip on any delta.
  const completedAt = new Date(Date.now() - (3 * 3600 + 1800) * 1000).toISOString();
  const booking = { id: 'X', status: 'Completed', jobStatus: 'completed_paid', completedAt };
  const t0 = Date.now();
  const baseline = syncVersionFor(accountPayload(booking, t0));

  // Every poll interval the portal uses, well inside one hour bucket.
  [1, 2500, 20000, 60000, 600000, 25 * 60000].forEach((deltaMs) => {
    assert.equal(
      syncVersionFor(accountPayload(booking, t0 + deltaMs)),
      baseline,
      `sync version moved after ${deltaMs}ms with nothing actually changed`
    );
  });
});

test('the post-service projection carries no clock-derived field finer than an hour', () => {
  const completedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const state = postServiceState({ id: 'X', status: 'Completed', jobStatus: 'completed_paid', completedAt });
  assert.equal(state.serviceIssue.msRemaining, undefined, 'a millisecond countdown busts the cache every request');
  assert.equal(state.serverTime, undefined, 'the envelope already carries an authoritative serverTime');
  // The meaning is preserved by stable fields.
  assert.ok(state.serviceIssue.windowClosesAt, 'an absolute deadline survives');
  assert.equal(typeof state.serviceIssue.hoursRemaining, 'number');
});

test('a real change still moves the sync version', () => {
  const completedAt = new Date(Date.now() - (3 * 3600 + 1800) * 1000).toISOString();
  const booking = { id: 'X', status: 'Completed', jobStatus: 'completed_paid', completedAt };
  const now = Date.now();
  const before = syncVersionFor(accountPayload(booking, now));
  const after = syncVersionFor(accountPayload({ ...booking, status: 'Paid' }, now));
  assert.notEqual(before, after, 'the conditional response must not hide genuine updates');

  // And a review being submitted changes the post-service projection itself.
  const reviewed = { ...booking, reviews: [{ reviewId: 'r1', stars: 5, submittedAt: completedAt }] };
  assert.notEqual(
    syncVersionFor(accountPayload(reviewed, now)),
    before,
    'a change inside postServiceState must still surface'
  );
});

/* ── 2. Paying must not move the hero off the appointment being viewed ───── */

test('settling a payment reassigns the hero when nothing is pinned', () => {
  // This is the underlying server behaviour the client has to defend against —
  // it is correct in isolation (a paid job is no longer actionable) but it is
  // why the client must pin what the customer is looking at.
  const selectUpcoming = loadSelectUpcoming();
  const subaru = {
    id: 'CD1-SUBARU', appointmentPublicRef: 'aptr_subaru', preferredDate: '2026-08-14',
    status: 'Confirmed', jobStatus: 'completed_pending_payment', createdAt: '2026-08-01T10:00:00Z',
  };
  const civic = {
    id: 'CD1-CIVIC', appointmentPublicRef: 'aptr_civic', preferredDate: '2026-08-14',
    status: 'Pending Review', customerApprovalStatus: 'pending', createdAt: '2026-08-01T09:00:00Z',
  };

  assert.equal(selectUpcoming([subaru, civic]).id, 'CD1-SUBARU');
  const paid = { ...subaru, jobStatus: 'completed_paid', status: 'Completed' };
  assert.equal(selectUpcoming([paid, civic]).id, 'CD1-CIVIC', 'fixture assumption');
});

/**
 * Behavioural, not source-text: drive the real loadAccount() with a stubbed
 * account payload that carries no explicit focus, then assert the appointment
 * it landed on is now pinned. Asserting the implementation instead of the effect
 * is what made the previous version of this test break during a merge.
 */
test('the portal pins the appointment on screen so polls cannot swap it', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(read('my-garage.html').replace(/<script src="[^"]*"><\/script>/g, ''), {
    url: 'https://cardetail1.com/my-garage.html',
    runScripts: 'outside-only',
  });

  const subaru = {
    id: 'CD1-SUBARU', appointmentPublicRef: 'aptr_subaru', status: 'Confirmed',
    customerStatus: 'Confirmed', service: 'Full Detail', preferredDate: '2026-08-14',
  };
  const sent = [];
  dom.window.fetch = async (url, opts) => {
    const body = JSON.parse((opts && opts.body) || '{}');
    sent.push({ url: String(url), body });
    if (String(url).includes('customer-portal-auth')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, authenticated: false }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        scope: 'account',
        bookings: [subaru],
        upcoming: subaru,
        focusedAppointment: null,   // the customer clicked nothing
        payment: {},
      }),
    };
  };
  dom.window.eval(garageJs);
  const api = dom.window.cd1MyGarage;

  // boot() runs on load and bumps the hydration generation; a loadAccount issued
  // underneath it is discarded as stale. Let it settle before driving the portal.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(api.state.appointmentFocusRef, null, 'nothing pinned before an account load');

  const ok = await api.loadAccount({ managePhase: false });
  assert.equal(ok, true, 'the stubbed account payload must load');

  assert.equal(
    api.state.appointmentFocusRef,
    'aptr_subaru',
    'an unfocused load must pin the appointment it showed, or the next poll can swap it'
  );
  assert.equal(api.state.booking.id, 'CD1-SUBARU');

  // And the pinned ref is what the next refresh sends back to the server.
  sent.length = 0;
  await api.loadAccount({ managePhase: false });
  const portalCall = sent.find((c) => c.url.includes('customer-portal-data'));
  assert.equal(portalCall.body.appointment, 'aptr_subaru', 'the retained ref must travel on every refresh');
});

/* ── 3. A transient focus miss must not evict the customer ───────────────── */

test('a focus miss is only fatal when the customer asked for that focus', () => {
  const fn = garageJs.slice(garageJs.indexOf('function applyAppointmentFocus('));
  const body = fn.slice(0, fn.indexOf('\n  function '));
  const branch = body.slice(body.indexOf("data.focusError === 'invalid_focus'"));
  assert.match(branch, /if \(opts\.userInitiated\) \{/, 'a poll must not clear the focus');
  // The toast and the state reset both live inside that guard.
  const guarded = branch.slice(branch.indexOf('if (opts.userInitiated)'), branch.indexOf('return;'));
  assert.match(guarded, /state\.appointmentFocusRef = null;/);
  assert.match(guarded, /showToast\(/);
});

test('user-initiated loads are marked explicitly, not inferred from the ref', () => {
  // portalReload() re-sends the retained ref on every poll, so presence of a
  // ref cannot distinguish a poll from a click.
  assert.match(garageJs, /userInitiated: opts\.userInitiated === true/);
  // selectAppointmentByRef (a click) and both hydration paths (a navigation).
  assert.match(garageJs, /appointmentFocusRef: ref, managePhase: false, userInitiated: true/);
  assert.equal((garageJs.match(/userInitiated: true,/g) || []).length, 2, 'both hydration sites marked');
  // The poll path must not mark itself user-initiated.
  const reload = garageJs.slice(garageJs.indexOf('function portalReload('));
  assert.doesNotMatch(reload.slice(0, 600), /userInitiated/);
});

/* ── "Payment is not available yet" ──────────────────────────────────────── */

test('payment preparation failures say what actually went wrong', () => {
  const src = read('netlify/functions/customer-balance-payment-intent.js');
  const mod = require('../netlify/functions/customer-balance-payment-intent.js');
  assert.match(src, /const PREPARATION_MESSAGES = Object\.freeze\(\{/);

  // A zero balance is not "not available yet" — there is nothing to pay.
  assert.match(src, /zero_balance: 'There is no balance left to pay/);
  // Infrastructure failures are ours, and invite a retry rather than a wait.
  assert.match(src, /postgres_payment_disabled: 'Card payment is temporarily unavailable/);
  assert.match(src, /stripe_network_error: 'We could not reach the payment processor/);
  // The vague catch-all is gone.
  assert.doesNotMatch(src, /'Payment is not available yet\.'/);
  assert.ok(!mod.handler.toString().includes('not available yet'));
});
