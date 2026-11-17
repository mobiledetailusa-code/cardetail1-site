// AI-assistant attribution: classification, client persistence, write-time index,
// server-confirmed revenue report, admin view and page wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const ai = require('../netlify/lib/ai-attribution');
const { buildIndexEntry, indexAiEvent } = require('../netlify/lib/ai-attribution-index');
const { buildAiSearchReport } = require('../netlify/lib/ai-search-report');

// ── 1. referrer classification ────────────────────────────────────────────
test('AI referrers map to their assistant; Google and Bing search never do', () => {
  const cases = {
    'chatgpt.com': 'chatgpt', 'chat.openai.com': 'chatgpt', 'www.perplexity.ai': 'perplexity',
    'perplexity.ai': 'perplexity', 'gemini.google.com': 'gemini', 'copilot.microsoft.com': 'copilot',
    'claude.ai': 'claude', 'chat.mistral.ai': 'other_ai', 'https://chatgpt.com/c/abc': 'chatgpt',
  };
  for (const [ref, key] of Object.entries(cases)) assert.equal(ai.assistantForReferrer(ref).key, key, ref);
  for (const ref of ['www.google.com', 'google.com', 'www.bing.com', 'bing.com', 'duckduckgo.com',
    'chatgpt.com.evil.example', 'notchatgpt.com', 'microsoft.com', 'mail.google.com', '', null]) {
    assert.equal(ai.assistantForReferrer(ref), null, String(ref));
  }
});

// ── 2. UTM classification ─────────────────────────────────────────────────
test('utm_source names an assistant only on an exact match, and paid campaigns stay paid', () => {
  assert.equal(ai.classifyTouch({ utmSource: 'chatgpt.com' }).key, 'chatgpt');
  assert.equal(ai.classifyTouch({ utmSource: ' ChatGPT.com ' }).key, 'chatgpt');
  assert.equal(ai.classifyTouch({ utmSource: 'chatgpt.com' }).matchedBy, 'utm_source');
  assert.equal(ai.classifyTouch({ utmSource: 'google' }), null);
  assert.equal(ai.classifyTouch({ utmSource: 'my-chatgpt-campaign' }), null);
  assert.equal(ai.classifyTouch({ utmSource: 'chatgpt.com', utmMedium: 'cpc' }), null, 'paid medium is never relabelled');
  // A sticky older paid campaign cannot hide a newer visit that arrived from an assistant.
  assert.equal(ai.classifyTouch({ utmSource: 'google', utmMedium: 'cpc', referrer: 'www.perplexity.ai' }).key, 'perplexity');
});

test('event attribution: first and last touch are classified separately from stored fields', () => {
  const r = ai.classifyEventAttribution({
    first_utm_source: 'google', first_utm_medium: 'cpc', referrer_domain: 'www.google.com',
    utm_source: 'google', utm_medium: 'cpc', last_referrer_domain: 'perplexity.ai',
  });
  assert.equal(r.isAi, true);
  assert.equal(r.firstTouch, null);
  assert.equal(r.lastTouch.key, 'perplexity');
  assert.equal(r.sourceKey, 'perplexity');
  const none = ai.classifyEventAttribution({ referrer_domain: 'www.google.com', last_referrer_domain: 'www.google.com' });
  assert.equal(none.isAi, false, 'Google (including AI Overviews) is not AI');
  assert.equal(ai.classifyEventAttribution({}).isAi, false, 'no data, no attribution');
});

// ── parity ────────────────────────────────────────────────────────────────
test('the browser copy of the assistant table matches the server table', () => {
  const src = read('assets/revenue-events.js');
  const m = src.match(/var AI_ASSISTANTS = (\[[\s\S]*?\n {2}\]);/);
  assert.ok(m, 'AI_ASSISTANTS block not found in revenue-events.js');
  const client = vm.runInNewContext(`(${m[1]})`);
  // JSON form: the vm copy lives in another realm, so prototypes differ even when the data match.
  const strip = (list) => JSON.stringify(list.map((a) => ({ key: a.key, domains: a.domains, utmSources: a.utmSources })));
  assert.equal(strip(client), strip(ai.AI_ASSISTANTS));
});

// ── 3–5, 11: client capture ───────────────────────────────────────────────
function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()] };
}
function loadClient({ search = '', referrer = '', pathname = '/', marketing = false } = {}) {
  const fetchCalls = [];
  let n = 0;
  const location = { hostname: 'example.test', pathname, search, href: `https://example.test${pathname}` };
  const document = { referrer, readyState: 'complete', head: { appendChild() {} }, body: { appendChild() {} },
    getElementById() { return null; }, createElement() { return { setAttribute() {} }; }, addEventListener() {}, querySelectorAll() { return []; } };
  const window = {
    location, document, localStorage: storage(), sessionStorage: storage(), innerWidth: 1280, dataLayer: [],
    Cardetail1Consent: { getConsent: () => ({ analytics: true, marketing }) },
    crypto: { randomUUID: () => `uuid-${++n}` },
    console: { warn() {}, debug() {}, log() {}, info() {}, error() {} },
    setTimeout() { return 0; }, clearTimeout() {},
    fetch(url, o) { fetchCalls.push({ url: String(url), body: o && o.body ? JSON.parse(o.body) : null }); return Promise.resolve({ ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ ok: true }) }); },
    gtag() {}, Date, Math, JSON, Number, Object, Array, String, Boolean, Error, URL, Promise,
    encodeURIComponent, decodeURIComponent, isFinite: Number.isFinite, parseInt, parseFloat,
  };
  window.window = window; window.globalThis = window;
  vm.runInContext(read('assets/revenue-events.js'), vm.createContext(window));
  const props = () => fetchCalls.filter((c) => c.body && c.body.event).map((c) => c.body.properties);
  return { window, location, document, props };
}

test('client: AI referrals and ChatGPT links are ai_assistant; Google stays organic; gclid stays paid', () => {
  const t = (opts) => { const h = loadClient(opts); h.window.Cardetail1Revenue.track('page_view', { event_id: 'e1' }); return h.props()[0].traffic_type; };
  assert.equal(t({ referrer: 'https://chatgpt.com/' }), 'ai_assistant');
  assert.equal(t({ search: '?utm_source=chatgpt.com' }), 'ai_assistant');
  assert.equal(t({ referrer: 'https://www.perplexity.ai/search/x' }), 'ai_assistant');
  assert.equal(t({ referrer: 'https://gemini.google.com/app' }), 'ai_assistant', 'Gemini is no longer counted as Google organic');
  assert.equal(t({ referrer: 'https://copilot.microsoft.com/' }), 'ai_assistant');
  assert.equal(t({ referrer: 'https://claude.ai/chat/1' }), 'ai_assistant');
  assert.equal(t({ referrer: 'https://www.google.com/search?q=x' }), 'organic', 'AI Overviews are indistinguishable');
  assert.equal(t({ referrer: 'https://chatgpt.com/', search: '?gclid=G1' }), 'paid', 'Google Ads click keeps paid');
  assert.equal(t({ search: '?utm_source=newsletter&utm_medium=email' }), 'referral');
  assert.equal(t({}), 'direct');
});

test('client: a returning AI referral without UTM becomes the last touch; first touch is kept', () => {
  const h = loadClient({ referrer: 'https://www.google.com/search', pathname: '/ceramic' });
  h.window.Cardetail1Revenue.track('page_view', { event_id: 'v1' });
  h.document.referrer = 'https://www.perplexity.ai/search/abc';
  h.location.pathname = '/fort-lee-mobile-detailing';
  h.window.Cardetail1Revenue.track('page_view', { event_id: 'v2' });
  const p = h.props()[1];
  assert.equal(p.referrer_domain, 'www.google.com', 'first referrer unchanged');
  assert.equal(p.landing_page, '/ceramic', 'first landing page unchanged');
  assert.equal(p.last_referrer_domain, 'www.perplexity.ai');
  assert.equal(p.last_landing_page, '/fort-lee-mobile-detailing');
  assert.equal(p.traffic_type, 'ai_assistant');
});

test('client: a later direct or ordinary visit does not overwrite the AI last touch', () => {
  const h = loadClient({ referrer: 'https://chatgpt.com/', pathname: '/' });
  h.window.Cardetail1Revenue.track('page_view', { event_id: 'a1' });
  h.document.referrer = '';
  h.window.Cardetail1Revenue.track('page_view', { event_id: 'a2' });
  h.document.referrer = 'https://news.example/article';
  h.window.Cardetail1Revenue.track('page_view', { event_id: 'a3' });
  const [, direct, other] = h.props();
  assert.equal(direct.last_referrer_domain, 'chatgpt.com');
  assert.equal(other.last_referrer_domain, 'chatgpt.com', 'non-AI referral without a campaign keeps the stored touch (existing rule)');
});

test('client: missing referrer and campaign data produce no AI attribution', () => {
  const h = loadClient({});
  h.window.Cardetail1Revenue.track('page_view', { event_id: 'm1' });
  const p = h.props()[0];
  assert.equal(p.traffic_type, 'direct');
  assert.equal(p.referrer_domain, undefined);
  assert.equal(ai.classifyEventAttribution(p).isAi, false);
});

test('client: consent rules for click IDs are unchanged and no new storage keys appear', () => {
  const h = loadClient({ referrer: 'https://chatgpt.com/', search: '?utm_source=chatgpt.com&fbclid=FB1&gclid=G1', marketing: false });
  h.window.Cardetail1Revenue.track('page_view', { event_id: 'c1' });
  const stored = JSON.parse(h.window.localStorage.getItem('cd1_rev_attr'));
  assert.equal(stored.gclid, null);
  assert.equal(stored.fbclid, null);
  assert.equal(h.props()[0].gclid, undefined);
  assert.deepEqual(h.window.localStorage.keys().sort(), ['cd1_rev_attr']);
});

// ── index ─────────────────────────────────────────────────────────────────
const aiProps = (extra = {}) => ({ anonymous_session_id: 'sess-1', referrer_domain: 'chatgpt.com', last_referrer_domain: 'chatgpt.com', ...extra });

test('index entries carry attribution only, and only for AI funnel events', () => {
  assert.equal(buildIndexEntry({ event: 'page_view', properties: { referrer_domain: 'www.google.com' } }, 'e', '2026-11-17/e'), null);
  assert.equal(buildIndexEntry({ event: 'click_call', properties: aiProps() }, 'e', '2026-11-17/e'), null);
  const entry = buildIndexEntry({ event: 'booking_submitted', receivedAt: '2026-11-17T10:00:00Z',
    properties: aiProps({ booking_reference: 'cd1-abc123-xyz9', email: 'x@y.z', gclid: 'G', estimated_value: 9999 }) }, 'evt-9', '2026-11-17/evt-9');
  assert.equal(entry.bookingReference, 'CD1-ABC123-XYZ9');
  assert.equal(entry.sourceKey, 'chatgpt');
  const text = JSON.stringify(entry);
  assert.doesNotMatch(text, /x@y\.z|gclid|9999|estimated_value/, 'no PII, click ids or browser amounts');
  assert.equal(buildIndexEntry({ event: 'booking_submitted', properties: aiProps({ booking_reference: 'not-a-ref' }) }, 'e', '2026-11-17/e').bookingReference, null);
});

function memoryDeps() {
  const stores = {};
  return {
    stores,
    getStore: async (name) => { stores[name] = stores[name] || new Map(); return { name }; },
    create: async (store, key, value) => {
      const m = stores[store.name];
      if (m.has(key)) return { created: false };
      m.set(key, value);
      return { created: true };
    },
  };
}

test('index writes are create-only: retries and duplicate posts never add rows; first booking row wins', async () => {
  const deps = memoryDeps();
  const rec = { event: 'booking_submitted', receivedAt: '2026-11-17T10:00:00Z', properties: aiProps({ booking_reference: 'CD1-AAAA-0001' }) };
  await indexAiEvent(rec, 'evt-1', '2026-11-17/evt-1', deps);
  await indexAiEvent(rec, 'evt-1', '2026-11-17/evt-1', deps);
  const forged = { ...rec, properties: aiProps({ booking_reference: 'CD1-AAAA-0001', referrer_domain: 'claude.ai', last_referrer_domain: 'claude.ai' }) };
  await indexAiEvent(forged, 'evt-2', '2026-11-17/evt-2', deps);
  const idx = deps.stores.aiIndex;
  assert.equal(idx.get('booking/CD1-AAAA-0001').sourceKey, 'chatgpt', 'a later post cannot relabel a booking');
  assert.equal([...idx.keys()].filter((k) => k.startsWith('2026-11-17/')).length, 2);
});

test('index failures never throw into event ingestion', async () => {
  const r = await indexAiEvent({ event: 'page_view', properties: aiProps() }, 'e', '2026-11-17/e', {
    getStore: async () => { throw new Error('blob down'); }, create: async () => ({ created: true }),
  });
  assert.equal(r.indexed, false);
});

test('revenue-event handler: AI page views are indexed once; non-AI events touch no index store', async () => {
  const rl = require('../netlify/lib/public-rate-limit');
  const rs = require('../netlify/lib/revenue-store');
  const orig = { rate: rl.enforcePublicRateLimit, get: rs.getRevenueStore, strict: rs.blobGetJsonStrict, create: rs.blobCreateJson };
  const stores = {};
  rl.enforcePublicRateLimit = async () => ({ blocked: false, allowed: true });
  rs.getRevenueStore = async (name) => { stores[name] = stores[name] || new Map(); return { name }; };
  rs.blobGetJsonStrict = async (s, k) => stores[s.name].get(k) || null;
  rs.blobCreateJson = async (s, k, v) => { if (stores[s.name].has(k)) return { created: false }; stores[s.name].set(k, v); return { created: true }; };
  const p = require.resolve('../netlify/functions/revenue-event');
  delete require.cache[p];
  const { handler } = require(p);
  Object.assign(rl, { enforcePublicRateLimit: orig.rate });
  Object.assign(rs, { getRevenueStore: orig.get, blobGetJsonStrict: orig.strict, blobCreateJson: orig.create });
  delete process.env.CONTEXT;
  const post = (body) => handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.7' }, body: JSON.stringify(body) });
  try {
    const plain = await post({ event: 'page_view', event_id: 'evt-plain', anonymous_session_id: 's1', properties: { referrer_domain: 'www.google.com' } });
    assert.equal(plain.statusCode, 200);
    assert.equal(stores.aiIndex, undefined, 'no index store opened for non-AI traffic');
    const body = { event: 'page_view', event_id: 'evt-ai', anonymous_session_id: 's2', properties: { referrer_domain: 'chatgpt.com', last_referrer_domain: 'chatgpt.com' } };
    assert.equal((await post(body)).statusCode, 200);
    assert.equal(JSON.parse((await post(body)).body).duplicate, true, 'replay is still a duplicate');
    const rows = [...stores.aiIndex.keys()].filter((k) => /^\d{4}-/.test(k));
    assert.equal(rows.length, 1);
    assert.equal(stores.events.size, 2, 'event store unchanged in shape: one row per event');
  } finally {
    delete require.cache[p];
  }
});

// ── 8–10: report ──────────────────────────────────────────────────────────
function reportDeps(data) {
  const stores = { aiIndex: data.ai || {}, events: data.events || {} };
  return {
    getStore: async (name) => ({ name }),
    listKeys: async (store, { prefix }) => Object.keys(stores[store.name]).filter((k) => k.startsWith(prefix)),
    getJson: async (store, key) => (key in stores[store.name] ? JSON.parse(JSON.stringify(stores[store.name][key])) : null),
  };
}
const RANGE = { from: '2026-11-10T00:00:00.000Z', to: '2026-11-17T23:00:00.000Z', fromDay: '2026-11-10', toDay: '2026-11-17' };
const row = (event, sourceKey, extra = {}) => ({ v: 1, event, sourceKey, sessionId: 's', ...extra });
const confirm = (ref, value, at, extra = {}) => ({ event: 'booking_confirmed', receivedAt: at,
  properties: { event_origin: 'server_confirm', booking_reference: ref, timestamp: at, ...(value === undefined ? { error_code: 'amount_unavailable' } : { estimated_value: value }), ...extra } });

test('report: counts are deduplicated and revenue comes only from server confirmations', async () => {
  const deps = reportDeps({
    ai: {
      'meta/coverage-start': { startedAt: '2026-11-01T00:00:00Z' },
      '2026-11-12/p1': row('page_view', 'chatgpt', { sessionId: 'A' }),
      '2026-11-12/p2': row('city_page_view', 'chatgpt', { sessionId: 'A' }),
      '2026-11-13/p3': row('page_view', 'perplexity', { sessionId: 'B' }),
      '2026-11-13/s1': row('booking_started', 'chatgpt', { sessionId: 'A' }),
      '2026-11-13/b1': row('booking_submitted', 'chatgpt', { sessionId: 'A', bookingReference: 'CD1-AAAA-0001' }),
      '2026-11-13/b2': row('booking_submitted', 'chatgpt', { sessionId: 'A', bookingReference: 'CD1-AAAA-0001' }),
      'booking/CD1-AAAA-0001': row('booking_submitted', 'chatgpt', { bookingReference: 'CD1-AAAA-0001', estimated_value: 9999 }),
      'booking/CD1-BBBB-0002': row('booking_submitted', 'perplexity', { bookingReference: 'CD1-BBBB-0002' }),
    },
    events: {
      '2026-11-14/confirmed:CD1-AAAA-0001:t1': confirm('CD1-AAAA-0001', 250, '2026-11-14T10:00:00Z'),
      '2026-11-15/confirmed:CD1-AAAA-0001:t2': confirm('CD1-AAAA-0001', 285, '2026-11-15T10:00:00Z'),
      '2026-11-15/confirmed:CD1-BBBB-0002:t1': confirm('CD1-BBBB-0002', undefined, '2026-11-15T11:00:00Z'),
      '2026-11-15/confirmed:CD1-CCCC-0003:t1': confirm('CD1-CCCC-0003', 400, '2026-11-15T12:00:00Z'),
      '2026-11-15/confirmed:CD1-DDDD-0004:t1': { event: 'booking_confirmed', properties: { booking_reference: 'CD1-DDDD-0004', estimated_value: 5000 } },
      '2026-11-15/confirmed:CD1-EEEE-0005:t1': { ...confirm('CD1-EEEE-0005', 700, '2026-11-15T12:00:00Z'), qaFixture: true },
    },
  });
  const r = await buildAiSearchReport(RANGE, deps);
  const chat = r.sources.find((s) => s.key === 'chatgpt');
  const perp = r.sources.find((s) => s.key === 'perplexity');
  assert.equal(chat.visits, 1, 'two page views in one session are one visit');
  assert.equal(chat.bookingStarts, 1);
  assert.equal(chat.bookingSubmissions, 1, 'duplicate submission rows count once');
  assert.equal(chat.confirmedBookings, 1, 're-confirmation counts once');
  assert.equal(chat.confirmedValue, 285, 'latest server amount, never the browser estimate');
  assert.equal(perp.confirmedBookings, 1);
  assert.equal(perp.confirmedMissingAmount, 1);
  assert.equal(perp.confirmedValue, 0);
  assert.equal(r.totals.confirmedValue, 285);
  assert.equal(r.totals.averageConfirmedValue, 285, 'average excludes bookings without an amount');
  assert.equal(r.allConfirmedBookingsInRange, 3, 'unverified and QA confirmations are ignored');
  assert.equal(r.confirmedWithoutAiRecord, 1);
  assert.equal(r.totals.submissionRate, 0.5);
  assert.equal(r.complete, true);
});

test('report: no data means zeros with null rates and an explicit missing coverage start', async () => {
  const r = await buildAiSearchReport(RANGE, reportDeps({}));
  assert.equal(r.coverageStart, null);
  assert.equal(r.complete, false);
  assert.equal(r.totals.visits, 0);
  assert.equal(r.totals.submissionRate, null);
  assert.equal(r.totals.averageConfirmedValue, null);
  assert.equal(r.sources.length, 6);
});

test('report: a range that starts before tracking began is marked partial', async () => {
  const r = await buildAiSearchReport(RANGE, reportDeps({ ai: { 'meta/coverage-start': { startedAt: '2026-11-15T00:00:00Z' } } }));
  assert.equal(r.complete, false);
});

// ── 12: authorization ─────────────────────────────────────────────────────
test('the ai-search view is behind the existing admin gate', async () => {
  const { handler } = require('../netlify/functions/revenue-admin');
  const res = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { view: 'ai-search' } });
  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(read('netlify/functions/revenue-admin.js'), /view === 'ai-search'[\s\S]{0,40}verifyAdminRequest/, 'view is evaluated only after auth');
  const src = read('netlify/functions/revenue-admin.js');
  assert.ok(src.indexOf("view === 'ai-search'") > src.indexOf('verifyAdminRequest(event.headers'));
});

// ── page wiring ───────────────────────────────────────────────────────────
test('admin-ops renders the AI card without redefining existing helpers', () => {
  const html = read('admin-ops.html');
  assert.match(html, /id="revopsAi"/);
  assert.match(html, /revenue-admin\?view=ai-search/);
  assert.equal((html.match(/function money\(/g) || []).length, 1, 'existing money(cents) is not shadowed');
  assert.match(html, /cannot be told apart from other traffic/);
});
