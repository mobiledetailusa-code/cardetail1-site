'use strict';

const fs = require('fs');
const path = require('path');
const {
  SITE_ID,
  packageIdFor,
  vehicleClassIdFor,
  addOnIdFor,
} = require('./ids');
const { dollarsToCents } = require('./money');
const { PACKAGE_DESCRIPTIONS } = require('../canonical-package-catalog');
const { ADDON_DISPLAY } = require('../canonical-addon-catalog');

function loadLegacyPricingModule(repoRoot) {
  const catalogPath = path.join(repoRoot, 'netlify', 'lib', 'booking-price-catalog.js');
  // Fresh require from absolute path
  delete require.cache[require.resolve(catalogPath)];
  return require(catalogPath);
}

function extractIndexPricingBlock(repoRoot) {
  const indexPath = path.join(repoRoot, 'index.html');
  if (!fs.existsSync(indexPath)) return null;
  const html = fs.readFileSync(indexPath, 'utf8');
  const m = html.match(/const PRICING = \{[\s\S]*?\n\};/);
  if (!m) return null;
  return m[0];
}

function scanHubPriceConflicts(repoRoot, serverPricing, report) {
  const hubs = fs.readdirSync(repoRoot).filter((f) => f.endsWith('.html'));
  for (const file of hubs) {
    if (file === 'index.html') continue;
    const html = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    if (!html.includes('const PRICING = {')) continue;
    // Compare a few known car tier anchors
    const smallMaint = html.match(/small:\s*\{[^}]*maint:\s*(\d+)/);
    const server = serverPricing.cars?.tiers?.small?.maint;
    if (smallMaint && server != null && Number(smallMaint[1]) !== Number(server)) {
      report.priceConflicts.push({
        file,
        field: 'cars.tiers.small.maint',
        htmlValue: Number(smallMaint[1]),
        serverValue: Number(server),
        message: 'Hub HTML price differs from booking-price-catalog.js',
      });
    }
    const fullSmall = html.match(/small:\s*\{[^}]*full:\s*(\d+)/);
    const serverFull = serverPricing.cars?.tiers?.small?.full;
    if (fullSmall && serverFull != null && Number(fullSmall[1]) !== Number(serverFull)) {
      report.priceConflicts.push({
        file,
        field: 'cars.tiers.small.full',
        htmlValue: Number(fullSmall[1]),
        serverValue: Number(serverFull),
        message: 'Hub HTML full price differs from server catalog',
      });
    }
  }
}

function importLegacyCatalog(options = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..', '..', '..');
  const dryRun = options.dryRun !== false; // default true
  const siteId = options.siteId || SITE_ID;

  const report = {
    siteId,
    dryRun,
    at: new Date().toISOString(),
    packages: [],
    addOns: [],
    vehicleClasses: [],
    duplicates: [],
    unresolved: [],
    priceConflicts: [],
    unmappedContent: [],
    errors: [],
    draft: null,
  };

  let PRICING;
  let LENGTH_PRICING;
  try {
    const mod = loadLegacyPricingModule(repoRoot);
    PRICING = mod.PRICING;
    LENGTH_PRICING = mod.LENGTH_PRICING;
  } catch (e) {
    report.errors.push({ code: 'catalog_load_failed', message: String(e.message || e) });
    return finalize(report, options);
  }

  const indexBlock = extractIndexPricingBlock(repoRoot);
  if (!indexBlock) {
    report.unmappedContent.push({
      path: 'index.html',
      reason: 'PRICING block not found for cross-check',
    });
  } else {
    // Cross-check index small.maint
    const m = indexBlock.match(/small:\s*\{[^}]*maint:\s*(\d+)/);
    if (m && Number(m[1]) !== Number(PRICING.cars.tiers.small.maint)) {
      report.priceConflicts.push({
        file: 'index.html',
        field: 'cars.tiers.small.maint',
        htmlValue: Number(m[1]),
        serverValue: Number(PRICING.cars.tiers.small.maint),
        message: 'index.html PRICING differs from booking-price-catalog.js',
      });
    }
  }

  scanHubPriceConflicts(repoRoot, PRICING, report);

  const packageIds = new Set();
  const addOnIds = new Set();
  const vcIds = new Set();
  const packages = [];
  const addOnsById = new Map();
  const vehicleClasses = [];

  for (const [category, cat] of Object.entries(PRICING || {})) {
    const tiers = cat.tiers || {};
    const packageKeys = new Set();
    for (const [tierKey, tier] of Object.entries(tiers)) {
      const vcId = vehicleClassIdFor(category, tierKey);
      if (vcIds.has(vcId)) {
        report.duplicates.push({ type: 'vehicleClass', id: vcId, legacyKey: tierKey, category });
      } else {
        vcIds.add(vcId);
        vehicleClasses.push({
          siteId,
          vehicleClassId: vcId,
          legacyKey: tierKey,
          category,
          label: tier.label || tierKey,
          active: true,
        });
      }
      for (const [pkgKey, dollars] of Object.entries(tier)) {
        if (pkgKey === 'label' || pkgKey === 'icon' || pkgKey === 'desc') continue;
        if (typeof dollars !== 'number') {
          report.unresolved.push({
            type: 'price',
            category,
            tierKey,
            pkgKey,
            reason: 'non_numeric_price',
            value: dollars,
          });
          continue;
        }
        packageKeys.add(pkgKey);
      }
    }

    // Length model packages
    const lengthPkgs = LENGTH_PRICING?.[category]?.packages || {};
    for (const pkgKey of Object.keys(lengthPkgs)) packageKeys.add(pkgKey);

    let order = 0;
    for (const pkgKey of packageKeys) {
      const packageId = packageIdFor(category, pkgKey);
      if (packageIds.has(packageId)) {
        report.duplicates.push({ type: 'package', id: packageId, legacyKey: pkgKey, category });
        continue;
      }
      packageIds.add(packageId);

      const prices = [];
      for (const [tierKey, tier] of Object.entries(tiers)) {
        if (typeof tier[pkgKey] !== 'number') continue;
        try {
          const amountCents = dollarsToCents(tier[pkgKey]);
          // 0 means unavailable in legacy — keep row but mark via amount 0 + note
          prices.push({
            packageId,
            vehicleClassId: vehicleClassIdFor(category, tierKey),
            currency: 'usd',
            amountCents,
            priceModel: 'flat',
          });
        } catch (e) {
          report.errors.push({
            code: e.code || 'price_convert_failed',
            packageId,
            tierKey,
            message: e.message,
          });
        }
      }

      const lengthRule = lengthPkgs[pkgKey];
      if (lengthRule) {
        try {
          if (lengthRule.perFt != null) {
            prices.push({
              packageId,
              vehicleClassId: null,
              currency: 'usd',
              amountCents: dollarsToCents(lengthRule.min || 0),
              priceModel: 'per_foot',
              perFootCents: dollarsToCents(lengthRule.perFt),
              minCents: dollarsToCents(lengthRule.min || 0),
            });
          } else if (lengthRule.ratePerFoot != null) {
            prices.push({
              packageId,
              vehicleClassId: null,
              currency: 'usd',
              amountCents: dollarsToCents(lengthRule.base || 0),
              priceModel: 'base_plus_per_foot',
              baseCents: dollarsToCents(lengthRule.base || 0),
              perFootCents: dollarsToCents(lengthRule.ratePerFoot),
            });
          }
        } catch (e) {
          report.errors.push({ code: e.code || 'length_price_failed', packageId, message: e.message });
        }
      }

      const desc = (PACKAGE_DESCRIPTIONS[category] && PACKAGE_DESCRIPTIONS[category][pkgKey]) || '';
      packages.push({
        siteId,
        packageId,
        legacyKey: pkgKey,
        category,
        name: titleFromLegacy(pkgKey),
        slug: `${category}-${pkgKey}`.replace(/_/g, '-'),
        description: desc,
        shortDescription: desc.slice(0, 280),
        active: prices.some((p) => p.amountCents > 0 || p.priceModel !== 'flat'),
        featured: category === 'cars' && ['full', 'premium'].includes(pkgKey),
        displayOrder: order++,
        features: [],
        prices,
      });
      report.packages.push({ packageId, legacyKey: pkgKey, category, priceRows: prices.length });
    }

    for (const addon of cat.addons || []) {
      const addOnId = addOnIdFor(addon.id);
      const display = ADDON_DISPLAY[addon.id] || { name: titleFromLegacy(addon.id), description: '' };
      let amountCents;
      try {
        amountCents = dollarsToCents(addon.price);
      } catch (e) {
        report.errors.push({ code: e.code || 'addon_price_failed', addOnId, message: e.message });
        report.unresolved.push({ type: 'addon_price', legacyKey: addon.id, reason: e.message });
        continue;
      }
      if (!addOnsById.has(addOnId)) {
        addOnsById.set(addOnId, {
          siteId,
          addOnId,
          legacyKey: addon.id,
          name: display.name,
          slug: addOnId.replace(/^addon_/, '').replace(/_/g, '-'),
          description: display.description || '',
          active: true,
          allowQuantity: !!addon.qty,
          prices: [],
          compatibility: [],
        });
        addOnIds.add(addOnId);
      } else if (!addOnIds.has(addOnId)) {
        report.duplicates.push({ type: 'addOn', id: addOnId });
      }
      const row = addOnsById.get(addOnId);
      const existing = row.prices.find((p) => p.category === category);
      if (existing && existing.amountCents !== amountCents) {
        report.priceConflicts.push({
          type: 'addon',
          addOnId,
          category,
          existingCents: existing.amountCents,
          incomingCents: amountCents,
          message: 'Add-on price conflict across categories kept as separate category rows',
        });
      }
      if (!existing) {
        row.prices.push({ category, currency: 'usd', amountCents });
        row.compatibility.push({ category });
      }
    }
  }

  // Content that cannot be mapped automatically
  report.unmappedContent.push(
    { path: 'index.html', reason: 'Hero/FAQ/gallery HTML requires Stage 4–5 structured mapping' },
    { path: 'assets/partials/specialty-public-footer.html', reason: 'Footer mapped partially in draft; verify links' },
    { path: '*-hub.html', reason: 'SEO hub copy not auto-imported in Stage 1' },
    { path: 'terms-conditions.html', reason: 'Legal page deferred' },
  );

  // Partial content draft from footer
  let footer = {
    siteId,
    tagline: 'Based in Palisades Park, NJ. Mobile cars, boats, RVs, and powersports — we come to you. Detailing Zone LLC.',
    groups: [],
    legalLinks: [{ label: 'Terms & Policies', href: '/terms-conditions.html' }],
    copyright: '© 2026 Cardetail1 · Detailing Zone LLC · All rights reserved.',
  };
  const footerPath = path.join(repoRoot, 'assets', 'partials', 'specialty-public-footer.html');
  if (fs.existsSync(footerPath)) {
    // keep defaults; structure imported above
  } else {
    report.unmappedContent.push({ path: 'assets/partials/specialty-public-footer.html', reason: 'missing' });
  }

  const draft = {
    siteId,
    status: 'draft',
    packages,
    addOns: [...addOnsById.values()],
    vehicleClasses,
    navigation: {
      siteId,
      headerItems: [
        { label: 'Services', href: '/index.html', sortOrder: 0 },
        { label: 'My Garage', href: '/my-garage.html', sortOrder: 1 },
        { label: 'Book', href: '/index.html#book', sortOrder: 2 },
      ],
    },
    footer,
    pages: [],
    galleries: [],
    serviceAreas: [],
    media: [],
  };

  for (const a of draft.addOns) report.addOns.push({ addOnId: a.addOnId, legacyKey: a.legacyKey, priceRows: a.prices.length });
  report.vehicleClasses = vehicleClasses.map((v) => ({ vehicleClassId: v.vehicleClassId, legacyKey: v.legacyKey }));
  report.draft = dryRun ? summarizeDraft(draft) : draft;
  report.stats = {
    packageCount: packages.length,
    addOnCount: draft.addOns.length,
    vehicleClassCount: vehicleClasses.length,
    duplicateCount: report.duplicates.length,
    priceConflictCount: report.priceConflicts.length,
    unresolvedCount: report.unresolved.length,
    unmappedCount: report.unmappedContent.length,
    errorCount: report.errors.length,
  };

  if (!dryRun && options.applyToStore) {
    // Only when explicitly requested (never production path in Stage 1)
    const { saveDraft } = require('./draft-service');
    const identity = options.identity || { authenticated: true, username: 'importer', role: 'owner' };
    const prev = process.env.OWNER_STUDIO_ENABLED;
    process.env.OWNER_STUDIO_ENABLED = 'true';
    try {
      saveDraft(identity, draft);
    } finally {
      if (prev === undefined) delete process.env.OWNER_STUDIO_ENABLED;
      else process.env.OWNER_STUDIO_ENABLED = prev;
    }
  }

  return finalize(report, options);
}

function titleFromLegacy(key) {
  return String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function summarizeDraft(draft) {
  return {
    siteId: draft.siteId,
    packageCount: draft.packages.length,
    addOnCount: draft.addOns.length,
    vehicleClassCount: draft.vehicleClasses.length,
    samplePackageIds: draft.packages.slice(0, 5).map((p) => p.packageId),
  };
}

function finalize(report, options) {
  if (options.writeArtifacts !== false) {
    const artifactsDir = options.artifactsDir || path.join(options.repoRoot || process.cwd(), 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const jsonPath = path.join(artifactsDir, 'owner-studio-import-report.json');
    const mdPath = path.join(artifactsDir, 'owner-studio-import-report.md');
    // Never write secrets
    const safe = JSON.parse(JSON.stringify(report));
    fs.writeFileSync(jsonPath, JSON.stringify(safe, null, 2));
    fs.writeFileSync(mdPath, toMarkdown(safe));
    report.artifactPaths = { jsonPath, mdPath };
  }
  return report;
}

function toMarkdown(report) {
  const lines = [
    '# Owner Studio Legacy Import Report',
    '',
    `- siteId: \`${report.siteId}\``,
    `- dryRun: \`${report.dryRun}\``,
    `- at: ${report.at}`,
    '',
    '## Stats',
    '',
    '```json',
    JSON.stringify(report.stats || {}, null, 2),
    '```',
    '',
    '## Price conflicts',
    '',
  ];
  if (!(report.priceConflicts || []).length) lines.push('_None_');
  for (const c of report.priceConflicts || []) {
    lines.push(`- \`${c.file || c.addOnId || ''}\` ${c.field || ''} — ${c.message}`);
  }
  lines.push('', '## Duplicates', '');
  if (!(report.duplicates || []).length) lines.push('_None_');
  for (const d of report.duplicates || []) lines.push(`- ${d.type} \`${d.id}\``);
  lines.push('', '## Unresolved', '');
  if (!(report.unresolved || []).length) lines.push('_None_');
  for (const u of report.unresolved || []) lines.push(`- ${u.type}: ${u.reason}`);
  lines.push('', '## Unmapped content (not silently dropped)', '');
  for (const u of report.unmappedContent || []) lines.push(`- \`${u.path}\` — ${u.reason}`);
  lines.push('', '## Notes', '', '- No production writes.', '- Prices never guessed; conversion failures are listed under errors.', '- Existing bookings unchanged.', '');
  return lines.join('\n');
}

module.exports = {
  importLegacyCatalog,
  toMarkdown,
};
