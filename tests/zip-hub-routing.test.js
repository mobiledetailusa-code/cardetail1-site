const HUB_ZIP3_OVERRIDES = {
  '073': 'hudson-county-hub.html',
  '071': 'essex-county-hub.html',
  '072': 'essex-county-hub.html',
  '075': 'passaic-county-hub.html',
};

function resolveHubPageForHero(zip) {
  const zip5 = String(zip).replace(/\D/g, '').slice(0, 5);
  if (zip5.length < 5) return null;
  const zip3 = zip5.slice(0, 3);
  const zip2 = zip5.slice(0, 2);
  if (HUB_ZIP3_OVERRIDES[zip3]) return HUB_ZIP3_OVERRIDES[zip3];
  if (zip2 === '07' || zip2 === '08') return 'bergen-county-hub.html';
  if (zip2 === '10' || zip2 === '11' || zip2 === '12') return 'ny-metro-hub.html';
  if (zip2 === '06') return 'connecticut-hub.html';
  if (zip2 === '18' || zip2 === '19') return 'pennsylvania-hub.html';
  return null;
}

const cases = [
  ['10001', 'ny-metro-hub.html'],
  ['06710', 'connecticut-hub.html'],
  ['07650', 'bergen-county-hub.html'],
  ['07302', 'hudson-county-hub.html'],
  ['07102', 'essex-county-hub.html'],
  ['07501', 'passaic-county-hub.html'],
  ['07030', 'bergen-county-hub.html'],
  ['10583', 'ny-metro-hub.html'],
  ['19104', 'pennsylvania-hub.html'],
  ['18101', 'pennsylvania-hub.html'],
  ['12550', 'ny-metro-hub.html'],
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
