import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const OUT = '/opt/cursor/artifacts';
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:8765/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dumpState(page, label) {
  return page.evaluate((label) => {
    const st = window.ST || {};
    const ah = document.getElementById('ah-car');
    const total =
      document.getElementById('live-total') ||
      document.getElementById('bk-total') ||
      document.querySelector('.live-total, #total-amt, #bk-sum-total, #addon-total');
    const lsKeys = [];
    for (let i = 0; i < localStorage.length; i++) lsKeys.push(localStorage.key(i));
    const ssKeys = [];
    for (let i = 0; i < sessionStorage.length; i++) ssKeys.push(sessionStorage.key(i));
    return {
      label,
      cat: st.cat,
      displayLabel: st.displayLabel,
      vehicleLabel: st.vehicleLabel,
      tierKey: st.tierKey,
      lengthFt: st.lengthFt,
      boatType: st.boatType,
      rvType: st.rvType,
      basePrice: st.basePrice,
      addonTotal: st.addonTotal,
      ahCar: ah ? ah.textContent : null,
      totalText: total ? total.textContent : null,
      localStorageKeys: lsKeys,
      sessionStorageKeys: ssKeys,
    };
  }, label);
}

const chromeCandidates = [
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];
const executablePath = chromeCandidates.find((p) => fs.existsSync(p));
if (!executablePath) throw new Error('chrome not found');

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(1000);

const opened = await page.evaluate(() => {
  if (typeof openBooking === 'function') { openBooking(); return 'openBooking'; }
  if (typeof launchBooking === 'function') { launchBooking(); return 'launchBooking'; }
  const btn = [...document.querySelectorAll('button,a')].find((el) => /book/i.test(el.textContent || ''));
  if (btn) { btn.click(); return 'click'; }
  return null;
});
await sleep(600);

await page.evaluate(() => {
  const zip = document.getElementById('bk-zip') || document.getElementById('hero-zip');
  if (zip) {
    zip.value = '07650';
    zip.dispatchEvent(new Event('input', { bubbles: true }));
    zip.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (typeof onBkZipInput === 'function') onBkZipInput('07650');
});
await sleep(500);

async function chooseCategory(cat) {
  await page.evaluate((cat) => { if (typeof selectCategory === 'function') selectCategory(cat); }, cat);
  await sleep(500);
}
async function chooseFirstPackage() {
  await page.evaluate(() => {
    const card = document.querySelector('#pkg-grid .pkg-card, #pkg-grid [data-pkg], .pkg-card, [id^="pk-"]');
    if (!card) return;
    const id = card.getAttribute('data-pkg') || (card.id || '').replace(/^pk-/, '');
    if (id && typeof selectPkg === 'function') selectPkg(id);
    else card.click();
  });
  await sleep(500);
}

await chooseCategory('powersports');
await chooseFirstPackage();
await page.evaluate(() => {
  if (typeof selectTier === 'function') selectTier('motorcycle');
  else document.querySelector('[data-tier="motorcycle"]')?.click();
});
await sleep(300);
await page.evaluate(() => {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  set('g-year', '2023'); set('g-make', 'Yamaha'); set('g-model', 'MT-07');
  if (typeof tryGenericConfirm === 'function') tryGenericConfirm();
});
await sleep(600);
await page.evaluate(() => {
  const next = document.getElementById('next3');
  if (next && !next.disabled) next.click();
  else if (typeof bkGoTo === 'function') bkGoTo(4);
});
await sleep(600);
await page.screenshot({ path: `${OUT}/01_powersports_motorcycle_summary.png` });
const psState = await dumpState(page, 'powersports');

await chooseCategory('rvs');
await chooseFirstPackage();
await page.evaluate(() => {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  set('g-year', '2022'); set('g-make', 'Jayco'); set('g-model', 'Eagle');
  const type = document.getElementById('rv-type');
  if (type) {
    const opt = [...type.options].find((o) => /travel/i.test(o.value + o.textContent));
    type.value = opt ? opt.value : type.options[1]?.value || type.value;
    type.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (typeof ST !== 'undefined') { ST.rvType = ST.rvType || 'travel'; ST.lengthFt = 35; }
  const len = document.getElementById('len-ft') || document.getElementById('g-length');
  if (len) { len.value = '35'; len.dispatchEvent(new Event('input', { bubbles: true })); len.dispatchEvent(new Event('change', { bubbles: true })); }
  if (typeof tryGenericConfirm === 'function') tryGenericConfirm();
});
await sleep(700);
await page.evaluate(() => {
  const next = document.getElementById('next3');
  if (next && !next.disabled) next.click();
  else if (typeof bkGoTo === 'function') bkGoTo(4);
});
await sleep(600);
await page.screenshot({ path: `${OUT}/02_rv_after_powersports_summary.png` });
const rvState = await dumpState(page, 'rv_after_powersports');

await chooseCategory('cars');
await chooseFirstPackage();
await page.evaluate(() => {
  if (typeof selectMake === 'function') selectMake('Hyundai');
  const model = document.getElementById('model-sel');
  if (model) {
    const opt = [...model.options].find((o) => /Santa Fe/i.test(o.value || o.textContent || ''));
    if (opt) { model.value = opt.value; model.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  const year = document.getElementById('year-sel');
  if (year) {
    if (year.options.length <= 1) {
      for (let y = 2026; y >= 2018; y--) { const o = document.createElement('option'); o.value = y; o.textContent = y; year.appendChild(o); }
      year.disabled = false;
    }
    year.value = '2025'; year.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (typeof selectTier === 'function') selectTier('suv3');
});
await sleep(800);
await page.evaluate(() => {
  const next = document.getElementById('next3');
  if (next && !next.disabled) next.click();
  else if (typeof bkGoTo === 'function') bkGoTo(4);
});
await sleep(600);
await page.screenshot({ path: `${OUT}/03_cars_3row_suv_summary.png` });
const carState = await dumpState(page, 'cars');

await chooseCategory('boats');
await chooseFirstPackage();
await page.evaluate(() => {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  set('g-year', '2021'); set('g-make', 'Caymas'); set('g-model', 'CX 19');
  const type = document.getElementById('boat-type');
  if (type) {
    const opt = [...type.options].find((o) => /pontoon|tritoon/i.test(o.value + o.textContent));
    type.value = opt ? opt.value : type.options[1]?.value || type.value;
    type.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (typeof ST !== 'undefined') { ST.boatType = ST.boatType || 'pontoon'; ST.lengthFt = 22; }
  const len = document.getElementById('len-ft') || document.getElementById('g-length');
  if (len) { len.value = '22'; len.dispatchEvent(new Event('input', { bubbles: true })); len.dispatchEvent(new Event('change', { bubbles: true })); }
  if (typeof tryGenericConfirm === 'function') tryGenericConfirm();
});
await sleep(700);
await page.evaluate(() => {
  const next = document.getElementById('next3');
  if (next && !next.disabled) next.click();
  else if (typeof bkGoTo === 'function') bkGoTo(4);
});
await sleep(600);
await page.screenshot({ path: `${OUT}/04_boat_after_cars_summary.png` });
const boatState = await dumpState(page, 'boat_after_cars');

const defense = await page.evaluate(() => {
  ST.cat = 'rvs';
  ST.vehicleLabel = '2022 Jayco Eagle · 35 ft';
  ST.displayLabel = 'Motorcycle';
  ST.tier = { label: 'Motorcycle' };
  ST.pkg = ST.pkg || { name: 'Maintenance', scope: 'both' };
  ST.pkgId = ST.pkgId || 'maint';
  ST._addonKey = '';
  if (typeof renderAddons === 'function') renderAddons();
  return {
    ahCar: document.getElementById('ah-car')?.textContent || null,
    displayLabel: ST.displayLabel,
    helper: window.CD1BookingVehicleSummary?.formatAddonHeaderSummary(ST) || null,
  };
});
await page.screenshot({ path: `${OUT}/05_defense_stale_motorcycle_injected.png` });

const report = { opened, psState, rvState, carState, boatState, defense };
fs.writeFileSync(`${OUT}/cross_category_state_dump.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
