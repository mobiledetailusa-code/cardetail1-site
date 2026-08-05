/**
 * Admin Ops — last-good data preservation on partial refresh failures.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const SS = require('../assets/admin-source-state.js');
const adminOps = fs.readFileSync(path.join(root, 'admin-ops.html'), 'utf8');
const opsRefresh = fs.readFileSync(path.join(root, 'assets/operational-refresh.js'), 'utf8');

function extractInlineScript(html) {
  const m = html.match(/<script>\s*\(function\(\)\{[\s\S]*\}\)\(\);\s*<\/script>/);
  return m ? m[0].replace(/<\/?script>/g, '') : '';
}

describe('admin-source-state helpers', () => {
  it('1. jobs success then failure preserves hasLoaded and does not clear data contract', () => {
    let meta = SS.createSourceMeta();
    const start1 = SS.beginSourceLoad(meta);
    meta = start1.meta;
    meta = SS.applySourceSuccess(meta, start1.generation).meta;
    assert.equal(meta.hasLoaded, true);
    assert.equal(meta.error, null);

    let jobs = [{ id: 'CD1-A' }, { id: 'CD1-B' }];
    const start2 = SS.beginSourceLoad(meta);
    meta = start2.meta;
    const fail = SS.applySourceFailure(meta, start2.generation, 'HTTP 502');
    meta = fail.meta;
    assert.equal(fail.preserveData, true);
    assert.equal(fail.isInitialFailure, false);
    assert.equal(meta.hasLoaded, true);
    assert.equal(meta.error, 'HTTP 502');
    assert.equal(jobs.length, 2); // caller must leave array untouched
  });

  it('2. technicians failure message is localized and independent of jobs', () => {
    const msg = SS.refreshFailureMessage('Technicians', true);
    assert.match(msg, /last loaded data/i);
    assert.doesNotMatch(msg, /Jobs/);
  });

  it('3. change-requests failure after success is refresh-stale, not wipe', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s1.meta, s1.generation).meta;
    const s2 = SS.beginSourceLoad(meta);
    const fail = SS.applySourceFailure(s2.meta, s2.generation, 'HTTP 502');
    assert.equal(fail.isInitialFailure, false);
    assert.equal(fail.preserveData, true);
    assert.match(SS.refreshFailureMessage('Change requests', true), /last loaded data/i);
  });

  it('4. change-requests failure preserves previously loaded semantic via preserveData', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s1.meta, s1.generation).meta;
    const cached = [{ id: 'cr1' }];
    const s2 = SS.beginSourceLoad(meta);
    const fail = SS.applySourceFailure(s2.meta, s2.generation, 'HTTP 502');
    assert.equal(fail.preserveData, true);
    assert.deepEqual(cached, [{ id: 'cr1' }]);
  });

  it('5. technician failure preserves previously loaded technicians semantic', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s1.meta, s1.generation).meta;
    const techs = [{ id: 't1' }];
    const s2 = SS.beginSourceLoad(meta);
    const fail = SS.applySourceFailure(s2.meta, s2.generation, 'HTTP 504');
    assert.equal(fail.preserveData, true);
    assert.equal(techs.length, 1);
  });

  it('6. partial refresh success clears only that source error', () => {
    let jobsMeta = SS.createSourceMeta();
    let techsMeta = SS.createSourceMeta();
    const j1 = SS.beginSourceLoad(jobsMeta);
    jobsMeta = SS.applySourceSuccess(j1.meta, j1.generation).meta;
    const t1 = SS.beginSourceLoad(techsMeta);
    techsMeta = SS.applySourceFailure(t1.meta, t1.generation, 'HTTP 504').meta;
    assert.equal(techsMeta.error, 'HTTP 504');

    const j2 = SS.beginSourceLoad(jobsMeta);
    jobsMeta = SS.applySourceFailure(j2.meta, j2.generation, 'HTTP 502').meta;
    assert.equal(jobsMeta.error, 'HTTP 502');

    const j3 = SS.beginSourceLoad(jobsMeta);
    jobsMeta = SS.applySourceSuccess(j3.meta, j3.generation).meta;
    assert.equal(jobsMeta.error, null);
    assert.equal(techsMeta.error, 'HTTP 504'); // unrelated source untouched
  });

  it('7. retry success replaces stale data contract (success clears error)', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s1.meta, s1.generation).meta;
    const s2 = SS.beginSourceLoad(meta);
    meta = SS.applySourceFailure(s2.meta, s2.generation, 'HTTP 502').meta;
    const s3 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s3.meta, s3.generation).meta;
    assert.equal(meta.error, null);
    assert.ok(meta.lastSuccessAt);
  });

  it('8. retry failure preserves last-good hasLoaded', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s1.meta, s1.generation).meta;
    const s2 = SS.beginSourceLoad(meta);
    meta = SS.applySourceFailure(s2.meta, s2.generation, 'HTTP 502').meta;
    const s3 = SS.beginSourceLoad(meta);
    meta = SS.applySourceFailure(s3.meta, s3.generation, 'HTTP 502').meta;
    assert.equal(meta.hasLoaded, true);
    assert.equal(meta.error, 'HTTP 502');
  });

  it('9. edit must not trigger refreshAll', () => {
    assert.equal(SS.editShouldTriggerRefreshAll(), false);
  });

  it('10. edit handler in HTML does not call refreshAll', () => {
    assert.match(adminOps, /Edit toggles local UI only/);
    const editBlock = adminOps.slice(adminOps.indexOf('dEnableEdit'), adminOps.indexOf('dEnableEdit') + 800);
    assert.doesNotMatch(editBlock, /refreshAll\(/);
  });

  it('11. clear filters uses in-memory helper and does not call refreshAll', () => {
    const cleared = SS.clearedJobFilters();
    assert.deepEqual(cleared, { search: '', status: '', queueFilter: 'all' });
    assert.match(adminOps, /Clear filters operates only on in-memory jobs/);
    const clearBlock = adminOps.slice(adminOps.indexOf('jobsClear'), adminOps.indexOf('jobsClear') + 450);
    assert.doesNotMatch(clearBlock, /refreshAll\(/);
    assert.doesNotMatch(clearBlock, /loadJobs\(/);
  });

  it('12. clear filters helper leaves queue at all', () => {
    assert.equal(SS.clearedJobFilters().queueFilter, 'all');
  });

  it('13. clear filters does not perform network reload (source assert)', () => {
    assert.match(adminOps, /no network reload/);
  });

  it('14. direct booking link waits while jobs not loaded', () => {
    const meta = SS.createSourceMeta();
    assert.equal(SS.resolveDirectLink('CD1-X', [], meta), 'wait');
  });

  it('15. direct booking link opens when job arrives; survives secondary failure semantics', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s1.meta, s1.generation).meta;
    assert.equal(SS.resolveDirectLink('CD1-X', [{ id: 'CD1-X' }], meta), 'open');
    // jobs ok, techs failed — direct link still openable from jobs
    assert.equal(SS.resolveDirectLink('CD1-X', [{ id: 'CD1-X' }], meta), 'open');
  });

  it('16. selected job remains open after failed refresh (preserveData)', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s1.meta, s1.generation).meta;
    const s2 = SS.beginSourceLoad(meta);
    const fail = SS.applySourceFailure(s2.meta, s2.generation, 'HTTP 502');
    assert.equal(fail.preserveData, true);
    assert.match(adminOps, /Only collapse when the selected job is truly gone from memory/);
  });

  it('17. real missing job distinguishable from refresh failure', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = SS.applySourceSuccess(s1.meta, s1.generation).meta;
    assert.equal(SS.resolveDirectLink('CD1-MISSING', [{ id: 'CD1-OTHER' }], meta), 'missing');
    const s2 = SS.beginSourceLoad(meta);
    meta = SS.applySourceFailure(s2.meta, s2.generation, 'HTTP 502').meta;
    assert.equal(SS.resolveDirectLink('CD1-MISSING', [{ id: 'CD1-OTHER' }], meta), 'wait');
  });

  it('18. initial failure with no cached data is initial failure', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    const fail = SS.applySourceFailure(s1.meta, s1.generation, 'HTTP 502');
    assert.equal(fail.isInitialFailure, true);
    assert.match(SS.refreshFailureMessage('Jobs', false), /could not be loaded/i);
  });

  it('19. localized retry wiring exists per source', () => {
    assert.match(adminOps, /async function retrySource\(source\)/);
    assert.match(adminOps, /data-retry-source/);
    assert.match(adminOps, /Retry jobs/);
  });

  it('20. older\/stale response cannot overwrite a newer success', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = s1.meta;
    const s2 = SS.beginSourceLoad(meta);
    meta = s2.meta;
    // late success from gen1 must not apply
    const late = SS.applySourceSuccess(meta, s1.generation);
    assert.equal(late.applied, false);
    const ok = SS.applySourceSuccess(meta, s2.generation);
    assert.equal(ok.applied, true);
  });

  it('21. aborted\/superseded failure cannot mutate current state', () => {
    let meta = SS.createSourceMeta();
    const s1 = SS.beginSourceLoad(meta);
    meta = s1.meta;
    const s2 = SS.beginSourceLoad(meta);
    meta = s2.meta;
    const lateFail = SS.applySourceFailure(meta, s1.generation, 'aborted');
    assert.equal(lateFail.applied, false);
    assert.equal(SS.shouldApplyGeneration(meta, s1.generation), false);
  });

  it('22. existing request-list filters continue working markers', () => {
    assert.match(adminOps, /requestsStatusFilter/);
    assert.match(adminOps, /req-filter-btn|requestsStatusFilter/);
    assert.match(adminOps, /admin-customer-requests/);
  });

  it('23. vehicle-removal workflow markers remain', () => {
    assert.match(adminOps, /vehicle_remove_request/);
    assert.match(adminOps, /Approve removal/);
  });

  it('24. payment behavior markers unchanged', () => {
    assert.match(adminOps, /generate_stripe_pay_link/);
    assert.match(adminOps, /reconcile_with_stripe/);
    assert.doesNotMatch(adminOps, /require\(['"]stripe['"]\)/);
  });

  it('25. no wipe-on-reject statements remain', () => {
    assert.doesNotMatch(adminOps, /if \(jobsR\.status === 'rejected'\) jobs = \[\]/);
    assert.doesNotMatch(adminOps, /if \(techsR\.status === 'rejected'\) techs = \[\]/);
    assert.doesNotMatch(adminOps, /if \(changeR\.status === 'rejected'\) changeRequests = \[\]/);
    assert.match(adminOps, /Intentionally do NOT assign jobs=\[\], techs=\[\], or changeRequests=\[\] on rejection/);
  });

  it('26. mobile overflow guard on load banner', () => {
    assert.match(adminOps, /overflow-wrap:anywhere/);
    assert.match(adminOps, /max-width:100%/);
  });
});

describe('admin-ops wiring contracts', () => {
  it('loads admin-source-state.js', () => {
    assert.match(adminOps, /assets\/admin-source-state\.js/);
  });

  it('inline script still parses', () => {
    const src = extractInlineScript(adminOps);
    assert.ok(src.length > 100);
    assert.doesNotThrow(() => {
      vm.compileFunction(src, [
        'CD1AdminSession', 'SiteAccess', 'CD1AdminSourceState',
        'document', 'window', 'location', 'fetch', 'prompt', 'confirm', 'alert',
        'navigator', 'setTimeout', 'clearTimeout', 'AbortController', 'URL', 'URLSearchParams',
        'FormData', 'CSS',
      ]);
    });
  });

  it('refreshAll dedupes simultaneous executions unless the prior request was superseded', () => {
    assert.match(adminOps, /if \(refreshAllInflight && !\(requestSignal && refreshAllSignal && refreshAllSignal\.aborted\)\)/);
  });

  it('operational refresh still dedupes inflight', () => {
    assert.match(opsRefresh, /if \(inflight && !supersede\) return inflight/);
  });

  it('captures bookingId query\/hash for direct links', () => {
    assert.match(adminOps, /pendingOpenBookingId/);
    assert.match(adminOps, /bookingId/);
    assert.match(adminOps, /maybeOpenPendingDirectLink/);
  });
});
