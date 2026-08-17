# TraxWax — Deploy to Cloudflare Pages

The full site lives in this folder. Getting it live is: push once, connect Cloudflare,
set the token. (I couldn't push from my side — the connector's token isn't scoped to
this new repo, and the 780 KB `collection.json` can't stream through the GitHub API
anyway — so Step 1 is a one-time `git push` from your Mac, which carries everything
including the data file and screenshots.)

Set `git config --global user.email` to your GitHub **noreply** address first if it
isn't already (github.com/settings/emails), or the push is rejected with `GH007`.

---

## Step 1 — Push the code (run on your Mac, ~30s)

The repo already has a starter `README`/`LICENSE`, so the safe move is clone → copy
our files in → push (no rebase, keeps the LICENSE, overwrites the starter README):

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

## Step 6 — Bake grid prices — later (v1.1.0)

To light up per-record prices in the grid/Ledger/sort (not just the modal), a scheduled
job fetches marketplace lows for every record and writes them into
`public/collection.json`'s `price` field — fold it into the existing weekly
`rebuild-record-collection` task. (Fetching 1,850 lows on every page load is the thing
we're deliberately avoiding.)

## Local testing (optional)

Run the Functions locally with your token:

```bash
cd "…/traxwax-site"
printf 'DISCOGS_TOKEN=YOUR_TOKEN\nDISCOGS_USER=lanebecker\n' > .dev.vars   # git-ignored; never commit
npx wrangler pages dev public
```

(Plain `python3 -m http.server` inside `public/` runs the site too — the `/api` calls
just 404 and the app falls back to mock data.)
