'use strict';

/**
 * Cars (and powersports) size chips stay hidden while make/model can classify.
 * Chips appear only when confirmation is required.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail(`unclosed function ${name}`);
}

test('make/model search appears before size chips in the vehicle step', () => {
  const makeIdx = index.indexOf('id="make-search-wrap"');
  const chipsIdx = index.indexOf('id="tier-chips-wrap"');
  assert.ok(makeIdx > 0 && chipsIdx > 0);
  assert.ok(makeIdx < chipsIdx, 'make/model should come before size chips');
});

test('syncTierChipsVisibility hides car chips unless classNeedsConfirm', () => {
  const fn = extractFunction(index, 'syncTierChipsVisibility');
  assert.match(fn, /ST\.cat==='cars'/);
  assert.match(fn, /ST\.classNeedsConfirm/);
  assert.match(fn, /wrap\.style\.display=show\?'block':'none'/);
});

test('renderTierChips does not force-show chips for cars', () => {
  const fn = extractFunction(index, 'renderTierChips');
  assert.doesNotMatch(
    fn,
    /else\{\s*document\.getElementById\('tier-chips-wrap'\)\.style\.display='block'/
  );
  assert.match(fn, /syncTierChipsVisibility\(\)/);
});

test('year selection shows chips only on classification failure', () => {
  const start = index.indexOf("getElementById('year-sel').addEventListener");
  assert.ok(start > 0);
  const chunk = index.slice(start, start + 2200);
  assert.match(chunk, /ST\.classNeedsConfirm=false/);
  assert.match(chunk, /ST\.classNeedsConfirm=true/);
  assert.equal((chunk.match(/syncTierChipsVisibility\(\)/g) || []).length >= 2, true);
  assert.match(chunk, /Vehicle size needs confirmation/);
});

test('manual selectTier clears confirm flag and re-syncs chip visibility', () => {
  const fn = extractFunction(index, 'selectTier');
  assert.match(fn, /ST\.classNeedsConfirm=false/);
  assert.match(fn, /syncTierChipsVisibility\(\)/);
});
