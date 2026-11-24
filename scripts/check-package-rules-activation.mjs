#!/usr/bin/env node
// Release gate for PACKAGE_RULES_ACTIVATION (assets/addon-rules.js).
// Run in the release worktree right before the production publish:
//   node scripts/check-package-rules-activation.mjs [--publish-at <ISO with offset>]
// Exits non-zero unless the activation is approved, carries an explicit UTC
// offset, and sits within 15 minutes of the planned publish time (default: now).
// It never edits anything; the owner sets the time in the release commit.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Rules = require('../assets/addon-rules.js');

const args = process.argv.slice(2);
const publishArg = args[args.indexOf('--publish-at') + 1];
const publishAt = args.includes('--publish-at') ? Rules.parseActivation(publishArg) : Date.now();
const activation = Rules.PACKAGE_RULES_ACTIVATION;
const effective = Date.parse(Rules.RULES_EFFECTIVE_AT);
const WINDOW_MS = 15 * 60 * 1000;
const problems = [];

if (activation.approved !== true) problems.push('PACKAGE_RULES_ACTIVATION.approved is not true');
if (Rules.parseActivation(activation.effectiveAt) == null) problems.push('effectiveAt has no explicit UTC offset');
if (Rules.ACTIVATION_INVALID_ENV) problems.push('CD1_PACKAGE_RULES_EFFECTIVE_AT is set but has no explicit offset');
if (publishAt == null) problems.push('--publish-at must be an ISO time with an explicit offset');
else if (Math.abs(effective - publishAt) > WINDOW_MS) {
  problems.push(`activation ${Rules.RULES_EFFECTIVE_AT} is more than 15 min from publish ${new Date(publishAt).toISOString()}`);
}

const summary = {
  effectiveAt: Rules.RULES_EFFECTIVE_AT,
  timeZone: activation.timeZone,
  source: Rules.ACTIVATION_SOURCE,
  approved: activation.approved,
  publishAt: publishAt == null ? null : new Date(publishAt).toISOString(),
};
console.log(JSON.stringify(summary, null, 1));
if (problems.length) {
  console.error('NOT READY:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('READY');
