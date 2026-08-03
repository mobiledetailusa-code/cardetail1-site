/**
 * Customer Portal Lite (Slice 2).
 *
 * Structure assertions run on source. The fixture block boots the real
 * my-garage.html + assets/my-garage.js under jsdom with the network stubbed,
 * then renders the approved staging fixture:
 *
 *   2025 Ford Bronco      Maintenance Detail $215 + Pet Hair $95 + Odor $90 = $400
 *   2023 Yamaha Boats 222S Essential Marine $462 + Rain-X $25             = $487
 *   grand total $887
 */
const test = require('node:test');
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
const garageHtml = read('my-garage.html');
const garageJs = read('assets/my-garage.js');

/* â”€â”€ Structure â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

test('the five approved customer sections exist', () => {
  assert.match(garageHtml, /id="upcoming-h">Current appointment</);
  assert.match(garageHtml, /id="pending-requests-section" hidden/);
  assert.match(garageHtml, /id="payments" aria-labelledby="pay-h"/);
  assert.match(garageHtml, /id="pay-h">Payments &amp; Receipts</);
  assert.match(garageHtml, /id="profile-section"[^>]*hidden/);
});

test('Requests, Profile and Service Addresses are conditional, never empty cards', () => {
  for (const id of ['pending-requests-section', 'profile-section', 'addresses-section']) {
    assert.match(garageHtml, new RegExp(`id="${id}"[^>]*hidden`), `${id} must start hidden`);
  }
});

test('appointment and history sections hide themselves when empty', () => {
  assert.match(garageHtml, /id="appointments-section"[^>]*hidden/);
  assert.match(garageHtml, /id="history-section"[^>]*hidden/);
  assert.match(garageJs, /\$\('appointments-section'\) && show\(\$\('appointments-section'\), !!upcoming\.length\)/);
  assert.match(garageJs, /\$\('history-section'\) && show\(\$\('history-section'\), !!hist\.length\)/);
});

test('incomplete customer modules are hidden but not deleted', () => {
  assert.match(garageHtml, /id="maintenance-section"[^>]*hidden/);
  assert.match(garageHtml, /id="comm-section"[^>]*hidden/);
  // Markup and backends retained â€” hidden from the primary UI only.
  assert.match(garageHtml, /id="maintenance-list"/);
  assert.match(garageHtml, /id="comm-empty"/);
  // The customer-facing entry point is gone.
  assert.doesNotMatch(garageHtml, /data-action="maintenance_request"/);
});

test('profile keeps only name, email and phone', () => {
  const section = garageHtml.slice(
    garageHtml.indexOf('id="profile-section"'),
    garageHtml.indexOf('id="addresses-section"')
  );
  // Name is editable; verified email and phone stay read-only in profile-view.
  assert.match(section, /id="pf-first"/);
  assert.match(section, /id="pf-last"/);
  assert.match(section, /id="profile-view"/);
  assert.match(section, /Verified email and phone are read-only/);
  // Display name, preferred contact and timezone are out of the Lite profile.
  assert.match(section, /id="pf-extended-fields" hidden/);
  const extended = section.slice(
    section.indexOf('id="pf-extended-fields"'),
    section.indexOf('id="pf-save"')
  );
  for (const id of ['pf-display', 'pf-channel', 'pf-tz']) {
    assert.ok(extended.includes(`id="${id}"`), `${id} must live inside the hidden block`);
  }
});

test('no dead receipt control is presented to the customer', () => {
  assert.doesNotMatch(garageJs, /'View Receipt'/);
  assert.doesNotMatch(garageHtml, />View Receipt</);
  assert.doesNotMatch(garageHtml, /id="btn-view-receipt"/);
});

test('package accordions from PR #148 are preserved with correct ARIA', () => {
  assert.match(garageJs, /class="btn ghost sm package-details-toggle"/);
  assert.match(garageJs, /aria-expanded="false" aria-controls="/);
  assert.match(garageJs, /class="package-details-panel" hidden/);
  assert.match(garageJs, /package-details-unavailable/);
  assert.match(garageJs, /<span class="package-toggle-label">View services<\/span>/);
  assert.match(garageJs, /labelEl\.textContent = next \? 'Hide services' : 'View services'/);
});

test('one shared payment controller, no second payment authority', () => {
  const starts = [...garageJs.matchAll(/startPayBalance\(\)/g)].length;
  assert.ok(starts >= 2, 'both CTAs route through startPayBalance');
  assert.equal([...garageJs.matchAll(/async function startPayBalance\b/g)].length, 1);
  assert.equal([...garageJs.matchAll(/customer-balance-payment-intent/g)].length, 1);
});

/* â”€â”€ Fixture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

if (JSDOM) {
  const FIXTURE = {
    id: 'CD1-FIXTURE-SLICE2',
    status: 'Confirmed',
    customerStatus: 'Confirmed',
    preferredDate: '2026-09-14',
    confirmedDate: '2026-09-14',
    service: 'Multi-vehicle detail',
    address: '1 Test Way, Newark NJ',
    vehicles: [
      {
        vehicleId: 'veh-bronco',
        vehicleLabel: '2025 Ford Bronco',
        year: 2025, make: 'Ford', model: 'Bronco',
        package: 'Maintenance Detail',
        packageName: 'Maintenance Detail',
        packagePrice: 215,
        addons: [
          { name: 'Pet Hair Removal', price: 95 },
          { name: 'Odor Treatment & Sanitize', price: 90 },
        ],
        subtotal: 400,
      },
      {
        vehicleId: 'veh-yamaha',
        vehicleLabel: '2023 Yamaha Boats 222S',
        year: 2023, make: 'Yamaha Boats', model: '222S',
        package: 'Essential Marine',
        packageName: 'Essential Marine',
        packagePrice: 462,
        addons: [{ name: 'Rain-X Glass Treatment', price: 25 }],
        subtotal: 487,
      },
    ],
    approvedFinalAmount: 887,
    totalPrice: 887,
  };

  const PAYMENT = {
    canPay: true,
    canCreatePayLink: true,
    amountDueApproved: 887,
    approvedCents: 88700,
    settledCents: 0,
    remainingCents: 88700,
    state: 'due',
  };

  // boot() binds the delegated UI handlers asynchronously, so let its
  // microtasks settle before rendering the fixture.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function bootPortal(booking, payment, changeRequests) {
    const errors = [];
    const dom = new JSDOM(garageHtml, {
      url: 'https://example.test/my-garage.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    window.fetch = () => new Promise(() => {});
    window.scrollTo = () => {};
    window.alert = () => {};
    if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = () => {};
    try {
      vm.runInContext(garageJs, dom.getInternalVMContext());
    } catch (e) {
      errors.push(String(e && e.message));
    }
    await flush();
    const api = window.cd1MyGarage;
    if (api) {
      api.state.booking = booking;
      api.state.bookings = [booking];
      api.state.payment = payment;
      api.state.changeRequests = changeRequests || [];
      try {
        api.renderDashboard({ payment: payment });
      } catch (e) {
        errors.push(String(e && e.message));
      }
    }
    return { doc: window.document, window, api, errors };
  }

  test('fixture: the portal boots and renders without error', async () => {
    const { api, errors } = await bootPortal(FIXTURE, PAYMENT);
    assert.ok(api, 'cd1MyGarage did not initialize');
    assert.deepEqual(errors, []);
  });

  test('fixture: both vehicle cards start collapsed', async () => {
    const { doc } = await bootPortal(FIXTURE, PAYMENT);
    const toggles = [...doc.querySelectorAll('.package-details-toggle')];
    assert.equal(toggles.length, 2, 'one accordion per vehicle');
    for (const t of toggles) {
      assert.equal(t.getAttribute('aria-expanded'), 'false');
      assert.equal(t.textContent.trim().startsWith('View services'), true);
      const panel = doc.getElementById(t.getAttribute('aria-controls'));
      assert.ok(panel, 'aria-controls must resolve');
      assert.equal(panel.hasAttribute('hidden'), true, 'panel starts hidden');
    }
  });

  test('fixture: expanding one vehicle does not expand the other', async () => {
    const { doc, window } = await bootPortal(FIXTURE, PAYMENT);
    const [first, second] = [...doc.querySelectorAll('.package-details-toggle')];
    first.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    assert.equal(first.getAttribute('aria-expanded'), 'true');
    assert.equal(second.getAttribute('aria-expanded'), 'false');
    assert.equal(doc.getElementById(first.getAttribute('aria-controls')).hasAttribute('hidden'), false);
    assert.equal(doc.getElementById(second.getAttribute('aria-controls')).hasAttribute('hidden'), true);
    assert.match(first.textContent, /Hide services/);
    assert.match(second.textContent, /View services/);
  });

  test('fixture: packages and add-ons stay attached to the right vehicle', async () => {
    const { doc } = await bootPortal(FIXTURE, PAYMENT);
    const cards = [...doc.querySelectorAll('.vehicle-breakdown[data-vehicle-id]')];
    assert.equal(cards.length, 2, 'one card per vehicle');

    // Requests target the stable vehicle id, not an array index or a label.
    assert.deepEqual(
      cards.map((c) => c.getAttribute('data-vehicle-id')).sort(),
      ['veh-bronco', 'veh-yamaha']
    );

    const bronco = cards.find((c) => c.getAttribute('data-vehicle-id') === 'veh-bronco').textContent;
    const boat = cards.find((c) => c.getAttribute('data-vehicle-id') === 'veh-yamaha').textContent;

    assert.match(bronco, /2025 Ford Bronco/);
    assert.match(bronco, /Maintenance Detail/);
    assert.match(bronco, /Pet Hair Removal/);
    assert.match(bronco, /Odor Treatment/);
    assert.match(bronco, /\$400/, 'Bronco subtotal');
    assert.doesNotMatch(bronco, /Rain-X/, 'boat add-on leaked into the Bronco');
    assert.doesNotMatch(bronco, /Essential Marine/, 'boat package leaked into the Bronco');

    assert.match(boat, /2023 Yamaha Boats 222S/);
    assert.match(boat, /Essential Marine/);
    assert.match(boat, /Rain-X Glass Treatment/);
    assert.match(boat, /\$487/, 'boat subtotal');
    assert.doesNotMatch(boat, /Pet Hair Removal/, 'Bronco add-on leaked into the boat');
    assert.doesNotMatch(boat, /Odor Treatment/, 'Bronco add-on leaked into the boat');
    assert.doesNotMatch(boat, /Maintenance Detail/, 'Bronco package leaked into the boat');
  });

  test('fixture: an unresolved old booking shows the safe fallback, never invented contents', async () => {
    const legacy = JSON.parse(JSON.stringify(FIXTURE));
    legacy.vehicles = [{ vehicleId: 'veh-old', vehicleLabel: '2014 Ford F-150', package: 'Legacy Package' }];
    const { doc, window } = await bootPortal(legacy, PAYMENT);
    const toggle = doc.querySelector('.package-details-toggle');
    assert.ok(toggle, 'accordion still renders for an old booking');
    toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const panel = doc.getElementById(toggle.getAttribute('aria-controls'));
    assert.match(panel.textContent, /unavailable for this older booking|Contact us/i);
  });

  test('fixture: authoritative totals are $400 / $487 / $887', async () => {
    const { doc } = await bootPortal(FIXTURE, PAYMENT);
    const body = doc.body.textContent;
    assert.match(body, /\$400\.00|\$400\b/, 'Bronco subtotal missing');
    assert.match(body, /\$487\.00|\$487\b/, 'boat subtotal missing');
    assert.match(body, /\$887\.00|\$887\b/, 'grand total missing');
  });

  test('fixture: exactly one payment CTA exists in the DOM', async () => {
    const { doc } = await bootPortal(FIXTURE, PAYMENT);
    const inline = doc.querySelectorAll('#btn-pay-balance');
    const sticky = doc.querySelectorAll('#pay-sticky-btn');
    assert.equal(inline.length, 1, 'one inline CTA');
    assert.equal(sticky.length, 1, 'one sticky CTA');
    // No third control, and no legacy duplicates.
    assert.equal(doc.querySelectorAll('#pay-balance-link').length, 0);
    assert.equal(doc.querySelectorAll('[data-portal-pay]').length, 0);
    assert.match(inline[0].textContent, /^Pay securely/);
    assert.match(sticky[0].textContent, /^Pay securely/);
  });

  test('fixture: a settled booking shows Paid and no payment CTA', async () => {
    const settled = {
      canPay: false, canCreatePayLink: false,
      amountDueApproved: 0, approvedCents: 88700, settledCents: 88700, remainingCents: 0,
      state: 'paid', amountPaid: 887,
    };
    const { doc } = await bootPortal(FIXTURE, settled);
    assert.equal(doc.querySelectorAll('#btn-pay-balance').length, 0, 'no CTA when nothing is due');
    assert.equal(doc.getElementById('pay-sticky-bar').hidden, true, 'sticky bar hidden when settled');
    assert.ok(doc.querySelector('[data-pay-settled]'), 'Paid state must be shown');
  });

  test('fixture: canPay false never renders an enabled CTA', async () => {
    const locked = {
      canPay: false, canCreatePayLink: false,
      amountDueApproved: 887, approvedCents: 88700, settledCents: 0, remainingCents: 88700,
      state: 'locked',
    };
    const { doc } = await bootPortal(FIXTURE, locked);
    assert.equal(doc.querySelectorAll('#btn-pay-balance').length, 0);
    assert.equal(doc.getElementById('pay-sticky-bar').hidden, true);
  });

  test('fixture: Requests section stays hidden when there are no requests', async () => {
    const { doc } = await bootPortal(FIXTURE, PAYMENT, []);
    assert.equal(doc.getElementById('pending-requests-section').hidden, true);
  });

  test('fixture: a pending vehicle-removal request renders against its vehicle id', async () => {
    const requests = [{
      id: 'req-1',
      requestType: 'vehicle_remove_request',
      status: 'pending',
      vehicleId: 'veh-bronco',
      createdAt: '2026-09-01',
      requestedState: { vehicleId: 'veh-bronco', vehicleLabel: '2025 Ford Bronco' },
    }];
    const { doc } = await bootPortal(FIXTURE, PAYMENT, requests);
    const section = doc.getElementById('pending-requests-section');
    assert.equal(section.hidden, false, 'Requests section must appear when a request exists');
    assert.match(section.textContent, /pending/i);
  });

  test('fixture: incomplete modules never appear for the customer', async () => {
    const { doc } = await bootPortal(FIXTURE, PAYMENT);
    for (const id of ['maintenance-section', 'comm-section']) {
      assert.equal(doc.getElementById(id).hidden, true, `${id} must stay hidden`);
    }
    assert.equal(doc.querySelectorAll('[data-action="maintenance_request"]').length, 0);
  });

  test('fixture: rendering does not issue any network request', async () => {
    let calls = 0;
    const dom = new JSDOM(garageHtml, { url: 'https://example.test/my-garage.html', runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.fetch = () => { calls += 1; return new Promise(() => {}); };
    dom.window.scrollTo = () => {};
    vm.runInContext(garageJs, dom.getInternalVMContext());
    const api = dom.window.cd1MyGarage;
    api.state.booking = FIXTURE;
    api.state.bookings = [FIXTURE];
    api.state.payment = PAYMENT;
    api.state.changeRequests = [];
    calls = 0;
    api.renderDashboard({ payment: PAYMENT });
    assert.equal(calls, 0, 'rendering must not refetch booking, payment, requests or catalog');
  });

  test('fixture: opening an accordion refetches nothing', async () => {
    let calls = 0;
    const dom = new JSDOM(garageHtml, { url: 'https://example.test/my-garage.html', runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.fetch = () => { calls += 1; return new Promise(() => {}); };
    dom.window.scrollTo = () => {};
    vm.runInContext(garageJs, dom.getInternalVMContext());
    const api = dom.window.cd1MyGarage;
    api.state.booking = FIXTURE;
    api.state.bookings = [FIXTURE];
    api.state.payment = PAYMENT;
    api.state.changeRequests = [];
    api.renderDashboard({ payment: PAYMENT });
    calls = 0;
    const toggle = dom.window.document.querySelector('.package-details-toggle');
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(calls, 0, 'expanding a package must not hit the network');
  });
}


