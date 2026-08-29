# TraxWax — deployment & operations

The site is **live at [traxwax.com](https://traxwax.com)**. This is the operations reference,
not a setup checklist — the original one-time Cloudflare setup was completed 2026-08-17/18 and
lives in git history.

---

## How deployment works

| | |
|---|---|
| **Host** | Cloudflare Pages, project `traxwax` |
| **Source** | `github.com/lanebecker/traxwax`, branch `main` |
| **Build command** | *(none)* |
| **Build output directory** | `public` |
| **Framework preset** | None |
| **Deploy trigger** | Every push to `main` auto-deploys. Non-production branches get preview URLs at `https://<branch>.traxwax.pages.dev`. |

Pages auto-detects `functions/` and deploys the proxy alongside the static site. There is no
build step to break.

## Environment variables

Set in **Workers & Pages → traxwax → Settings → Variables and Secrets**, for **Production and
Preview** both:

| Name | Value | Notes |
|---|---|---|
| `DISCOGS_TOKEN` | Discogs personal access token | Mark as **Secret / encrypted**. Read by every `functions/api/*` handler. |
| `DISCOGS_USER` | `lanebecker` | Optional — `functions/api/value.js` defaults to this. |

Separately, GitHub **Settings → Secrets and variables → Actions** holds its own
`DISCOGS_TOKEN` for `refresh-collection.yml`. **These are two independent stores of the same
secret.** Discogs issues only one personal access token per account, so rotating it means
updating both, plus two more consumers — see `../DISCOGS-CREDENTIALS.md` for the full map and
rotation checklist.

> **Token type.** This is a **personal access token**, not an app registration — TraxWax is
> currently single-user and the proxy reads Lane's own data, acting as him. Multi-user (v1.0.0)
> moves per-user reads to OAuth under the `TraxWax` Discogs app; this PAT still serves the
> app's own public calls.

After changing any variable, **Deployments → Retry deployment** (or push a commit) so the
Functions pick it up.

## The weekly refresh

`.github/workflows/refresh-collection.yml` runs weekly and on `workflow_dispatch`:

1. Runs `build/refresh_collection.py` with the Actions `DISCOGS_TOKEN`.
2. Pulls the collection, does one `get_release` pass per record.
3. Writes `public/collection.json` and any new `public/releases/<id>.json`.
4. Commits to `main` — Cloudflare deploys it.

A full pass takes ~35–40 minutes, throttled under the Discogs rate limit. Tracklist files are
write-once, so weekly diffs stay small; only new records add files.

**To force a refresh now:** repo → **Actions → Refresh collection → Run workflow**.

**Because this commits to `main`,** any long-lived branch will drift and needs a
`git pull --rebase origin main` before merging.

## Local testing

Static only:

```bash
cd public && python3 -m http.server 8000     # http://localhost:8000
```

With the proxy Functions live:

```bash
cd "…/traxwax-clone"
printf 'DISCOGS_TOKEN=YOUR_TOKEN\nDISCOGS_USER=lanebecker\n' > .dev.vars   # git-ignored, never commit
npx wrangler pages dev public
```

Most of the site works with no proxy at all — the modal reads baked static files. Only the
live header value and the fallback for a brand-new un-baked record need the Functions.

## Verifying a deploy

- `https://traxwax.com/api/value` → JSON `{minimum, median, maximum}`
- Open any record → tracklist, have/want, and lowest sale populate; header **EST.** fills in
- Grid and Ledger prices show real figures (they come from the weekly bake, not live calls)
- The footer shows both required Discogs notices

## Rollback

Cloudflare Pages keeps every deployment. **Workers & Pages → traxwax → Deployments →** find
the last good one **→ Rollback**. This is instant and does not touch git; fix forward in the
repo afterwards so the next push does not re-deploy the bad state.

---

## Retired

- **The Cowork `rebuild-record-collection` task** — superseded by the GitHub Action above.
  Disabled 2026-08-28 (kept disabled for history, not deleted).
- **The `traxwax-site/` staging directory and its rsync workflow** — replaced 2026-08-17 by
  editing `traxwax-clone` directly as the single persistent working copy.
