'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const os = require('../netlify/lib/owner-studio');

const OWNER = { authenticated: true, username: 'owner1', role: 'owner' };
const ADMIN = { authenticated: true, username: 'admin1', role: 'admin' };
const STAFF = { authenticated: true, username: 'tech1', role: 'staff' };

function enableStudio() {
  process.env.OWNER_STUDIO_ENABLED = 'true';
  process.env.PUBLIC_CONTENT_SOURCE = 'legacy';
  process.env.OWNER_STUDIO_ADMIN_CAN_PUBLISH = 'false';
}

function disableStudio() {
  process.env.OWNER_STUDIO_ENABLED = 'false';
  process.env.PUBLIC_CONTENT_SOURCE = 'legacy';
  delete process.env.OWNER_STUDIO_ADMIN_CAN_PUBLISH;
}

function samplePackage(overrides = {}) {
  return {
    siteId: os.SITE_ID,
    packageId: 'pkg_maintenance_detail',
    legacyKey: 'maint',
    category: 'cars',
    name: 'Maintenance Detail',
    slug: 'maintenance-detail',
    description: 'Exterior wash and interior vacuum.',
    shortDescription: 'Monthly upkeep',
    active: true,
    featured: false,
    displayOrder: 0,
    features: [{ kind: 'included', label: 'Hand wash', sortOrder: 0 }],
    prices: [{
      packageId: 'pkg_maintenance_detail',
      vehicleClassId: 'vc_sedan',
      currency: 'usd',
      amountCents: 17500,
      priceModel: 'flat',
    }],
    ...overrides,
  };
}

beforeEach(() => {
  os.resetStore();
  disableStudio();
});

describe('Owner Studio foundation', () => {
  it('uses stable catalog IDs independent of names', () => {
    assert.equal(os.packageIdFor('cars', 'maint'), 'pkg_maintenance_detail');
    assert.equal(os.vehicleClassIdFor('cars', 'small'), 'vc_sedan');
    assert.equal(os.addOnIdFor('pethair'), 'addon_pet_hair');
    assert.equal(os.isStableId('pkg_maintenance_detail'), true);
    assert.equal(os.isStableId('Maintenance Detail'), false);
  });

  it('stores money as integer cents and rejects floats/negatives', () => {
    assert.equal(os.dollarsToCents(175), 17500);
    assert.throws(() => os.assertIntegerCents(19.99), /money_not_integer|not_integer/);
    assert.throws(() => os.assertIntegerCents(-1), /money_negative|negative/);
    assert.throws(() => os.rejectFloatingMoney(12.5), /floating_point_money/);
  });

  it('isolates drafts from published catalog reads', () => {
    enableStudio();
    os.saveDraft(OWNER, {
      siteId: os.SITE_ID,
      packages: [samplePackage()],
      addOns: [],
      navigation: { siteId: os.SITE_ID, headerItems: [{ label: 'Home', href: '/index.html', sortOrder: 0 }] },
    });
    const pub = os.readPublishedCatalog(os.SITE_ID);
    assert.equal(pub.source, 'legacy');
    assert.equal(pub.catalog, null);
    const draft = os.readDraft(os.SITE_ID);
    assert.equal(draft.packages.length, 1);
    assert.equal(draft.status, 'draft');
  });

  it('publishes immutable releases and supports atomic rollback', () => {
    enableStudio();
    process.env.PUBLIC_CONTENT_SOURCE = 'owner-studio';
    os.saveDraft(OWNER, {
      siteId: os.SITE_ID,
      packages: [samplePackage()],
      addOns: [{
        siteId: os.SITE_ID,
        addOnId: 'addon_pet_hair',
        legacyKey: 'pethair',
        name: 'Pet Hair Removal',
        slug: 'pet-hair',
        description: 'Deep pet hair removal',
        active: true,
        allowQuantity: false,
        prices: [{ category: 'cars', currency: 'usd', amountCents: 9500 }],
        compatibility: [{ category: 'cars' }],
      }],
      navigation: { siteId: os.SITE_ID, headerItems: [{ label: 'Home', href: '/index.html', sortOrder: 0 }] },
      footer: {
        siteId: os.SITE_ID,
        tagline: 'Mobile detailing',
        groups: [],
        legalLinks: [{ label: 'Terms', href: '/terms-conditions.html' }],
        copyright: '© 2026',
      },
    });
    const r1 = os.publishRelease(OWNER, os.SITE_ID);
    assert.ok(r1.releaseId.startsWith('rel_'));
    assert.equal(r1.immutable, true);
    const firstId = r1.releaseId;

    os.saveDraft(OWNER, {
      ...os.readDraft(os.SITE_ID),
      packages: [samplePackage({ name: 'Maintenance Detail v2', prices: [{
        packageId: 'pkg_maintenance_detail',
        vehicleClassId: 'vc_sedan',
        currency: 'usd',
        amountCents: 18500,
        priceModel: 'flat',
      }] })],
    });
    const r2 = os.publishRelease(OWNER, os.SITE_ID);
    assert.notEqual(r2.releaseId, firstId);
    assert.equal(os.resolveCurrentRelease(os.SITE_ID).releaseId, r2.releaseId);

    // Prior release remains unchanged
    const prior = os.getStore().releases.get(firstId);
    assert.equal(prior.catalog.packages[0].prices[0].amountCents, 17500);

    const rolled = os.rollbackToRelease(OWNER, firstId, os.SITE_ID);
    assert.equal(rolled.releaseId, firstId);
    assert.equal(os.resolveCurrentRelease(os.SITE_ID).catalog.packages[0].prices[0].amountCents, 17500);
  });

  it('deactivates historical packages instead of deleting', () => {
    enableStudio();
    os.saveDraft(OWNER, {
      siteId: os.SITE_ID,
      packages: [samplePackage()],
      addOns: [],
    });
    os.deactivatePackage(OWNER, 'pkg_maintenance_detail', os.SITE_ID);
    const draft = os.readDraft(os.SITE_ID);
    assert.equal(draft.packages.length, 1);
    assert.equal(draft.packages[0].active, false);
  });

  it('rejects publication when validation fails', () => {
    enableStudio();
    os.saveDraft(OWNER, {
      siteId: os.SITE_ID,
      packages: [samplePackage({ prices: [] })],
      addOns: [],
    });
    // Empty prices on active package → validateReleaseCandidate fails at publish
    assert.throws(() => os.publishRelease(OWNER, os.SITE_ID), (err) => {
      return err.code === 'release_validation_failed';
    });
  });

  it('falls back to legacy when flags off or unknown source', () => {
    disableStudio();
    process.env.PUBLIC_CONTENT_SOURCE = 'something-weird';
    const pub = os.readPublishedCatalog(os.SITE_ID);
    assert.equal(pub.source, 'legacy');
    const content = os.readPublishedSiteContent(os.SITE_ID);
    assert.equal(content.source, 'legacy');
  });

  it('enforces siteId isolation', () => {
    assert.throws(() => os.assertSiteId(''), /invalid_site_id/);
    assert.throws(() => os.assertSiteId('OTHER SITE'), /invalid_site_id/);
    assert.equal(os.assertSiteId('detailing-zone'), 'detailing-zone');
  });

  it('keeps secrets and drafts out of published snapshots', () => {
    const snaps = os.buildPublishedSnapshots({
      siteId: os.SITE_ID,
      releaseId: 'rel_test',
      publishedAt: new Date().toISOString(),
      catalog: { packages: [], secret: 'nope', draftStatus: 'draft' },
      content: { navigation: { headerItems: [] }, audit: [{ a: 1 }], ADMIN_SESSION_SECRET: 'x' },
    });
    const cat = snaps.files['catalog/current.json'];
    const content = snaps.files['site-content/current.json'];
    assert.equal(cat.catalog.secret, undefined);
    assert.equal(content.content.audit, undefined);
    assert.ok(snaps.manifest.catalog.sha256);
    assert.ok(snaps.manifest.content.sha256);
    os.assertSnapshotSafe(cat);
    os.assertSnapshotSafe(content);
  });

  it('rejects HTML/script injection in content fields', () => {
    assert.throws(() => os.validatePageContent({
      siteId: os.SITE_ID,
      pageId: 'home',
      heading: 'Hi <script>alert(1)</script>',
      subheading: '',
      body: '',
      ctas: [],
    }), /unsafe_content/);
  });

  it('enforces role authorization for edit/publish/rollback', () => {
    enableStudio();
    assert.throws(() => os.authorizeOwnerStudio(STAFF, 'edit_draft'), /staff_denied|denied/);
    assert.throws(() => os.authorizeOwnerStudio(ADMIN, 'publish'), /publish_denied/);
    process.env.OWNER_STUDIO_ADMIN_CAN_PUBLISH = 'true';
    assert.equal(os.authorizeOwnerStudio(ADMIN, 'publish').ok, true);
    disableStudio();
    assert.throws(() => os.authorizeOwnerStudio(OWNER, 'edit_draft'), /owner_studio_disabled/);
  });

  it('appends audit events on draft save and publish', () => {
    enableStudio();
    process.env.PUBLIC_CONTENT_SOURCE = 'owner-studio';
    os.saveDraft(OWNER, { siteId: os.SITE_ID, packages: [samplePackage()], addOns: [] });
    os.publishRelease(OWNER, os.SITE_ID);
    const events = os.listAuditEvents(os.SITE_ID);
    assert.ok(events.some((e) => e.action === 'draft.save'));
    assert.ok(events.some((e) => e.action === 'release.publish'));
  });

  it('builds booking catalog snapshots without mutating legacy bookings', () => {
    const snap = os.buildBookingCatalogSnapshot({
      packageId: 'pkg_maintenance_detail',
      packageRevisionId: 'prev_1',
      publishedCatalogReleaseId: 'rel_1',
      packageName: 'Maintenance Detail',
      vehicleClassId: 'vc_sedan',
      basePriceCents: 17500,
      approvedTotalCents: 17500,
      currency: 'usd',
      selectedAddOns: [],
    });
    assert.equal(snap.basePriceCents, 17500);
    const legacyBooking = {
      packageId: 'maint',
      package: 'Maintenance',
      ledger: { approvedCents: 20000, currency: 'usd' },
    };
    const resolved = os.resolveBookingCommercial(legacyBooking);
    assert.equal(resolved.source, 'legacy-aggregate');
    assert.equal(resolved.approvedTotalCents, 20000);
    assert.equal(legacyBooking.ledger.approvedCents, 20000);
  });

  it('runs deterministic importer dry-run without production writes', () => {
    const report1 = os.importLegacyCatalog({
      repoRoot: path.join(__dirname, '..'),
      dryRun: true,
      writeArtifacts: false,
    });
    const report2 = os.importLegacyCatalog({
      repoRoot: path.join(__dirname, '..'),
      dryRun: true,
      writeArtifacts: false,
    });
    assert.equal(report1.dryRun, true);
    assert.ok(report1.stats.packageCount > 0);
    assert.ok(report1.stats.addOnCount > 0);
    assert.deepEqual(
      report1.packages.map((p) => p.packageId),
      report2.packages.map((p) => p.packageId)
    );
    assert.ok(report1.unmappedContent.length > 0, 'must report unmapped content');
    // Memory store remains empty (no apply)
    assert.equal(os.readDraft(os.SITE_ID).packages.length, 0);
  });

  it('does not reintroduce CustomerVehicle garage models in Owner Studio schema text', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    assert.equal(/model\s+CustomerVehicle\b/.test(schema), false);
    assert.ok(/model\s+OsPackage\b/.test(schema));
  });

  it('keeps public content source legacy by default (website unchanged path)', () => {
    delete process.env.OWNER_STUDIO_ENABLED;
    delete process.env.PUBLIC_CONTENT_SOURCE;
    const flags = os.getOwnerStudioFlags();
    assert.equal(flags.enabled, false);
    assert.equal(flags.publicContentSource, 'legacy');
    assert.equal(os.useLegacyPublicContent(), true);
  });

  it('csrf helpers bind token to session', () => {
    const token = os.createCsrfToken('sess-1', 'secret-secret-secret-secret-secret');
    assert.equal(os.verifyCsrfToken('sess-1', 'secret-secret-secret-secret-secret', token), true);
    assert.equal(os.verifyCsrfToken('sess-2', 'secret-secret-secret-secret-secret', token), false);
  });
});
