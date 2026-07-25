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
const SAFE_PATH_RE = /^\/[A-Za-z0-9._~/-]*$/;
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

function validatePackageDraft(input) {
  rejectUnknown(input, new Set([
    'siteId', 'packageId', 'legacyKey', 'category', 'name', 'slug', 'description',
    'shortDescription', 'active', 'featured', 'displayOrder', 'durationMinutes',
    'features', 'prices',
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
  };
}

function validateAddOnDraft(input) {
  rejectUnknown(input, new Set([
    'siteId', 'addOnId', 'legacyKey', 'name', 'slug', 'description', 'active',
    'allowQuantity', 'prices', 'compatibility',
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

function validateMediaMetadata(input) {
  rejectUnknown(input, new Set([
    'siteId', 'mediaId', 'path', 'alt', 'caption', 'contentType', 'published',
  ]));
  const path = assertPlainText(input.path, 'path', MAX.url);
  if (path.includes('..') || path.includes('\\') || /^(https?:)?\/\//i.test(path) === false && !path.startsWith('assets/')) {
    // allow assets/ relative or https URLs
    if (!SAFE_HTTP_URL_RE.test(path) && !/^assets\/[A-Za-z0-9._/-]+$/.test(path)) {
      const err = new Error('invalid_media_path');
      err.code = 'invalid_media_path';
      throw err;
    }
  }
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
  if (contentDraft?.navigation) {
    try { validateNavigation(contentDraft.navigation); } catch (e) {
      errors.push({ code: e.code || 'navigation_invalid', message: e.message });
    }
  }
  return { ok: errors.length === 0, errors };
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
  validateNavigation,
  validateFooter,
  validatePageContent,
  validateGallery,
  validateMediaMetadata,
  validateServiceArea,
  validateReleaseCandidate,
};
