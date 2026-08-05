const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const htmlFiles = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'newark-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'template-city.html',
];

const helpersAnchor = `function getTravelFeeAmount(){ return ST.travelFee||0; }

const ZIP_ZONES = {`;

const helpersBlock = `function getTravelFeeAmount(){ return ST.travelFee||0; }
function getKnownZip5(){
  for(const id of ['bk-zip','hero-zip','loc-zip']){
    const el=document.getElementById(id);
    if(el){ const z=String(el.value||'').replace(/\\D/g,'').slice(0,5); if(z.length===5) return z; }
  }
  const stored=sessionStorage.getItem('cd1_zip');
  if(stored){ const z=String(stored).replace(/\\D/g,'').slice(0,5); if(z.length===5) return z; }
  return null;
}
function syncTravelFromKnownZip(){
  const z=getKnownZip5();
  if(z&&resolveZipService(z)) applyTravelForZip(z);
}
function getCategoryFromBases(){
  return {
    cars:Math.min(...Object.values(PRICING.cars.tiers).map(t=>t.maint)),
    boats:LENGTH_PRICING.boats.packages.maint.min,
    rvs:getLengthPrice('rvs','maint',LENGTH_PRICING.rvs.min),
    powersports:Math.min(...Object.values(PRICING.powersports.tiers).map(t=>Object.values(t).filter(v=>typeof v==='number')[0]||99)),
  };
}
function formatLocFrom(cat){
  if(cat==='fleet') return 'From $50/unit';
  syncTravelFromKnownZip();
  const fee=getKnownZip5()&&activeZone?getTravelFeeAmount():0;
  return 'From $'+(applyRichPrice(getCategoryFromBases()[cat])+fee);
}

const ZIP_ZONES = {`;

const updateBkFromPricesOld = `function updateBkFromPrices(){
  // Base "from" prices per category (cheapest tier, cheapest package)
  const BASE = {
    cars:       {label:'From $', price: Math.min(...Object.values(PRICING.cars.tiers).map(t=>t.maint))},
    boats:      {label:'From $', price: LENGTH_PRICING.boats.packages.maint.min},
    rvs:        {label:'From $', price: getLengthPrice('rvs','maint',LENGTH_PRICING.rvs.min)},
    powersports:{label:'From $', price: Math.min(...Object.values(PRICING.powersports.tiers).map(t=>Object.values(t).filter(v=>typeof v==='number')[0]||99))},
    fleet:      {label:'From $', price: null, fixed:'From $50/unit'},
  };
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('bkfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    const adj = applyRichPrice(info.price);
    el.textContent = 'From $'+adj;
  });
}`;

const updateBkFromPricesNew = `function updateBkFromPrices(){
  const BASE = {
    cars:       {label:'From $', price: Math.min(...Object.values(PRICING.cars.tiers).map(t=>t.maint))},
    boats:      {label:'From $', price: LENGTH_PRICING.boats.packages.maint.min},
    rvs:        {label:'From $', price: getLengthPrice('rvs','maint',LENGTH_PRICING.rvs.min)},
    powersports:{label:'From $', price: Math.min(...Object.values(PRICING.powersports.tiers).map(t=>Object.values(t).filter(v=>typeof v==='number')[0]||99))},
    fleet:      {label:'From $', price: null, fixed:'From $50/unit'},
  };
  const bkZip=document.getElementById('bk-zip');
  const zip5=bkZip?String(bkZip.value||'').replace(/\\D/g,'').slice(0,5):'';
  const fee=(zip5.length===5&&resolveZipService(zip5))?getTravelFeeAmount():0;
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('bkfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    el.textContent = 'From $'+(applyRichPrice(info.price)+fee);
  });
}`;

const updateHomeFromPricesOld = `function _updateHomeFromPrices(){
  const BASE = {
    cars:        { price: Math.min(...Object.values(PRICING.cars.tiers).map(t=>t.maint)), suffix:' · by vehicle size' },
    boats:       { price: LENGTH_PRICING.boats.packages.maint.min,     suffix:' · by vessel length' },
    rvs:         { price: getLengthPrice('rvs','maint',LENGTH_PRICING.rvs.min), suffix:' · by RV length' },
    powersports: { price: Math.min(...Object.values(PRICING.powersports.tiers).map(t=> Object.values(t).filter(v=>typeof v==='number')[0]||89)), suffix:' · by vehicle type' },
    fleet:       { price: null, fixed:'From $50/unit · Fleet quote available' },
  };
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('hfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    const adj = applyRichPrice(info.price);
    el.textContent = 'From $'+adj + info.suffix;
  });
}`;

const updateHomeFromPricesNew = `function _updateHomeFromPrices(){
  syncTravelFromKnownZip();
  const fee=getKnownZip5()&&activeZone?getTravelFeeAmount():0;
  const BASE = {
    cars:        { price: Math.min(...Object.values(PRICING.cars.tiers).map(t=>t.maint)), suffix:' · by vehicle size' },
    boats:       { price: LENGTH_PRICING.boats.packages.maint.min,     suffix:' · by vessel length' },
    rvs:         { price: getLengthPrice('rvs','maint',LENGTH_PRICING.rvs.min), suffix:' · by RV length' },
    powersports: { price: Math.min(...Object.values(PRICING.powersports.tiers).map(t=> Object.values(t).filter(v=>typeof v==='number')[0]||89)), suffix:' · by vehicle type' },
    fleet:       { price: null, fixed:'From $50/unit · Fleet quote available' },
  };
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('hfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    el.textContent = 'From $'+(applyRichPrice(info.price)+fee) + info.suffix;
  });
}`;

const locFromOld = `      <div class="loc-from">${d.from}</div>\`;`;
const locFromNew = `      <div class="loc-from">${formatLocFrom(cat)}</div>\`;`;

const gateMsgOld =
  "if(gateMsg){ gateMsg.classList.add('unlocked'); gateMsg.innerHTML='<span class=\"zg-ico\">✅</span><span>'+(cityName ? cityName+' — ' : '')+'select your service below</span>'; }";
const gateMsgNew =
  "if(gateMsg){ gateMsg.classList.add('unlocked'); gateMsg.innerHTML='<span class=\"zg-ico\">✅</span><span>'+(cityName ? cityName+' — ' : '')+'select your service below</span><span style=\"font-size:11px;color:var(--mu);font-weight:400;margin-left:6px\">· Prices include service to your area</span>'; }";

const applyZipOld = `  renderLocationCarousel(svc ? (svc.zone.key||'default') : 'default');
}`;

const applyZipNew = `  renderLocationCarousel(svc ? (svc.zone.key||'default') : 'default');
  if(typeof _updateHomeFromPrices==='function') _updateHomeFromPrices();
  if(typeof updateBkFromPrices==='function') updateBkFromPrices();
}`;

const replacements = [
  [helpersAnchor, helpersBlock],
  [updateBkFromPricesOld, updateBkFromPricesNew],
  [updateHomeFromPricesOld, updateHomeFromPricesNew],
  [locFromOld, locFromNew],
  [gateMsgOld, gateMsgNew],
  [applyZipOld, applyZipNew],
];

for (const file of htmlFiles) {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) {
    console.warn('Skip missing', file);
    continue;
  }
  let html = fs.readFileSync(fp, 'utf8');
  let changed = false;
  for (const [oldStr, newStr] of replacements) {
    if (html.includes(oldStr)) {
      html = html.replace(oldStr, newStr);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(fp, html);
    console.log('Patched', file);
  } else {
    console.log('No changes', file);
  }
}

console.log('Done.');
