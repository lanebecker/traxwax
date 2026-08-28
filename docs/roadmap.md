# Feature Roadmap — TraxWax

Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.
Minor releases add features; patch releases fix bugs without changing behaviour.
The current version is in the `VERSION` file at the repo root; the README badge is
kept in sync with it by `.github/workflows/sync-version-badge.yml`.

**Current version: `0.4.0`** — live at [traxwax.com](https://traxwax.com).

---

## Shipped

### v0.1.0 — Port & proxy

The Claude Design redesign ported off the design runtime into a standalone site on
the full collection, plus the Discogs proxy.

- THE CRATE / THE TIMELINE / THE LEDGER views over `public/collection.json`
- Composable facet filters + SHOWING row; single-control sort + direction
- Light/dark themes; responsive columns 6→2; loading / empty / modal states
- Cloudflare Pages Functions proxy (release / value / price) — token server-side

### v0.1.1 — Covers actually load

Fixed a `url()` quote collision that made every cover resolve to `url("")`.

### v0.2.0 — Placeholder + self-updating pipeline

- No-cover placeholder (flat vinyl disc, red label, artist initials)
- `build/refresh_collection.py` + a weekly GitHub Actions cron that commits
  `collection.json` and lets Cloudflare auto-deploy — **Claude and Cowork are out
  of the refresh loop entirely**

### v0.2.1 — Sharper covers

Switched from the 150px q40 `thumb` to `cover_image` (~600px q90).

### v0.2.2 — Real tracklists

Loading state, retry, and a localStorage cache on the modal tracklist.

### v0.3.0 — Baked modal data

One `get_release` pass per record bakes immutable data (tracklist, country,
released, videos) into write-once `public/releases/<id>.json`, and mutable stats
(community rating, have/want, lowest sale) onto each `collection.json` record.
**The modal makes zero live calls** and is immune to rate limits.

*This also delivered what the old roadmap listed as a future "v1.1.0 — baked grid
prices": grid prices, the Ledger's expensive end, the value stats, and price-sort
are all populated from baked data.*

### v0.3.1 — Mobile layout

Added a ≤640px media query. The page had been overflowing sideways ~270px at
390px wide. Renamed nav TIMELINE → THE TIMELINE.

### v0.4.0 — Discogs attribution

Site footer carrying the two notices the Discogs API Terms require: the
"Data provided by Discogs" do-follow link and the affiliation/trademark
disclaimer.

---

## Next

### v0.5.0 — Accessibility & polish

- Modal focus-trap + restore focus to the invoking card on close
- Roving arrow-key focus across the grid; `aria-live` on the result count
- Modal cover uses `cover_image` (not the 150px `thumb`)

### v1.0.0 — Multi-user

The substantial one, specified in `docs/multi-user-spec.md` and grounded by
`docs/phase-0-plan.md`. Clerk login, per-user Discogs OAuth, a shared CC0
release catalog, and live-only Restricted data. Phase 0 foundations are largely
in place; Phase 1 is the first shippable multi-user app.

---

## Retired

- **The Cowork artifact** (`lanes-record-collection`) — the original home of this
  project. Superseded by this site; see the project `CLAUDE.md` for the sunset
  record.

## Unscheduled / under consideration

- **In-app settings** — surface the kit's authored props (theme, accent, columns,
  `showPrices`, `ownerLine`) as real product settings.
- **"What to play tonight?"** random pick; shareable filtered-view URLs.
