'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const GUIDE_PAGES = [
  'blog.html',
  'detailing-vs-car-wash.html',
  'how-often-to-detail.html',
  'mobile-detailing-what-to-expect.html',
];

function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html))) blocks.push(JSON.parse(match[1]));
  return blocks;
}

function typeList(html) {
  return jsonLdBlocks(html).flatMap((block) => [].concat(block['@type'] || []));
}

function faqBlock(html) {
  return jsonLdBlocks(html).find((block) => [].concat(block['@type'] || []).includes('FAQPage'));
}

function imgTags(html) {
  return [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : '';
}

test('homepage and footer expose Guides', () => {
  const index = read('index.html');
  assert.match(index, /href="blog\.html">Guides<\/a>/);
  const footer = read('assets/partials/specialty-public-footer.html');
  assert.match(footer, /href="blog\.html">Guides &amp; FAQ<\/a>/);
});

test('guide pages are indexable public HTML with title, H1, and canonical', () => {
  for (const page of GUIDE_PAGES) {
    const html = read(page);
    assert.match(html, /<meta charset="UTF-8">/i, `${page} missing charset`);
    assert.match(html, /<title>[^<]+<\/title>/, `${page} missing title`);
    assert.match(html, /<h1[\s>]/, `${page} missing H1`);
    assert.equal((html.match(/<h1[\s>]/gi) || []).length, 1, `${page} must have exactly one H1`);
    assert.match(html, /rel="canonical"/, `${page} missing canonical`);
    assert.doesNotMatch(html, /id="bk-ov"/, `${page} must not embed the booking modal`);
    assert.match(html, /href="blog\.html"/, `${page} missing guides hub link`);
    assert.match(html, /id="cd1-public-footer"/, `${page} missing canonical footer`);
    assert.match(html, /assets\/back-to-top\.js/, `${page} missing back-to-top`);
    assert.match(html, /Cardetail1/, `${page} missing brand`);
    assert.match(html, /content="index,follow/, `${page} missing index,follow robots`);
    assert.doesNotMatch(html, /noindex/i, `${page} is noindexed`);
    assert.doesNotMatch(html, /Vehicles detailed/, `${page} claims a vehicle count`);
    assert.doesNotMatch(html, /Lock Your Slot/i, `${page} uses forbidden slot copy`);
    assert.match(html, /href="index\.html"/, `${page} missing booking/home CTA`);
  }
});

test('guide titles and H1s match the customer query', () => {
  const hub = read('blog.html');
  assert.match(hub, /<title>Car Detailing Guides \| Cardetail1<\/title>/);
  assert.match(hub, /<h1>Car Detailing Guides<\/h1>/);

  const wash = read('detailing-vs-car-wash.html');
  assert.match(wash, /<title>Car Wash vs\. Car Detailing: What’s the Difference\? \| Cardetail1<\/title>/);
  assert.match(wash, /<h1>Car Wash vs\. Car Detailing: What’s Actually Different\?<\/h1>/);

  const often = read('how-often-to-detail.html');
  assert.match(often, /<title>How Often Should You Detail Your Car\? \| Cardetail1<\/title>/);
  assert.match(often, /<h1>How Often Should You Detail Your Car\?<\/h1>/);

  const mobile = read('mobile-detailing-what-to-expect.html');
  assert.match(mobile, /<title>What Is Mobile Car Detailing\? What to Expect \| Cardetail1<\/title>/);
  assert.match(mobile, /<h1>What Is Mobile Car Detailing and What Should You Expect\?<\/h1>/);
});

test('guides hub is a crawlable search destination', () => {
  const html = read('blog.html');
  assert.match(html, /<form[^>]*id="guide-search-form"[^>]*method="get"/);
  assert.match(html, /name="q"/);
  assert.match(html, /action="blog\.html"/);
  assert.match(html, /Car Wash vs\. Car Detailing/);
  assert.match(html, /mobile car detailing/i);
  const types = typeList(html);
  assert.ok(types.includes('CollectionPage'));
  assert.ok(types.includes('FAQPage'));
  assert.ok(types.includes('WebSite'));
  assert.ok(types.includes('BreadcrumbList'));
  const website = jsonLdBlocks(html).find((block) => [].concat(block['@type'] || []).includes('WebSite'));
  assert.equal(
    website.potentialAction.target.urlTemplate,
    'https://cardetail1.com/blog.html?q={search_term_string}',
  );
  const collection = jsonLdBlocks(html).find((block) => [].concat(block['@type'] || []).includes('CollectionPage'));
  assert.equal(collection.mainEntity['@type'], 'ItemList');
  assert.equal(collection.mainEntity.itemListElement.length, 3);
});

test('homepage WebSite SearchAction points at the guides hub', () => {
  const website = jsonLdBlocks(read('index.html')).find((block) =>
    [].concat(block['@type'] || []).includes('WebSite'),
  );
  assert.ok(website);
  assert.equal(website.name, 'Cardetail1');
  assert.equal(
    website.potentialAction.target.urlTemplate,
    'https://cardetail1.com/blog.html?q={search_term_string}',
  );
});

test('visible FAQ questions match FAQPage JSON-LD and stay bounded', () => {
  for (const page of GUIDE_PAGES) {
    const html = read(page);
    const summaries = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1].trim());
    const faq = faqBlock(html);
    const names = faq.mainEntity.map((q) => q.name);
    assert.deepEqual(names, summaries, `${page} FAQ schema/visible mismatch`);
    assert.ok(names.length >= 5 && names.length <= 8, `${page} should have 5–8 FAQs, got ${names.length}`);
  }
  const hubNames = faqBlock(read('blog.html')).mainEntity.map((q) => q.name);
  assert.ok(hubNames.includes('What is the difference between a car wash and detailing?'));
  assert.ok(hubNames.includes('Does mobile detailing require water or electricity?'));
});

test('detailing vs car wash page has comparison, Article schema, and contextual links', () => {
  const html = read('detailing-vs-car-wash.html');
  assert.match(html, /class="cmp-table"/);
  assert.match(html, /class="vs-pair"/);
  assert.match(html, /Typical car wash/);
  assert.match(html, /Professional detail/);
  assert.match(html, /href="mobile-detailing-what-to-expect\.html"/);
  assert.match(html, /href="how-often-to-detail\.html"/);
  const types = typeList(html);
  assert.ok(types.includes('Article'));
  assert.ok(types.includes('BlogPosting'));
  assert.ok(types.includes('FAQPage'));
  assert.ok(types.includes('BreadcrumbList'));
  const article = jsonLdBlocks(html).find((block) => [].concat(block['@type'] || []).includes('Article'));
  assert.ok(article.datePublished);
  assert.ok(article.publisher.logo.url);
});

test('guide images resolve, have alt, and are not placeholders', () => {
  const placeholderSrc = /unsplash|placeholder\.|picsum|sedan\.svg/i;
  for (const page of GUIDE_PAGES) {
    const html = read(page);
    for (const tag of imgTags(html)) {
      const src = attr(tag, 'src');
      const alt = attr(tag, 'alt');
      assert.ok(src, `${page} image missing src`);
      assert.doesNotMatch(src, placeholderSrc, `${page} placeholder src ${src}`);
      assert.ok(alt.length > 0, `${page} image missing alt: ${src}`);
      if (src.startsWith('http')) continue;
      const file = path.join(root, src);
      assert.equal(fs.existsSync(file), true, `${page} broken image ${src}`);
      if (src.includes('assets/blog/')) {
        const kb = fs.statSync(file).size / 1024;
        assert.ok(kb < 250, `${src} is ${kb.toFixed(1)}KB — too large for blog`);
      }
    }
  }
});

test('sitemap lists guides with lastmod so Google can recrawl the hub', () => {
  const sitemap = read('sitemap.xml');
  const robots = read('robots.txt');
  assert.doesNotMatch(robots, /Disallow: \/blog/);
  for (const slug of GUIDE_PAGES) {
    const block = sitemap.split('<url>').find((chunk) => chunk.includes(slug));
    assert.ok(block, `missing sitemap url ${slug}`);
    assert.match(block, /<lastmod>2026-08-30<\/lastmod>/);
  }
});

test('pretty URLs for guides are wired in netlify.toml', () => {
  const toml = read('netlify.toml');
  assert.match(toml, /from = "\/blog"/);
  assert.match(toml, /to = "\/blog\.html"/);
  assert.match(toml, /from = "\/detailing-vs-car-wash"/);
  assert.match(toml, /from = "\/how-often-to-detail"/);
  assert.match(toml, /from = "\/mobile-detailing-what-to-expect"/);
});

test('guide search script is wired to cards, FAQ, and filter chips', () => {
  const js = read('assets/blog.js');
  assert.match(js, /getElementById\('guide-search'\)/);
  assert.match(js, /\[data-guide-card\]/);
  assert.match(js, /\[data-guide-faq\] details/);
  assert.match(js, /data-guide-filter/);
  assert.match(js, /\.hidden/);
  assert.match(js, /URLSearchParams/);
  assert.match(js, /params\.get\('q'\)/);
});
