'use strict';

/**
 * RV sales optimization — commercial ladder, membership, booking ID safety.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const BOOKABLE = ['exterior', 'interior', 'full', 'premium'];

test('RV page exposes full commercial ladder copy', () => {
  const html = read('rv-detailing.html');
  for (const name of [
    'Maintenance Wash',
    'Exterior Wash',
    'Interior Detail',
    'Premium Exterior',
    'Premium Complete Detail',
    'Paint Correction',
    'Paint Correction \\+ Interior',
  ]) {
    assert.match(html, new RegExp(name));
  }
  assert.match(html, /Recommended/);
  assert.match(html, /Highest ticket/);
  assert.match(html, /RV Care Membership/);
  assert.match(html, /Super Interior/);
  assert.match(html, /\$135/);
  assert.match(html, /data-rv-membership/);
  assert.match(html, /data-twilio-ready="membership-interest"/);
});

test('RV bookable CTAs keep existing package IDs only', () => {
  const html = read('rv-detailing.html');
  const pkgs = [...html.matchAll(/data-booking-package="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(pkgs.length >= 4);
  for (const id of pkgs) {
    assert.ok(BOOKABLE.includes(id), `unexpected booking package id: ${id}`);
  }
  for (const id of BOOKABLE) {
    assert.ok(pkgs.includes(id), `missing bookable package ${id}`);
  }
});

test('RV bookable From prices unchanged', () => {
  const html = read('rv-detailing.html');
  assert.match(html, /From \$349/);
  assert.match(html, /From \$299/);
  assert.match(html, /From \$549/);
  assert.match(html, /From \$849/);
});

test('booking PRICING.rvs keeps IDs and length mins; display names updated', () => {
  const index = read('index.html');
  const block = index.match(/rvs:\s*\{[\s\S]*?powersports:/)[0];
  for (const id of BOOKABLE) {
    assert.match(block, new RegExp(`id:'${id}'`));
  }
  assert.match(block, /name:'Premium Complete Detail'/);
  assert.match(block, /name:'Premium Exterior'/);
  assert.doesNotMatch(block, /id:'maint'|id:'correction'|id:'complete'/);
  const length = index.match(/rvs:\s*\{[\s\S]*?exterior:\s*\{perFt:\s*12,\s*min:\s*349\}/);
  assert.ok(length);
  assert.match(index, /interior:\s*\{perFt:\s*21,\s*min:\s*299\}/);
  assert.match(index, /full:\s*\{perFt:\s*30,\s*min:\s*549\}/);
  assert.match(index, /premium:\s*\{perFt:\s*38,\s*min:\s*849\}/);
});

test('specialty booking bridge still whitelists only RV bookable IDs', () => {
  const bridge = read('assets/specialty-booking-bridge.js');
  assert.match(bridge, /rvs:\s*\{\s*exterior:\s*1,\s*interior:\s*1,\s*full:\s*1,\s*premium:\s*1\s*\}/);
});

test('RV SEO covers premium topical language without stuffing', () => {
  const html = read('rv-detailing.html');
  assert.match(html, /Premium Mobile RV/);
  assert.match(html, /Travel Trailer Detailing|travel trailer/i);
  assert.match(html, /Gelcoat/);
  assert.match(html, /Motorhome|motorhome/);
  assert.match(html, /Luxury RV Care|luxury interior/i);
});
