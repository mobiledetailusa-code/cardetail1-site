#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const files = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

for (const f of files) {
  let html = await readFile(f, 'utf8');
  const orig = html;
  html = html.replace(
    /const POPULAR_IDS=\['rainx','pethair','odor'\];/g,
    "const POPULAR_IDS=ST.cat==='rvs'?['superint','rainx','pethair','odor']:['rainx','pethair','odor'];"
  );
  html = html.replace(
    /(id="bkfrom-rvs"[^>]*>)From \$(?:279|349)/g,
    '$1From $8/ft'
  );
  html = html.replace(
    /rvs:LENGTH_PRICING\.rvs\.packages\.exterior\.min/g,
    'rvs:LENGTH_PRICING.rvs.packages.maint.min'
  );
  html = html.replace(
    /rvs:\s*\{\s*price:\s*LENGTH_PRICING\.rvs\.packages\.exterior\.min\s*\}/g,
    'rvs:        { price: LENGTH_PRICING.rvs.packages.maint.min }'
  );
  html = html.replace(
    /(name:'RVs & Trailers',[^\n]*from:')From \$(?:279|349)'/g,
    "$1From $8/ft'"
  );
  html = html.replace(
    /(name:'RVs & Trailers',[^\n]*from:")From \$(?:279|349)"/g,
    '$1From $8/ft"'
  );
  if (html !== orig) {
    await writeFile(f, html);
    console.log('patched', f);
  } else {
    console.log('unchanged', f);
  }
}
