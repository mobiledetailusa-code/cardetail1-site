'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  computeVehicleSubtotal,
} = require('../netlify/lib/booking-price-catalog');
const {
  BASE_PRICES,
  INCLUSIONS,
  PACKAGES,
  PUBLIC_PACKAGE_NAMES,
} = require('../netlify/lib/ceramic-coating');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const page = read('ceramic-coating.html');
const ZIP = '07601';

function money(pkgId) {
  const quoted = computeVehicleSubtotal({ cat: 'cars', pkgId, tierKey: 'small', addons: [] }, ZIP);
  assert.equal(quoted.ok, true, quoted.error);
  const minimum = Math.min(...Object.values(BASE_PRICES[pkgId]));
  assert.equal(quoted.basePrice, minimum);
  assert.equal(quoted.basePrice, BASE_PRICES[pkgId].compact);
  return quoted.basePrice;
}

function formatPrice(amount) {
  return '$' + amount.toLocaleString('en-US');
}

function parseRedirects(toml) {
  return toml.split('[[redirects]]').slice(1).map((block) => {
    const body = block.split('[[')[0];
    const from = body.match(/from = "([^"]+)"/);
    const to = body.match(/to = "([^"]+)"/);
    const status = body.match(/status = (\d+)/);
    if (!from || !to || !status) return null;
    return { from: from[1], to: to[1], status: Number(status[1]), force: /force = true/.test(body) };
  }).filter(Boolean);
}

function jsonLd(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html))) blocks.push(JSON.parse(match[1]));
  const nodes = [];
  for (const block of blocks) {
    if (block['@graph']) nodes.push(...block['@graph']);
    else nodes.push(block);
  }
  return nodes;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, pathname, redirects) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        location: res.headers.location || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('ceramic coating landing page', () => {
  const oneYear = money('ceramic_1yr');
  const threeYear = money('ceramic_3yr');

  it('serves the clean /ceramic-coating URL with 200 and redirects the html file once', async () => {
    const rules = parseRedirects(read('netlify.toml'));
    const htmlRule = rules.find((rule) => rule.from === '/ceramic-coating.html');
    assert.ok(htmlRule);
    assert.equal(htmlRule.to, '/ceramic-coating');
    assert.equal(htmlRule.status, 301);
    assert.equal(htmlRule.force, true);
    assert.equal(rules.some((rule) => rule.from === '/ceramic-coating'), false);

    const server = http.createServer((req, res) => {
      const current = new URL(req.url, 'http://127.0.0.1');
      const rule = rules.find((item) => item.from === current.pathname);
      if (rule && rule.status >= 300 && rule.status < 400) {
        res.writeHead(rule.status, { Location: rule.to });
        res.end();
        return;
      }
      let file = current.pathname === '/' ? 'index.html' : current.pathname.replace(/^\//, '');
      if (!path.extname(file) && fs.existsSync(path.join(root, `${file}.html`))) file = `${file}.html`;
      const abs = path.join(root, file);
      if (!abs.startsWith(root) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(abs));
    });
    const port = await listen(server);
    try {
      const clean = await request(port, '/ceramic-coating');
      assert.equal(clean.status, 200);
      assert.match(clean.body, /<link rel="canonical" href="https:\/\/cardetail1\.com\/ceramic-coating">/);
      const duplicate = await request(port, '/ceramic-coating.html');
      assert.equal(duplicate.status, 301);
      assert.equal(duplicate.location, '/ceramic-coating');
      const followed = await request(port, duplicate.location);
      assert.equal(followed.status, 200);
      const again = await request(port, '/ceramic-coating');
      assert.equal(again.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('has one H1, the canonical URL, and both catalog packages', () => {
    assert.equal((page.match(/<h1\b/gi) || []).length, 1);
    assert.match(page, /<h1[^>]*>Professional Ceramic Coating at Your Location<\/h1>/);
    assert.match(page, /<link rel="canonical" href="https:\/\/cardetail1\.com\/ceramic-coating">/);
    assert.match(page, /Professional Ceramic Protection — Up to 1 Year/);
    assert.match(page, /Professional Ceramic Protection — Up to 3 Years/);
    const escaped = (amount) => formatPrice(amount).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(page, new RegExp(`data-ceramic-from="ceramic_1yr">${escaped(oneYear)}`));
    assert.match(page, new RegExp(`data-ceramic-from="ceramic_3yr">${escaped(threeYear)}`));
    assert.match(page, /Most Popular/);
    assert.equal(PUBLIC_PACKAGE_NAMES.ceramic_1yr, 'Professional Ceramic Protection — Up to 1 Year');
    assert.equal(PUBLIC_PACKAGE_NAMES.ceramic_3yr, 'Professional Ceramic Protection — Up to 3 Years');
    assert.equal(PACKAGES.ceramic_1yr.baseMinutes, 480);
    assert.equal(PACKAGES.ceramic_3yr.baseMinutes, 600);
    assert.match(page, /About 8 hours/);
    assert.match(page, /About 10 hours/);
    for (const item of INCLUSIONS) assert.equal(page.includes(item), true, item);
  });

  it('points package buttons at the existing cars booking flow', () => {
    assert.match(page, /href="\/\?book=cars&amp;pkg=ceramic_1yr"[^>]*data-ceramic-book="ceramic_1yr"/);
    assert.match(page, /href="\/\?book=cars&amp;pkg=ceramic_3yr"[^>]*data-ceramic-book="ceramic_3yr"/);
    assert.match(page, /href="\/\?book=cars" data-ceramic-book=""/);
    assert.doesNotMatch(page, /id="bk-ov"/);
    assert.doesNotMatch(page, /js\.stripe\.com/);
    assert.doesNotMatch(page, /ceramic-booking\.js/);
    assert.match(read('assets/ceramic-coating-page.js'), /embed/);
    assert.match(read('assets/ceramic-coating-page.js'), /book', 'cars'/);
  });

  it('does not add longer terms or banned protection claims', () => {
    assert.doesNotMatch(page, /5-year|9-year|10H|scratch-proof|guaranteed|permanent protection/i);
    assert.doesNotMatch(page, /AggregateRating|"@type":\s*"Review"|@type": "Review"/);
    const nodes = jsonLd(page);
    assert.equal(nodes.some((node) => [].concat(node['@type']).includes('Review')), false);
    assert.equal(nodes.some((node) => [].concat(node['@type']).includes('AggregateRating')), false);
    assert.equal(nodes.some((node) => [].concat(node['@type']).includes('FAQPage')), false);
    const service = nodes.find((node) => [].concat(node['@type']).includes('Service'));
    const crumbs = nodes.find((node) => [].concat(node['@type']).includes('BreadcrumbList'));
    assert.ok(service);
    assert.ok(crumbs);
    assert.equal(service.offers[0].price, String(oneYear));
    assert.equal(service.offers[1].price, String(threeYear));
    assert.equal(crumbs.itemListElement[0].item, 'https://cardetail1.com/');
    assert.equal(crumbs.itemListElement[1].item, 'https://cardetail1.com/ceramic-coating');
  });

  it('keeps deploy previews free of Google Ads tags', () => {
    assert.match(page, /deploy-preview-\\d\+/);
    assert.match(page, /noindex, nofollow/);
    assert.doesNotMatch(page, /<meta name="robots" content="noindex/);
    assert.doesNotMatch(page, /googletagmanager|googleadservices|gtag\(|AW-|revenue-events\.js/i);
    assert.doesNotMatch(read('sitemap.xml'), /ceramic-coating/);
    assert.match(page, /href="\/"/);
  });

  it('gives every image alt text and reserved dimensions', () => {
    const images = page.match(/<img\b[^>]*>/gi) || [];
    assert.ok(images.length >= 5);
    for (const tag of images) {
      assert.match(tag, /\balt="[^"]+"/, tag);
      assert.match(tag, /\bwidth="\d+"/, tag);
      assert.match(tag, /\bheight="\d+"/, tag);
      const src = tag.match(/\bsrc="([^"]+)"/)[1];
      assert.equal(fs.existsSync(path.join(root, src)), true, src);
    }
  });

  it('does not change ceramic price authority', () => {
    assert.equal(BASE_PRICES.ceramic_1yr.compact, 650);
    assert.equal(BASE_PRICES.ceramic_3yr.compact, 1050);
    assert.equal(oneYear, 650);
    assert.equal(threeYear, 1050);
    assert.equal(fs.readFileSync(path.join(root, 'netlify/lib/ceramic-coating.js'), 'utf8').includes('depositDollars: 150'), true);
    assert.equal(fs.readFileSync(path.join(root, 'netlify/lib/ceramic-coating.js'), 'utf8').includes('depositDollars: 250'), true);
  });
});
