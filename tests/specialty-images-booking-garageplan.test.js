/**
 * Specialty images, Book CTAs, and Garage Plan section — operational regression.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

/**
 * True only if `p` is tracked by git (staged or committed) — i.e. it would
 * actually ship. A secret-bearing file like a local `.env` that exists on
 * disk but is gitignored/untracked is not a leak risk and must not fail
 * this check; only a tracked copy is.
 */
function isGitTracked(p) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', p], { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const PAGES = [
  { file: 'boats-detailing.html', cat: 'boats', label: 'Boats' },
  { file: 'rv-detailing.html', cat: 'rvs', label: 'RV' },
  { file: 'powersports-detailing.html', cat: 'powersports', label: 'Powersports' },
];

const MAX_CONTENT_IMAGE_BYTES = 550 * 1024;

test('specialty pages exist with exactly one H1 each', () => {
  for (const p of PAGES) {
    assert.equal(exists(p.file), true, p.file);
    const html = read(p.file);
    const h1 = [...html.matchAll(/<h1\b/gi)];
    assert.equal(h1.length, 1, `${p.file} H1 count`);
  }
});

test('specialty pages use category-compatible image refs and no yacht stock', () => {
  for (const p of PAGES) {
    const html = read(p.file);
    assert.doesNotMatch(html, /yacht-cruise|yacht-speed-cruise/i);
    const imgs = [...html.matchAll(/src="(assets\/[^"]+\.(?:jpe?g|png|webp|jpg))"/gi)].map((m) => m[1]);
    for (const src of imgs) {
      assert.equal(exists(src), true, `missing ${src} on ${p.file}`);
      const tag = html.match(new RegExp(`<img[^>]+src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'i'));
      assert.ok(tag, `img tag for ${src}`);
      assert.match(tag[0], /width=|height=|aspect-ratio/i);
    }
  }
  assert.equal(exists('assets/media/boats/gallery/yacht-cruise.jpg'), false);
  assert.equal(exists('assets/media/boats/gallery/yacht-speed-cruise.jpg'), false);
});

test('boats page images stay marine and do not reference RV/car/powersports galleries', () => {
  const html = read('boats-detailing.html');
  assert.match(html, /assets\/videos\/specialty\/boats\//);
  assert.doesNotMatch(html, /assets\/media\/rv\/|assets\/media\/powersports\/|luxury-urus|sedan/i);
  assert.match(html, /vkpq0511\.mp4|rwaj3347\.mp4/);
});

test('RV page images stay RV and do not reference boats/powersports/car stock', () => {
  const html = read('rv-detailing.html');
  assert.match(html, /assets\/images\/specialty\/rv\//);
  assert.doesNotMatch(html, /assets\/media\/boats\/|assets\/media\/powersports\/|luxury-urus/i);
});

test('powersports page images stay powersports and do not reference RV/car-only assets', () => {
  const html = read('powersports-detailing.html');
  assert.match(html, /assets\/images\/specialty\/powersports\//);
  assert.doesNotMatch(html, /assets\/media\/rv\/|assets\/media\/boats\/|luxury-urus|momentum-gclass/i);
  assert.match(html, /gator-interior/);
});

test('Book CTAs exist and use correct data-booking-category', () => {
  for (const p of PAGES) {
    const html = read(p.file);
    assert.match(html, new RegExp(`data-booking-category="${p.cat}"`));
    assert.match(html, /Book (Online|This Service)|Select This .+ Package/i);
  }
});

test('specialty booking bridge opens category booking helpers', () => {
  const js = read('assets/specialty-booking-bridge.js');
  assert.match(js, /openCategoryPackageBooking/);
  assert.match(js, /openCategoryBooking/);
  assert.match(js, /openSpecialtyBooking/);
  assert.match(js, /data-booking-multi/);
  assert.match(js, /multi/);
  assert.doesNotMatch(js, /evaluateAndMaybeBlock/);
});

test('Have 2+ vehicles section keeps working Book Multiple CTA only', () => {
  const index = read('index.html');
  assert.match(index, /Detail 2 or more vehicles in one visit/);
  assert.match(index, /Book Multiple Vehicles/);
  assert.doesNotMatch(index, /Request Garage Plan|Build Your Garage Plan|data-cd1-garage-cta/);
  for (const p of PAGES) {
    const html = read(p.file);
    assert.match(html, /data-cd1-multi-vehicle-section/);
    assert.match(html, /data-booking-multi="1"/);
    assert.match(html, /data-booking-category="[^"]+"/);
    assert.doesNotMatch(html, /Request Garage Plan|Build Your Garage Plan|data-cd1-garage-cta/);
  }
});

test('Garage Plan Admin plumbing remains available server-side when deferred from public CTAs', () => {
  const submit = read('netlify/functions/garage-plan-submit.js');
  assert.match(submit, /gpReference/);
  assert.match(submit, /customerName/);
  const admin = read('admin-ops.html') + read('assets/admin-ops.css') + read('assets/admin-ops.js');
  assert.match(admin, /revopsGarage/);
  assert.match(admin, /gpReference|Garage Plan/i);
  const household = read('netlify/lib/revenue-household.js');
  assert.match(household, /customerName/);
  assert.match(household, /notificationStatus/);
});

test('six-step checkout is authoritative on index; specialty pages keep process copy without booking step chrome', () => {
  for (const p of PAGES) {
    const html = read(p.file);
    assert.doesNotMatch(html, /id="bpt6"|BK_VISIBLE_STEPS/i);
    assert.match(html, /Four clear steps|Start booking|Book Online/i);
  }
  const bridge = read('assets/specialty-booking-bridge.js');
  assert.match(bridge, /index\.html\?/);
  assert.match(bridge, /launchBooking/);
  const index = read('index.html');
  assert.match(index, /BK_VISIBLE_STEPS = 6/);
});

test('committed specialty content images stay under size budget', () => {
  const files = [
    'assets/media/boats/gallery/boat-mastercraft-side.jpg',
    'assets/media/boats/gallery/boat-cockpit-detail.jpg',
    'assets/media/rv/gallery/momentum-gclass-front.jpeg',
    'assets/media/rv/gallery/momentum-gclass-side.jpeg',
    'assets/media/rv/gallery/rockwood-signature-front.jpeg',
    'assets/media/rv/gallery/jayco-eagle-front.jpeg',
    'assets/media/rv/gallery/wingamm-side.jpeg',
    'assets/media/powersports/gallery/motorcycle-road-glide.jpg',
    'assets/media/powersports/gallery/motorcycle-touring-side.jpg',
    'assets/media/powersports/gallery/IMG_7482.jpeg',
    'assets/media/powersports/gallery/IMG_7492.jpeg',
    'assets/media/powersports/gallery/polaris-atv-front.jpeg',
    'assets/media/powersports/gallery/utv-interior-detail.jpg',
  ];
  for (const f of files) {
    assert.equal(exists(f), true, f);
    const size = fs.statSync(path.join(root, f)).size;
    assert.ok(size <= MAX_CONTENT_IMAGE_BYTES, `${f} is ${size} bytes`);
  }
});

test('no Communication Core / credential / QA screenshot artifacts introduced', () => {
  assert.equal(exists('netlify/functions/communication-core.js'), false);
  assert.equal(exists('docs/communication-core.md'), false);
  const stagedNoise = [
    'docs/qa-screenshots',
    '_qa',
  ];
  for (const p of stagedNoise) {
    if (exists(p)) {
      assert.fail(`unexpected path present: ${p}`);
    }
  }
  // A local, gitignored .env is normal developer/agent setup and must not
  // fail this check — only a *tracked* (staged or committed) secret-bearing
  // env file is an actual leak risk.
  if (isGitTracked('.env')) {
    assert.fail('.env is tracked by git — a secret-bearing file must never be staged or committed');
  }
});

test('specialty CSS constrains media frames', () => {
  const css = read('assets/specialty-category.css');
  assert.match(css, /\.sp-media-frame/);
  assert.match(css, /max-height/);
  assert.match(css, /img,\s*video\s*\{\s*max-width:\s*100%/);
  assert.match(css, /cd1-multi-cta/);
});
