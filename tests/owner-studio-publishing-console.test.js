'use strict';

/**
 * Stage 6 — Publishing module in the console.
 *
 * The page is the only Owner Studio screen that can change which catalog the site
 * would serve, so these tests are mostly about what it refuses to do.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const page = read('admin-owner-studio-publishing.html');
const overview = read('admin-owner-studio.html');
const catalog = read('admin-owner-studio-catalog.html');
const toml = read('netlify.toml');

describe('the page is reachable and gated like every Owner Studio surface', () => {
  it('is routed and never indexed', () => {
    assert.match(toml, /from = "\/admin\/owner-studio\/publishing"/);
    assert.match(toml, /to = "\/admin-owner-studio-publishing\.html"/);
    assert.match(page, /name="robots" content="noindex,nofollow"/);
  });

  it('is served no-store, like the other admin pages', () => {
    assert.match(toml, /for = "\/admin-owner-studio-publishing\.html"[\s\S]{0,120}no-store/);
  });

  it('loads the session gate after the session client', () => {
    const client = page.indexOf('/netlify/lib/admin-session-client.js');
    const gate = page.indexOf('/assets/owner-studio/session-gate.js');
    assert.ok(client !== -1 && gate !== -1 && client < gate);
  });

  it('reuses the shared design system rather than its own styles', () => {
    assert.match(page, /rel="stylesheet" href="\/assets\/owner-studio\/studio\.css"/);
    assert.doesNotMatch(page, /<style>/);
  });
});

describe('publish is inert until the environment allows it', () => {
  it('ships the publish button disabled', () => {
    assert.match(page, /<button type="button" id="btn-publish" disabled>/);
  });

  /**
   * The button is only ever enabled from the API's own publishEnabled field. The page
   * never infers permission from anything it can see locally.
   */
  it('derives the enabled state solely from the API response', () => {
    assert.match(page, /state\.publishEnabled = !!data\.publishEnabled;/);
    assert.match(page, /btn\.disabled = !state\.publishEnabled \|\| state\.busy;/);
  });

  it('explains the switch instead of printing the error code', () => {
    assert.match(page, /publication_not_enabled/);
    assert.match(page, /OWNER_STUDIO_PUBLISH_ENABLED=true/);
  });

  it('offers no rollback control on rows while publishing is off', () => {
    assert.match(page, /r\.current \|\| !state\.publishEnabled/);
  });
});

describe('mutations carry the same proof the API demands', () => {
  it('sends a CSRF token with every mutation', () => {
    assert.match(page, /'x-csrf-token': csrf/);
    assert.match(page, /async function ensureCsrf\(/);
  });

  it('sends credentials so a cookie-authenticated tab works', () => {
    assert.match(page, /credentials: 'same-origin'/);
  });

  it('requires an explicitly typed draft version before publishing', () => {
    assert.match(page, /Number\.isInteger\(version\) && version >= 1|!Number\.isInteger\(version\) \|\| version < 1/);
    assert.match(page, /expectedDraftVersion: version/);
  });

  it('surfaces the actual version on a stale-draft conflict', () => {
    assert.match(page, /data\.actualVersion/);
  });

  /**
   * Asymmetric on purpose. Publishing is reached by typing a version into a field;
   * rollback is one click on a row, so it asks first.
   */
  it('confirms rollback but not publish', () => {
    const rollback = page.match(/function rollback\(releaseId\)[\s\S]*?\n  \}/);
    assert.ok(rollback, 'rollback not found');
    assert.match(rollback[0], /window\.confirm\(/);
    const publish = page.match(/function publish\(\)[\s\S]*?\n  \}/);
    assert.ok(publish, 'publish not found');
    assert.doesNotMatch(publish[0], /window\.confirm\(/);
  });

  it('never claims the public site changed on a successful publish', () => {
    assert.match(page, /public site is unchanged until PUBLIC_CONTENT_SOURCE=owner-studio/);
  });
});

describe('navigation reflects that Publishing now exists', () => {
  it('is listed as available on the Overview, not planned', () => {
    assert.match(overview, /<li class="module available">[\s\S]{0,200}<h3>Publishing<\/h3>/);
    assert.match(overview, /href="\/admin\/owner-studio\/publishing"/);
  });

  it('is reachable from the Catalog Manager rail', () => {
    assert.match(catalog, /href="\/admin\/owner-studio\/publishing"/);
  });

  it('renders untrusted release fields through an escaper', () => {
    assert.match(page, /function esc\(s\)/);
    assert.match(page, /esc\(r\.releaseId\)/);
    assert.match(page, /esc\(r\.publishedBy/);
  });
});
