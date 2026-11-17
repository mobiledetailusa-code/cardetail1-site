// The AI Search Performance card loads independently of the main Revenue
// Operations request. Runs the real admin-ops.html code (AI card helpers and
// refreshRevopsTab) in a sandbox with stubbed DOM and api().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin-ops.html'), 'utf8');
const start = html.indexOf('  // AI search performance: recorded counts');
const end = html.indexOf("  $('#revopsRefresh').onclick");
assert.ok(start > 0 && end > start, 'AI card / RevOps refresh block not found');
const block = html.slice(start, end);

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  const els = {};
  // textContent and innerHTML share one value, like a real element.
  const make = (id) => {
    let content = '';
    return {
      id, hidden: false, value: '',
      get innerHTML() { return content; }, set innerHTML(v) { content = String(v); },
      get textContent() { return content.replace(/<[^>]*>/g, ''); }, set textContent(v) { content = String(v); },
    };
  };
  const el = (id) => (els[id] = els[id] || make(id));
  const calls = [];
  const pending = { dashboard: [], ai: [] };
  const log = { dashboardRendered: 0, errors: [] };
  const ctx = {
    $: (sel) => el(sel.replace(/^#/, '')),
    esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    api: (url) => {
      calls.push(url);
      const d = deferred();
      (/view=ai-search/.test(url) ? pending.ai : pending.dashboard).push(d);
      return d.promise;
    },
    renderRevopsDashboard: () => { log.dashboardRendered += 1; el('revopsStats').innerHTML = '<div>stats</div>'; },
    setRevopsLoading: (on) => { el('revopsLoading').hidden = !on; el('revopsContent').hidden = !!on; },
    setRevopsError: (m) => { if (m) log.errors.push(m); el('revopsError').hidden = !m; },
    Date, Math, Number, String, JSON, Object, Array, Promise,
  };
  el('revopsPriorityFilter').value = '';
  vm.createContext(ctx);
  vm.runInContext(`let revopsInflight = null;
${block}\nthis.refreshRevopsTab = refreshRevopsTab; this.refreshAiSearch = refreshAiSearch;`, ctx);
  const card = () => ({ note: el('revopsAiNote').textContent, stats: el('revopsAiStats').innerHTML, sources: el('revopsAiSources').innerHTML });
  return { ctx, calls, pending, log, card, el };
}

const flush = () => new Promise((r) => setImmediate(r));
const timeout = () => Object.assign(new Error('timeout'), { name: 'AbortError' });
const okReport = (over = {}) => ({
  ok: true, status: 'complete', complete: true, lowerBound: false, coverageStart: '2026-11-17T20:00:00.000Z',
  totals: { aiSessions: 3, bookingSubmissions: 1, confirmedBookings: 1, approvedValue: 285 },
  sources: [{ key: 'chatgpt', label: 'ChatGPT', latestReferralSessions: 3, firstAcquiredSessions: 2, bookingSubmissions: 1, confirmedBookings: 1, approvedValue: 285, confirmedMissingAmount: 0 }],
  excluded: {}, limitations: ['Browser-reported.'], ...over,
});
const notStarted = { ok: true, status: 'not_started', coverageStart: null, totals: { aiSessions: 0 }, sources: [], excluded: {}, limitations: [] };

test('AI request starts before, and does not wait for, the main dashboard request', async () => {
  const h = harness();
  h.ctx.refreshRevopsTab();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0], /view=ai-search/, 'AI report is requested first');
  assert.match(h.calls[1], /view=dashboard/);
  assert.match(h.card().note, /Loading AI search data/);
  h.pending.ai[0].resolve(okReport());
  await flush();
  assert.match(h.card().stats, /AI-attributed sessions/, 'AI card renders while the dashboard is still pending');
  assert.equal(h.log.dashboardRendered, 0);
});

test('1. dashboard and AI report both succeed', async () => {
  const h = harness();
  const p = h.ctx.refreshRevopsTab();
  h.pending.ai[0].resolve(okReport());
  h.pending.dashboard[0].resolve({ ok: true });
  await p; await flush();
  assert.equal(h.log.dashboardRendered, 1);
  assert.equal(h.log.errors.length, 0);
  assert.match(h.card().stats, /Approved booking value — not collected payment/);
  assert.match(h.card().stats, /\$285/);
  assert.equal(h.el('revopsContent').hidden, false);
});

test('2. dashboard times out; AI card still renders', async () => {
  const h = harness();
  const p = h.ctx.refreshRevopsTab();
  h.pending.dashboard[0].reject(timeout());
  await p; await flush();
  assert.match(h.log.errors[0], /RevOps load failed: timeout/, 'existing error path unchanged');
  h.pending.ai[0].resolve(okReport());
  await flush();
  assert.match(h.card().stats, /AI-attributed sessions/);
  assert.match(h.card().note, /Complete for this range/);
});

test('3. dashboard succeeds; AI report fails without touching the dashboard', async () => {
  const h = harness();
  const p = h.ctx.refreshRevopsTab();
  h.pending.ai[0].reject(new Error('Server error 500'));
  h.pending.dashboard[0].resolve({ ok: true });
  await p; await flush();
  assert.equal(h.log.dashboardRendered, 1);
  assert.equal(h.log.errors.length, 0, 'AI failure never sets the RevOps error');
  assert.match(h.card().note, /AI search report unavailable: Server error 500\. No figures are shown\./);
  assert.equal(h.card().stats, '');
});

test('4. both requests fail: each shows its own error, no figures', async () => {
  const h = harness();
  const p = h.ctx.refreshRevopsTab();
  h.pending.ai[0].reject(new Error('Unauthorized'));
  h.pending.dashboard[0].reject(timeout());
  await p; await flush();
  assert.equal(h.log.errors.length, 1);
  assert.match(h.card().note, /AI search report unavailable/);
  assert.equal(h.card().stats, '');
  assert.equal(h.card().sources, '');
});

test('5–7. not_started, partial and unavailable states render without false zeros', async () => {
  const run = async (report) => {
    const h = harness();
    h.ctx.refreshAiSearch();
    h.pending.ai[0].resolve(report);
    await flush();
    return h.card();
  };
  const ns = await run(notStarted);
  assert.match(ns.note, /No AI-attributed activity recorded yet/);
  assert.equal(ns.stats, '', 'not_started shows no figures');
  const partial = await run(okReport({ status: 'partial', complete: false, lowerBound: true }));
  assert.match(partial.note, /Partial for this range/);
  assert.match(partial.stats, /≥ 3/);
  const unavailable = await run({ ok: true, status: 'unavailable', totals: null, sources: null });
  assert.match(unavailable.note, /unavailable right now/);
  assert.equal(unavailable.stats, '');
});

test('9. repeated navigation reuses in-flight requests', async () => {
  const h = harness();
  const a = h.ctx.refreshRevopsTab();
  h.ctx.refreshRevopsTab();
  h.ctx.refreshAiSearch();
  assert.equal(h.calls.filter((u) => /ai-search/.test(u)).length, 1);
  assert.equal(h.calls.filter((u) => /dashboard/.test(u)).length, 1);
  // The AI request finishing first does not start another while the dashboard is pending.
  h.pending.ai[0].resolve(notStarted);
  await flush();
  h.ctx.refreshRevopsTab();
  assert.equal(h.calls.length, 2);
  h.pending.dashboard[0].resolve({ ok: true });
  await a;
  // A later visit refreshes both once.
  h.ctx.refreshRevopsTab();
  assert.equal(h.calls.filter((u) => /ai-search/.test(u)).length, 2);
  assert.equal(h.calls.filter((u) => /dashboard/.test(u)).length, 2);
});

test('10. card sits outside the RevOps content area; dashboard timeout and markup unchanged', () => {
  const aiIdx = html.indexOf('id="revopsAi"');
  const contentIdx = html.indexOf('<div id="revopsContent">');
  assert.ok(aiIdx > 0 && aiIdx < contentIdx, 'card is not hidden with #revopsContent while the dashboard loads');
  assert.match(html, /<div id="revopsContent">\s*<div class="grid g4" id="revopsStats"><\/div>/);
  assert.match(html, /const q = '\/\.netlify\/functions\/revenue-admin\?view=dashboard&limit=50'/);
  assert.match(block, /const data = await api\(q\);\s*renderRevopsDashboard\(data\);\s*const lu/, 'dashboard path unchanged apart from the AI call');
  assert.equal((html.match(/^\s*refreshAiSearch\(\);/gm) || []).length, 1, 'AI report started from one place');
  assert.match(block, /if \(revopsInflight\) return revopsInflight;\s*refreshAiSearch\(\);/, 'started before the dashboard request');
});
