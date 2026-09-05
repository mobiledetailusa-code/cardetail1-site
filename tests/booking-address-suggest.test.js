'use strict';

/**
 * Booking Step 4 address suggestions — ZIP carry + city mismatch + street search.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  isUsableStreetQuery,
  normalizeZip5,
  zipInServiceArea,
  detectPlaceConflict,
  applyExpectedPlace,
  suggestAddresses,
} = require('../netlify/lib/address-suggest');

const BOOKING_PAGES = [
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

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
  };
}

describe('address query guards', () => {
  it('requires a house number and street start', () => {
    assert.equal(isUsableStreetQuery('168 oak'), true);
    assert.equal(isUsableStreetQuery('168 Oak'), true);
    assert.equal(isUsableStreetQuery('oak'), false);
    assert.equal(isUsableStreetQuery('168'), false);
    assert.equal(isUsableStreetQuery(''), false);
  });

  it('treats Palisades Park ZIP as in-area and rejects junk ZIPs', () => {
    assert.equal(normalizeZip5('07650'), '07650');
    assert.equal(zipInServiceArea('07650'), true);
    assert.equal(zipInServiceArea('00000'), false);
    assert.equal(zipInServiceArea(''), false);
  });
});

describe('city / ZIP mismatch', () => {
  it('flags a different ZIP in the typed address', () => {
    const c = detectPlaceConflict('168 Oak St, Teaneck, NJ 07666', {
      zip: '07650',
      cityLabel: 'Palisades Park, NJ',
    });
    assert.equal(c.type, 'zip');
    assert.equal(c.foundZip, '07666');
    assert.equal(c.expectedZip, '07650');
  });

  it('flags a completed address whose city is not the ZIP city', () => {
    const c = detectPlaceConflict('168 Oak St, Fort Lee, NJ', {
      zip: '07650',
      cityLabel: 'Palisades Park, NJ',
    });
    assert.equal(c.type, 'city');
    assert.equal(c.expectedCity, 'Palisades Park, NJ');
  });

  it('does not flag a partial street before city is typed', () => {
    assert.equal(
      detectPlaceConflict('168 oak', { zip: '07650', cityLabel: 'Palisades Park, NJ' }),
      null
    );
  });

  it('rewrites city/state/ZIP onto the street line', () => {
    assert.equal(
      applyExpectedPlace('168 Oak St, Fort Lee, NJ 07024', 'Palisades Park, NJ', '07650'),
      '168 Oak St, Palisades Park, NJ 07650'
    );
  });
});

describe('suggestAddresses', () => {
  const prevGoogle = process.env.GOOGLE_PLACES_API_KEY;
  const prevMaps = process.env.GOOGLE_MAPS_API_KEY;

  beforeEach(() => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  afterEach(() => {
    if (prevGoogle == null) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = prevGoogle;
    if (prevMaps == null) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = prevMaps;
  });

  it('rejects a missing ZIP without calling the geocoder', async () => {
    let called = 0;
    const result = await suggestAddresses({ q: '168 oak', zip: '' }, {
      fetchImpl: async () => { called += 1; return jsonResponse({}); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'zip_required');
    assert.equal(called, 0);
  });

  it('returns ZIP-matching streets first and drops ZIP-only hits', async () => {
    const result = await suggestAddresses(
      { q: '168 oak', zip: '07650', city: 'Palisades Park, NJ' },
      {
        fetchImpl: async (url) => {
          const href = String(url);
          if (href.includes('findAddressCandidates')) {
            return jsonResponse({
              candidates: [
                {
                  address: '07650, Palisades Park, New Jersey',
                  score: 91,
                  attributes: {
                    Addr_type: 'Postal',
                    AddNum: '',
                    StAddr: '07650',
                    City: 'Palisades Park',
                    RegionAbbr: 'NJ',
                    Postal: '07650',
                    Score: 91,
                    LongLabel: '07650, Palisades Park, NJ, USA',
                  },
                },
                {
                  address: '168 Oak St, Teaneck, New Jersey, 07666',
                  score: 79,
                  attributes: {
                    AddNum: '168',
                    StAddr: '168 Oak St',
                    City: 'Teaneck',
                    RegionAbbr: 'NJ',
                    Postal: '07666',
                    Addr_type: 'StreetAddress',
                    Score: 79,
                    LongLabel: '168 Oak St, Teaneck, NJ, 07666, USA',
                  },
                },
                {
                  address: '168 Oakwood Ln, Palisades Park, New Jersey, 07650',
                  score: 92,
                  attributes: {
                    AddNum: '168',
                    StAddr: '168 Oakwood Ln',
                    City: 'Palisades Park',
                    RegionAbbr: 'NJ',
                    Postal: '07650',
                    Addr_type: 'StreetAddress',
                    Score: 92,
                    LongLabel: '168 Oakwood Ln, Palisades Park, NJ, 07650, USA',
                  },
                },
              ],
            });
          }
          if (href.includes('/suggest')) {
            return jsonResponse({ suggestions: [] });
          }
          throw new Error('unexpected url ' + href);
        },
      }
    );
    assert.equal(result.ok, true);
    assert.ok(result.suggestions.length >= 1);
    assert.equal(result.suggestions[0].zip, '07650');
    assert.equal(result.suggestions[0].label, '168 Oakwood Ln, Palisades Park, NJ 07650');
    assert.ok(result.suggestions.every((row) => /^\d/.test(row.label)));
    assert.ok(result.suggestions.every((row) => !/^07650\b/.test(row.label)));
  });

  it('fails open to an empty list when the geocoder is down', async () => {
    const result = await suggestAddresses(
      { q: '168 oak', zip: '07650', city: 'Palisades Park, NJ' },
      { fetchImpl: async () => { throw new Error('network'); } }
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.suggestions, []);
  });
});

describe('booking Step 4 wiring', () => {
  it('keeps the address field id and ZIP chip on every booking page', () => {
    for (const page of BOOKING_PAGES) {
      const html = read(page);
      assert.match(html, /id="f-addr"/, page);
      assert.match(html, /id="bk-addr-dd"/, page);
      assert.match(html, /id="bk-addr-zip-chip"/, page);
      assert.match(html, /booking-address-suggest\.js/, page);
    }
  });

  it('does not put a Places/Maps key in the booking HTML or client script', () => {
    const client = read('assets/booking-address-suggest.js');
    assert.doesNotMatch(client, /GOOGLE_PLACES_API_KEY/);
    assert.doesNotMatch(client, /GOOGLE_MAPS_API_KEY/);
    assert.match(client, /\/\.netlify\/functions\/address-suggest/);
    const fn = read('netlify/functions/address-suggest.js');
    assert.match(fn, /enforcePublicRateLimit/);
    assert.doesNotMatch(fn, /require\(['"][^'"]*stripe[^'"]*['"]\)/i);
    const { DEFAULT_LIMITS } = require('../netlify/lib/public-rate-limit');
    assert.equal(DEFAULT_LIMITS['address-suggest'].max, 180);
  });

  it('client applies the ZIP city onto a mismatched street line', () => {
    const src = read('assets/booking-address-suggest.js');
    assert.match(src, /bk-addr-zip-change/);
    assert.match(src, /function applyExpectedPlace/);
    assert.match(src, /hideDropdown\(\)/);
  });
});
