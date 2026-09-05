# Wave 5a — shareable filtered-view URLs — plan

Status: **MECHANISM BUILT + audited to convergence (2026-09-04)** — unversioned, sitting in the working tree,
HELD to bundle with the DNA card + Design'd share buttons as one 5a "share the shelf" release. Verification-pass
caught 2 grid-blanking gaps (match/forsale on empty context) + 2 spec gaps (dir/sort); remediation-audit Pass-1
caught 3 more (match-ctx gate, textarea leak, unknown-param strip) → all fixed; Pass-2 on the rework clean.
**Frontend only — no migration, no Edge, no break-glass.**
The terms-clean half of Wave 5a (the DNA card is the other half, awaiting the Claude Design kit). Roadmap §8:
"Shareable filtered-view URLs — state serialized to the query string; works on own/public crates." Target the
next free minor (indicative v1.20.0; ships when the DNA card is also ready, or on its own).

## What it does
The crate's filter/sort state (not just the tab) is reflected in the URL, so a link — copied or bookmarked —
reopens the same filtered view. Today only the tab rides the URL (as a `#hash`); facets are session-only.

## The state that travels (and how it's encoded, in the query string)
| state field | param | encoding | notes |
|---|---|---|---|
| `state.view` | (unchanged) | the existing `#hash` (`#wantlist`/`#timeline`/`#ledger`) | KEEP the hash for the tab — don't move it; it already works + `#selling` deep-links depend on it |
| `state.genres` (array) | `g` (repeated) | one `g=` per style (`p.append`), NOT comma-joined | a Discogs style name can itself contain a comma ("Folk, World, & Country"), so repeat the param instead of comma-splitting; parse via `getAll('g')` |
| `state.coloredOnly` | `wax` | `1` when true, omitted when false | |
| `state.color` | `color` | the value | e.g. `?color=Red` |
| `state.artist` | `artist` | the value | added in build (a real removable facet, `computeVals` line 675) — without it "share this filtered view" silently drops an active artist filter. Same string-compare (`r.artist!==s.artist`) + `esc()`-in-chip safety as `color` |
| `state.query` | `q` | `encodeURIComponent` | the search box |
| `state.sort` | `sort` | the value, **whitelisted** to `added`/`artist`/`year`/`price` | unknown → fall back to `added` (a junk `?sort=x` makes `sorted()`'s `key(a)` throw — the whitelist is load-bearing, not cosmetic) |
| `state.dir` | `dir` | `asc`→`+1`, omitted→`-1` | `state.dir` default is `-1` **globally** (not per-sort — `case 'sort'` never touches dir). Emit `dir=asc` only when `+1`; omit at `-1`; parse missing→`-1`, `asc`→`1`, anything else→`-1` |
| `state.forSaleOnly` | `forsale` | `1` when true | **apply from URL only when `__twInventory` has entries** — an empty-but-non-null Map (own crate w/ 0 listings; friend crate w/o for-sale consent) is truthy and `matches()` excludes every record → blank grid. Mirror the `#selling` gate |
| `state.matchFilter` | `match` | `youWant`/`theyWant` | **friend-crate-only — apply from URL ONLY when `!IS_OWN()`.** On an own crate `__twMatchCtx` is null and `matches()` returns false for EVERY record (blank grid), so a stray `match` must be dropped, not "ignored" |

Only non-default values are emitted, so an unfiltered crate stays a clean `…/app/<user>` URL (no `?`).

## Task 1 — serialize: a `_syncFilterUrl()` called from `render()`
Add a helper that composes the query string from `state` (only non-default fields), preserves the CURRENT hash
(the tab), and `history.replaceState`s it — but ONLY when the resulting URL differs from the current one (guard
against redundant writes on the many non-filter re-renders: stats loads, modal opens, tracklist fills). Call it
once at the end of `render()`. It must NOT touch the hash (the tab writers at the `case 'view'`/`#selling`/boot
sites own the hash; this only rewrites `location.search`). Debounced search already coalesces `q` writes via the
render it triggers.
- Do NOT `pushState` (no new history entries per keystroke) — `replaceState` only, same as the tab sync.

## Task 2 — apply: parse the query at `bootCrate`, before the first render
In `bootCrate`, after the existing tab/`#selling` hash logic (~app.js:1530-1546) and after the `state` resets
(1512-1514), parse `location.search` and set the corresponding `state` fields, so the first paint is already
filtered. Guards:
- Apply **pure data facets** (`g`/`wax`/`color`/`q`) on any crate (own/friend/public) — harmless where they match nothing.
- `match=youWant/theyWant` — apply **only when `!IS_OWN()`** (the friend-crate case). On an own crate,
  `__twMatchCtx` is force-nulled and `matches()` returns false for EVERY record when `matchFilter` is set —
  a stray `match` param would BLANK the whole crate, not no-op. Drop it on own crates. (Mirrors the `#selling`
  friend gate.) On a friend crate, apply after `__twMatchCtx` loads (awaited before first render).
- `forsale=1` — apply **only when `window.__twInventory` has entries** (`.size > 0`). An empty-but-non-null Map
  is truthy, and `matches()` then excludes every record → blank grid. Empty-Map cases: own crate with zero
  listings, and friend crate with the match provider but no for-sale consent. The live FOR SALE button already
  guards on `_n>0`; a URL param bypasses that, so re-apply the same guard here. (`__twInventory` is awaited before
  first render.)
- Sanitize every value: `genres`/`color` only accept strings; `sort` **whitelisted to `{added,artist,year,price}`,
  unknown → `added`** (an unrecognized key throws in `sorted()`); `dir` only `asc` maps to `+1`, everything else
  → `-1`; unknown/junk params are ignored (never throw, never inject).
- The reset block already nulls `matchFilter`; set the parsed values AFTER it (like `_bootSelling`).

## Task 3 — the copy-to-clipboard HELPER now; the BUTTONS to Claude Design (SETTLED, Lane 2026-09-04)
Lane's call: TWO affordances — a **persistent "Share my crate"** control AND a **contextual "Share this filtered
view"** control — and their **placement + visual design go to Claude Design** (folded into the 5a design pass,
alongside the DNA card). So this plan builds only the MECHANISM; the buttons are wired when the kit returns.
- **Build now:** a `_copyShareLink()` helper — `navigator.clipboard.writeText(location.href)` (the URL already
  reflects state via Tasks 1–2), with the existing snackbar confirming "Link copied" (fallback: a temp
  `<textarea>` + `execCommand('copy')` for older/permission-denied cases; never throw). Expose it via the
  existing `data-act` click delegation (e.g. `case 'copyLink'`) so a Design'd button just needs
  `data-act="copyLink"` (or `data-act="copyCrateLink"` for the bare-crate variant — same helper, the URL differs
  only by whether filters are active).
- **Deferred to the Design kit + a follow-up build:** where the two buttons sit, how they look, their labels/
  icons, and the empty-vs-filtered distinction. Left as a task; 5a's *visible* share affordance ships when the
  design lands (with the DNA card).
- **5a can still ship the mechanism** (address bar reflects filters → bookmarkable/manually-copyable) ahead of
  the buttons if desired; recommend holding the 5a release to bundle mechanism + Design'd buttons + DNA card as
  one coherent "share the shelf" cut.

## Scope / edges
- **Own crate:** full — reload/bookmark preserves your filtered view. Primary 5a use.
- **Public crate (5b):** the same query params apply on `/c/<slug>` when that ships — no extra work then.
- **Friend crate:** data facets apply; `match` applies once you're that friend (context loads); `forsale`
  applies only if you have for-sale consent (non-empty `__twInventory`). Where the context/consent is absent the
  param is DROPPED at parse (not applied-then-empty) — so the link degrades to the base filtered crate, never a
  blank grid. That gating is the whole point of defects #1/#2 above.
- **No PII/security surface:** params are facet values (genres, colors, search text) — the search text is the
  only user-entered string; it's `encodeURIComponent`'d and only ever set into `state.query` (already rendered
  through `esc()`), never `eval`'d or put in the DOM raw. No token, no id list, no ownership data in the URL.

## Post-build verification
- `node --check app.js`.
- Live: apply genres + colored + a sort on your crate → the address bar gains `?g=…&wax=1&sort=…`; copy it,
  open in a fresh tab → same filtered view paints on first load; clear all → URL returns to clean; the tab hash
  still works alongside (`#wantlist?…` coexists); a hand-mangled param (`?sort=garbage`) is ignored, not thrown.

## Audit plan
remediation-audit Pass-1 (break this): URL==state round-trips (serialize→parse is lossless for every field +
default-omission is symmetric); the render-time sync can't loop or thrash (only writes on change; no pushState);
parse sanitizes every param (no injection via `q`/`color`/`g`; junk ignored); the tab-hash + `#selling` logic is
untouched (facet sync only rewrites search, never hash); friend-only `match` doesn't leak/misapply on own crates.
Narrow Pass-2 over rework. Converge.
