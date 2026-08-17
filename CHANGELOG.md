# Changelog

All notable changes to TraxWax are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

---

## [Unreleased]

_Nothing yet._

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
