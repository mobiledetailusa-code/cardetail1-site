#!/usr/bin/env node
/**
 * Manual IndexNow submission for cardetail1.com (Bing, Yandex, Seznam, Naver…).
 *
 * Run it by hand AFTER a production deploy is live. It is not wired into the
 * build, adds no Function and schedules nothing.
 *
 *   node scripts/indexnow-submit.js --changed-since <deployed-commit>   # dry run
 *   node scripts/indexnow-submit.js --changed-since <deployed-commit> --submit
 *   node scripts/indexnow-submit.js --url https://cardetail1.com/mahwah-mobile-detailing --submit
 *   node scripts/indexnow-submit.js --all            # every sitemap URL (use rarely)
 *
 * Safety rules:
 *  - Only URLs listed in sitemap.xml are submitted as new/changed. Admin,
 *    portal, template and other non-indexable pages are never in the sitemap,
 *    and robots.txt Disallow rules are checked again on top of that.
 *  - A removed URL is submitted only if it is outside the sitemap and the live
 *    site answers 404 or 410 for it.
 *  - --submit first checks that the live key file matches the committed key,
 *    and that every changed URL answers 200. Without --submit nothing leaves
 *    this machine.
 * See docs/seo/indexnow.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST = 'cardetail1.com';
const ORIGIN = `https://${HOST}`;
const KEY = '4928f243e82d24fa6968f4e19e34171c';
const KEY_LOCATION = `${ORIGIN}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS = 10000;

function parseSitemap(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim());
}

/** robots.txt Disallow patterns for the `User-agent: *` group, as RegExps. */
function parseDisallow(robots) {
  const rules = [];
  let star = false;
  let inAgents = false;
  for (const raw of String(robots).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!inAgents) star = false;
      inAgents = true;
      if (val === '*') star = true;
      continue;
    }
    inAgents = false;
    if (star && key === 'disallow' && val) {
      const re = '^' + val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
      rules.push(new RegExp(re));
    }
  }
  return rules;
}

function isDisallowed(url, rules) {
  const u = new URL(url);
  const p = u.pathname + u.search;
  return rules.some((re) => re.test(p));
}

/** Root page file (e.g. "mahwah-mobile-detailing.html") → public pretty URL. */
function urlForFile(file) {
  const rel = String(file).replace(/\\/g, '/');
  if (rel.includes('/') || !rel.endsWith('.html')) return null;
  const stem = rel.slice(0, -'.html'.length);
  return stem === 'index' ? `${ORIGIN}/` : `${ORIGIN}/${stem}`;
}

function sameHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === HOST;
  } catch {
    return false;
  }
}

/**
 * Decide what to submit. Pure: no I/O.
 * @returns {{ changed: string[], removed: string[], skipped: {url: string, reason: string}[] }}
 */
function buildPlan({ sitemapUrls, disallow = [], changedFiles = [], deletedFiles = [], urls = [], removedUrls = [], all = false }) {
  const inSitemap = new Set(sitemapUrls);
  const changed = new Set();
  const removed = new Set();
  const skipped = [];
  const candidates = [
    ...(all ? sitemapUrls : []),
    ...changedFiles.map(urlForFile).filter(Boolean),
    ...urls,
  ];
  for (const url of candidates) {
    if (!sameHost(url)) skipped.push({ url, reason: 'not https://cardetail1.com' });
    else if (!inSitemap.has(url)) skipped.push({ url, reason: 'not in sitemap.xml' });
    else if (isDisallowed(url, disallow)) skipped.push({ url, reason: 'disallowed by robots.txt' });
    else changed.add(url);
  }
  for (const url of [...deletedFiles.map(urlForFile).filter(Boolean), ...removedUrls]) {
    if (!sameHost(url)) skipped.push({ url, reason: 'not https://cardetail1.com' });
    else if (inSitemap.has(url)) skipped.push({ url, reason: 'still in sitemap.xml; not removed' });
    else if (isDisallowed(url, disallow)) skipped.push({ url, reason: 'disallowed by robots.txt' });
    else removed.add(url);
  }
  return { changed: [...changed], removed: [...removed], skipped };
}

function payload(urlList) {
  return { host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList };
}

function gitNames(ref, filter) {
  const out = execFileSync('git', ['diff', '--name-only', `--diff-filter=${filter}`, `${ref}..HEAD`], { cwd: ROOT, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

function parseArgs(argv) {
  const a = { urls: [], removedUrls: [], submit: false, all: false, since: null };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--submit') a.submit = true;
    else if (v === '--all') a.all = true;
    else if (v === '--changed-since') a.since = argv[++i];
    else if (v === '--url') a.urls.push(argv[++i]);
    else if (v === '--removed') a.removedUrls.push(argv[++i]);
    else throw new Error(`unknown argument: ${v}`);
  }
  return a;
}

async function liveStatus(url) {
  const res = await fetch(url, { method: 'GET', redirect: 'manual' });
  return res.status;
}

async function main(argv) {
  const args = parseArgs(argv);
  const sitemapUrls = parseSitemap(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8'));
  const disallow = parseDisallow(fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8'));
  const changedFiles = args.since ? gitNames(args.since, 'AMR') : [];
  const deletedFiles = args.since ? gitNames(args.since, 'D') : [];
  const plan = buildPlan({ sitemapUrls, disallow, changedFiles, deletedFiles, urls: args.urls, removedUrls: args.removedUrls, all: args.all });

  for (const s of plan.skipped) console.log(`skip    ${s.url} (${s.reason})`);
  for (const u of plan.changed) console.log(`changed ${u}`);
  for (const u of plan.removed) console.log(`removed ${u}`);
  if (!plan.changed.length && !plan.removed.length) {
    console.log('Nothing to submit.');
    return 0;
  }
  if (!args.submit) {
    console.log('\nDry run. Add --submit after the deploy is live to send:');
    console.log(JSON.stringify(payload([...plan.changed, ...plan.removed]), null, 2));
    return 0;
  }

  const keyRes = await fetch(KEY_LOCATION);
  const liveKey = keyRes.ok ? (await keyRes.text()).trim() : '';
  if (liveKey !== KEY) {
    console.error(`Key file ${KEY_LOCATION} is not live (HTTP ${keyRes.status}). Deploy it first.`);
    return 1;
  }
  const urlList = [];
  for (const u of plan.changed) {
    const s = await liveStatus(u);
    if (s === 200) urlList.push(u);
    else console.log(`skip    ${u} (live HTTP ${s}, expected 200)`);
  }
  for (const u of plan.removed) {
    const s = await liveStatus(u);
    if (s === 404 || s === 410) urlList.push(u);
    else console.log(`skip    ${u} (live HTTP ${s}, expected 404/410)`);
  }
  if (!urlList.length) {
    console.log('Nothing left to submit after live checks.');
    return 0;
  }
  if (urlList.length > MAX_URLS) throw new Error(`IndexNow accepts at most ${MAX_URLS} URLs per request`);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload(urlList)),
  });
  console.log(`IndexNow answered HTTP ${res.status} for ${urlList.length} URL(s).`);
  // 200 = accepted, 202 = accepted, key validation pending.
  return res.status === 200 || res.status === 202 ? 0 : 1;
}

module.exports = { KEY, KEY_LOCATION, HOST, parseSitemap, parseDisallow, isDisallowed, urlForFile, buildPlan, payload, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
