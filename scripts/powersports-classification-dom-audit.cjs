'use strict';

/**
 * Real-Chrome Powersports classification regression.
 *
 * The booking is opened, navigated and edited through rendered controls. The
 * script never assigns to window.ST and never submits a booking.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');

const BASE = process.env.CD1_BASE || 'http://127.0.0.1:4174';
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) throw new Error('Chrome executable not found');

const pause = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

async function replaceText(page, selector, text) {
  await page.click(selector, { clickCount: 3 });
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.keyboard.press('A');
  await page.keyboard.up(modifier);
  await page.keyboard.press('Backspace');
  await page.type(selector, text, { delay: 8 });
}

async function clickDataValue(page, rootSelector, value) {
  await page.waitForFunction(
    (root, expected) => [...document.querySelectorAll(`${root} .srch-item`)]
      .some((element) => element.dataset.val === expected),
    { timeout: 5000 }, rootSelector, value
  );
  const handles = await page.$$(`${rootSelector} .srch-item`);
  for (const handle of handles) {
    if (await handle.evaluate((element) => element.dataset.val) === value) {
      // The production autocomplete commits on mousedown so its blur handler
      // cannot close the list first. Dispatch the same rendered-control event
      // sequence a pointer click produces.
      await handle.evaluate((element) => {
        element.scrollIntoView({ block: 'nearest' });
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      return;
    }
  }
  throw new Error(`No rendered option ${value} in ${rootSelector}`);
}

async function selectKnown(page, make, model) {
  await replaceText(page, '#g-make', make.slice(0, Math.min(make.length, 5)));
  await clickDataValue(page, '#g-make-dd', make);
  await page.click('#g-model');
  await clickDataValue(page, '#g-model-dd', model);
  await page.select('#g-year', '2025');
  await pause();
}

async function selectFreeform(page, make, model) {
  await replaceText(page, '#g-make', make);
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => !document.getElementById('g-model').disabled, { timeout: 3000 });
  await replaceText(page, '#g-model', model);
  await page.keyboard.press('Tab');
  await page.select('#g-year', '2025');
  await pause();
}

async function snapshot(page, name) {
  return page.evaluate((caseName) => {
    const st = window.ST || {};
    const price = document.getElementById('vc-price');
    const note = document.getElementById('g-custom-note');
    return {
      name: caseName,
      category: st.cat || '',
      tierKey: st.tierKey || '',
      tierLabel: st.displayLabel || (st.tier && st.tier.label) || '',
      vehicleLabel: st.vehicleLabel || '',
      priceTierKey: (st.tier && st.tier.priceTierKey) || '',
      basePrice: Number(st.basePrice) || 0,
      status: st._powersportsResolutionStatus || '',
      continueEnabled: !document.getElementById('next3').disabled,
      visiblePriceText: price && getComputedStyle(price).display !== 'none' ? price.textContent.trim() : '',
      note: note && getComputedStyle(note).display !== 'none' ? note.textContent.trim() : '',
    };
  }, name);
}

function expectBookable(row, tierKey, label, basePrice) {
  assert.equal(row.category, 'powersports', row.name);
  assert.equal(row.status, 'bookable', row.name);
  assert.equal(row.tierKey, tierKey, row.name);
  assert.equal(row.tierLabel, label, row.name);
  assert.equal(row.basePrice, basePrice, row.name);
  assert.equal(row.continueEnabled, true, row.name);
}

function expectSafeStop(row, status, messagePattern) {
  assert.equal(row.category, 'powersports', row.name);
  assert.equal(row.status, status, row.name);
  assert.equal(row.tierKey, '', row.name);
  assert.equal(row.basePrice, 0, row.name);
  assert.equal(row.continueEnabled, false, row.name);
  assert.equal(row.visiblePriceText, '', row.name);
  assert.match(row.note, messagePattern, row.name);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1365,900'],
    defaultViewport: { width: 1365, height: 900 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));
  page.on('dialog', (dialog) => dialog.accept());

  try {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.click('.nav-cta');
    await replaceText(page, '#bk-zip', '07650');
    await page.waitForSelector('#bkcat-powersports:not(.locked)', { timeout: 5000 });
    await page.click('#bkcat-powersports');
    await page.waitForSelector('#pk-maintenance', { visible: true, timeout: 5000 });
    await page.click('#pk-maintenance');
    await page.waitForSelector('#g-make', { visible: true, timeout: 5000 });

    const rows = [];

    await selectKnown(page, 'Polaris', 'RZR Trail');
    rows.push(await snapshot(page, 'A1 RZR Trail'));
    expectBookable(rows.at(-1), 'utv_standard', 'Side-by-Side / UTV', 190, 'utv_standard');

    await selectKnown(page, 'Harley-Davidson', 'Road Glide');
    rows.push(await snapshot(page, 'A2 RZR → Road Glide'));
    expectBookable(rows.at(-1), 'motorcycle_large', 'Large Motorcycle', 190, 'motorcycle_large');
    assert.doesNotMatch(`${rows.at(-1).tierLabel} ${rows.at(-1).vehicleLabel}`, /UTV|Side-by-Side/i);

    await selectKnown(page, 'Polaris', 'RZR Trail');
    rows.push(await snapshot(page, 'B Road Glide → RZR'));
    expectBookable(rows.at(-1), 'utv_standard', 'Side-by-Side / UTV', 190, 'utv_standard');

    for (const fixture of [
      ['C Indian Challenger', 'Indian Motorcycle', 'Challenger', 'motorcycle_large', 'Large Motorcycle', 190, 'motorcycle_large'],
      ['D Can-Am Spyder RT', 'Can-Am', 'Spyder RT', 'motorcycle_trike', 'Trike / 3-Wheel Motorcycle', 200, 'motorcycle_trike'],
      ['E Polaris Slingshot', 'Polaris', 'Slingshot', 'motorcycle_trike', 'Trike / 3-Wheel Motorcycle', 200, 'motorcycle_trike'],
      ['F Honda FourTrax Rancher', 'Honda', 'FourTrax Rancher', 'atv', 'ATV / Quad', 175, 'atv'],
      ['G Massimo MSA 550', 'Massimo', 'MSA 550', 'atv', 'ATV / Quad', 175, 'atv'],
      ['H Polaris General XP 4', 'Polaris', 'General XP 4', 'utv_large', 'Large / Crew Side-by-Side / UTV', 200, 'utv_large'],
      ['I Polaris RZR Trail', 'Polaris', 'RZR Trail', 'utv_standard', 'Side-by-Side / UTV', 190, 'utv_standard'],
    ]) {
      await selectKnown(page, fixture[1], fixture[2]);
      rows.push(await snapshot(page, fixture[0]));
      expectBookable(rows.at(-1), fixture[3], fixture[4], fixture[5], fixture[6]);
    }

    for (const fixture of [
      ['J Sea-Doo Switch', 'Sea-Doo', 'Switch'],
      ['K Sea-Doo Spark PWC', 'Sea-Doo', 'Spark'],
    ]) {
      await selectFreeform(page, fixture[1], fixture[2]);
      rows.push(await snapshot(page, fixture[0]));
      expectSafeStop(rows.at(-1), 'route_boats', /booked through Boats|Choose Boats/i);
    }

    await selectKnown(page, 'Club Car', 'Onward');
    rows.push(await snapshot(page, 'L Golf Cart'));
    expectSafeStop(rows.at(-1), 'contact', /Online pricing is not available/i);

    await selectKnown(page, 'Bobcat', 'S70 Skid Steer');
    rows.push(await snapshot(page, 'M Equipment'));
    expectSafeStop(rows.at(-1), 'contact', /Online pricing is not available/i);

    assert.deepEqual(pageErrors, []);
    process.stdout.write(`${JSON.stringify({ ok: true, cases: rows }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
