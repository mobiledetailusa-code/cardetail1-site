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
  const state = {
    jobs,
    // tech-auth by action; default: every call succeeds.
    auth: (body) => response(200, { ok: true, techId: 'TECH-AAAAAA111111', name: 'Alex Rivera', token: body.action === 'login' ? 'b'.repeat(64) : undefined }),
    photoPost: () => response(200, { ok: true, photosBefore: ['/.netlify/functions/job-photo-image?id=jobph_1_aaaa'], photosAfter: [] }),
    jobGets: 0,
  };
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
        if (u.includes('tech-auth')) return state.auth(JSON.parse(opts.body || '{}'));
        if (u.includes('tech-profile')) return response(200, { ok: true, profile: { onboardingComplete: true } });
        if (u.includes('tech-jobs') && method === 'GET') { state.jobGets += 1; return state.jobs(); }
        if (u.includes('tech-jobs')) return response(200, { ok: true });
        if (u.includes('tech-job-photos') && method === 'POST') return state.photoPost();
        if (u.includes('tech-job-photos')) return response(200, { ok: true, photosBefore: [], photosAfter: [] });
        if (u.includes('job-photo-image')) return response(404, { ok: false });
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
    state,
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

// ---------------------------------------------------------------------------
// Residual races: completion dialog, photo upload, logout
// ---------------------------------------------------------------------------

/** Replace FileReader so the test decides when a file read finishes. */
function controlFileReader(w) {
  const pending = [];
  w.FileReader = class {
    readAsDataURL() {
      pending.push(() => { this.result = 'data:image/jpeg;base64,QUJD'; this.onload(); });
    }
  };
  return {
    get pending() { return pending.length; },
    finishAll() { while (pending.length) pending.shift()(); },
  };
}
const photoFile = () => ({ files: [{ size: 1000, type: 'image/jpeg', name: 'a.jpg' }], value: 'C:\\fakepath\\a.jpg' });
const photoPosts = (page) => page.posts.filter((p) => p.url.includes('tech-job-photos'));
const modalOpen = (page) => page.w.document.getElementById('complete-modal').classList.contains('open');

test('completion dialog: invalidation closes it and clears customer details (failure and refresh start)', async (t) => {
  const page = await loadedPage(t);
  page.w.openComplete('bk_job_one');
  await page.settle();
  assert.ok(modalOpen(page));
  assert.match(page.w.document.getElementById('cmp-summary').textContent, /Jordan Stale/);
  assert.match(page.w.document.getElementById('cmp-summary').innerHTML, /Harbor View/);
  page.w.document.getElementById('cust-name').value = 'Jordan Stale';

  // The moment a refresh starts, the dialog is gone (response still pending).
  const pending = deferred();
  page.setJobs(() => pending.promise);
  const p = page.w.loadJobs();
  assert.equal(modalOpen(page), false, 'closed as soon as the list is invalidated');
  const modal = page.w.document.getElementById('complete-modal');
  assert.doesNotMatch(modal.innerHTML, STALE);
  assert.equal(page.w.document.getElementById('cmp-summary').innerHTML, '');
  assert.equal(page.w.document.getElementById('cust-name').value, '');
  assert.equal(page.w.document.getElementById('cmp-sub').textContent, '—');
  pending.resolve(response(503, { ok: false, error: 'temporarily_unavailable' }));
  await p;
  await page.settle();
  assert.equal(modalOpen(page), false);
  assert.doesNotMatch(modal.innerHTML, STALE);

  page.posts.length = 0;
  await page.w.submitComplete();
  assert.equal(page.posts.filter((x) => x.url.includes('tech-complete-job')).length, 0, 'no stale completion');
});

test('completion dialog: a photo list arriving after the dialog was discarded is ignored', async (t) => {
  const page = await loadedPage(t);
  const photosGet = deferred();
  const realFetch = page.w.fetch;
  page.w.fetch = (url, opts) => (String(url).includes('tech-job-photos') && !(opts && opts.method)
    ? photosGet.promise : realFetch(url, opts));
  page.w.openComplete('bk_job_one');
  page.setJobs(() => response(503, { ok: false }));
  await page.w.loadJobs();
  photosGet.resolve(response(200, { ok: true, photosBefore: ['/.netlify/functions/job-photo-image?id=jobph_9_ffff'], photosAfter: [] }));
  await page.settle();
  assert.equal(page.w.document.getElementById('grid-before').innerHTML, '');
});

test('normal completion still submits on a current list', async (t) => {
  const page = await loadedPage(t);
  const reader = controlFileReader(page.w);
  page.state.photoPost = () => response(200, {
    ok: true,
    photosBefore: ['/.netlify/functions/job-photo-image?id=jobph_1_aaaa'],
    photosAfter: ['/.netlify/functions/job-photo-image?id=jobph_2_bbbb'],
  });
  page.w.openComplete('bk_job_one');
  await page.settle();
  const up = page.w.onPhotoPick('before', photoFile());
  reader.finishAll();
  await up;
  await page.settle();
  const d = page.w.document;
  d.getElementById('chk-service').checked = true;
  d.getElementById('chk-work-doc').checked = true;
  d.getElementById('chk-tech-confirm').checked = true;
  page.posts.length = 0;
  await page.w.submitComplete();
  await page.settle();
  const sent = page.posts.filter((x) => x.url.includes('tech-complete-job'));
  assert.equal(sent.length, 1, d.getElementById('cmperr').textContent);
  assert.equal(sent[0].body.bookingId, 'bk_job_one');
  assert.equal(modalOpen(page), false);
});

test('photo upload: normal upload sends once and shows the returned photos', async (t) => {
  const page = await loadedPage(t);
  const reader = controlFileReader(page.w);
  page.w.openComplete('bk_job_one');
  await page.settle();
  page.posts.length = 0;
  const up = page.w.onPhotoPick('before', photoFile());
  assert.equal(reader.pending, 1);
  reader.finishAll();
  await up;
  await page.settle();
  const sent = photoPosts(page);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.bookingId, 'bk_job_one');
  assert.match(page.w.document.getElementById('grid-before').innerHTML, /jobph_1_aaaa/);
});

for (const [label, invalidate] of [
  ['the list fails (503)', async (page) => { page.setJobs(() => response(503, { ok: false })); await page.w.loadJobs(); }],
  ['the list is refreshed successfully', async (page) => { await page.w.loadJobs(); }],
  ['the technician signs out', async (page) => { await page.w.doLogout(); }],
  ['a network failure empties the list', async (page) => { page.setJobs(() => Promise.reject(new TypeError('Failed to fetch'))); await page.w.loadJobs(); }],
]) {
  test(`photo upload: nothing is sent when ${label} while the file is being read`, async (t) => {
    const page = await loadedPage(t);
    const reader = controlFileReader(page.w);
    page.w.openComplete('bk_job_one');
    await page.settle();
    page.posts.length = 0;
    const up = page.w.onPhotoPick('after', photoFile());
    assert.equal(reader.pending, 1, 'file read in progress');
    await invalidate(page);
    reader.finishAll();
    await up;
    await page.settle();
    assert.deepEqual(photoPosts(page), [], 'no upload request');
    assert.equal(page.w.document.getElementById('grid-after').innerHTML, '');
  });
}

test('photo upload: a response that arrives after invalidation is not shown', async (t) => {
  const page = await loadedPage(t);
  const reader = controlFileReader(page.w);
  const upload = deferred();
  page.state.photoPost = () => upload.promise;
  page.w.openComplete('bk_job_one');
  await page.settle();
  const up = page.w.onPhotoPick('before', photoFile());
  reader.finishAll();
  await page.settle();
  assert.equal(photoPosts(page).length, 1, 'upload in flight');
  page.setJobs(() => response(503, { ok: false }));
  await page.w.loadJobs();
  upload.resolve(response(200, { ok: true, photosBefore: ['/.netlify/functions/job-photo-image?id=jobph_1_aaaa'], photosAfter: [] }));
  await up;
  await page.settle();
  assert.equal(page.w.document.getElementById('grid-before').innerHTML, '');
  assert.equal(modalOpen(page), false);
});

test('logout: the list is cleared when logout starts; an in-flight list response cannot restore it', async (t) => {
  const page = await loadedPage(t);
  page.w.openComplete('bk_job_one');
  await page.settle();
  const jobsPending = deferred();
  page.setJobs(() => jobsPending.promise);
  // A refresh is in flight…
  const listing = page.w.loadJobs();
  // …then put it back to "loaded" so logout must clear it itself.
  jobsPending.resolve(response(200, { ok: true, jobs: [job()], withdrawals: [] }));
  await listing;
  assert.equal(page.cards(), 1);

  const inflight = deferred();
  page.setJobs(() => inflight.promise);
  const listing2 = page.w.loadJobs();
  page.w.openComplete('bk_job_one');
  const logoutResp = deferred();
  page.state.auth = (body) => (body.action === 'logout' ? logoutResp.promise : response(200, { ok: true }));
  const out = page.w.doLogout();
  // Synchronously cleared, before the server answers.
  assert.equal(page.cards(), 0);
  assert.doesNotMatch(page.visibleText(), STALE);
  assert.equal(modalOpen(page), false);

  inflight.resolve(response(200, { ok: true, jobs: [job()], withdrawals: [] }));
  await listing2;
  await page.settle();
  assert.equal(page.cards(), 0, 'in-flight response during logout is ignored');
  assert.doesNotMatch(page.visibleText(), STALE);

  logoutResp.resolve(response(200, { ok: true }));
  await out;
  await page.settle();
  assert.equal(page.cards(), 0);
  assert.equal(page.w.sessionStorage.getItem('cd1_tech_token'), null);
  assert.ok(page.w.document.getElementById('s-land').classList.contains('active'));
});

for (const [label, fail] of [
  ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['a server error', () => response(500, { ok: false })],
]) {
  test(`logout: ${label} from the server logout still leaves no customer data`, async (t) => {
    const page = await loadedPage(t);
    page.w.openComplete('bk_job_one');
    await page.settle();
    const logoutResp = deferred();
    page.state.auth = (body) => (body.action === 'logout' ? logoutResp.promise : response(200, { ok: true }));
    const out = page.w.doLogout();
    const before = page.state.jobGets;
    await page.w.loadJobs(); // a refresh attempted while logging out sends nothing
    assert.equal(page.state.jobGets, before, 'no list request during logout');
    logoutResp.resolve(fail());
    await out;
    await page.settle();
    assert.equal(page.cards(), 0);
    assert.doesNotMatch(page.visibleText(), STALE);
    assert.equal(page.w.sessionStorage.getItem('cd1_tech_token'), null);
    assert.ok(page.w.document.getElementById('s-land').classList.contains('active'));
  });
}

test('login after logout loads the job list normally', async (t) => {
  const page = await loadedPage(t);
  await page.w.doLogout();
  assert.equal(page.cards(), 0);
  page.setJobs(ok([job({ id: 'bk_after_login', customerName: 'Casey Current' })]));
  const d = page.w.document;
  page.w.showLogin();
  d.getElementById('l-email').value = 'tech@example.com';
  d.getElementById('l-pass').value = 'not-a-real-password';
  await page.w.doLogin();
  await page.settle();
  assert.equal(page.w.sessionStorage.getItem('cd1_tech_token'), 'b'.repeat(64));
  assert.ok(d.getElementById('s-dash').classList.contains('active'));
  assert.equal(page.cards(), 1);
  assert.match(page.list().textContent, /Casey Current/);
});
