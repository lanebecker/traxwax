# TraxWax

[![version](https://img.shields.io/badge/version-1.0.0-blueviolet)](VERSION)

**Live at [traxwax.com](https://traxwax.com)** — Lane's Discogs vinyl collection as a
browsable, filterable crate. ~1,861 records. Static site on Cloudflare Pages, no framework,
no build step, and it refreshes itself weekly with no human in the loop.

## Layout

```
traxwax/
├── public/                   # Cloudflare Pages build output directory
│   ├── index.html            # landing page, served at /
│   ├── app/index.html        # app shell, served at /app and /app/<username>
│   ├── boot.js               # auth + routing entry point; decides whether app.js loads
│   ├── app.js                # the crate renderer, ported from the Claude Design kit
│   ├── styles.css            # tokens (light/dark) + base + ≤640px responsive
│   ├── collection.json       # every record: metadata, covers, baked stats + price
│   ├── releases/<id>.json    # per-release immutable tracklist/country/released/videos
│   └── _redirects            # rewrites /app/* to the app shell (see note below)
├── functions/api/            # Pages Functions — the Discogs proxy; token stays server-side
│   ├── release/[id].js       #   fallback release detail for un-baked new records
│   ├── price/[id].js         #   marketplace stats for one release
│   └── value.js              #   whole-collection estimated value (header EST.)
├── build/
│   ├── refresh_collection.py #   THE data builder: Discogs API → collection.json + releases/
│   ├── build_collection.py   #   legacy: discogs_records.json → collection.json
│   └── seed_catalog.py       #   one-shot: emits the CC0 catalog seed for Supabase (Phase 0)
├── supabase/migrations/      # multi-user schema + RLS
├── .github/workflows/
│   ├── refresh-collection.yml  # weekly data refresh → commit → auto-deploy
│   └── sync-version-badge.yml  # keeps the README badge in sync with VERSION
├── docs/                     # roadmap, multi-user spec, phase plans
├── screenshots/              # rendered reference states
├── VERSION · CHANGELOG.md · CLAUDE.md · DEPLOY.md
```

## How it stays current

`.github/workflows/refresh-collection.yml` runs weekly and on `workflow_dispatch`. It
executes `build/refresh_collection.py`, which pulls the collection from the Discogs API, does
one `get_release` pass per record, writes `collection.json` plus any new `releases/*.json`,
and commits. Cloudflare deploys the commit automatically.

**No scheduled task, no local machine, no human.** The Cowork artifact that used to require
all three was retired 2026-08-28.

## Architecture notes

**The detail modal makes zero live calls.** Immutable data (tracklist, country, release date,
videos) is baked once into write-once `public/releases/<id>.json`; mutable stats (community
rating, have/want, lowest sale) live on each `collection.json` record and refresh weekly. The
modal is therefore immune to rate limits and can never show a fabricated tracklist.

**Covers come from the Discogs CDN** — `cover_image`, roughly 600px at q90. There is no
base64 embedding; that only ever existed to work around Cowork iframes blocking CDN URLs, and
that constraint died with the artifact.

**Attribution is mandatory.** The footer carries the two notices the Discogs API Terms
require: the do-follow "Data provided by Discogs" link and the affiliation disclaimer. Do not
remove them. See `../Discogs-API-Terms-Summary.md`.

## Routing

`/` is the landing page. `/app` and `/app/<username>` both serve `public/app/index.html` via
a `_redirects` rewrite, and `boot.js` reads the path to decide what to render: the Clerk
sign-in card when signed out, a connect prompt when Discogs is not linked, or the crate when
the signed-in user owns that username. **Crates are private** — `/app/<username>` resolves
only for its owner.

`boot.js` and `app.js` deliberately live at the `public/` root rather than under `/app/`.
Cloudflare Pages follows redirects "regardless of whether or not an asset matches the incoming
request", so a `/app/*` splat would serve HTML for any script parked beneath it, the module
MIME check would reject it, and every page would render blank.

## Run locally

`app.js` fetches `./collection.json`, so serve it over HTTP rather than `file://`:

```
cd public && python3 -m http.server 8000    # http://localhost:8000
```

To exercise the proxy Functions too, see **DEPLOY.md → Local testing**.

## Regenerate the data

```
DISCOGS_TOKEN=… python3 build/refresh_collection.py
```

Flags: `SKIP_PRICES=1` (fast metadata + covers only, ~30s), `SKIP_RELEASES=1`,
`RELEASE_NEW_ONLY=1` (only new records' tracklists), `RELEASE_LIMIT=N`. A full pass takes
~35–40 minutes against the rate limit. The weekly Action does this for you; you only need it
by hand to pick up new records immediately.

## Versioning

`VERSION` (semver) is the single source of truth. To cut a release: edit `VERSION`, add a
`[x.y.z]` section to `CHANGELOG.md`, commit, push. `sync-version-badge.yml` rewrites the badge
above to match and warns if the changelog was not updated in the same push.

## Status

**Shipped** through **v0.4.0** — the full redesign (Crate / Timeline / Ledger), composable
facet filters, single-control sort, light/dark themes, responsive 6→2 columns, the baked
detail modal, mobile layout, the self-refresh pipeline, the custom domain, and the required
Discogs attribution. Full history in `CHANGELOG.md`.

**Next** — see `docs/roadmap.md`:
- **v0.5.0** accessibility polish: modal focus-trap and focus restore, roving grid focus,
  `aria-live` on the result count, `cover_image` for the modal cover.
- **v1.0.0** multi-user: Clerk login, per-user Discogs OAuth, a shared CC0 release catalog,
  and live-only Restricted data. Design in `docs/multi-user-spec.md`; foundations in
  `docs/phase-0-plan.md` (complete); build plan in `docs/phase-1-plan.md`.
