# Feature Roadmap — TraxWax

Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.
Minor releases add features; patch releases fix bugs without changing behaviour.
The current version is in the `VERSION` file at the repo root; the README badge is
kept in sync with it by `.github/workflows/sync-version-badge.yml`.

---

## v0.1.0 — Port & proxy ✅ (current)

The Claude Design redesign ported off the design runtime into a standalone site on
the full ~1,850-record collection, plus the Discogs proxy. See `CHANGELOG.md`.

- THE CRATE / TIMELINE / THE LEDGER views over `public/collection.json`
- Composable facet filters + SHOWING row; single-control sort + direction
- Light/dark themes; responsive columns 6→2; loading / empty / modal states
- Cloudflare Pages Functions proxy (release / value / price) — token server-side
- Header EST. + modal detail wired live (mock fallback for local dev)

---

## v1.0.0 — First live deploy

- Pushed + connected to Cloudflare Pages; `DISCOGS_TOKEN` set as a secret
- `traxwax.com` custom domain (nameservers moved to Cloudflare, SSL)
- Header value + detail modal live from the proxy, end-to-end
- Verified on the `*.pages.dev` URL and the apex domain

---

## v1.1.0 — Baked grid prices

- Weekly job fetches marketplace lows for every record → `collection.json` `price`
- Grid prices, the Ledger "expensive end", the value stats, and price-sort populate
- Folds into the existing weekly `rebuild-record-collection` task

---

## v1.2.0 — Accessibility & polish (design-spec follow-ups)

- Modal focus-trap + restore focus to the invoking card on close
- Roving arrow-key focus across the grid; `aria-live` on the result count
- Modal cover uses `cover_image` (not the 150px `thumb`)

---

## Unscheduled / under consideration

- **Multi-user** — the header owner line and per-collection stats are already the
  seam (DESIGN spec §8); a browse-others view is a page above this one, not a change
  to it.
- **In-app settings** — surface the kit's authored props (theme, accent, columns,
  `showPrices`, `ownerLine`) as real product settings.
- **"What to play tonight?"** random pick; shareable filtered-view URLs.
