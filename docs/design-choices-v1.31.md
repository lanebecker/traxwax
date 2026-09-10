# TraxWax v1.31 remediation — visual / UI / UX choices for Claude Design review

A running list of every design-touching decision made (or surfaced) during the v1.31 cold-audit
remediation, for Lane to review with Claude Design. Two parts: **(A)** choices I actually made on
assets during remediation, and **(B)** UI/UX findings the audit surfaced whose *fix* is a design call,
not just an engineering one — flagged here rather than implemented, so Claude Design sets the direction.

---

## A. Choices made during remediation (already applied to the committed assets)

### A1 — Landing hero pill row (`public/screenshots/crate-hero.jpg`)
**What changed:** removed the `1516 COLORED` stat pill, removed the `$54,428.67 EST.` valuation pill, and
slid the `1,861 IN CRATE` white pill flush against the black `+12 THIS MONTH` pill. Result: one white box +
one black box, then the RE-SYNC / LIGHTS OUT action buttons unchanged.
**Why:** COLORED was removed from the live header everywhere (Lane), so the marketing screenshot had to
match; the valuation is Restricted Discogs data that must not bake into a committed/served image (audit T1.1).
**Design calls to confirm:**
- Is the white-pill-flush-against-black-pill pairing the intended final treatment, or should the stat pills
  keep an even gap the way IN CRATE/COLORED did?
- Removing two pills leaves a larger red gutter between the `LANEBECKER'S SHELF · FILED BY WHIM` byline and
  the IN CRATE pill. Acceptable, or should the cluster re-center?
- The hero is a hand-retouched raster. The durable fix is to **re-render it from the app** on a demo fixture
  with no Restricted data (so it can be regenerated on any header change) — worth doing in Claude Design?

### A2 — Detail-modal screenshot (`screenshots/06-detail-modal.png`)
**What changed:** the RATING (`4.3 (139)`) and HAVE/WANT (`1366 / 2459`) values were replaced with the app's
real `—` no-data glyph, matching the LOWEST SALE cell that already showed `—`.
**Why:** those are Restricted Discogs community fields (audit T1.4); the `—` is exactly what the app renders
with no marketplace data, so the screenshot now depicts a genuine, honest empty state.
**Design call:** same as A1 — the durable fix is re-rendering reference screenshots from a demo fixture
rather than retouching. Is a demo-data render path worth building?

### A3 — Fabricated dev fixture (`public/collection.json`)
**What changed:** the real 1,861-record ownership export was replaced with a 24-record clearly-fabricated
fixture (invented artists/titles, synthetic ids, no cover URLs).
**Why:** the real file shipped real ownership + personal ratings to anyone (audit T1.2) and is dead in prod.
**Design call:** none visual, but note the local-dev fallback now shows placeholder records — if any
screenshots are ever rendered from this path they'll show fake data (intended).

---

## B. UI/UX findings whose fix is a design call (surfaced, NOT yet implemented)

These are filed as GitHub issues (Tier 4 of the audit) but the *direction* is Claude Design's to set.
Grouped by theme; full detail per finding in `docs/cold-audit-v1.31.md`.

### Accessibility / contrast (these have a "correct" WCAG answer but a palette choice inside it)
- **T4.7 — dark-theme accent fails AA as text.** `--accent` (#e01046) on the dark panel/bg computes 3.66–3.96:1
  at 9.5–13px; the light accent on light bg is 3.86–4.50:1. Every account status/error line uses it. Needs a
  *lighter accent reserved for text* in dark (the brand red can stay for fills). Which red?
- **T4.24 / T4.25 / T4.23 — Clerk sign-in card in dark theme.** The "OR" divider text is 3.27:1; the field-error
  text uses the light accent (two different reds); and if you toggle to dark then hit the sign-in card, the whole
  card renders light-on-dark at ~1:1 (invisible). Needs the dark palette wired at mount + a legible divider/error color.
- **T4.3 — palette swatches** suppress the focus ring with an inline `outline`; needs a focus treatment that
  isn't the outline (e.g. an inset ring / box-shadow). What should a focused swatch look like?
- **T4.8 — tabs & sort buttons** convey selected/active state only by color; needs an accessible selected state
  (aria + a non-color cue). Does the active tab get an underline weight change, a check, etc.?
- **T4.2 — "UPLOAD A PHOTO"** is keyboard-unreachable; the fix (make the label a real button) is mechanical but
  the visible affordance is a design choice.

### Responsive / layout
- **T4.5 — SHARING visibility rows** side-scroll on a 360px phone (a consent screen). How should the label +
  the 3-segment control stack below ~640px?
- **T4.4 — account-nav separators** render as grey blocks ≤820px. Keep a divider in the horizontal strip, or drop it?
- **T4.6 — invite-link input** overflows the panel <398px. Full-width-on-wrap, or shrink?

### Copy / state
- **T4.1 — PROFILE tab** still says "Nobody sees any of this yet — your crate is private" unconditionally, now
  false. New copy? (Suggest: derive from the actual visibility, or a link to SHARING.)
- **T4.11 — locked for-sale row** always shows "🔒 PRIVATE" even when the stored value is FRIENDS/PUBLIC. Should
  the locked control show the *stored* selection (inert) rather than a hardcoded PRIVATE?
- **T4.13 — OG card headline** never truncates, so a very long single-token display name overflows the 1200×630
  card. Truncation rule / max length?
- **T2.17b — a missing release year renders a literal "0"** on the card (other surfaces show "—"). Confirm "—".
- **T2.17d — the FILED UNDER tray** says "NO MATCH" beside a matching selected chip. Copy/logic fix.

### Motion / micro-interaction
- **T4.12 — DISCONNECT button** jumps to full width when armed (loses `align-self`). Intended, or keep width?
- **T2.7 / T2.8 — focus/inert handling** when the DNA sheet or a state card interacts with the record modal —
  mostly engineering, but the *observable* symptom (focus jumping, a card behind an inert shell) is UX.

### Consistency / dead code (design-system hygiene)
- **T4.18 — three dead exports** (`emptyState()`, `toggle()`, `.tw-wordmark*`) with comments claiming they're the
  canonical builders. Either adopt them (so the wordmark/empty-state are truly one source) or delete them. A
  design-system call about where the single source of truth lives.
- **T4.9 — `a:hover`** never fires on account/friends links (inline color wins). Move link colors to classes so
  hover/focus states exist. What are the hover states?

---

_Generated during the v1.31 cold-audit remediation. Pair with `docs/cold-audit-v1.31.md` for the full findings._
