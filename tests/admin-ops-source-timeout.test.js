'use strict';

/**
 * Admin Ops operational readiness: Jobs settle the global refresh while slow
 * secondary sources continue behind scoped status.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function extractRefreshAll(html) {
  const src = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/i);
  assert.ok(src, 'admin-ops inline script');
  const block = src[1].match(/async function refreshAll\([^)]*\)[\s\S]*?^  \}/m);
  assert.ok(block, 'refreshAll');
  return block[0];
}

describe('Admin Ops source timeout contract', () => {
  const html = read('admin-ops.html');
  const jobsSrc = read('netlify/functions/admin-ops-jobs.js');
  const refresh = extractRefreshAll(html);

  it('renders Jobs and resolves primary readiness before starting secondary sources', () => {
    assert.match(refresh, /const jobsR = await settle\(loadJobs\(\)\)/);
    assert.match(refresh, /loadJobs\(\)[\s\S]*renderPrimaryJobsSurfaces\(\)[\s\S]*refreshSecondarySources/);
    assert.doesNotMatch(refresh, /await refreshSecondarySources/);
    assert.doesNotMatch(refresh, /loadJobs\(null,\s*\{\s*signal:\s*requestSignal/);
    assert.doesNotMatch(refresh, /loadChangeRequests\(\{\s*signal:\s*requestSignal/);
    assert.match(html, /SOURCE_FETCH_TIMEOUT_MS = 10000/);
  });

  it('primary timeout budgets do not serialize an inner retry', () => {
    assert.match(html, /requestTimeoutMs:\s*12000/);
    assert.match(html, /SOURCE_FETCH_TIMEOUT_MS = 10000/);
    assert.match(html, /const maxAttempts = 1/);
    assert.match(html, /CHANGE_REQUESTS_FETCH_TIMEOUT_MS = 40000/);
    assert.match(html, /timeoutMs:\s*CHANGE_REQUESTS_FETCH_TIMEOUT_MS/);
    assert.match(html, /if \(secondaryRefreshInflight\) return secondaryRefreshInflight/);
  });

  it('per-source api timeout still reports timeout not aborted', () => {
    assert.match(html, /if \(timedOut\) throw new Error\('timeout'\)/);
    assert.match(html, /Retry jobs/);
    assert.match(html, /data-retry-source/);
    assert.match(html, /Retry all/);
  });

  it('listJobs keeps Blob payloads authoritative when Prisma mirror completeness is unproven', () => {
    const listStart = jobsSrc.indexOf('async function listJobs');
    const listEnd = jobsSrc.indexOf('async function persistMutation', listStart);
    const listFn = jobsSrc.slice(listStart, listEnd > 0 ? listEnd : listStart + 4000);
    assert.doesNotMatch(listFn, /listBookingMirrors/);
    assert.doesNotMatch(listFn, /mirrored\.length/);
    assert.match(listFn, /not_used_incomplete_mirror/);
    assert.match(listFn, /hydrateJobsFromBlobs\(timing\)/);
    assert.match(listFn, /mirror miss must never hide a valid operational Job/);
    const hydrateStart = jobsSrc.indexOf('async function hydrateJobsFromBlobs');
    const hydrateFn = jobsSrc.slice(hydrateStart, listStart);
    assert.match(hydrateFn, /store\.get\(blob\.key/);
    assert.doesNotMatch(hydrateFn, /getWithMetadata\s*\(/);
    assert.doesNotMatch(hydrateFn, /consistency:\s*'strong'/);
    assert.match(hydrateFn, /listAllBlobsStrict/);
    assert.match(hydrateFn, /ADMIN_LIST_BLOB_READ_CONCURRENCY/);
    assert.match(jobsSrc, /ADMIN_LIST_BLOB_READ_CONCURRENCY = 64/);
    assert.match(hydrateFn, /blobs\.slice\(i, i \+ ADMIN_LIST_BLOB_READ_CONCURRENCY\)/);
    assert.match(hydrateFn, /failed request, never an authoritative successful zero Jobs response/);
  });

  it('does not pass poll abort into loadJobs or loadChangeRequests', () => {
    assert.doesNotMatch(refresh, /signal:\s*requestSignal/);
  });

  it('exposes safe Server-Timing phases for the primary endpoint', () => {
    assert.match(jobsSrc, /Server-Timing/);
    for (const phase of ['cd1-auth', 'cd1-prisma', 'cd1-blob-store', 'cd1-blob-list', 'cd1-blob-read', 'cd1-project', 'cd1-serialize', 'cd1-handler']) {
      assert.match(jobsSrc, new RegExp(phase));
    }
    assert.doesNotMatch(jobsSrc, /Server-Timing[^\n]*(bookingId|email|phone)/i);
  });

  it('emits parseable endpoint timing headers without record identifiers', () => {
    const endpoint = require('../netlify/functions/admin-ops-jobs');
    const response = endpoint.jobsSyncResponse([{ id: 'timing-fixture' }], '', {
      authMs: 1.2,
      prismaMs: 2.3,
      blobStoreMs: 0,
      blobListMs: 0,
      blobReadMs: 0,
      projectionMs: 3.4,
      listJobsMs: 7.5,
      readSource: 'blobs',
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['Server-Timing'], /cd1-auth;dur=1\.2/);
    assert.match(response.headers['Server-Timing'], /cd1-prisma;dur=2\.3/);
    assert.match(response.headers['Server-Timing'], /cd1-project;dur=3\.4/);
    assert.equal(response.headers['Timing-Allow-Origin'], '*');
    assert.equal(response.headers['X-CD1-Jobs-Read-Source'], 'blobs');
    assert.doesNotMatch(response.headers['Server-Timing'], /timing-fixture/);
  });

  it('Change requests list hydrates blobs with one eventual GET per key', () => {
    const src = read('netlify/functions/admin-customer-requests.js');
    const listStart = src.indexOf("if (action === 'list')");
    const listEnd = src.indexOf("if (action === 'decide')");
    const listFn = src.slice(listStart, listEnd > 0 ? listEnd : listStart + 8000);
    assert.match(listFn, /hydrateRequestRecords\(/);
    assert.match(listFn, /listAllBlobs/);
    assert.doesNotMatch(listFn, /fetchBlobRecords/);
    assert.doesNotMatch(listFn, /getWithMetadata\s*\(/);
    assert.doesNotMatch(listFn, /consistency:\s*'strong'/);
    const hydrateStart = src.indexOf('async function hydrateRequestRecords');
    const hydrateFn = src.slice(hydrateStart, listStart);
    assert.match(hydrateFn, /store\.get\(b\.key/);
    assert.doesNotMatch(hydrateFn, /getWithMetadata\s*\(/);
  });
});
