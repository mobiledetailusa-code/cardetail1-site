'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function createElement(tag) {
  const el = {
    tag,
    id: '',
    className: '',
    hidden: false,
    textContent: '',
    value: '',
    checked: false,
    type: '',
    name: '',
    disabled: false,
    children: [],
    parent: null,
    attrs: {},
    dataset: {},
    style: {},
    listeners: {},
    classList: null,
    setAttribute(key, value) {
      this.attrs[key] = String(value);
      if (key === 'id') this.id = String(value);
      if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
    },
    getAttribute(key) { return this.attrs[key]; },
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    insertAdjacentElement(position, node) {
      const parent = this.parent;
      if (!parent) return node;
      const idx = parent.children.indexOf(this);
      parent.children.splice(position === 'afterend' ? idx + 1 : idx, 0, node);
      node.parent = parent;
      return node;
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    },
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    },
    dispatch(type, event) {
      (this.listeners[type] || []).forEach((fn) => fn(event));
    },
    click() {
      this.dispatch('click', { preventDefault() {}, stopPropagation() {}, target: this });
    },
    focus() { this.owner && (this.owner.activeElement = this); },
    querySelector(sel) { return walk(this, sel)[0] || null; },
    querySelectorAll(sel) { return walk(this, sel); },
  };
  el.classList = {
    contains: (name) => el.className.split(/\s+/).includes(name),
    add: (name) => { if (!el.classList.contains(name)) el.className = `${el.className} ${name}`.trim(); },
    remove: (name) => { el.className = el.className.split(/\s+/).filter((part) => part && part !== name).join(' '); },
    toggle: (name, on) => { if (on) el.classList.add(name); else el.classList.remove(name); },
  };
  Object.defineProperty(el, 'innerHTML', {
    set(value) {
      el.children = [];
      el._html = String(value);
    },
    get() { return el._html || ''; },
  });
  return el;
}

function matches(el, sel) {
  if (sel === '.bsec.on') return el.classList.contains('bsec') && el.classList.contains('on');
  if (sel === '.btn-n, .btn-sub') return el.classList.contains('btn-n') || el.classList.contains('btn-sub');
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.includes('[value="')) {
    const value = sel.match(/\[value="([^"]*)"\]/)[1];
    return el.value === value;
  }
  if (sel.includes('[data-id')) return !!el.getAttribute('data-id');
  if (sel === 'input[value=""]') return el.tag === 'input' && el.value === '';
  if (sel.startsWith('input')) return el.tag === 'input';
  if (sel === 'h3') return el.tag === 'h3';
  if (sel === 'summary') return el.tag === 'summary';
  return el.tag === sel;
}

function walk(root, sel) {
  const out = [];
  (root.children || []).forEach((child) => {
    if (matches(child, sel)) out.push(child);
    out.push(...walk(child, sel));
  });
  return out;
}

function textOf(el) {
  return [el.textContent || '', ...(el.children || []).map(textOf)].join(' ');
}

function createPage() {
  const elements = {};
  const body = createElement('body');
  const head = createElement('head');
  const grid = createElement('div');
  grid.id = 'addon-grid';
  const bs4 = createElement('div');
  bs4.id = 'bs4';
  const bs3 = createElement('div');
  bs3.id = 'bs3';
  bs3.className = 'bsec on';
  const next = createElement('button');
  next.id = 'next3';
  next.className = 'btn-n';
  bs3.appendChild(grid);
  bs3.appendChild(next);
  body.appendChild(bs3);
  body.appendChild(bs4);
  const modal = createElement('div');
  modal.className = 'booking-modal-ov open';
  const shell = createElement('div');
  shell.className = 'booking-modal';
  modal.appendChild(shell);
  body.appendChild(modal);
  elements['addon-grid'] = grid;
  elements.bs4 = bs4;
  elements.bs3 = bs3;
  elements.next3 = next;
  const document = {
    readyState: 'complete',
    head,
    body,
    activeElement: null,
    createElement,
    getElementById(id) { return findId(body, id) || findId(head, id); },
    querySelector(sel) { return walk(body, sel)[0] || walk(head, sel)[0] || null; },
    querySelectorAll(sel) { return walk(body, sel); },
    addEventListener() {},
  };
  function findId(node, id) {
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = findId(child, id);
      if (found) return found;
    }
    return null;
  }
  body.owner = document;
  const context = {
    document,
    console,
    setTimeout,
    clearTimeout,
    ST: {
      pkgId: 'ceramic_1yr',
      tierKey: 'small',
      basePrice: 650,
      addonTotal: 0,
      addons: [],
      companionInterior: false,
      pkg: { name: 'Professional Ceramic Protection — Up to 1 Year' },
    },
    PRICING: {
      cars: {
        tiers: { small: { interior: 200 }, suv3: { interior: 255 } },
        addons: [
          { id: 'rainx', name: 'Rain-X Windshield Treatment', price: 25, desc: 'Water-repellent Rain-X on windshield' },
          { id: 'wax1yr', name: '1-Year Carnauba Wax', price: 75 },
          { id: 'polymer', name: 'Polymer Paint Sealant', price: 25 },
          { id: 'claybar', name: 'Clay Bar Treatment', price: 45 },
          { id: 'ceramic_windshield', name: 'Windshield Ceramic Coating', price: 100, desc: 'Ceramic coating on the windshield only.' },
          { id: 'ceramic_glass_all', name: 'All Exterior Glass Ceramic Coating', price: 175, desc: 'Ceramic coating on all exterior glass.' },
          { id: 'ceramic_wheels', name: 'Wheel Face Ceramic Coating', price: 175 },
          { id: 'ceramic_trim', name: 'Exterior Plastic Trim Ceramic Coating', price: 125 },
          { id: 'ceramic_lights', name: 'Headlights & Taillights Ceramic Coating', price: 75 },
          { id: 'ceramic_correction', name: 'Moderate Paint Correction Upgrade', price: 250 },
          { id: 'ceramic_waterspot', name: 'Water Spot Removal', price: 125 },
          { id: 'ceramic_contamination', name: 'Heavy Sap/Contamination Removal', price: 100 },
          { id: 'undercarriage', name: 'Accessible Undercarriage Cleaning', price: 125 },
          { id: 'engine_bay', name: 'Engine Bay Detail', price: 125 },
          { id: 'heavymud', name: 'Heavy Mud Removal', price: 75 },
          { id: 'mobile_water', name: 'Mobile Water Supply', price: 50 },
          { id: 'pethair', name: 'Pet Hair Removal', price: 95 },
          { id: 'odor', name: 'Odor Treatment & Sanitize', price: 90 },
        ],
      },
    },
    recalcAddonTotal() {
      context.ST.addonTotal = (context.ST.addons || []).reduce((sum, addon) => sum + Number(addon.price || 0), 0);
    },
    updateTotal() {},
    bkMoney(n) { return `$${Number(n).toFixed(2)}`; },
    getTravelFeeAmount() { return 0; },
    MutationObserver: function MutationObserver(fn) { this.fn = fn; this.observe = () => {}; },
  };
  context.window = context;
  context.global = context;
  createElement.ownerDocument = document;
  const protoFocus = createElement('a').focus;
  // focus uses owner set on elements created after document exists
  const orig = context.document.createElement;
  context.document.createElement = (tag) => {
    const el = orig(tag);
    el.owner = document;
    el.focus = function focus() { document.activeElement = el; protoFocus.call(el); };
    return el;
  };
  vm.createContext(context);
  vm.runInContext(read('assets/ceramic-booking.js'), context);
  context.document.getElementById = (id) => findId(body, id) || findId(head, id);
  return context;
}

function checkout(ctx) {
  return ctx.document.getElementById('ceramic-checkout');
}

describe('ceramic checkout cards', () => {
  let ctx;
  beforeEach(() => {
    ctx = createPage();
    ctx.CD1CeramicBooking.renderCeramicCheckout();
  });

  it('shows the $25 non-ceramic water-repellent option and hides wax, sealant, and clay', () => {
    const text = textOf(checkout(ctx));
    assert.match(text, /Windshield Water-Repellent Treatment/);
    assert.match(text, /\$25/);
    assert.match(text, /This is not a ceramic coating/);
    assert.equal(text.includes('Polymer Paint Sealant'), false);
    assert.equal(text.includes('1-Year Carnauba Wax'), false);
    assert.equal(text.includes('Clay Bar Treatment'), false);
    assert.match(text, /No additional glass protection/);
    assert.equal(ctx.document.getElementById('ceramic-more').tag, 'details');
    assert.equal(ctx.document.getElementById('ceramic-more').open, undefined);
  });

  it('keeps glass protection mutually exclusive in the total and payload', () => {
    const rain = checkout(ctx).querySelector('input[value="rainx"]');
    rain.checked = true;
    rain.dispatch('change', {});
    assert.deepEqual(Array.from(ctx.ST.addons, (addon) => String(addon.id)), ['rainx']);
    assert.equal(ctx.ST.addonTotal, 25);
    assert.equal(ctx.document.getElementById('ceramic-selection-status').textContent, 'Added — total updated');
    const glass = checkout(ctx).querySelector('input[value="ceramic_glass_all"]');
    glass.checked = true;
    glass.dispatch('change', {});
    assert.deepEqual(Array.from(ctx.ST.addons, (addon) => String(addon.id)), ['ceramic_glass_all']);
    assert.equal(ctx.ST.addonTotal, 175);
    const payload = { vehicles: [{ pkgId: 'ceramic_1yr', addons: ctx.ST.addons.slice(), subtotal: 650 + 175 }] };
    ctx.CD1CeramicBooking.boot && ctx.ST;
    const host = checkout(ctx);
    assert.equal(textOf(host).includes('Windshield Water-Repellent Treatment'), true);
    assert.equal(ctx.ST.addons.some((addon) => addon.id === 'rainx'), false);
    assert.equal(payload.vehicles[0].addons.some((addon) => addon.id === 'rainx'), false);
  });

  it('uses the canonical interior price and clears nested add-ons when interior is removed', () => {
    const box = checkout(ctx).querySelector('input[value="interior"]');
    const before = ctx.ST.companionInterior;
    const disclose = ctx.document.getElementById('interior-inclusions-btn');
    disclose.click();
    assert.equal(ctx.ST.companionInterior, before);
    assert.equal(ctx.document.getElementById('interior-inclusions').hidden, false);
    box.checked = true;
    box.dispatch('change', {});
    assert.equal(ctx.ST.companionInterior, true);
    assert.match(textOf(checkout(ctx)), /Add Complete Interior Detail/);
    assert.match(textOf(checkout(ctx)), /\$200 · approximately 2 hours/);
    assert.match(textOf(checkout(ctx)), /Pet Hair Removal/);
    const pet = checkout(ctx).querySelector('input[value="pethair"]');
    pet.checked = true;
    pet.dispatch('change', {});
    assert.equal(ctx.ST.addons.some((addon) => addon.id === 'pethair'), true);
    const interior = checkout(ctx).querySelector('input[value="interior"]');
    interior.checked = false;
    interior.dispatch('change', {});
    assert.equal(ctx.ST.companionInterior, false);
    assert.equal(ctx.ST.addons.some((addon) => addon.id === 'pethair' || addon.id === 'odor'), false);
    assert.equal(ctx.document.getElementById('companion-addons').children.length, 0);
  });

  it('selects a card from the checkbox change path and updates duration', () => {
    const lights = checkout(ctx).querySelector('input[value="ceramic_lights"]');
    assert.equal(lights.type, 'checkbox');
    assert.equal(lights.parent.tag, 'label');
    lights.checked = true;
    lights.dispatch('change', {});
    assert.equal(ctx.ST.addonTotal, 75);
    assert.equal(ctx.CD1CeramicBooking.appointmentMinutes(), 480 + 20);
    const sticky = ctx.document.getElementById('ceramic-sticky-total').textContent;
    assert.match(sticky, /\$725\.00/);
    assert.match(ctx.document.getElementById('ceramic-sticky-dur').textContent, /8 hr 20 min/);
    const shell = ctx.document.querySelector('.booking-modal');
    assert.equal(shell.classList.contains('cd1-sticky-pad'), true);
  });

  it('does not select a card when the pointer moved like a scroll', () => {
    const rain = checkout(ctx).querySelector('input[value="rainx"]');
    const card = rain.parent;
    card.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    card.dispatch('pointermove', { clientX: 0, clientY: 40 });
    let prevented = false;
    rain.dispatch('click', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(ctx.ST.addons.length, 0);
  });
});

describe('home page compression', () => {
  const html = read('index.html');
  const css = html;

  it('replaces the priced add-on strip and drops the homepage how-it-works section', () => {
    assert.match(html, /Compatible add-ons are shown during booking\./);
    assert.match(html, /Check price and options/);
    assert.equal(html.includes('id="home-addon-chips"'), false);
    assert.equal(html.includes('HOME_ADDON_IDS'), false);
    assert.equal(html.includes('id="how"'), false);
    assert.equal(html.includes('how-grid--compact'), false);
    assert.equal(html.includes('Inspect &amp; pay after'), false);
  });

  it('builds one work carousel instead of a vertical gallery dump', () => {
    assert.match(html, /initHomeWorkCarousel/);
    assert.match(html, /View more work/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(css, /scroll-snap-type:x mandatory/);
    assert.match(css, /aspect-ratio:4\/3/);
    assert.match(css, /flex-basis:calc\(50% - 6px\)/);
  });

  it('styles 48px targets and blocks horizontal overflow through 430px', () => {
    const script = read('assets/ceramic-booking.js');
    assert.match(script, /min-height:48px/);
    assert.match(script, /max-width:430px/);
    assert.match(script, /overflow-x:hidden/);
    assert.match(script, /safe-area-inset-bottom/);
    assert.match(script, /cd1-sticky-pad/);
  });
});

function productionCarsCatalog() {
  const html = read('index.html');
  const carsStart = html.indexOf('\n  cars: {');
  const trucksStart = html.indexOf('\n  trucks: {', carsStart);
  assert.ok(carsStart > 0 && trucksStart > carsStart);
  const cars = html.slice(carsStart, trucksStart);
  const suv3 = cars.match(/suv3:\s*\{[^}]+\}/);
  assert.ok(suv3);
  const tier = {
    interior: Number(suv3[0].match(/interior:(\d+)/)[1]),
    ceramic_1yr: Number(suv3[0].match(/ceramic_1yr:(\d+)/)[1]),
  };
  const addonStart = cars.indexOf('addons:[');
  assert.ok(addonStart > 0);
  const addons = [];
  const re = /\{id:'([^']+)'[\s\S]*?name:'([^']*)'[\s\S]*?price:(\d+)/g;
  re.lastIndex = addonStart;
  let match;
  while ((match = re.exec(cars))) {
    addons.push({ id: match[1], name: match[2], price: Number(match[3]), desc: '' });
  }
  return { tier, addons };
}

function clickControl(ctx, value) {
  const input = checkout(ctx).querySelector(`input[value="${value}"]`);
  assert.ok(input, `missing control ${value}`);
  input.checked = true;
  input.dispatch('change', {});
}

function visible(ctx) {
  return textOf(checkout(ctx)).replace(/\s+/g, ' ');
}

describe('MDX ceramic checkout rerenders from the production catalog', () => {
  const catalog = productionCarsCatalog();
  const rawIds = ['ceramic_windshield', 'ceramic_glass_all', 'ceramic_wheels', 'ceramic_trim', 'ceramic_lights'];

  it('reads the deployed cars catalog instead of a second price list', () => {
    assert.equal(catalog.tier.ceramic_1yr, 825);
    assert.equal(catalog.tier.interior, 255);
    assert.equal(catalog.addons.find((row) => row.id === 'rainx').price, 25);
    assert.equal(catalog.addons.find((row) => row.id === 'pethair').price, 95);
    assert.equal(catalog.addons.find((row) => row.id === 'odor').price, 90);
    assert.equal(catalog.addons.find((row) => row.id === 'ceramic_windshield').price, 100);
    const script = read('assets/ceramic-booking.js');
    assert.equal(script.includes('eval('), false);
    assert.match(read('index.html'), /window\.PRICING = PRICING/);
    assert.match(read('index.html'), /window\.ST = ST/);
  });

  it('keeps labels and totals after every click, rerender, and saved session', () => {
    const ctx = createPage();
    ctx.PRICING = { cars: { tiers: { suv3: catalog.tier }, addons: catalog.addons } };
    ctx.ST.tierKey = 'suv3';
    ctx.ST.basePrice = catalog.tier.ceramic_1yr;
    ctx.ST.vehicleLabel = '2016 Acura MDX';
    ctx.CD1CeramicBooking.renderCeramicCheckout();

    let text = visible(ctx);
    assert.match(text, /Windshield Water-Repellent Treatment/);
    assert.match(text, /\$25/);
    assert.match(text, /This is not a ceramic coating/);
    assert.match(text, /Windshield Ceramic Coating/);
    assert.match(text, /All Exterior Glass Ceramic Coating/);
    assert.match(text, /Wheel Face Ceramic Coating/);
    assert.match(text, /Exterior Plastic Trim Ceramic Coating/);
    assert.match(text, /Headlights & Taillights Ceramic Coating/);
    assert.match(text, /\$255 · approximately 2 hours/);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$825.00');
    rawIds.forEach((id) => assert.equal(text.includes(id), false, id));
    assert.equal(/\$0(?:\.00)?\b/.test(text), false);

    clickControl(ctx, 'rainx');
    text = visible(ctx);
    assert.match(text, /Windshield Water-Repellent Treatment/);
    assert.match(text, /\$25/);
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'rainx').price, 25);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$850.00');
    rawIds.forEach((id) => assert.equal(text.includes(id), false, id));
    assert.equal(/\$0(?:\.00)?\b/.test(text), false);

    clickControl(ctx, 'none');
    assert.equal(ctx.ST.addons.some((addon) => addon.id === 'rainx'), false);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$825.00');

    clickControl(ctx, 'interior');
    text = visible(ctx);
    assert.match(text, /\$255 · approximately 2 hours/);
    assert.match(text, /Pet Hair Removal/);
    assert.match(text, /\$95/);
    assert.match(text, /Odor Treatment/);
    assert.match(text, /\$90/);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$1080.00');
    assert.equal(ctx.CD1CeramicBooking.appointmentMinutes(), 480 + 120);

    clickControl(ctx, 'rainx');
    text = visible(ctx);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$1105.00');
    assert.match(ctx.document.getElementById('ceramic-sticky-dur').textContent, /10 hr 15 min/);
    assert.equal(ctx.CD1CeramicBooking.appointmentMinutes(), 480 + 15 + 120);
    assert.match(text, /\$25/);
    assert.match(text, /\$255 · approximately 2 hours/);

    clickControl(ctx, 'pethair');
    clickControl(ctx, 'odor');
    ctx.CD1CeramicBooking.renderCeramicCheckout();
    text = visible(ctx);
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'pethair').price, 95);
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'odor').price, 90);
    assert.match(text, /\$95/);
    assert.match(text, /\$90/);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$1290.00');

    clickControl(ctx, 'ceramic_windshield');
    const glassIds = Array.from(ctx.ST.addons, (addon) => String(addon.id))
      .filter((id) => id === 'rainx' || id === 'ceramic_windshield' || id === 'ceramic_glass_all');
    assert.deepEqual(glassIds, ['ceramic_windshield']);
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'ceramic_windshield').price, 100);
    text = visible(ctx);
    assert.match(text, /Windshield Ceramic Coating/);
    assert.equal(text.includes('ceramic_windshield'), false);

    const interior = checkout(ctx).querySelector('input[value="interior"]');
    interior.checked = false;
    interior.dispatch('change', {});
    text = visible(ctx);
    assert.equal(ctx.ST.companionInterior, false);
    assert.equal(ctx.ST.addons.some((addon) => addon.id === 'pethair' || addon.id === 'odor'), false);
    assert.equal(text.includes('Pet Hair Removal'), false);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$925.00');

    ctx.CD1CeramicBooking.renderCeramicCheckout();
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'ceramic_windshield').price, 100);
    assert.match(visible(ctx), /Windshield Ceramic Coating/);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$925.00');

    ctx.ST.addons = [{ id: 'rainx', name: 'rainx', price: 0 }];
    ctx.ST.companionInterior = false;
    ctx.CD1CeramicBooking.renderCeramicCheckout();
    text = visible(ctx);
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'rainx').name, 'Windshield Water-Repellent Treatment');
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'rainx').price, 25);
    assert.match(text, /Windshield Water-Repellent Treatment/);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$850.00');
    assert.equal(/\$0(?:\.00)?\b/.test(text), false);

    clickControl(ctx, 'ceramic_windshield');
    clickControl(ctx, 'ceramic_glass_all');
    text = visible(ctx);
    const glassAfterSwitch = Array.from(ctx.ST.addons, (addon) => String(addon.id))
      .filter((id) => id === 'rainx' || id === 'ceramic_windshield' || id === 'ceramic_glass_all');
    assert.deepEqual(glassAfterSwitch, ['ceramic_glass_all']);
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'ceramic_glass_all').price, 175);
    assert.match(text, /All Exterior Glass Ceramic Coating/);
    assert.match(text, /\$175/);
    assert.equal(text.includes('ceramic_glass_all'), false);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$1000.00');

    const more = ctx.document.getElementById('ceramic-more');
    assert.equal(more.tag, 'details');
    more.open = true;
    clickControl(ctx, 'ceramic_waterspot');
    text = visible(ctx);
    assert.match(text, /Water Spot Removal/);
    assert.match(text, /\$225/);
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'ceramic_waterspot').price, 225);
    assert.equal(text.includes('ceramic_waterspot'), false);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$1225.00');

    const savedVehicle = {
      pkgId: 'ceramic_1yr',
      addons: ctx.ST.addons.map((addon) => ({ id: addon.id, name: addon.id, price: 0 })),
      subtotal: 825,
    };
    ctx.ST.addons = [];
    ctx.ST.companionInterior = false;
    ctx.CD1CeramicBooking.renderCeramicCheckout();
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$825.00');
    ctx.ST.addons = savedVehicle.addons;
    ctx.CD1CeramicBooking.renderCeramicCheckout();
    text = visible(ctx);
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'ceramic_glass_all').name, 'All Exterior Glass Ceramic Coating');
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'ceramic_glass_all').price, 175);
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'ceramic_waterspot').name, 'Water Spot Removal');
    assert.equal(ctx.ST.addons.find((addon) => addon.id === 'ceramic_waterspot').price, 225);
    assert.match(text, /All Exterior Glass Ceramic Coating/);
    assert.match(text, /Water Spot Removal/);
    assert.equal(ctx.document.getElementById('ceramic-sticky-total').textContent, '$1225.00');
    rawIds.forEach((id) => assert.equal(text.includes(id), false, id));
    assert.equal(/\$0(?:\.00)?\b/.test(text), false);
  });

  it('fails closed when an add-on cannot resolve canonical metadata', () => {
    const ctx = createPage();
    ctx.PRICING = { cars: { tiers: { suv3: { interior: 255, ceramic_1yr: 825 } }, addons: [] } };
    ctx.ST.tierKey = 'suv3';
    ctx.ST.basePrice = 825;
    ctx.ST.addons = [{ id: 'ceramic_windshield', name: 'ceramic_windshield', price: 0 }];
    ctx.CD1CeramicBooking.renderCeramicCheckout();
    const text = visible(ctx);
    assert.equal(ctx.ST.addons.some((addon) => addon.id === 'ceramic_windshield'), false);
    rawIds.forEach((id) => assert.equal(text.includes(id), false, id));
    assert.equal(/\$0(?:\.00)?\b/.test(text), false);
    assert.match(text, /prices could not be confirmed/);
    assert.equal(ctx.document.getElementById('next3').disabled, true);
    assert.equal(ctx.document.getElementById('ceramic-sticky-continue').disabled, true);
  });

  it('removes eligibility questions and still shows water and payment choices', () => {
    const ctx = createPage();
    const panel = ctx.document.getElementById('ceramic-panel');
    const html = panel.innerHTML;
    assert.equal(html.includes('Ceramic Coating eligibility'), false);
    assert.equal(html.includes('repainted'), false);
    assert.equal(html.includes('type="checkbox"'), false);
    assert.match(html, /name="ceramic-water"/);
    assert.match(html, /name="ceramic-plan"/);
    assert.match(html, /prepay_full/);
    assert.match(html, /value="deposit"/);
    assert.equal(typeof ctx.CD1CeramicBooking.readAnswers, 'undefined');
  });

  it('hides Continue on the submit step and does not press the offer button', () => {
    const ctx = createPage();
    ctx.CD1CeramicBooking.renderCeramicCheckout();
    const bar = ctx.document.getElementById('ceramic-sticky');
    assert.equal(bar.classList.contains('is-on'), true);
    const bs5 = ctx.document.createElement('div');
    bs5.id = 'bs5';
    bs5.className = 'bsec on';
    const offer = ctx.document.createElement('button');
    offer.id = 'bk-offer-apply';
    offer.className = 'btn-n';
    offer.hidden = true;
    let offerClicks = 0;
    offer.click = () => { offerClicks += 1; };
    const submit = ctx.document.createElement('button');
    submit.id = 'sub-btn';
    submit.className = 'btn-sub';
    let submitClicks = 0;
    submit.click = () => { submitClicks += 1; };
    bs5.appendChild(offer);
    bs5.appendChild(submit);
    ctx.document.body.appendChild(bs5);
    ctx.document.getElementById('bs3').classList.remove('on');
    ctx.CD1CeramicBooking.renderCeramicCheckout();
    assert.equal(bar.classList.contains('is-on'), false);
    assert.equal(bar.hidden, true);
    assert.equal(ctx.document.querySelector('.booking-modal').classList.contains('cd1-sticky-pad'), false);
    ctx.document.getElementById('ceramic-sticky-continue').click();
    assert.equal(offerClicks, 0);
    assert.equal(submitClicks, 1);
  });
});
