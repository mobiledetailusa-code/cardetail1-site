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

test('#admin hash redirects to canonical admin page, not customer portal', () => {
  assert.match(index, /location\.hash\s*===?\s*['"]#admin['"]/);
  assert.match(index, /location\.replace\s*\(\s*['"]\/admin['"]\s*\)/);
  assert.doesNotMatch(index, /location\.hash\s*===?\s*['"]#admin['"]\)[^;]*openLogin/);
  assert.doesNotMatch(index, /location\.hash\s*===?\s*['"]#admin['"]\)[^;]*openPortal/);
  assert.doesNotMatch(index, /id="admin-ov"/);
  assert.doesNotMatch(index, /id="jobs-ov"/);
  assert.doesNotMatch(index, /id="emp-ov"/);
  assert.match(index, /id="bk-ov"/);
  assert.match(index, /id="cp-ov"/);
});

test('canonical portal HTML files are present and unchanged by this guard', () => {
  for (const f of portalFiles) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} should exist`);
  }
});

const pkgModalJs = read('assets/car-pkg-detail-modal.js');
const buttonStatesCss = read('assets/button-states.css');

test('shared package detail data includes required content for all three car packages', () => {
  assert.match(pkgModalJs, /const CAR_PKG_DETAILS\s*=\s*\{/);
  assert.match(pkgModalJs, /interior:\s*\{[\s\S]*includes:\s*\[[\s\S]*"Vacuum"[\s\S]*"Steam touch points"[\s\S]*"Floor mats"[\s\S]*\]/);
  assert.match(pkgModalJs, /interior:\s*\{[\s\S]*bestFor:\s*\[[\s\S]*"Daily drivers"[\s\S]*"Family cars"[\s\S]*\]/);
  assert.match(pkgModalJs, /interior:\s*\{[\s\S]*addonsMayApply:\s*\[[\s\S]*"Heavy pet hair"[\s\S]*"Biohazard"[\s\S]*\]/);

  assert.match(pkgModalJs, /full:\s*\{[\s\S]*includes:\s*\[[\s\S]*"Interior detail"[\s\S]*"Exterior hand wash"[\s\S]*"Exterior protection"[\s\S]*\]/);
  assert.match(pkgModalJs, /full:\s*\{[\s\S]*bestFor:\s*\[[\s\S]*"Full refresh inside and out"[\s\S]*"Resale prep"[\s\S]*\]/);
  assert.match(pkgModalJs, /full:\s*\{[\s\S]*addonsMayApply:\s*\[[\s\S]*"Clay\/polish upgrade"[\s\S]*"Headlights"[\s\S]*\]/);

  assert.match(pkgModalJs, /refresh:\s*\{[\s\S]*includes:\s*\[[\s\S]*"Hand wash"[\s\S]*"Clay bar\/decontamination"[\s\S]*"Sealant\/protection"[\s\S]*\]/);
  assert.match(pkgModalJs, /refresh:\s*\{[\s\S]*bestFor:\s*\[[\s\S]*"Dull paint"[\s\S]*"Exterior restoration"[\s\S]*\]/);
  assert.match(pkgModalJs, /refresh:\s*\{[\s\S]*addonsMayApply:\s*\[[\s\S]*"Heavy oxidation"[\s\S]*"Headlight restoration"[\s\S]*\]/);
});

test('homepage opens package details in modal panel instead of inline card expansion', () => {
  assert.match(index, /id="car-pkg-detail-ov"/);
  assert.match(index, /id="car-pkg-detail-body"/);
  assert.match(index, /assets\/car-pkg-detail-modal\.js/);
  assert.match(index, /initCarPkgDetailModal\(\);/);
  assert.match(index, /\.car-pkg-detail-ov\[hidden\]\{display:none!important\}/);
  assert.doesNotMatch(index, /function toggleHomePkgDetail/);
  assert.doesNotMatch(index, /id="home-pkg-detail-interior"/);
  const modalIdx = index.indexOf('id="car-pkg-detail-ov"');
  const addonsIdx = index.indexOf('class="car-addons-block"');
  const bodyCloseIdx = index.lastIndexOf('</body>');
  assert.ok(modalIdx > addonsIdx, 'modal should not sit inside package cards');
  assert.ok(modalIdx > bodyCloseIdx - 1200 && modalIdx < bodyCloseIdx, 'modal should live near end of body');
  for (const pkgId of ['interior', 'full', 'refresh']) {
    assert.match(index, new RegExp(`openHomePkgDetailModal\\('${pkgId}'`));
    assert.match(index, new RegExp(`openBookingCarPkg\\('${pkgId}'\\)`));
  }
  assert.match(pkgModalJs, /function openHomePkgDetailModal\(pkgId/);
  assert.match(pkgModalJs, /<h4>Includes<\/h4>/);
  assert.match(pkgModalJs, /<h4>Best for<\/h4>/);
  assert.match(pkgModalJs, /<h4>Add-ons may apply<\/h4>/);
  assert.match(pkgModalJs, /openBookingCarPkg\(pkgId\)/);
  assert.match(pkgModalJs, /ov\.hidden = true/);
});

test('homepage no longer shows the More Than Cars specialty promo section', () => {
  assert.doesNotMatch(index, /id="specialty-services"/);
  assert.doesNotMatch(index, /More than cars/i);
  assert.doesNotMatch(index, /Featured boat page/i);
  assert.doesNotMatch(index, /Featured powersports page/i);
  assert.match(index, /class="specialty-service-nav"/);
});

test('booking modal primary buttons keep readable hover colors', () => {
  assert.match(buttonStatesCss, /\.booking-modal \.btn-n:hover:not\(:disabled\)[\s\S]*color:\s*#ffffff\s*!important/);
  assert.match(buttonStatesCss, /\.booking-modal \.btn-n:hover:not\(:disabled\)[\s\S]*background:\s*#1d4ed8\s*!important/);
  assert.doesNotMatch(buttonStatesCss, /opacity:\s*0\.[0-2]/);
});
