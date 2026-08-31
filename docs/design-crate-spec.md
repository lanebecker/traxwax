# TraxWax — Design Kit v1

Handoff spec for implementing the redesign on TraxWax.com. The authoritative source is
**`TraxWax App.dc.html`** — a working, interactive design with real data, real filtering,
real states. This document describes it so the implementation can be a graft, not a guess.

Files in this kit:

| File | What it is |
|---|---|
| `TraxWax App.dc.html` | **The design.** Full app: grid, filters, timeline, ledger, detail modal, all states, light + dark. Opens in any browser. |
| `TraxWax.dc.html` | Exploration file: the four rejected/merged directions (1a–1d) and the label-font study (3a–3f). Reference only. |
| `records.js` | The 24 sample records, flattened from the baseline kit. |
| `support.js` | Runtime for the `.dc.html` files. Not part of the production app. |

---

## 1. Brand

**Name:** TraxWax. Wordmark is **Anton**, uppercase, set in a solid black block, rotated `-1.2deg`,
knocked out in white. Block padding `12px 14px 10px` at 44px type (optical centering — Anton's
metrics are bottom-heavy; do not use symmetric padding). The block never changes color with theme;
it is black in both light and dark.

**Voice:** dry, not zany. Labels are shop language — `FILED UNDER`, `THE CRATE`, `THE LEDGER`,
`SEARCH THE CRATE`, `COLORED WAX`, `JUST IN`, `LIGHTS OUT`. Jokes live in secondary lines only
("one shelf, catalogued past the point of reason", "$412 of regret"), never in a control label.

**The tape.** Four translucent tape strips: two on the top edge of the red header, two on the
bottom corners of the panel. They are the only decorative element in the design. Do not add more.

**Rule:** covers are the content. Every surface around them is white, grey, black, or the one red.
No gradients, no shadows on the covers themselves, no image treatments.

---

## 2. Tokens

Defined as CSS custom properties on `:root`, overridden by `body[data-theme="dark"]`.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#eceef0` | `#0e0f11` | page behind the panel |
| `--panel` | `#ffffff` | `#17181b` | panel, cards, fields |
| `--bar` | `#d8dade` | `#212329` | filter bar, footer strip, empty bar tracks |
| `--ink` | `#16171a` | `#f0efed` | primary text, hard rules |
| `--muted` | `#54585f` | `#b4b7bd` | labels, secondary text (AA on `--bar`) |
| `--faint` | `#666a72` | `#9ea2a9` | tertiary meta (AA on `--panel`) |
| `--line` | `#16171a` | `#3a3d44` | structural 1.5px borders |
| `--hair` | `#d6d8dc` | `#2b2d33` | 1px internal dividers |
| `--accent` | `#e8194b` | `#e01046` | header band, active state, price emphasis |
| `--on-accent` | `#ffffff` | `#ffffff` | text on accent |
| `--shadow` | `#16171a` | `#000000` | hard offset shadows |
| `--tape` | `rgba(150,155,163,.26)` | `rgba(255,255,255,.12)` | tape strips |
| `--skel` | `#e4e6e9` | `#212329` | skeletons, cover placeholder |

Accent differs by theme on purpose: `#ff2f5e` reads better in the dark but fails AA with white
text. `#e01046` is the dark value. **Do not use `--faint` on `--bar`** — it fails AA; use `--muted`.

Theme is set with `document.body.dataset.theme = 'light' | 'dark'`. Persist the user's choice and
respect `prefers-color-scheme` on first visit.

---

## 3. Type

Three families, loaded from Google Fonts.

| Role | Family | Spec |
|---|---|---|
| Wordmark | **Anton** | 44px / uppercase / `line-height:1` |
| Record titles, big numbers, state headlines | **Barlow Condensed** 600–700 | card title 20px, ledger stat 40px, modal title 38px, state headline 34px |
| Labels, chips, meta, all data | **IBM Plex Mono** 400–700 | 9–11px, `letter-spacing .06–.16em`, mostly uppercase |
| Running text (tracklist, label names) | **Archivo** 400–600 | 13px |

Minimum sizes in use: 9px only for the `JUST IN` badge and column keys; 10.5px for the card artist
line; nothing else below 10px. Card artist and vinyl lines are single-line with ellipsis.

---

## 4. Layout

- Page: `--bg`, 26px gutter. Panel maxes at **1480px**, centered, `1px solid var(--line)`,
  `box-shadow: 5px 5px 0 rgba(0,0,0,.16)`.
- Panel stack, top to bottom: **header band (red)** → **filter bar (`--bar`)** → **view tabs + sort
  (white)** → **active-filters row (only when filters are on)** → **content** → **design-states
  strip (`--bar`)**.
- Structural borders are `1.5px solid var(--line)`; internal dividers `1px solid var(--hair)`.
  Nothing is rounded. Radius is 0 everywhere, by design.
- Grid: `repeat(var(columns), minmax(0,1fr))`, gap 16px, default **6 columns**.
  `minmax(0,1fr)` and `min-width:0` on the card are required — nowrap text otherwise blows out
  the tracks.

**Responsive** (not built in the kit — implement):
6 cols ≥1400px · 5 ≥1100 · 4 ≥820 · 3 ≥600 · 2 <600. Below 820px the filter bar becomes a
`FILTERS (n)` button opening a bottom sheet; tap targets 44px; the header stat strip collapses to
records + value only.

---

## 5. Components

### Card
White, `1.5px` black border, `3px 3px 0` hard shadow, no radius, no hover lift.
Cover inset 6px on three sides (top/left/right), flush to the metadata block.
Body, in order: **artist** (10.5px mono, uppercase, `--faint`, clickable → artist filter) ·
**title** (Barlow Condensed 20/700, clickable → detail) · **vinyl row** (9px swatch square with
1.5px border + shortened color name, clickable → color filter) · **rule** · **meta row**
(`YEAR · STYLE` left, price right).

The meta row is `align-items:flex-start` so the price stays put when the left line wraps.
`JUST IN` badge: accent, 9px/800, rotated `-2.5deg`, hanging off the cover's left edge.
Cap the visible style to one; the rest live in the detail view. Card heights stay uniform.

### Swatches
Square, 9px, `1.5px solid var(--line)`. Single color = flat fill; two colors = 50/50
`linear-gradient(90deg, a 0 50%, b 50% 100%)`. Derived from the format string by keyword match.
**Colored-wax detection requires a recognized color word** — "Fifth Pressing", "50th Anniversary",
"Zoetrope" are pressing notes, not colors, and must not count as colored or pass the filter.

### Filter model (the big change)
All facets **compose**; none clears another. Facet kinds: `STYLE` (multi), `WAX` (colored only),
`ARTIST`, `COLOR`, `SEARCH`. Every active facet appears in the **SHOWING** row as an accent chip
with its kind, its value, and a ✕; plus `CLEAR ALL`. `ALL n` clears styles only.
Sort is a single segmented control (`ADDED / ARTIST / YEAR / PRICE`) with a separate `↓ / ↑`
direction button — not two dropdowns.

One list model everywhere: no pagination. With static JSON, virtualize or infinite-scroll the
full result set.

### Views
- **THE CRATE** — the grid.
- **TIMELINE** — grouped by month added, newest first: a 150px left rail (month, count, group
  value) and a wrapping row of 84px cover tiles, each clickable.
- **THE LEDGER** — four big stats across the top (records / est. value / colored / added this
  month), then two panels: `Most-filed styles` horizontal bars and `The expensive end` top-5 list.

### Detail modal
840px, fixed overlay `rgba(10,10,12,.62)`, `8px 8px 0` shadow. Header: 190px cover, artist, title,
`year · label · country`, vinyl pill, added date, and a three-cell strip (rating / have-want /
**lowest sale**, the last one filled accent). Body: tracklist left, `Filed under` style chips +
label + `VIEW ON DISCOGS` / `▶ LISTEN` right. Closes on ✕, backdrop click, and Esc.
**Implemented (v1.3.3, W0.4):** the modal is a `role="dialog"`/`aria-modal` dialog with a
focus trap, focus restore to the invoking card on close, and it already loads `cover_image`
(not the 150px `thumb`) via `deco()`.

### States
- **Loading** — shimmering skeleton cards in the grid, same geometry. No progress bar, no
  per-record price ceremony: the proxy serves warm prices, so prices simply appear.
- **Empty** — `0 RESULTS` / "Nothing filed under that." / one dry line / `CLEAR THE FILTERS`.
- **Error** — `ERROR 503 · CRATE UNREACHABLE` / "Discogs isn't picking up." / `TRY AGAIN`.
- The `DESIGN STATES` strip at the bottom of the panel is a **demo affordance for this kit** —
  remove it in production.

---

## 6. Accessibility

Verified in the kit: all text clears WCAG AA 4.5:1 in both themes. Keep it that way.
- Covers are `role="img"` with `aria-label="{artist} — {title} cover"` (they are background
  images so an unresolved URL never fires a request). Use real `alt` if you switch to `<img>`.
- Every filterable string is a real `<button>`; focus ring is `2px solid var(--accent)` at 2px
  offset via `:focus-visible`.
- Shipped v1.3.3 (W0.4): modal focus trap + restore, arrow-key roving focus across the grid
  (single tab stop, Tab-into-cell so the focused card's controls stay reachable), and
  `aria-live` on the results count (the last shipped in v1.3.2).

---

## 7. Data seams (unchanged from the baseline kit)

- **Seam 1 — data.** The design reads a flat record shape:
  `{ id, artist, title, year, label, styles[], genres[], vinyl, thumb, added, rating, price }`.
  Map `collection.json` into that shape once, at load.
- **Seam 2 — live calls.** Prices and release detail come from the Cloudflare proxy
  (`/api/price/:id`, `/api/release/:id`, `/api/value`). The modal's tracklist and community stats
  are mocked in the kit; wire them to `/api/release/:id`.

## 8. Multi-user, later

The design is single-user but not painted into a corner: the header's owner line
(`Lane's shelf · filed by <word>`, where `<word>` is drawn per load from `FILED_BY` in `app.js` —
50 riffs on `whim`; v1.4.6) is the profile slot — it becomes `{handle} · {tagline}` with an
avatar to its left, and the stat strip is already per-collection. The panel is one collection;
a future browse-others view is a page above it, not a change to this one.

## 9. Tweakable props (as authored)

`theme` (light/dark) · `accent` (color) · `columns` (4–8) · `showPrices` (grid prices on/off) ·
`ownerLine` (text). These map to real product settings: public vs. private pricing, grid density,
and per-user branding.
