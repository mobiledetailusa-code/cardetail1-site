'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('admin apply_welcome_offer requires reason on override', () => {
  const src = read('netlify/functions/admin-ops-jobs.js');
  assert.match(src, /apply_welcome_offer/);
  assert.match(src, /reason_required_for_override/);
  assert.match(src, /remove_welcome_offer/);
  assert.match(src, /reason_required/);
});

test('admin offer actions write audit entries', () => {
  const src = read('netlify/functions/admin-ops-jobs.js');
  assert.match(src, /appendAudit\(auditEntry/);
  assert.match(src, /welcome_offer_applied/);
  assert.match(src, /welcome_offer_removed/);
});

test('technician complete job cannot modify welcome offer', () => {
  const src = read('netlify/functions/tech-complete-job.js');
  assert.doesNotMatch(src, /apply_welcome_offer|remove_welcome_offer|WELCOME10/i);
});
