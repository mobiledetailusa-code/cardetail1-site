'use strict';

/**
 * Admin Ops first-load timeouts: Jobs + Change requests both died at 25s
 * because refreshAll passed a shared poll AbortSignal into both loaders and
 * listJobs double-fetched every booking blob with strong consistency.
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

  it('starts Jobs and Change requests together and paints Jobs first', () => {
    assert.doesNotMatch(refresh, /Promise\.allSettled/);
    assert.match(refresh, /const jobsP = settle\(loadJobs\(\)\)/);
    assert.match(refresh, /const changeP = settle\(loadChangeRequests\(\)\)/);
    assert.match(refresh, /const jobsR = await jobsP/);
    assert.match(refresh, /await changeP/);
    assert.doesNotMatch(refresh, /loadJobs\(null,\s*\{\s*signal:\s*requestSignal/);
    assert.doesNotMatch(refresh, /loadChangeRequests\(\{\s*signal:\s*requestSignal/);
    assert.match(refresh, /aborted\(\)/);
    assert.match(html, /SOURCE_FETCH_TIMEOUT_MS = 25000/);
  });

  it('poll controller budget covers Jobs 25s then Change requests 40s', () => {
    assert.match(html, /requestTimeoutMs:\s*90000/);
    assert.match(html, /SOURCE_FETCH_TIMEOUT_MS = 25000/);
    assert.match(html, /CHANGE_REQUESTS_FETCH_TIMEOUT_MS = 40000/);
    assert.match(html, /timeoutMs:\s*CHANGE_REQUESTS_FETCH_TIMEOUT_MS/);
  });

  it('per-source api timeout still reports timeout not aborted', () => {
    assert.match(html, /if \(timedOut\) throw new Error\('timeout'\)/);
    assert.match(html, /Retry jobs/);
    assert.match(html, /data-retry-source/);
    assert.match(html, /Retry all/);
  });

  it('listJobs prefers Prisma rows and hydrates Blobs only when that list is empty', () => {
    const listStart = jobsSrc.indexOf('async function listJobs');
    const listEnd = jobsSrc.indexOf('async function persistMutation', listStart);
    const listFn = jobsSrc.slice(listStart, listEnd > 0 ? listEnd : listStart + 4000);
    assert.match(listFn, /listBookingMirrors\(\)/);
    assert.match(listFn, /mirrored\.length/);
    assert.match(listFn, /hydrateJobsFromBlobs\(\)/);
    assert.match(listFn, /Empty Prisma[\s\S]*hydrate Blobs/);
    const hydrateStart = jobsSrc.indexOf('async function hydrateJobsFromBlobs');
    const hydrateFn = jobsSrc.slice(hydrateStart, listStart);
    assert.match(hydrateFn, /store\.get\(blob\.key/);
    assert.doesNotMatch(hydrateFn, /getWithMetadata\s*\(/);
    assert.doesNotMatch(hydrateFn, /consistency:\s*'strong'/);
  });

  it('does not pass poll abort into loadJobs or loadChangeRequests', () => {
    assert.doesNotMatch(refresh, /signal:\s*requestSignal/);
  });

  it('Change requests pending list prefers the open catalog over a full-store hydrate', () => {
    const src = read('netlify/functions/admin-customer-requests.js');
    const listStart = src.indexOf("if (action === 'list')");
    const listEnd = src.indexOf("if (action === 'decide')");
    const listFn = src.slice(listStart, listEnd > 0 ? listEnd : src.length);
    assert.match(listFn, /readOpenCatalog/);
    assert.match(listFn, /hydrateRequestRecords\(/);
    assert.match(listFn, /listAllBlobs/);
    assert.doesNotMatch(listFn, /fetchBlobRecords/);
    assert.doesNotMatch(listFn, /getWithMetadata\s*\(/);
    const lib = read('netlify/lib/customer-change-requests.js');
    assert.match(lib, /OPEN_CATALOG_KEY = '_open_catalog'/);
    assert.match(lib, /async function hydrateRequestRecords/);
    assert.match(lib, /store\.get\(key/);
    assert.doesNotMatch(lib.slice(lib.indexOf('async function hydrateRequestRecords')), /getWithMetadata\s*\(/);
  });
});
