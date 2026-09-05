# TraxWax

[![version](https://img.shields.io/badge/version-1.20.10-blueviolet)](VERSION)

**Live at [traxwax.com](https://traxwax.com)** — anyone's Discogs vinyl collection as a
browsable, filterable crate. Sign in, connect Discogs, and your records import in about a
minute. Static front-end on Cloudflare Pages (no framework, no build step) over a Supabase
backend (Postgres + Edge Functions) with Clerk auth.

## Layout

```
traxwax/
├── public/                   # Cloudflare Pages build output directory
│   ├── index.html            # landing page, served at /
│   ├── app/index.html        # app shell, served at /app and /app/<username>
│   ├── boot.js               # auth + routing entry; connect/import/account UI; data providers
│   ├── app.js                # the crate renderer, ported from the Claude Design kit
│   ├── styles.css            # tokens (light/dark) + base + ≤640px responsive
│   ├── collection.json       # DEV FIXTURE: baked single-user data (Restricted fields removed)
│   ├── releases/<id>.json    # baked CC0 release files — modal fallback tier for local dev
│   ├── _headers              # security headers + cache policy (no-cache entry points)
│   ├── _redirects            # rewrites /app/* to the app shell (see Routing)
│   └── _routes.json          # pins Pages Functions to /api/* so the static rules above apply
├── functions/api/
│   └── release/[id].js       # legacy CC0 proxy — last-resort modal fallback only
├── supabase/
│   ├── migrations/           # 0001–0025: schema, RLS, RPCs (see CLAUDE.md for the map)
│   └── functions/            # 9 Edge Functions — the real backend (see DEPLOY.md)
├── build/
│   ├── refresh_collection.py # legacy single-user data builder (manual dispatch only)
│   └── seed_catalog.py       # one-shot: emitted the CC0 catalog seed for Supabase (Phase 0)
├── .github/workflows/
│   ├── refresh-collection.yml  # RETIRED from cron; workflow_dispatch only (dev fixture)
│   └── sync-version-badge.yml  # keeps the README badge in sync with VERSION
├── docs/                     # roadmap, multi-user spec, phase plans + audits
├── screenshots/              # rendered reference states
├── VERSION · CHANGELOG.md · CLAUDE.md · DEPLOY.md
```

## How data flows (v1.0.0+)

Signed-in users read their crate from **Supabase** (`collection_items ⋈ releases` under
RLS). Imports run client-driven through the `import-collection` Edge Function under each
user's own Discogs OAuth token; the shared CC0 catalog (`releases`) is enriched in the
background by `enrich-release` and **keeps itself current** (v1.2.0): basic metadata merges
last-import-wins on every import, 404 tombstones retry after 7 days, and deep fields
re-fetch after 180 days. Restricted data (prices, community stats, ownership) is fetched
live per user via `live-stats` with a ≤6h server-side cache and never permanently stored.

The baked `collection.json` + `releases/*.json` remain as the local-dev fixture and the
modal's offline fallback tiers — not the production data path.

## Architecture notes

**Covers come from the Discogs CDN** — `cover_image`, roughly 600px at q90.

**Attribution is mandatory.** The footer carries the two notices the Discogs API Terms
require: the do-follow "Data provided by Discogs" link and the affiliation disclaimer. Do
not remove them. See `../Discogs-API-Terms-Summary.md`.

**Account controls (v1.1.0):** the header ACCOUNT modal offers disconnect (removes the
credential + imported collection; profile survives) and typed-confirmation data deletion
(everything TraxWax stores; the Clerk sign-in identity is deliberately untouched). The
OAuth callback parks completed links as *pending*; a one-time fragment code plus the
verified Clerk session completes them (`finalize-connect`), closing the link-CSRF.

## Routing

`/` is the landing page. `/app` and `/app/<username>` both serve `public/app/index.html` via
a `_redirects` rewrite, and `boot.js` reads the path to decide what to render: the Clerk
sign-in card when signed out, a connect prompt when Discogs is not linked, or the crate when
the signed-in user owns that username. **Crates are private by default** — but since the friends
wave, an owner can share their crate and/or wantlist with accepted friends (`crate_visibility` /
`wantlist_visibility`), so `/app/<username>` also resolves for a consented friend, who reads a
Restricted-data-free projection via the `get_friend_crate` RPC + friend-read RLS (gated on
`private.can_view_crate` / `can_view_wantlist`).

`boot.js` and `app.js` deliberately live at the `public/` root rather than under `/app/`.
Cloudflare Pages follows redirects "regardless of whether or not an asset matches the incoming
request", so a `/app/*` splat would serve HTML for any script parked beneath it, the module
MIME check would reject it, and every page would render blank.

## Run locally

`app.js` falls back to the baked fixture when the Supabase providers are absent, so the
crate renders standalone. Serve over HTTP rather than `file://`:

```
cd public && python3 -m http.server 8000    # http://localhost:8000
```

Auth, import, and live stats need the deployed Edge Functions — see **DEPLOY.md**.

## Versioning

`VERSION` (semver) is the single source of truth. To cut a release: edit `VERSION`, add a
`[x.y.z]` section to `CHANGELOG.md`, commit, push. `sync-version-badge.yml` rewrites the badge
above to match and warns if the changelog was not updated in the same push.

## Status

**Shipped through v1.14.0** (2026-09-03): the full single-user redesign (v0.x); multi-user launch —
Clerk auth, per-user Discogs OAuth (tokens AES-256-GCM at rest), client-driven import + background CC0
enrichment, live-only Restricted data (v1.0.0); account controls + link-CSRF-safe finalize (v1.1.0);
the self-healing catalog (v1.2.0); accessibility polish (v1.3.x); analytics (v1.4.7); wantlists + the
match matrix (v1.5.0) and THE OVERLAP (v1.6.0); a full cold audit remediated across frontend/security/
backend/perf (v1.8.3–v1.9.1); the friends & consented-crate social wave — friend-card redesign, the
`get_friend_crate` projection, friend-crate header + visibility states (v1.10.0–v1.11.0); the open-design
items wave incl. the landing FOUC fix (v1.12.0); optional any-pressing (master-level) matching (#28,
v1.13.0); the CSP flipped to enforced (#38, v1.13.0); and an end-of-phase cold audit — wantlist_items
write lockdown, RLS initplan perf, want-control fixes, doc refresh (v1.14.0). Full history in
`CHANGELOG.md`, release-by-release detail in `docs/roadmap.md`.

**Next** — remaining backlog is small: friend link-sharing (#10, parked) and future social waves.
See `docs/social-roadmap.md`.
