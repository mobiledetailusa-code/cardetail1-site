$files = @(
  'bergen-county-hub.html','hudson-county-hub.html','essex-county-hub.html','passaic-county-hub.html',
  'ny-metro-hub.html','connecticut-hub.html','newark-mobile-detailing.html',
  'westchester-mobile-detailing.html','trenton-mobile-detailing.html','template-city.html'
)
$root = Split-Path -Parent $PSScriptRoot

$pairs = @(
  @{
    Old = @'
function getTravelFeeAmount(){ return ST.travelFee||0; }

const ZIP_ZONES = {
'@
    New = @'
function getTravelFeeAmount(){ return ST.travelFee||0; }
function getKnownZip5(){
  for(const id of ['bk-zip','hero-zip','loc-zip']){
    const el=document.getElementById(id);
    if(el){ const z=String(el.value||'').replace(/\D/g,'').slice(0,5); if(z.length===5) return z; }
  }
  const stored=sessionStorage.getItem('cd1_zip');
  if(stored){ const z=String(stored).replace(/\D/g,'').slice(0,5); if(z.length===5) return z; }
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
    rvs:LENGTH_PRICING.rvs.packages.exterior.min,
    powersports:Math.min(...Object.values(PRICING.powersports.tiers).map(t=>Object.values(t).filter(v=>typeof v==='number')[0]||99)),
  };
}
function formatLocFrom(cat){
  if(cat==='fleet') return 'From $60/unit';
  syncTravelFromKnownZip();
  const fee=getKnownZip5()&&activeZone?getTravelFeeAmount():0;
  return 'From $'+(applyRichPrice(getCategoryFromBases()[cat])+fee);
}

const ZIP_ZONES = {
'@
  }
  @{
    Old = @'
function updateBkFromPrices(){
  // Base "from" prices per category (cheapest tier, cheapest package)
  const BASE = {
    cars:       {label:'From $', price: Math.min(...Object.values(PRICING.cars.tiers).map(t=>t.maint))},
    boats:      {label:'From $', price: LENGTH_PRICING.boats.packages.maint.min},
    rvs:        {label:'From $', price: LENGTH_PRICING.rvs.packages.exterior.min},
    powersports:{label:'From $', price: Math.min(...Object.values(PRICING.powersports.tiers).map(t=>Object.values(t).filter(v=>typeof v==='number')[0]||99))},
    fleet:      {label:'From $', price: null, fixed:'From $60/unit'},
  };
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('bkfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    const adj = applyRichPrice(info.price);
    el.textContent = 'From $'+adj;
  });
}
'@
    New = @'
function updateBkFromPrices(){
  const BASE = {
    cars:       {label:'From $', price: Math.min(...Object.values(PRICING.cars.tiers).map(t=>t.maint))},
    boats:      {label:'From $', price: LENGTH_PRICING.boats.packages.maint.min},
    rvs:        {label:'From $', price: LENGTH_PRICING.rvs.packages.exterior.min},
    powersports:{label:'From $', price: Math.min(...Object.values(PRICING.powersports.tiers).map(t=>Object.values(t).filter(v=>typeof v==='number')[0]||99))},
    fleet:      {label:'From $', price: null, fixed:'From $60/unit'},
  };
  const bkZip=document.getElementById('bk-zip');
  const zip5=bkZip?String(bkZip.value||'').replace(/\D/g,'').slice(0,5):'';
  const fee=(zip5.length===5&&resolveZipService(zip5))?getTravelFeeAmount():0;
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('bkfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    el.textContent = 'From $'+(applyRichPrice(info.price)+fee);
  });
}
'@
  }
  @{
    Old = @'
function _updateHomeFromPrices(){
  const BASE = {
    cars:        { price: Math.min(...Object.values(PRICING.cars.tiers).map(t=>t.maint)), suffix:' · by vehicle size' },
    boats:       { price: LENGTH_PRICING.boats.packages.maint.min,     suffix:' · by vessel length' },
    rvs:         { price: LENGTH_PRICING.rvs.packages.exterior.min,    suffix:' · by RV length' },
    powersports: { price: Math.min(...Object.values(PRICING.powersports.tiers).map(t=> Object.values(t).filter(v=>typeof v==='number')[0]||89)), suffix:' · by vehicle type' },
    fleet:       { price: null, fixed:'From $60/unit · Fleet quote available' },
  };
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('hfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    const adj = applyRichPrice(info.price);
    el.textContent = 'From $'+adj + info.suffix;
  });
}
'@
    New = @'
function _updateHomeFromPrices(){
  syncTravelFromKnownZip();
  const fee=getKnownZip5()&&activeZone?getTravelFeeAmount():0;
  const BASE = {
    cars:        { price: Math.min(...Object.values(PRICING.cars.tiers).map(t=>t.maint)), suffix:' · by vehicle size' },
    boats:       { price: LENGTH_PRICING.boats.packages.maint.min,     suffix:' · by vessel length' },
    rvs:         { price: LENGTH_PRICING.rvs.packages.exterior.min,    suffix:' · by RV length' },
    powersports: { price: Math.min(...Object.values(PRICING.powersports.tiers).map(t=> Object.values(t).filter(v=>typeof v==='number')[0]||89)), suffix:' · by vehicle type' },
    fleet:       { price: null, fixed:'From $60/unit · Fleet quote available' },
  };
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('hfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    el.textContent = 'From $'+(applyRichPrice(info.price)+fee) + info.suffix;
  });
}
'@
  }
  @{
    Old = '      <div class="loc-from">${d.from}</div>`;'
    New = '      <div class="loc-from">${formatLocFrom(cat)}</div>`;'
  }
  @{
    Old = @'
  renderLocationCarousel(svc ? (svc.zone.key||'default') : 'default');
}

function renderLocationCarousel(zoneKey){
'@
    New = @'
  renderLocationCarousel(svc ? (svc.zone.key||'default') : 'default');
  if(typeof _updateHomeFromPrices==='function') _updateHomeFromPrices();
  if(typeof updateBkFromPrices==='function') updateBkFromPrices();
}

function renderLocationCarousel(zoneKey){
'@
  }
)

foreach ($f in $files) {
  $fp = Join-Path $root $f
  if (-not (Test-Path $fp)) { Write-Output "Skip missing $f"; continue }
  $html = [IO.File]::ReadAllText($fp)
  $orig = $html
  foreach ($pair in $pairs) {
    $html = $html.Replace($pair.Old, $pair.New)
  }
  if ($html -ne $orig) {
    [IO.File]::WriteAllText($fp, $html)
    Write-Output "Patched $f"
  } else {
    Write-Output "No changes $f"
  }
}

Write-Output 'Done.'
