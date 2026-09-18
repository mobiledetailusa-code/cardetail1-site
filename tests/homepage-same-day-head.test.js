'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

describe('homepage head signals same-day availability', () => {
  it('availability banner reinforces same-day with honest 2-hour lead copy', () => {
    assert.match(html, /<h3>Same-day when slots remain<\/h3>/);
    assert.match(html, /about 2 hours' notice/);
    assert.match(html, /class="sdb">Same-day available<\/div>/);
  });

  it('booking schedule notice stays aligned with same-day claim', () => {
    assert.match(
      html,
      /Same-day appointments may be available\. Remaining slots open with about 2 hours' notice\./
    );
  });
});
