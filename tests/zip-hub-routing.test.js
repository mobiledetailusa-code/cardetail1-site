const HUB_ZIP5_TO_PAGE = {
  '07030':'hudson-county-hub.html','07032':'hudson-county-hub.html','07047':'hudson-county-hub.html',
  '07086':'hudson-county-hub.html','07087':'hudson-county-hub.html','07093':'hudson-county-hub.html','07094':'hudson-county-hub.html',
  '07003':'essex-county-hub.html','07028':'essex-county-hub.html','07040':'essex-county-hub.html','07042':'essex-county-hub.html',
  '07043':'essex-county-hub.html','07044':'essex-county-hub.html','07050':'essex-county-hub.html','07052':'essex-county-hub.html',
  '07201':'essex-county-hub.html','07202':'essex-county-hub.html',
  '07011':'passaic-county-hub.html','07012':'passaic-county-hub.html','07013':'passaic-county-hub.html','07014':'passaic-county-hub.html',
  '07055':'passaic-county-hub.html','07407':'passaic-county-hub.html','07424':'passaic-county-hub.html',
  '07010':'bergen-county-hub.html','07020':'bergen-county-hub.html','07022':'bergen-county-hub.html','07024':'bergen-county-hub.html',
  '07026':'bergen-county-hub.html','07031':'bergen-county-hub.html','07057':'bergen-county-hub.html','07070':'bergen-county-hub.html',
  '07071':'bergen-county-hub.html','07072':'bergen-county-hub.html','07073':'bergen-county-hub.html','07074':'bergen-county-hub.html','07075':'bergen-county-hub.html',
};
const HUB_ZIP3_TO_PAGE = {
  '076':'bergen-county-hub.html','074':'bergen-county-hub.html',
  '073':'hudson-county-hub.html',
  '071':'essex-county-hub.html','072':'essex-county-hub.html',
  '075':'passaic-county-hub.html',
};

function resolveHubPageForHero(zip) {
  const zip5 = String(zip).replace(/\D/g, '').slice(0, 5);
  if (zip5.length < 5) return null;
  const zip3 = zip5.slice(0, 3);
  const zip2 = zip5.slice(0, 2);
  if (HUB_ZIP5_TO_PAGE[zip5]) return HUB_ZIP5_TO_PAGE[zip5];
  if (HUB_ZIP3_TO_PAGE[zip3]) return HUB_ZIP3_TO_PAGE[zip3];
  if (zip2 === '07' || zip2 === '08') return 'new-jersey-hub.html';
  if (zip2 === '10' || zip2 === '11') return 'ny-metro-hub.html';
  if (zip2 === '06') return 'connecticut-hub.html';
  if (zip2 === '19') return 'pennsylvania-hub.html';
  return null;
}

const cases = [
  ['10001', 'ny-metro-hub.html'],
  ['06710', 'connecticut-hub.html'],
  ['07650', 'bergen-county-hub.html'],
  ['07302', 'hudson-county-hub.html'],
  ['07102', 'essex-county-hub.html'],
  ['07501', 'passaic-county-hub.html'],
  ['07030', 'hudson-county-hub.html'],
  ['07060', 'new-jersey-hub.html'],
  ['08901', 'new-jersey-hub.html'],
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
