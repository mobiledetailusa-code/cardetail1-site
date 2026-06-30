const NJ_HUB_ZIP3 = new Set(['070','071','072','073','074','075','076','077','078','079']);

function resolveHubPageForHero(zip) {
  const zip5 = String(zip).replace(/\D/g, '').slice(0, 5);
  if (zip5.length < 5) return null;
  const zip3 = zip5.slice(0, 3);
  const zip2 = zip5.slice(0, 2);
  if (NJ_HUB_ZIP3.has(zip3)) return 'new-jersey-hub.html';
  if (zip2 === '10' || zip2 === '11') return 'ny-metro-hub.html';
  if (zip2 === '06') return 'connecticut-hub.html';
  if (zip2 === '19') return 'pennsylvania-hub.html';
  return null;
}

const cases = [
  ['10001', 'ny-metro-hub.html'],
  ['06710', 'connecticut-hub.html'],
  ['07650', 'new-jersey-hub.html'],
  ['07302', 'new-jersey-hub.html'],
  ['07102', 'new-jersey-hub.html'],
  ['07501', 'new-jersey-hub.html'],
  ['07030', 'new-jersey-hub.html'],
  ['07060', 'new-jersey-hub.html'],
  ['07901', 'new-jersey-hub.html'],
  ['08901', null],
  ['08001', null],
  ['10583', 'ny-metro-hub.html'],
  ['19104', 'pennsylvania-hub.html'],
  ['90210', null],
];

let failed = 0;
for (const [zip, expected] of cases) {
  const r = resolveHubPageForHero(zip);
  const ok = expected === null ? r === null : r === expected;
  if (!ok) failed++;
  console.log(zip, r, ok ? 'OK' : 'FAIL expected ' + expected);
}
if (failed) process.exit(1);
