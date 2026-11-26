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
    assert.match(js, /\/terms-conditions#welcome-offer/);
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

    it('walks the signed-in appointment, payment, receipt, history, and a later change', async () => {
      const { api, doc, window } = await boot();
      const widths = [390, 1280];
      for (const width of widths) {
        window.innerWidth = width;
        api.state.scope = 'account';
        api.state.customerAccountId = 'acct_alice';
        api.state.session = true;
        api.state.customer = { profile: { firstName: 'Alice' } };
        const history = [];
        for (let i = 0; i < 10; i += 1) {
          history.push({
            id: `CD1-H${i}`,
            status: 'Completed',
            jobStatus: 'completed_paid',
            paymentStatus: 'paid',
            service: `Past service ${i}`,
            confirmedDate: `2020-01-${String(i + 1).padStart(2, '0')}`,
            totalPrice: 80 + i,
            appointmentPublicRef: `aptr_hist0${i}aaaa`,
          });
        }
        history.push({
          id: 'CD1-BAD',
          status: 'Completed',
          jobStatus: 'completed',
          service: 'Undated visit',
          preferredDate: 'next Tuesday',
          confirmedDate: '',
          appointmentPublicRef: 'aptr_baddateaaaa',
        });
        api.state.bookings = [
          {
            id: 'CD1-NOW',
            status: 'Confirmed',
            jobStatus: 'confirmed',
            service: 'Interior Detail',
            confirmedDate: '2026-11-18',
            preferredDate: '2026-11-18',
            address: '1 Main St',
            appointmentPublicRef: 'aptr_currentaaa',
          },
          ...history,
        ];
        api.state.booking = api.state.bookings[0];
        api.state.historyLimit = 8;
        const payment = {
          approvedCents: 19000,
          settledCents: 5000,
          remainingCents: 14000,
          amountDueApproved: 140,
          approvedTotal: 190,
          canPay: true,
          canCreatePayLink: true,
          paymentStatus: 'partially_paid',
        };
        api.renderDashboard({ payment });
        const hero = doc.getElementById('upcoming-panel').textContent;
        assert.match(hero, /Interior Detail/);
        assert.match(hero, /2026-11-18/);
        assert.match(hero, /Partially paid/);
        assert.match(hero, /\$140\.00/);
        assert.equal(doc.getElementById('home-card-reschedule').hidden, false);
        assert.equal(doc.getElementById('home-card-book-title').textContent, 'Book another service');
        assert.equal(doc.querySelectorAll('#history-list li').length, 8);
        assert.equal(doc.getElementById('history-more').hidden, false);
        assert.match(doc.getElementById('history-more').textContent, /Show more/);
        doc.getElementById('history-more').click();
        assert.ok(doc.querySelectorAll('#history-list li').length > 8);
        assert.match(doc.getElementById('history-list').textContent, /Date unavailable/);
        assert.doesNotMatch(doc.getElementById('history-list').textContent, /next Tuesday/);
        const paymentReceipt = doc.querySelector('[data-receipt-link][href*="type=payment"]');
        assert.ok(paymentReceipt);
        assert.match(paymentReceipt.getAttribute('href'), /bookingId=CD1-NOW/);
        assert.equal(doc.querySelector('[data-receipt-link][href*="type=final"]'), null);
        api.state.booking = history[history.length - 1];
        api.renderDashboard({ payment });
        assert.match(doc.getElementById('upcoming-panel').textContent, /Date unavailable/);
        assert.doesNotMatch(doc.getElementById('upcoming-panel').textContent, /next Tuesday/);
        api.state.booking = api.state.bookings[0];

        api.state.booking = {
          ...api.state.bookings[0],
          status: 'Completed',
          jobStatus: 'completed_paid',
          customerStatus: 'Completed',
          completedAt: '2026-11-18T16:00:00.000Z',
        };
        api.renderDashboard({
          payment: {
            approvedCents: 19000,
            settledCents: 19000,
            remainingCents: 0,
            amountDueApproved: 0,
            approvedTotal: 190,
            canPay: false,
            paymentStatus: 'paid',
          },
        });
        const after = doc.getElementById('upcoming-panel').textContent;
        assert.match(after, /Paid/);
        assert.doesNotMatch(after, /Payment Due|not_due/);
        const receipt = doc.querySelector('[data-receipt-link][href*="type=final"]');
        assert.ok(receipt);
        assert.match(receipt.getAttribute('href'), /bookingId=CD1-NOW/);
        assert.doesNotMatch(doc.body.textContent, /techPayout|adminNotes|CD1-OTHER/);

        api.state.customerAccountId = 'acct_bob';
        api.state.bookings = [{
          id: 'CD1-OTHER',
          status: 'Confirmed',
          service: 'Other account',
          confirmedDate: '2026-12-01',
        }];
        api.state.booking = api.state.bookings[0];
        api.renderDashboard({ payment: { approvedCents: 100, settledCents: 0, remainingCents: 100 } });
        assert.match(doc.getElementById('upcoming-panel').textContent, /Other account/);
        assert.doesNotMatch(doc.body.textContent, /Interior Detail|CD1-NOW|CD1-H0/);
      }
    });
  });
}
