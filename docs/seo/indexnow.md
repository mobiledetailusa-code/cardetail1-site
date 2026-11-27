# IndexNow (manual)

IndexNow tells Bing (and Yandex, Seznam, Naver, Yep) that a URL changed, so it is
recrawled within hours instead of weeks. Bing's index also feeds DuckDuckGo,
Yahoo, ChatGPT Search and Copilot, which on 2026-11-26 still showed
"Based in Palisades Park" snippets that the site dropped in deploys 6b07c401/6b0874ca.

## What is in the repository

| File | Purpose |
| --- | --- |
| `4928f243e82d24fa6968f4e19e34171c.txt` | Ownership key. Public by design: the protocol requires it at the site root. It is not a secret and grants nothing beyond pinging IndexNow for cardetail1.com. |
| `scripts/indexnow-submit.js` | Manual CLI. Dry run by default. |
| `tests/indexnow-submit.test.js` | Guards: only sitemap URLs, robots.txt Disallow respected, no Function, schedule or build hook. |

No Function, scheduled task, build step or paid service is involved. Automatic
builds stay off.

## Release procedure (after a production deploy is live)

1. Note the commit that was live **before** this deploy (the rollback point's commit).
2. Dry run and read the list:
   ```
   node scripts/indexnow-submit.js --changed-since <previous-live-commit>
   ```
3. If the list is right, send it:
   ```
   node scripts/indexnow-submit.js --changed-since <previous-live-commit> --submit
   ```
   `--submit` checks that `https://cardetail1.com/<key>.txt` serves the key, that
   every changed URL answers 200 and every removed URL answers 404/410, then posts
   once to `https://api.indexnow.org/indexnow`. HTTP 200 or 202 means accepted.

Other forms:

- One URL: `--url https://cardetail1.com/mahwah-mobile-detailing --submit`
- A removed page (must be out of `sitemap.xml` and 404/410 live): `--removed <url> --submit`
- Whole sitemap (first run only, or after a site-wide change): `--all --submit`

## Rules

- The script skips any URL this machine already sent in the last 24 hours (local, untracked `.indexnow-log.json`). Use `--force` only after a real content change on the same day.
- HTTP answers: 200/202 accepted; 400 bad format; 403 key file missing or wrong; 422 URL not on this host or key mismatch; 429 too many requests (stop, retry later). Anything else exits 1.
- Submit only when content actually changed. Re-submitting unchanged URLs does not
  speed anything up and can lower trust in the key.
- Never add admin, portal, receipt, template or booking deep-link URLs. The script
  refuses anything that is not in `sitemap.xml` or that `robots.txt` disallows.
- Changing the key: create a new `<key>.txt`, update `KEY` in the script, the
  `.gitignore` exception and `ROOT_FILES` in `scripts/build-public-dist.js`, deploy,
  then delete the old file in a later deploy.

## Bing Webmaster Tools

IndexNow works without a Bing Webmaster Tools account. With an account, Bing shows
the submissions under *IndexNow* and adds crawl, index and keyword reports. The
quickest verification is *Import from Google Search Console* (the site already has
a GSC verification meta tag), so no new DNS record or meta tag is needed.
