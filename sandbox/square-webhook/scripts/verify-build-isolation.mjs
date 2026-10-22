import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const require = createRequire(path.join(repoRoot, '.github/netlify-build/package.json'));
const configEntry = require.resolve('@netlify/config');
const zipEntry = require.resolve('@netlify/zip-it-and-ship-it');
const { resolveConfig } = await import(pathToFileURL(configEntry));
const { zipFunctions } = await import(pathToFileURL(zipEntry));

const mainArg = process.argv.indexOf('--main-dist');
const mainDist = mainArg === -1 ? '' : path.resolve(repoRoot, process.argv[mainArg + 1] || '');

function fail(message) {
  console.error(`BUILD ISOLATION NOT VERIFIED: ${message}`);
  process.exit(1);
}

function functionNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.js') || name.endsWith('.zip') || name.endsWith('.mjs'));
}

const commercial = await resolveConfig({
  cwd: repoRoot,
  repositoryRoot: repoRoot,
  context: 'production',
  offline: true,
  host: '127.0.0.1',
});
if (!String(commercial.configPath).endsWith(`${path.sep}netlify.toml`)) {
  fail(`commercial config resolved to ${commercial.configPath}`);
}
if (String(commercial.configPath).includes(`${path.sep}sandbox${path.sep}`)) {
  fail('commercial site selected the sandbox netlify.toml');
}
const commercialFunctions = commercial.config.functionsDirectory;
if (path.basename(path.dirname(commercialFunctions)) !== 'netlify' || path.basename(commercialFunctions) !== 'functions') {
  fail(`commercial functions directory is ${commercialFunctions}`);
}
if (commercialFunctions.includes(`${path.sep}sandbox${path.sep}`)) {
  fail('commercial functions directory points at the sandbox receiver');
}
if (functionNames(commercialFunctions).includes('square-sandbox-webhook.js')) {
  fail('square-sandbox-webhook.js is inside the commercial functions directory');
}

const sandbox = await resolveConfig({
  cwd: repoRoot,
  repositoryRoot: repoRoot,
  packagePath: 'sandbox/square-webhook',
  context: 'production',
  offline: true,
  host: '127.0.0.1',
});
if (!String(sandbox.configPath).endsWith(path.join('sandbox', 'square-webhook', 'netlify.toml'))) {
  fail(`sandbox config resolved to ${sandbox.configPath}`);
}
const sandboxFunctions = sandbox.config.functionsDirectory;
const sandboxPublish = sandbox.config.build.publish;
if (!sandboxFunctions.endsWith(path.join('sandbox', 'square-webhook', 'netlify', 'functions'))) {
  fail(`sandbox functions directory is ${sandboxFunctions}`);
}
if (!sandboxPublish.endsWith(path.join('sandbox', 'square-webhook', 'public'))) {
  fail(`sandbox publish directory is ${sandboxPublish}`);
}
const sandboxSourceNames = functionNames(sandboxFunctions);
if (sandboxSourceNames.length !== 1 || sandboxSourceNames[0] !== 'square-sandbox-webhook.js') {
  fail(`sandbox function list is ${sandboxSourceNames.join(',')}`);
}
const commercialNames = new Set(functionNames(path.join(repoRoot, 'netlify/functions')));
for (const name of sandboxSourceNames) {
  if (commercialNames.has(name)) fail(`sandbox package includes commercial function ${name}`);
}

if (mainDist) {
  if (!fs.existsSync(mainDist)) fail(`main build output is missing at ${mainDist}`);
  const built = fs.readdirSync(mainDist);
  if (built.some((name) => name.includes('square-sandbox-webhook'))) {
    fail(`main build output contains the sandbox receiver: ${built.filter((name) => name.includes('square')).join(',')}`);
  }
  if (!built.some((name) => name.includes('stripe-webhook') || name.includes('submit-booking'))) {
    fail('main build output is missing current commercial functions');
  }
}

const fnConfig = (sandbox.config.functions && sandbox.config.functions['*']) || {};
const includedFiles = fnConfig.included_files || fnConfig.includedFiles || [];
if (!includedFiles.some((pattern) => pattern.includes('@prisma')) || !includedFiles.some((pattern) => pattern.includes('.prisma'))) {
  fail('sandbox netlify.toml does not exclude the commercial Prisma client');
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cd1-square-sandbox-fn-'));
const zipped = await zipFunctions(sandboxFunctions, out, {
  basePath: repoRoot,
  config: {
    '*': {
      nodeBundler: fnConfig.node_bundler || fnConfig.nodeBundler || 'esbuild',
      includedFiles,
      includedFilesBasePath: repoRoot,
    },
  },
});
if (!Array.isArray(zipped) || zipped.length !== 1) fail(`sandbox bundle count is ${zipped && zipped.length}`);
const zipPath = zipped[0].path;
if (!zipPath || !fs.existsSync(zipPath)) fail('sandbox bundle zip is missing');
const listed = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
if (listed.status !== 0) fail(listed.stderr || 'unzip failed');
const entries = listed.stdout;
if (!/square-sandbox-webhook\.zip|square-sandbox-webhook\.js|___netlify-bootstrap/.test(entries) && !entries.includes('.js')) {
  fail('sandbox zip has no function entry');
}
const unpacked = path.join(out, 'unpacked');
fs.mkdirSync(unpacked);
const extracted = spawnSync('unzip', ['-q', zipPath, '-d', unpacked], { encoding: 'utf8' });
if (extracted.status !== 0) fail(extracted.stderr || 'unzip extract failed');
const jsFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) jsFiles.push(full);
  }
}
walk(unpacked);
const bundle = jsFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
if (!bundle.includes('x-square-hmacsha256-signature') || !bundle.includes('sha256')) {
  fail('bundled function does not contain the Square HMAC verifier');
}
if (!bundle.includes('node_modules/pg/') && !entries.includes('node_modules/pg/')) {
  fail('bundled function does not package pg');
}
if (/sk_(?:live|test)_[A-Za-z0-9]{8,}|EAAA[A-Za-z0-9]{8,}|postgres(?:ql)?:\/\/[^"'\\\s]*@/.test(bundle + entries)) {
  fail('bundled function contains a credential-shaped value');
}
if (entries.includes('node_modules/@prisma/') || entries.includes('node_modules/.prisma/') || entries.includes('schema.prisma')) {
  fail('sandbox bundle contains the commercial Prisma client');
}
if (/(^|\/)\.env(\.|$)/m.test(entries)) {
  fail('sandbox bundle contains an env file');
}
if (bundle.includes('submit-booking') || bundle.includes('payment-authority-service') || bundle.includes('stripe-webhook')) {
  fail('bundled function contains commercial payment code');
}
if (/process\.env\.DATABASE_URL/.test(bundle) || !bundle.includes('SQUARE_SANDBOX_WEBHOOK_DATABASE_URL')) {
  fail('bundled function does not keep the sandbox database URL separate');
}
function probePackagedHandler(env, label) {
  const result = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(path.join(unpacked, 'square-sandbox-webhook.js'))});
    m.handler({ httpMethod: 'POST', body: '{}', headers: {}, isBase64Encoded: false }).then((res) => {
      const body = JSON.parse(res.body);
      if (res.statusCode !== 503) {
        console.error(${JSON.stringify(label)}, res.statusCode, body);
        process.exit(2);
      }
      if (body.paymentConfirmed !== false || body.financialEffect !== 'none') process.exit(3);
      console.log(JSON.stringify({ label: ${JSON.stringify(label)}, error: body.error }));
    }).catch((err) => { console.error(err); process.exit(1); });
  `], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', ...env },
  });
  if (result.status !== 0) fail(result.stderr || result.stdout || `${label} packaged handler did not fail closed`);
  return result.stdout.trim();
}
const unknownSite = probePackagedHandler({}, 'unknown-site');
const productionSite = probePackagedHandler({
  SITE_ID: 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0',
  SQUARE_SANDBOX_ALLOWED_SITE_ID: 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0',
  SQUARE_SANDBOX_WEBHOOK_CONFIRMATION: 'square-sandbox',
  SQUARE_SANDBOX_MERCHANT_ID: 'MERCHANT_SANDBOX',
  SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL: 'https://cardetail1-square-sandbox.netlify.app/.netlify/functions/square-sandbox-webhook',
  SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'sandbox-webhook-test-key',
  SQUARE_SANDBOX_WEBHOOK_DATABASE_URL: 'postgres://127.0.0.1:9/square_sandbox_webhook',
  DATABASE_URL: 'postgres://127.0.0.1:9/commercial',
  PAYMENT_PROVIDER: 'square',
}, 'production-site');
const adapter = require(path.join(repoRoot, 'netlify/lib/payment-provider-adapter.js'));
const previousProvider = process.env.PAYMENT_PROVIDER;
process.env.PAYMENT_PROVIDER = 'square';
const providerAfterEnv = adapter.getActivePaymentProvider();
if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
else process.env.PAYMENT_PROVIDER = previousProvider;
if (adapter.ACTIVE_PAYMENT_PROVIDER !== 'none' || providerAfterEnv.id !== 'none') {
  fail(`payment provider is ${adapter.ACTIVE_PAYMENT_PROVIDER}/${providerAfterEnv && providerAfterEnv.id}`);
}
const publishFiles = fs.readdirSync(sandboxPublish);
if (publishFiles.some((name) => name.startsWith('.env') || name.endsWith('.sql'))) {
  fail(`publish directory contains a non-public file: ${publishFiles.join(',')}`);
}

console.log(JSON.stringify({
  commercialFunctions,
  sandboxFunctions,
  sandboxPublish,
  sandboxConfig: sandbox.configPath,
  provider: adapter.ACTIVE_PAYMENT_PROVIDER,
  unknownSite,
  productionSite,
  bundleEntries: entries.split('\n').filter((line) => line.includes('.js') || line.includes('pg')).slice(0, 12),
}));
