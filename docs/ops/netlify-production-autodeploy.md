# Netlify Production auto-deploy

## Incident (Stage 2A merge)

Merge of PR #132 to `master` (`9b81e8d`) did **not** create a Git-triggered Production deploy. Production was published via CLI deploy `6a617d783f05b6a6ccda993e`.

## Root cause

Netlify site `cardetail1` (`d7e5f77c-1f0b-4209-a9df-3d6aae380dd0`) had:

```text
build_settings.stop_builds = true
build_settings.repo_branch = master
build_settings.provider = github
build_settings.allowed_branches = ["master"]
build hooks = []
```

With **`stop_builds: true`**, Netlify does not run builds from Git pushes (including Production builds for `master`).

This is a **Netlify site configuration** issue (not GitHub webhook absence alone, not a repo code defect).

## Remediation

Set `stop_builds` back to `false` on the site (Netlify UI: Site configuration → Build & deploy → Continuous Deployment → “Stop builds” / resume builds, or API `updateSite`).

### Rollback

Re-set `stop_builds: true` if an emergency freeze is required.

## Validation

1. Confirm `stop_builds === false` via Netlify API `getSite`.
2. Push a non-production branch and confirm a branch deploy or deploy preview is created (if branch deploys are enabled for the site).
3. After a trivial `master` merge (or empty commit policy), confirm a Production deploy appears with matching `commit_ref`.

## Notes

CLI `netlify deploy --prod` still works while builds are stopped; that is how Stage 2A was published. Prefer Git auto-deploy for release auditability (`commit_ref` populated on Production deploys).
