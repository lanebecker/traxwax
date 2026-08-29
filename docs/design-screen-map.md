# TraxWax — Design Screen Map

Which surface in `TraxWax Surfaces.dc.html` (S0–S20) traces to which repo file, and where.
This is the **detailed, authoritative** surface→file map. The repo-root **`github.md`** is the
Design team's concise sync anchor (repo/branch + a high-level map + sync history) that a
design sync diffs against; it points here for detail. Keep this current when a surface moves.

Written 2026-08-29, against v1.3.2 (the pass that built these). Design truth:
`docs/design-surfaces-spec.md`; crate spec `docs/design-crate-spec.md` (identical to the
delivered `docs/design-source/DESIGN-KIT-V1.md`); runnable doc `docs/design-source/TraxWax
Surfaces.dc.html`.

| ID | Surface | Rendered by | Notes |
|---|---|---|---|
| **S0** | Shell system (buttons, fields, toggle, progress, state card, empty-state, avatar) | `public/boot.ui.js` | Pure functions, no Clerk/Supabase coupling. Classes for the landing live in `public/styles.css` (`.tw-btn*`, `.tw-wordmark*`, `.tw-tape*`). |
| **S1** | Landing page | `public/index.html` + `.tw-land-*` in `public/styles.css` | Static, no JS beyond the theme IIFE. Hero image is `/screenshots/crate-hero.png` (**ASSET TODO**, spec §11). |
| **S2 / S3** | Auth — sign-in / sign-up chrome | `boot.js` `mountAuth()` + `public/boot.clerk.js` (`clerkAppearance`) | Our `stateCard` frame, Clerk's component in the `extra` slot. Merged into `Clerk.load()`. |
| **S4** | Onboarding (name + photo) | `boot.js` `render()` onboarding block | `stateCard` + `UI.field` + `UI.avatar`; `COPY.onboarding`. Kicker `STEP 2 OF 3`. |
| **S5 / S6** | Connect Discogs (+ 13 errors) | `boot.js` `render()` `paintConnect()` | Reassurance panel in body; errors → problem slab. Copy in `UI.COPY.connect*`. |
| **S7 / S8** | Import running / progress | `boot.js` `runImport()` + `UI.progressBar` | Real bar + record count; on failure the bar stays and goes grey (`progressBar(pct, true)`). |
| **S9** | Importing is paused | `boot.js` `render()` `import_status === 'error'` | `danger` (outlined) button, no primary. `COPY.importPaused`. |
| **S10** | No crate here — **PRIVACY-CRITICAL** | `boot.js` `render()` username-mismatch branch | Grey rule, `COPY.noCrate`. Must stay byte-identical for not-found vs not-friends (§9.1). |
| **S11** | Something went sideways | `boot.js` `showError()` | Raw exception in a collapsed `<details>` (`TECHNICAL DETAIL`). `COPY.unexpected`. |
| **S12** | Finishing the link | `boot.js` `render()` `?connect=verify` branch | No buttons, no sign-out. `COPY.verify`. |
| **S13–S16** | Account surface (profile / sharing / friends / discogs / danger) | `boot.js` `renderAccount()` + `UI.accountPageHtml` / `UI.bindAccountPage` | Routed at **`/account`** and **`/account/discogs`** (`public/_redirects`). `SHARING` / `FRIENDS` are disabled `SOON` rows (Wave 1). |
| **S17** | Empty crate | `public/app.js` `emptyCrateHtml()` | `records.length === 0` branch in `render()`, before zero-results. |
| **S18** | Visiting someone else's crate | *space only — ▸ Wave 1* | Owner header designed to gain a visitor variant; see §9.2. `EST. VALUE` must not be load-bearing in the header layout. |
| **S19** | Card badge slot | `.tw-badge*` in `public/styles.css` + `badgesHtml`/`badgesFor` in `public/app.js` | *reserved — ▸ Wave 2*. Nothing emits them yet. |
| **S20** | Dark | every surface, `body[data-theme="dark"]` tokens in `public/styles.css` | No new tokens; wordmark keeps `#16171a` + gains a `--line` border. |

## Routing

- `/` → `public/index.html` (landing, S1)
- `/app`, `/app?mode=signup` → SPA shell `public/app/index.html` → `boot.js` (auth, onboarding, connect, crate gate)
- `/app/<username>` → the crate (`app.js`), or S10 for a non-owner
- `/account`, `/account/discogs` → SPA shell → `boot.js` `renderAccount()` (S13–S16)
- `/api/*` → Cloudflare Pages Functions (`functions/api/`, the CC0 release proxy)

`public/_redirects` rewrites `/app*` and `/account*` to the `/app/` shell (200, URL preserved).
`public/_routes.json` pins Functions to `/api/*` only, so those rewrites take effect in the
static asset store. `public/_headers` marks the entry-point JS + shells `no-cache`.

## Reserved-but-unbuilt (do not wire until the named wave)

- `UI.toggle` — consent switches, ▸ Wave 1 (crate) / Wave 2 (wantlist) / Wave 4 (for-sale). §9.5.
- `UI.emptyState` — the reusable pattern; ▸ "no friends yet" (W1), "no matches" (W2), empty overlap (W3). §9.9.
- `.tw-badge*` + `badgesFor()` — ▸ Wave 2 match badges. §9.3.
- `priceCellHtml()` in `app.js` — ▸ Wave 1 friend crates (server suppresses price). §9.4.
- `NAV` `sharing` / `friends` rows in `boot.ui.js` — disabled `SOON` until Wave 1.
- Landing `.tw-land-slab` — ▸ Wave 5 public-crates slot. §9.8.
