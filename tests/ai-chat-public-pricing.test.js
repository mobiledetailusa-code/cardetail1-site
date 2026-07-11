/**
 * Server-side AI chat public pricing alignment tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function extractBusinessSystem(source) {
  const m = source.match(/const BUSINESS_SYSTEM = `([\s\S]*?)`;/);
  assert.ok(m, 'BUSINESS_SYSTEM prompt missing');
  return m[1];
}

function extractPricingGuidance(prompt) {
  const m = prompt.match(/PRICING:([^\n]+)/);
  assert.ok(m, 'PRICING guidance line missing');
  return m[1];
}

test('AI chat prompt does not describe general Cars detailing as starting at $175', () => {
  const prompt = extractBusinessSystem(read('netlify/functions/ai-chat.js'));
  const pricing = extractPricingGuidance(prompt);
  assert.doesNotMatch(pricing, /Cars[^$\n]*\$175|general[^$\n]*Cars[^$\n]*\$175/i);
  assert.doesNotMatch(prompt, /Cars \$175/);
});

test('AI chat prompt describes public Cars starting price as $225 Interior Detail', () => {
  const prompt = extractBusinessSystem(read('netlify/functions/ai-chat.js'));
  const pricing = extractPricingGuidance(prompt);
  assert.match(pricing, /\$225/);
  assert.match(pricing, /Interior Detail/i);
});

test('AI chat prompt treats Maintenance Detail as separate $175 tier not public Cars minimum', () => {
  const prompt = extractBusinessSystem(read('netlify/functions/ai-chat.js'));
  const pricing = extractPricingGuidance(prompt);
  assert.match(pricing, /Maintenance Detail[^$\n]*\$175|\$175[^$\n]*Maintenance Detail/i);
  assert.match(pricing, /not as the general Cars starting price|not.*general Cars starting price/i);
});

test('booking catalog still has maint at $175 and interior at $225', () => {
  const html = read('index.html');
  assert.match(html, /maint:175/);
  assert.match(html, /interior:225/);
  assert.match(html, /id:'maint'[\s\S]*?Maintenance Detail/);
  assert.match(html, /id:'interior'[\s\S]*?Interior Detail/);
});

test('client chat and server AI prompt agree on public category starting prices', () => {
  const index = read('index.html');
  const prompt = extractBusinessSystem(read('netlify/functions/ai-chat.js'));
  const pricing = extractPricingGuidance(prompt);

  assert.match(index, /function chatStartingPricesReply\(\)/);
  assert.match(index, /applyRichPrice\(b\.cars\)/);
  assert.doesNotMatch(index, /Cars & Trucks — from <b>\$175/);

  assert.match(pricing, /Boats from \$199/);
  assert.match(pricing, /\$349/);
  assert.match(pricing, /Powersports from \$119/);
  assert.match(pricing, /Fleet[^$\n]*quote-only|quote-only[^$\n]*Fleet/i);
  assert.doesNotMatch(pricing, /\$60\/unit|\$60 per unit/i);
});

test('ai-chat.js change is pricing guidance only with runtime logic intact', () => {
  const source = read('netlify/functions/ai-chat.js');
  assert.match(source, /exports\.handler = async \(event\) =>/);
  assert.match(source, /enforcePublicRateLimit/);
  assert.match(source, /ANTHROPIC_API_KEY/);
  assert.match(source, /system: BUSINESS_SYSTEM/);
  assert.doesNotMatch(source, /Cars \$175/);
});

test('only ai-chat.js differs among Netlify Functions since encoding correction', () => {
  const tracked = execSync('git diff --name-only 117484ee1bca78cb9b64a3827be8bef747ddd0ea -- netlify/functions', {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.equal(tracked, 'netlify/functions/ai-chat.js', `unexpected function diff: ${tracked || '(none)'}`);
});

test('ai-chat pricing correction does not change package IDs or pricing formulas', () => {
  const diff = execSync('git diff 117484ee1bca78cb9b64a3827be8bef747ddd0ea -- index.html', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(diff.trim(), '', 'index.html should be unchanged');
});

test('ai-chat source and tests contain no credential literals', () => {
  const files = ['netlify/functions/ai-chat.js', 'tests/ai-chat-public-pricing.test.js'];
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9_-]{10,}/);
    assert.doesNotMatch(text, /ANTHROPIC_API_KEY\s*=\s*['"][^'"]+['"]/);
  }
});
