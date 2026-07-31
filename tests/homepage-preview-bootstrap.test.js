'use strict';

/**
 * Stage 4B-2 — homepage saved-draft preview bootstrap + booking-safety + button.
 * Content assertions over the shipped index.html and admin-owner-studio-catalog.html
 * (no DOM runtime); price mapping is covered by owner-studio-storefront-adapter.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const index = read('index.html');
const catalog = read('admin-owner-studio-catalog.html');
const adapterSrc = read('netlify/lib/owner-studio/storefront-preview-adapter.js');

// Isolate the preview bootstrap region for order-sensitive checks.
const boot = index.slice(index.indexOf('async function osBootstrapPreview'), index.indexOf('if(osPreviewRequested())'));

describe('homepage preview bootstrap (4B-2)', () => {
  it('1. normal homepage makes no preview API request (fetch only inside the gated bootstrap)', () => {
    // Exactly one reference to the preview endpoint, and it lives inside osBootstrapPreview.
    const hits = index.match(/owner-studio-catalog-preview/g) || [];
    assert.equal(hits.length, 1);
    assert.match(boot, /fetch\('\/\.netlify\/functions\/owner-studio-catalog-preview'/);
    // The dispatcher only calls the bootstrap when the flag is present.
    assert.match(index, /if\(osPreviewRequested\(\)\)\{\s*osBootstrapPreview\(\);\s*\}\s*else\s*\{\s*osRunBookingPricingInit\(\);\s*\}/);
  });

  it('2. normal homepage keeps existing booking init (renderHomeAddons/_updateHomeFromPrices/updateBkFromPrices)', () => {
    assert.match(index, /function osRunBookingPricingInit\(\)\{[\s\S]*renderHomeAddons\(\);[\s\S]*_updateHomeFromPrices\(\);[\s\S]*updateBkFromPrices\(\);/);
  });

  it('3. preview flag triggers exactly one authenticated same-origin fetch', () => {
    assert.match(boot, /credentials:\s*'same-origin'/);
    assert.equal((boot.match(/fetch\(/g) || []).length, 1);
  });

  it('4/5/6. preview replaces PRICING/LENGTH_PRICING BEFORE pricing init; requires preview===true; no legacy/draft mix', () => {
    // PRICING reassigned from the adapter output, then init runs.
    const iAssign = boot.indexOf('PRICING=osApplyPreviewShell');
    const iInit = boot.indexOf('osRunBookingPricingInit()');
    assert.ok(iAssign > 0 && iInit > iAssign, 'PRICING must be replaced before init');
    assert.match(boot, /data\.preview!==true/);
    assert.match(boot, /LENGTH_PRICING=adapted\.LENGTH_PRICING/);
    // PRICING/LENGTH_PRICING are reassignable (let), never overlaid legacy+draft.
    assert.match(index, /let PRICING = \{/);
    assert.match(index, /let LENGTH_PRICING = \{/);
  });

  it('11. an unavailable preview never presents legacy prices as the draft, and disables booking', () => {
    assert.match(index, /function osPreviewFail\(\)\{[\s\S]*NOT the saved draft[\s\S]*osDisableBookingButtons\(\);/);
    // Failure path does NOT initialize a bookable pricing flow.
    const fail = index.slice(index.indexOf('function osPreviewFail'), index.indexOf('async function osBootstrapPreview'));
    assert.doesNotMatch(fail, /osRunBookingPricingInit\(\)/);
    // Provides a same-origin Admin/Catalog Manager link.
    assert.match(index, /window\.location\.origin\+'\/admin\/owner-studio\/catalog'/);
  });

  it('12/13. draft-preview banner is shown with draft version + saved timestamp', () => {
    assert.match(boot, /DRAFT PREVIEW — NOT PUBLISHED/);
    assert.match(boot, /draft v'\+adapted\.meta\.draftVersion/);
    assert.match(boot, /saved '\+String\(adapted\.meta\.savedAt\)/);
    assert.match(boot, /Preview mode — bookings and payments are disabled/);
  });

  it('14. booking submission is blocked in preview at the authoritative entry point', () => {
    assert.match(index, /async function submitBooking\(\)\{\s*if\(OS_PREVIEW_ACTIVE\)\{[^}]*return;/);
  });

  it('15. setup-intent / payment entry points are blocked in preview', () => {
    assert.match(index, /async function confirmSetupIntent\(\)\{\s*if\(OS_PREVIEW_ACTIVE\)\{[^}]*return;/);
    assert.match(index, /async function initCardOnFile\(\)\{\s*if\(OS_PREVIEW_ACTIVE\)\{ return; \}/);
    assert.match(index, /stripe-auth-btn/); // disabled by osDisableBookingButtons signature match
    assert.match(index, /function osDisableBookingButtons\(\)[\s\S]*confirmSetupIntent\|initCardOnFile\|stripe-auth-btn/);
  });

  it('preview fails closed (OS_PREVIEW_ACTIVE set true up-front and on failure)', () => {
    assert.match(boot, /OS_PREVIEW_ACTIVE=true;/);
    assert.match(index, /function osPreviewFail\(\)\{\s*OS_PREVIEW_ACTIVE=true;/);
  });

  it('loads the pure adapter as a browser script and uses window.StorefrontPreviewAdapter', () => {
    assert.match(index, /<script src="\/netlify\/lib\/owner-studio\/storefront-preview-adapter\.js"><\/script>/);
    assert.match(boot, /window\.StorefrontPreviewAdapter\.adaptStorefrontPreview\(data\)/);
    assert.match(adapterSrc, /window\.StorefrontPreviewAdapter\s*=/);
  });
});

describe('Catalog Manager "Preview saved draft on website" button (4B-2)', () => {
  it('button exists in the action bar', () => {
    assert.match(catalog, /id="btn-preview-site"[^>]*>Preview saved draft on website<\/button>/);
  });

  it('16/17. disabled while dirty or while an add-on buffer is unapplied (hasPendingWork)', () => {
    assert.match(catalog, /const canPreview = !!state\.draft && !!state\.baselineDraft && !hasPendingWork\(\)/);
    // hasPendingWork is dirty OR unapplied add-on buffer.
    assert.match(catalog, /return !!\(state\.dirty \|\| hasUnappliedAddonChanges\(\)\)/);
    assert.match(catalog, /Save or discard your draft changes before opening storefront preview\./);
  });

  it('only available after a saved draft has loaded', () => {
    assert.match(catalog, /const canPreview = !!state\.draft && !!state\.baselineDraft/);
    assert.match(catalog, /<button type="button" class="secondary" id="btn-preview-site" disabled/);
  });

  it('18/19. opens the same-origin storefront with ?os_preview=1 in a new tab, no secret in the URL', () => {
    assert.match(catalog, /window\.open\(window\.location\.origin \+ '\/\?os_preview=1', '_blank', 'noopener'\)/);
    // The opened URL carries only the flag — no token/key/secret query params.
    const opener = catalog.slice(catalog.indexOf("id=\"btn-preview-site\"") );
    assert.doesNotMatch(catalog, /os_preview=1[^'"]*(token|adminKey|x-admin-key|secret|csrf)=/i);
  });
});
