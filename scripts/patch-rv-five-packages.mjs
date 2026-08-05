#!/usr/bin/env node

/**
 * Legacy entry point retained for operator compatibility.
 *
 * The RV page now follows the authoritative six-package catalog. Rebuilding
 * the former five-card template would restore obsolete package prices, so this
 * command delegates to the catalog-to-page synchronizer instead.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'apply-package-price-change.mjs',
);
const result = spawnSync(process.execPath, [script, '--sync-only'], {
  cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
