'use strict';

/**
 * One verb, one behaviour.
 *
 * The Admin drawer had two controls labelled Edit: "Edit details" in the sticky
 * summary (#dEnableEdit), which unlocked the fields, and "Edit" in the sticky
 * footer (#dStickyEdit), which only scrolled. Operators reported "I click Edit
 * and it does not edit" — they were clicking the one that never unlocked.
 *
 * Locked controls also carried opacity .85 and no cursor change, so they read
 * as ordinary inputs that silently swallowed clicks.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const js = read('assets/admin-ops.js');
const css = read('assets/admin-ops.css');

describe('Admin edit mode — a single unlock', () => {
  it('exposes one shared unlock function', () => {
    assert.match(js, /function enableApptEditMode\(\)/);
  });

  it('both Edit controls call it', () => {
    // "Edit details" in the sticky summary
    assert.match(js, /\$\('#dEnableEdit'\)[\s\S]{0,200}?enableApptEditMode\(\)/);
    // "Edit" in the sticky footer unlocks first, then scrolls to the fields it
    // just unlocked. Previously it only scrolled.
    assert.match(
      js,
      /enableApptEditMode\(\);\s*\n\s*const target = \$\('#dSaveCustomer'\) \|\| \$\('#dSaveService'\) \|\| \$\('#dBody'\);/
    );
    assert.equal((js.match(/enableApptEditMode\(\)/g) || []).length, 3,
      'one declaration + one call per Edit control');
  });

  it('the unlock stays local — it must never refresh or clear selection', () => {
    const fn = js.slice(js.indexOf('function enableApptEditMode()'));
    const body = fn.slice(0, fn.indexOf('\n  }') + 4);
    assert.doesNotMatch(body, /refreshAll\(/, 'unlock must not trigger a refresh');
    assert.doesNotMatch(body, /loadJobs\(|jobs\s*=\s*\[\]/, 'unlock must not clear the job list');
    assert.match(body, /editShouldTriggerRefreshAll/, 'source-state guard is still honoured');
    assert.match(body, /data-edit-enabled/, 'fields are opted in to editing');
  });

  it('re-entry is a no-op rather than a second toast', () => {
    const fn = js.slice(js.indexOf('function enableApptEditMode()'));
    assert.match(fn.slice(0, 800), /classList\.contains\('appt-edit-mode'\)/);
  });
});

describe('Admin edit mode — the locked state is legible', () => {
  it('locked fields look locked, not merely dimmed', () => {
    const rule = css.slice(css.indexOf('.appt-readonly input:not([data-edit-enabled])'));
    const block = rule.slice(0, rule.indexOf('}') + 1);
    assert.match(block, /pointer-events:none/);
    assert.match(block, /cursor:not-allowed/);
    assert.match(block, /border-style:dashed/);
    assert.doesNotMatch(block, /opacity:\.85/, 'opacity .85 read as an ordinary control');
  });

  it('the workspace states once that it is locked, and hides that in edit mode', () => {
    assert.match(js, /class="appt-lock-hint"/);
    assert.match(js, /Use <strong>Edit<\/strong> to change this job/);
    assert.match(css, /\.appt-readonly \.appt-lock-hint\{display:flex\}/);
    assert.match(css, /\.appt-edit-mode \.appt-lock-hint\{display:none\}/);
  });
});
