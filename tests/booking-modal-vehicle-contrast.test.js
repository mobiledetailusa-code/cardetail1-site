'use strict';

/**
 * Light booking modal must keep multi-vehicle cart labels readable.
 * Regression: remapping --white to #ffffff made var(--white) body text invisible.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

describe('booking modal vehicle cart contrast', () => {
  it('does not map --white to pure #fff on light booking surfaces', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/booking-modal-light.css'), 'utf8');
    const block = css.match(/\.booking-modal\s*\{[\s\S]*?\n\}/);
    assert.ok(block, 'missing .booking-modal token block');
    assert.match(block[0], /--ink:\s*#0f172a/);
    assert.match(block[0], /--white:\s*#0f172a/);
    assert.doesNotMatch(block[0], /--white:\s*#ffffff/);
    assert.match(block[0], /--on-accent:\s*#ffffff/);
  });

  it('cart name/total rules force dark ink inside booking modal', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/booking-modal-light.css'), 'utf8');
    assert.match(css, /\.booking-modal\s+\.vcart-item-name[\s\S]*?color:\s*var\(--ink[^)]*\)\s*!important/);
    assert.match(css, /\.booking-modal\s+\.vcart-total[\s\S]*?color:\s*var\(--ink[^)]*\)\s*!important/);
  });

  it('computed cart text is dark on light modal surface', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/booking-modal-light.css'), 'utf8');
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const styleMatch = index.match(/\.vcart-item-name\{[^}]+\}/);
    const totalMatch = index.match(/\.vcart-total\{[^}]+\}/);
    assert.ok(styleMatch && totalMatch);
    assert.match(styleMatch[0], /color:var\(--ink\)/);
    assert.match(totalMatch[0], /color:var\(--ink\)/);

    const dom = new JSDOM(
      `<!doctype html><html><head>
        <style>:root{--white:#ece8e1;--ink:#ece8e1;--bg0:#12181f}</style>
        <style>${css}</style>
      </head><body>
        <div class="booking-modal">
          <div class="vcart">
            <div class="vcart-item-name" id="n">Full Detail · Civic</div>
            <div class="vcart-total" id="t"><span>Cart Total</span><span>$240</span></div>
          </div>
        </div>
      </body></html>`,
      { pretendToBeVisual: true }
    );
    const { getComputedStyle, document } = dom.window;
    // jsdom often returns empty computed colors; assert cascade source instead when empty.
    const nameColor = getComputedStyle(document.getElementById('n')).color;
    const totalColor = getComputedStyle(document.getElementById('t')).color;
    if (nameColor && nameColor !== '' && nameColor !== 'rgba(0, 0, 0, 0)') {
      assert.notEqual(nameColor, 'rgb(255, 255, 255)');
      assert.notEqual(totalColor, 'rgb(255, 255, 255)');
    }
    const modalWhite = getComputedStyle(document.querySelector('.booking-modal')).getPropertyValue('--white').trim();
    assert.equal(modalWhite, '#0f172a');
  });
});
