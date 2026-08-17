// The universal-strategy generation pipeline must be byte-reproducible.
//
// `npm run audit:pre-deploy` exited 2 on a clean checkout, reporting both
// generated artifacts as STALE. They were not stale: `diff -w` between the
// committed artifact and a freshly generated one was 0 lines. The generator
// builds its output from a template literal in its own source plus the text of
// its inputs, so every newline in the byte-for-byte comparison came from however
// Git happened to check those files out. Under core.autocrlf=true the artifact
// arrived CRLF while the generator emitted LF, and the check reported drift that
// did not exist.
//
// The fix is in the generator: it normalises its inputs and compares on content
// rather than bytes, so the result no longer depends on any checkout setting.
//
// A `.gitattributes` pinning the pipeline to `eol=lf` was tried first and
// removed. It is inert here: `eol=lf` does not down-convert a blob that already
// contains CRLF, so the files still arrived CRLF and the attribute changed
// nothing. Verified by deleting it and re-running — `--check` still exits 0,
// `audit:pre-deploy` still exits 0, and the tree stays clean. Reintroduce it only
// together with a `git add --renormalize` that actually makes the blobs LF.
//
// Everything here runs in a temp directory. The checkout is never written to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const SCRIPT = 'scripts/sync-universal-strategy-config.mjs';
const SHARED = 'shared/universal-customer-strategy-config.json';
const LOGIC = 'netlify/lib/universal-customer-strategy-logic.js';
const BUNDLE = 'assets/universal-customer-strategy.generated.js';
const BACKEND = 'netlify/lib/universal-customer-strategy-config.json';
const PIPELINE = [SCRIPT, SHARED, LOGIC, BUNDLE, BACKEND];

const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
const write = (dir, rel, s) => {
  const full = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, s);
};
const toLf = (s) => s.replace(/\r\n/g, '\n');
const toCrlf = (s) => toLf(s).replace(/\n/g, '\r\n');

/** A throwaway copy of just the generation pipeline. Unique per call. */
function sandbox(transform = (s) => s) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd1-sync-'));
  for (const rel of PIPELINE) write(dir, rel, transform(read(root, rel)));
  return dir;
}

const runSync = (dir, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

test('the committed artifacts are already synchronized with the shared config', () => {
  const dir = sandbox();
  try {
    const r = runSync(dir, '--check');
    assert.equal(r.status, 0, `--check must pass on the committed tree:\n${r.stdout}${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--check is decided on content, not on line endings', () => {
  // Exactly the situation that produced the false STALE: a checkout that
  // rewrote the pipeline to CRLF.
  const dir = sandbox(toCrlf);
  try {
    assert.ok(read(dir, BUNDLE).includes('\r\n'), 'precondition: the sandbox really is CRLF');
    const r = runSync(dir, '--check');
    assert.equal(
      r.status, 0,
      `a CRLF checkout is not a stale artifact — --check must still pass:\n${r.stdout}${r.stderr}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the generated bundle is byte-identical whether the inputs are LF or CRLF', () => {
  const lf = sandbox(toLf);
  const crlf = sandbox(toCrlf);
  try {
    for (const dir of [lf, crlf]) {
      const r = runSync(dir);
      assert.equal(r.status, 0, `generation failed:\n${r.stdout}${r.stderr}`);
    }
    for (const artifact of [BUNDLE, BACKEND]) {
      assert.equal(
        read(lf, artifact), read(crlf, artifact),
        `${artifact} differs depending on the line endings of its inputs — the artifact is not reproducible`,
      );
      assert.ok(!read(lf, artifact).includes('\r'), `${artifact} must be emitted with LF`);
    }
  } finally {
    for (const dir of [lf, crlf]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--check still fails on a genuine content change', () => {
  // The point of the fix is a check that reports real drift and only real drift.
  // Without this, normalising line endings could have made it always green.
  for (const [label, artifact, mutate] of [
    ['bundle', BUNDLE, (s) => s.replace('use strict', 'use strict; /* drift */')],
    ['backend config', BACKEND, (s) => s.replace(/}\s*$/, ',"driftedKey":1}')],
  ]) {
    const dir = sandbox();
    try {
      write(dir, artifact, mutate(read(dir, artifact)));
      const r = runSync(dir, '--check');
      assert.equal(r.status, 1, `--check must still detect real drift in the ${label}`);
      assert.match(r.stderr, /STALE/, `--check must name the ${label} as stale`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a missing artifact is still reported as stale', () => {
  const dir = sandbox();
  try {
    fs.rmSync(path.join(dir, ...BUNDLE.split('/')));
    const r = runSync(dir, '--check');
    assert.equal(r.status, 1, 'a missing generated bundle must fail the check');
    assert.match(r.stderr, /missing/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the fix does not depend on any checkout or Git configuration', () => {
  // The guarantee is entirely inside the generator, so it must hold in a tree
  // that carries no Git metadata and no attributes at all — which is also the
  // shape a Netlify build sees.
  const dir = sandbox(toCrlf);
  try {
    assert.equal(fs.existsSync(path.join(dir, '.gitattributes')), false, 'the sandbox has no Git attributes');
    assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'the sandbox is not a repository');
    const r = runSync(dir, '--check');
    assert.equal(r.status, 0, `--check must pass with no Git involved at all:\n${r.stdout}${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
