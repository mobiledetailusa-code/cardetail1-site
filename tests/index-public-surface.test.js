// Guards: public index.html must not ship legacy admin/tech ops surfaces.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const index = read('index.html');
const portalFiles = ['admin.html', 'admin-ops.html', 'technician.html', 'customer.html'];

test('index.html has no legacy ops overlay markup', () => {
  assert.doesNotMatch(index, /id="admin-ov"/);
  assert.doesNotMatch(index, /id="jobs-ov"/);
  assert.doesNotMatch(index, /id="emp-ov"/);
});

test('index.html has no internal ops env strings or legacy admin panels', () => {
  assert.doesNotMatch(index, /ADMIN_DASH_PASSWORD/);
  assert.doesNotMatch(index, /BID_SECRET/);
  assert.doesNotMatch(index, /Sync Techs/);
  assert.doesNotMatch(index, /Technician Roster/);
  assert.doesNotMatch(index, /function openAdminPanel/);
  assert.doesNotMatch(index, /function openJobsBoard/);
});

test('index.html keeps public booking, ZIP routing, and card-on-file flow', () => {
  assert.match(index, /id="bk-ov"/);
  assert.match(index, /NJ_HUB_ZIP3/);
  assert.match(index, /resolveHubPageForHero/);
  assert.match(index, /waitForVerifiedCardSave/);
  assert.match(index, /Secure Your Booking/);
});

test('index.html admin login routes to canonical admin-ops console', () => {
  assert.match(index, /admin-auth/);
  assert.match(index, /admin-ops\.html/);
  const doLoginBlock = index.slice(index.indexOf('async function doLogin'), index.indexOf('async function doLogin') + 900);
  assert.doesNotMatch(doLoginBlock, /admin-ov.*classList\.add\('open'\)/);
});

test('canonical portal HTML files are present and unchanged by this guard', () => {
  for (const f of portalFiles) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} should exist`);
  }
});
