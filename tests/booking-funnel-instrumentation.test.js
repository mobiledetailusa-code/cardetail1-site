const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const funnelSource = fs.readFileSync(path.join(root, 'assets', 'revops-booking-hooks.js'), 'utf8');
const initSource = fs.readFileSync(path.join(root, 'assets', 'revops-init.js'), 'utf8');
const revenueSource = fs.readFileSync(path.join(root, 'assets', 'revenue-events.js'), 'utf8');
const hubSource = fs.readFileSync(path.join(root, 'assets', 'hub-booking-bridge.js'), 'utf8');
const conversionSource = fs.readFileSync(path.join(root, 'assets', 'booking-conversion-ux.js'), 'utf8');
const checkoutSource = fs.readFileSync(path.join(root, 'assets', 'checkout-analytics.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const serverSchema = require('../netlify/lib/revenue-event-schema');
const { buildBookingFunnelReport } = require('../netlify/lib/booking-funnel-report');

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); },
  };
}

function makeFunnel(options = {}) {
  let active = options.active || 1;
  const events = [];
  const sessionStore = storage();
  const overlay = { classList: classList(options.visible === false ? [] : ['open']) };
  const gate = { classList: classList() };
  const body = { classList: classList(options.embed ? ['cd1-booking-embed'] : []) };
  const context = {
    URLSearchParams,
    location: { pathname: options.pathname || '/', search: options.embed ? '?embed=1' : '' },
    document: {
      body,
      querySelector(selector) {
        if (selector === '.bsec.on') return active ? { id: `bs${active}` } : null;
        return null;
      },
      getElementById(id) {
        if (id === 'bk-ov') return overlay;
        if (id === 'bk-gate-msg') return gate;
        return null;
      },
    },
    sessionStorage: sessionStore,
    ST: options.ST || { cat: '', pkg: null, pkgId: '', vehicles: [] },
    Cardetail1Revenue: {
      getSessionId: () => options.sessionId || 'sess_canonical_123',
      track(name, props) {
        if (options.throwAnalytics) throw new Error('analytics unavailable');
        events.push({ name, props: { ...(props || {}) }, session: this.getSessionId() });
        return `evt_${events.length}`;
      },
    },
    openBooking(category) {
      if (options.openSucceeds !== false && category !== 'fleet') overlay.classList.add('open');
      return 'opened';
    },
    bkGoTo(next) {
      if (options.rejectTransition !== next) active = Number(next);
      return active;
    },
    showSuccess(payload) { return payload && payload.id; },
    onBkZipInput(value) {
      if (value === '07030') gate.classList.add('unlocked');
      else gate.classList.remove('unlocked');
    },
    getComputedStyle: () => ({ display: overlay.classList.contains('open') ? 'flex' : 'none', visibility: 'visible' }),
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    console,
  };
  context.window = context;
  context.globalThis = context;
  context.parent = options.embed ? {} : context;
  vm.createContext(context);
  vm.runInContext(funnelSource, context, { filename: 'revops-booking-hooks.js' });
  return {
    context,
    events,
    overlay,
    gate,
    get active() { return active; },
    set active(value) { active = value; },
  };
}

function makePageView(options = {}) {
  const pageViews = [];
  const context = {
    URLSearchParams,
    location: { pathname: options.pathname || '/', search: options.embed ? '?embed=1' : '' },
    document: {
      readyState: 'complete',
      querySelectorAll: () => [],
    },
    Cardetail1Revenue: {
      initAdapters() {},
      initPageView(type) { pageViews.push(type); },
    },
    console,
  };
  context.window = context;
  context.globalThis = context;
  context.parent = options.embed ? {} : context;
  vm.createContext(context);
  vm.runInContext(initSource, context, { filename: 'revops-init.js' });
  return { context, pageViews };
}

function makeRevenue(options = {}) {
  const sessionStore = storage();
  const localStore = storage();
  const requests = [];
  const context = {
    URL,
    URLSearchParams,
    Date,
    Math,
    Promise,
    JSON,
    Object,
    String,
    Number,
    Array,
    isFinite,
    location: { pathname: '/index.html', search: options.search || '' },
    document: {
      referrer: '',
      getElementById: () => null,
      createElement: () => ({ set id(value) { this._id = value; } }),
      head: { appendChild() {} },
    },
    sessionStorage: sessionStore,
    localStorage: localStore,
    crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
    fetch(url, request) {
      requests.push({ url, request });
      return Promise.resolve({ status: 200, headers: { get: () => null } });
    },
    setTimeout: () => 1,
    clearTimeout() {},
    innerWidth: 1200,
    console: { warn() {}, debug() {} },
  };
  context.window = context;
  context.globalThis = context;
  context.parent = options.embed ? {} : context;
  vm.createContext(context);
  vm.runInContext(revenueSource, context, { filename: 'revenue-events.js' });
  return { context, requests };
}

// The requested 24-item focused matrix follows in the same order as the release brief.
test('1. standalone homepage emits one home page_view', () => {
  const page = makePageView();
  page.context.CD1RevOpsInit.init();
  assert.deepEqual(page.pageViews, ['home']);
});

test('2. delegated iframe does not create a false homepage page_view', () => {
  assert.deepEqual(makePageView({ embed: true }).pageViews, []);
});

test('3. booking_started fires once only after booking is visibly open', () => {
  const failed = makeFunnel({ visible: false, openSucceeds: false });
  failed.context.openBooking('cars');
  assert.equal(failed.events.length, 0);
  const visible = makeFunnel();
  visible.context.openBooking('cars');
  visible.context.openBooking('cars');
  assert.equal(visible.events.filter((event) => event.name === 'booking_started').length, 1);
});

test('4. direct booking opening is tracked', () => {
  const run = makeFunnel();
  assert.equal(run.context.openBooking('boats'), 'opened');
  assert.equal(run.events[0].name, 'booking_started');
});

test('5. hub delegated booking opening is tracked only from ready signal', () => {
  const run = makeFunnel({ embed: true });
  run.context.openBooking('cars');
  assert.equal(run.events.length, 0);
  run.context.CD1CanonicalFunnel.delegatedBookingReady('cars');
  assert.equal(run.events[0].name, 'booking_started');
  assert.match(hubSource, /iframeReady\(\)[\s\S]*delegatedBookingReady/);
});

test('6. inline fallback booking opening uses the direct visible-open hook', () => {
  const run = makeFunnel({ pathname: '/new-jersey-hub.html' });
  run.context.openBooking('cars');
  assert.equal(run.events.filter((event) => event.name === 'booking_started').length, 1);
});

test('7. Category completion emits step 1 once after committed transition', () => {
  const run = makeFunnel({ ST: { cat: 'cars', pkg: null, vehicles: [] } });
  run.context.bkGoTo(2);
  run.active = 1;
  run.context.bkGoTo(2);
  assert.equal(run.events.filter((event) => event.props.booking_step === 1).length, 1);
});

test('8. Package completion emits step 2 with opaque package_id', () => {
  const run = makeFunnel({ active: 2, ST: { cat: 'cars', pkg: { id: 'signature' }, pkgId: 'signature', vehicles: [] } });
  run.context.bkGoTo(3);
  assert.deepEqual(run.events[0].props, { booking_step: 2, category: 'cars', package_id: 'signature' });
});

test('9. Vehicle completion emits step 3 only after a valid committed vehicle', () => {
  const run = makeFunnel({ active: 3, ST: { cat: 'cars', pkg: {}, vehicles: [] } });
  run.context.bkGoTo(4);
  assert.equal(run.events.length, 0);
  run.active = 3;
  run.context.ST.vehicles.push({ vehicleLabel: 'test vehicle' });
  run.context.bkGoTo(4);
  assert.equal(run.events[0].props.booking_step, 3);
});

test('10. Info completion emits step 4 only on the validated transition to Review', () => {
  const run = makeFunnel({ active: 4, rejectTransition: 5 });
  run.context.bkGoTo(5);
  assert.equal(run.events.length, 0);
  assert.match(indexSource, /bkValidateContactPhone\(\)[\s\S]*bkValidateScheduleSelection\(\)[\s\S]*bkGoTo\(5\)/);
});

test('11. Review reached fires when Step 5 becomes active', () => {
  const run = makeFunnel({ active: 4 });
  run.context.bkGoTo(5);
  assert.equal(run.events.filter((event) => event.name === 'booking_review_reached').length, 1);
  assert.equal(run.events.find((event) => event.name === 'booking_review_reached').props.booking_step, 5);
});

test('12. Review reached does not fire first at Step 6', () => {
  const run = makeFunnel({ active: 5 });
  run.context.bkGoTo(6);
  assert.equal(run.events.length, 0);
  assert.doesNotMatch(conversionSource, /track\('booking_review_reached'/);
});

test('13. back and forward navigation does not inflate canonical stage count', () => {
  const run = makeFunnel({ active: 4 });
  run.context.bkGoTo(5);
  run.context.bkGoTo(4);
  run.context.bkGoTo(5);
  assert.equal(run.events.filter((event) => event.name === 'booking_step_completed').length, 1);
  assert.equal(run.events.filter((event) => event.name === 'booking_review_reached').length, 1);
});

test('14. failed validation/state does not emit a completion', () => {
  const run = makeFunnel({ active: 1, ST: { cat: '', pkg: null, vehicles: [] } });
  run.context.bkGoTo(2);
  assert.equal(run.events.length, 0);
});

test('15. failed submission does not emit booking_submitted', () => {
  const run = makeFunnel();
  run.context.CD1CanonicalFunnel.bookingSubmitted({ bookingCreated: false, id: 'CD1-FAILED-1' });
  run.context.CD1CanonicalFunnel.bookingSubmitted({ bookingCreated: true });
  assert.equal(run.events.length, 0);
});

test('16. successful persisted submission emits booking_submitted', () => {
  const run = makeFunnel();
  run.context.CD1CanonicalFunnel.bookingSubmitted({ bookingCreated: true, id: 'CD1-QA123-ABCD' });
  assert.equal(run.events[0].name, 'booking_submitted');
  assert.doesNotMatch(checkoutSource, /emit\('booking_submitted'/);
  assert.match(indexSource, /onBookingSubmitted\(data\)/);
  assert.match(checkoutSource, /bookingSubmitted\(response\)/);
  for (const file of fs.readdirSync(root).filter((name) => /(?:-hub|-mobile-detailing|template-city)\.html$/.test(name))) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /onBookingSubmitted\(\)/, `${file} must pass the untouched server response`);
  }
});

test('17. booking_submitted contains the opaque booking_id', () => {
  const run = makeFunnel();
  run.context.CD1CanonicalFunnel.bookingSubmitted({ bookingCreated: true, id: 'CD1-QA123-ABCD' });
  assert.deepEqual(run.events[0].props, { booking_id: 'CD1-QA123-ABCD' });
});

test('18. no customer PII enters a canonical event', () => {
  const run = makeFunnel();
  run.context.CD1CanonicalFunnel.bookingSubmitted({
    bookingCreated: true,
    id: 'CD1-QA123-ABCD',
    email: 'person@example.com',
    phone: '5555555555',
    address: '1 Test St',
  });
  assert.equal(JSON.stringify(run.events).includes('person@example.com'), false);
  assert.deepEqual(Object.keys(run.events[0].props), ['booking_id']);
});

test('19. the same anonymous session persists through a canonical journey', () => {
  const run = makeFunnel({ sessionId: 'sess_one_journey_123', ST: { cat: 'cars', pkg: {}, pkgId: 'detail', vehicles: [{}] } });
  run.context.openBooking('cars');
  run.context.bkGoTo(2);
  run.context.bkGoTo(3);
  run.context.bkGoTo(4);
  run.context.bkGoTo(5);
  run.context.showSuccess({ bookingCreated: true, id: 'CD1-QA123-ABCD' });
  assert.deepEqual(new Set(run.events.map((event) => event.session)), new Set(['sess_one_journey_123']));
});

test('20. hub iframe adopts the parent opaque session and remains joinable', () => {
  const sid = 'sess_parent_journey_123';
  const revenue = makeRevenue({ embed: true, search: `?embed=1&cd1_session=${sid}` });
  assert.equal(revenue.context.Cardetail1Revenue.getSessionId(), sid);
  assert.match(hubSource, /params\.set\('cd1_session', sid\)/);
});

test('21. PR #201 stable event-id retry state machine remains exposed', () => {
  const revenue = makeRevenue();
  const api = revenue.context.Cardetail1Revenue._deliveryTest;
  assert.equal(api.maxAttempts, 4);
  assert.deepEqual(Object.keys(api.states).sort(), ['PENDING', 'RETRYABLE_FAILURE', 'SENT', 'TERMINAL_FAILURE']);
});

test('22. analytics failure remains non-blocking for opening, transitions, and success UI', () => {
  const run = makeFunnel({ throwAnalytics: true, ST: { cat: 'cars', pkg: null, vehicles: [] } });
  assert.equal(run.context.openBooking('cars'), 'opened');
  assert.equal(run.context.bkGoTo(2), 2);
  assert.equal(run.context.showSuccess({ bookingCreated: true, id: 'CD1-QA123-ABCD' }), 'CD1-QA123-ABCD');
});

test('23. unknown schema event is still rejected', () => {
  const result = serverSchema.validateEventPayload({
    event: 'invented_funnel_event',
    event_id: 'evt_unknown',
    anonymous_session_id: 'sess_unknown_123',
  });
  assert.deepEqual(result, { ok: false, error: 'unknown_event' });
});

test('24. client/server event and property allowlists remain exactly equal', () => {
  const revenue = makeRevenue();
  const client = revenue.context.Cardetail1Revenue.getContract();
  assert.deepEqual([...client.events], [...serverSchema.APPROVED_EVENTS].sort());
  assert.deepEqual([...client.properties], [...serverSchema.APPROVED_PROPERTIES].sort());
  assert.doesNotMatch(checkoutSource, /Cardetail1Revenue\.track\(name/);
  assert.match(checkoutSource, /Cardetail1Revenue\.getSessionId\(\)/);
});

test('funnel report deduplicates by earliest session/stage and cohorts on first home receivedAt', () => {
  const events = [];
  const add = (event, session, receivedAt, properties = {}) => events.push({
    event,
    receivedAt,
    properties: { anonymous_session_id: session, ...properties },
  });
  add('page_view', 'sess_post_123', '2026-08-22T12:00:00Z', { page_type: 'home' });
  add('booking_started', 'sess_post_123', '2026-08-22T12:01:00Z');
  add('booking_started', 'sess_post_123', '2026-08-22T12:01:01Z');
  for (let step = 1; step <= 4; step += 1) {
    add('booking_step_completed', 'sess_post_123', `2026-08-22T12:0${step + 1}:00Z`, { booking_step: step });
  }
  add('booking_review_reached', 'sess_post_123', '2026-08-22T12:06:00Z', { booking_step: 5 });
  add('booking_submitted', 'sess_post_123', '2026-08-22T12:07:00Z', { booking_id: 'CD1-QA123-ABCD' });
  add('page_view', 'sess_pre_123', '2026-08-20T12:00:00Z', { page_type: 'home' });

  const report = buildBookingFunnelReport(events, { releaseAt: '2026-08-21T00:00:00Z' });
  assert.deepEqual(report.postRelease.counts, {
    home: 1, open: 1, category: 1, package: 1, vehicle: 1, info: 1, review: 1, submitted: 1,
  });
  assert.equal(report.postRelease.uniqueSubmittedBookings, 1);
  assert.equal(report.postRelease.ratesPercent.homeToSubmitted, 100);
  assert.equal(JSON.stringify(report).includes('CD1-QA123-ABCD'), false);
});

test('funnel report excludes the historical Confirm-stage Review misfire', () => {
  const report = buildBookingFunnelReport([
    {
      event: 'page_view',
      receivedAt: '2026-08-22T12:00:00Z',
      properties: { anonymous_session_id: 'sess_history_123', page_type: 'home' },
    },
    {
      event: 'booking_review_reached',
      receivedAt: '2026-08-22T12:01:00Z',
      properties: { anonymous_session_id: 'sess_history_123', funnel_step: 'confirm' },
    },
  ], { releaseAt: '2026-08-21T00:00:00Z' });
  assert.equal(report.postRelease.counts.review, 0);
});

test('invalid or sensitive-looking booking IDs are stripped by the server schema', () => {
  const validated = serverSchema.validateEventPayload({
    event: 'booking_submitted',
    event_id: 'evt_bad_booking_id',
    anonymous_session_id: 'sess_schema_123',
    properties: { booking_id: 'person@example.com', email: 'person@example.com' },
  });
  assert.equal(validated.ok, true);
  assert.equal(Object.hasOwn(validated.properties, 'booking_id'), false);
  assert.equal(Object.hasOwn(validated.properties, 'email'), false);
});

test('ZIP diagnostics expose only coarse service-area classifications', () => {
  const run = makeFunnel();
  run.context.onBkZipInput('07030');
  run.context.onBkZipInput('99999');
  assert.deepEqual(run.events.map((event) => [event.name, event.props.zip_zone]), [
    ['zip_check_started', 'service_area_check'],
    ['zip_check_valid', 'serviceable'],
    ['zip_check_rejected', 'outside_service_area'],
  ]);
  assert.equal(JSON.stringify(run.events).includes('07030'), false);
});
