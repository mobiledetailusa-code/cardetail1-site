const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const cssInsert = `.hub-radius-section{background:var(--bg1);padding:48px 24px 56px;border-top:1px solid rgba(255,255,255,.04)}
.hub-radius-inner{max-width:640px;margin:0 auto;text-align:center}
.hub-radius-desc{font-size:15px;color:var(--mu);line-height:1.75;margin-bottom:12px}
.hub-radius-note{font-size:13px;color:rgba(138,155,176,.75);line-height:1.6}
.bk-travel-line{display:none;font-size:12px;color:var(--mu);margin:-4px 0 14px;padding:10px 14px;background:rgba(245,166,35,.06);border:1px solid rgba(245,166,35,.2);border-radius:var(--rs);line-height:1.5}
.bk-travel-line.no-fee{background:rgba(34,197,94,.06);border-color:rgba(34,197,94,.2)}
`;

const radiusSections = {
  'bergen-county-hub.html': 'Hackensack / Palisades Park',
  'hudson-county-hub.html': 'Jersey City',
  'essex-county-hub.html': 'Newark',
  'passaic-county-hub.html': 'Paterson',
  'ny-metro-hub.html': 'Manhattan',
  'connecticut-hub.html': 'Waterbury',
};

function radiusHtml(anchor) {
  return `
<!-- MOBILE SERVICE RADIUS -->
<section class="hub-radius-section" id="service-radius" aria-label="Mobile service radius">
  <div class="hub-radius-inner">
    <div class="sec-eye">Coverage</div>
    <div class="sec-title">MOBILE SERVICE<br><span style="color:var(--blue)">RADIUS</span></div>
    <p class="hub-radius-desc">We operate from our <strong>${anchor}</strong> hub and travel up to <strong>150 miles</strong> to your driveway, marina, or fleet yard. Enter your ZIP above — we'll confirm coverage and unlock booking for your area.</p>
    <p class="hub-radius-note">Most areas within 30 miles are covered at standard rates. Final pricing is shown when you select a package during booking.</p>
  </div>
</section>
`;
}

const oldOnBkZip = `function onBkZipInput(val){
  const digits = val.replace(/\\D/g,'');
  if(digits.length < 5){ return; }
  const zip5 = digits.substring(0,5);
  const svc = applyTravelForZip(zip5);

  richMultiplier = getRichMultiplier(zip5);
  const richBadge = document.getElementById('bk-rich-badge');
  if(richBadge) richBadge.style.display = richMultiplier > 1 ? 'inline-flex' : 'none';

  const badge    = document.getElementById('bk-zone-badge');
  const surBadge = document.getElementById('bk-surcharge-badge');
  const gateMsg  = document.getElementById('bk-gate-msg');

  if(svc){
    const zone = svc.zone;
    const cityName = getCityByZip(zip5);
    badge.style.display = 'inline-flex';
    badge.textContent   = '✓ ' + (cityName ? cityName : zone.short);
    if(surBadge) surBadge.style.display = 'none';
    document.querySelectorAll('#bk-cat-grid .svc-card').forEach(c=>c.classList.remove('locked'));
    if(gateMsg){ gateMsg.classList.add('unlocked'); gateMsg.innerHTML='<span class="zg-ico">✅</span><span>'+(cityName ? cityName+' — ' : '')+'select your service below</span>'; }
    updateBkFromPrices();
    renderLocationCarousel(zone.key||'default');
  } else {
    badge.style.display    = 'none';
    if(surBadge) surBadge.style.display = 'none';
    document.querySelectorAll('#bk-cat-grid .svc-card').forEach(c=>c.classList.add('locked'));
    if(gateMsg){ gateMsg.classList.remove('unlocked'); gateMsg.innerHTML='<span class="zg-ico">⚠️</span><span>Outside our '+TRAVEL_MAX_MILES+'-mile area — call 551-373-5668</span>'; }
  }
  updateTotal();
}`;

const newOnBkZip = `function updateBkTravelDisplay(svc){
  const surBadge = document.getElementById('bk-surcharge-badge');
  const travelLine = document.getElementById('bk-travel-line');
  if(surBadge) surBadge.style.display = 'none';
  if(travelLine){ travelLine.style.display = 'none'; travelLine.className = 'bk-travel-line'; travelLine.innerHTML = ''; }
}

${oldOnBkZip.replace(
  "  const badge    = document.getElementById('bk-zone-badge');\n  const surBadge = document.getElementById('bk-surcharge-badge');\n  const gateMsg  = document.getElementById('bk-gate-msg');",
  "  const badge    = document.getElementById('bk-zone-badge');\n  const gateMsg  = document.getElementById('bk-gate-msg');"
).replace(
  "    if(surBadge) surBadge.style.display = 'none';\n    document.querySelectorAll('#bk-cat-grid .svc-card').forEach(c=>c.classList.remove('locked'));",
  "    updateBkTravelDisplay(svc);\n    document.querySelectorAll('#bk-cat-grid .svc-card').forEach(c=>c.classList.remove('locked'));"
).replace(
  "    badge.style.display    = 'none';\n    if(surBadge) surBadge.style.display = 'none';",
  "    badge.style.display    = 'none';\n    updateBkTravelDisplay(null);"
)}`;

for (const [file, anchor] of Object.entries(radiusSections)) {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) {
    console.warn('Skip missing', file);
    continue;
  }
  let html = fs.readFileSync(fp, 'utf8');

  if (!html.includes('.hub-radius-section')) {
    html = html.replace('.hero-zip-err{font-size:12px;color:var(--rd);font-weight:500}', '.hero-zip-err{font-size:12px;color:var(--rd);font-weight:500}\n' + cssInsert);
  }

  if (!html.includes('id="service-radius"')) {
    html = html.replace(
      '</section>\n\n<!-- LOCATION CAROUSEL -->',
      '</section>\n' + radiusHtml(anchor) + '\n<!-- LOCATION CAROUSEL -->'
    );
  }

  if (!html.includes('id="bk-travel-line"')) {
    html = html.replace(
      `<div class="zip-gate-msg" id="bk-gate-msg">
          <span class="zg-ico">📍</span>
          <span>Enter your 5-digit ZIP code to unlock services and see local pricing</span>
        </div>
        <div class="service-grid" id="bk-cat-grid"`,
      `<div class="zip-gate-msg" id="bk-gate-msg">
          <span class="zg-ico">📍</span>
          <span>Enter your 5-digit ZIP code to unlock services and see local pricing</span>
        </div>
        <div class="bk-travel-line" id="bk-travel-line"></div>
        <div class="service-grid" id="bk-cat-grid"`
    );
  }

  if (html.includes(oldOnBkZip) && !html.includes('function updateBkTravelDisplay')) {
    html = html.replace(oldOnBkZip, newOnBkZip);
  }

  fs.writeFileSync(fp, html);
  console.log('Patched', file);
}
