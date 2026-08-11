'use strict';

/**
 * Owner Studio pages must gate unauthenticated visitors the same way admin-ops.html
 * does, instead of rendering the control plane and relying on a note in the page.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const GATE = read('assets/owner-studio/session-gate.js');
const STUDIO_PAGES = ['admin-owner-studio.html', 'admin-owner-studio-catalog.html'];

/** Run the gate against a stubbed browser and report what it did. */
function runGate({ token, validateResponse, fetchThrows }) {
  const calls = { redirected: null, cleared: false, fetches: [] };
  const context = {
    console,
    location: { replace(url) { calls.redirected = url; } },
    window: {},
    fetch: async (url, init) => {
      calls.fetches.push({ url, init });
      if (fetchThrows) throw new Error('network down');
      return { json: async () => validateResponse };
    },
  };
  context.window = context;
  context.CD1AdminSession = {
    getToken: () => token,
    clearToken: () => { calls.cleared = true; },
    syncWindowKey: () => {},
  };
  vm.createContext(context);
  vm.runInContext(GATE, context);
  return calls;
}

describe('Owner Studio session gate', () => {
  it('is loaded by every Owner Studio page, after the session client it depends on', () => {
    for (const page of STUDIO_PAGES) {
      const html = read(page);
      const sessionClient = html.indexOf('/netlify/lib/admin-session-client.js');
      const gate = html.indexOf('/assets/owner-studio/session-gate.js');
      assert.notEqual(gate, -1, `${page} does not load the session gate`);
      assert.ok(sessionClient !== -1 && sessionClient < gate,
        `${page} must load admin-session-client.js before the gate that uses it`);
    }
  });

  it('redirects to the login page when no token is present, without calling the API', async () => {
    const calls = runGate({ token: '' });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.redirected, '/admin');
    assert.equal(calls.fetches.length, 0, 'a missing token needs no round trip');
  });

  it('redirects and clears the token when the session is rejected', async () => {
    const calls = runGate({ token: 'stale', validateResponse: { ok: false } });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.redirected, '/admin');
    assert.equal(calls.cleared, true, 'a rejected token must not survive the redirect');
    assert.equal(calls.fetches[0].url, '/.netlify/functions/admin-auth');
    assert.equal(JSON.parse(calls.fetches[0].init.body).action, 'validate');
    assert.equal(calls.fetches[0].init.headers['x-admin-key'], 'stale');
  });

  it('keeps a valid session on the page', async () => {
    const calls = runGate({ token: 'good', validateResponse: { ok: true } });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.redirected, null);
    assert.equal(calls.cleared, false);
  });

  it('fails open on a network error rather than stranding the operator', async () => {
    const calls = runGate({ token: 'good', fetchThrows: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.redirected, null, 'a transient blip must not bounce a signed-in operator');
  });

  it('never hides the document, which would blank the page if the script failed', () => {
    assert.doesNotMatch(GATE, /visibility\s*[:=]\s*['"]?hidden/);
    assert.doesNotMatch(read('assets/owner-studio/studio.css'), /data-os-gate/);
  });
});
