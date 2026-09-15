'use strict';

/**
 * Real-Chrome DOM audit for multi-vehicle optional fleet.
 * Uses UI clicks only (no ST mutation for cart append).
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.CD1_BASE || 'http://127.0.0.1:4173';
const OUT = '/tmp/cd1-multi-vehicle-audit';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function snapshot(page, label) {
  return page.evaluate((lbl) => {
    const ST = window.ST || {};
    const addBtn = [...document.querySelectorAll('.btn-add-veh')].find((el) => /Add Another Vehicle/i.test(el.textContent || ''));
    const cont = document.getElementById('next3');
    const callout = document.getElementById('cd1-optional-fleet-callout');
    const routing = document.getElementById('cd1-routing-alt-panel');
    const items = document.querySelectorAll('#vcart-items .vcart-item').length;
    const total = (document.getElementById('vcart-sum') || {}).textContent || '';
    const stepOn = [...document.querySelectorAll('.bsec.on')].map((el) => el.id);
    const isVisible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetParent !== null;
    };
    return {
      label: lbl,
      stLen: (ST.vehicles || []).length,
      visibleCart: items,
      cartTotal: total,
      addVisible: !!addBtn && isVisible(addBtn),
      addEnabled: !!(addBtn && !addBtn.disabled),
      contVisible: !!cont && isVisible(cont),
      contEnabled: !!(cont && !cont.disabled),
      fleetCallout: !!(callout && callout.classList.contains('show')),
      fleetRouting: !!(routing && routing.style.display === 'block'),
      step: stepOn[0] || '',
      consoleErrors: (window.__cd1AuditErrors || []).slice(),
    };
  }, label);
}

async function unlockZip(page) {
  await page.waitForSelector('#bk-zip', { timeout: 15000 });
  await page.focus('#bk-zip');
  await page.evaluate(() => {
    const el = document.getElementById('bk-zip');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.type('#bk-zip', '07650', { delay: 40 });
  await page.evaluate(() => {
    if (typeof onBkZipInput === 'function') onBkZipInput('07650');
  });
  await sleep(400);
  const unlocked = await page.evaluate(() => !document.getElementById('bkcat-cars').classList.contains('locked'));
  if (!unlocked) throw new Error('ZIP gate did not unlock categories');
}

async function pickPackage(page) {
  // Prefer Interior Detail if present, else first non-custom pkg
  const clicked = await page.evaluate(() => {
    const pkgs = [...document.querySelectorAll('#bs2 .pkg, #pkg-grid .pkg, .pkg')];
    const interior = pkgs.find((p) => /Interior/i.test(p.textContent || ''));
    const full = pkgs.find((p) => /Full Detail|Premium Full/i.test(p.textContent || ''));
    const target = interior || full || pkgs[0];
    if (!target) return false;
    target.click();
    return true;
  });
  if (!clicked) throw new Error('No package found');
  await sleep(500);
}

async function configureCar(page, n) {
  await page.waitForSelector('#bkcat-cars:not(.locked)', { timeout: 10000 });
  // After Add Another Vehicle we're on step 1; ensure cars category
  const onStep1 = await page.evaluate(() => document.getElementById('bs1')?.classList.contains('on'));
  if (onStep1) {
    await page.click('#bkcat-cars');
    await sleep(600);
    await pickPackage(page);
  } else {
    // Already on vehicle step after package auto-advance? ensure package if needed
    const onStep3 = await page.evaluate(() => document.getElementById('bs3')?.classList.contains('on'));
    if (!onStep3) {
      await page.click('#bkcat-cars');
      await sleep(600);
      await pickPackage(page);
    }
  }
  await page.waitForSelector('#make-in', { visible: true, timeout: 10000 });
  await page.click('#make-in', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('#make-in', 'Honda', { delay: 35 });
  await sleep(500);
  await page.waitForSelector('#make-dd .srch-item', { timeout: 8000 });
  await page.click('#make-dd .srch-item');
  await sleep(600);
  await page.waitForFunction(() => {
    const sel = document.getElementById('model-sel');
    return sel && !sel.disabled && [...sel.options].some((o) => o.value === 'Civic' || o.value);
  }, { timeout: 8000 });
  const modelValue = await page.evaluate(() => {
    const sel = document.getElementById('model-sel');
    const opts = [...sel.options].filter((o) => o.value);
    const civic = opts.find((o) => o.value === 'Civic' || /Civic/i.test(o.text));
    return (civic || opts[0]).value;
  });
  await page.select('#model-sel', modelValue);
  await sleep(500);
  await page.waitForFunction(() => {
    const sel = document.getElementById('year-sel');
    return sel && !sel.disabled && [...sel.options].some((o) => o.value);
  }, { timeout: 8000 });
  const years = await page.evaluate(() => [...document.getElementById('year-sel').options].map((o) => o.value).filter(Boolean));
  const year = years.includes('2020') ? '2020' : years[0];
  await page.select('#year-sel', year);
  await sleep(800);
  await page.evaluate(() => {
    const wrap = document.getElementById('tier-chips-wrap');
    if (wrap && getComputedStyle(wrap).display !== 'none') {
      const chip = wrap.querySelector('.tchip');
      if (chip) chip.click();
    }
  });
  await sleep(400);
  const ready = await page.evaluate(() => {
    const next = document.getElementById('next3');
    return {
      nextEnabled: !!(next && !next.disabled),
      label: (window.ST && window.ST.vehicleLabel) || '',
      base: window.ST && window.ST.basePrice,
    };
  });
  if (!ready.nextEnabled) {
    await page.screenshot({ path: '/tmp/cd1-multi-vehicle-audit/fail_vehicle_' + n + '.png' }).catch(() => {});
    throw new Error('Vehicle ' + n + ' not ready: ' + JSON.stringify(ready));
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
    protocolTimeout: 180000,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1000);
  // Dismiss consent if present
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const accept = btns.find((b) => /Accept all|Accept|Got it|OK/i.test(b.textContent || ''));
    if (accept) accept.click();
  });
  await sleep(300);

  // Open booking
  await page.evaluate(() => {
    if (typeof openBooking === 'function') openBooking(null);
  });
  await sleep(600);
  await unlockZip(page);

  const rows = [];
  for (let i = 1; i <= 6; i++) {
    await configureCar(page, i);
    if (i < 6) {
      await page.click('.btn-add-veh');
      await sleep(600);
    } else {
      // leave on step 3 with vehicle 6 configured; commit via Add Another then stay, or Continue later
      await page.click('.btn-add-veh');
      await sleep(600);
    }
    const snap = await snapshot(page, 'after-vehicle-' + i);
    snap.consoleErrors = errors.slice();
    rows.push(snap);
    await page.screenshot({ path: path.join(OUT, 'vehicle_' + i + '.png'), fullPage: false });
    console.log(JSON.stringify(snap));
  }

  // Fleet callout assertions at 6 — reopen vehicle step so callout controls are in DOM flow
  await page.evaluate(() => { if (typeof bkGoTo === 'function') bkGoTo(3); });
  await sleep(400);
  const calloutText = await page.evaluate(() => {
    const el = document.getElementById('cd1-optional-fleet-callout');
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
  });
  console.log('CALLOUT_TEXT', JSON.stringify(calloutText));
  await page.screenshot({ path: path.join(OUT, 'fleet_callout_6.png'), fullPage: false });

  const before = await snapshot(page, 'before-continue-booking');
  await page.evaluate(() => {
    const btn = document.getElementById('cd1-fleet-continue');
    if (btn) btn.click();
  });
  await sleep(300);
  const afterDismiss = await snapshot(page, 'after-continue-booking');
  console.log(JSON.stringify({
    beforeLen: before.stLen,
    afterLen: afterDismiss.stLen,
    beforeTotal: before.cartTotal,
    afterTotal: afterDismiss.cartTotal,
    calloutAfter: afterDismiss.fleetCallout,
  }));

  // Vehicle 7
  let seven = null;
  try {
    await page.evaluate(() => { if (typeof bkGoTo === 'function') bkGoTo(1); });
    await sleep(300);
    await configureCar(page, 7);
    await page.click('.btn-add-veh');
    await sleep(500);
    seven = await snapshot(page, 'after-vehicle-7');
    console.log(JSON.stringify(seven));
    await page.screenshot({ path: path.join(OUT, 'vehicle_7.png'), fullPage: false });
  } catch (e) {
    console.log('VEHICLE_7_ERROR', e.message);
  }

  // Review with current cart (avoid heavy fillConfirm side-effects timing out)
  await page.evaluate(() => {
    if (typeof bkGoTo === 'function') bkGoTo(5);
  });
  await sleep(1200);
  const review = await page.evaluate(() => {
    try {
      if (typeof fillConfirm === 'function') fillConfirm();
    } catch (e) { /* ignore */ }
    const cards = document.querySelectorAll('#c-vehicle-cards .bkli-vehicle, #c-vehicle-cards .vcart-item, #bs5 .bkli-vehicle');
    const title = (document.getElementById('c-service-title') || {}).textContent || '';
    const total = (document.getElementById('c-total') || {}).textContent || '';
    return {
      stLen: (window.ST && ST.vehicles && ST.vehicles.length) || 0,
      cardCount: cards.length,
      title,
      total,
      cardText: [...cards].map((c) => c.textContent.trim().replace(/\s+/g, ' ').slice(0, 100)),
    };
  });
  console.log('REVIEW', JSON.stringify(review));
  await page.screenshot({ path: path.join(OUT, 'review.png'), fullPage: false });

  const backend = await page.evaluate(() => {
    const vehicles = (ST.vehicles || []).map((v) => ({
      cat: v.cat, pkgId: v.pkgId, vehicleLabel: v.vehicleLabel, basePrice: v.basePrice,
      addonTotal: v.addonTotal || 0, subtotal: v.subtotal,
    }));
    return { count: vehicles.length, payloadBytes: JSON.stringify({ vehicles }).length };
  });
  console.log('PAYLOAD', JSON.stringify(backend));

  // Compact row log without console error spam
  const compact = rows.map((r) => ({
    label: r.label, stLen: r.stLen, visibleCart: r.visibleCart, cartTotal: r.cartTotal,
    fleetCallout: r.fleetCallout, fleetRouting: r.fleetRouting, step: r.step,
  }));
  console.log('ROWS', JSON.stringify(compact));

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ rows: compact, calloutText, afterDismiss, seven, review, backend, errorCount: errors.length }, null, 2));
  await browser.close();
  console.log('WROTE', OUT);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
