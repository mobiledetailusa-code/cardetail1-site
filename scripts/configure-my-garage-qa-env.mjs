#!/usr/bin/env node
/** Configure branch QA env — never prints secrets. */
import {
  readExistingEmailsSilently,
  generateQaAdminToken,
  setQaEnv,
  verifyQaEnv,
  readAdminEmailSilently,
} from './netlify-qa-env-manager.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function validEmail(value) {
  const v = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function deriveDistinctEmails(existingA, existingB, adminEmail) {
  const base = [existingA, existingB, adminEmail].find((v) => validEmail(v));
  if (!base) return null;
  const [local, domain] = base.split('@');
  const root = local.split('+')[0];
  return {
    emailA: `${root}+mygarage-qa-a@${domain}`,
    emailB: `${root}+mygarage-qa-b@${domain}`,
  };
}

function promptEmailsPowerShell() {
  const ps = [
    '$a = Read-Host "QA email A"',
    '$b = Read-Host "QA email B"',
    'if (-not $a -or -not $b -or ($a -eq $b)) { exit 2 }',
    `$p = Join-Path $env:TEMP "mygarage-qa-emails-$PID.json"`,
    '[ordered]@{ emailA = $a.Trim().ToLower(); emailB = $b.Trim().ToLower() } | ConvertTo-Json | Set-Content -Path $p -Encoding UTF8',
    'Write-Output $p',
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const file = String(r.stdout || '').trim();
  if (!file || !fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return data;
  } catch {
    return null;
  }
}

let emails = await readExistingEmailsSilently();
let emailA = emails.MY_GARAGE_QA_EMAIL_A;
let emailB = emails.MY_GARAGE_QA_EMAIL_B;
const adminEmail = await readAdminEmailSilently();
if (!validEmail(emailA) || !validEmail(emailB) || emailA === emailB) {
  const derived = deriveDistinctEmails(emailA, emailB, adminEmail);
  if (derived) {
    emailA = derived.emailA;
    emailB = derived.emailB;
  } else {
    const prompted = promptEmailsPowerShell();
    if (!prompted?.emailA || !prompted?.emailB || prompted.emailA === prompted.emailB) {
      console.error('qa_emails_missing', { hasA: !!emailA, hasB: !!emailB, distinct: emailA !== emailB });
      process.exit(1);
    }
    emailA = prompted.emailA;
    emailB = prompted.emailB;
  }
}

const adminToken = generateQaAdminToken();
const v = await setQaEnv({ emailA, emailB, adminToken });
const tokenFile = path.join(os.tmpdir(), `mygarage-qa-${process.pid}.token`);
fs.writeFileSync(tokenFile, JSON.stringify({ emailA, emailB, adminToken }), { mode: 0o600 });
console.log(JSON.stringify({
  ok: v.configured && v.correctContext && v.correctScope && v.noProduction,
  configured: v.configured,
  correctContext: v.correctContext,
  correctScope: v.correctScope,
  noProduction: v.noProduction,
  tokenFile: path.basename(tokenFile),
}));
