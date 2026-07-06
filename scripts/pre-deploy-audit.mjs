#!/usr/bin/env node
/**
 * Pre-deploy audit — deterministic checks + optional @cursor/sdk AI sweep.
 *
 * Without CURSOR_API_KEY: runs node --check + targeted tests, writes report.
 * With CURSOR_API_KEY: adds a read-only Agent.prompt audit (Cursor SDK plugin pattern #1).
 *
 * Usage:
 *   npm run audit:pre-deploy
 *   CURSOR_API_KEY=cursor_... npm run audit:pre-deploy
 */

import { execSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPORTS_DIR = join(ROOT, "reports");

const AUDIT_PROMPT = `You are auditing the Cardetail1 site before deploy. READ ONLY — do not edit any file.

Scan production HTML pages, inline scripts, and netlify/functions for:

1. JavaScript syntax issues in netlify/functions/*.js and inline scripts in index.html.
2. Unbalanced HTML tags in index.html, admin-ops.html, technician.html, customer.html, authorize.html.
3. Stripe / card-on-file conflicts:
   - Frontend ST.cardOnFileSaved vs backend cardOnFileStatus === "saved" race
   - initCardOnFile race guards (cardInitInProgress, cardInitNonce)
   - submit-booking.js gating vs index.html submitBooking()
   - stripe-webhook.js setup_intent.succeeded handling
4. Form submit conflicts (duplicate handlers, missing preventDefault, buttons without type="button").
5. Legacy Square / PaymentIntent dead code that could confuse checkout.

Output concise markdown with severity table, grouped findings, files inspected,
tests to run, and a proceed/hold-deploy recommendation. Surgical only — no redesign.`;

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

const NODE = process.execPath;

function run(cmd) {
  try {
    const out = execSync(cmd, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH },
    });
    return { ok: true, output: out.trim() };
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    return { ok: false, output: output || err.message };
  }
}

async function deterministicChecks() {
  const sections = ["## Deterministic checks\n"];

  const fnDir = join(ROOT, "netlify", "functions");
  const files = (await readdir(fnDir)).filter(f => f.endsWith(".js"));
  const syntaxLines = [];
  for (const file of files) {
    const rel = join("netlify", "functions", file).replace(/\\/g, "/");
    const result = run(`"${NODE}" --check "${rel}"`);
    syntaxLines.push(result.ok ? `- [ok] \`${rel}\`` : `- [FAIL] \`${rel}\`: ${result.output}`);
  }
  sections.push("### JS syntax (node --check)\n", syntaxLines.join("\n"), "");

  const testResult = run(
    `"${NODE}" --test tests/card-on-file-hardening.test.js tests/booking-flow.test.js`
  );
  sections.push(
    "### Targeted tests\n",
    testResult.ok
      ? "- [ok] card-on-file-hardening + booking-flow (all passed)"
      : `- [FAIL] tests:\n\`\`\`\n${testResult.output}\n\`\`\``,
    ""
  );

  sections.push(
    "### Recommendation (deterministic only)\n",
    testResult.ok && syntaxLines.every(l => l.startsWith("- [ok]"))
      ? "**Proceed** on syntax/tests — run AI sweep below before production deploy if payment code changed."
      : "**Hold deploy** — fix failing checks first."
  );

  return sections.join("\n");
}

async function aiSweep(apiKey) {
  const { Agent, CursorAgentError } = await import("@cursor/sdk");

  try {
    const result = await Agent.prompt(AUDIT_PROMPT, {
      apiKey,
      model: { id: "composer-2.5" },
      local: { cwd: ROOT, settingSources: [] },
    });

    if (result.status === "error") {
      return { ok: false, body: `AI audit ended with status=error` };
    }

    const body =
      typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result, null, 2);
    return { ok: true, body, status: result.status };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      return {
        ok: false,
        body: `Startup failed: ${err.message} (retryable=${err.isRetryable})`,
      };
    }
    throw err;
  }
}

async function main() {
  console.log("[audit] Cardetail1 pre-deploy audit");
  console.log("[audit] cwd:", ROOT);

  const deterministic = await deterministicChecks();
  let report = `# Pre-deploy audit\n\nGenerated: ${new Date().toISOString()}\n\n${deterministic}\n`;

  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (apiKey) {
    console.log("[audit] CURSOR_API_KEY set — running @cursor/sdk Agent.prompt sweep…");
    const ai = await aiSweep(apiKey);
    report += `\n---\n\n## AI audit (@cursor/sdk)\n\n`;
    report += ai.ok
      ? `Status: ${ai.status}\n\n${ai.body}\n`
      : `**AI audit skipped/failed:** ${ai.body}\n`;
  } else {
    console.log("[audit] No CURSOR_API_KEY — deterministic checks only.");
    console.log("[audit] Add key from https://cursor.com/dashboard/integrations for AI sweep.");
    report +=
      "\n---\n\n## AI audit (@cursor/sdk)\n\n" +
      "_Skipped — set `CURSOR_API_KEY` to enable the read-only Agent.prompt sweep " +
      "(same Stripe/form audit you previously ran manually in chat)._\n";
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, `pre-deploy-audit-${timestampSlug()}.md`);
  await writeFile(reportPath, report, "utf8");

  console.log(`[audit] report: ${reportPath}`);
  process.stdout.write("\n--- preview ---\n");
  process.stdout.write(report.slice(0, 2500));
  if (report.length > 2500) process.stdout.write("\n… (see report file)\n");

  const hold = report.includes("[FAIL]");
  process.exit(hold ? 2 : 0);
}

main().catch(err => {
  console.error("[audit] unexpected error:", err);
  process.exit(1);
});
