/**
 * Idempotent Seasonal Driveway Cleanup UI + catalog insert for booking pages.
 * Does not rewrite existing Powersports add-on copy (Heavy Mud stays untouched).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PAGES = [
  'index.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

const OLD_CARS_INSERT = `{id:'seasonal_driveway_cleanup', scope:'any', name:'Driveway & Entry Cleanup', desc:'Driveway, front walkway/steps and immediate entry area. Light leaves and loose debris cleared with professional blowing equipment.', price:95},
      {id:'walkway_steps', scope:'any', name:'Front Walkway + Steps', desc:'Blower cleanup of the front walkway and entry steps.', price:35},
      {id:'porch_entry', scope:'any', name:'Porch / Entry Area', desc:'Blower cleanup of the immediate porch or entry hard-surface area.', price:45},
      {id:'small_patio', scope:'any', name:'Small Patio', desc:'Blower cleanup of one small residential patio adjacent to the entrance.', price:50},
      {id:'heavy_wet_leaf', scope:'any', name:'Heavy / Wet Leaf Buildup', desc:'For unusually heavy, wet or matted leaf buildup requiring additional time.', price:50},
      {id:'bag_place_property', scope:'any', name:'Bag & Place On Property', desc:'Leaves are bagged and placed at a customer-designated location on the property. Off-property disposal is not included.', price:35},
      {id:'pressure_surface_wash', scope:'any', name:'Pressure Wash Upgrade', desc:'Optional water-based cleaning of the driveway and immediate entry hard surfaces. Weather and site conditions permitting.', price:125},`;

const CARS_INSERT = `{id:'seasonal_driveway_cleanup', scope:'any', name:'Driveway & Entry Cleanup', desc:'Driveway + walkway/steps + immediate entry. Light leaves and loose debris cleared on-site.', price:95},
      {id:'walkway_steps', scope:'any', name:'Front Walkway + Steps', desc:'Blower cleanup of the front walkway and entry steps.', price:35},
      {id:'porch_entry', scope:'any', name:'Porch / Entry Area', desc:'Blower cleanup of the immediate porch or entry hard-surface area.', price:45},
      {id:'small_patio', scope:'any', name:'Small Patio', desc:'Blower cleanup of one small residential patio adjacent to the entrance.', price:50},
      {id:'heavy_wet_leaf', scope:'any', name:'Heavy / Wet Leaf Buildup', desc:'For unusually heavy, wet or matted leaf buildup requiring additional time.', price:50},
      {id:'bag_place_property', scope:'any', name:'Bag & Place On Property', desc:'Leaves are bagged and placed at a customer-designated location on the property. Off-property disposal is not included.', price:35},
      {id:'pressure_surface_wash', scope:'any', name:'Pressure Wash Upgrade', desc:'Optional water-based cleaning of the driveway and immediate entry hard surfaces. Weather and site conditions permitting.', price:125},`;

const RVS_INSERT = CARS_INSERT;
const OLD_RVS_INSERT = OLD_CARS_INSERT;

const OLD_POWERSPORTS_INSERT = `{id:'seasonal_driveway_cleanup', name:'Driveway & Entry Cleanup', desc:'Driveway, front walkway/steps and immediate entry area. Light leaves and loose debris cleared with professional blowing equipment.', price:95, publicNew:true},
      {id:'walkway_steps', name:'Front Walkway + Steps', desc:'Blower cleanup of the front walkway and entry steps.', price:35, publicNew:false},
      {id:'porch_entry', name:'Porch / Entry Area', desc:'Blower cleanup of the immediate porch or entry hard-surface area.', price:45, publicNew:false},
      {id:'small_patio', name:'Small Patio', desc:'Blower cleanup of one small residential patio adjacent to the entrance.', price:50, publicNew:false},
      {id:'heavy_wet_leaf', name:'Heavy / Wet Leaf Buildup', desc:'For unusually heavy, wet or matted leaf buildup requiring additional time.', price:50, publicNew:true},
      {id:'bag_place_property', name:'Bag & Place On Property', desc:'Leaves are bagged and placed at a customer-designated location on the property. Off-property disposal is not included.', price:35, publicNew:false},
      {id:'pressure_surface_wash', name:'Pressure Wash Upgrade', desc:'Optional water-based cleaning of the driveway and immediate entry hard surfaces. Weather and site conditions permitting.', price:125, publicNew:true},`;

const POWERSPORTS_INSERT = `{id:'seasonal_driveway_cleanup', name:'Driveway & Entry Cleanup', desc:'Driveway + walkway/steps + immediate entry. Light leaves and loose debris cleared on-site.', price:95, publicNew:true},
      {id:'walkway_steps', name:'Front Walkway + Steps', desc:'Blower cleanup of the front walkway and entry steps.', price:35, publicNew:false},
      {id:'porch_entry', name:'Porch / Entry Area', desc:'Blower cleanup of the immediate porch or entry hard-surface area.', price:45, publicNew:false},
      {id:'small_patio', name:'Small Patio', desc:'Blower cleanup of one small residential patio adjacent to the entrance.', price:50, publicNew:false},
      {id:'heavy_wet_leaf', name:'Heavy / Wet Leaf Buildup', desc:'For unusually heavy, wet or matted leaf buildup requiring additional time.', price:50, publicNew:true},
      {id:'bag_place_property', name:'Bag & Place On Property', desc:'Leaves are bagged and placed at a customer-designated location on the property. Off-property disposal is not included.', price:35, publicNew:false},
      {id:'pressure_surface_wash', name:'Pressure Wash Upgrade', desc:'Optional water-based cleaning of the driveway and immediate entry hard surfaces. Weather and site conditions permitting.', price:125, publicNew:true},`;

function replaceOrInsert(html, oldBlock, newBlock, marker, label) {
  if (html.includes(newBlock)) return html;
  if (oldBlock && html.includes(oldBlock)) return html.split(oldBlock).join(newBlock);
  if (marker && html.includes(marker) && !html.includes("id:'seasonal_driveway_cleanup'")) {
    return insertAfterMarker(html, marker, newBlock, label);
  }
  if (html.includes("id:'seasonal_driveway_cleanup'")) {
    throw new Error(`${label} seasonal catalog block drifted and could not be synced`);
  }
  throw new Error(`missing ${label} seasonal catalog marker`);
}

function insertAfterMarker(html, marker, insert, label) {
  const idx = html.indexOf(marker);
  if (idx < 0) throw new Error(`missing ${label} marker`);
  const at = idx + marker.length;
  return html.slice(0, at) + '\n      ' + insert + html.slice(at);
}

function patchPage(file, html) {
  let next = html;

  if (!next.includes('assets/seasonal-driveway-addon.js')) {
    if (!next.includes('assets/booking-line-items.js')) {
      throw new Error(`${file} missing booking-line-items.js include`);
    }
    next = next.replace(
      /<script src="assets\/booking-line-items\.js"[^>]*><\/script>/,
      '<script src="assets/seasonal-driveway-addon.js"></script>\n<script src="assets/booking-line-items.js" defer></script>',
    );
  }

  const carsMarker = "{id:'trashcans',  scope:'any', name:'Trash Can Cleaning',        desc:'Residential trash can cleaning at the service location. $25 each', price:25, qty:true},";
  const rvMarker = "{id:'trashcans',  scope:'any', name:'Trash Can Cleaning',        desc:' per can at RV park, campground, storage, or home', price:25, qty:true},";
  const psMarker = "{id:'lightdeg',   name:'Light Exterior Degreasing',    desc:'Light degrease of visible exterior surfaces. Detailing only — not engine service', price:45},";
  next = replaceOrInsert(next, OLD_CARS_INSERT, CARS_INSERT, carsMarker, `${file} cars`);
  next = replaceOrInsert(next, OLD_RVS_INSERT, RVS_INSERT, rvMarker, `${file} rvs`);
  next = replaceOrInsert(next, OLD_POWERSPORTS_INSERT, POWERSPORTS_INSERT, psMarker, `${file} powersports`);

  const prevCars = `{id:'seasonal_driveway_cleanup', scope:'any', name:'Driveway & Entry Cleanup', desc:'Driveway, front walkway/steps and immediate entry area. Light leaves and loose debris cleared with professional blowing equipment.', price:95},`;
  const nextCars = `{id:'seasonal_driveway_cleanup', scope:'any', name:'Driveway & Entry Cleanup', desc:'Driveway + walkway/steps + immediate entry. Light leaves and loose debris cleared on-site.', price:95},`;
  if (next.includes(prevCars)) next = next.split(prevCars).join(nextCars);
  const prevPs = `{id:'seasonal_driveway_cleanup', name:'Driveway & Entry Cleanup', desc:'Driveway, front walkway/steps and immediate entry area. Light leaves and loose debris cleared with professional blowing equipment.', price:95, publicNew:true},`;
  const nextPs = `{id:'seasonal_driveway_cleanup', name:'Driveway & Entry Cleanup', desc:'Driveway + walkway/steps + immediate entry. Light leaves and loose debris cleared on-site.', price:95, publicNew:true},`;
  if (next.includes(prevPs)) next = next.split(prevPs).join(nextPs);

  next = next.replace(
    "if(window.CD1SeasonalDriveway && CD1SeasonalDriveway.isFamilyId(a.id)) return false;\n",
    "if(window.CD1SeasonalDriveway && CD1SeasonalDriveway.isChildId(a.id)) return false;\n",
  );

  const popularIndex = "  const POPULAR_IDS=ST.cat==='powersports'?['heavymud']:ST.cat==='rvs'?['superint','sanitize','rainx','pethair','odor']:['rainx','pethair','odor'];\n  const popularAddons=addons.filter(a=>POPULAR_IDS.includes(a.id));\n  const otherAddons=addons.filter(a=>!POPULAR_IDS.includes(a.id));";
  const popularHub = "  const POPULAR_IDS=ST.cat==='rvs'?['superint','sanitize','rainx','pethair','odor']:['rainx','pethair','odor'];\n  const popularAddons=addons.filter(a=>POPULAR_IDS.includes(a.id));\n  const otherAddons=addons.filter(a=>!POPULAR_IDS.includes(a.id));";
  const popularNext = "  const POPULAR_IDS=(window.CD1SeasonalDriveway&&CD1SeasonalDriveway.popularIdsFor(ST.cat))||['rainx','pethair','odor'];\n  const popularAddons=window.CD1SeasonalDriveway&&CD1SeasonalDriveway.pickPopularAddons?CD1SeasonalDriveway.pickPopularAddons(addons,ST.cat):addons.filter(a=>POPULAR_IDS.includes(a.id)).slice(0,4);\n  const otherAddons=addons.filter(a=>POPULAR_IDS.indexOf(a.id)<0);";
  if (next.includes(popularIndex)) next = next.replace(popularIndex, popularNext);
  if (next.includes(popularHub)) next = next.replace(popularHub, popularNext);

  const oldCardHtml = "  function addonCardHtml(a){\n    const isQty=!!a.qty;\n    return `<div class=\"addon${isQty?' addon-unit':''}\" data-price=\"${a.price}\" data-id=\"${a.id}\" data-unit=\"${isQty?1:0}\" onclick=\"toggleAddon(this)\">";
  const newCardHtml = "  function addonCardHtml(a){\n    const isQty=!!a.qty;\n    const isSeasonalParent=window.CD1SeasonalDriveway&&CD1SeasonalDriveway.isParentId(a.id);\n    const seasonalOn=isSeasonalParent&&CD1SeasonalDriveway.selectedIds(ST).indexOf(a.id)>=0;\n    const click=isSeasonalParent?\"event.stopPropagation();CD1SeasonalDriveway.onCardClick('\"+a.id+\"')\":'toggleAddon(this)';\n    return `<div class=\"addon${isQty?' addon-unit':''}${seasonalOn?' sel':''}\" data-price=\"${a.price}\" data-id=\"${a.id}\" data-unit=\"${isQty?1:0}\" onclick=\"${click}\">";
  if (next.includes(oldCardHtml)) next = next.replace(oldCardHtml, newCardHtml);

  if (!next.includes("CD1SeasonalDriveway.isFamilyId")) {
    const filterNeedle = "    if(_pkgIncludesAddon[a.id]) return false;\n";
    if (!next.includes(filterNeedle)) throw new Error(`${file} missing addon dedup filter`);
    next = next.replace(
      filterNeedle,
      filterNeedle + "    if(window.CD1SeasonalDriveway && CD1SeasonalDriveway.isFamilyId(a.id)) return false;\n",
    );
  }

  if (!next.includes('CD1SeasonalDriveway.mountAddonGrid')) {
    const indexMount = '  syncRvSuperintAddonDedup();\n  updateTotal();\n}';
    const hubMount = '\'<button type="button" class="addon-toggle-btn" id="addon-toggle-btn" onclick="toggleAllAddons()">Show All Add-ons ▾</button></div>\';\n  updateTotal();\n}';
    if (next.includes(indexMount)) {
      next = next.replace(
        indexMount,
        '  syncRvSuperintAddonDedup();\n  if(window.CD1SeasonalDriveway) CD1SeasonalDriveway.mountAddonGrid(ST, PRICING);\n  updateTotal();\n}',
      );
    } else if (next.includes(hubMount)) {
      next = next.replace(
        hubMount,
        '\'<button type="button" class="addon-toggle-btn" id="addon-toggle-btn" onclick="toggleAllAddons()">Show All Add-ons ▾</button></div>\';\n  if(window.CD1SeasonalDriveway) CD1SeasonalDriveway.mountAddonGrid(ST, PRICING);\n  updateTotal();\n}',
      );
    } else {
      throw new Error(`${file} missing renderAddons close`);
    }
  }

  if (!next.includes('currentVehicleSeasonalTotal')) {
    const recalc = 'function recalcAddonTotal(){ ST.addonTotal = ST.addons.reduce((s,a)=>s + a.price*(a.qty||1), 0); }';
    if (!next.includes(recalc)) throw new Error(`${file} missing recalcAddonTotal`);
    next = next.replace(
      recalc,
      "function recalcAddonTotal(){ const _veh=(ST.addons||[]).filter(a=>!(window.CD1SeasonalDriveway&&CD1SeasonalDriveway.isFamilyId(a.id))).reduce((s,a)=>s+a.price*(a.qty||1),0); const _sea=(window.CD1SeasonalDriveway&&CD1SeasonalDriveway.currentVehicleSeasonalTotal(ST,PRICING))||0; ST.addonTotal=_veh+_sea; }",
    );
  }

  if (!next.includes('syncSeasonalOntoCart')) {
    const cartNeedle = "function renderVehicleCart(){\n  const wrap = document.getElementById('vcart-items');";
    if (!next.includes(cartNeedle)) throw new Error(`${file} missing renderVehicleCart`);
    next = next.replace(
      cartNeedle,
      "function renderVehicleCart(){\n  if(window.CD1SeasonalDriveway) CD1SeasonalDriveway.syncSeasonalOntoCart(ST, PRICING);\n  const wrap = document.getElementById('vcart-items');",
    );
  }

  if (!next.includes('decorateVehicleItem')) {
    const itemNeedle = 'function buildCurrentVehicleItem(){\n  if(!ST.pkg || !ST.vehicleLabel) return null;\n  const subtotal = ST.basePrice + ST.addonTotal;\n  return {';
    if (!next.includes(itemNeedle)) throw new Error(`${file} missing buildCurrentVehicleItem`);
    next = next.replace(
      itemNeedle,
      'function buildCurrentVehicleItem(){\n  if(!ST.pkg || !ST.vehicleLabel) return null;\n  const subtotal = ST.basePrice + ST.addonTotal;\n  const item = {',
    );
    const closeNeedle = '    addons: [...ST.addons],\n    addonTotal: ST.addonTotal,\n    subtotal,\n  };\n}';
    if (!next.includes(closeNeedle)) throw new Error(`${file} missing buildCurrentVehicleItem close`);
    next = next.replace(
      closeNeedle,
      '    addons: [...ST.addons],\n    addonTotal: ST.addonTotal,\n    subtotal,\n  };\n  if(window.CD1SeasonalDriveway) return CD1SeasonalDriveway.decorateVehicleItem(item, ST, PRICING);\n  return item;\n}',
    );
  }

  return next;
}

for (const file of PAGES) {
  const p = path.join(root, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = patchPage(file, before);
  if (after !== before) {
    fs.writeFileSync(p, after);
    console.log('patched', file);
  } else {
    console.log('unchanged', file);
  }
}

const garage = path.join(root, 'my-garage.html');
let garageHtml = fs.readFileSync(garage, 'utf8');
if (!garageHtml.includes('assets/seasonal-driveway-addon.js')) {
  garageHtml = garageHtml.replace(
    '<script src="assets/my-garage.js?v=20260805-sync-pr3" defer></script>',
    '<script src="assets/seasonal-driveway-addon.js"></script>\n<script src="assets/my-garage.js?v=20260805-sync-pr3" defer></script>',
  );
  fs.writeFileSync(garage, garageHtml);
  console.log('patched my-garage.html');
}
