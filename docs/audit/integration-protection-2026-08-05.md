# Integration protection — GitHub Actions

Date: 2026-08-05
Branch: `ci/integration-protection`
Base: PR5 `feat/twilio-readiness-pr5` (`916e46fd8fe77fecbf1cc9025b2893d822d9cae9`)
Scope: workflow, deterministic CI build-tool lock and release documentation only
Production/deploy: not performed

## Protection supplied

`.github/workflows/integration.yml` runs on every pull request, on pushes to `master`, and by manual dispatch. Obsolete runs for the same pull request/ref are cancelled.

The workflow uses:

- `npm ci` against the committed lockfile;
- Node.js 22 and an npm download cache keyed by `package-lock.json` (never a cached `node_modules` tree);
- PostgreSQL 16 with a fresh service database per database job;
- all migrations from zero, migration status and a database/schema drift check;
- the complete test suite with full Git history for its historical containment assertions and a Linux-compatible directory for its legacy performance artifact;
- dedicated financial-invariant and Admin/Customer parity suites;
- an offline Netlify deploy-preview build with exact Netlify CLI version `27.1.0` and its full dependency graph isolated under `.github/netlify-build/package-lock.json`;
- read-only repository permissions and checkout credentials disabled after checkout;
- stable job/check names for branch protection.

The Netlify CLI is installed from a separate CI-only lockfile and used solely by the build check; the application `package.json` and `package-lock.json` remain unchanged, and the CLI is not bundled into Functions or browser assets. Its install scripts are disabled. Deploy-preview identity variables are scoped only to the build job so they cannot distort runtime-origin tests in the complete suite. Stripe and Twilio live values are deliberately empty. Twilio send/consent flags are explicitly false, and the build has no Netlify project credential. The workflow therefore cannot charge, deploy or send an SMS. If a future CI-only secret becomes necessary, it must be added through GitHub Actions secrets and must never be a live Stripe/Twilio credential.

## Required checks — owner action

GitHub branch protection is not changed by this PR. After this workflow has completed successfully at least once on the target branch, the repository owner should mark exactly these five contexts as required:

1. `integration / migrations`
2. `integration / full-test`
3. `integration / financial-invariants`
4. `integration / portal-parity`
5. `integration / netlify-build`

Recommended owner settings: require branches to be up to date before merging; require pull requests and approvals; dismiss stale approvals after new commits; prevent bypass except for documented emergency procedure. Do not type check names manually before GitHub has observed a successful run—select the contexts returned by the workflow UI.

## Risk and rollback

The workflow does not mutate application or production state. Main risks are CI duration and transient package/container registry availability. Concurrency cancellation bounds obsolete work, while isolated PostgreSQL services and the npm content cache avoid cross-run state.

Rollback is a revert of the isolated CI commit. If the owner has already made the five contexts required, first change branch protection through an explicitly approved owner action so the repository is not left with required contexts that can no longer run.

## Review checklist

- Confirm the PR diff contains only `.github/workflows/integration.yml`, `.github/netlify-build/package.json`, `.github/netlify-build/package-lock.json` and this document; root application manifests must be byte-for-byte unchanged.
- Confirm the base and head match the immutable SHAs recorded in the PR evidence.
- Confirm all five checks complete on GitHub-hosted runners.
- Inspect a failed migration-drift experiment in a disposable branch if the owner wants an additional negative test.
- Confirm no live Stripe, Twilio or Netlify secret is exposed to pull requests.
- Configure branch protection manually only after owner approval.
