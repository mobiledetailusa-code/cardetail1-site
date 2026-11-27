'use strict';

// Every public (sitemap) page must render a link preview in Facebook,
// WhatsApp, iMessage and X: an absolute og:image that exists in the
// repository, plus title, description, canonical og:url and a twitter:card.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://cardetail1.com/';
const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);

function fileFor(url) {
  const stem = url.slice(ORIGIN.length).replace(/\/$/, '');
  return (stem || 'index') + '.html';
}

/** Pixel size of a PNG, JPEG or WebP file, or null. */
function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const m = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
    return null;
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const c = b.toString('ascii', 12, 16);
    if (c === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (c === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (c === 'VP8L') { const n = b.readUInt32LE(21); return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)]; }
  }
  return null;
}

const meta = (html, key) => {
  const re = new RegExp(`<meta (?:property|name)="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" content="([^"]*)"`);
  const m = html.match(re);
  return m ? m[1] : null;
};

test('the sitemap lists pages to check', () => {
  assert.ok(urls.length >= 40, `only ${urls.length} sitemap URLs`);
});

for (const url of urls) {
  const file = fileFor(url);
  test(`${file} has a complete share preview`, () => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const image = meta(html, 'og:image');
    assert.ok(image, `${file}: og:image missing`);
    assert.ok(image.startsWith(ORIGIN), `${file}: og:image must be an absolute ${ORIGIN} URL`);
    const local = path.join(ROOT, image.slice(ORIGIN.length));
    assert.ok(fs.existsSync(local), `${file}: og:image file ${image} is not in the repository`);
    assert.ok(meta(html, 'og:title'), `${file}: og:title missing`);
    assert.ok(meta(html, 'og:description'), `${file}: og:description missing`);
    const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    assert.equal(meta(html, 'og:url'), canonical, `${file}: og:url must equal the canonical URL`);
    assert.ok(meta(html, 'twitter:card'), `${file}: twitter:card missing`);
    const w = meta(html, 'og:image:width');
    const h = meta(html, 'og:image:height');
    if (w || h) {
      const size = imageSize(local);
      assert.ok(size, `${file}: cannot read ${image} dimensions`);
      assert.deepEqual([Number(w), Number(h)], size, `${file}: og:image:width/height must match ${image}`);
    }
  });
}
