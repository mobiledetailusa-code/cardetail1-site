#!/usr/bin/env node
/**
 * Release A — apply the multi-vehicle booking summary to the hub/city pages
 * that carry their own inline copy of the booking flow.
 *
 * index.html is the canonical page and is patched directly; this script brings
 * the 12 duplicated flows to the same projection. Idempotent: a page that is
 * already patched is skipped. Any page whose markup does not match exactly is
 * reported and left untouched rather than partially rewritten.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const HEAD_ANCHOR = '<link rel="stylesheet" href="assets/booking-modal-light.css">';
const HEAD_PATCH = `${HEAD_ANCHOR}
<link rel="stylesheet" href="assets/booking-summary.css">
<script src="assets/booking-line-items.js" defer></script>`;

// The city pages use an em dash placeholder where the hub pages use a hyphen.
const confirmMarkupOld = (d) => `          <div class="or"><span class="ol">Category</span><span class="ov" id="c-cat">${d}</span></div>
          <div class="or"><span class="ol">Vehicle</span><span class="ov" id="c-veh">${d}</span></div>
          <div class="or"><span class="ol">Package</span><span class="ov" id="c-pkg">${d}</span></div>
          <div class="or"><span class="ol">Pkg price</span><span class="ov" id="c-pprice">${d}</span></div>
          <div id="c-addon-rows"></div>
          <div class="or"><span class="ol" style="color:var(--white);font-weight:600">Total</span><span class="oc-total" id="c-total">${d}</span></div>`;

const confirmMarkupNew = (d) => `          <div id="c-vehicle-cards"></div>
          <div class="or"><span class="ol bkli-total-label">Estimated total</span><span class="oc-total" id="c-total">${d}</span></div>`;

const SERVICE_TITLE_OLD = `          <div class="oc-t">Service</div>
          <div class="confirm-vehicle-visual" id="c-visual"></div>`;
const SERVICE_TITLE_NEW = `          <div class="oc-t" id="c-service-title">Service</div>
          <div class="confirm-vehicle-visual" id="c-visual"></div>`;

const successMarkupOld = (d) => `            <div class="or"><span class="ol">Package</span><span class="ov" id="ok-pkg">${d}</span></div>
            <div class="or"><span class="ol">Vehicle</span><span class="ov" id="ok-veh">${d}</span></div>
            <div class="or"><span class="ol">Total</span><span class="ov" id="ok-total" style="color:var(--blue);font-weight:700">${d}</span></div>`;

const successMarkupNew = (d) => `            <div id="ok-vehicle-cards"></div>
            <div class="or"><span class="ol bkli-total-label">Total</span><span class="ov" id="ok-total" style="color:var(--blue);font-weight:700">${d}</span></div>`;

/**
 * Shared helpers. The authoritative implementation is
 * assets/booking-line-items.js; the inline fallback only keeps the summary
 * itemized if that asset fails to load.
 */
const HELPERS = `// ── Multi-vehicle line items (Release A) ─────────────────────────────────────
// Single source of truth: assets/booking-line-items.js, shared with the
// confirmation email so Review, confirmation and email itemize identically.
function bkliMoney(n){ return '$' + (Number(n) || 0).toFixed(2); }
function bkliEsc(v){
  return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function bkProjectVehicles(source){
  if (window.Cardetail1LineItems) return window.Cardetail1LineItems.projectBooking(source);
  const raw = Array.isArray(source) ? source : (source && source.vehicles);
  const list = Array.isArray(raw) ? raw.filter(Boolean) : [];
  const items = list.map((v,i)=>{
    const addons=(Array.isArray(v.addons)?v.addons:[]).map(a=>({
      name:String(a.name||'Add-on'), qty:Number(a.qty)>0?Number(a.qty):1,
      price:Number(a.price)||0, lineTotal:(Number(a.price)||0)*(Number(a.qty)>0?Number(a.qty):1),
    }));
    const addonTotal = v.addonTotal!=null?Number(v.addonTotal):addons.reduce((s,a)=>s+a.lineTotal,0);
    const packagePrice = v.basePrice!=null?Number(v.basePrice):null;
    return {
      key:String(v.vehicleId||v.id||('vehicle-'+i)), index:i,
      label:String(v.vehicleLabel||'Vehicle'),
      packageName:String(v.pkgName||v.packageName||'Package'),
      packagePrice, addons, addonTotal,
      subtotal:v.subtotal!=null?Number(v.subtotal):((packagePrice||0)+addonTotal),
    };
  });
  return {items, itemsSubtotal:items.reduce((s,i)=>s+(i.subtotal||0),0), vehicleCount:items.length};
}
function bkRenderVehicleSummary(items){
  if (window.Cardetail1LineItems) return window.Cardetail1LineItems.renderSummaryHtml(items);
  const list = Array.isArray(items)?items:[];
  const multi = list.length>1;
  return list.map((it,idx)=>{
    let rows='<div class="or"><span class="ol">'+bkliEsc(it.packageName)+'</span><span class="ov">'+(it.packagePrice==null?'Estimate':bkliMoney(it.packagePrice))+'</span></div>';
    rows += it.addons.length
      ? it.addons.map(a=>'<div class="or"><span class="ol">+ '+bkliEsc(a.name)+(a.qty>1?' × '+a.qty:'')+'</span><span class="ov">+'+bkliMoney(a.lineTotal)+'</span></div>').join('')
      : '<div class="or"><span class="ol">Add-ons</span><span class="ov bkli-none">None</span></div>';
    if(multi) rows+='<div class="or bkli-subtotal"><span class="ol">Vehicle subtotal</span><span class="ov">'+bkliMoney(it.subtotal)+'</span></div>';
    return '<section class="bkli-vehicle" aria-label="Vehicle '+(idx+1)+' of '+list.length+'">'+
      '<h4 class="bkli-vehicle-title">'+(multi?'<span class="bkli-vehicle-index">'+(idx+1)+'</span>':'')+
      '<span class="bkli-vehicle-name">'+bkliEsc(it.label)+'</span></h4>'+rows+'</section>';
  }).join('');
}

function fillConfirm(){`;

const fillConfirmOld = (d) => `  const catLabels={cars:'Cars & Trucks',boats:'Boats & Marine',rvs:'RVs & Trailers',powersports:'Powersports',fleet:'Fleet Services'};
  const visual=VEHICLE_VISUALS[getVehicleVisualKey()]||CATEGORY_VISUALS[ST.cat]||VEHICLE_VISUALS.sedan;
  const visualEl=document.getElementById('c-visual');
  if(visualEl) visualEl.innerHTML=\`<img src="\${visual.img}" alt="\${visual.alt}" width="720" height="720" loading="lazy" decoding="async">\`;
  document.getElementById('c-cat').textContent=catLabels[ST.cat]||ST.cat;
  document.getElementById('c-veh').textContent=ST.vehicleLabel;
  document.getElementById('c-pkg').textContent=(ST.pkg?.name||'${d}')+' Package';
  document.getElementById('c-pprice').textContent=ST.basePrice ? '$'+(ST.basePrice+fee) : 'Estimate';`;

const FILLCONFIRM_NEW = `  // Every booked vehicle itemizes here — never the current single-vehicle
  // selection with a cart-wide package price pinned to it.
  const projection=bkProjectVehicles(vehicles);
  const firstVeh=vehicles[0]||{};
  const visual=VEHICLE_VISUALS[(vehicles.length===1&&firstVeh.visualKey)||getVehicleVisualKey()]||CATEGORY_VISUALS[firstVeh.cat||ST.cat]||VEHICLE_VISUALS.sedan;
  const visualEl=document.getElementById('c-visual');
  if(visualEl){
    visualEl.style.display=vehicles.length>1?'none':'';
    visualEl.innerHTML=vehicles.length>1?'':\`<img src="\${visual.img}" alt="\${visual.alt}" width="720" height="720" loading="lazy" decoding="async">\`;
  }
  const serviceTitleEl=document.getElementById('c-service-title');
  if(serviceTitleEl) serviceTitleEl.textContent=vehicles.length>1?('Service · '+vehicles.length+' vehicles'):'Service';
  const cardsEl=document.getElementById('c-vehicle-cards');
  if(cardsEl) cardsEl.innerHTML=bkRenderVehicleSummary(projection.items);`;

const ADDON_ROWS_OLD = `  document.getElementById('c-addon-rows').innerHTML=ST.addons.length
    ?ST.addons.map(a=>\`<div class="or"><span class="ol">+ \${a.name}\${a.qty>1?' Ã—'+a.qty:''}</span><span class="ov">+$\${a.price*(a.qty||1)}</span></div>\`).join('')
    :'<div class="or"><span class="ol">Add-ons</span><span class="ov" style="color:var(--mu)">None</span></div>';
`;

const showSuccessOld = (d) => `  document.getElementById('ok-pkg').textContent=(ST.pkg?.name||b.package||'${d}')+' Package';
  document.getElementById('ok-veh').textContent=ST.vehicleLabel||b.vehicle||'${d}';`;

const SHOWSUCCESS_NEW = `  // Itemize from the submitted payload's authoritative vehicles[], not from the
  // leftover single-vehicle selection state.
  const okCards=document.getElementById('ok-vehicle-cards');
  if(okCards) okCards.innerHTML=bkRenderVehicleSummary(bkProjectVehicles(b).items);`;

const editsFor = (d) => [
  ['head assets', HEAD_ANCHOR, HEAD_PATCH],
  ['service title', SERVICE_TITLE_OLD, SERVICE_TITLE_NEW],
  ['confirm markup', confirmMarkupOld(d), confirmMarkupNew(d)],
  ['success markup', successMarkupOld(d), successMarkupNew(d)],
  ['helpers + fillConfirm head', 'function fillConfirm(){', HELPERS],
  ['fillConfirm service rows', fillConfirmOld(d), FILLCONFIRM_NEW],
  ['fillConfirm addon rows', ADDON_ROWS_OLD, ''],
  ['showSuccess', showSuccessOld(d), SHOWSUCCESS_NEW],
];

const PLACEHOLDERS = ['-', '—'];

function patch(file) {
  const abs = path.join(root, file);
  let src = fs.readFileSync(abs, 'utf8');
  if (src.includes('assets/booking-line-items.js')) return { file, status: 'already-patched' };

  // These pages are CRLF; keep every needle and replacement in the file's own
  // line ending so the patch never rewrites unrelated lines.
  const crlf = src.includes('\r\n');
  const eol = (text) => (crlf ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n'));

  let edits = null;
  let problems = [];
  for (const placeholder of PLACEHOLDERS) {
    const candidate = editsFor(placeholder);
    const issues = candidate
      .map(([label, needle]) => [label, src.split(eol(needle)).length - 1])
      .filter(([, hits]) => hits !== 1)
      .map(([label, hits]) => `${label}: expected 1 occurrence, found ${hits}`);
    if (!issues.length) { edits = candidate; break; }
    if (!problems.length || issues.length < problems.length) problems = issues;
  }
  if (!edits) return { file, status: 'skipped', problems };

  // Function replacements only: these blocks contain "'$'" and String.replace
  // would read that as the $' insert-everything-after pattern.
  for (const [, needle, replacement] of edits) {
    src = src.replace(eol(needle), () => eol(replacement));
  }
  fs.writeFileSync(abs, src, 'utf8');
  return { file, status: 'patched' };
}

const pages = fs.readdirSync(root)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => f !== 'index.html')
  .filter((f) => fs.readFileSync(path.join(root, f), 'utf8').includes('function fillConfirm('));

let failed = 0;
for (const page of pages) {
  const result = patch(page);
  if (result.status === 'skipped') {
    failed += 1;
    console.error(`SKIPPED ${result.file}`);
    result.problems.forEach((p) => console.error(`   - ${p}`));
  } else {
    console.log(`${result.status.padEnd(15)} ${result.file}`);
  }
}
console.log(`\n${pages.length} pages considered, ${failed} skipped.`);
process.exit(failed ? 1 : 0);
