'use strict';

/**
 * The upcoming-appointment card is the first thing a signed-in customer sees,
 * and the buttons that change the booking sit directly below it in
 * my-garage.html. When the card renders every scheduling preference and site
 * note inline, those buttons land off-screen — the information is not wrong,
 * it is in the way. These tests pin the split: essentials and money stay
 * inline, the rest stays behind a disclosure.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'assets', 'my-garage.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'my-garage.html'), 'utf8');

/**
 * Everything that composes the hero card: the inline rows are assembled into
 * essentialRows just above the template, so the region starts there.
 */
function heroTemplate() {
  const start = js.indexOf('var essentialRows =');
  assert.ok(start > -1, 'essential rows block not found');
  const end = js.indexOf("'</div>';", start);
  assert.ok(end > start, 'hero card template end not found');
  return js.slice(start, end);
}

describe('upcoming appointment card', () => {
  it('leads with date, arrival, location and the money block', () => {
    const hero = heroTemplate();
    for (const label of ['<dt>Date</dt>', '<dt>Arrival window</dt>', '<dt>Location</dt>']) {
      assert.ok(hero.includes(label), `${label} must stay inline`);
    }
    assert.ok(hero.includes('booking-financial-summary'), 'totals stay on the card');
    const money = hero.indexOf('booking-financial-summary');
    const details = hero.indexOf('appt-details');
    assert.ok(money < details, 'payment state comes before the collapsed detail');
  });

  it('does not repeat the status and service it already shows as heading', () => {
    const hero = heroTemplate();
    assert.ok(hero.includes('card-kicker'), 'status still shows as the kicker');
    assert.ok(hero.includes('card-title'), 'service still shows as the title');
    assert.ok(!hero.includes('<dt>Status</dt>'), 'status must not repeat in the grid');
    assert.ok(!hero.includes('<dt>Service</dt>'), 'service must not repeat in the grid');
  });

  it('states one arrival window instead of preferred, confirmed and pending', () => {
    const hero = heroTemplate();
    assert.ok(!hero.includes('Confirmed date / window'), 'confirmed row duplicated Date + Arrival window');
    assert.match(js, /arrivalPrimary/);
    // Still tells the customer their requested window while it is unconfirmed.
    assert.match(js, /Pending confirmation/);
  });

  it('keeps scheduling preferences and site notes behind a disclosure', () => {
    const hero = heroTemplate();
    const idx = hero.indexOf('<details class="appt-details"');
    assert.ok(idx > -1, 'secondary detail must be collapsible');
    const inside = hero.slice(idx);
    assert.ok(inside.includes('siteRows'), 'preferences render inside the disclosure');
    assert.match(js, /siteRows \+= '<div><dt>Preferred date/);
    assert.match(js, /siteRows \+= offerHtml/);
  });

  it('still carries every field the booking contract requires', () => {
    // booking-conversion-readiness asserts these exist; collapsing must not
    // become deleting.
    for (const field of [
      'preferredArrivalWindow', 'alternatePreferredDate', 'waterAvailable',
      'electricityAvailable', 'Additional notes', 'Date flexibility', 'Travel fee',
    ]) {
      assert.ok(js.includes(field), `${field} must still render somewhere`);
    }
  });

  it('the change-booking actions still follow the card directly', () => {
    const panel = html.indexOf('id="upcoming-panel"');
    const actions = html.indexOf('id="customer-actions"');
    assert.ok(panel > -1 && actions > panel, 'actions stay immediately after the card');
    for (const action of ['reschedule_request', 'address_update', 'cancellation_request']) {
      assert.ok(html.includes(action), `${action} button must remain`);
    }
  });

  it('the disclosure is styled without clipping its own text', () => {
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    assert.match(style, /\.appt-details\{/);
    assert.match(style, /\.appt-details>summary\{[^}]*min-height:44px/);
    const clipping = style.match(/[^{}]*\{[^}]*overflow:\s*hidden[^}]*\}/g) || [];
    for (const rule of clipping) {
      assert.doesNotMatch(rule, /\.appt-details/, `disclosure must not clip: ${rule.trim()}`);
    }
  });
});
