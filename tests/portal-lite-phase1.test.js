'use strict';

/**
 * Customer portal Phase 1 — email-first entry, timed greeting, home cards,
 * empty-state 10% CTA. UI only on my-garage.html + assets/my-garage.js.
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
const html = read('my-garage.html');
const js = read('assets/my-garage.js');

describe('Phase 1 portal shell', () => {
  it('keeps the portal name and route', () => {
    assert.match(html, /<h1>My Detailing Portal<\/h1>/);
    assert.match(html, /id="portal-welcome"/);
    assert.match(html, /id="portal-home-cards"/);
  });

  it('puts email sign-in before appointment-code lookup', () => {
    const acct = html.indexOf('id="account-access"');
    const lookup = html.indexOf('id="lookup"');
    assert.ok(acct > -1 && lookup > acct, 'Open your portal must sit above lookup');
    assert.match(html, /Open your portal/);
    assert.match(html, /Already have an appointment code/);
    assert.match(html, /Find your appointment/);
    assert.match(html, /Email me a secure sign-in link/);
    assert.doesNotMatch(html, /Full portal access/);
  });

  it('keeps lookup as fallback without removing the form', () => {
    assert.match(html, /id="lk-form"/);
    assert.match(html, /id="lk-booking-id"/);
    assert.match(html, /lookup-fallback/);
  });

  it('home cards exist and do not add a third Pay securely control', () => {
    assert.match(html, /id="home-card-appt"/);
    assert.match(html, /id="home-card-pay"/);
    assert.match(html, /id="home-card-book"/);
    assert.match(html, /id="home-card-reschedule"/);
    assert.match(html, /10% off your first eligible service, up to \$40/);
    assert.doesNotMatch(html, /data-portal-pay/);
    assert.doesNotMatch(html, /id="pay-balance-link"/);
    assert.match(html, /id="pay-sticky-btn">Pay securely/);
    assert.match(html, /More actions/);
    assert.match(html, /id="customer-actions"/);
    const post = html.indexOf('id="post-auth"');
    const cards = html.indexOf('id="portal-home-cards"');
    const panel = html.indexOf('id="upcoming-panel"');
    const actions = html.indexOf('id="customer-actions"');
    assert.ok(post > -1 && cards > post && cards < panel && panel < actions, 'cards sit above the appointment, actions stay after it');
  });

  it('does not add maintenance_request to the primary HTML', () => {
    assert.doesNotMatch(html, /data-action="maintenance_request"/);
  });
});

describe('Phase 1 greeting and empty state', () => {
  it('greeting helpers live on the portal API', () => {
    assert.match(js, /function greetingPartOfDay/);
    assert.match(js, /function greetingLine/);
    assert.match(js, /function syncPortalHome/);
    assert.match(js, /Good morning/);
    assert.match(js, /Good afternoon/);
    assert.match(js, /Good evening/);
  });

  it('empty appointment copy keeps the 10% offer and the old book link', () => {
    assert.match(js, /No upcoming appointment/);
    assert.match(js, /Book with 10% off/);
    assert.match(js, /Book a service/);
    assert.match(js, /up to \$40/);
    assert.match(js, /terms-conditions\.html#welcome-offer/);
  });

  it('pay home card only scrolls to payments', () => {
    assert.match(js, /scrollPortalTarget\('payments'\)/);
    assert.doesNotMatch(js, /data-home-card="pay"[\s\S]{0,200}startPayBalance/);
  });
});

if (JSDOM) {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function boot() {
    const dom = new JSDOM(html, {
      url: 'https://example.test/my-garage.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    window.fetch = () => new Promise(() => {});
    window.scrollTo = () => {};
    if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = () => {};
    vm.runInContext(js, dom.getInternalVMContext());
    await flush();
    return { window, doc: window.document, api: window.cd1MyGarage };
  }

  describe('Phase 1 runtime', () => {
    it('greets by hour and first name', async () => {
      const { api } = await boot();
      const atHour = (h) => {
        const d = new Date();
        d.setHours(h, 0, 0, 0);
        return d;
      };
      assert.equal(api.greetingPartOfDay(atHour(8)), 'Good morning');
      assert.equal(api.greetingPartOfDay(atHour(13)), 'Good afternoon');
      assert.equal(api.greetingPartOfDay(atHour(19)), 'Good evening');
      api.state.customer = { profile: { firstName: 'Maria' } };
      assert.equal(api.greetingLine(atHour(8)), 'Good morning, Maria');
    });

    it('empty dashboard shows the 10% book card', async () => {
      const { api, doc } = await boot();
      api.state.booking = null;
      api.state.bookings = [];
      api.state.customer = { profile: { firstName: 'Alex' } };
      api.renderDashboard({ payment: {} });
      const empty = doc.getElementById('upcoming-panel').textContent;
      assert.match(empty, /No upcoming appointment/);
      assert.match(empty, /Book with 10% off/);
      assert.match(empty, /Book a service/);
      assert.equal(doc.getElementById('home-card-book-title').textContent, 'Book with 10% off');
      assert.equal(doc.getElementById('home-card-reschedule').hidden, true);
      assert.equal(doc.getElementById('home-card-pay').hidden, true);
      assert.match(doc.getElementById('portal-welcome').textContent, /Alex/);
    });

    it('signed-in booking shows appointment and reschedule cards, not a third pay button', async () => {
      const { api, doc } = await boot();
      api.state.booking = {
        id: 'CD1-P1',
        status: 'Confirmed',
        service: 'Interior Detail',
        preferredDate: '2026-09-14',
        firstName: 'Pat',
      };
      api.state.customer = { profile: { firstName: 'Pat' } };
      api.renderDashboard({
        payment: { canPay: true, canCreatePayLink: true, amountDueApproved: 190 },
      });
      assert.equal(doc.getElementById('portal-home-cards').hidden, false);
      assert.equal(doc.getElementById('home-card-appt-title').textContent, 'Interior Detail');
      assert.equal(doc.getElementById('home-card-reschedule').hidden, false);
      assert.equal(doc.getElementById('home-card-pay').hidden, false);
      assert.match(doc.getElementById('home-card-pay-title').textContent, /Due/);
      assert.equal(doc.getElementById('home-card-book-title').textContent, 'Book another service');
      assert.equal(doc.querySelectorAll('#btn-pay-balance').length, 1);
      assert.equal(doc.querySelectorAll('[data-portal-pay]').length, 0);
      assert.equal(doc.querySelectorAll('#pay-sticky-btn').length, 1);
    });
  });
}
