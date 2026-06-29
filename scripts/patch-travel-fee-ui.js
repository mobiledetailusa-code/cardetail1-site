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

const oldUpdateBkTravelDisplay = `function updateBkTravelDisplay(svc){
  const surBadge = document.getElementById('bk-surcharge-badge');
  const travelLine = document.getElementById('bk-travel-line');
  if(!svc){
    if(surBadge) surBadge.style.display = 'none';
    if(travelLine){ travelLine.style.display = 'none'; travelLine.className = 'bk-travel-line'; }
    return;
  }
  const fee = svc.fee || 0;
  const miles = svc.miles || 0;
  if(surBadge){
    surBadge.style.display = 'inline-flex';
    if(fee > 0){
      surBadge.style.color = '';
      surBadge.textContent = '+$' + fee + ' travel';
    } else {
      surBadge.style.color = 'var(--gr)';
      surBadge.textContent = 'No travel fee';
    }
  }
  if(travelLine){
    travelLine.style.display = 'block';
    travelLine.className = fee > 0 ? 'bk-travel-line' : 'bk-travel-line no-fee';
    travelLine.innerHTML = fee > 0
      ? '📍 ~' + miles + ' mi from our hub · <strong>+$' + fee + ' travel fee</strong> per appointment (distance-based, shown before checkout)'
      : '📍 ~' + miles + ' mi from our hub · <strong>No travel fee</strong> for your area';
  }
}`;

const newUpdateBkTravelDisplay = `function updateBkTravelDisplay(svc){
  const surBadge = document.getElementById('bk-surcharge-badge');
  const travelLine = document.getElementById('bk-travel-line');
  if(surBadge) surBadge.style.display = 'none';
  if(travelLine){ travelLine.style.display = 'none'; travelLine.className = 'bk-travel-line'; travelLine.innerHTML = ''; }
}`;

const renderPackagesAnchor = `      startPrice=applyRichPrice(sampleTier[p.id]||sampleTier.maint||sampleTier.wash||sampleTier.exterior);
    }
    return \`<div class="pkg`;

const renderPackagesReplacement = `      startPrice=applyRichPrice(sampleTier[p.id]||sampleTier.maint||sampleTier.wash||sampleTier.exterior);
    }
    if(p.id!=='custom') startPrice += getTravelFeeAmount();
    return \`<div class="pkg`;

const updateBkFromPricesOld = `  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('bkfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    const adj = applyRichPrice(info.price);
    el.textContent = 'From $'+adj;
  });`;

const updateBkFromPricesNew = `  const bkZip=document.getElementById('bk-zip');
  const zip5=bkZip?String(bkZip.value||'').replace(/\\D/g,'').slice(0,5):'';
  const fee=(zip5.length===5&&resolveZipService(zip5))?getTravelFeeAmount():0;
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('bkfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    el.textContent = 'From $'+(applyRichPrice(info.price)+fee);
  });`;

const updateHomeFromPricesOld = `  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('hfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    const adj = applyRichPrice(info.price);
    el.textContent = 'From $'+adj + info.suffix;
  });`;

const updateHomeFromPricesNew = `  syncTravelFromKnownZip();
  const fee=getKnownZip5()&&activeZone?getTravelFeeAmount():0;
  Object.entries(BASE).forEach(([cat, info])=>{
    const el = document.getElementById('hfrom-'+cat);
    if(!el) return;
    if(info.fixed){ el.textContent = info.fixed; return; }
    el.textContent = 'From $'+(applyRichPrice(info.price)+fee) + info.suffix;
  });`;

const replacements = [
  [oldUpdateBkTravelDisplay, newUpdateBkTravelDisplay],
  [renderPackagesAnchor, renderPackagesReplacement],
  [updateBkFromPricesOld, updateBkFromPricesNew],
  [updateHomeFromPricesOld, updateHomeFromPricesNew],
  [
    "document.getElementById('s5-total').textContent=cartBase?'$'+(cartBase+fee)+(fee?' incl. travel':'') :'Estimate';",
    "document.getElementById('s5-total').textContent=cartBase?'$'+(cartBase+fee):'Estimate';",
  ],
  [
    "document.getElementById('c-total').textContent=total ? '$'+total+(fee?' (incl. travel)':'') : 'Estimate';",
    "document.getElementById('c-total').textContent=total ? '$'+total : 'Estimate';",
  ],
  [
    "if(sumEl){ sumEl.textContent = '$'+(sum + fee) + (fee ? ' (incl. travel fee)' : ''); }",
    "if(sumEl){ sumEl.textContent = '$'+(sum + fee); }",
  ],
  [
    "Enter your ZIP above — we'll confirm coverage and show any distance-based travel fee before you book.",
    "Enter your ZIP above — we'll confirm coverage and unlock booking for your area.",
  ],
  [
    `Most areas within 30 miles have <strong>no travel fee</strong>. Farther zones add a flat fee ($15–$55) based on estimated distance — <a href="#" class="booking-popup-trigger" onclick="openBooking(null);return false" style="color:var(--blue);text-decoration:none">see yours when you enter a ZIP</a>.`,
    `Most areas within 30 miles are covered at standard rates. Final pricing is shown when you select a package during booking.`,
  ],
  [
    'reply:"Most core areas have <b>no travel fee</b>. Farther zones (e.g. NYC, Long Island, PA Philly/Pocono) add a small flat travel fee shown automatically when you enter your ZIP — typically <b>$15–$35</b>. No surprises: it\'s displayed before you submit.",',
    'reply:"Most core areas have <b>no travel fee</b>. Farther zones (e.g. NYC, Long Island, PA Philly/Pocono) may include a small distance-based fee — typically <b>$15–$35</b> — already included in the package total shown when you book.",',
  ],
  [
    "document.getElementById('c-pprice').textContent=ST.basePrice ? '$'+ST.basePrice : 'Estimate';",
    "document.getElementById('c-pprice').textContent=ST.basePrice ? '$'+(ST.basePrice+fee) : 'Estimate';",
  ],
  [
    '$${total}${travelFee?` <span style="font-size:11px;color:var(--mu)">(incl. $${travelFee} travel)</span>`:\'\'}',
    '$${total}',
  ],
];

const customerFile = 'customer.html';
const customerFp = path.join(root, customerFile);
if (fs.existsSync(customerFp)) {
  let customerHtml = fs.readFileSync(customerFp, 'utf8');
  const travelFeeDecl = '  const travelFee = active.travelFeeAmount || active.zoneSurcharge || 0;\n\n';
  if (customerHtml.includes(travelFeeDecl)) {
    customerHtml = customerHtml.replace(travelFeeDecl, '');
    fs.writeFileSync(customerFp, customerHtml);
    console.log('Patched', customerFile, '(removed travelFee decl)');
  }
}

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
