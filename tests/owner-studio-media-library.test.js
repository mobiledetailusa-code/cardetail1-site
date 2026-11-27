'use strict';

/**
 * Stage 3 — Media Library: path safety and reference integrity.
 *
 * Two of the migration risks the roadmap names for this stage are path traversal
 * and orphan files. These cover both, on the pure layer, before any upload or blob
 * storage is wired.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateMediaMetadata } = require('../netlify/lib/owner-studio/schemas');
const {
  collectMediaReferences, auditMedia, planMediaDeletion, publishableMedia,
} = require('../netlify/lib/owner-studio/media/media-references');

const media = (path) => validateMediaMetadata({ siteId: 'detailing-zone', mediaId: 'media_x', path });
const rejects = (path) => assert.throws(() => media(path), (e) => e.code === 'invalid_media_path', path);

describe('media paths cannot climb out of assets/', () => {
  it('accepts an ordinary site-relative asset', () => {
    assert.equal(media('assets/photos/car-01.webp').path, 'assets/photos/car-01.webp');
    assert.equal(media('assets/ok_file-1.webp').path, 'assets/ok_file-1.webp');
  });

  it('accepts an https URL', () => {
    assert.equal(media('https://cdn.example.com/a.webp').path, 'https://cdn.example.com/a.webp');
  });

  /**
   * Regression. The previous check tested for '..' and then re-validated against
   * /^assets\/[A-Za-z0-9._\/-]+$/ — a class containing both '.' and '/', so
   * "assets/../../etc/passwd" matched the allowlist and was ACCEPTED despite the
   * traversal having been spotted.
   */
  it('rejects traversal that the old allowlist let through', () => {
    rejects('assets/../../etc/passwd');
    rejects('assets/../secret');
    rejects('assets/a/../../../b.webp');
    rejects('assets/./x.webp');
  });

  it('rejects paths that do not start inside assets/', () => {
    rejects('../../etc/passwd');
    rejects('/etc/passwd');
    rejects('//evil.example/x.webp');
    rejects('other/photos/x.webp');
    rejects('assets');
  });

  it('rejects non-https schemes outright', () => {
    rejects('http://cdn.example.com/a.webp');
    rejects('file:///etc/passwd');
    // javascript: and data:text/html are caught earlier, by the shared unsafe-content
    // guard in assertPlainText. Which guard fires first is an implementation detail;
    // that they never reach a media path is the property.
    for (const scheme of ['javascript:alert(1)', 'data:text/html,<script>']) {
      assert.throws(() => media(scheme), (e) => e.code === 'unsafe_content' || e.code === 'invalid_media_path', scheme);
    }
  });

  it('rejects backslashes, percent-encoding and empty segments', () => {
    rejects('assets\\photos\\x.webp');
    rejects('assets/..%2f..%2fetc');
    rejects('assets//x.webp');
    rejects('assets/');
  });

  it('rejects an empty path', () => {
    rejects('');
  });
});

function draft(over = {}) {
  return Object.assign({
    galleries: [{ galleryId: 'gal_home', items: [{ mediaId: 'media_hero' }, { mediaId: 'media_two' }] }],
    pages: [{ pageId: 'page_home', heroMediaId: 'media_hero' }],
    packages: [{ packageId: 'pkg_full', coverMediaId: 'media_cover' }],
  }, over);
}

const asset = (mediaId, over = {}) => Object.assign({ mediaId, published: true, archivedAt: null }, over);

describe('references are collected from everywhere a draft can point', () => {
  it('finds gallery items, page heroes and package covers', () => {
    const refs = collectMediaReferences(draft());
    assert.deepEqual([...refs.keys()].sort(), ['media_cover', 'media_hero', 'media_two']);
    assert.equal(refs.get('media_hero').length, 2, 'referenced by both a gallery and a page');
    assert.deepEqual(refs.get('media_cover'), [{ kind: 'package', ownerId: 'pkg_full', field: 'coverMediaId' }]);
  });

  it('returns nothing for an empty draft rather than throwing', () => {
    assert.equal(collectMediaReferences({}).size, 0);
    assert.equal(collectMediaReferences(null).size, 0);
  });
});

describe('the audit separates in-use from orphaned and dangling', () => {
  it('classifies an inventory against the draft', () => {
    const out = auditMedia(draft(), [
      asset('media_hero'), asset('media_two'), asset('media_cover'),
      asset('media_unused'), asset('media_old', { archivedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    assert.deepEqual(out.referenced, ['media_cover', 'media_hero', 'media_two']);
    assert.deepEqual(out.orphans, ['media_old', 'media_unused']);
    assert.deepEqual(out.archived, ['media_old']);
    assert.deepEqual(out.dangling, []);
  });

  /** A draft pointing at a missing asset renders as a broken image; report it. */
  it('reports a reference to an asset that does not exist', () => {
    const out = auditMedia(draft(), [asset('media_hero')]);
    assert.equal(out.dangling.length, 2);
    assert.deepEqual(out.dangling.map((d) => d.mediaId), ['media_cover', 'media_two']);
    assert.equal(out.dangling[0].referencedBy[0].kind, 'package');
  });
});

describe('a referenced asset is never hard-deleted', () => {
  it('archives instead of destroying when something points at it', () => {
    const plan = planMediaDeletion('media_hero', draft(), [asset('media_hero')]);
    assert.equal(plan.action, 'archive');
    assert.equal(plan.reason, 'referenced');
    assert.equal(plan.referencedBy.length, 2, 'the caller can name what is still using it');
  });

  it('allows a hard delete only for an orphan', () => {
    const plan = planMediaDeletion('media_unused', draft(), [asset('media_unused')]);
    assert.equal(plan.action, 'hard_delete');
    assert.equal(plan.reason, 'orphan');
  });

  it('allows a hard delete for an already-archived orphan', () => {
    const plan = planMediaDeletion('media_old', draft(), [asset('media_old', { archivedAt: '2026-01-01T00:00:00.000Z' })]);
    assert.equal(plan.action, 'hard_delete');
    assert.equal(plan.reason, 'archived_orphan');
  });

  it('archives an archived asset that is still referenced — archiving is not enough', () => {
    const plan = planMediaDeletion('media_hero', draft(), [asset('media_hero', { archivedAt: '2026-01-01T00:00:00.000Z' })]);
    assert.equal(plan.action, 'archive', 'still in use, so still not destroyable');
  });

  it('is a no-op for an unknown id rather than an error', () => {
    assert.deepEqual(planMediaDeletion('media_nope', draft(), []),
      { action: 'noop', reason: 'not_found', referencedBy: [] });
  });
});

describe('only published, referenced, unarchived media may be snapshotted', () => {
  const inventory = [
    asset('media_hero'),
    asset('media_two', { published: false }),
    asset('media_cover', { archivedAt: '2026-01-01T00:00:00.000Z' }),
    asset('media_unused'),
  ];

  it('excludes unpublished, archived and unreferenced assets', () => {
    assert.deepEqual(publishableMedia(draft(), inventory), ['media_hero']);
  });

  it('never includes an asset the library would refuse to serve', () => {
    const out = publishableMedia(draft(), inventory);
    assert.equal(out.includes('media_two'), false, 'unpublished');
    assert.equal(out.includes('media_cover'), false, 'archived');
    assert.equal(out.includes('media_unused'), false, 'unreferenced');
  });
});
