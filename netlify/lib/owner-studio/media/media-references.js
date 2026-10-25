'use strict';

/**
 * Owner Studio — Media Library reference integrity (Stage 3).
 *
 * Pure: given a draft and a media inventory, it says which assets are in use, which
 * are orphans, and what deleting one is allowed to mean. No IO, no blob storage, no
 * database — the storage half of Stage 3 builds on this, not the other way round.
 *
 * The rule this exists to enforce, from the roadmap: **an asset that is referenced
 * is never hard-deleted.** Deleting the file out from under a page that points at it
 * turns a marketing image into a broken one on the public site, and there is no undo
 * for a blob that is gone. Referenced assets archive; only orphans may be destroyed.
 */

/** Every place a draft can point at a media asset. */
const REFERENCE_SOURCES = [
  { kind: 'gallery', collection: 'galleries', idField: 'galleryId' },
  { kind: 'page', collection: 'pages', idField: 'pageId' },
];

function pushRef(map, mediaId, ref) {
  if (!mediaId) return;
  if (!map.has(mediaId)) map.set(mediaId, []);
  map.get(mediaId).push(ref);
}

/**
 * Walk a draft and collect every media reference.
 *
 * @returns {Map<string, Array<{kind:string, ownerId:string, field:string}>>}
 */
function collectMediaReferences(draft) {
  const refs = new Map();
  const d = draft || {};

  for (const source of REFERENCE_SOURCES) {
    for (const owner of d[source.collection] || []) {
      if (!owner) continue;
      const ownerId = String(owner[source.idField] || '');

      // Galleries reference through an items[] list.
      for (const item of owner.items || []) {
        if (item) pushRef(refs, item.mediaId, { kind: source.kind, ownerId, field: 'items[].mediaId' });
      }
      // Pages (and anything else) may carry a single hero/cover reference.
      for (const field of ['heroMediaId', 'coverMediaId', 'mediaId']) {
        if (owner[field]) pushRef(refs, owner[field], { kind: source.kind, ownerId, field });
      }
    }
  }

  // Packages may carry a cover image once the content editor lands; reading it here
  // means a package cover cannot be deleted the day that field starts being written.
  for (const pkg of d.packages || []) {
    if (pkg && pkg.coverMediaId) {
      pushRef(refs, pkg.coverMediaId, { kind: 'package', ownerId: String(pkg.packageId || ''), field: 'coverMediaId' });
    }
  }

  return refs;
}

function isArchived(asset) {
  return !!(asset && asset.archivedAt);
}

/**
 * Classify an inventory against a draft.
 *
 * `dangling` is the case worth acting on: a draft pointing at a media id that does
 * not exist. It is reported rather than ignored because it renders as a broken
 * image, and because it is the shape a bad import or a hand-edited draft produces.
 */
function auditMedia(draft, inventory) {
  const refs = collectMediaReferences(draft);
  const assets = inventory || [];
  const byId = new Map(assets.map((a) => [a && a.mediaId, a]));

  const referenced = [];
  const orphans = [];
  for (const asset of assets) {
    if (!asset || !asset.mediaId) continue;
    (refs.has(asset.mediaId) ? referenced : orphans).push(asset.mediaId);
  }

  const dangling = [];
  for (const [mediaId, where] of refs) {
    if (!byId.has(mediaId)) dangling.push({ mediaId, referencedBy: where });
  }

  return {
    referenced: referenced.sort(),
    orphans: orphans.sort(),
    dangling: dangling.sort((a, b) => (a.mediaId < b.mediaId ? -1 : 1)),
    archived: assets.filter(isArchived).map((a) => a.mediaId).sort(),
  };
}

/**
 * Decide what deleting an asset may do. Never performs the deletion.
 *
 * @returns {{action:'hard_delete'|'archive'|'noop', reason:string, referencedBy:Array}}
 */
function planMediaDeletion(mediaId, draft, inventory) {
  const id = String(mediaId || '');
  const asset = (inventory || []).find((a) => a && a.mediaId === id);
  if (!asset) return { action: 'noop', reason: 'not_found', referencedBy: [] };

  const referencedBy = collectMediaReferences(draft).get(id) || [];
  if (referencedBy.length) {
    // Archiving keeps the bytes and the row; the asset simply stops being offered
    // for new use. Callers must not treat this as a failure — it is the safe outcome.
    return { action: 'archive', reason: 'referenced', referencedBy };
  }
  if (isArchived(asset)) return { action: 'hard_delete', reason: 'archived_orphan', referencedBy: [] };
  return { action: 'hard_delete', reason: 'orphan', referencedBy: [] };
}

/**
 * Media that may appear in a published snapshot: published, not archived, and not
 * dangling. Mirrors the release-repository filter so a snapshot can never carry an
 * asset the library would refuse to serve.
 */
function publishableMedia(draft, inventory) {
  const refs = collectMediaReferences(draft);
  return (inventory || [])
    .filter((a) => a && a.mediaId && a.published === true && !isArchived(a))
    .filter((a) => refs.has(a.mediaId))
    .map((a) => a.mediaId)
    .sort();
}

module.exports = {
  collectMediaReferences,
  auditMedia,
  planMediaDeletion,
  publishableMedia,
};
