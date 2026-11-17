/**
 * The one Cardetail1 business entity (schema.org LocalBusiness, @id /#business).
 *
 * Source of truth: the LocalBusiness node in index.html JSON-LD. Every other
 * public page that defines the same @id must carry an identical copy, so search
 * engines and AI systems see one consistent identity (name, phone, address,
 * areaServed, offers) instead of per-page variants.
 *
 * areaServed lists only the standard service area: places whose ZIPs resolve to
 * the no-fee zone in netlify/lib/travel-fee.js. Extended areas (distance fee,
 * cross-Hudson surcharge, or quote) are not named in the entity.
 *
 * Page-specific geography belongs in a page's own Service node, never in a
 * redefinition of /#business.
 */
import fs from 'node:fs';
import path from 'node:path';

export const BUSINESS_ID = 'https://cardetail1.com/#business';

const BLOCK_RE = /(<script type="application\/ld\+json">\n)([\s\S]*?)(\n<\/script>)/g;

const typesOf = (node) => [].concat((node && node['@type']) || []);

/** A node that defines the business (not a bare { "@id" } reference). */
export function definesBusiness(node) {
  return !!node && typeof node === 'object' && node['@id'] === BUSINESS_ID
    && typesOf(node).includes('LocalBusiness');
}

/** Parse every JSON-LD block of an LF-normalized HTML string. */
export function jsonLdBlocks(src) {
  const out = [];
  for (const m of src.matchAll(BLOCK_RE)) {
    out.push({ match: m[0], open: m[1], body: m[2], close: m[3], data: JSON.parse(m[2]) });
  }
  return out;
}

/** The canonical business node from index.html, without @context. */
export function loadCanonicalBusiness(root) {
  const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const found = [];
  for (const block of jsonLdBlocks(src)) {
    const nodes = block.data['@graph'] || [block.data];
    for (const n of nodes) if (definesBusiness(n)) found.push(n);
  }
  if (found.length !== 1) throw new Error(`index.html must define ${BUSINESS_ID} exactly once (found ${found.length})`);
  const { '@context': _ctx, ...node } = found[0];
  if (!Array.isArray(node.areaServed) || !node.areaServed.length) throw new Error('canonical areaServed is empty');
  return node;
}

/**
 * Replace every /#business definition in an LF-normalized page with the canonical
 * node. Other nodes keep their content. Returns { src, changed }.
 * Throws if a block that defines the business is not canonical 2-space JSON,
 * so a rewrite can never silently reformat hand-written markup.
 */
export function syncBusinessEntity(src, canonical, label = 'page') {
  let changed = 0;
  const next = src.replace(BLOCK_RE, (whole, open, body, close) => {
    const data = JSON.parse(body);
    const graph = Array.isArray(data['@graph']);
    const nodes = graph ? data['@graph'] : [data];
    if (!nodes.some(definesBusiness)) return whole;
    if (JSON.stringify(data, null, 2) !== body) {
      throw new Error(`${label}: JSON-LD block defining ${BUSINESS_ID} is not canonical JSON; refusing to rewrite`);
    }
    let out;
    if (graph) {
      out = { ...data, '@graph': data['@graph'].map((n) => (definesBusiness(n) ? { ...canonical } : n)) };
    } else {
      out = { '@context': data['@context'] || 'https://schema.org', ...canonical };
    }
    const text = JSON.stringify(out, null, 2);
    if (text === body) return whole;
    changed += 1;
    return `${open}${text}${close}`;
  });
  return { src: next, changed };
}
