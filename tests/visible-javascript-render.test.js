/**
 * Public HTML must never render JavaScript source as visible page text.
 *
 * The city-page footer leak was a String.replace $' splice: chat INTENTS contain
 * dollar','$'], and a string replacement treated $' as "everything after the
 * match", which inserted </html> into the script and dumped the rest of the
 * chat widget as a body text node after the footer.
 *
 * JavaScript may exist inside <script> elements. It must not exist as
 * unintended visible text, and it must not sit after the first </html>.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const root = path.resolve(__dirname, '..');

const PUBLIC_HTML = fs.readdirSync(root).filter((f) => f.endsWith('.html'));

const CITY_FAMILY = [
  'template-city.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
];

const HUB_FAMILY = [
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
];

const LEAKED_JS_IN_VISIBLE_TEXT = [
  /fn:\s*\(\)\s*=>\s*\(\s*\{/,
  /function\s+cdLocalAnswer\s*\(/,
  /reply:chatStartingPricesReply\s*\(/,
  /window\.cdSubmitHandoff\s*=/,
  /const INTENTS\s*=/,
];

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function scriptOpenCloseCount(html) {
  const opens = html.match(/<script\b/gi) || [];
  const closes = html.match(/<\/script>/gi) || [];
  return { opens: opens.length, closes: closes.length };
}

function stripNonVisibleMarkup(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function visibleTextNodes(html) {
  if (JSDOM) {
    const dom = new JSDOM(html);
    const { document, NodeFilter } = dom.window;
    if (!document.body) return [];
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (el.closest('script, style, noscript, template')) return NodeFilter.FILTER_REJECT;
        if (!String(node.textContent || '').trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let current = walker.nextNode();
    while (current) {
      nodes.push(String(current.textContent));
      current = walker.nextNode();
    }
    return nodes;
  }
  return [stripNonVisibleMarkup(html)];
}

test('String.replace $\' interpolates document remainder — generators must not do that', () => {
  const source = "HEAD NEEDLE </body>\n</html>\n";
  const payload = "dollar','$'], fn:()=>({ reply:chatStartingPricesReply() })";
  const unsafe = source.replace('NEEDLE', payload);
  const safe = source.replace('NEEDLE', () => payload);
  assert.match(unsafe, /<\/html>\s*\], fn:/, 'the historical failure mode: $\' splices </html> into the replacement');
  assert.doesNotMatch(safe, /<\/html>\s*\], fn:/);
  assert.match(safe, /dollar','\$'\], fn:\(\)=>\(\{/);
  assert.equal(safe.toLowerCase().split('</html>').length - 1, 1);
});

test('generate-hub-pages uses function replacement so $ in JS is literal', () => {
  const src = read('scripts/generate-hub-pages.js');
  assert.match(src, /html\.replace\(from, \(\) => to\)/);
  assert.match(src, /dollar','\$'\]/);
});

test('booking conversion sync uses function replacement for HTML splices', () => {
  const src = read('scripts/sync-booking-conversion-pages.js');
  assert.match(src, /html\.replace\(existing, \(\) => canonicalBlock\)/);
  assert.match(src, /replace\('<\/body>', \(\) => `/);
});

for (const page of PUBLIC_HTML) {
  test(`${page} has a single document end and no JS after </html>`, () => {
    const html = read(page);
    const low = html.toLowerCase();
    const first = low.indexOf('</html>');
    assert.notEqual(first, -1, `${page} missing </html>`);
    const after = html.slice(first + 7).trim();
    assert.equal(after, '', `${page} has ${after.length} chars after </html>: ${JSON.stringify(after.slice(0, 80))}`);
    assert.equal(low.split('</html>').length - 1, 1, `${page} has duplicate </html>`);
    assert.ok((low.split('</body>').length - 1) <= 1, `${page} has duplicate </body>`);
    const { opens, closes } = scriptOpenCloseCount(html);
    assert.equal(opens, closes, `${page} script tag mismatch open=${opens} close=${closes}`);
    assert.doesNotMatch(html, /dollar','\[\{label/, `${page} still has the truncated chat price intent`);
    assert.doesNotMatch(html, /<\/html>\s*\], fn:/, `${page} still has the $' splice marker`);
  });
}

for (const page of [...CITY_FAMILY, ...HUB_FAMILY, 'index.html']) {
  test(`${page} chat price intent stays inside a script element`, () => {
    const html = read(page);
    assert.match(html, /dollar','\$'\], fn:\(\)=>\(\{/);
    assert.match(html, /reply:chatStartingPricesReply\(\)/);
    const idx = html.indexOf("dollar','$'], fn:()=>({");
    const lastScriptOpen = html.lastIndexOf('<script', idx);
    const lastScriptClose = html.lastIndexOf('</script>', idx);
    assert.ok(lastScriptOpen > lastScriptClose, `${page} price intent is not inside a script`);
  });
}

test('jsdom visible body text does not contain leaked chat/booking JavaScript', () => {
  const representative = [
    ...CITY_FAMILY,
    'hudson-county-hub.html',
    'bergen-county-hub.html',
    'essex-county-hub.html',
    'new-jersey-hub.html',
    'index.html',
  ];
  for (const page of representative) {
    const html = read(page);
    const visible = [...visibleTextNodes(html), stripNonVisibleMarkup(html)].join('\n');
    for (const pattern of LEAKED_JS_IN_VISIBLE_TEXT) {
      assert.doesNotMatch(
        visible,
        pattern,
        `${page} visible text matches ${pattern}: ${visible.match(pattern)?.[0] || ''}`,
      );
    }
  }
});
