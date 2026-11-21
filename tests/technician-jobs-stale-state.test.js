'use strict';

/**
 * technician.html — the job list never shows or acts on stale data after a
 * failed refresh (503, network failure, invalid payload, other errors), and
 * overlapping or delayed responses cannot restore an older list.
 *
 * Loads the real page in jsdom with a stubbed fetch. Synthetic data only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'technician.html'), 'utf8');
const TOKEN = 'a'.repeat(64);

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function job(over = {}) {
  return {
    id: 'bk_job_one',
    package: 'Full Detail',
    vehicle: 'SUV',
    zone: 'Bergen',
    customerName: 'Jordan Stale',
    phone: '+12015550123',
    address: '12 Harbor View, Fort Lee, NJ',
    customerNote: 'Gate code 4411',
    confirmedDate: todayIso(),
    confirmedTime: '9:00 AM',
    jobStatus: 'assigned',
    piiLocked: false,
    ...over,
  };
}
const STALE = /Jordan Stale|Harbor View|5550123|Gate code|bk_job_one|bk_job_two/;

function response(status, body, { badJson = false } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (badJson) throw new SyntaxError('Unexpected token <');
      return body;
    },
    async blob() { return {}; },
  };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Boot the technician page signed in. `jobs` is a function returning the
 * next GET tech-jobs result (a response, a promise of one, or a thrown error).
 */
async function bootPage(t, jobs) {
  const posts = [];
  const state = { jobs };
  // Script errors while the page is open fail the test; errors after
  // window.close() (observers firing on a torn-down document) are ignored.
  const scriptErrors = [];
  let closed = false;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => { if (!closed) scriptErrors.push(e); });
  const dom = new JSDOM(HTML, {
    virtualConsole,
    url: 'https://cardetail1.com/technician.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.sessionStorage.setItem('cd1_tech_token', TOKEN);
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
      w.prompt = () => 'Truck in the shop this week';
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = String(opts.method || 'GET').toUpperCase();
        if (method === 'POST' && !/tech-auth|tech-profile/.test(u)) posts.push({ url: u, body: JSON.parse(opts.body || '{}') });
        if (u.includes('tech-auth')) return response(200, { ok: true, techId: 'TECH-AAAAAA111111', name: 'Alex Rivera' });
        if (u.includes('tech-profile')) return response(200, { ok: true, profile: { onboardingComplete: true } });
        if (u.includes('tech-jobs') && method === 'GET') return state.jobs();
        if (u.includes('tech-jobs')) return response(200, { ok: true });
        if (u.includes('tech-job-photos')) return response(200, { ok: true, photosBefore: [], photosAfter: [] });
        if (u.includes('tech-complete-job')) return response(200, { ok: true });
        return response(404, { ok: false });
      };
    },
  });
  t.after(() => {
    const errs = scriptErrors.map((e) => String(e.detail || e.message));
    closed = true;
    dom.window.close();
    assert.deepEqual(errs, [], 'no page script errors');
  });
  const w = dom.window;
  const page = {
    w,
    posts,
    setJobs(fn) { state.jobs = fn; },
    list: () => w.document.getElementById('jobs-list'),
    cards: () => w.document.querySelectorAll('#jobs-list .jc').length,
    summary: () => w.document.getElementById('dd-summary').innerHTML,
    count: () => w.document.getElementById('dd-count').textContent,
    visibleText: () => w.document.getElementById('jobs-list').innerHTML + w.document.getElementById('dd-summary').innerHTML
      + w.document.getElementById('dd-count').textContent + w.document.getElementById('complete-modal').innerHTML,
    toast: () => w.document.getElementById('toast').textContent,
    async settle() { for (let i = 0; i < 20; i++) await new Promise((r) => w.setTimeout(r, 0)); },
  };
  await page.settle();
  return page;
}

const ok = (jobs, withdrawals = []) => () => response(200, { ok: true, count: jobs.length, jobs, withdrawals });

function assertEmptyUnavailable(page, label) {
  assert.equal(page.cards(), 0, `${label}: no job cards`);
  assert.equal(page.summary(), '', `${label}: no summary cards`);
  assert.equal(page.count(), '', `${label}: no job count`);
  const panel = page.w.document.getElementById('jobs-unavailable');
  assert.ok(panel, `${label}: unavailable message shown`);
  const retry = panel.querySelector('button');
  assert.ok(retry && /try again/i.test(retry.textContent), `${label}: retry action`);
  assert.doesNotMatch(page.visibleText(), STALE, `${label}: no stale data on screen`);
}

async function loadedPage(t) {
  const page = await bootPage(t, ok([job(), job({ id: 'bk_job_two', customerName: 'Jordan Stale Two' })]));
  page.w.setDispatchDate(todayIso());
  assert.equal(page.cards(), 2, 'baseline: two cards');
  assert.match(page.summary(), /dd-card/);
  assert.match(page.count(), /2 jobs/);
  return page;
}

test('successful load → HTTP 503 → empty UI with retry', async (t) => {
  const page = await loadedPage(t);
  page.setJobs(() => response(503, { ok: false, error: 'temporarily_unavailable' }));
  await page.w.loadJobs();
  assertEmptyUnavailable(page, '503');
  assert.match(page.list().textContent, /temporarily unavailable/i);
});

test('successful load → network failure → empty UI with retry', async (t) => {
  const page = await loadedPage(t);
  page.setJobs(() => Promise.reject(new TypeError('Failed to fetch')));
  await page.w.loadJobs();
  assertEmptyUnavailable(page, 'network');
  assert.match(page.list().textContent, /could not reach the server/i);
});

test('invalid payloads and other non-success responses also clear the list', async (t) => {
  const page = await loadedPage(t);
  const cases = [
    ['500', () => response(500, { ok: false, error: 'failed_to_load_jobs' })],
    ['502 html', () => response(502, null, { badJson: true })],
    ['200 non-JSON', () => response(200, null, { badJson: true })],
    ['200 ok:false', () => response(200, { ok: false })],
    ['200 jobs not an array', () => response(200, { ok: true, jobs: 'x' })],
    ['200 job without id', () => response(200, { ok: true, jobs: [{ customerName: 'Jordan Stale' }] })],
    ['200 withdrawals not an array', () => response(200, { ok: true, jobs: [job()], withdrawals: {} })],
    ['403', () => response(403, { ok: false, error: 'forbidden' })],
  ];
  for (const [label, fn] of cases) {
    page.setJobs(ok([job()]));
    await page.w.loadJobs();
    assert.equal(page.cards(), 1, `${label}: reloaded before failure`);
    page.setJobs(fn);
    await page.w.loadJobs();
    assertEmptyUnavailable(page, label);
  }
});

test('failed refresh → date change cannot redraw stale cards', async (t) => {
  const page = await loadedPage(t);
  page.setJobs(() => response(503, { ok: false, error: 'temporarily_unavailable' }));
  await page.w.loadJobs();
  for (const d of ['', todayIso(), '2030-01-01', '']) {
    page.w.setDispatchDate(d);
    assertEmptyUnavailable(page, `date "${d}"`);
  }
});

test('failed refresh → technician actions are rejected locally (no request sent)', async (t) => {
  const page = await loadedPage(t);
  // Completion form opened while the list was good…
  page.w.openComplete('bk_job_one');
  assert.ok(page.w.document.getElementById('complete-modal').classList.contains('open'));
  page.setJobs(() => response(503, { ok: false, error: 'temporarily_unavailable' }));
  await page.w.loadJobs();
  page.posts.length = 0;

  await page.w.updStatus('bk_job_one', 'accepted');
  assert.match(page.toast(), /out of date/i);
  await page.w.requestWithdrawal('bk_job_one');
  page.w.openIssue('bk_job_one');
  assert.equal(page.w.document.getElementById('issue-modal').classList.contains('open'), false);
  // …cannot be submitted against the stale job.
  await page.w.submitComplete();
  assert.match(page.w.document.getElementById('cmperr').textContent, /out of date/i);
  page.w.closeComplete();
  page.w.openComplete('bk_job_one');
  assert.equal(page.w.document.getElementById('complete-modal').classList.contains('open'), false, 'cannot open completion');
  await page.settle();
  assert.deepEqual(page.posts, [], 'no status, withdrawal, issue or completion request was sent');
});

test('successful refresh after a failure restores current jobs and actions', async (t) => {
  const page = await loadedPage(t);
  page.setJobs(() => response(503, { ok: false, error: 'temporarily_unavailable' }));
  await page.w.loadJobs();
  assertEmptyUnavailable(page, 'failed');

  page.setJobs(ok([job({ id: 'bk_job_fresh', customerName: 'Casey Current', confirmedDate: todayIso() })]));
  page.w.document.querySelector('#jobs-unavailable button').click();
  await page.settle();
  assert.equal(page.w.document.getElementById('jobs-unavailable'), null);
  assert.equal(page.cards(), 1);
  assert.match(page.list().textContent, /Casey Current/);
  assert.doesNotMatch(page.list().innerHTML, /bk_job_one|Jordan Stale/);
  assert.match(page.count(), /1 job/);

  page.posts.length = 0;
  page.setJobs(ok([job({ id: 'bk_job_fresh', customerName: 'Casey Current', jobStatus: 'accepted' })]));
  await page.w.updStatus('bk_job_fresh', 'accepted');
  assert.deepEqual(page.posts.map((p) => p.body), [{ bookingId: 'bk_job_fresh', status: 'accepted' }]);
  await page.w.updStatus('bk_job_one', 'accepted');
  assert.equal(page.posts.length, 1, 'a job that is no longer in the list is refused');
});

test('overlapping requests: an older response can never replace a newer result', async (t) => {
  const page = await loadedPage(t);

  // Older request returns the old list AFTER the newer one succeeded.
  const older = deferred();
  const newer = deferred();
  const q = [older, newer];
  page.setJobs(() => q.shift().promise);
  const a = page.w.loadJobs();
  const b = page.w.loadJobs();
  newer.resolve(response(200, { ok: true, jobs: [job({ id: 'bk_new', customerName: 'Newest Customer' })], withdrawals: [] }));
  await b;
  older.resolve(response(200, { ok: true, jobs: [job()], withdrawals: [] }));
  await a;
  await page.settle();
  assert.match(page.list().textContent, /Newest Customer/);
  assert.doesNotMatch(page.visibleText(), /Jordan Stale/);

  // Newer request failed; a delayed older success must not restore data.
  const older2 = deferred();
  const newer2 = deferred();
  const q2 = [older2, newer2];
  page.setJobs(() => q2.shift().promise);
  const c = page.w.loadJobs();
  const d = page.w.loadJobs();
  newer2.resolve(response(503, { ok: false, error: 'temporarily_unavailable' }));
  await d;
  older2.resolve(response(200, { ok: true, jobs: [job()], withdrawals: [] }));
  await c;
  await page.settle();
  assertEmptyUnavailable(page, 'delayed older success after newer failure');
  page.posts.length = 0;
  await page.w.updStatus('bk_job_one', 'accepted');
  assert.deepEqual(page.posts, []);

  // While a refresh is in flight, nothing old is shown or actionable.
  const pending = deferred();
  page.setJobs(() => pending.promise);
  const e = page.w.loadJobs();
  page.w.setDispatchDate('');
  assert.equal(page.cards(), 0);
  assert.match(page.list().textContent, /Loading jobs/);
  await page.w.updStatus('bk_new', 'accepted');
  assert.deepEqual(page.posts, []);
  pending.resolve(response(200, { ok: true, jobs: [job({ id: 'bk_new', customerName: 'Newest Customer' })], withdrawals: [] }));
  await e;
  assert.equal(page.cards(), 1);
});

test('sign-out invalidates an in-flight job list request', async (t) => {
  const page = await loadedPage(t);
  const pending = deferred();
  page.setJobs(() => pending.promise);
  const p = page.w.loadJobs();
  await page.w.doLogout();
  pending.resolve(response(200, { ok: true, jobs: [job()], withdrawals: [] }));
  await p;
  await page.settle();
  assert.equal(page.cards(), 0);
  assert.doesNotMatch(page.visibleText(), STALE);
});

test('pending-withdrawal badges come only from the latest successful list', async (t) => {
  const page = await bootPage(t, ok([job()], [{ id: 'twr_1', bookingId: 'bk_job_one', status: 'pending' }]));
  assert.match(page.list().textContent, /Withdrawal requested/);
  page.setJobs(() => response(503, { ok: false }));
  await page.w.loadJobs();
  page.setJobs(ok([job()]));
  await page.w.loadJobs();
  assert.doesNotMatch(page.list().textContent, /Withdrawal requested/, 'old withdrawals are not carried over');
  assert.match(page.list().innerHTML, /Request withdrawal/);
});

test('mobile layout: the unavailable panel reuses the existing responsive empty-state styles', () => {
  // Same .empty/.ei/.et/.btn classes as every other empty state; no fixed widths.
  const m = HTML.match(/id="jobs-unavailable"[\s\S]*?Try again<\/button><\/div>/);
  assert.ok(m);
  assert.match(m[0], /class="ei"/);
  assert.match(m[0], /class="btn btn-p btn-sm"/);
  assert.doesNotMatch(m[0], /width\s*:/);
  assert.match(HTML, /\.empty\{text-align:center;padding:44px 14px/);
  assert.match(HTML, /<meta name="viewport" content="width=device-width/);
});
