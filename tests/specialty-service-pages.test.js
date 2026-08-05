/**
 * Specialty service pages + shared specialty-service-nav + local booking bridge
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const PUBLIC_PAGES = [
  'index.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
  'boats-detailing.html',
  'powersports-detailing.html',
  'rv-detailing.html',
];

const SPECIALTY_PAGES = [
  'boats-detailing.html',
  'powersports-detailing.html',
  'rv-detailing.html',
];

const CATEGORY_BY_PAGE = {
  'boats-detailing.html': 'boats',
  'rv-detailing.html': 'rvs',
  'powersports-detailing.html': 'powersports',
};

const PACKAGE_BY_PAGE = {
  'boats-detailing.html': ['maint', 'full', 'premium'],
  'rv-detailing.html': ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
  'powersports-detailing.html': ['wash', 'full', 'premium'],
};

/** Approved real-work / category media (no car filler). */
const POWERSPORTS_MEDIA = [
  'assets/images/specialty/powersports/polaris-front-before-480.jpg',
  'assets/images/specialty/powersports/polaris-front-before-768.jpg',
  'assets/images/specialty/powersports/polaris-front-before-1200.jpg',
  'assets/images/specialty/powersports/polaris-front-after-480.jpg',
  'assets/images/specialty/powersports/polaris-front-after-768.jpg',
  'assets/images/specialty/powersports/polaris-front-after-1200.jpg',
  'assets/images/specialty/powersports/gator-interior-before-480.jpg',
  'assets/images/specialty/powersports/gator-interior-before-768.jpg',
  'assets/images/specialty/powersports/gator-interior-before-1200.jpg',
  'assets/images/specialty/powersports/gator-interior-after-480.jpg',
  'assets/images/specialty/powersports/gator-interior-after-768.jpg',
  'assets/images/specialty/powersports/gator-interior-after-1200.jpg',
  'assets/media/powersports/gallery/polaris-atv-front.jpeg',
  'assets/media/powersports/gallery/polaris-atv-angle.jpeg',
  'assets/media/powersports/gallery/motorcycle-road-glide.jpg',
  'assets/media/powersports/gallery/motorcycle-touring-side.jpg',
  'assets/media/powersports/gallery/IMG_7482.jpeg',
  'assets/media/powersports/gallery/IMG_7492.jpeg',
  'assets/media/powersports/gallery/utv-interior-detail.jpg',
  'assets/vehicles/premium/motorcycle.webp',
  'assets/vehicles/premium/atv.webp',
  'assets/vehicles/premium/utv.webp',
  'assets/vehicles/premium/powersports.webp',
];

const BOATS_MEDIA = [
  'assets/vehicles/premium/boat.webp',
  'assets/vehicles/premium/marine.webp',
  'assets/videos/specialty/boats/vkpq0511.mp4',
  'assets/videos/specialty/boats/rwaj3347.mp4',
  'assets/videos/specialty/boats/xats4703.mp4',
  'assets/images/specialty/boats/vkpq0511-poster.jpg',
  'assets/images/specialty/boats/rwaj3347-poster.jpg',
  'assets/images/specialty/boats/xats4703-poster.jpg',
];

const RV_MEDIA = [
  'assets/images/specialty/rv/rockwood-front-before-480.jpg',
  'assets/images/specialty/rv/rockwood-front-before-768.jpg',
  'assets/images/specialty/rv/rockwood-front-before-1200.jpg',
  'assets/images/specialty/rv/rockwood-front-after-480.jpg',
  'assets/images/specialty/rv/rockwood-front-after-768.jpg',
  'assets/images/specialty/rv/rockwood-front-after-1200.jpg',
  'assets/images/specialty/rv/wingamm-front-before-480.jpg',
  'assets/images/specialty/rv/wingamm-front-before-768.jpg',
  'assets/images/specialty/rv/wingamm-front-before-1200.jpg',
  'assets/images/specialty/rv/wingamm-front-after-480.jpg',
  'assets/images/specialty/rv/wingamm-front-after-768.jpg',
  'assets/images/specialty/rv/wingamm-front-after-1200.jpg',
  'assets/images/specialty/rv/wingamm-side-before-480.jpg',
  'assets/images/specialty/rv/wingamm-side-before-768.jpg',
  'assets/images/specialty/rv/wingamm-side-before-1200.jpg',
  'assets/images/specialty/rv/wingamm-side-after-480.jpg',
  'assets/images/specialty/rv/wingamm-side-after-768.jpg',
  'assets/images/specialty/rv/wingamm-side-after-1200.jpg',
  'assets/images/specialty/rv/vienna-front-before-480.jpg',
  'assets/images/specialty/rv/vienna-front-before-768.jpg',
  'assets/images/specialty/rv/vienna-front-before-1200.jpg',
  'assets/images/specialty/rv/vienna-front-after-480.jpg',
  'assets/images/specialty/rv/vienna-front-after-768.jpg',
  'assets/images/specialty/rv/vienna-front-after-1200.jpg',
  'assets/images/specialty/rv/vienna-roof-before-480.jpg',
  'assets/images/specialty/rv/vienna-roof-before-768.jpg',
  'assets/images/specialty/rv/vienna-roof-before-1200.jpg',
  'assets/images/specialty/rv/vienna-roof-after-480.jpg',
  'assets/images/specialty/rv/vienna-roof-after-768.jpg',
  'assets/images/specialty/rv/vienna-roof-after-1200.jpg',
];

/** Known car gallery filenames that must never appear on Powersports. */
const CAR_GALLERY_BLOCKLIST = [
  'IMG_7146', 'IMG_7147', 'IMG_7154', 'IMG_7156', 'IMG_7157',
  'IMG_7166', 'IMG_7167', 'IMG_7168', 'IMG_7381', 'IMG_7413',
  'IMG_7415', 'IMG_7441', 'IMG_7442', 'IMG_7458', 'IMG_7459',
];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function extractImgSrcs(html) {
  return [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
}

function extractMediaSrcs(html) {
  const imgs = extractImgSrcs(html);
  const videos = [...html.matchAll(/<source[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
  const posters = [...html.matchAll(/\bposter="([^"]+)"/gi)].map((m) => m[1]);
  const srcset = [...html.matchAll(/\bsrcset="([^"]+)"/gi)].flatMap((m) =>
    m[1].split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)
  );
  const og = [...html.matchAll(/property="og:image"\s+content="https:\/\/cardetail1\.com\/([^"]+)"/gi)].map((m) => m[1]);
  return [...imgs, ...videos, ...posters, ...srcset, ...og];
}

describe('specialty dedicated pages exist', () => {
  it('boats dedicated page exists', () => {
    assert.ok(exists('boats-detailing.html'));
  });
  it('powersports dedicated page exists', () => {
    assert.ok(exists('powersports-detailing.html'));
  });
  it('RV/Trailer dedicated page exists', () => {
    assert.ok(exists('rv-detailing.html'));
  });
});

describe('specialty-service-nav shared component', () => {
  for (const page of PUBLIC_PAGES) {
    it(`appears on ${page}`, () => {
      const html = read(page);
      assert.match(html, /class="specialty-service-nav"/);
      assert.match(html, /aria-label="Specialty detailing services"/);
    });

    it(`${page} has specialty nav CSS link`, () => {
      const html = read(page);
      assert.match(html, /assets\/specialty-service-nav\.css/);
    });

    it(`${page} specialty nav has exactly three service links`, () => {
      const html = read(page);
      const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/);
      assert.ok(block, 'nav block missing');
      const hrefs = [...block[0].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      assert.equal(hrefs.length, 3);
      assert.deepEqual(hrefs, [
        'rv-detailing.html',
        'boats-detailing.html',
        'powersports-detailing.html',
      ]);
    });

    it(`${page} specialty links are real anchors (not onclick-only)`, () => {
      const html = read(page);
      const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
      assert.doesNotMatch(block, /onclick=/);
      assert.match(block, /<a class="specialty-service-link" href="rv-detailing\.html"/);
      assert.match(block, /<a class="specialty-service-link" href="boats-detailing\.html"/);
      assert.match(block, /<a class="specialty-service-link" href="powersports-detailing\.html"/);
    });

    it(`${page} specialty nav has no promotional title label`, () => {
      const html = read(page);
      const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
      assert.doesNotMatch(block, /specialty-service-nav-label/);
      assert.doesNotMatch(block, /More Than Cars/i);
      assert.doesNotMatch(block, /Featured/i);
    });
  }

  it('specialty nav appears after main header nav', () => {
    const html = read('index.html');
    const mainNav = html.indexOf('id="main-nav"');
    const specialty = html.indexOf('class="specialty-service-nav"');
    assert.ok(mainNav >= 0 && specialty > mainNav);
  });
});

describe('homepage specialty switcher placement and state', () => {
  it('homepage contains exactly one specialty switcher', () => {
    const html = read('index.html');
    const blocks = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/g) || [];
    assert.equal(blocks.length, 1);
  });

  it('homepage switcher appears after global header and before hero', () => {
    const html = read('index.html');
    const mainNav = html.indexOf('id="main-nav"');
    const specialty = html.indexOf('class="specialty-service-nav"');
    const hero = html.indexOf('<section class="hero">');
    assert.ok(mainNav >= 0 && specialty > mainNav && hero > specialty);
  });

  it('homepage switcher has exactly three links in RV / Boats / Powersports order', () => {
    const html = read('index.html');
    const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
    const hrefs = [...block.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, [
      'rv-detailing.html',
      'boats-detailing.html',
      'powersports-detailing.html',
    ]);
  });

  it('homepage switcher hrefs match dedicated-page switcher hrefs', () => {
    const home = read('index.html').match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
    const boats = read('boats-detailing.html').match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
    const homeHrefs = [...home.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const boatsHrefs = [...boats.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(homeHrefs, boatsHrefs);
  });

  it('homepage switcher has no aria-current selected state', () => {
    const html = read('index.html');
    const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
    assert.doesNotMatch(block, /aria-current=/);
  });

  it('homepage switcher links are navigation anchors, not booking openers', () => {
    const html = read('index.html');
    const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
    assert.doesNotMatch(block, /openBooking|data-booking-category|onclick=/);
  });

  it('homepage does not include the More Than Cars promo section', () => {
    const html = read('index.html');
    assert.doesNotMatch(html, /id="specialty-services"/);
    assert.doesNotMatch(html, /More than cars/i);
    assert.doesNotMatch(html, /Featured boat page/i);
    assert.doesNotMatch(html, /specialty-section--secondary/);
    assert.doesNotMatch(html, /specialty-highlight-btn/);
  });

  it('homepage clears fixed header so specialty switcher is visible', () => {
    const html = read('index.html');
    assert.match(html, /\.specialty-service-nav\{margin-top:60px\}/);
    assert.match(html, /@media\(max-width:760px\)\{[\s\S]*?\.specialty-service-nav\{margin-top:52px\}/);
  });

  it('homepage uses shared specialty-service-nav.css (no duplicate switcher stylesheet)', () => {
    const html = read('index.html');
    const cssLinks = [...html.matchAll(/href="([^"]*specialty[^"]*\.css)"/g)].map((m) => m[1]);
    assert.deepEqual(cssLinks, ['assets/specialty-service-nav.css']);
  });

  it('no Netlify Function files changed by homepage switcher work', () => {
    assert.ok(exists('netlify/functions/submit-booking.js'));
    // Static guard: homepage switcher must not call functions
    const html = read('index.html');
    const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
    assert.doesNotMatch(block, /\.netlify\/functions/);
  });
});

describe('aria-current on dedicated pages', () => {
  it('boats page marks Boats as current', () => {
    const html = read('boats-detailing.html');
    assert.match(html, /href="boats-detailing\.html" aria-current="page"/);
    assert.doesNotMatch(html, /href="rv-detailing\.html" aria-current="page"/);
    assert.doesNotMatch(html, /href="powersports-detailing\.html" aria-current="page"/);
  });
  it('powersports page marks Powersports as current', () => {
    const html = read('powersports-detailing.html');
    assert.match(html, /href="powersports-detailing\.html" aria-current="page"/);
  });
  it('rv page marks RV & Trailers as current', () => {
    const html = read('rv-detailing.html');
    assert.match(html, /href="rv-detailing\.html" aria-current="page"/);
  });
  it('generic hubs do not set aria-current', () => {
    const html = read('new-jersey-hub.html');
    const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
    assert.doesNotMatch(block, /aria-current=/);
  });
});

describe('package sections near top', () => {
  for (const page of SPECIALTY_PAGES) {
    it(`${page} has package section id="packages"`, () => {
      const html = read(page);
      assert.match(html, /id="packages"/);
    });
    it(`${page} has exactly one H1`, () => {
      const html = read(page);
      const h1s = html.match(/<h1[\s>]/gi) || [];
      assert.equal(h1s.length, 1);
    });
  }

  it('boats H2 uses required package heading', () => {
    assert.match(read('boats-detailing.html'), /Choose Your Mobile Boat Detailing Package/);
  });
  it('rv H2 uses required package heading', () => {
    assert.match(read('rv-detailing.html'), /Choose Your Mobile RV &amp; Trailer Detailing Package/);
  });
  it('powersports H2 uses required package heading', () => {
    assert.match(read('powersports-detailing.html'), /Choose Your Powersports Detailing Package/);
  });

  it('boats page package section appears before video gallery', () => {
    const html = read('boats-detailing.html');
    assert.ok(html.indexOf('id="packages"') < html.indexOf('id="boat-gallery"'));
    assert.doesNotMatch(html, /yacht-cruise|yacht-speed-cruise/i);
    assert.match(html, /id="boat-gallery"/i);
    assert.match(html, /assets\/videos\/specialty\/boats\/vkpq0511\.mp4/);
  });
  it('powersports page package section appears before gallery', () => {
    const html = read('powersports-detailing.html');
    assert.ok(html.indexOf('id="packages"') < html.indexOf('id="gallery"'));
  });
  it('rv page package section appears before gallery', () => {
    const html = read('rv-detailing.html');
    const pkg = html.indexOf('id="packages"');
    const gallery = html.indexOf('RV Before');
    assert.ok(pkg >= 0 && gallery > pkg);
  });
});

describe('powersports video removal and images', () => {
  it('powersports page contains no video element', () => {
    const html = read('powersports-detailing.html');
    assert.doesNotMatch(html, /<video[\s>]/i);
  });
  it('powersports page contains no iframe', () => {
    const html = read('powersports-detailing.html');
    assert.doesNotMatch(html, /<iframe[\s>]/i);
  });
  it('powersports page has no video gallery heading', () => {
    const html = read('powersports-detailing.html');
    assert.doesNotMatch(html, /Powersports Video Gallery/i);
  });

  it('every rendered powersports media path exists and is approved', () => {
    const html = read('powersports-detailing.html');
    const srcs = extractMediaSrcs(html).filter((s) => !s.includes('cardetail1-logo'));
    assert.ok(srcs.length > 0, 'expected media');
    for (const src of srcs) {
      assert.doesNotMatch(src, /^(blob:|file:|https?:\/\/)/i);
      assert.doesNotMatch(src, /[A-Za-z]:\\/);
      assert.ok(exists(src), `missing image: ${src}`);
      assert.ok(
        POWERSPORTS_MEDIA.includes(src),
        `unapproved powersports media: ${src}`
      );
    }
  });

  it('powersports imports no automotive gallery car images', () => {
    const html = read('powersports-detailing.html');
    for (const id of CAR_GALLERY_BLOCKLIST) {
      assert.doesNotMatch(html, new RegExp(id, 'i'));
    }
    assert.doesNotMatch(html, /sedan|SUV interior|car paint|dashboard of a car/i);
  });

  it('no HEIC or MOV image sources on powersports page', () => {
    const html = read('powersports-detailing.html');
    assert.doesNotMatch(html, /\.HEIC|\.MOV|\.heic|\.mov/i);
  });
});

describe('boats and RV media paths resolve', () => {
  it('boats media exists and stays category-specific', () => {
    const html = read('boats-detailing.html');
    const srcs = extractMediaSrcs(html).filter((s) => !s.includes('cardetail1-logo'));
    for (const src of srcs) {
      assert.ok(exists(src), `missing: ${src}`);
      assert.ok(BOATS_MEDIA.includes(src) || src.startsWith('assets/vehicles/premium/'), `unexpected boats media: ${src}`);
      assert.doesNotMatch(src, /powersports\/gallery|before-after\/.*car|vehicles\/premium\/(sedan|suv|truck)/i);
    }
  });

  it('rv media exists and stays category-specific', () => {
    const html = read('rv-detailing.html');
    const srcs = extractImgSrcs(html).filter((s) => !s.includes('cardetail1-logo'));
    for (const src of srcs) {
      assert.ok(exists(src), `missing: ${src}`);
      assert.doesNotMatch(src, /powersports\/gallery\/IMG_748|vehicles\/premium\/(sedan|motorcycle)/i);
    }
    for (const must of RV_MEDIA) {
      assert.ok(html.includes(must), `expected RV media ${must}`);
      assert.ok(exists(must));
    }
  });
});

describe('local booking CTAs (no homepage redirect)', () => {
  for (const page of SPECIALTY_PAGES) {
    const cat = CATEGORY_BY_PAGE[page];

    it(`${page} loads specialty booking bridge`, () => {
      const html = read(page);
      assert.match(html, /assets\/specialty-booking-bridge\.js/);
    });

    it(`${page} Book CTAs use overlay bridge with href fallback`, () => {
      const html = read(page);
      // Progressive enhancement: primary Book links may include index.html?book=…
      // but must also carry data-booking-category so the specialty bridge opens overlay.
      assert.match(html, new RegExp(`href="index\\.html\\?book=${cat}"[^>]*data-booking-category="${cat}"|data-booking-category="${cat}"[^>]*href="index\\.html\\?book=${cat}"`));
      assert.doesNotMatch(html, /href="\/#booking"/);
      assert.doesNotMatch(html, /href="index\.html#booking"/);
      assert.match(html, /assets\/specialty-booking-bridge\.js/);
    });

    it(`${page} Book CTAs use data-booking-category="${cat}"`, () => {
      const html = read(page);
      const buttons = [...html.matchAll(/data-booking-category="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(buttons.length >= 2, 'expected booking CTAs');
      assert.ok(buttons.every((c) => c === cat), `expected only ${cat}, got ${buttons.join(',')}`);
      assert.ok(!buttons.includes('cars'), 'must not fall back to cars');
    });

    it(`${page} package CTAs preselect existing package IDs`, () => {
      const html = read(page);
      const pkgs = [...html.matchAll(/data-booking-package="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(pkgs)].sort(), [...PACKAGE_BY_PAGE[page]].sort());
      for (const pkg of pkgs) {
        assert.match(
          html,
          new RegExp(`data-booking-category="${cat}"[^>]*data-booking-package="${pkg}"|data-booking-package="${pkg}"[^>]*data-booking-category="${cat}"`)
        );
      }
    });

    it(`${page} View Packages scrolls locally`, () => {
      const html = read(page);
      assert.match(html, /href="#packages"/);
    });
  }

  it('booking bridge opens overlay and shows inline error when iframe fails (no homepage redirect)', () => {
    const js = read('assets/specialty-booking-bridge.js');
    assert.match(js, /openSpecialtyBooking/);
    assert.match(js, /openCategoryPackageBooking/);
    assert.match(js, /specialty-booking-overlay/);
    assert.match(js, /params\.set\('book'/);
    assert.match(js, /params\.set\('embed',\s*'1'\)/);
    assert.match(js, /cd1-booking-closed/);
    assert.match(js, /We could not load this booking option/);
    assert.doesNotMatch(js, /navigateToHomepageBooking/);
    assert.doesNotMatch(js, /location\.assign\s*\(\s*['"]index\.html/);
    assert.doesNotMatch(js, /href\s*=\s*['"]\/['"]/);
  });

  it('netlify CSP allows same-origin booking iframe', () => {
    const toml = read('netlify.toml');
    assert.match(toml, /frame-src 'self'/);
    assert.match(toml, /X-Frame-Options\s*=\s*"SAMEORIGIN"/);
  });

  it('shared launcher validates real category and package IDs', () => {
    const js = read('assets/specialty-booking-bridge.js');
    assert.match(js, /VALID_PACKAGES/);
    assert.match(js, /boats:\s*\{[^}]*maint/);
    assert.match(js, /rvs:\s*\{[^}]*maint_light/);
    assert.match(js, /powersports:\s*\{[^}]*wash/);
    assert.match(js, /INVALID_CATEGORY|INVALID_PACKAGE/);
    assert.match(js, /We could not load this booking option/);
    assert.match(js, /551-313-2956/);
    assert.doesNotMatch(js, /fallback.*cars|default.*cars/i);
  });

  it('package CTAs never use href # / or index.html', () => {
    for (const page of SPECIALTY_PAGES) {
      const html = read(page);
      const ctaBlocks = html.match(/<button[^>]*package-booking-cta[\s\S]*?<\/button>/g) || [];
      assert.ok(ctaBlocks.length >= 3, `${page} expected package CTAs`);
      for (const block of ctaBlocks) {
        assert.doesNotMatch(block, /href=/);
        assert.match(block, /type="button"/);
        assert.match(block, /data-booking-category="/);
        assert.match(block, /data-booking-package="/);
      }
      assert.doesNotMatch(html, /package-booking-cta[^>]*href="/);
    }
  });

  it('homepage embed mode supports specialty iframe booking', () => {
    const html = read('index.html');
    assert.match(html, /openBookingFromQuery/);
    assert.match(html, /params\.get\('book'\)/);
    assert.match(html, /cd1-booking-embed/);
    assert.match(html, /openBookingPkg/);
    assert.match(html, /ST\._prefillPkgId/);
    assert.match(html, /typeof seedDefaultTechs==='function'/);
    assert.match(html, /hero-zip/);
  });

  it('ZIP is preserved into embed query when present', () => {
    const js = read('assets/specialty-booking-bridge.js');
    assert.match(js, /params\.set\('zip'/);
    assert.match(js, /cd1_zip/);
    assert.match(js, /resolveZip/);
  });

  it('package CTA IDs exist in index.html PRICING for each specialty category', () => {
    const index = read('index.html');
    const extractIds = (cat) => {
      const m = index.match(new RegExp(`${cat}:\\s*\\{[\\s\\S]*?packages:\\[([\\s\\S]*?)\\],\\s*addons:`));
      assert.ok(m, `missing ${cat} packages`);
      return [...m[1].matchAll(/id:'([^']+)'/g)].map((x) => x[1]);
    };
    const boatsIds = extractIds('boats');
    const rvsIds = extractIds('rvs');
    const psIds = extractIds('powersports');
    for (const pkg of PACKAGE_BY_PAGE['boats-detailing.html']) {
      assert.ok(boatsIds.includes(pkg), `boats missing ${pkg}`);
    }
    for (const pkg of PACKAGE_BY_PAGE['rv-detailing.html']) {
      assert.ok(rvsIds.includes(pkg), `rvs missing ${pkg}`);
    }
    for (const pkg of PACKAGE_BY_PAGE['powersports-detailing.html']) {
      assert.ok(psIds.includes(pkg), `powersports missing ${pkg}`);
    }
  });

  it('boats/RV length and powersports tiers remain in booking config', () => {
    const html = read('index.html');
    assert.match(html, /usesLength=\(cat==='boats'\|\|cat==='rvs'\)/);
    assert.match(html, /setupLengthSelector/);
    assert.match(html, /LENGTH_PRICING/);
    assert.match(html, /motorcycle:\s*\{label:'Motorcycle'/);
    assert.match(html, /utv:\s*\{label:'UTV \/ Side-by-Side'/);
  });
});

describe('pricing catalog unchanged for specialty packages', () => {
  it('boats package IDs remain maint/essential/full/premium', () => {
    const html = read('index.html');
    const boats = html.match(/boats:\s*\{[\s\S]*?packages:\[([\s\S]*?)\],\s*addons:/);
    assert.ok(boats);
    assert.match(boats[1], /id:'maint'/);
    assert.match(boats[1], /id:'essential'/);
    assert.match(boats[1], /id:'full'/);
    assert.match(boats[1], /id:'premium'/);
  });
  it('powersports package IDs remain wash/essential/full/premium', () => {
    const html = read('index.html');
    const ps = html.match(/powersports:\s*\{[\s\S]*?packages:\[([\s\S]*?)\],\s*addons:/);
    assert.ok(ps);
    assert.match(ps[1], /id:'wash'/);
    assert.match(ps[1], /id:'essential'/);
    assert.match(ps[1], /id:'full'/);
    assert.match(ps[1], /id:'premium'/);
  });
  it('LENGTH_PRICING boat mins unchanged', () => {
    const html = read('index.html');
    assert.match(html, /boats:\s*\{[\s\S]*?maint:\s*\{perFt:\s*10,\s*min:\s*170\}/);
    assert.match(html, /full:\s*\{perFt:\s*26,\s*min:\s*380\}/);
    assert.match(html, /premium:\s*\{perFt:\s*32,\s*min:\s*595\}/);
  });
  it('LENGTH_PRICING rv mins match Preview104 commercial ladder', () => {
    const html = read('index.html');
    assert.match(html, /rvs:\s*\{[\s\S]*?maint:\s*\{ base: 130, ratePerFoot: 9 \}/);
    assert.match(html, /maint_light:\s*\{ base: 215, ratePerFoot: 14 \}/);
    assert.match(html, /interior:\s*\{ base: 215, ratePerFoot: 15 \}/);
    assert.match(html, /full_basic:\s*\{ base: 255, ratePerFoot: 21 \}/);
    assert.match(html, /premium:\s*\{ base: 255, ratePerFoot: 24 \}/);
    assert.match(html, /full:\s*\{ base: 340, ratePerFoot: 31 \}/);
    assert.doesNotMatch(html, /rvs:[\s\S]*?correction:\s*\{perFt:/);
  });
});

describe('specialty page UI (back-to-top + gallery lightbox)', () => {
  const pages = [
    'boats-detailing.html',
    'powersports-detailing.html',
    'rv-detailing.html',
    'fleet-services.html',
    'multi-vehicle-detailing.html',
  ];

  for (const page of pages) {
    it(`${page} loads shared specialty-page-ui assets`, () => {
      const html = read(page);
      assert.match(html, /assets\/specialty-page-ui\.css/);
      assert.match(html, /assets\/specialty-page-ui\.js/);
    });
  }

  it('specialty-page-ui.js provides back-to-top and lightbox behavior', () => {
    const js = read('assets/specialty-page-ui.js');
    assert.match(js, /initBackToTop/);
    assert.match(js, /initGalleryLightbox/);
    assert.match(js, /cd1-lightbox/);
    assert.match(js, /scrollY>420|scrollY > 420/);
  });

  it('rv gallery images are constrained with cover framing', () => {
    const html = read('rv-detailing.html');
    const css = read('assets/specialty-gallery.css');
    assert.match(html, /vienna-front-after-768.jpg/);
    assert.match(html, /ba-compare|sp-ba-card/);
    assert.match(css, /\.sp-ba-card[\s\S]*object-fit:\s*cover/);
    assert.doesNotMatch(html, /yacht-cruise/);
  });

  it('homepage back-to-top sits above chat widget', () => {
    const html = read('index.html');
    const css = read('assets/public-surface.css');
    assert.match(html, /assets\/back-to-top\.js/);
    assert.match(css, /#cd1-btt\{[^}]*z-index:10050/);
    assert.match(read('assets/back-to-top.js'), /cd1-btt-on/);
  });
});

describe('no Netlify Function changes required by specialty pages', () => {
  it('specialty pages are static HTML only', () => {
    for (const page of SPECIALTY_PAGES) {
      const html = read(page);
      assert.doesNotMatch(html, /\.netlify\/functions/);
    }
  });

  it('fleet remains quote-only on specialty pages', () => {
    for (const page of SPECIALTY_PAGES) {
      const html = read(page);
      assert.doesNotMatch(html, /data-booking-category="fleet"/);
      assert.doesNotMatch(html, /book=fleet/);
    }
  });
});
