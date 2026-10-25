'use strict';

const { isStableId, SITE_ID_RE } = require('./ids');
const { assertIntegerCents, assertCurrency, rejectFloatingMoney } = require('./money');

const MAX = {
  name: 80,
  description: 2000,
  shortDescription: 280,
  label: 120,
  slug: 80,
  url: 500,
  alt: 200,
  faq: 2000,
  seoTitle: 70,
  seoDescription: 170,
};

const UNSAFE_CONTENT_RE = /<\s*script|javascript:|data:text\/html|<\s*iframe|<\s*object|<\s*embed|expression\s*\(|@import|<\/?\s*style|on\w+\s*=/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_PATH_RE = /^\/[A-Za-z0-9._~\/?#&=%+-]*$/;
const SAFE_HTTP_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?$/;

function rejectUnknown(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const err = new Error('expected_object');
    err.code = 'expected_object';
    throw err;
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      const err = new Error(`unknown_field:${key}`);
      err.code = 'unknown_field';
      err.field = key;
      throw err;
    }
  }
}

function assertPlainText(value, field, max) {
  if (typeof value !== 'string') {
    const err = new Error(`${field}_not_string`);
    err.code = 'not_string';
    err.field = field;
    throw err;
  }
  if (value.length > max) {
    const err = new Error(`${field}_too_long`);
    err.code = 'too_long';
    err.field = field;
    throw err;
  }
  if (UNSAFE_CONTENT_RE.test(value)) {
    const err = new Error(`${field}_unsafe_content`);
    err.code = 'unsafe_content';
    err.field = field;
    throw err;
  }
  return value;
}

function assertSafeUrl(value, field) {
  const v = assertPlainText(value, field, MAX.url);
  if (!(SAFE_HTTP_URL_RE.test(v) || SAFE_PATH_RE.test(v) || /^tel:\+?[0-9()-.\s]+$/.test(v) || /^mailto:[^\s]+$/.test(v))) {
    const err = new Error(`${field}_unsafe_url`);
    err.code = 'unsafe_url';
    err.field = field;
    throw err;
  }
  return v;
}

function assertSlug(value, field = 'slug') {
  const v = assertPlainText(value, field, MAX.slug);
  if (!SLUG_RE.test(v)) {
    const err = new Error(`${field}_invalid`);
    err.code = 'invalid_slug';
    err.field = field;
    throw err;
  }
  return v;
}

function assertStable(id, field) {
  if (!isStableId(id)) {
    const err = new Error(`${field}_invalid_stable_id`);
    err.code = 'invalid_stable_id';
    err.field = field;
    throw err;
  }
  return id;
}

function validatePackagePrice(input) {
  rejectUnknown(input, new Set([
    'packageId', 'vehicleClassId', 'currency', 'amountCents', 'priceModel',
    'perFootCents', 'minCents', 'baseCents',
  ]));
  assertStable(input.packageId, 'packageId');
  if (input.vehicleClassId != null) assertStable(input.vehicleClassId, 'vehicleClassId');
  const currency = assertCurrency(input.currency);
  rejectFloatingMoney(input.amountCents);
  const amountCents = assertIntegerCents(input.amountCents, 'amountCents');
  const priceModel = String(input.priceModel || 'flat');
  if (!['flat', 'per_foot', 'base_plus_per_foot'].includes(priceModel)) {
    const err = new Error('invalid_price_model');
    err.code = 'invalid_price_model';
    throw err;
  }
  const out = { packageId: input.packageId, vehicleClassId: input.vehicleClassId || null, currency, amountCents, priceModel };
  if (input.perFootCents != null) out.perFootCents = assertIntegerCents(input.perFootCents, 'perFootCents');
  if (input.minCents != null) out.minCents = assertIntegerCents(input.minCents, 'minCents');
  if (input.baseCents != null) out.baseCents = assertIntegerCents(input.baseCents, 'baseCents');
  return out;
}

function validateVehicleClassDraft(input) {
  rejectUnknown(input, new Set([
    'siteId', 'vehicleClassId', 'legacyKey', 'category', 'label', 'active', 'displayOrder',
  ]));
  if (!SITE_ID_RE.test(String(input.siteId || ''))) {
    const err = new Error('invalid_site_id');
    err.code = 'invalid_site_id';
    throw err;
  }
  assertStable(input.vehicleClassId, 'vehicleClassId');
  return {
    siteId: input.siteId,
    vehicleClassId: input.vehicleClassId,
    legacyKey: assertPlainText(String(input.legacyKey || ''), 'legacyKey', 64),
    category: assertPlainText(String(input.category || ''), 'category', 40),
    label: assertPlainText(input.label, 'label', MAX.label),
    active: input.active !== false,
    displayOrder: Number.isInteger(input.displayOrder) ? input.displayOrder : 0,
  };
}

function validatePackageDraft(input) {
  rejectUnknown(input, new Set([
    'siteId', 'packageId', 'legacyKey', 'category', 'name', 'slug', 'description',
    'shortDescription', 'active', 'featured', 'displayOrder', 'durationMinutes',
    'features', 'prices', 'compatibleVehicleClassIds', 'compatibleAddOnIds',
  ]));
  if (!SITE_ID_RE.test(String(input.siteId || ''))) {
    const err = new Error('invalid_site_id');
    err.code = 'invalid_site_id';
    throw err;
  }
  assertStable(input.packageId, 'packageId');
  const name = assertPlainText(input.name, 'name', MAX.name);
  const slug = assertSlug(input.slug || input.packageId.replace(/^pkg_/, '').replace(/_/g, '-'));
  const description = assertPlainText(input.description || '', 'description', MAX.description);
  const shortDescription = assertPlainText(input.shortDescription || '', 'shortDescription', MAX.shortDescription);
  const features = Array.isArray(input.features) ? input.features.map((f, i) => {
    rejectUnknown(f, new Set(['kind', 'label', 'sortOrder']));
    if (!['included', 'excluded'].includes(f.kind)) {
      const err = new Error('invalid_feature_kind');
      err.code = 'invalid_feature_kind';
      throw err;
    }
    return {
      kind: f.kind,
      label: assertPlainText(f.label, `features[${i}].label`, MAX.label),
      sortOrder: Number.isInteger(f.sortOrder) ? f.sortOrder : i,
    };
  }) : [];
  const prices = Array.isArray(input.prices) ? input.prices.map(validatePackagePrice) : [];
  // duplicate active price rows
  const seen = new Set();
  for (const p of prices) {
    const key = `${p.packageId}|${p.vehicleClassId || ''}|${p.priceModel}`;
    if (seen.has(key)) {
      const err = new Error('duplicate_active_price_row');
      err.code = 'duplicate_active_price_row';
      throw err;
    }
    seen.add(key);
  }
  let durationMinutes = null;
  if (input.durationMinutes != null) {
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 0 || input.durationMinutes > 24 * 60) {
      const err = new Error('invalid_duration');
      err.code = 'invalid_duration';
      throw err;
    }
    durationMinutes = input.durationMinutes;
  }
  const compatibleVehicleClassIds = Array.isArray(input.compatibleVehicleClassIds)
    ? input.compatibleVehicleClassIds.map((id, i) => assertStable(id, `compatibleVehicleClassIds[${i}]`))
    : [];
  const compatibleAddOnIds = Array.isArray(input.compatibleAddOnIds)
    ? input.compatibleAddOnIds.map((id, i) => assertStable(id, `compatibleAddOnIds[${i}]`))
    : [];
  return {
    siteId: input.siteId,
    packageId: input.packageId,
    legacyKey: assertPlainText(String(input.legacyKey || ''), 'legacyKey', 64),
    category: assertPlainText(String(input.category || ''), 'category', 40),
    name,
    slug,
    description,
    shortDescription,
    active: input.active !== false,
    featured: !!input.featured,
    displayOrder: Number.isInteger(input.displayOrder) ? input.displayOrder : 0,
    durationMinutes,
    features,
    prices,
    compatibleVehicleClassIds,
    compatibleAddOnIds,
  };
}

function validateAddOnDraft(input) {
  rejectUnknown(input, new Set([
    'siteId', 'addOnId', 'legacyKey', 'name', 'slug', 'description', 'active',
    'allowQuantity', 'prices', 'compatibility', 'displayOrder',
  ]));
  assertStable(input.addOnId, 'addOnId');
  const prices = Array.isArray(input.prices) ? input.prices.map((p) => {
    rejectUnknown(p, new Set(['category', 'currency', 'amountCents']));
    return {
      category: assertPlainText(String(p.category || ''), 'category', 40),
      currency: assertCurrency(p.currency),
      amountCents: assertIntegerCents(p.amountCents, 'amountCents'),
    };
  }) : [];
  const compatibility = Array.isArray(input.compatibility) ? input.compatibility.map((c) => {
    rejectUnknown(c, new Set(['category', 'packageId']));
    const row = {};
    if (c.category) row.category = assertPlainText(String(c.category), 'category', 40);
    if (c.packageId) row.packageId = assertStable(c.packageId, 'packageId');
    return row;
  }) : [];
  return {
    siteId: input.siteId,
    addOnId: input.addOnId,
    legacyKey: assertPlainText(String(input.legacyKey || ''), 'legacyKey', 64),
    name: assertPlainText(input.name, 'name', MAX.name),
    slug: assertSlug(input.slug || input.addOnId.replace(/^addon_/, '').replace(/_/g, '-')),
    description: assertPlainText(input.description || '', 'description', MAX.description),
    active: input.active !== false,
    allowQuantity: !!input.allowQuantity,
    displayOrder: Number.isInteger(input.displayOrder) ? input.displayOrder : 0,
    prices,
    compatibility,
  };
}

function validateNavigation(input) {
  rejectUnknown(input, new Set(['siteId', 'headerItems']));
  const headerItems = (input.headerItems || []).map((item, i) => {
    rejectUnknown(item, new Set(['label', 'href', 'sortOrder']));
    return {
      label: assertPlainText(item.label, `headerItems[${i}].label`, MAX.label),
      href: assertSafeUrl(item.href, `headerItems[${i}].href`),
      sortOrder: Number.isInteger(item.sortOrder) ? item.sortOrder : i,
    };
  });
  return { siteId: input.siteId, headerItems };
}

function validateFooter(input) {
  rejectUnknown(input, new Set(['siteId', 'tagline', 'groups', 'legalLinks', 'copyright']));
  const groups = (input.groups || []).map((g, gi) => {
    rejectUnknown(g, new Set(['title', 'links']));
    return {
      title: assertPlainText(g.title, `groups[${gi}].title`, MAX.label),
      links: (g.links || []).map((l, li) => {
        rejectUnknown(l, new Set(['label', 'href']));
        return {
          label: assertPlainText(l.label, `groups[${gi}].links[${li}].label`, MAX.label),
          href: assertSafeUrl(l.href, `groups[${gi}].links[${li}].href`),
        };
      }),
    };
  });
  return {
    siteId: input.siteId,
    tagline: assertPlainText(input.tagline || '', 'tagline', MAX.shortDescription),
    groups,
    legalLinks: (input.legalLinks || []).map((l, i) => ({
      label: assertPlainText(l.label, `legalLinks[${i}].label`, MAX.label),
      href: assertSafeUrl(l.href, `legalLinks[${i}].href`),
    })),
    copyright: assertPlainText(input.copyright || '', 'copyright', MAX.shortDescription),
  };
}

function validatePageContent(input) {
  rejectUnknown(input, new Set([
    'siteId', 'pageId', 'heading', 'subheading', 'body', 'ctas', 'seo',
  ]));
  const ctas = (input.ctas || []).map((c, i) => {
    rejectUnknown(c, new Set(['label', 'href', 'kind']));
    return {
      label: assertPlainText(c.label, `ctas[${i}].label`, MAX.label),
      href: assertSafeUrl(c.href, `ctas[${i}].href`),
      kind: assertPlainText(String(c.kind || 'primary'), 'kind', 32),
    };
  });
  let seo = null;
  if (input.seo) {
    rejectUnknown(input.seo, new Set(['title', 'description', 'canonicalPath', 'ogImageMediaId']));
    seo = {
      title: assertPlainText(input.seo.title || '', 'seo.title', MAX.seoTitle),
      description: assertPlainText(input.seo.description || '', 'seo.description', MAX.seoDescription),
      canonicalPath: input.seo.canonicalPath
        ? assertSafeUrl(input.seo.canonicalPath, 'seo.canonicalPath')
        : '',
      ogImageMediaId: input.seo.ogImageMediaId ? assertStable(input.seo.ogImageMediaId, 'ogImageMediaId') : null,
    };
  }
  return {
    siteId: input.siteId,
    pageId: assertPlainText(String(input.pageId || ''), 'pageId', 80),
    heading: assertPlainText(input.heading || '', 'heading', MAX.name),
    subheading: assertPlainText(input.subheading || '', 'subheading', MAX.shortDescription),
    body: assertPlainText(input.body || '', 'body', MAX.description),
    ctas,
    seo,
  };
}

function validateGallery(input) {
  rejectUnknown(input, new Set(['siteId', 'galleryId', 'items']));
  const items = (input.items || []).map((it, i) => {
    rejectUnknown(it, new Set(['mediaId', 'caption', 'sortOrder']));
    return {
      mediaId: assertStable(it.mediaId, `items[${i}].mediaId`),
      caption: assertPlainText(it.caption || '', `items[${i}].caption`, MAX.alt),
      sortOrder: Number.isInteger(it.sortOrder) ? it.sortOrder : i,
    };
  });
  return { siteId: input.siteId, galleryId: assertPlainText(String(input.galleryId || ''), 'galleryId', 80), items };
}

// A media path is EITHER a site-relative assets/ path OR an https URL — never a
// mixture, and never anything that can climb out of assets/.
//
// The previous check tested for '..' and then re-validated against
// /^assets\/[A-Za-z0-9._\/-]+$/, whose character class contains both '.' and '/'.
// So "assets/../../etc/passwd" matched the inner allowlist and was accepted despite
// the outer test having spotted the traversal. Stage 3 gives operators a media
// library that writes these paths, which is what makes it worth closing now.
const MEDIA_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Checked by code point rather than a regex class: writing a control-character
// range inline is what embedded raw bytes here before.
function hasControlChar(s) {
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) < 32) return true;
  return false;
}

function assertSafeMediaPath(raw) {
  const invalid = () => {
    const err = new Error('invalid_media_path');
    err.code = 'invalid_media_path';
    throw err;
  };
  const path = String(raw || '');
  if (!path) invalid();
  if (SAFE_HTTP_URL_RE.test(path)) return path;          // absolute https, already constrained
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) invalid();       // any other scheme, incl. javascript:/data:
  if (path.startsWith('//') || path.startsWith('/')) invalid();
  if (path.includes('\\') || path.includes('%') || hasControlChar(path)) invalid();

  const segments = path.split('/');
  if (segments[0] !== 'assets' || segments.length < 2) invalid();
  for (const segment of segments) {
    // Rejects '', '.', '..' and anything with a character outside the allowlist,
    // so no segment can traverse and no empty segment can collapse the path.
    if (!MEDIA_SEGMENT_RE.test(segment)) invalid();
  }
  return path;
}

function validateMediaMetadata(input) {
  rejectUnknown(input, new Set([
    'siteId', 'mediaId', 'path', 'alt', 'caption', 'contentType', 'published',
  ]));
  const path = assertSafeMediaPath(assertPlainText(input.path, 'path', MAX.url));
  return {
    siteId: input.siteId,
    mediaId: assertStable(input.mediaId, 'mediaId'),
    path,
    alt: assertPlainText(input.alt || '', 'alt', MAX.alt),
    caption: assertPlainText(input.caption || '', 'caption', MAX.alt),
    contentType: assertPlainText(String(input.contentType || 'image/webp'), 'contentType', 80),
    published: !!input.published,
  };
}

function validateServiceArea(input) {
  rejectUnknown(input, new Set(['siteId', 'serviceAreaId', 'name', 'description', 'href', 'sortOrder']));
  return {
    siteId: input.siteId,
    serviceAreaId: assertPlainText(String(input.serviceAreaId || ''), 'serviceAreaId', 80),
    name: assertPlainText(input.name, 'name', MAX.name),
    description: assertPlainText(input.description || '', 'description', MAX.description),
    href: input.href ? assertSafeUrl(input.href, 'href') : '',
    sortOrder: Number.isInteger(input.sortOrder) ? input.sortOrder : 0,
  };
}

function validateReleaseCandidate(catalogDraft, contentDraft) {
  const errors = [];
  if (!catalogDraft || !Array.isArray(catalogDraft.packages) || catalogDraft.packages.length === 0) {
    errors.push({ code: 'catalog_empty', message: 'Release candidate has no packages' });
  }
  const pkgs = catalogDraft?.packages || [];
  for (const p of pkgs) {
    try {
      validatePackageDraft(p);
    } catch (e) {
      errors.push({ code: e.code || 'package_invalid', message: e.message, packageId: p.packageId });
    }
    if (p.active && (!p.prices || p.prices.length === 0)) {
      errors.push({ code: 'missing_price_coverage', message: 'Active package lacks prices', packageId: p.packageId });
    }
  }
  for (const a of catalogDraft?.addOns || []) {
    try {
      validateAddOnDraft(a);
    } catch (e) {
      errors.push({ code: e.code || 'addon_invalid', message: e.message, addOnId: a.addOnId });
    }
  }
  for (const vc of catalogDraft?.vehicleClasses || []) {
    try {
      validateVehicleClassDraft(vc);
    } catch (e) {
      errors.push({ code: e.code || 'vehicle_class_invalid', message: e.message, vehicleClassId: vc.vehicleClassId });
    }
  }
  if (contentDraft?.navigation) {
    try { validateNavigation(contentDraft.navigation); } catch (e) {
      errors.push({ code: e.code || 'navigation_invalid', message: e.message });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Full Stage 2 catalog draft validation (authoritative for Save Draft).
 */
function validateCompleteCatalogDraft(input, options = {}) {
  const maxBytes = options.maxBytes || 1_500_000;
  const serialized = JSON.stringify(input || {});
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    const err = new Error('payload_too_large');
    err.code = 'payload_too_large';
    err.statusCode = 413;
    throw err;
  }
  rejectUnknown(input, new Set([
    // `draftId` is a server-emitted echo field returned by sanitizeDraftResponse. It is
    // tolerated here (and discarded below — never trusted) so the read shape round-trips
    // safely through Save Draft. Without it, every UI save fails with unknown_field:draftId.
    'siteId', 'draftId', 'status', 'draftVersion', 'version', 'packages', 'addOns', 'vehicleClasses',
    'navigation', 'footer', 'pages', 'galleries', 'serviceAreas', 'media',
    'priceConflicts', 'unmappedContent', 'updatedAt', 'updatedBy', 'lastSavedAt', 'lastSavedBy',
  ]));
  if (!SITE_ID_RE.test(String(input.siteId || ''))) {
    const err = new Error('invalid_site_id');
    err.code = 'invalid_site_id';
    throw err;
  }
  const siteId = input.siteId;
  const packages = (input.packages || []).map(validatePackageDraft);
  const addOns = (input.addOns || []).map(validateAddOnDraft);
  const vehicleClasses = (input.vehicleClasses || []).map(validateVehicleClassDraft);

  const pkgIds = new Set();
  for (const p of packages) {
    if (pkgIds.has(p.packageId)) {
      const err = new Error('duplicate_package_id');
      err.code = 'duplicate_stable_id';
      err.field = 'packageId';
      throw err;
    }
    pkgIds.add(p.packageId);
  }
  const addOnIds = new Set();
  for (const a of addOns) {
    if (addOnIds.has(a.addOnId)) {
      const err = new Error('duplicate_addon_id');
      err.code = 'duplicate_stable_id';
      err.field = 'addOnId';
      throw err;
    }
    addOnIds.add(a.addOnId);
  }
  const vcIds = new Set();
  for (const vc of vehicleClasses) {
    if (vcIds.has(vc.vehicleClassId)) {
      const err = new Error('duplicate_vehicle_class_id');
      err.code = 'duplicate_stable_id';
      err.field = 'vehicleClassId';
      throw err;
    }
    vcIds.add(vc.vehicleClassId);
  }

  for (const p of packages) {
    for (const id of p.compatibleVehicleClassIds || []) {
      if (!vcIds.has(id)) {
        const err = new Error(`missing_vehicle_class_ref:${id}`);
        err.code = 'missing_entity_reference';
        err.field = 'compatibleVehicleClassIds';
        throw err;
      }
    }
    for (const id of p.compatibleAddOnIds || []) {
      if (!addOnIds.has(id)) {
        const err = new Error(`missing_addon_ref:${id}`);
        err.code = 'missing_entity_reference';
        err.field = 'compatibleAddOnIds';
        throw err;
      }
    }
    for (const price of p.prices || []) {
      if (price.vehicleClassId && !vcIds.has(price.vehicleClassId)) {
        const err = new Error(`missing_price_vehicle_class:${price.vehicleClassId}`);
        err.code = 'missing_entity_reference';
        err.field = 'prices.vehicleClassId';
        throw err;
      }
    }
  }

  const priceConflicts = Array.isArray(input.priceConflicts) ? input.priceConflicts.map((c) => {
    rejectUnknown(c, new Set([
      'conflictId', 'entityType', 'entityId', 'field', 'serverValue', 'presentationValue',
      'serverCents', 'presentationCents', 'sources', 'status', 'resolution', 'resolvedBy', 'resolvedAt',
      'file', 'htmlValue', 'message',
    ]));
    const status = String(c.status || 'unresolved');
    if (!['unresolved', 'resolved-in-draft'].includes(status)) {
      const err = new Error('invalid_conflict_status');
      err.code = 'invalid_conflict_status';
      throw err;
    }
    return {
      conflictId: assertPlainText(String(c.conflictId || `${c.file || 'x'}:${c.field || 'f'}`), 'conflictId', 160),
      entityType: assertPlainText(String(c.entityType || 'package_price'), 'entityType', 40),
      entityId: c.entityId ? assertPlainText(String(c.entityId), 'entityId', 80) : null,
      field: assertPlainText(String(c.field || ''), 'field', 120),
      serverValue: c.serverValue != null ? Number(c.serverValue) : null,
      presentationValue: c.presentationValue != null ? Number(c.presentationValue) : (c.htmlValue != null ? Number(c.htmlValue) : null),
      serverCents: c.serverCents != null ? assertIntegerCents(c.serverCents, 'serverCents') : null,
      presentationCents: c.presentationCents != null ? assertIntegerCents(c.presentationCents, 'presentationCents') : null,
      sources: Array.isArray(c.sources)
        ? c.sources.map((s, i) => assertPlainText(String(s), `sources[${i}]`, 200))
        : (c.file ? [assertPlainText(String(c.file), 'file', 200)] : []),
      status,
      resolution: c.resolution ? assertPlainText(String(c.resolution), 'resolution', 80) : null,
      resolvedBy: c.resolvedBy ? assertPlainText(String(c.resolvedBy), 'resolvedBy', 80) : null,
      resolvedAt: c.resolvedAt ? assertPlainText(String(c.resolvedAt), 'resolvedAt', 40) : null,
      message: c.message ? assertPlainText(String(c.message), 'message', 280) : '',
    };
  }) : [];

  const unmappedContent = Array.isArray(input.unmappedContent) ? input.unmappedContent.map((u, i) => {
    rejectUnknown(u, new Set(['path', 'reason', 'contentClass']));
    return {
      path: assertPlainText(String(u.path || ''), `unmapped[${i}].path`, 200),
      reason: assertPlainText(String(u.reason || ''), `unmapped[${i}].reason`, 280),
      contentClass: u.contentClass ? assertPlainText(String(u.contentClass), 'contentClass', 80) : null,
    };
  }) : [];

  const navigation = input.navigation
    ? validateNavigation({ ...input.navigation, siteId })
    : { siteId, headerItems: [] };
  const footer = input.footer
    ? validateFooter({ ...input.footer, siteId })
    : { siteId, tagline: '', groups: [], legalLinks: [], copyright: '' };
  const pages = (input.pages || []).map((p) => validatePageContent({ ...p, siteId }));

  return {
    siteId,
    status: 'draft',
    packages,
    addOns,
    vehicleClasses,
    navigation,
    footer,
    pages,
    galleries: input.galleries || [],
    serviceAreas: input.serviceAreas || [],
    media: input.media || [],
    priceConflicts,
    unmappedContent,
  };
}

module.exports = {
  MAX,
  UNSAFE_CONTENT_RE,
  rejectUnknown,
  assertPlainText,
  assertSafeUrl,
  assertSlug,
  validatePackageDraft,
  validatePackagePrice,
  validateAddOnDraft,
  validateVehicleClassDraft,
  validateNavigation,
  validateFooter,
  validatePageContent,
  validateGallery,
  validateMediaMetadata,
  validateServiceArea,
  validateReleaseCandidate,
  validateCompleteCatalogDraft,
};
