/**
 * ZIP-biased street suggestions for booking Step 4.
 *
 * Default geocoder is the public ArcGIS World Geocoding service (no key).
 * If GOOGLE_PLACES_API_KEY / GOOGLE_MAPS_API_KEY is set, Places Autocomplete
 * is tried first. Fail-open: a geocoder outage returns [] so the customer can
 * still type the address.
 *
 * Does not change quoted travel fees. A nearby-city pick is a hint, not a ZIP change.
 */

const { estimateMilesForZip, zipCoordIndex, TRAVEL_MAX_MILES } = require('./travel-fee');

const ARCGIS_CANDIDATES =
  'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
const ARCGIS_SUGGEST =
  'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest';
const GOOGLE_AUTOCOMPLETE =
  'https://maps.googleapis.com/maps/api/place/autocomplete/json';

const MAX_Q = 80;
const MAX_CITY = 80;
const MAX_RESULTS = 6;

function normalizeZip5(zip) {
  const z = String(zip == null ? '' : zip).replace(/\D/g, '').slice(0, 5);
  return z.length === 5 ? z : '';
}

function normalizeQuery(q) {
  return String(q == null ? '' : q).replace(/\s+/g, ' ').trim().slice(0, MAX_Q);
}

function sanitizeCity(city) {
  const s = String(city == null ? '' : city)
    .replace(/<[^>]*>/g, '')
    .replace(/[^A-Za-z0-9 .,'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CITY);
  return s;
}

/** "168 oak" — house number plus at least two letters of a street. */
function isUsableStreetQuery(q) {
  return /^\d{1,6}\s+[A-Za-z][A-Za-z0-9.'\-]{1,}/.test(normalizeQuery(q));
}

function parseCityLabel(cityLabel) {
  const raw = sanitizeCity(cityLabel);
  if (!raw) return { city: '', state: '' };
  const m = raw.match(/^(.*?)(?:,\s*([A-Za-z]{2}))?$/);
  return {
    city: (m && m[1] ? m[1] : raw).trim(),
    state: (m && m[2] ? m[2] : '').toUpperCase(),
  };
}

function zipInServiceArea(zip) {
  const z = normalizeZip5(zip);
  if (!z) return false;
  const miles = estimateMilesForZip(z);
  return miles != null && miles <= TRAVEL_MAX_MILES;
}

function coordsForZip(zip) {
  const z = normalizeZip5(zip);
  if (!z) return null;
  return zipCoordIndex().get(z) || null;
}

function googlePlacesKey() {
  return String(process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '').trim();
}

function arcgisToken() {
  return String(process.env.ARCGIS_GEOCODE_TOKEN || process.env.ARCGIS_API_KEY || '').trim();
}

async function fetchJson(url, { fetchImpl, timeoutMs = 2800 } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => {
    try { if (ctrl) ctrl.abort(); } catch (_) { /* */ }
  }, timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Cardetail1-booking-address/1.0',
      },
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatLabel({ line1, city, state, zip }) {
  const street = String(line1 || '').trim();
  const locality = [city, state].filter(Boolean).join(', ');
  const tail = [locality, zip].filter(Boolean).join(' ');
  return [street, tail].filter(Boolean).join(', ');
}

function fromLongLabel(raw) {
  return String(raw || '')
    .replace(/,\s*USA\s*$/i, '')
    .replace(/,\s*United States(?: of America)?\s*$/i, '')
    .replace(/,\s*New Jersey,/i, ', NJ,')
    .replace(/,\s*New York,/i, ', NY,')
    .replace(/,\s*Connecticut,/i, ', CT,')
    .replace(/,\s*Pennsylvania,/i, ', PA,')
    .trim();
}

function normalizeKey(label) {
  return String(label || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

function detectPlaceConflict(address, { zip, cityLabel } = {}) {
  const text = String(address || '');
  const expectedZip = normalizeZip5(zip);
  const foundZip = normalizeZip5((text.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || '');
  if (expectedZip && foundZip && foundZip !== expectedZip) {
    return {
      type: 'zip',
      expectedZip,
      foundZip,
      expectedCity: String(cityLabel || '').trim(),
    };
  }
  const expectedCity = parseCityLabel(cityLabel).city;
  if (!expectedCity || expectedCity.length < 3) return null;
  const cityRe = new RegExp(`\\b${expectedCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const looksComplete = /,\s*[A-Za-z].+\b[A-Z]{2}\b/.test(text) || Boolean(foundZip);
  if (looksComplete && !cityRe.test(text)) {
    return {
      type: 'city',
      expectedZip,
      foundZip: foundZip || '',
      expectedCity: String(cityLabel || '').trim(),
    };
  }
  return null;
}

function applyExpectedPlace(address, cityLabel, zip) {
  const street = String(address || '').split(',')[0].trim() || String(address || '').trim();
  const { city, state } = parseCityLabel(cityLabel);
  const z = normalizeZip5(zip);
  if (!street) return '';
  return formatLabel({ line1: street, city, state: state || 'NJ', zip: z });
}

function rankBoost(row, zip, city) {
  let n = Number(row.score) || 0;
  if (zip && row.zip === zip) n += 100;
  if (city && String(row.city || '').toLowerCase() === city.toLowerCase()) n += 40;
  return n;
}

function mapArcGisCandidate(c) {
  const a = (c && c.attributes) || {};
  const line1 = String(a.StAddr || a.ShortLabel || '').trim();
  const addNum = String(a.AddNum || '').trim();
  const addrType = String(a.Addr_type || '');
  if (!addNum && !/^\d/.test(line1)) return null;
  if (addrType === 'Postal' || addrType === 'Locality' || addrType === 'POI') return null;
  const city = String(a.City || '').trim();
  const state = String(a.RegionAbbr || '').trim();
  const zip = normalizeZip5(a.Postal);
  const street = line1 || `${addNum} ${a.StName || ''}`.trim();
  const structured = formatLabel({ line1: street, city, state, zip });
  const label = (structured && /^\d/.test(structured))
    ? structured
    : fromLongLabel(a.LongLabel || c.address || '');
  if (!/^\d/.test(label)) return null;
  return {
    label,
    line1: line1 || label.split(',')[0].trim(),
    city,
    state,
    zip,
    score: Number(a.Score != null ? a.Score : c.score) || 0,
    source: 'arcgis',
  };
}

function mapArcGisSuggestion(s) {
  const text = fromLongLabel(s && s.text);
  if (!text || !/^\d/.test(text)) return null;
  const zip = normalizeZip5((text.match(/\b(\d{5})\b/) || [])[1] || '');
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const line1 = parts[0] || text;
  let city = '';
  let state = '';
  if (parts[1] && /^[A-Z]{2}$/.test(parts[2] || '')) {
    city = parts[1];
    state = parts[2];
  } else if (parts[1]) {
    city = parts[1];
    state = /^[A-Z]{2}$/.test(parts[2] || '') ? parts[2] : '';
  }
  const structured = formatLabel({ line1, city, state, zip });
  return {
    label: (structured && city && /^\d/.test(structured)) ? structured : text,
    line1,
    city,
    state,
    zip,
    score: 70,
    source: 'arcgis',
  };
}

function mapGooglePrediction(p) {
  const label = fromLongLabel(p && p.description);
  if (!label || !/^\d/.test(label)) return null;
  const main = p.structured_formatting && p.structured_formatting.main_text;
  return {
    label,
    line1: String(main || label.split(',')[0]).trim(),
    city: '',
    state: '',
    zip: normalizeZip5((label.match(/\b(\d{5})\b/) || [])[1] || ''),
    score: 90,
    source: 'google',
  };
}

function dedupeRank(rows, zip, city) {
  const seen = new Set();
  const out = [];
  const sorted = rows
    .filter(Boolean)
    .sort((a, b) => rankBoost(b, zip, city) - rankBoost(a, zip, city));
  for (const row of sorted) {
    const key = normalizeKey(row.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: row.label,
      line1: row.line1,
      city: row.city,
      state: row.state,
      zip: row.zip,
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

async function suggestFromGoogle({ q, zip, coords }, opts) {
  const key = googlePlacesKey();
  if (!key) return [];
  const url = new URL(GOOGLE_AUTOCOMPLETE);
  url.searchParams.set('input', q);
  url.searchParams.set('key', key);
  url.searchParams.set('types', 'address');
  url.searchParams.set('components', 'country:us');
  if (coords) {
    url.searchParams.set('location', `${coords.lat},${coords.lon}`);
    url.searchParams.set('radius', '12000');
  }
  const data = await fetchJson(url.toString(), opts);
  const preds = (data && data.predictions) || [];
  return preds.map(mapGooglePrediction).filter(Boolean);
}

async function suggestFromArcGis({ q, zip, city, state, coords }, opts) {
  const token = arcgisToken();
  const locality = [city, state, zip].filter(Boolean).join(' ');
  const singleLine = `${q} ${locality}`.trim();
  const candUrl = new URL(ARCGIS_CANDIDATES);
  candUrl.searchParams.set('f', 'json');
  candUrl.searchParams.set('SingleLine', singleLine);
  candUrl.searchParams.set('sourceCountry', 'USA');
  candUrl.searchParams.set('maxLocations', '8');
  candUrl.searchParams.set('outFields', 'AddNum,StAddr,City,RegionAbbr,Postal,Addr_type,LongLabel,Match_addr,Score,ShortLabel,StName');
  if (coords) candUrl.searchParams.set('location', `${coords.lon},${coords.lat}`);
  if (token) candUrl.searchParams.set('token', token);

  const sugUrl = new URL(ARCGIS_SUGGEST);
  sugUrl.searchParams.set('f', 'json');
  sugUrl.searchParams.set('text', q);
  sugUrl.searchParams.set('countryCode', 'USA');
  sugUrl.searchParams.set('maxSuggestions', '8');
  sugUrl.searchParams.set('category', 'Address');
  if (coords) {
    sugUrl.searchParams.set('location', `${coords.lon},${coords.lat}`);
    sugUrl.searchParams.set('distance', '12000');
  }
  if (token) sugUrl.searchParams.set('token', token);

  const [cand, sug] = await Promise.all([
    fetchJson(candUrl.toString(), opts),
    fetchJson(sugUrl.toString(), opts),
  ]);
  const fromCand = ((cand && cand.candidates) || []).map(mapArcGisCandidate);
  const fromSug = ((sug && sug.suggestions) || []).map(mapArcGisSuggestion);
  return [...fromCand, ...fromSug].filter(Boolean);
}

/**
 * @param {{ q: string, zip: string, city?: string }} input
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
async function suggestAddresses(input, opts = {}) {
  const zip = normalizeZip5(input && input.zip);
  const q = normalizeQuery(input && input.q);
  const parsed = parseCityLabel(input && input.city);
  if (!zip) return { ok: false, error: 'zip_required', suggestions: [] };
  if (!zipInServiceArea(zip)) return { ok: false, error: 'zip_out_of_area', suggestions: [] };
  if (!isUsableStreetQuery(q)) return { ok: true, suggestions: [] };

  const coords = coordsForZip(zip);
  const ctx = { q, zip, city: parsed.city, state: parsed.state, coords };

  let rows = [];
  try {
    rows = await suggestFromGoogle(ctx, opts);
  } catch (_) { /* ArcGIS next */ }
  if (!rows.length) {
    try {
      rows = await suggestFromArcGis(ctx, opts);
    } catch (_) {
      rows = [];
    }
  }
  return { ok: true, suggestions: dedupeRank(rows, zip, parsed.city) };
}

module.exports = {
  normalizeZip5,
  normalizeQuery,
  sanitizeCity,
  isUsableStreetQuery,
  parseCityLabel,
  zipInServiceArea,
  detectPlaceConflict,
  applyExpectedPlace,
  formatLabel,
  suggestAddresses,
};
