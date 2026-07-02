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

const cssNeedle = '.terms-panel strong{color:var(--white)}';
const cssInsert = `.terms-panel strong{color:var(--white)}
.checkout-terms-wrap{margin-bottom:16px}
.checkout-terms-linkline{font-size:12.5px;color:var(--mu);line-height:1.55;margin:0 0 10px;text-align:center}
.checkout-terms-linkline a{color:var(--blue);font-weight:600;text-decoration:underline;text-underline-offset:3px}
.checkout-terms-disclosure{background:var(--bg3);border:1px solid rgba(255,255,255,.08);border-radius:var(--r);overflow:hidden}
.checkout-terms-disclosure summary{padding:12px 16px;font-size:12px;font-weight:600;color:var(--mu);cursor:pointer;list-style:none;user-select:none}
.checkout-terms-disclosure summary::-webkit-details-marker{display:none}
.checkout-terms-disclosure summary::before{content:'▸ ';color:var(--blue)}
.checkout-terms-disclosure[open] summary::before{content:'▾ '}
.checkout-terms-disclosure[open] summary{border-bottom:1px solid rgba(255,255,255,.08);color:var(--tx)}
.checkout-terms-disclosure .terms-panel,.checkout-terms-disclosure .pay-box{border:none;border-radius:0;margin-bottom:0;max-height:none}
.checkout-terms-disclosure .terms-panel{border-bottom:1px solid rgba(255,255,255,.06)}`;

const openWrap =
  `        <div class="checkout-terms-wrap">
          <p class="checkout-terms-linkline"><a href="/terms-conditions" target="_blank" rel="noopener noreferrer">Read full booking terms &amp; agreements →</a></p>
          <details class="checkout-terms-disclosure">
            <summary>View policy summary (optional)</summary>
            <div class="terms-panel">`;

const closeWrap =
  `          </details>
        </div>`;

for (const file of pages) {
  const fp = path.join(root, file);
  let html = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
  if (html.includes('checkout-terms-wrap')) {
    console.log('skip', file);
    continue;
  }
  if (!html.includes(cssNeedle)) throw new Error(`${file}: CSS anchor missing`);
  html = html.replace(cssNeedle, cssInsert);

  const start = html.indexOf('        <div class="terms-panel">');
  if (start < 0) throw new Error(`${file}: terms-panel missing`);
  const btnRow = html.indexOf('        <div class="btn-row">', start);
  if (btnRow < 0) throw new Error(`${file}: btn-row missing`);

  const block = html.slice(start, btnRow);
  if (!block.includes('class="pay-box"')) throw new Error(`${file}: pay-box missing in block`);

  const inner = block
    .replace('        <div class="terms-panel">', openWrap)
    .replace(/\n        <\/div>\s*$/, `\n        </div>\n${closeWrap}\n`);

  html = html.slice(0, start) + inner + html.slice(btnRow);
  fs.writeFileSync(fp, html);
  console.log('patched', file);
}
