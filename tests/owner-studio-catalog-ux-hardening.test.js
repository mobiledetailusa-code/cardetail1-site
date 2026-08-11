'use strict';

/**
 * Owner Studio — Catalog Manager UX hardening (Phase 2).
 *
 * Two complementary layers, both runnable under `node --test` with no DOM runtime:
 *   1. Pure logic unit tests against the shared, browser+node module
 *      (netlify/lib/owner-studio-catalog-ux-logic.js): strict price parser, canonical
 *      baseline / dirty diff, package search, canonical-response guard, safe rendering,
 *      and the page-state predicates.
 *   2. Behaviour-of-the-real-page tests: the inline `classifyFailure` is extracted from
 *      admin-owner-studio-catalog.html and executed (zero drift from shipped code), plus
 *      content assertions over the shipped HTML for the DOM-wired behaviours.
 *
 * These are additive — existing persistence / API-contract / multi-tab tests are untouched.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const Ux = require('../netlify/lib/owner-studio-catalog-ux-logic');
const catalogHtml = read('admin-owner-studio-catalog.html');
const adminOps = read('admin-ops.html');
const toml = read('netlify.toml');

// -- helpers -----------------------------------------------------------------
function extractInlineScript(html) {
  const m = html.match(/<script>\s*\(function \(\)[\s\S]*?\}\)\(\);\s*<\/script>/);
  assert.ok(m, 'inline catalog script not found');
  return m[0].replace(/<\/?script>/g, '');
}
// Brace-match a self-contained named function out of source and evaluate it in isolation.
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `function ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const inlineScript = extractInlineScript(catalogHtml);
// eslint-disable-next-line no-new-func
const classifyFailure = new Function(extractFunction(inlineScript, 'classifyFailure') + '\nreturn classifyFailure;')();
const resp = (status, data) => ({ status, headers: { get: () => '' } });

function sampleDraft() {
  return {
    siteId: 'cardetail1',
    version: 3,
    draftId: 'draft_x',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastSavedBy: 'owner',
    packages: [{
      packageId: 'pkg_full', category: 'cars', name: 'Full Detail', slug: 'full-detail',
      shortDescription: 'Full', description: 'Interior + exterior', active: true, featured: true, displayOrder: 0,
      features: [{ kind: 'included', label: 'Wash', sortOrder: 0 }],
      prices: [{ packageId: 'pkg_full', vehicleClassId: 'vc_sedan', currency: 'usd', amountCents: 28500, priceModel: 'flat' }],
      compatibleVehicleClassIds: ['vc_sedan'], compatibleAddOnIds: ['addon_pet'],
    }],
    addOns: [{
      addOnId: 'addon_pet', name: 'Pet Hair', slug: 'pet-hair', description: 'Pet hair removal',
      active: true, allowQuantity: false, displayOrder: 0,
      prices: [{ category: 'cars', currency: 'usd', amountCents: 4500 }], compatibility: [{ category: 'cars' }],
    }],
    vehicleClasses: [{ vehicleClassId: 'vc_sedan', legacyKey: 'small', category: 'cars', label: 'Sedan', active: true, displayOrder: 0 }],
    priceConflicts: [{ conflictId: 'c1', status: 'unresolved', resolution: null }],
  };
}

// ===========================================================================
describe('strict price parser (usdToCents replacement)', () => {
  const accept = [['0', 0], ['5', 500], ['5.5', 550], ['5.50', 550], ['125', 12500], ['125.99', 12599]];
  for (const [raw, cents] of accept) {
    it(`accepts "${raw}" -> ${cents} integer cents`, () => {
      const r = Ux.parsePriceToCents(raw);
      assert.equal(r.ok, true);
      assert.equal(r.cents, cents);
      assert.ok(Number.isInteger(r.cents), 'cents must be an integer (no floating dollars)');
    });
  }

  const reject = ['', '   ', '-5', '-0.01', 'abc', '5abc', '5.005', '5.', '.5', 'Infinity', 'NaN', '1e3', '1,250', '$5'];
  for (const raw of reject) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      const r = Ux.parsePriceToCents(raw);
      assert.equal(r.ok, false);
      assert.equal(r.cents, undefined, 'a rejected value must never yield cents (no coerced 0)');
    });
  }

  it('a negative value is rejected, never stripped and flipped positive', () => {
    const r = Ux.parsePriceToCents('-5');
    assert.equal(r.ok, false);
    assert.notEqual(r.cents, 500);
  });

  it('accepts values whose cents are Number.isSafeInteger and rejects unsafe cents', () => {
    // Commercial magnitudes (e.g. $1,000,000) remain valid — no UI business max.
    assert.equal(Ux.parsePriceToCents('1000000').ok, true);
    assert.equal(Ux.parsePriceToCents('1000000').cents, 100000000);
    // Exact safe-integer boundary in cents: Number.MAX_SAFE_INTEGER.
    const maxSafeDollars = '90071992547409.91';
    const atMax = Ux.parsePriceToCents(maxSafeDollars);
    assert.equal(atMax.ok, true);
    assert.equal(atMax.cents, Number.MAX_SAFE_INTEGER);
    assert.ok(Number.isSafeInteger(atMax.cents));
    const over = Ux.parsePriceToCents('90071992547409.92');
    assert.equal(over.ok, false);
    assert.equal(over.error, 'out_of_range');
    assert.equal(over.cents, undefined);
  });

  it('zero is valid by default but rejectable where the catalog forbids a free item', () => {
    assert.equal(Ux.parsePriceToCents('0').ok, true);
    assert.equal(Ux.parsePriceToCents('0', { allowZero: false }).ok, false);
  });

  it('every rejection maps to a field-level message', () => {
    for (const code of ['required', 'negative', 'invalid', 'out_of_range']) {
      assert.equal(typeof Ux.priceErrorMessage(code), 'string');
      assert.ok(Ux.priceErrorMessage(code).length > 0);
    }
    assert.match(Ux.priceErrorMessage('out_of_range'), /safe numeric representation/i);
    assert.doesNotMatch(Ux.priceErrorMessage('out_of_range'), /1[,.]?000[,.]?000/);
  });
});

// ===========================================================================
describe('canonical baseline & dirty detection', () => {
  it('is clean against its own deep clone', () => {
    const d = sampleDraft();
    assert.equal(Ux.isCatalogDirty(d, JSON.parse(JSON.stringify(d))), false);
  });

  it('a valid package price edit marks dirty; reverting to baseline returns clean', () => {
    const baseline = sampleDraft();
    const draft = JSON.parse(JSON.stringify(baseline));
    draft.packages[0].prices[0].amountCents = 30000;
    assert.equal(Ux.isCatalogDirty(draft, baseline), true);
    draft.packages[0].prices[0].amountCents = 28500; // revert
    assert.equal(Ux.isCatalogDirty(draft, baseline), false);
  });

  it('a valid add-on edit marks dirty; reverting returns clean', () => {
    const baseline = sampleDraft();
    const draft = JSON.parse(JSON.stringify(baseline));
    draft.addOns[0].prices[0].amountCents = 5500;
    assert.equal(Ux.isCatalogDirty(draft, baseline), true);
    draft.addOns[0].prices[0].amountCents = 4500;
    assert.equal(Ux.isCatalogDirty(draft, baseline), false);
  });

  it('server version bump / timestamps / transient UI fields alone are NOT dirty', () => {
    const draft = sampleDraft();
    const sig = Ux.editableCatalogSignature(draft);
    const churned = JSON.parse(JSON.stringify(draft));
    churned.version = 999;
    churned.updatedAt = '2027-01-01T00:00:00.000Z';
    churned.lastSavedBy = 'someone-else';
    churned.draftId = 'draft_other';
    churned._uiSearch = 'wax';         // transient UI, never part of the editable model
    churned._expanded = ['addon_pet'];
    assert.equal(Ux.editableCatalogSignature(churned), sig);
    assert.equal(Ux.isCatalogDirty(churned, draft), false);
  });

  it('array order of packages/prices does not create false dirty', () => {
    const draft = sampleDraft();
    draft.packages.push({
      packageId: 'pkg_maint', category: 'cars', name: 'Maintenance', slug: 'maint',
      shortDescription: '', description: '', active: true, featured: false, displayOrder: 1,
      features: [], prices: [], compatibleVehicleClassIds: [], compatibleAddOnIds: [],
    });
    const reordered = JSON.parse(JSON.stringify(draft));
    reordered.packages.reverse();
    assert.equal(Ux.isCatalogDirty(reordered, draft), false);
  });
});

// ===========================================================================
describe('package search parity', () => {
  const draft = sampleDraft();
  const ctx = { vehicleClasses: draft.vehicleClasses };
  const pkg = draft.packages[0];
  it('empty query matches everything', () => assert.equal(Ux.packageMatchesQuery(pkg, '', ctx), true));
  it('matches by name', () => assert.equal(Ux.packageMatchesQuery(pkg, 'full detail', ctx), true));
  it('matches by id', () => assert.equal(Ux.packageMatchesQuery(pkg, 'pkg_full', ctx), true));
  it('matches by description', () => assert.equal(Ux.packageMatchesQuery(pkg, 'exterior', ctx), true));
  it('matches by category', () => assert.equal(Ux.packageMatchesQuery(pkg, 'cars', ctx), true));
  it('matches by compatible vehicle class label', () => assert.equal(Ux.packageMatchesQuery(pkg, 'sedan', ctx), true));
  it('non-match returns false', () => assert.equal(Ux.packageMatchesQuery(pkg, 'motorcycle', ctx), false));
});

// ===========================================================================
describe('canonical response guard (malformed = failure)', () => {
  it('accepts a well-formed draft payload', () => {
    assert.equal(Ux.isCanonicalDraftResponse({ draft: { packages: [], addOns: [], vehicleClasses: [], version: 2 } }), true);
  });
  it('rejects malformed / partial payloads', () => {
    assert.equal(Ux.isCanonicalDraftResponse(null), false);
    assert.equal(Ux.isCanonicalDraftResponse({}), false);
    assert.equal(Ux.isCanonicalDraftResponse({ draft: null }), false);
    assert.equal(Ux.isCanonicalDraftResponse({ draft: {} }), false);
    assert.equal(Ux.isCanonicalDraftResponse({ draft: { packages: [], addOns: [], vehicleClasses: [] } }), false); // no version
    assert.equal(Ux.isCanonicalDraftResponse({ draft: { packages: 'x', addOns: [], vehicleClasses: [], version: 1 } }), false);
  });
});

// ===========================================================================
describe('safe rendering of catalog-controlled values', () => {
  it('a hostile category value renders inert (escaped), not as an element', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const out = Ux.escapeHtml(hostile);
    assert.doesNotMatch(out, /<img/);
    assert.match(out, /&lt;img/);
    assert.ok(!out.includes('<'), 'no raw < survives');
  });
  it('the package category <option> is rendered with escapeHtml on value AND label', () => {
    assert.match(catalogHtml, /<option value="\$\{escapeHtml\(c\)\}">\$\{escapeHtml\(c\)\}<\/option>/);
    // The pre-fix unescaped form must be gone.
    assert.doesNotMatch(catalogHtml, /<option value="\$\{c\}">\$\{c\}<\/option>/);
  });
});

// ===========================================================================
describe('page-state predicates forbid contradictory states', () => {
  it('Save is enabled only while dirty + valid + not-saving + editable', () => {
    assert.equal(Ux.isSaveEnabled({ state: 'ready-dirty', dirty: true, valid: true, saving: false }), true);
    assert.equal(Ux.isSaveEnabled({ state: 'ready-clean', dirty: false, valid: true, saving: false }), false);
    assert.equal(Ux.isSaveEnabled({ state: 'saving', dirty: true, valid: true, saving: true }), false);
    assert.equal(Ux.isSaveEnabled({ state: 'ready-dirty', dirty: true, valid: false, saving: false }), false);
    assert.equal(Ux.isSaveEnabled({ state: 'authentication-error', dirty: true, valid: true, saving: false }), false);
    assert.equal(Ux.isSaveEnabled({ state: 'authorization-error', dirty: true, valid: true, saving: false }), false);
  });
  it('flags impossible combinations', () => {
    assert.equal(Ux.isContradictoryModel({ state: 'saved', dirty: true }), true);        // Saved while dirty
    assert.equal(Ux.isContradictoryModel({ state: 'ready-clean', dirty: true }), true);   // clean while dirty
    assert.equal(Ux.isContradictoryModel({ state: 'ready-dirty', dirty: false }), true);
    assert.equal(Ux.isContradictoryModel({ state: 'saving', dirty: true, valid: true, saving: true }), false);
    assert.equal(Ux.isContradictoryModel({ state: 'ready-dirty', dirty: true, valid: true, saving: false }), false);
  });
  it('exposes the closed page-state set', () => {
    for (const s of ['loading', 'ready-clean', 'ready-dirty', 'saving', 'saved', 'validation-error',
      'authentication-error', 'authorization-error', 'network-error', 'catalog-unavailable', 'stale-conflict', 'rate-limit']) {
      assert.ok(Ux.PAGE_STATES.includes(s), `missing page state ${s}`);
    }
  });
});

// ===========================================================================
describe('classifyFailure (extracted from the shipped page) maps every mutation failure', () => {
  it('401 -> authentication-error (clears session)', () => {
    const f = classifyFailure(resp(401), {});
    assert.equal(f.state, 'authentication-error');
    assert.equal(f.authRequired, true);
  });
  it('403 -> authorization-error (keeps catalog)', () => {
    const f = classifyFailure(resp(403), {});
    assert.equal(f.state, 'authorization-error');
    assert.equal(f.authRequired, false);
  });
  it('409 stale_catalog_draft_version -> stale-conflict', () => {
    const f = classifyFailure(resp(409), { error: 'stale_catalog_draft_version', currentVersion: 7 });
    assert.equal(f.state, 'stale-conflict');
    assert.equal(f.stale, true);
    assert.equal(f.keepSession, true);
  });
  it('409 (unspecified) still surfaces stale-conflict but not the stale flag', () => {
    const f = classifyFailure(resp(409), {});
    assert.equal(f.state, 'stale-conflict');
    assert.equal(f.stale, false);
  });
  it('429 -> rate-limit (keeps session)', () => {
    const f = classifyFailure(resp(429), {});
    assert.equal(f.state, 'rate-limit');
    assert.equal(f.keepSession, true);
  });
  it('500 and 503 -> catalog-unavailable (keeps session)', () => {
    assert.equal(classifyFailure(resp(500), {}).state, 'catalog-unavailable');
    assert.equal(classifyFailure(resp(503), {}).state, 'catalog-unavailable');
    assert.equal(classifyFailure(resp(503), {}).keepSession, true);
  });
  it('400 -> validation-error (keeps edits)', () => {
    const f = classifyFailure(resp(400), { error: 'unsafe_content' });
    assert.equal(f.state, 'validation-error');
    assert.equal(f.authRequired, false);
  });
  it('network failure (status 0) -> network-error', () => {
    const f = classifyFailure(resp(0), { error: 'network_error' });
    assert.equal(f.state, 'network-error');
    assert.equal(f.network, true);
  });
  it('an unmapped status falls back to a non-empty failure, never a cleared session', () => {
    const f = classifyFailure(resp(418), {});
    assert.equal(f.authRequired, false);
    assert.ok(f.msg && f.msg.length > 0);
  });
  it('15. untrusted_origin is NOT an account-authorization denial (distinct message)', () => {
    const f = classifyFailure(resp(403), { error: 'untrusted_origin' });
    assert.equal(f.state, 'authorization-error');
    assert.equal(f.authRequired, false);
    assert.equal(f.keepSession, true);
    assert.doesNotMatch(f.msg, /not authorized for Owner Studio/i);
    assert.match(f.msg, /not approved for saving/i);
  });
  it('16. csrf_invalid / csrf_missing map to session-expired guidance', () => {
    for (const code of ['csrf_invalid', 'csrf_missing']) {
      const f = classifyFailure(resp(403), { error: code });
      assert.equal(f.state, 'authentication-error');
      assert.equal(f.authRequired, true);
      assert.match(f.msg, /session expired|Reload the page/i);
    }
  });
  it('17. a genuine Owner Studio authorization denial still shows the permission message', () => {
    const f = classifyFailure(resp(403), { error: 'owner_studio_edit_denied' });
    assert.equal(f.state, 'authorization-error');
    assert.match(f.msg, /not authorized for Owner Studio/i);
  });
  it('origin_required and owner_studio_disabled map to their own specific messages', () => {
    assert.match(classifyFailure(resp(403), { error: 'origin_required' }).msg, /origin could not be verified/i);
    assert.match(classifyFailure(resp(403), { error: 'owner_studio_disabled' }).msg, /disabled in this environment/i);
  });
});

// ===========================================================================
describe('admin-ops navigation integration', () => {
  it('adds exactly ONE Catalog Manager link to the canonical route', () => {
    const count = (adminOps.match(/href="\/admin\/owner-studio\/catalog"/g) || []).length;
    assert.equal(count, 1, 'exactly one Catalog Manager link');
    assert.match(adminOps, /id="catalogManagerLink"[^>]*>Catalog Manager<|>Catalog Manager<\/a>/);
  });
  it('preserves the existing Owner Studio link', () => {
    assert.match(adminOps, /id="ownerStudioLink"/);
    assert.match(adminOps, /href="\/admin\/owner-studio"[^>]*>Owner Studio</);
  });
  it('is same-tab and carries no credential in the URL', () => {
    const link = adminOps.match(/<a href="\/admin\/owner-studio\/catalog"[^>]*>/)[0];
    assert.doesNotMatch(link, /target=/);
    assert.doesNotMatch(link, /[?&](token|adminKey|x-admin-key|key)=/i);
  });
  it('the canonical route is declared in netlify.toml', () => {
    assert.match(toml, /from = "\/admin\/owner-studio\/catalog"/);
  });
  it('the Catalog Manager page marks its own catalog destination with aria-current="page"', () => {
    assert.match(catalogHtml, /href="\/admin\/owner-studio\/catalog" aria-current="page"/);
  });
});

// ===========================================================================
describe('shipped Catalog Manager page wires the hardened behaviours', () => {
  it('loads the shared UX logic module before the inline script', () => {
    const iSession = catalogHtml.indexOf('/netlify/lib/admin-session-client.js');
    const iModule = catalogHtml.indexOf('/netlify/lib/owner-studio-catalog-ux-logic.js');
    const iInline = catalogHtml.indexOf('window.CatalogUxLogic');
    assert.ok(iModule > iSession && iModule < iInline, 'module must load after session client, before inline use');
  });
  it('Save starts disabled (clean) and is gated by the state predicate', () => {
    assert.match(catalogHtml, /<button type="button" id="btn-save" disabled>/);
    assert.match(catalogHtml, /Ux\.isSaveEnabled\(/);
    assert.match(catalogHtml, /function updateSaveButton\(\)/);
  });
  it('guards duplicate save clicks and shows a saving state only while pending', () => {
    assert.match(catalogHtml, /if \(!state\.draft \|\| state\.saving\) return;/);
    assert.match(catalogHtml, /setPageState\('saving'\)/);
    assert.match(catalogHtml, /state\.saving = false;/);
  });
  it('a successful save replaces both draft and baseline and the version', () => {
    assert.match(catalogHtml, /state\.draft = data\.draft;[\s\S]{0,200}setBaseline\(\);/);
    assert.match(catalogHtml, /if \(!Ux\.isCanonicalDraftResponse\(data\)\)/);
  });
  it('a failed save preserves edits via classifyFailure and never clears a loaded draft (except auth)', () => {
    assert.match(catalogHtml, /reportMutationFailure\(res, data, 'Save failed'\)/);
    assert.match(catalogHtml, /if \(f\.authRequired\) \{ state\.draft = null/);
  });
  it('uses the strict parser at both price boundaries with field-level messages', () => {
    assert.match(catalogHtml, /Ux\.parsePriceToCents\(/);
    assert.match(catalogHtml, /data-price-err/);
    assert.doesNotMatch(catalogHtml, /function usdToCents/);
  });
  it('implements the 409 stale-conflict reload-latest workflow with confirmation', () => {
    assert.match(catalogHtml, /id="btn-reload-latest"/);
    assert.match(catalogHtml, /async function reloadLatest\(\)/);
    assert.match(catalogHtml, /Your unsaved local changes will be discarded/);
    assert.match(catalogHtml, /setBaseline\(\);[\s\S]{0,120}setPageState\('ready-clean'\)/);
  });
  it('warns on unload and on route navigation while dirty or unapplied buffer', () => {
    assert.match(catalogHtml, /addEventListener\('beforeunload'/);
    assert.match(catalogHtml, /if \(!hasPendingLocalEdits\(\)\) return;\s*\r?\n\s*e\.preventDefault\(\)/);
    assert.match(catalogHtml, /function guardRouteNavigation\(\)/);
    assert.match(catalogHtml, /unsaved catalog changes\. Leave this page/);
    assert.match(catalogHtml, /function hasPendingLocalEdits\(/);
  });
  it('the "Unsaved changes" badge is hidden while clean and shown only while genuinely dirty', () => {
    // Badge ships with the [hidden] attribute and is toggled purely through el('dirty').hidden.
    assert.match(catalogHtml, /<span id="dirty" class="badge warn" hidden>Unsaved changes<\/span>/);
    // Regression guard: .badge sets display:inline-block, which defeats the bare [hidden]
    // default. A .badge[hidden] rule (higher specificity) MUST restore display:none, else the
    // badge is stuck visible in every state — clean, saved and signed-out.
    assert.match(catalogHtml, /\.badge\[hidden\]\s*\{[^}]*display\s*:\s*none/);
    // Visible only when the real dirty flag is set …
    assert.match(catalogHtml, /el\('dirty'\)\.hidden = !state\.dirty;/);
    // … and force-hidden on authentication failure, so "Unsaved changes" never sits over a
    // signed-out page.
    assert.match(catalogHtml, /el\('dirty'\)\.hidden = true;\s*\n\s*el\('auth-note'\)\.hidden = false;/);
  });
  it('the page-state model forbids "Saved" and "Unsaved changes" appearing together', () => {
    assert.equal(Ux.isContradictoryModel({ state: 'saved', dirty: true }), true);   // Saved while dirty
    assert.equal(Ux.isContradictoryModel({ state: 'ready-clean', dirty: true }), true); // clean while dirty
    assert.equal(Ux.isContradictoryModel({ state: 'saved', dirty: false }), false);  // the only coherent "saved"
  });
  it('13. read-only lock disables package + add-on fields, apply, resolve, restore and Save', () => {
    assert.match(catalogHtml, /function applyMutationLock\(\)/);
    assert.match(catalogHtml, /#editor input, #editor textarea, #editor select, #editor button/);
    assert.match(catalogHtml, /#addon-list input, #addon-list textarea, #addon-list select, #addon-list button/);
    assert.match(catalogHtml, /#conflict-list button\[data-resolve\], #revision-list button\[data-restore\]/);
    assert.match(catalogHtml, /el\('btn-save'\)\.disabled = state\.mutationLocked \|\|/);
    assert.match(catalogHtml, /id="readonly-banner"/);
    // The verdict is read from the server capability payload, not invented client-side.
    assert.match(catalogHtml, /readCapabilities\(data\)/);
    assert.match(catalogHtml, /mo\.allowed === false/);
  });
  it('14. read-only keeps search, filters, accordions, preview and history usable', () => {
    const lock = catalogHtml.slice(
      catalogHtml.indexOf('function applyMutationLock()'),
      catalogHtml.indexOf('function readCapabilities(')
    );
    assert.ok(lock.length > 0, 'applyMutationLock body not found');
    // The lock targets only mutation regions — never read/navigation controls.
    assert.doesNotMatch(lock, /#search|#addon-search|#btn-preview|#btn-reload\b|f-status|f-category/);
    // Accordion summaries are explicitly re-enabled for read-only inspection.
    assert.match(lock, /#addon-list \.addon-summary/);
    assert.match(catalogHtml, /id="addon-search"/);
    assert.match(catalogHtml, /id="btn-preview"/);
  });
  it('ships a sticky Catalog action bar with version, status, Discard and Save', () => {
    assert.match(catalogHtml, /id="catalog-action-bar"/);
    assert.match(catalogHtml, /\.catalog-action-bar\s*\{[^}]*position:\s*sticky/);
    assert.match(catalogHtml, /id="bar-version"/);
    assert.match(catalogHtml, /id="bar-status"/);
    assert.match(catalogHtml, /id="btn-discard"/);
    assert.match(catalogHtml, /Discard draft changes/);
    assert.match(catalogHtml, /function discardDraftChanges\(\)/);
    assert.match(catalogHtml, /baselineDraft/);
  });
  it('add-on editor uses Apply/Cancel with a local edit buffer (no live draft mutation)', () => {
    assert.match(catalogHtml, /addonEditBuffers/);
    assert.match(catalogHtml, /Ux\.cloneAddonEditBuffer/);
    assert.match(catalogHtml, /Ux\.applyAddonBufferToDraft/);
    assert.match(catalogHtml, /Ux\.addonBufferHasUnappliedChanges/);
    assert.match(catalogHtml, /data-addon-apply/);
    assert.match(catalogHtml, /data-addon-cancel/);
    assert.match(catalogHtml, /Apply add-on changes/);
    assert.match(catalogHtml, /function applyAddonEdits\(/);
    assert.match(catalogHtml, /function cancelAddonEdits\(/);
    assert.match(catalogHtml, /function hasUnappliedAddonChanges\(/);
    assert.match(catalogHtml, /function blockForUnappliedAddonBuffer\(/);
    assert.match(catalogHtml, /function requestAddonExpand\(/);
    assert.match(catalogHtml, /Apply or cancel the open add-on changes before saving\./);
    assert.doesNotMatch(catalogHtml, /function flushOpenAddonEditors\(/);
    assert.doesNotMatch(catalogHtml, /a\.prices\[idx\]\.amountCents = parsed\.cents/);
    assert.match(catalogHtml, /buf\.prices\[idx\]\.rawUsd = inp\.value/);
    // Typing must never trigger a network save.
    assert.doesNotMatch(catalogHtml, /addEventListener\('input',\s*\(\)\s*=>\s*\{[^}]*saveDraft/);
  });
  it('package Apply / save auto-flush behaviour remains unchanged', () => {
    assert.match(catalogHtml, /id="btn-apply-pkg"/);
    assert.match(catalogHtml, /function applyPackageEdits\(\)/);
    assert.match(catalogHtml, /if \(state\.selectedId && !el\('editor'\)\.hidden\) applyPackageEdits\(\);/);
  });
  it('package search shows a count, a clear action and an empty-results state', () => {
    assert.match(catalogHtml, /id="pkg-count"/);
    assert.match(catalogHtml, /Showing \$\{rows\.length\} of \$\{total\} packages/);
    assert.match(catalogHtml, /id="clear-package-search"/);
    assert.match(catalogHtml, /No packages match the current search/);
    assert.match(catalogHtml, /Ux\.packageMatchesQuery\(/);
  });
  it('keeps the existing second-tab cookie behaviour (no token in URL, cross-tab logout)', () => {
    // Full coverage lives in owner-studio-multitab-session.test.js; this guards against regression here.
    assert.doesNotMatch(catalogHtml, /[?&](token|adminKey|x-admin-key)=/i);
    assert.match(catalogHtml, /onSessionEvent/);
    assert.match(catalogHtml, /Signed out in another tab/);
  });
});

// ===========================================================================
describe('add-on edit buffer (Apply/Cancel gate)', () => {
  const ORIGINAL = 4500;
  const TEMP = 9511;

  /** Simulated server store — only mutates on successful Save Draft. */
  function makeServer(initialDraft) {
    let stored = JSON.parse(JSON.stringify(initialDraft));
    return {
      get() { return JSON.parse(JSON.stringify(stored)); },
      save(draftPayload) {
        stored = JSON.parse(JSON.stringify(draftPayload));
        stored.version = (stored.version || 0) + 1;
        return JSON.parse(JSON.stringify(stored));
      },
    };
  }

  function draftWithTwoAddons() {
    const d = sampleDraft();
    d.addOns.push({
      addOnId: 'addon_other', name: 'Other', slug: 'other', description: 'Other',
      active: true, allowQuantity: false, displayOrder: 1,
      prices: [{ category: 'cars', currency: 'usd', amountCents: 1200 }],
      compatibility: [{ category: 'cars' }],
    });
    return d;
  }

  it('1. Server/canonical draft remains 4500 during typing (buffer only)', () => {
    const server = makeServer(sampleDraft());
    const draft = server.get();
    const beforeSig = Ux.editableCatalogSignature(draft);
    const buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    assert.equal(draft.addOns[0].prices[0].amountCents, ORIGINAL);
    assert.equal(server.get().addOns[0].prices[0].amountCents, ORIGINAL);
    assert.equal(Ux.editableCatalogSignature(draft), beforeSig);
    assert.equal(Ux.addonBufferHasUnappliedChanges(buf, draft.addOns[0]), true);
  });

  it('2. Apply changes local canonical draft to 9511', () => {
    const draft = sampleDraft();
    const buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    const r = Ux.applyAddonBufferToDraft(draft, buf);
    assert.equal(r.ok, true);
    assert.equal(draft.addOns[0].prices[0].amountCents, TEMP);
    assert.ok(Number.isInteger(draft.addOns[0].prices[0].amountCents));
    assert.equal(Ux.addonBufferHasUnappliedChanges(Ux.cloneAddonEditBuffer(draft.addOns[0]), draft.addOns[0]), false);
  });

  it('3. Server remains 4500 before Save Draft (Apply is local only)', () => {
    const server = makeServer(sampleDraft());
    const working = server.get();
    const buf = Ux.cloneAddonEditBuffer(working.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    Ux.applyAddonBufferToDraft(working, buf);
    assert.equal(working.addOns[0].prices[0].amountCents, TEMP);
    assert.equal(server.get().addOns[0].prices[0].amountCents, ORIGINAL, 'no server write until Save Draft');
  });

  it('4. Save Draft payload contains 9511', () => {
    const draft = sampleDraft();
    const buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    Ux.applyAddonBufferToDraft(draft, buf);
    const clean = { ...draft };
    for (const k of ['draftId', 'updatedAt', 'updatedBy', 'lastSavedAt', 'lastSavedBy']) delete clean[k];
    assert.equal(clean.addOns[0].prices[0].amountCents, TEMP);
  });

  it('5. Fresh GET after successful save returns 9511', () => {
    const server = makeServer(sampleDraft());
    const working = server.get();
    const buf = Ux.cloneAddonEditBuffer(working.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    Ux.applyAddonBufferToDraft(working, buf);
    // Fresh GET after Apply (before Save) must still be 4500 — wording trap, not a product defect.
    assert.equal(server.get().addOns[0].prices[0].amountCents, ORIGINAL);
    const saved = server.save(working);
    assert.equal(saved.addOns[0].prices[0].amountCents, TEMP);
    assert.equal(server.get().addOns[0].prices[0].amountCents, TEMP);
  });

  it('6–7. Restore + Save returns 4500; final fresh GET returns 4500', () => {
    const server = makeServer(sampleDraft());
    let working = server.get();
    let buf = Ux.cloneAddonEditBuffer(working.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    Ux.applyAddonBufferToDraft(working, buf);
    server.save(working);
    working = server.get();
    assert.equal(working.addOns[0].prices[0].amountCents, TEMP);
    const restoreBuf = Ux.cloneAddonEditBuffer(working.addOns[0]);
    restoreBuf.prices[0].rawUsd = Ux.centsToUsd(ORIGINAL);
    assert.equal(Ux.applyAddonBufferToDraft(working, restoreBuf).ok, true);
    assert.equal(working.addOns[0].prices[0].amountCents, ORIGINAL);
    server.save(working);
    assert.equal(server.get().addOns[0].prices[0].amountCents, ORIGINAL);
  });

  it('8. Save is blocked while buffer is unapplied (page wiring + pure predicate)', () => {
    const draft = sampleDraft();
    const buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    assert.equal(Ux.addonBufferHasUnappliedChanges(buf, draft.addOns[0]), true);
    assert.equal(draft.addOns[0].prices[0].amountCents, ORIGINAL);
    assert.match(catalogHtml, /if \(hasUnappliedAddonChanges\(\)\) \{\s*blockForUnappliedAddonBuffer\(\);\s*return;/);
    assert.match(catalogHtml, /Apply or cancel the open add-on changes before saving\./);
    assert.doesNotMatch(catalogHtml, /flushOpenAddonEditors/);
  });

  it('9. Switching add-ons cannot silently lose the buffer', () => {
    assert.match(catalogHtml, /function requestAddonExpand\(/);
    assert.match(catalogHtml, /if \(unapplied && unapplied !== targetId\)/);
    assert.match(catalogHtml, /blockForUnappliedAddonBuffer\(\)/);
    const draft = draftWithTwoAddons();
    const buffers = Object.create(null);
    buffers.addon_pet = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buffers.addon_pet.prices[0].rawUsd = '95.11';
    assert.equal(Ux.addonBufferHasUnappliedChanges(buffers.addon_pet, draft.addOns[0]), true);
    // Policy: keep the unapplied buffer; do not replace it with another add-on's buffer.
    assert.equal(Object.keys(buffers).length, 1);
    assert.equal(buffers.addon_pet.prices[0].rawUsd, '95.11');
  });

  it('10. Closing/collapsing cannot silently lose the buffer', () => {
    assert.match(catalogHtml, /if \(unapplied && unapplied === targetId && state\.addonExpanded\.has\(targetId\)\)/);
    assert.match(catalogHtml, /addon-collapse-all[\s\S]*hasUnappliedAddonChanges\(\)/);
    const draft = sampleDraft();
    const buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    assert.equal(Ux.addonBufferHasUnappliedChanges(buf, draft.addOns[0]), true);
    // Collapse is refused while unapplied — buffer object remains.
    assert.equal(buf.prices[0].rawUsd, '95.11');
    assert.equal(draft.addOns[0].prices[0].amountCents, ORIGINAL);
  });

  it('11. Search/filter/navigation cannot silently lose the buffer', () => {
    assert.match(catalogHtml, /syncOpenAddonEditorsToBuffers\(\)/);
    assert.match(catalogHtml, /search\/filter\/rebuild never silently discards/);
    assert.match(catalogHtml, /hasPendingLocalEdits\(\)/);
    assert.match(catalogHtml, /beforeunload[\s\S]*hasPendingLocalEdits/);
    assert.match(catalogHtml, /function selectPackage\(id\) \{\s*\/\/ Switching into the Packages editor[\s\S]*hasUnappliedAddonChanges/);
    const draft = sampleDraft();
    const buffers = { addon_pet: Ux.cloneAddonEditBuffer(draft.addOns[0]) };
    buffers.addon_pet.prices[0].rawUsd = '95.11';
    // Simulated filter rebuild: buffers map is not cleared.
    const afterFilter = buffers;
    assert.equal(afterFilter.addon_pet.prices[0].rawUsd, '95.11');
    assert.equal(Ux.addonBufferHasUnappliedChanges(afterFilter.addon_pet, draft.addOns[0]), true);
  });

  it('12. Cancel does not dirty the canonical draft', () => {
    const draft = sampleDraft();
    const baseline = Ux.editableCatalogSignature(draft);
    let buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buf.name = 'CHANGED';
    buf.prices[0].rawUsd = '99.99';
    assert.equal(Ux.addonBufferHasUnappliedChanges(buf, draft.addOns[0]), true);
    // Cancel = drop buffer and re-clone from canonical draft (no apply).
    buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    assert.equal(Ux.editableCatalogSignature(draft), baseline);
    assert.equal(Ux.isCatalogDirty(draft, sampleDraft()), false);
    assert.equal(Ux.addonBufferHasUnappliedChanges(buf, draft.addOns[0]), false);
    assert.equal(draft.addOns[0].prices[0].amountCents, ORIGINAL);
  });

  it('13. Failed server save retains the applied draft', () => {
    const server = makeServer(sampleDraft());
    const working = server.get();
    const buf = Ux.cloneAddonEditBuffer(working.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    Ux.applyAddonBufferToDraft(working, buf);
    assert.equal(working.addOns[0].prices[0].amountCents, TEMP);
    // Simulate network/5xx — server store untouched; local applied draft kept.
    assert.equal(server.get().addOns[0].prices[0].amountCents, ORIGINAL);
    assert.equal(Ux.isCatalogDirty(working, sampleDraft()), true);
    assert.equal(Ux.isSaveEnabled({ state: 'network-error', dirty: true, valid: true, saving: false }), true);
  });

  it('14. Stale 409 retains the applied draft', () => {
    const working = sampleDraft();
    const buf = Ux.cloneAddonEditBuffer(working.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    Ux.applyAddonBufferToDraft(working, buf);
    const f = classifyFailure(resp(409, { error: 'stale_catalog_draft_version', currentVersion: 9 }), { error: 'stale_catalog_draft_version', currentVersion: 9 });
    assert.equal(f.state, 'stale-conflict');
    assert.equal(f.stale, true);
    assert.equal(working.addOns[0].prices[0].amountCents, TEMP, 'local edit survives 409 classification');
    assert.match(catalogHtml, /reportMutationFailure\(res, data, 'Save failed'\)/);
  });

  it('15. Package editing remains unchanged', () => {
    assert.equal(typeof Ux.parsePriceToCents, 'function');
    assert.equal(typeof Ux.editableCatalogSignature, 'function');
    assert.match(catalogHtml, /function applyPackageEdits\(\)/);
    assert.match(catalogHtml, /id="btn-apply-pkg"/);
    assert.match(catalogHtml, /input\.addEventListener\('input', \(\) => validatePriceInput\(input, errEl, key, \{ allowEmpty: true \}\)\)/);
    assert.match(catalogHtml, /if \(state\.selectedId && !el\('editor'\)\.hidden\) applyPackageEdits\(\);/);
  });

  it('malformed / negative price is rejected and draft is untouched', () => {
    const draft = sampleDraft();
    const bad = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    bad.prices[0].rawUsd = '12.345';
    assert.equal(Ux.applyAddonBufferToDraft(draft, bad).ok, false);
    assert.equal(draft.addOns[0].prices[0].amountCents, ORIGINAL);
    const neg = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    neg.prices[0].rawUsd = '-5';
    assert.equal(Ux.applyAddonBufferToDraft(draft, neg).ok, false);
    assert.equal(draft.addOns[0].prices[0].amountCents, ORIGINAL);
  });

  it('valid zero remains zero when allowed; Apply updates collapsed summary cents', () => {
    const draft = sampleDraft();
    assert.equal(Ux.addonSummaryAmountCents(draft.addOns[0]), ORIGINAL);
    const zeroBuf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    zeroBuf.prices[0].rawUsd = '0';
    assert.equal(Ux.applyAddonBufferToDraft(draft, zeroBuf, { allowZero: true }).ok, true);
    assert.equal(draft.addOns[0].prices[0].amountCents, 0);
    const tempBuf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    tempBuf.prices[0].rawUsd = '95.11';
    Ux.applyAddonBufferToDraft(draft, tempBuf);
    assert.equal(Ux.addonSummaryAmountCents(draft.addOns[0]), TEMP);
  });

  it('one add-on edit does not change another add-on', () => {
    const draft = draftWithTwoAddons();
    const otherBefore = draft.addOns[1].prices[0].amountCents;
    const buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buf.prices[0].rawUsd = '95.11';
    Ux.applyAddonBufferToDraft(draft, buf);
    assert.equal(draft.addOns[0].prices[0].amountCents, TEMP);
    assert.equal(draft.addOns[1].prices[0].amountCents, otherBefore);
  });
});
