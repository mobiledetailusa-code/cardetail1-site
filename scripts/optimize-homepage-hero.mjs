#!/usr/bin/env node
/**
 * Rebuild homepage hero WebP/AVIF variants from a source PNG.
 *
 * Usage:
 *   node scripts/optimize-homepage-hero.mjs [path/to/source.png]
 *
 * Defaults to assets/hero/homepage-hero-source.png when present.
 * Does not upscale past the source width. Desktop targets stay in the
 * 1600–1920 band when the source allows; mobile is a separate right-weighted crop.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'assets', 'hero');
const defaultSrc = path.join(outDir, 'homepage-hero-source.png');
const src = path.resolve(process.argv[2] || defaultSrc);

async function writeSized(pipeline, base, width, { webpQ, avifQ }) {
  const img = pipeline.clone().resize({ width, withoutEnlargement: true });
  const webp = path.join(outDir, `${base}-${width}.webp`);
  const avif = path.join(outDir, `${base}-${width}.avif`);
  await img.clone().webp({ quality: webpQ, effort: 6 }).toFile(webp);
  await img.clone().avif({ quality: avifQ, effort: 6 }).toFile(avif);
  const dim = await sharp(webp).metadata();
  console.log(
    `  ${path.basename(webp)} ${(fs.statSync(webp).size / 1024).toFixed(1)}KB · ` +
      `${path.basename(avif)} ${(fs.statSync(avif).size / 1024).toFixed(1)}KB · ${dim.width}x${dim.height}`
  );
}

(async () => {
  if (!fs.existsSync(src)) {
    console.error(`Source not found: ${src}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const full = sharp(src).rotate();
  const { width, height } = await full.metadata();
  console.log(`source ${width}x${height} ${(fs.statSync(src).size / 1024 / 1024).toFixed(2)}MB`);

  const desktopW = Math.min(1671, width);
  await writeSized(full, 'homepage-hero', 1280, { webpQ: 82, avifQ: 55 });
  await writeSized(full, 'homepage-hero', desktopW, { webpQ: 82, avifQ: 55 });

  const cropW = Math.min(1000, width);
  const left = Math.max(0, Math.min(Math.round(width * 0.24), width - cropW));
  const mobile = sharp(src).rotate().extract({ left, top: 0, width: cropW, height });
  console.log(`mobile crop left=${left} ${cropW}x${height}`);
  for (const w of [800, 900]) {
    const img = mobile.clone().resize({ width: w, withoutEnlargement: true });
    const webp = path.join(outDir, `homepage-hero-mobile-${w}.webp`);
    const avif = path.join(outDir, `homepage-hero-mobile-${w}.avif`);
    await img.clone().webp({ quality: w === 900 ? 80 : 78, effort: 6 }).toFile(webp);
    await img.clone().avif({ quality: w === 900 ? 52 : 50, effort: 6 }).toFile(avif);
    const dim = await sharp(webp).metadata();
    console.log(
      `  ${path.basename(webp)} ${(fs.statSync(webp).size / 1024).toFixed(1)}KB · ` +
        `${path.basename(avif)} ${(fs.statSync(avif).size / 1024).toFixed(1)}KB · ${dim.width}x${dim.height}`
    );
  }
  console.log('done — do not link homepage-hero-source.png from public HTML');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
