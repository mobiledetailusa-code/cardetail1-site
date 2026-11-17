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
const { buildIndexRows, indexAiEvent } = require('../netlify/lib/ai-attribution-index');
const { buildAiSearchReport, classifyBooking, referenceCreatedMs, strictListKeys } = require('../netlify/lib/ai-search-report');

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

test('client: a paid visitor returning through an AI assistant keeps the paid last touch', () => {
  // Paid campaign (sticky utm_medium=cpc), then a later Perplexity visit with no UTMs.
  const h = loadClient({ search: '?utm_source=google&utm_medium=cpc&utm_campaign=detail', referrer: 'https://www.google.com/' });
  h.window.Cardetail1Revenue.track('page_view', { event_id: 'pd1' });
  h.location.search = '';
  h.document.referrer = 'https://www.perplexity.ai/search/x';
  h.window.Cardetail1Revenue.track('page_view', { event_id: 'pd2' });
  const p = h.props()[1];
  assert.equal(p.traffic_type, 'paid', 'paid traffic label unchanged');
  assert.equal(p.utm_medium, 'cpc');
  assert.notEqual(p.last_referrer_domain, 'www.perplexity.ai', 'an AI return never overwrites a paid touch');
  // Google Ads click ID (marketing consent) followed by a ChatGPT return: same rule.
  const g = loadClient({ search: '?gclid=G1', marketing: true });
  g.window.Cardetail1Revenue.track('page_view', { event_id: 'gd1' });
  g.location.search = '';
  g.document.referrer = 'https://chatgpt.com/';
  g.window.Cardetail1Revenue.track('page_view', { event_id: 'gd2' });
  const q = g.props()[1];
  assert.equal(q.traffic_type, 'paid');
  assert.notEqual(q.last_referrer_domain, 'chatgpt.com');
  assert.equal(JSON.parse(g.window.localStorage.getItem('cd1_rev_attr')).gclid, 'G1', 'stored click ID untouched');
});

test('server paid signal: paid medium (latest or first) or the browser paid label', () => {
  assert.equal(ai.hasPaidSignal({ utm_medium: 'CPC' }), true);
  assert.equal(ai.hasPaidSignal({ first_utm_medium: 'paid_social' }), true, 'Meta paid social');
  assert.equal(ai.hasPaidSignal({ traffic_type: 'paid' }), true, 'gclid-only Google Ads (click IDs never reach the server)');
  assert.equal(ai.hasPaidSignal({ utm_medium: 'organic', traffic_type: 'ai_assistant' }), false);
  const r = ai.classifyEventAttribution({ traffic_type: 'paid', last_referrer_domain: 'chatgpt.com' });
  assert.equal(r.paidSignal, true);
  assert.equal(ai.classifyEventAttribution({ traffic_type: 'ai_assistant' }).isAi, false, 'a forged label alone is not AI');
});

// ── index ─────────────────────────────────────────────────────────────────
const aiProps = (extra = {}) => ({ anonymous_session_id: 'sess-1', referrer_domain: 'chatgpt.com', last_referrer_domain: 'chatgpt.com', ...extra });
const refAt = (iso, tail = 'AB12') => `CD1-${Date.parse(iso).toString(36).toUpperCase()}-${tail}`;

test('index rows carry attribution only; every booking submission gets a booking row', () => {
  assert.equal(buildIndexRows({ event: 'page_view', properties: { referrer_domain: 'www.google.com' } }, 'e', '2026-11-17/e'), null);
  assert.equal(buildIndexRows({ event: 'click_call', properties: aiProps() }, 'e', '2026-11-17/e'), null);
  const ref = refAt('2026-11-17T09:59:00Z');
  const built = buildIndexRows({ event: 'booking_submitted', receivedAt: '2026-11-17T10:00:00Z',
    properties: aiProps({ booking_reference: ref.toLowerCase(), email: 'x@y.z', gclid: 'G', estimated_value: 9999 }) }, 'evt-9', '2026-11-17/evt-9');
  assert.deepEqual(built.rows.map((r) => r.key), ['2026-11-17/evt-9', `booking/${ref}/evt-9`]);
  assert.equal(built.rows[1].value.sourceKey, 'chatgpt');
  assert.doesNotMatch(JSON.stringify(built), /x@y\.z|gclid|9999|estimated_value/, 'no PII, click ids or browser amounts');
  // Non-AI submissions are recorded on the booking only, so conflicting claims are visible.
  const plain = buildIndexRows({ event: 'booking_submitted', receivedAt: '2026-11-17T10:00:00Z',
    properties: { anonymous_session_id: 's9', referrer_domain: 'www.google.com', booking_reference: ref } }, 'evt-p', '2026-11-17/evt-p');
  assert.deepEqual(plain.rows.map((r) => r.key), [`booking/${ref}/evt-p`]);
  assert.equal(plain.rows[0].value.sourceKey, null);
  // Unreliable session ids are not sessions.
  const fb = buildIndexRows({ event: 'page_view', properties: aiProps({ anonymous_session_id: 'sess_fallback' }) }, 'f', '2026-11-17/f');
  assert.equal(fb.rows[0].value.sessionId, null);
});

function memoryDeps({ failCreate } = {}) {
  const stores = {};
  return {
    stores,
    getStore: async (name) => { stores[name] = stores[name] || new Map(); return { name }; },
    create: async (store, key, value) => {
      if (failCreate && failCreate(key)) throw new Error('blob write failed');
      const m = stores[store.name];
      if (m.has(key)) return { created: false };
      m.set(key, value);
      return { created: true };
    },
  };
}

test('index writes are create-only: retries and duplicate posts never add rows', async () => {
  const deps = memoryDeps();
  const ref = refAt('2026-11-17T09:59:00Z');
  const rec = { event: 'booking_submitted', receivedAt: '2026-11-17T10:00:00Z', properties: aiProps({ booking_reference: ref }) };
  await indexAiEvent(rec, 'evt-1', '2026-11-17/evt-1', deps);
  await indexAiEvent(rec, 'evt-1', '2026-11-17/evt-1', deps);
  const keys = [...deps.stores.aiIndex.keys()].sort();
  assert.deepEqual(keys, ['2026-11-17/evt-1', `booking/${ref}/evt-1`, 'meta/coverage-start'].sort());
});

test('failed index writes leave a failure marker and never throw into ingestion', async () => {
  const deps = memoryDeps({ failCreate: (k) => k.startsWith('booking/') });
  const ref = refAt('2026-11-17T09:59:00Z');
  const r = await indexAiEvent({ event: 'booking_submitted', receivedAt: '2026-11-17T10:00:00Z', properties: aiProps({ booking_reference: ref }) },
    'evt-f', '2026-11-17/evt-f', deps);
  assert.equal(r.indexed, false);
  assert.deepEqual(deps.stores.aiIndex.get('meta/write-failure/2026-11-17/evt-f').keys, [`booking/${ref}/evt-f`]);
  const down = await indexAiEvent({ event: 'page_view', properties: aiProps() }, 'e', '2026-11-17/e', {
    getStore: async () => { throw new Error('blob down'); }, create: async () => ({ created: true }),
  });
  assert.equal(down.indexed, false);
});

test('revenue-event handler: AI page views indexed once; non-AI views touch no index; previews write nothing', async () => {
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
  const prevCtx = process.env.CONTEXT;
  delete process.env.CONTEXT;
  const post = (body) => handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.7' }, body: JSON.stringify(body) });
  try {
    const plain = await post({ event: 'page_view', event_id: 'evt-plain', anonymous_session_id: 's1', properties: { referrer_domain: 'www.google.com' } });
    assert.equal(plain.statusCode, 200);
    assert.equal(stores.aiIndex, undefined, 'no index store opened for non-AI traffic');
    const body = { event: 'page_view', event_id: 'evt-ai', anonymous_session_id: 's2', properties: { referrer_domain: 'chatgpt.com', last_referrer_domain: 'chatgpt.com' } };
    assert.equal((await post(body)).statusCode, 200);
    assert.equal(JSON.parse((await post(body)).body).duplicate, true, 'replay is still a duplicate');
    assert.equal([...stores.aiIndex.keys()].filter((k) => /^\d{4}-/.test(k)).length, 1);
    assert.equal(stores.events.size, 2, 'event store unchanged in shape: one row per event');

    // Preview and branch deploys share the production store: refused before any store is opened.
    for (const k of Object.keys(stores)) delete stores[k];
    process.env.CONTEXT = 'deploy-preview';
    const preview = await post({ ...body, event_id: 'evt-preview' });
    assert.notEqual(preview.statusCode, 200);
    assert.equal(JSON.parse(preview.body).error, 'preview_writes_disabled');
    assert.deepEqual(Object.keys(stores), [], 'no event or index store opened from a preview');
  } finally {
    if (prevCtx === undefined) delete process.env.CONTEXT; else process.env.CONTEXT = prevCtx;
    delete require.cache[p];
  }
});

// ── report ────────────────────────────────────────────────────────────────
// In-memory Netlify-like stores: paginated list() and fault injection.
function reportDeps(data, faults = {}) {
  const stores = { aiIndex: data.ai || {}, events: data.events || {} };
  const store = (name) => ({
    name,
    list({ prefix }) {
      if (faults.list && faults.list(name, prefix)) return (async function* () { throw new Error('list failed'); })();
      const keys = Object.keys(stores[name]).filter((k) => k.startsWith(prefix)).sort();
      return (async function* () { for (let i = 0; i < keys.length; i += 3) yield { blobs: keys.slice(i, i + 3).map((key) => ({ key })) }; })();
    },
  });
  return {
    stores,
    getStore: async (name) => { if (faults.store) throw new Error('store down'); return store(name); },
    getJson: async (s, key) => {
      if (faults.get && faults.get(s.name, key)) throw new Error('read failed');
      return key in stores[s.name] ? JSON.parse(JSON.stringify(stores[s.name][key])) : null;
    },
  };
}
const RANGE = { from: '2026-11-10T00:00:00.000Z', to: '2026-11-17T23:00:00.000Z', fromDay: '2026-11-10', toDay: '2026-11-17' };
const COVERED = { 'meta/coverage-start': { startedAt: '2026-11-01T00:00:00Z' } };
const at = (day, hh = '10') => `${day}T${hh}:00:00.000Z`;
function irow(event, day, opts = {}) {
  const src = opts.source === undefined ? 'chatgpt' : opts.source;
  const touch = src ? { key: src, matchedBy: 'referrer', value: `${src}.example` } : null;
  return { v: 2, event, eventId: opts.id || 'x', day, receivedAt: opts.receivedAt || at(day), sessionId: opts.session === undefined ? 'A' : opts.session,
    sourceKey: src, firstTouch: opts.first === undefined ? touch : opts.first, lastTouch: opts.last === undefined ? touch : opts.last,
    paidSignal: !!opts.paid, bookingReference: opts.ref || null };
}
const confirm = (ref, value, when, extra = {}) => ({ event: 'booking_confirmed', receivedAt: when,
  properties: { event_origin: 'server_confirm', booking_reference: ref, timestamp: when, ...(value === undefined ? { error_code: 'amount_unavailable' } : { estimated_value: value }), ...extra } });
// A booking_submitted on `day` at 10:00; AI rows also get a day row, like the real index.
function booking(ai, ref, day, opts = {}) {
  const id = opts.id || `sub-${ref}`;
  const r = irow('booking_submitted', day, { ...opts, id, ref });
  if (r.sourceKey) ai[`${day}/${id}`] = r;
  ai[`booking/${ref}/${id}`] = r;
}

function baseData() {
  const ai = { ...COVERED };
  ai['2026-11-12/p1'] = irow('page_view', '2026-11-12', { session: 'A' });
  ai['2026-11-12/p2'] = irow('city_page_view', '2026-11-12', { session: 'A' });
  ai['2026-11-12/p3'] = irow('page_view', '2026-11-12', { session: 'A' }); // reload: same session
  ai['2026-11-13/p4'] = irow('page_view', '2026-11-13', { session: 'B', source: 'perplexity' });
  const R1 = refAt(at('2026-11-13', '09'), 'AA01');
  const R2 = refAt(at('2026-11-13', '09'), 'BB02');
  booking(ai, R1, '2026-11-13', { session: 'A', id: 'b1' });
  booking(ai, R1, '2026-11-13', { session: 'A', id: 'b2' }); // duplicate submission
  booking(ai, R2, '2026-11-13', { session: 'B', source: 'perplexity', id: 'b3' });
  const events = {
    '2026-11-14/confirmed:R1:t1': confirm(R1, 250, at('2026-11-14')),
    '2026-11-15/confirmed:R1:t2': confirm(R1, 285, at('2026-11-15')),
    '2026-11-15/confirmed:R2:t1': confirm(R2, undefined, at('2026-11-15', '11')),
    '2026-11-15/confirmed:C:t1': confirm(refAt(at('2026-11-01'), 'CC03'), 400, at('2026-11-15', '12')),
    '2026-11-15/confirmed:D:t1': { event: 'booking_confirmed', properties: { booking_reference: R1, estimated_value: 5000 } },
    '2026-11-15/confirmed:E:t1': { ...confirm(R2, 700, at('2026-11-15', '13')), qaFixture: true },
  };
  return { ai, events, R1, R2 };
}

test('report: sessions, submissions and confirmations are deduplicated; revenue is server-confirmed only', async () => {
  const { ai, events } = baseData();
  const deps = reportDeps({ ai, events });
  const r = await buildAiSearchReport(RANGE, deps);
  const chat = r.sources.find((s) => s.key === 'chatgpt');
  const perp = r.sources.find((s) => s.key === 'perplexity');
  assert.equal(r.status, 'complete');
  assert.equal(chat.latestReferralSessions, 1, 'three page views and a reload in one session are one session');
  assert.equal(chat.bookingSubmissions, 1, 'duplicate submission events count once');
  assert.equal(chat.confirmedBookings, 1, 're-confirmation counts once');
  assert.equal(chat.approvedValue, 285, 'latest server amount; browser 5000 and QA 700 ignored');
  assert.equal(perp.confirmedBookings, 1);
  assert.equal(perp.confirmedMissingAmount, 1);
  assert.equal(r.totals.aiSessions, 2);
  assert.equal(r.totals.approvedValue, 285);
  assert.equal(r.totals.averageApprovedValue, 285, 'average excludes bookings without an amount');
  assert.equal(r.confirmations.allServerConfirmedInRange, 3, 'unverified and QA confirmations are ignored');
  assert.equal(r.confirmations.withoutAttributionRecord, 1, 'missing attribution is never assigned to AI');
  assert.equal(r.totals.submissionRate, 1);
  const again = await buildAiSearchReport(RANGE, deps);
  assert.deepEqual(again, r, 'repeated queries do not change totals');
});

test('report: first-touch and latest-referral sessions are separate and totals are deduplicated', async () => {
  const ai = { ...COVERED };
  const chat = { key: 'chatgpt', matchedBy: 'referrer', value: 'chatgpt.com' };
  const claude = { key: 'claude', matchedBy: 'referrer', value: 'claude.ai' };
  ai['2026-11-12/a'] = irow('page_view', '2026-11-12', { session: 'S1', first: chat, last: null }); // acquired via ChatGPT, now direct
  ai['2026-11-12/b'] = irow('page_view', '2026-11-12', { session: 'S2', source: 'claude', first: chat, last: claude });
  ai['2026-11-12/c'] = irow('page_view', '2026-11-12', { session: null }); // no reliable session
  const r = await buildAiSearchReport(RANGE, reportDeps({ ai }));
  const c = r.sources.find((s) => s.key === 'chatgpt');
  const cl = r.sources.find((s) => s.key === 'claude');
  assert.equal(c.firstAcquiredSessions, 2);
  assert.equal(c.latestReferralSessions, 0);
  assert.equal(cl.latestReferralSessions, 1);
  assert.equal(r.totals.aiSessions, 2, 'a session under two assistants is counted once in totals');
  assert.equal(r.totals.firstAcquiredSessions, 2);
  assert.equal(r.totals.latestReferralSessions, 1);
  assert.equal(r.excluded.aiEventsWithoutSession, 1, 'events without a reliable session are not merged into one');
});

test('report: paid campaign + AI touch is paid + AI-assisted, never AI revenue', async () => {
  const ai = { ...COVERED };
  const R = refAt(at('2026-11-13', '09'), 'PA01');
  ai['2026-11-13/p'] = irow('page_view', '2026-11-13', { session: 'P', paid: true });
  booking(ai, R, '2026-11-13', { session: 'P', paid: true });
  const events = { '2026-11-14/confirmed:R:t': confirm(R, 300, at('2026-11-14')) };
  const r = await buildAiSearchReport(RANGE, reportDeps({ ai, events }));
  assert.equal(r.totals.aiSessions, 0);
  assert.equal(r.totals.bookingSubmissions, 0);
  assert.equal(r.totals.confirmedBookings, 0);
  assert.equal(r.totals.approvedValue, 0);
  assert.equal(r.excluded.paidAssistedSessions, 1);
  assert.equal(r.excluded.paidAssistedConfirmed, 1);
  assert.equal(r.excluded.paidAssistedApprovedValue, 300);
});

test('report: conflicting or forged booking attribution is excluded from AI totals', async () => {
  const day = '2026-11-13';
  const cases = {
    // An attacker claims a real booking for Claude; the customer's own event says ChatGPT.
    'two sessions claim one booking': (ai, R) => { booking(ai, R, day, { session: 'A', id: 'x1' }); booking(ai, R, day, { session: 'ATK', source: 'claude', id: 'x2' }); },
    // Forged AI claim against a booking whose real submission was not AI.
    'AI claim vs non-AI submission': (ai, R) => { booking(ai, R, day, { session: 'A', source: null, id: 'y1' }); booking(ai, R, day, { session: 'ATK', id: 'y2' }); },
    // One session reporting two assistants.
    'one session, two assistants': (ai, R) => { booking(ai, R, day, { session: 'A', id: 'z1' }); booking(ai, R, day, { session: 'A', source: 'claude', id: 'z2' }); },
    // A claim posted days after the reference was created.
    'late claim outside the submission window': (ai, R) => { booking(ai, R, '2026-11-16', { session: 'ATK' }); },
    // A reference without a creation time cannot be bound.
    'unparseable reference': (ai) => { booking(ai, 'CD1-E2E-TEST', day, { session: 'A' }); },
    // A submission with no reliable session id.
    'no reliable session': (ai, R) => { booking(ai, R, day, { session: null }); },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const ai = { ...COVERED };
    const R = refAt(at(day, '09'), 'FG01');
    setup(ai, R);
    const ref = name === 'unparseable reference' ? 'CD1-E2E-TEST' : R;
    const events = { '2026-11-14/confirmed:F:t': confirm(ref, 500, at('2026-11-14')) };
    const r = await buildAiSearchReport(RANGE, reportDeps({ ai, events }));
    assert.equal(r.totals.confirmedBookings, 0, name);
    assert.equal(r.totals.approvedValue, 0, name);
    assert.equal(r.excluded.unverifiableConfirmed, 1, name);
    assert.equal(r.sources.reduce((n, s) => n + s.bookingSubmissions, 0), 0, name);
  }
});

test('report: one booking is never counted under two assistants', async () => {
  const ai = { ...COVERED };
  const R = refAt(at('2026-11-13', '09'), 'MA01');
  const chat = { key: 'chatgpt', matchedBy: 'referrer', value: 'chatgpt.com' };
  const perp = { key: 'perplexity', matchedBy: 'referrer', value: 'perplexity.ai' };
  // First touch ChatGPT, latest referral Perplexity: one source (latest), one booking.
  booking(ai, R, '2026-11-13', { session: 'A', source: 'perplexity', first: chat, last: perp });
  const events = { '2026-11-14/confirmed:R:t': confirm(R, 320, at('2026-11-14')) };
  const r = await buildAiSearchReport(RANGE, reportDeps({ ai, events }));
  assert.equal(r.totals.confirmedBookings, 1);
  assert.equal(r.totals.bookingSubmissions, 1);
  assert.equal(r.totals.approvedValue, 320);
  assert.deepEqual(r.sources.filter((s) => s.confirmedBookings).map((s) => s.key), ['perplexity']);
});

test('report: storage failures never become complete zeros', async () => {
  const { ai, events } = baseData();
  const fail = [
    ['index listing fails', { list: (n, p) => n === 'aiIndex' && /^\d{4}-/.test(p) }],
    ['confirmation listing fails', { list: (n) => n === 'events' }],
    ['index row read fails', { get: (n, k) => n === 'aiIndex' && /^2026-11-12\//.test(k) }],
    ['confirmation read fails', { get: (n) => n === 'events' }],
    ['booking rows unreadable', { get: (n, k) => n === 'aiIndex' && k.startsWith('booking/') }],
    ['booking rows unlistable', { list: (n, p) => n === 'aiIndex' && p.startsWith('booking/') }],
  ];
  for (const [name, faults] of fail) {
    const r = await buildAiSearchReport(RANGE, reportDeps({ ai, events }, faults));
    assert.equal(r.status, 'partial', name);
    assert.equal(r.complete, false, name);
    assert.equal(r.lowerBound, true, name);
    assert.ok(r.warnings.length > 0, name);
    assert.equal(r.totals.submissionRate, null, `${name}: no rates on incomplete data`);
  }
  for (const faults of [{ store: true }, { get: (n, k) => k === 'meta/coverage-start' }]) {
    const r = await buildAiSearchReport(RANGE, reportDeps({ ai, events }, faults));
    assert.equal(r.status, 'unavailable');
    assert.equal(r.totals, null, 'unavailable data has no numbers at all');
  }
});

test('report: unhealed index-write failures mark the range partial; healed ones do not', async () => {
  const { ai, events, R1 } = baseData();
  const r1 = await buildAiSearchReport(RANGE, reportDeps({ ai: { ...ai, 'meta/write-failure/2026-11-13/lost': { keys: ['2026-11-13/lost'] } }, events }));
  assert.equal(r1.status, 'partial');
  assert.ok(r1.warnings.includes('index_write_failures'));
  const r2 = await buildAiSearchReport(RANGE, reportDeps({ ai: { ...ai, 'meta/write-failure/2026-11-13/b1': { keys: [`booking/${R1}/b1`] } }, events }));
  assert.equal(r2.status, 'complete', 'a retried write that later succeeded is healed');
});

test('report: truncated listings are partial, and the strict lister reports its cap', async () => {
  const { ai, events } = baseData();
  const deps = reportDeps({ ai, events });
  const r = await buildAiSearchReport(RANGE, { ...deps, listKeys: async (store, prefix, cap) => {
    const res = await strictListKeys(store, prefix, cap);
    return /^2026-11-12\//.test(prefix) ? { keys: res.keys.slice(0, 1), truncated: true } : res;
  } });
  assert.equal(r.status, 'partial');
  assert.equal(r.truncated, true);
  const big = {};
  for (let i = 0; i < 7; i += 1) big[`2026-11-12/k${i}`] = 1;
  const s = reportDeps({ ai: big });
  const listed = await strictListKeys(await s.getStore('aiIndex'), '2026-11-12/', 5);
  assert.equal(listed.truncated, true);
  assert.equal(listed.keys.length, 5);
  await assert.rejects(strictListKeys({ list() { return (async function* () { throw new Error('x'); })(); } }, '', 5), 'errors propagate');
});

test('report: no tracking yet is "not_started"; a range before tracking began is partial', async () => {
  const none = await buildAiSearchReport(RANGE, reportDeps({}));
  assert.equal(none.status, 'not_started');
  assert.equal(none.totals.submissionRate, null);
  assert.equal(none.sources.length, 6);
  const late = await buildAiSearchReport(RANGE, reportDeps({ ai: { 'meta/coverage-start': { startedAt: '2026-11-15T00:00:00Z' } } }));
  assert.equal(late.status, 'partial');
});

test('classifyBooking: a consistent single-session submission inside the window is AI', () => {
  const R = refAt('2026-11-13T09:00:00Z', 'OK01');
  const r = irow('booking_submitted', '2026-11-13', { ref: R });
  assert.deepEqual(classifyBooking(R, [r, { ...r, eventId: 'retry' }]), { kind: 'ai', sourceKey: 'chatgpt' });
  assert.equal(classifyBooking(R, []).kind, 'no_record');
  assert.equal(classifyBooking(R, [{ ...r, receivedAt: '2026-11-13T08:00:00Z' }]).kind, 'unverifiable', 'before the reference existed');
  assert.equal(classifyBooking(R, [r], { listTruncated: true }).kind, 'unverifiable');
  assert.equal(referenceCreatedMs(R), Date.parse('2026-11-13T09:00:00Z'));
});

// ── authorization ─────────────────────────────────────────────────────────
test('the ai-search view is behind the existing admin gate and uses strict reads', async () => {
  const { handler } = require('../netlify/functions/revenue-admin');
  const res = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { view: 'ai-search' } });
  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(res.body || '', /totals|sources/);
  const src = read('netlify/functions/revenue-admin.js');
  assert.ok(src.indexOf("view === 'ai-search'") > src.indexOf('verifyAdminRequest(event.headers'));
  assert.match(src, /view === 'ai-search'[\s\S]{0,400}getJson: blobGetJsonStrict/);
});

// ── page wiring ───────────────────────────────────────────────────────────
test('admin-ops AI card: accurate labels, no false zeros, no rates, existing helpers untouched', () => {
  const html = read('admin-ops.html');
  assert.match(html, /id="revopsAi"/);
  assert.match(html, /revenue-admin\?view=ai-search/);
  assert.equal((html.match(/function money\(/g) || []).length, 1, 'existing money(cents) is not shadowed');
  assert.match(html, /AI-attributed sessions/);
  assert.match(html, /Approved booking value — not collected payment/);
  assert.match(html, /Browser-reported attribution, not independently verified/);
  assert.match(html, /status === 'unavailable'/);
  assert.doesNotMatch(html, /AI-attributed visits|'Confirmed value'|Visit → /);
});
