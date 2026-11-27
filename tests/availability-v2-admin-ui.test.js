'use strict';

/**
 * Operational Availability V2 — Phase 1 Admin Ops availability UI contract:
 * presets, preview-before-save, explicit confirmation, protected-date
 * selection, holiday opening, effective calendar, stale-tab guards, and the
 * mobile layout rules (single-column calendar, stacked preview rows, 44px
 * touch targets).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin-ops.html'), 'utf8');

test('bulk shortcuts cover the five owner tasks', () => {
  for (const preset of ['all_days', 'weekends', 'sundays', 'open_range', 'close_range']) {
    assert.match(html, new RegExp(`data-av-preset="${preset}"`), preset);
  }
  assert.match(html, />Open all days</);
  assert.match(html, />Open all weekends</);
  assert.match(html, />Open all Sundays</);
  assert.match(html, /id="avBulkCapacity"[^>]*min="1"[^>]*max="20"/);
  for (const slot of ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM']) {
    assert.match(html, new RegExp(`id="avBulkWindows"[\\s\\S]*value="${slot}"`), slot);
  }
});

test('nothing is saved without a preview, a planHash and an explicit confirmation', () => {
  assert.match(html, /action: 'preview_bulk_availability'/);
  assert.match(html, /action: 'apply_bulk_availability'/);
  assert.match(html, /planHash: p\.planHash/);
  assert.match(html, /window\.confirm\('Apply '/);
  assert.match(html, /acknowledgeReservations: !!\(ack && ack\.checked\)/);
  assert.match(html, /They stay booked/);
  assert.match(html, /data-av-include=/, 'protected dates are opted in one by one');
});

test('single-date exceptions can open a holiday only explicitly, and edits carry the revision', () => {
  assert.match(html, /id="avOverrideHoliday"/);
  assert.match(html, /holidayOpening: \$\('#avOverrideHoliday'\)\.checked/);
  assert.match(html, /expectedRevision: a\.revision != null \? a\.revision : null/);
  assert.equal((html.match(/\.\.\.avVersionFields\(\)/g) || []).length, 3, 'mode, upsert and remove send the revision');
});

test('status shows the active mode, the activation date and the weekend cliff warning', () => {
  assert.match(html, /id="avStatus"/);
  assert.match(html, /Supervised from /);
  assert.match(html, /every Saturday and Sunday becomes closed unless it is opened/);
  assert.match(html, /Availability settings could not be read\./);
});

test('effective calendar renders open/closed/activation/bookings', () => {
  assert.match(html, /id="avCalendar"/);
  assert.match(html, /action: 'effective_calendar'/);
  assert.match(html, /afterActivation/);
  assert.match(html, / booked</);
  assert.match(html, /loadSettings\(\)\.then\(\(\) => \{ renderSettingsForm\(\); loadAvailabilityCalendar\(\); \}\)/);
});

test('mobile layout: single-column calendar, stacked preview rows, touch-size controls', () => {
  const media = html.slice(html.indexOf('@media(max-width:640px){\n  .av-cal'));
  assert.ok(media.length > 0, 'phone breakpoint for the availability card');
  assert.match(media, /\.av-cal\{grid-template-columns:1fr\}/);
  assert.match(media, /\.av-table,\.av-table tbody,\.av-table tr,\.av-table td\{display:block;width:100%\}/);
  assert.match(media, /\.av-table td\[data-l\]::before\{content:attr\(data-l\)/);
  assert.match(html, /\.av-chip\{[^}]*min-height:40px/);
  assert.match(html, /\.av-card \.av-sec>summary\{[^}]*min-height:44px/);
  assert.match(html, /\.btn\{min-height:44px/);
});

test('the deprecated auto-confirm checkbox is left untouched (no confirmation change in Phase 1)', () => {
  assert.match(html, /id="setAutoConfirm"/);
  assert.match(html, /Auto-confirm new bookings \(future: on submit\)/);
});
