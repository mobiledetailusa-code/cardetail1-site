'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SS = require('../assets/admin-source-state');
const Refresh = require('../assets/operational-refresh');
const adminOps = read('admin-ops.html');

function loadedMeta() {
  const start = SS.beginSourceLoad(SS.createSourceMeta());
  return SS.applySourceSuccess(start.meta, start.generation, 100).meta;
}

function dayViewDom() {
  const dom = new JSDOM(adminOps, {
    url: 'https://preview.example.test/admin-ops.html',
    runScripts: 'outside-only',
  });
  dom.window.eval(read('assets/admin-dayview.js'));
  return dom;
}

function controller(options) {
  const fakeDoc = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  return Refresh.createRefreshController(Object.assign({
    controllerKey: 'admin-read-' + Math.random(),
    window: {
      AbortController,
      setTimeout,
      clearTimeout,
      document: fakeDoc,
      navigator: { onLine: true },
      addEventListener() {},
      removeEventListener() {},
    },
    document: fakeDoc,
    navigator: { onLine: true },
    setTimeout,
    clearTimeout,
  }, options));
}

describe('Admin Ops operational read path', () => {
  it('A/B. existing Jobs remain a data-bearing state during refresh and timeout', () => {
    const jobs = [{ id: 'J1' }, { id: 'J2' }, { id: 'J3' }, { id: 'J4' }];
    let meta = loadedMeta();
    const refresh = SS.beginSourceLoad(meta);
    meta = refresh.meta;
    assert.equal(SS.classifySourceState(meta, jobs), 'REFRESHING_WITH_DATA');
    const failed = SS.applySourceFailure(meta, refresh.generation, 'timeout');
    assert.equal(failed.preserveData, true);
    assert.equal(jobs.length, 4);
    assert.equal(SS.classifySourceState(failed.meta, jobs), 'ERROR_WITH_DATA');
  });

  it('C. Change Requests cannot block the primary render or global completion', () => {
    const refreshStart = adminOps.indexOf('async function refreshAll');
    const refreshEnd = adminOps.indexOf('async function refreshRequestsTab', refreshStart);
    const source = adminOps.slice(refreshStart, refreshEnd);
    const renderAt = source.indexOf('renderPrimaryJobsSurfaces()');
    const secondaryAt = source.indexOf('refreshSecondarySources({ includeSettings: !syncOnly })');
    assert.ok(renderAt > 0 && secondaryAt > renderAt);
    assert.doesNotMatch(source.slice(secondaryAt - 20, secondaryAt + 100), /await\s+refreshSecondarySources/);
    assert.match(adminOps, /Updating Jobs…/);
    assert.match(adminOps, /Requests unavailable/);
  });

  it('D/E. only successful loaded-empty is authoritative zero', () => {
    const initial = SS.createSourceMeta();
    assert.equal(SS.classifySourceState(initial, []), 'NOT_LOADED');
    const loading = SS.beginSourceLoad(initial);
    assert.equal(SS.classifySourceState(loading.meta, []), 'LOADING_NO_DATA');
    const success = SS.applySourceSuccess(loading.meta, loading.generation, 100).meta;
    assert.equal(SS.classifySourceState(success, []), 'LOADED_EMPTY');
    assert.equal(SS.sourceStateHasAuthoritativeEmpty('LOADING_NO_DATA'), false);
    assert.equal(SS.sourceStateHasAuthoritativeEmpty('LOADED_EMPTY'), true);
  });

  it('E. Schedule DOM shows loading, not zero appointments, before first success', () => {
    const dom = dayViewDom();
    let state = 'LOADING_NO_DATA';
    dom.window.CD1AdminDayView.attach({
      getJobs: () => [],
      getJobsState: () => state,
      today: () => '2026-09-14',
      customerName: () => '',
    });
    assert.match(dom.window.document.querySelector('#dvSchedList').textContent, /Loading appointments/);
    assert.doesNotMatch(dom.window.document.querySelector('#dvSchedList').textContent, /No appointments/);
    assert.doesNotMatch(dom.window.document.querySelector('#dvCalStats').textContent, /Jobs \(month\)0/i);

    state = 'LOADED_EMPTY';
    dom.window.CD1AdminDayView.render();
    assert.match(dom.window.document.querySelector('#dvSchedList').textContent, /No appointments match/);
    assert.match(dom.window.document.querySelector('#dvCalStats').textContent, /Jobs \(month\)0/i);
    dom.window.close();
  });

  it('E. the Jobs empty branch explicitly repaints Schedule after authoritative success', () => {
    const renderStart = adminOps.indexOf('function renderJobs()');
    const emptyBranchEnd = adminOps.indexOf('const stillVisible', renderStart);
    const emptyBranch = adminOps.slice(renderStart, emptyBranchEnd);
    assert.match(emptyBranch, /if \(window\.CD1AdminDayView\) CD1AdminDayView\.render\(\)/);
  });

  it('F. duplicate lifecycle bootstrap coalesces instead of restarting first Jobs', async () => {
    let ready = false;
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const c = controller({
      isPrimaryReady: () => ready,
      onRefresh: async () => {
        calls += 1;
        await gate;
        ready = true;
        return { ok: true };
      },
    });
    const first = c.refresh('initial');
    const focused = c.refresh('focus', { supersede: true });
    assert.equal(calls, 1);
    release();
    await Promise.all([first, focused]);
    assert.ok(calls <= 2);
    c.destroy();
  });

  it('G. authoritative cash result patches balance immediately and is guarded from stale list data', () => {
    const before = {
      id: 'J1', bookingVersion: 1, paymentWorkflowStatus: 'awaiting_customer_payment',
      approvedCents: 24000, settledCents: 0, remainingCents: 24000,
    };
    const result = {
      ok: true,
      bookingVersion: 2,
      projection: { paymentStatus: 'paid', approvedCents: 24000, settledCents: 24000, remainingCents: 0 },
    };
    const patched = SS.applyAuthoritativePaymentResult(before, result, 'cash');
    assert.equal(patched.paymentWorkflowStatus, 'cash_paid');
    assert.equal(patched.remainingCents, 0);
    assert.equal(patched.amountDueApproved, 0);
    assert.equal(patched.bookingVersion, 2);
    assert.equal(SS.applyAuthoritativePaymentResult(before, {
      ok: true,
      projection: { paymentStatus: 'paid', remainingCents: 0 },
    }, 'cash'), before, 'partial financial responses are not fabricated client-side');
    assert.match(adminOps, /mergeMutationGuard\(incoming\[i\], current\)/);
    assert.match(adminOps, /incomingVersion >= requiredVersion/);
    assert.match(adminOps, /jobMutationGuards\.set/);
  });

  it('primary Blob-list failure is not converted to a successful empty response', () => {
    const source = read('netlify/functions/admin-ops-jobs.js');
    const strictStart = source.indexOf('async function listAllBlobsStrict');
    const hydrateStart = source.indexOf('async function hydrateJobsFromBlobs');
    const hydrateEnd = source.indexOf('async function listJobs');
    assert.ok(strictStart > 0 && hydrateStart > strictStart);
    assert.match(source.slice(strictStart, hydrateStart), /throw new Error\('booking_(store_unavailable|list_incomplete)'\)/);
    assert.doesNotMatch(source.slice(hydrateStart, hydrateEnd), /catch[\s\S]*return \[\]/);
    assert.match(source.slice(hydrateStart, hydrateEnd), /throw new Error\('booking_blob_incomplete'\)/);
    assert.doesNotMatch(source.slice(hydrateStart, hydrateEnd), /store\.get\([\s\S]*\.catch\(\(\) => null\)/);
  });

  it('real-preview diagnostics report aggregate timing and scan counts without response data', () => {
    const source = read('netlify/functions/admin-ops-jobs.js');
    assert.match(source, /response\.headers\['Server-Timing'\] = jobsServerTiming\(timing\)/);
    assert.match(source, /X-CD1-Jobs-Blob-List-Operations/);
    assert.match(source, /X-CD1-Jobs-Blob-Read-Operations/);
    assert.match(source, /X-CD1-Jobs-Prisma-Queries/);
    assert.match(source, /X-CD1-Jobs-Payload-Bytes/);
    assert.doesNotMatch(source, /X-CD1-Jobs-(Candidate|Classification|List-Fields|Key-Shapes)/);
    const diagStart = adminOps.indexOf('function diagnosticEvent');
    const apiStart = adminOps.indexOf('async function api');
    const diagSource = adminOps.slice(diagStart, apiStart);
    assert.doesNotMatch(diagSource, /firstName|lastName|phone|email|address|paymentIntent|stripe/i);
  });

  it('does not hydrate shared LKG storage after an unvalidated auth request', () => {
    assert.match(adminOps, /let adminSessionValidated = false/);
    assert.match(adminOps, /adminSessionValidated = true/);
    assert.match(adminOps, /catch \{\s*adminSessionValidated = false/);
    assert.match(adminOps, /if \(adminSessionValidated && !jobsSnapshotHydrated\) hydrateJobsSnapshotIfAvailable\(\)/);
  });
});
