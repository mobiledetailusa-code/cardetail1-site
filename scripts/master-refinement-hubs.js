const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const hubH1 = {
  'bergen-county-hub.html': 'Bergen County',
  'hudson-county-hub.html': 'Hudson County',
  'essex-county-hub.html': 'Essex County',
  'passaic-county-hub.html': 'Passaic County',
  'ny-metro-hub.html': 'NY Metro',
  'connecticut-hub.html': 'Connecticut',
};

const radiusNote =
  'We travel up to 150 miles from our anchor city. Distance may affect your total — mileage pricing is included in the quote at booking, not shown as a separate fee when you enter your ZIP.';

const oldRadiusNote =
  'Most areas within 30 miles are covered at standard rates. Final pricing is shown when you select a package during booking.';

const footLogoOld =
  '<img class="foot-logo-img" src="assets/cardetail1-logo.webp" width="520" height="261" alt="Cardetail1 Mobile Detailing" loading="lazy" decoding="async">';
const footLogoNew =
  '<a href="index.html" aria-label="Cardetail1 Home"><img class="foot-logo-img" src="assets/cardetail1-logo.webp" width="520" height="261" alt="Cardetail1 Mobile Detailing" loading="lazy" decoding="async"></a>';

for (const [file, hubName] of Object.entries(hubH1)) {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) {
    console.warn('Skip missing', file);
    continue;
  }
  let html = fs.readFileSync(fp, 'utf8');

  html = html.replace(
    /<h1>Premium Mobile Detailing<br>in <em>[^<]+<\/em><\/h1>/,
    `<h1>Welcome to Cardetail1 | ${hubName} &amp; Surrounding Areas</h1>`
  );

  if (html.includes(oldRadiusNote)) {
    html = html.replace(oldRadiusNote, radiusNote);
  }

  if (html.includes(footLogoOld) && !html.includes('foot-logo-img" src="assets/cardetail1-logo.webp" width="520" height="261" alt="Cardetail1 Mobile Detailing" loading="lazy" decoding="async"></a>')) {
    html = html.replace(footLogoOld, footLogoNew);
  }

  fs.writeFileSync(fp, html);
  console.log('Refined', file);
}
