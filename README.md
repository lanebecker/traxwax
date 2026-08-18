# TraxWax

[![version](https://img.shields.io/badge/version-0.3.1-blueviolet)](VERSION)

The hosted home of Lane's record collection — the Claude Design redesign, ported off
the design runtime into a clean static site, running on the full ~1,850-record
collection. Destined for **traxwax.com** on Cloudflare Pages.

## Layout

```
traxwax-site/
├── public/                 # Cloudflare Pages "build output directory"
│   ├── index.html          # shell: fonts + mount point
│   ├── styles.css          # tokens (light/dark) + base + responsive columns
│   ├── app.js              # the app — ported from the Claude Design kit (no runtime dep)
│   ├── collection.json     # ~1,850 records: metadata + covers + baked stats/price
│   └── releases/<id>.json  # per-release baked tracklist/country/videos (immutable, one per record)
├── build/
│   ├── refresh_collection.py # THE data builder: Discogs API -> collection.json + releases/
│   └── build_collection.py   # legacy: discogs_records.json -> collection.json
├── functions/api/          # Cloudflare Pages Functions: the Discogs proxy (release, value, price)
├── .github/workflows/      # sync-version-badge.yml — keeps the README badge in sync with VERSION
├── docs/roadmap.md         # planned features and versioning
├── screenshots/            # rendered reference states (light/dark/ledger/timeline/modal/mobile)
├── VERSION                 # single source of truth for the version (semver)
├── CHANGELOG.md            # what changed in each version (Keep a Changelog)
├── CLAUDE.md               # project context + versioning rule (shared-facts block synced in)
└── DEPLOY.md               # deploy steps
```

## Versioning

`VERSION` (semver) is the single source of truth. To cut a release: edit `VERSION`
and add a `[x.y.z]` section to `CHANGELOG.md`, commit, push — the
`sync-version-badge` workflow rewrites the badge above to match and warns if the
changelog wasn't updated. See `docs/roadmap.md`.

## Run locally

Because `app.js` does `fetch('./collection.json')`, open it over HTTP, not `file://`:

```
cd public && python3 -m http.server 8000    # then visit http://localhost:8000
```

## Regenerate the data

```
DISCOGS_TOKEN=… python3 build/refresh_collection.py   # rebuilds collection.json + releases/ from Discogs
```

Flags: `SKIP_RELEASES=1` (metadata + covers only, ~30s), `RELEASE_NEW_ONLY=1` (only
new records' tracklists), `RELEASE_LIMIT=N` (cap get_release calls). The weekly GitHub
Action runs this for you.

## The two seams (see TRAXWAX-DESIGN-SPEC.md §7)

- **Seam 1 — data.** `public/collection.json`, shape `{id, artist, title, year, label,
  styles[], genres[], vinyl, thumb, cover_image, added, rating, price, crating, crcount,
  have, want}`. Covers load from the Discogs CDN (`cover_image`, 600px). Immutable
  tracklists live in `public/releases/<id>.json`.
- **Seam 2 — mostly baked.** The modal reads its tracklist from the static
  `releases/<id>.json` and its stats/price from `collection.json` — no live call. The
  Cloudflare proxy (`/api/value` for the header value, `/api/release/:id` as a fallback for
  a not-yet-baked new record) is the only live piece left.

## What's implemented vs. what's next

**Done (this phase):** full redesign ported (Crate grid, Timeline, Ledger, detail modal),
composable facet filters with the SHOWING row, single-control sort + direction, light/dark
themes (persisted, respects `prefers-color-scheme`), responsive columns (6→2), empty state,
loading state, all 1,850 records. The Claude Design `DESIGN STATES` demo strip was removed
per spec. Verified via headless render in light + dark + filtered + modal with zero console
errors.

**Done (deploy phase):** the proxy Functions (`functions/api/release/[id].js`, `value.js`,
`price/[id].js`) are built and `app.js` calls them (with graceful mock fallback for local
dev). Header **EST.** and the detail modal go live once the token is set. See **DEPLOY.md**.

**Next:**
1. Push + connect to Cloudflare Pages + set `DISCOGS_TOKEN` — **DEPLOY.md** steps 1–4.
2. Custom domain `traxwax.com` (move nameservers to Cloudflare) — DEPLOY.md step 5.
3. Bake per-record grid prices via the weekly task — DEPLOY.md step 6 (grid/Ledger read `—`
   until then; the modal's lowest sale is already live).
4. Spec polish still open: modal focus-trap + return focus, roving grid focus, `aria-live`
   on the result count, and `cover_image` (not the 150px `thumb`) for the modal cover.
```
