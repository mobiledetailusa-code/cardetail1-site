'use strict';

/**
 * Phase 2 — the SMS/email /a?t= access link is portal login.
 * Confirm/error pages point at email sign-in, not CD1 lookup.
 * GET still never consumes. Twilio SMS templates are unchanged.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const accessSrc = read('netlify/functions/customer-appointment-access.js');
const garageHtml = read('my-garage.html');
const garageJs = read('assets/my-garage.js');
const smsSrc = read('netlify/lib/sms-templates.js');
const tokenSrc = read('netlify/lib/appointment-access-token.js');

const access = require('../netlify/functions/customer-appointment-access');

function assertNoCd1LookupPush(html) {
  assert.doesNotMatch(html, /code and phone/i);
  assert.doesNotMatch(html, /Find appointment using/i);
  assert.doesNotMatch(html, /CD1-/);
}

describe('access-link pages are portal login, not CD1 lookup', () => {
  it('confirm page signs the customer into the portal without consuming on GET', () => {
    const page = access.__test.confirmOpenPage('aat_testtokenvalue', 'caa_test');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Open your detailing portal/i);
    assert.match(page.body, /Open my portal/i);
    assert.match(page.body, /appointment in focus/i);
    assert.match(page.body, /email scanners/i);
    assert.match(page.body, /action" value="exchange"/);
    assert.match(page.body, /\/my-garage#account-access/);
    assert.doesNotMatch(page.body, /#lookup/);
    assert.doesNotMatch(page.body, /View my appointment/i);
    assertNoCd1LookupPush(page.body);
  });

  it('invalid / expired / used pages lead with email sign-in; lookup is support-only', () => {
    const invalid = access.__test.invalidLinkPage('caa_inv');
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.body, /\/my-garage#account-access/);
    assert.match(invalid.body, /Email me a sign-in link/);
    assert.match(invalid.body, /do not need an appointment code/i);
    assert.match(invalid.body, /Have an appointment code from support/);
    assert.match(invalid.body, /\/my-garage#lookup/);
    assertNoCd1LookupPush(invalid.body);

    const expired = access.__test.expiredLinkPage('aat_expired', 'caa_exp');
    assert.equal(expired.statusCode, 410);
    assert.match(expired.body, /has expired/i);
    assert.match(expired.body, /Send me a new link/);
    assert.match(expired.body, /\/my-garage#account-access/);
    assert.match(expired.body, /Have an appointment code from support/);
    assertNoCd1LookupPush(expired.body);

    const used = access.__test.usedLinkPage('aat_used', 'caa_used');
    assert.equal(used.statusCode, 410);
    assert.match(used.body, /already used/i);
    assert.match(used.body, /email yourself a sign-in link/i);
    assert.match(used.body, /\/my-garage#account-access/);
    assertNoCd1LookupPush(used.body);
  });

  it('session-failed and unavailable pages do not send people to CD1 lookup', () => {
    const failed = access.__test.sessionFailedPage('aat_fail', 'caa_fail');
    assert.match(failed.body, /Could not open your portal/i);
    assert.match(failed.body, /\/my-garage#account-access/);
    assert.doesNotMatch(failed.body, /#lookup/);
    assertNoCd1LookupPush(failed.body);

    const busy = access.__test.temporaryUnavailablePage('caa_busy');
    assert.match(busy.body, /\/my-garage#account-access/);
    assert.doesNotMatch(busy.body, /#lookup/);
    assertNoCd1LookupPush(busy.body);
  });

  it('GET beginAccess never consumes; exchange still focuses the portal', () => {
    const beginStart = accessSrc.indexOf('async function beginAccess');
    const beginEnd = accessSrc.indexOf('async function exchangeToken');
    assert.ok(beginStart >= 0 && beginEnd > beginStart);
    const beginBody = accessSrc.slice(beginStart, beginEnd);
    assert.doesNotMatch(beginBody, /consumeAppointmentAccessToken/);
    assert.match(beginBody, /confirmOpenPage/);

    assert.match(accessSrc, /buildPortalFocusPath/);
    assert.match(tokenSrc, /\/my-garage\?appointment=/);
  });
});

describe('access-link recovery copy stays off CD1', () => {
  it('function source does not tell customers to use code and phone', () => {
    assert.doesNotMatch(accessSrc, /code and phone/i);
    assert.doesNotMatch(accessSrc, /Find appointment using code/i);
    assert.match(accessSrc, /#account-access/);
    assert.match(accessSrc, /Have an appointment code from support/);
  });

  it('500 handler points at email sign-in', () => {
    const catchIdx = accessSrc.lastIndexOf("title: 'Something went wrong'");
    assert.ok(catchIdx > 0);
    const catchHtml = accessSrc.slice(catchIdx, catchIdx + 800);
    assert.match(catchHtml, /sign in with the email on your booking/i);
    assert.doesNotMatch(catchHtml, /code and phone/i);
  });
});

describe('SMS and garage lookup stay as they were', () => {
  it('does not put CD1 or a new CTA into SMS view links', () => {
    assert.match(smsSrc, /function viewLink/);
    assert.match(smsSrc, /View: \$\{url\}/);
    assert.doesNotMatch(smsSrc, /CD1-/);
  });

  it('garage still has collapsed lookup for support and Phase 1 email-first', () => {
    assert.match(garageHtml, /Already have an appointment code/);
    assert.match(garageHtml, /Find your appointment/);
    assert.match(garageHtml, /id="account-access"/);
    assert.match(garageHtml, /Open your portal/);
    assert.match(garageJs, /function applyPortalEntryHash/);
    assert.match(garageJs, /hash === 'lookup'/);
    assert.match(garageJs, /hash === 'account-access'/);
  });
});

if (JSDOM) {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function bootAt(url) {
    const html = read('my-garage.html');
    const js = read('assets/my-garage.js');
    const dom = new JSDOM(html, {
      url,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    window.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false }),
    });
    window.scrollTo = () => {};
    if (!window.Element.prototype.scrollIntoView) {
      window.Element.prototype.scrollIntoView = function scrollIntoViewStub() {
        this._scrolled = true;
      };
    }
    vm.runInContext(js, dom.getInternalVMContext());
    for (let i = 0; i < 20; i += 1) await flush();
    return { window, doc: window.document, api: window.cd1MyGarage };
  }

  describe('portal entry hash', () => {
    it('opens the lookup details for #lookup (support / legacy public links)', async () => {
      const { doc, api } = await bootAt('https://example.test/my-garage.html#lookup');
      assert.equal(typeof api.applyPortalEntryHash, 'function');
      const lookup = doc.getElementById('lookup');
      assert.ok(lookup);
      assert.equal(lookup.open, true);
    });

    it('focuses email sign-in for #account-access', async () => {
      const { doc } = await bootAt('https://example.test/my-garage.html#account-access');
      const email = doc.getElementById('acct-email');
      assert.equal(doc.activeElement, email);
    });
  });
}
