const HUB_PAGES = {
  bergen: 'bergen-county-hub.html',
  hudson: 'hudson-county-hub.html',
  essex: 'essex-county-hub.html',
  passaic: 'passaic-county-hub.html',
  nyMetro: 'ny-metro-hub.html',
  pennsylvania: 'pennsylvania-hub.html',
  connecticut: 'connecticut-hub.html',
};
const HUB_ZIP3_PREFIXES = {
  bergen: ['076', '074'],
  hudson: ['073'],
  essex: ['071', '072'],
  passaic: ['075'],
  nyMetro: ['100', '101', '102', '103', '104', '111', '112', '113', '114', '105', '106', '107'],
  pennsylvania: ['190', '191', '180', '181', '182', '183', '184', '185', '186', '187', '188', '189', '193', '194', '195', '196', '170', '171', '172', '173', '174', '175', '176', '177', '178', '179'],
  connecticut: ['060', '061', '062', '063', '064', '065', '066', '067', '068', '069'],
};
const HUB_RESOLVE_ORDER = ['bergen', 'hudson', 'essex', 'passaic', 'nyMetro', 'pennsylvania', 'connecticut'];
const HUB_ZIP5_OVERRIDES = {
  '07030': 'hudson',
  '07010': 'bergen',
  '07650': 'bergen',
};
function resolveHubByZip(zip) {
  const z = String(zip).replace(/\D/g, '').slice(0, 5);
  if (z.length < 5) return null;
  const zip3 = z.slice(0, 3);
  let hubKey = HUB_ZIP5_OVERRIDES[z] || null;
  if (!hubKey) {
    for (const key of HUB_RESOLVE_ORDER) {
      const prefs = HUB_ZIP3_PREFIXES[key];
      if (prefs && prefs.includes(zip3)) { hubKey = key; break; }
    }
  }
  if (!hubKey) return null;
  return { key: hubKey, page: HUB_PAGES[hubKey] };
}
const cases = [
  ['10001', 'nyMetro'],
  ['06710', 'connecticut'],
  ['07650', 'bergen'],
  ['07030', 'hudson'],
  ['10583', 'nyMetro'],
  ['19104', 'pennsylvania'],
  ['90210', null],
];
let failed = 0;
for (const [zip, expected] of cases) {
  const r = resolveHubByZip(zip);
  const ok = expected === null ? r === null : r?.key === expected;
  if (!ok) failed++;
  console.log(zip, r?.key, ok ? 'OK' : 'FAIL expected ' + expected);
}
if (failed) process.exit(1);
