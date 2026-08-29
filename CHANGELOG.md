# Changelog

All notable changes to TraxWax are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

---

## [Unreleased]

_Nothing yet._

---

## [1.2.0] — 2026-08-29

Catalog refresh (GitHub #3, cold audit #15): the shared CC0 catalog is no longer frozen
at first sight. Plan: `docs/phase-2-catalog-refresh-plan.md` (rev 2, twice audited).
Migration 0010 and both function redeploys are live.

### Fixed
- **404 tombstones are no longer permanent.** A 404 now writes a DATED tombstone
  (`releases.gone_at`); it retries after 7 days under an owner's token, and any
  successful fetch clears it. Transient 404s heal instead of wedging a release
  tracklist-less forever.

### Changed
- **Basic catalog metadata refreshes on every import** (last-import-wins): artist,
  title, year, label, styles, genres, thumb, cover_image now merge through the new
  `seed_releases` RPC — Discogs community corrections propagate whenever anyone
  imports or re-syncs. The merge is empty-guarded (`''`/`0`/`[]` never stomp a real
  value), and seeds carry no deep fields, so enrichment cannot regress.
- **Deep fields re-fetch after 180 days**: rows whose `enriched_at` has aged out are
  re-enriched by leftover background budget (new work always first — the import gate
  still closes on new work exactly as before).
- `pending_enrichment` extended (superset response, backward-compatible); the
  background drain in `boot.js` now also drains refresh work.

---

## [1.1.0] — 2026-08-29

Account controls (GitHub #8): disconnect, deletion, and the authenticated-finalize step
that closes the link-CSRF accepted at Stage B. Plan: `docs/phase-2-account-plan.md`
(rev 2, twice audited). Migration 0009 and the four Edge Function deploys are live.

### Added
- **ACCOUNT modal** (header button, next to RE-SYNC): connected-as line, disconnect, and
  a danger-zone deletion with typed `DELETE` confirmation.
- **Disconnect Discogs** — removes the encrypted credential, the imported collection
  (Restricted Data tied to the connection, per the same rule re-linking uses), and any
  in-flight handshake state; the profile resets to never-connected. The dialog says all
  of this plainly, and points at Discogs → Settings → Applications for full revocation
  (Discogs offers no token-revocation API).
- **Delete my TraxWax data** — purges everything TraxWax stores (profile included).
  Deliberately does NOT delete the Clerk sign-in identity, which is shared infrastructure
  for future apps; the copy says so.
- The `import_status = 'error'` dead end now offers the disconnect exit it had been
  promising since Stage C.

### Security
- **Link-CSRF closed** (Stage B round-2 M-2, accepted 2026-08-28; Stage C/D carried it).
  The OAuth callback now parks completed links as *pending* and hands the approving
  browser a one-time code in the URL fragment (never sent to a server); the new
  `finalize-connect` function completes the link only when the code (possession) AND the
  verified Clerk sub (identity) both match the pending row — looked up by code hash,
  never by sub, because the state row's user id is the attacker's own in that attack.
  Only the code's SHA-256 lands in the DB. Proven by SQL replay: victim-with-code →
  `link_not_yours` + row consumed; attacker-without-code → cannot address the row.

---

## [1.0.1] — 2026-08-29

Post-launch bug batch: the cold-audit backlog's small fixes (issues #2, #4, #5, #6, #7)
plus the launch-day stale-cache bug (#9). Twice audited before commit (full adversarial
pass, then the narrow rework pass); DB migration 0008 and both Edge Function updates are
already live and verified.

### Fixed
- **Search** no longer rebuilds the whole app on every keystroke (150 ms debounce), and
  the caret stays where you were editing instead of jumping to the end. Focus and caret
  now survive *any* re-render — and a stale debounce timer can never steal focus, least
  of all behind an open modal. (#5)
- **JUST IN / THIS MONTH** use the local month, not UTC, so the badge and counter no
  longer flip a day early/late outside UTC. (#7)
- **Stale JavaScript after deploys**: `_headers` now sends `Cache-Control: no-cache` on
  HTML, the entry-point JS/CSS and `collection.json` (cheap ETag revalidation), plus a
  week-long cache on the immutable `releases/*.json`. Returning browsers pick up each
  deploy on the next load instead of running pre-launch code from cache. (#9)

### Changed
- **enrich-release** discovers pending work with a single `pending_enrichment` join RPC
  (migration 0008, SECURITY DEFINER, service-role-only) instead of ~18 DB round trips per
  invocation — ~6,700 queries saved per fresh 1,861-item collection. (#4)
- **connect-discogs** rate-limits OAuth leg 1 per user: a 10-second, DB-clocked cooldown
  armed *before* the Discogs call, so failed calls throttle a hostile loop too and the
  shared consumer key's 60/min budget can't be exhausted by one account. The connect UI
  explains the cooldown instead of showing a raw error token. (#2)

### Removed
- Dead code (#6): the client `api` helper — both its endpoints (`/api/value`,
  `/api/price`) were deleted in the 1.0.0 cold audit, leaving guaranteed-null callers —
  and the never-used `profiles.display_name` column. `collection_items.folder` and the
  personal `rating` stay imported (deliberately) but remain unrendered.

---

## [1.0.0] — 2026-08-29

TraxWax goes multi-user: anyone can sign in, connect their Discogs account, and browse
their own crate at `traxwax.com`.

### Added — Multi-user (Phase 1)

- **Accounts & sign-in** via Clerk; each visitor gets their own crate at `/app/<username>`,
  private to them.
- **Connect Discogs** through the OAuth 1.0a handshake; the per-user access token is stored
  encrypted (AES-256-GCM), server-side only.
- **Per-user collection import** into Supabase under each user's own token, with a shared
  CC0 catalog (`releases`) and live tracklist enrichment that drains in the background.
- **RE-SYNC** control with a last-synced indicator.
- **Live stats** — header estimate and per-record price/community stats fetched live under
  the user's token, cached ≤6h, never stored (Discogs Restricted-data compliance).
- Backend: five Supabase Edge Functions (connect-discogs, connect-discogs-callback,
  import-collection, enrich-release, live-stats); migrations 0001–0006; RLS throughout.
- Baseline security headers; end-of-phase cold audit with the fix batch folded in
  (see `docs/phase-1-cold-audit.md`; deferred items are GitHub issues #2–#8).

### Fixed

- **Colored Wax filter** rewritten to an exclusion model — it no longer drops records with
  unusual color names (e.g. "Maroon", "Beige", "Speckled Dragon Egg").

### Changed

- The crate reads from Supabase (per-user) instead of the baked `collection.json`; the
  baked file is now a dev fixture with Restricted fields removed. The weekly refresh
  workflow is retired (manual dispatch only).

---

## [0.4.0] — 2026-08-18

### Added

- **Discogs API attribution.** A site footer now carries the two notices the Discogs API
  Terms of Use require even for non-commercial use: a **"Data provided by Discogs"**
  do-follow link (no `nofollow`) and the affiliation/trademark disclaimer — *"This
  application uses Discogs' API but is not affiliated with, sponsored or endorsed by Discogs.
  'Discogs' is a trademark of Zink Media, LLC."* Rendered in the TraxWax idiom (IBM Plex Mono,
  accent-red link), legible in light and dark, and stacked left-aligned on mobile. The detail
  modal's per-release "VIEW ON DISCOGS" link already satisfies the per-item attribution.

---

## [0.3.1] — 2026-08-17

### Fixed

- **Mobile layout.** The design's inline styles only made the grid responsive; the header,
  filter bar, tabs + sort row, Ledger stat grid, and detail modal all overflowed on phones
  (the page scrolled sideways ~270px at 390px wide). Added mobile CSS (≤640px): the header
  stacks and drops the two least-vital counters (keeping IN CRATE + EST.), the sort control
  wraps to its own line, the Ledger goes 2-up with stacked panels, and the modal becomes
  single-column with a smaller cover. No horizontal scroll at any phone width; desktop is
  unchanged.

### Changed

- Renamed the nav tab **"TIMELINE" → "THE TIMELINE"** to match THE CRATE / THE LEDGER.

---

## [0.3.0] — 2026-08-17

### Added / Changed

- **The detail modal now reads baked data — no live Discogs call, immune to rate limits.**
  A single weekly `get_release` pass per record bakes everything the modal shows:
  - immutable parts (tracklist, country, release date, videos) → static per-release files
    at `public/releases/<id>.json`, loaded directly by the modal and cached forever. A
    pressing's tracklist never changes, so files are written once and existing ones are
    never rewritten (weekly diffs stay tiny).
  - changing parts (community rating, have/want, lowest sale) → fields on each record in
    `collection.json`, refreshed weekly, so the stat cells are instant and ≤1 week fresh.

  The modal falls back to the live `/api/release` proxy only for a brand-new record whose
  file hasn't been baked yet. This removes the "Track 1, 2…" placeholders and the
  rate-limit failures entirely. `refresh_collection.py` now runs one `get_release` pass
  (flags `SKIP_RELEASES` / `RELEASE_NEW_ONLY` / `RELEASE_LIMIT`) that **replaces the
  separate marketplace price bake** — `get_release` returns the lowest price too.

---

## [0.2.2] — 2026-08-17

### Fixed

- **Tracklists always resolve; the generic "Track 1, 2…" placeholders are gone.** The
  modal used to render fabricated track names instantly, then swap in the real ones —
  and when the Discogs fetch failed (a transient 429 rate-limit) the fakes stayed. Now
  it shows a shimmer skeleton while loading, then the real tracks — or an honest "no
  tracklist" / "couldn't reach Discogs — Retry", never fabricated ones. The
  `/api/release` fetch retries transient failures on both the client and the proxy, and
  results are cached in `localStorage` (tracklists are immutable) so a record you've
  opened before is instant and never re-fetched. Removed the mock track / rating /
  have-want fallbacks entirely.

---

## [0.2.1] — 2026-08-17

### Changed

- **Sharper cover art.** Covers now use Discogs' `cover_image` (~600px, quality 90)
  instead of the 150px `thumb`, which was being upscaled to ~380px on Retina and looked
  pixelated. `deco()` prefers `cover_image`, falls back to `thumb`, then the no-cover
  placeholder. `refresh_collection.py` and `build_collection.py` now capture
  `cover_image`, and `refresh_collection.py` gains a `SKIP_PRICES` mode for a ~1-minute
  metadata + cover refresh (no price bake). Regenerating `collection.json` also picked up
  3 newly-added records (1,850 → 1,853).

---

## [0.2.0] — 2026-08-17

### Added

- **Self-updating pipeline — no Claude, no Cowork, no local machine.**
  `.github/workflows/refresh-collection.yml` runs weekly (and on demand via *Run
  workflow*) and rebuilds `public/collection.json` from the Discogs API through
  `build/refresh_collection.py` — new records, edits, and **baked marketplace low
  prices** — then commits it; Cloudflare Pages auto-deploys. A price that fails to
  fetch keeps its previous value, so a rough API day never wipes prices. Replaces the
  old Cowork `rebuild-record-collection` task. One-time setup: add `DISCOGS_TOKEN` as a
  GitHub **Actions** secret (separate from the Pages secret).
- **Designed no-cover placeholder.** Records without album art now render a flat
  vinyl-disc placeholder — black disc, red label, artist initials, no gradients — in the
  TraxWax idiom, instead of a blank grey box. Applies to cards, timeline tiles, the
  ledger, and the detail modal.

### Changed

- DEPLOY step 6 rewritten from "manual weekly Cowork task" to the automated Actions
  workflow.

---

## [0.1.1] — 2026-08-17

### Fixed

- **Covers now load.** Card / timeline / ledger / modal cover art was written as
  `background-image:url("…")` inside a double-quoted `style="…"` attribute, so the
  inner double quotes closed the attribute early and every cover URL parsed to
  `url("")` — no album art loaded anywhere on the deployed site. Switched the `url()`
  in `deco()` to single quotes. Diagnosed on the live deploy (`traxwax.pages.dev`):
  computed `background-image` was `url("")` and **0** of 1,850 covers ever fetched;
  the Discogs CDN serves thumbs to the pages.dev origin fine (no hotlink block), so
  the empty URL was the whole cause.

---

## [0.1.0] — 2026-08-17

Initial build: the Claude Design redesign ported into a standalone site on the full
~1,850-record collection, plus the Discogs proxy. Not yet deployed — **v1.0.0** is
reserved for the first live deploy on Cloudflare Pages with the custom domain and
baked prices (see `docs/roadmap.md`).

### Added

- Production site (`public/`): `index.html` + `styles.css` + `app.js`, ported off
  the Claude Design runtime (`support.js` / `<x-dc>`) into a dependency-free vanilla
  renderer that copies the kit's inline styling verbatim.
- Three views — **THE CRATE** (grid), **TIMELINE** (by month added), **THE LEDGER**
  (stats) — over `public/collection.json` (1,850 records, flat shape).
- Composable facet filters (STYLE / WAX / ARTIST / COLOR / SEARCH) with the SHOWING
  chip row; single segmented sort (ADDED / ARTIST / YEAR / PRICE) + direction toggle.
- Light/dark themes (persisted, respects `prefers-color-scheme`); responsive columns
  6→2; loading, empty, and detail-modal states.
- Cloudflare Pages Functions proxy — `functions/api/release/[id].js`, `value.js`,
  `price/[id].js` — holding the Discogs token server-side, with edge caching and
  strict id validation.
- `app.js` calls the proxy for the detail modal and header value, with a graceful
  mock fallback so local dev (no proxy) still works.
- `build/build_collection.py` maps `discogs_records.json` → `public/collection.json`.
- Docs + versioning: `README.md` (version badge), `DEPLOY.md`, `docs/roadmap.md`,
  `CHANGELOG.md`, `VERSION`, and the `sync-version-badge` workflow.

### Notes

- Covers load from the Discogs CDN (`thumb`); no base64 (unlike the Cowork artifact).
- Per-record grid prices read `—` until the weekly price-bake lands (roadmap v1.1.0);
  the header EST. value and the modal's lowest sale go live once the token is set.
