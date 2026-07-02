const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pages = [
  'bergen-county-hub.html', 'hudson-county-hub.html', 'essex-county-hub.html',
  'passaic-county-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html',
  'pennsylvania-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html', 'template-city.html',
];

const openBookingOld = `  if(heroZip && heroZip.value.replace(/\\D/g,'').length === 5){
    const bkZip = document.getElementById('bk-zip');
    if(bkZip && !bkZip.value) bkZip.value = heroZip.value;
  }`;

const openBookingNew = `  if(heroZip && heroZip.value.replace(/\\D/g,'').length === 5){
    const zip5 = heroZip.value.replace(/\\D/g,'').slice(0, 5);
    const bkZip = document.getElementById('bk-zip');
    if(bkZip && !bkZip.value) bkZip.value = zip5;
    if(typeof onBkZipInput === 'function') onBkZipInput(zip5);
  }`;

const initHubOld = `  if(zip5.length === 5){
    const inp = document.getElementById('hero-zip');
    if(inp) inp.value = zip5;
  }`;

const initHubNew = `  if(zip5.length === 5){
    const inp = document.getElementById('hero-zip');
    if(inp) inp.value = zip5;
    const bkZip = document.getElementById('bk-zip');
    if(bkZip && !bkZip.value) bkZip.value = zip5;
    if(typeof onBkZipInput === 'function') onBkZipInput(zip5);
  }`;

const draftErrOld = `      if(!draftData.ok) throw new Error('Could not register booking. Please try again.');`;

const draftErrNew = `      if(!draftData.ok){
        const draftErrMap={
          payment_preference_required:'Choose a payment preference first.',
          card_on_file_policy_required:'Accept the card-on-file policy to continue.',
          zip_required:'Enter a valid ZIP code in the booking form.',
          out_of_service_area:'This ZIP is outside our service area.',
          invalid_pricing:'We could not verify your package price. Go back and reselect your service.',
          price_mismatch:'Your total changed — go back one step and continue again.',
        };
        throw new Error(draftErrMap[draftData.error]||'Could not register booking. Please try again.');
      }`;

for (const file of pages) {
  const fp = path.join(root, file);
  let html = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
  if (!html.includes(openBookingOld)) throw new Error(`${file}: openBookingFromHome block not found`);
  html = html.replace(openBookingOld, openBookingNew);
  if (!html.includes(initHubOld)) throw new Error(`${file}: initHubZipFromQuery block not found`);
  html = html.replace(initHubOld, initHubNew);
  if (!html.includes(draftErrOld)) throw new Error(`${file}: draft error line not found`);
  html = html.replace(draftErrOld, draftErrNew);
  fs.writeFileSync(fp, html);
  console.log('patched', file);
}
