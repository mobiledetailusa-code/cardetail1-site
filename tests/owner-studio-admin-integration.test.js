'use strict';

/**
 * Owner Studio Stage 2 — Admin navigation integration + add-on UX redesign.
 * These are content-level assertions over the shipped HTML (no DOM runtime in CI),
 * asserting the required information architecture and controls are present.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('Owner Studio is a first-class Admin navigation destination', () => {
  it('admin-ops portal links to Owner Studio via the canonical route', () => {
    const html = read('admin-ops.html');
    assert.match(html, /href="\/admin\/owner-studio"/);
    assert.match(html, /id="ownerStudioLink"/);
    assert.match(html, />Owner Studio</);
  });

  it('the Admin portal is auth-gated, so the link is hidden from unauthorized users', () => {
    const html = read('admin-ops.html');
    // Whole portal redirects unauthenticated visitors to the login page.
    assert.match(html, /ensureAdminSession/);
    assert.match(html, /location\.replace\('admin\.html'\)/);
  });

  it('the canonical routes are declared in netlify.toml', () => {
    const toml = read('netlify.toml');
    assert.match(toml, /from = "\/admin\/owner-studio"/);
    assert.match(toml, /from = "\/admin\/owner-studio\/catalog"/);
  });

  it('Owner Studio hub exposes only working modules and no dead nav anchors', () => {
    const html = read('admin-owner-studio.html');
    // Catalog Manager is navigable.
    assert.match(html, /href="\/admin\/owner-studio\/catalog"/);
    // Back to the Admin portal exists.
    assert.match(html, /href="\/admin"/);
    // The previous dead anchor links (#pages/#media/#navigation/#footer/#releases)
    // must not appear as navigable hrefs.
    assert.doesNotMatch(html, /href="#pages"/);
    assert.doesNotMatch(html, /href="#media"/);
    assert.doesNotMatch(html, /href="#navigation"/);
    assert.doesNotMatch(html, /href="#footer"/);
    assert.doesNotMatch(html, /href="#releases"/);
  });

  it('Owner Studio hub shows planned modules as non-navigable roadmap items', () => {
    const html = read('admin-owner-studio.html');
    assert.match(html, /Control-plane modules/);
    assert.match(html, /class="module available"/);
    assert.match(html, /Pricing &amp; Travel/);
    assert.match(html, /Publishing/);
    assert.match(html, /Not yet available/);
  });
});

describe('Add-on management is searchable, filterable and collapsed by default', () => {
  const html = read('admin-owner-studio-catalog.html');

  it('provides a search field over add-ons', () => {
    assert.match(html, /id="addon-search"/);
    assert.match(html, /Name, ID, category, or description/);
  });

  it('provides status, category and flag filters', () => {
    assert.match(html, /id="addon-filter-status"/);
    assert.match(html, /id="addon-filter-cat"/);
    assert.match(html, /id="addon-filter-flag"/);
    assert.match(html, /value="conflicts"/);
    assert.match(html, /value="missing-price"/);
    assert.match(html, /value="unsaved"/);
  });

  it('provides expand-all, collapse-all and clear-search controls', () => {
    assert.match(html, /id="addon-expand-all"/);
    assert.match(html, /id="addon-collapse-all"/);
    assert.match(html, /id="addon-clear-search"/);
  });

  it('shows a visible result count', () => {
    assert.match(html, /id="addon-count"/);
    assert.match(html, /Showing \$\{rows\.length\} of \$\{total\} add-ons/);
  });

  it('renders collapsed accordion rows, not an always-expanded table', () => {
    assert.match(html, /'addon-row'/);
    assert.match(html, /addon-summary/);
    assert.match(html, /setAttribute\('aria-expanded'/);
    // Default collapsed: expansion is driven by an explicit expanded set.
    assert.match(html, /state\.addonExpanded\.has\(a\.addOnId\)/);
    // Editors are lazily built only when a row is expanded.
    assert.match(html, /lazy: only build when open/);
    // The old always-expanded add-on edit table is gone.
    assert.doesNotMatch(html, /Apply add-on changes/);
  });

  it('tracks and surfaces per-item unsaved changes without silently discarding', () => {
    assert.match(html, /addonDirty/);
    assert.match(html, /markAddonDirty/);
    assert.match(html, /unsaved</);
    // Live-apply on edit so collapsing never drops an entered value.
    assert.match(html, /Live-apply so edits are never silently discarded/);
  });

  it('auto-commits the open package editor before saving', () => {
    assert.match(html, /Auto-commit any pending edits in the open package editor/);
    assert.match(html, /if \(state\.selectedId && !el\('editor'\)\.hidden\) applyPackageEdits\(\);/);
  });
});
