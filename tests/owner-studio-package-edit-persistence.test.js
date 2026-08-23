'use strict';

/**
 * Regression: a package price edit that cannot be applied must never be saved away.
 *
 * saveDraft auto-commits the open package editor so an operator who types a price and
 * clicks Save Draft does not lose it. But it ignored applyPackageEdits' outcome, and
 * applyPackageEdits bails without applying when any price field is invalid. The two
 * together meant: type a price, click Save, see "Saved", and the draft was persisted
 * WITHOUT the edit — the exact silent data loss the auto-commit comment promises to
 * prevent. Observed on staging: draft advanced v34 → v35 with zero price changes.
 *
 * Add-ons already had this protection (hasUnappliedAddonChanges blocks the save);
 * packages did not.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin-owner-studio-catalog.html'), 'utf8');

/** Extract a whole function body by counting braces — a lazy regex stops at the
 *  first nested block and silently returns a fragment, which would let these
 *  assertions pass or fail for the wrong reason. */
function fn(name) {
  const start = html.search(new RegExp('function ' + name + '\\s*\\('));
  assert.notEqual(start, -1, name + ' not found');
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  assert.fail(name + ' has no closing brace');
  return '';
}

describe('applyPackageEdits reports whether it committed', () => {
  const body = fn('applyPackageEdits');

  it('returns false when there is no selected package', () => {
    assert.match(body, /if \(!p\) return false;/);
  });

  it('returns false when a price field is invalid', () => {
    assert.match(body, /Fix the highlighted price fields before applying\.[\s\S]{0,120}return false;/);
  });

  it('returns true only after the edits are written into the draft', () => {
    assert.match(body, /p\.prices = flat\.concat\(nonFlat\);[\s\S]*?return true;/);
  });

  it('never returns a bare undefined, which a caller would read as failure by accident', () => {
    assert.doesNotMatch(body, /\n\s*return;\s*\n/);
  });
});

describe('saveDraft refuses rather than persisting a draft missing the edit', () => {
  const body = fn('saveDraft');

  it('checks the auto-commit result instead of discarding it', () => {
    assert.match(body, /!applyPackageEdits\(\)/);
    assert.doesNotMatch(body, /el\('editor'\)\.hidden\) applyPackageEdits\(\);/,
      'the fire-and-forget call is what caused the silent loss');
  });

  it('stops the save and says what to fix', () => {
    const guard = body.match(/if \(state\.selectedId && !el\('editor'\)\.hidden && !applyPackageEdits\(\)\) \{[\s\S]*?\n      \}/);
    assert.ok(guard, 'auto-commit guard not found');
    assert.match(guard[0], /return;/, 'must abort the save');
    assert.match(guard[0], /Fix the highlighted price fields/);
  });

  it('keeps the pre-existing add-on buffer block, which had the right policy already', () => {
    assert.match(body, /hasUnappliedAddonChanges\(\)/);
    assert.match(body, /blockForUnappliedAddonBuffer\(\)/);
  });

  /** Order matters: the package guard must run before anything is sent to the server. */
  it('runs both guards before the network call', () => {
    const pkgAt = body.indexOf('!applyPackageEdits()');
    const addonAt = body.indexOf('hasUnappliedAddonChanges()');
    const fetchAt = body.search(/fetch\(|api\(/);
    assert.ok(pkgAt > -1 && addonAt > -1);
    if (fetchAt > -1) {
      assert.ok(pkgAt < fetchAt, 'package guard must precede the save request');
      assert.ok(addonAt < fetchAt, 'add-on guard must precede the save request');
    }
  });
});
