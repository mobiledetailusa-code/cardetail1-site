'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { JSDOM } = require('jsdom');

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
    assert.match(page, /<h1[^>]*>Keep That Freshly Detailed Look for Years<\/h1>/);
    assert.match(page, /<title>Professional Ceramic Coating at Your Location \| Cardetail1<\/title>/);
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

  it('keeps 5- and 9-year options as consultation only and avoids absolute claims', () => {
    assert.doesNotMatch(page, /scratch-proof|\bpermanent\b|\bguaranteed\b|\b10H\b/i);
    assert.doesNotMatch(page, /outdoor application is always|always applied outdoors|garage is never/i);
    assert.match(page, /If conditions are not suitable/);
    assert.match(page, /We don’t treat every outdoor space as suitable/);
    const five = page.slice(page.indexOf('id="cc-card-5"'), page.indexOf('id="cc-long-term"'));
    const nine = page.slice(page.indexOf('id="cc-long-term"'), page.indexOf('class="cc-trust"'));
    for (const block of [five, nine]) {
      assert.doesNotMatch(block, /\$\d|data-ceramic-book|pkg=|pkgId|submit-booking|ceramic_5|ceramic_9/);
      assert.match(block, /sms:\+15513893986/);
    }
    assert.match(five, /Ask About 5 Years/);
    assert.match(five, /5-year%20ceramic%20coating%20option/);
    assert.match(nine, /up to 9 years/);
    assert.match(nine, /long-term%20ceramic%20protection/);
    assert.doesNotMatch(page, /data-ceramic-book="(?!ceramic_1yr|ceramic_3yr|")/);
    assert.doesNotMatch(read('assets/ceramic-coating-page.js'), /submit-booking|localStorage|sessionStorage|gtag\(/);
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

  it('shows eight projects without undocumented terms or missing-info captions', () => {
    const projects = page.slice(page.indexOf('id="projects"'), page.indexOf('id="process"'));
    const names = [
      'Audi Q8',
      'Toyota Sequoia',
      'BMW X7',
      'Ford Bronco',
      'Toyota Corolla Cross',
      'Toyota Highlander',
      'Mercedes-Benz GLC',
    ];
    assert.equal((projects.match(/class="cc-project"/g) || []).length, 8);
    for (const name of names) assert.equal(projects.includes(name), true, name);
    assert.match(projects, /data-vehicle="BMW"/);
    assert.match(projects, /Surface preparation in progress/);
    assert.equal((projects.match(/Finished ceramic coating result/g) || []).length, 7);
    assert.match(projects, /Take a Closer Look/);
    assert.doesNotMatch(projects, /Not labeled|Not itemized|Initial condition|booked term|Up to \d Year/i);
    assert.doesNotMatch(page, /Not labeled|Not itemized/);
    const css = read('assets/ceramic-coating.css');
    assert.match(css, /@media \(min-width:1360px\)/);
    assert.match(css, /repeat\(4,minmax\(0,1fr\)\)/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /scroll-behavior:\s*auto/);
    assert.match(css, /aspect-ratio:4\/3/);
    assert.doesNotMatch(css, /cc-project--feature|cc-compare/);
  });

  it('highlights a recommendation without storing it, and closes the closer look with Escape', () => {
    const dom = new JSDOM(page, {
      url: 'http://127.0.0.1/ceramic-coating',
      runScripts: 'outside-only',
    });
    const { window } = dom;
    const { document } = window;
    window.IntersectionObserver = class {
      observe() {}
      disconnect() {}
    };
    window.eval(read('assets/ceramic-coating-page.js'));
    const guide = document.getElementById('guide');
    assert.equal(guide.querySelector('form, input, textarea'), null);

    const mid = document.querySelector('[data-keep="mid"]');
    mid.click();
    assert.equal(mid.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('[data-keep="short"]').getAttribute('aria-pressed'), 'false');
    assert.equal(document.querySelector('[data-recommend="year3"]').classList.contains('is-recommended'), true);
    assert.equal(document.querySelector('[data-recommend="year1"]').classList.contains('is-recommended'), false);
    assert.equal(document.querySelector('[data-recommend="year5"]').classList.contains('is-recommended'), false);
    assert.equal(
      document.getElementById('cc-guide-result').textContent,
      'Up to 3 Years is our most popular balance of protection and value.',
    );
    assert.equal(window.localStorage.length, 0);

    document.querySelector('[data-keep="long"]').click();
    assert.equal(document.querySelector('[data-recommend="year5"]').classList.contains('is-recommended'), true);
    assert.equal(document.querySelector('[data-recommend="year9"]').classList.contains('is-recommended'), true);
    assert.equal(document.querySelector('[data-recommend="year3"]').classList.contains('is-recommended'), false);
    assert.match(document.getElementById('cc-guide-result').textContent, /long-term options/);

    const audiBtn = document.querySelector('[data-vehicle="Audi Q8"] [data-look]');
    audiBtn.focus();
    audiBtn.click();
    const dialog = document.getElementById('cc-look');
    assert.equal(dialog.hidden, false);
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(document.getElementById('cc-look-title').textContent, 'Audi Q8');
    assert.match(document.getElementById('cc-look-line').textContent, /Dark paint/);
    assert.equal(document.getElementById('cc-look-photos').querySelectorAll('img').length, 2);
    assert.match(dialog.textContent, /Additional paint correction is performed only when quoted and approved/);
    const close = document.getElementById('cc-look-close');
    const ask = dialog.querySelector('a[href^="sms:"]');
    assert.equal(document.activeElement, close);
    ask.focus();
    const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(document.activeElement, close);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(dialog.hidden, true);
    assert.equal(document.activeElement, audiBtn);

    const yearBtn = document.querySelector('[data-ceramic-book="ceramic_1yr"]');
    yearBtn.click();
    const frame = document.querySelector('#cc-booking-overlay iframe');
    assert.match(frame.getAttribute('src'), /book=cars/);
    assert.match(frame.getAttribute('src'), /pkg=ceramic_1yr/);
    assert.match(frame.getAttribute('src'), /embed=1/);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(frame.getAttribute('src'), 'about:blank');
    assert.equal(window.localStorage.length, 0);
  });
});
