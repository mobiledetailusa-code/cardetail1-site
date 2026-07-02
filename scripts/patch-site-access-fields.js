const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = [
  'index.html',
  'bergen-county-hub.html', 'hudson-county-hub.html', 'essex-county-hub.html',
  'passaic-county-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html',
  'pennsylvania-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html', 'template-city.html',
];

const siteAccessHtml = `          <div class="fg"><div class="fl">Water available?</div>
            <select class="fsel" id="f-water">
              <option value="">Select…</option>
              <option value="yes">Yes, water spigot/hose access available</option>
              <option value="no">No water available</option>
              <option value="unsure">Not sure</option>
            </select>
          </div>
          <div class="fg"><div class="fl">Electricity available?</div>
            <select class="fsel" id="f-electric">
              <option value="">Select…</option>
              <option value="yes">Yes, outlet available</option>
              <option value="no">No electricity available</option>
              <option value="unsure">Not sure</option>
            </select>
          </div>
          <div class="fg full"><div class="fl">Service location / access</div>
            <select class="fsel" id="f-location">
              <option value="">Select…</option>
              <option value="driveway">Driveway</option>
              <option value="street">Street parking</option>
              <option value="garage">Garage / parking deck</option>
              <option value="apartment">Apartment / condo</option>
              <option value="marina">Marina / dock</option>
              <option value="commercial">Commercial lot</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="fg full"><div class="fl">Access notes (optional)</div><textarea class="fta" id="f-access-notes" placeholder="Gate code, parking instructions, hose location, power outlet location, restrictions…"></textarea></div>
`;

const notesOld = /<div class="fg full"><div class="fl">Notes \(optional\)<\/div><textarea class="fta" id="f-notes" placeholder="Specific stains, gate code, parking info, pet hair…"><\/textarea><\/div>/;

const notesNew = `${siteAccessHtml}          <div class="fg full"><div class="fl">Notes (optional)</div><textarea class="fta" id="f-notes" placeholder="Specific stains, pet hair, vehicle condition…"></textarea></div>`;

const helperFn = `
function readSiteAccessFields(){
  return {
    waterAvailable: document.getElementById('f-water')?.value || '',
    electricityAvailable: document.getElementById('f-electric')?.value || '',
    serviceLocation: document.getElementById('f-location')?.value || '',
    accessNotes: document.getElementById('f-access-notes')?.value.trim() || '',
  };
}
function formatSiteAccessForText(b){
  const water={yes:'Yes, water spigot/hose access available',no:'No water available',unsure:'Not sure'};
  const electric={yes:'Yes, outlet available',no:'No electricity available',unsure:'Not sure'};
  const loc={driveway:'Driveway',street:'Street parking',garage:'Garage / parking deck',apartment:'Apartment / condo',marina:'Marina / dock',commercial:'Commercial lot',other:'Other'};
  const lines=[];
  if(b.waterAvailable) lines.push('Water: '+(water[b.waterAvailable]||b.waterAvailable));
  if(b.electricityAvailable) lines.push('Electricity: '+(electric[b.electricityAvailable]||b.electricityAvailable));
  if(b.serviceLocation) lines.push('Service location: '+(loc[b.serviceLocation]||b.serviceLocation));
  if(b.accessNotes) lines.push('Access notes: '+b.accessNotes);
  return lines.join('\\n');
}
`;

for (const file of files) {
  let html = fs.readFileSync(path.join(root, file), 'utf8');
  if (!notesOld.test(html)) throw new Error(`${file}: Notes block not found`);
  html = html.replace(notesOld, notesNew);

  if (!html.includes('function readSiteAccessFields()')) {
    html = html.replace(/\nfunction buildBookingPayload\(\)\{/, `${helperFn}\nfunction buildBookingPayload(){`);
  }

  const payloadNeedle = "notes:document.getElementById('f-notes').value.trim(),";
  const payloadInsert = `    ...readSiteAccessFields(),
    notes:document.getElementById('f-notes').value.trim(),`;
  if (!html.includes('...readSiteAccessFields()')) {
    if (!html.includes(payloadNeedle)) throw new Error(`${file}: buildBookingPayload notes line not found`);
    html = html.replace(payloadNeedle, payloadInsert);
  }

  const fmtNeedle = "Notes: ${b.notes||'None'}`;";
  const fmtInsert = "${formatSiteAccessForText(b)?formatSiteAccessForText(b)+'\\n':''}Notes: ${b.notes||'None'}`;";
  if (!html.includes('formatSiteAccessForText(b)')) {
    if (!html.includes(fmtNeedle)) throw new Error(`${file}: formatBookingText not found`);
    html = html.replace(fmtNeedle, fmtInsert);
  }

  const resetNeedle = "['f-first','f-last','f-phone','f-email','f-addr','f-date','f-notes'].forEach";
  const resetNew = "['f-first','f-last','f-phone','f-email','f-addr','f-date','f-water','f-electric','f-location','f-access-notes','f-notes'].forEach";
  if (!html.includes("'f-water'")) {
    if (!html.includes(resetNeedle)) throw new Error(`${file}: form reset not found`);
    html = html.replace(resetNeedle, resetNew);
  }

  fs.writeFileSync(path.join(root, file), html);
  console.log('OK', file);
}
