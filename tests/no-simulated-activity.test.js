'use strict';

// Regression: 13 public pages shipped a never-called "dispatch radar" that
// fabricated live jobs (RADAR_JOBS with named customers and "12 min ago",
// plus a random job spawner). It rendered nothing (no #radar-screen element,
// renderDispatchRadar never called), but one wiring change would have shown
// invented commercial activity. Public pages must not carry that code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));

const FABRICATION = [
  /\bRADAR_JOBS\b/,
  /\bSIM_NAMES\b/,
  /\bspawnNewJob\b/,
  /\brenderDispatchRadar\b/,
  /\b_fbHandleJob\b/,
  /timeAgo:\s*'\d+ (?:min|hrs?) ago'/,
];

test('no public page carries the simulated dispatch activity', () => {
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    for (const re of FABRICATION) assert.doesNotMatch(html, re, `${page} still contains ${re}`);
  }
});

test('pages that call renderActivityFeed() still define it and their inline scripts parse', () => {
  let checked = 0;
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    if (!/\brenderActivityFeed\(\);/.test(html)) continue;
    checked += 1;
    assert.match(html, /function renderActivityFeed\(\)/, `${page} lost the renderActivityFeed stub`);
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new vm.Script(m[1], { filename: page }), `${page} inline script no longer parses`);
    }
  }
  assert.ok(checked >= 13, `expected the 13 booking pages, saw ${checked}`);
});
