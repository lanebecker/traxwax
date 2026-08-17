# TraxWax — Deploy to Cloudflare Pages

The full site is now pushed to **github.com/lanebecker/traxwax** (site + proxy +
`collection.json` + screenshots + docs). What's left is to connect Cloudflare and set
the token — **start at Step 2**.

---

## Step 1 — Push the code ✅ done (2026-08-17)

Already pushed — the repo has the full site, `collection.json`, screenshots, and docs.
**Skip to Step 2.** Kept below for reference / future re-pushes.

The repo had a starter `README`/`LICENSE`, so the safe move was clone → copy files in →
push (no rebase, keeps the LICENSE, overwrites the starter README):

```bash
cd "/Users/lanebecker-wmf/Documents/Claude.nosync/Projects/Lane's Record Collection"
git clone https://github.com/lanebecker/traxwax.git traxwax-clone
rsync -a --exclude='.git' "traxwax-site/" traxwax-clone/
cd traxwax-clone
git add -A
git commit -m "TraxWax v0.1.0 — production site + Discogs proxy + docs"
git push
```

That ships the site, the proxy Functions, `collection.json`, the screenshots, and all
the docs in one commit. (Prefer I push instead? Grant your fine-grained PAT
`Contents: write` on `lanebecker/traxwax` and say the word — though the git push above
is simpler and also carries the data file.)

## Step 2 — Create the Pages project (Cloudflare dashboard)

1. **Workers & Pages → Create → Pages → Connect to Git**, pick the `traxwax` repo.
2. Build settings: **Framework preset = None**, **Build command = (empty)**,
   **Build output directory = `public`**. Save & Deploy.
3. Pages auto-detects `functions/` and deploys the proxy alongside the static site.

You'll get a `https://traxwax.pages.dev` URL. Until Step 3, the header value and modal
lowest-sale show "—".

## Step 3 — Add the Discogs token (secret)

Dashboard: **Settings → Variables and Secrets → Add**, for **Production and Preview**:

- `DISCOGS_TOKEN` = your Discogs personal access token  *(mark as Secret / encrypted)*
- `DISCOGS_USER` = `lanebecker`  *(optional; this is the default)*

Use a **standard user token (PAT)** — Discogs → Settings → Developers → *Generate new
token* — **not** an app registration. TraxWax is single-user and the proxy reads only
your own / public data, acting as you. If you later add per-user sign-in (multi-user
with login), that moves to OAuth + an app registration — swap this secret then; the PAT
still serves the app's own public calls.

Then **Deployments → Retry deployment** (or push any commit) so the Functions pick up
the secret.

## Step 4 — Verify

- `https://traxwax.pages.dev/api/value` → JSON `{minimum, median, maximum}`.
- Open any record → tracklist + have/want + **lowest sale** populate from Discogs; the
  header **EST.** fills in.
- Grid/Ledger per-record prices stay "—" until the weekly bake (Step 6).

## Step 5 — Custom domain (traxwax.com) — later

Its DNS isn't on Cloudflare yet. Cleanest path: **add the domain to Cloudflare** (it
imports your existing DNS), **change the nameservers at your registrar** to the two
Cloudflare gives you, then in the Pages project **Custom domains → Set up → traxwax.com**
(+ `www`). SSL auto-provisions. This cuts a **v1.0.0** release (see `docs/roadmap.md`).

## Step 6 — Automatic updates (GitHub Actions) — one-time setup

The site keeps itself current with **no Claude, no Cowork task, no local machine**:
`.github/workflows/refresh-collection.yml` runs weekly (and on demand), rebuilds
`public/collection.json` from the Discogs API via `build/refresh_collection.py` (new
records, edits, and baked marketplace low prices), and commits it — Cloudflare
auto-deploys the commit.

One-time setup — add the Discogs token as an **Actions** secret (a separate store from
the Pages secret you set in Step 3):

- repo → **Settings → Secrets and variables → Actions → New repository secret**
- Name: `DISCOGS_TOKEN`   Value: your Discogs personal access token

Then trigger the first run: repo → **Actions → Refresh collection → Run workflow**. It
takes ~35–40 min (it prices all ~1,850 records, throttled under Discogs' rate limit),
commits the result, and the grid / Ledger / sort prices light up. After that it runs
itself every Monday. This **replaces the old Cowork `rebuild-record-collection` task** —
you can retire it.

## Local testing (optional)

Run the Functions locally with your token:

```bash
cd "…/traxwax-site"
printf 'DISCOGS_TOKEN=YOUR_TOKEN\nDISCOGS_USER=lanebecker\n' > .dev.vars   # git-ignored; never commit
npx wrangler pages dev public
```

(Plain `python3 -m http.server` inside `public/` runs the site too — the `/api` calls
just 404 and the app falls back to mock data.)
