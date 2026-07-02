const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pages = [
  'index.html',
  'bergen-county-hub.html', 'hudson-county-hub.html', 'essex-county-hub.html',
  'passaic-county-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html',
  'pennsylvania-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html', 'template-city.html',
];

const cardGateCopy =
  /\n\s*<div class="card-gate-copy">Book with confidence\. We place a secure \$0 hold just to reserve your spot on our route\. We never charge you upfront\. You only pay when the job is done and you're 100% happy with the results\.<\/div>/g;

const confidenceBox =
  /\n\s*<div style="font-size:12\.5px;color:var\(--mu\);line-height:1\.65;margin-bottom:12px;padding:12px 14px;background:rgba\(77,163,255,\.06\);border:1px solid rgba\(77,163,255,\.18\);border-radius:8px"><strong style="color:var\(--white\)">Book with confidence:<\/strong> We place a secure \$0 hold just to reserve your spot on our route\. We never charge you upfront\. You only pay when the job is done and you're 100% happy with the results\.<\/div>/g;

const footerHold =
  /\n\s*<p style="font-size:11\.5px;color:var\(--mu\);line-height:1\.6;margin-top:10px;text-align:center">A secure \$0 hold reserves your spot [—-] not a charge\. You only pay when the job is done and you're 100% happy with the results\.<\/p>/g;

for (const file of pages) {
  const fp = path.join(root, file);
  let html = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
  const before = html;
  html = html.replace(cardGateCopy, '');
  html = html.replace(confidenceBox, '');
  html = html.replace(footerHold, '');
  if (html === before) throw new Error(`${file}: expected checkout confidence copy not found`);
  fs.writeFileSync(fp, html);
  console.log('patched', file);
}
