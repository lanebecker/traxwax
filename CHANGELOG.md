# Changelog

All notable changes to TraxWax are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

---

## [Unreleased]

_Nothing yet._

---

## [1.9.2] — 2026-09-02

Friend-visibility **#42** — friend-crate read projection (backend + frontend; migration `0021` via
break-glass).

### Fixed
- **A consented friend can no longer read the owner's `folder` or `instance_id` (#42).** The friend crate
  read moved from a table-wide `collection_select_friends` RLS SELECT (every column readable) to a SECURITY
  DEFINER projection RPC `get_friend_crate`, gated on `private.can_view_crate`, returning only the display
  columns + `rating` (**ratings stay visible to friends, by design**). `folder` and `instance_id` are never
  emitted, and the internal `collection_items.id` surrogate is stripped from the payload too. The table-wide
  friend policy is **dropped**, so `collection_items` is no longer friend-readable at the table level —
  `get_friend_crate` is the sole friend crate path. `boot.js` reads via the RPC (one ordered array, no
  pagination); no visible change to the grid.

### Notes
- Adversarial audit: Pass-1 caught the RPC emitting the internal `collection_items.id` (a *different*
  internal id) into the friend payload → fixed (`to_jsonb(t) - 'ord'`); Pass-2 over the fix verified
  byte-for-byte serialization parity with the prior shape → converged.
- **#43** (wantlist-only visitor + locked crate tab) and **#47** (friend-crate header) are the next bundle,
  built with the friend-crate-view design pass.

---

## [1.9.1] — 2026-09-01

Cold audit remediation — **Wave 4: performance + modal a11y (#44, #37 modal-inert).** Frontend only
(`public/app.js`); no Edge, migration, or break-glass.

### Fixed
- **Opening a record no longer rebuilds the entire card grid (#44).** The detail modal now renders into its
  own body-level `#tw-modal-root` (a sibling of `#app`, like the toast/snackbar) via a new `renderModal()`,
  instead of being part of `render()`'s `#app` innerHTML. A single record-open fired `render()` three times
  (openDetail → `_loadStats` → `_loadRelease`), each recomputing `computeVals()` and re-parsing every card;
  those six modal-only paths (also Escape, retryDetail, closeDetail) now call `renderModal()`, leaving the
  grid DOM untouched. `render()` is shell-only and ends by delegating to `renderModal()`, so a full render
  still finishes with the same roving-tabindex-then-modal-focus behavior as before.
- **The modal is now inert-isolated (#37, modal-inert sub-item).** While a record modal is actually open,
  `#app` is set `inert` + `aria-hidden`, so keyboard/screen-reader focus is trapped in the dialog and can't
  wander into the grid behind it; the body-level modal, toast, and undo snackbar stay interactive. Closes
  the last a11y-infra piece of #37 (search label shipped in v1.8.3; sub-44px tap targets + landing-theme
  FOUC remain, tracked in #37).

### Notes
- **Render coalescing / grid-HTML memoization deliberately left out of scope (#44).** The container split
  removes the pathological 3×-grid-rebuild on modal open; batching `render()` into an animation frame would
  make the render heart async and risk focus/caret/roving timing bugs — high risk, low remaining value.
- **Adversarial audit:** Pass-1 (executed jsdom repros) found two introduced defects, both fixed before
  ship — the shell `inert` toggle now gates on the modal *having rendered* (`state.detailId` truthy **and**
  `#tw-modal-root` non-empty), not on `detailId` alone (an absent record would otherwise inert the shell
  behind an empty modal-root); and `_syncGridRoving()` moved into `renderModal()` so standalone modal
  open/close paths re-point the grid's roving tabindex (pre-refactor only `render()` did). Pass-2 over the
  rework was clean. One pre-existing finding filed as **#48** (a pending deferred-remove timer survives a
  `bootCrate` re-boot).

---

## [1.9.0] — 2026-09-01

Cold audit remediation — **Wave 3: backend & DB integrity (#40, #41).** Migration `0020` (applied via
break-glass); no Edge or frontend change.

### Fixed
- **Account deletion de-identifies invites the user accepted (#40)** — `delete_account` now nulls
  `friend_invites.accepted_by` where it held the deleted user's Clerk sub, keeping `used_at` so the
  single-use invite stays consumed. Closes a right-to-erasure residue.
- **anon reads no longer error on the friend-shared tables (#41)** — the `collection_select_friends` and
  `wantlist_select_friends` RLS policies are scoped `TO authenticated`, so an anonymous SELECT never
  reaches the `private.*` consent function (which it couldn't execute since migration 0016, erroring
  instead of returning empty). No change for signed-in users; unblocks the Wave-5 public-crate direction.

### Notes
- **#39 (import future-skew sweep) deferred** — the proposed `least(startedAt, db_now)` clamp was a no-op
  (caught by the verification pass: `db_now` at sweep time is newer than the fresh rows). The correct fix
  is a protocol change (persist page-1's server clock and sweep against it), disproportionate for a
  low-severity, self-scoped, self-healing bug. Left open with the approach documented.

---

## [1.8.5] — 2026-08-31

Friend-crate card redesign (design spec: friend-want; interim design work between cold-audit Waves 2 and 3).

### Changed
- **Add/remove on a friend's crate moved into the card's meta row.** The full-width `＋ ADD TO WANTLIST`
  button is gone; the meta footer now shows a quiet **+ WANT** (accent) when a record isn't on your
  wantlist and **✕ REMOVE** (ink — the same control as the wantlist tab) when it is. The **ON YOUR
  WANTLIST** cover strip states the status.
- **Adding is instant and quiet** — the strip is the confirmation, so there's no snackbar on add.
- **Removing reuses the wantlist undo snackbar** (deferred Discogs delete, UNDO within the ~6s grace
  window), but the card **stays on the friend's shelf** — only the strip and the meta control revert.
  (Re-clicking + WANT during the grace window cancels the pending delete with no round-trip.)
- **`SEE ON DISCOGS →` retired from the card face** — it lives on the record's detail view
  (`VIEW ON DISCOGS ↗`). The full-width friend button and the dead `priceCellHtml` are removed; the
  MATCHES stat refreshes when an add/remove commits.

---

## [1.8.4] — 2026-08-31

Cold audit remediation — **Wave 2: security hardening (#38).**

### Added
- **Content-Security-Policy (report-only) on all routes** — a full policy (script / style / img / font /
  connect / frame / worker allowlists) shipped in REPORT-ONLY mode so it validates against the live app
  (Clerk, Supabase, Umami, Google Fonts, Discogs covers) without blocking anything. Once the browser
  console is clean of violations, flip the header name to `Content-Security-Policy` to enforce.
- **Strict-Transport-Security** (`max-age=31536000; includeSubDomains`) and a **Permissions-Policy**
  (camera / microphone / geolocation / interest-cohort disabled) — both enforced.

### Notes
- SRI intentionally omitted: Clerk `@6` / supabase-js `@2` / umami `script.js` are moving version tags
  where a pinned integrity hash breaks on their next update; the CSP script-src allowlist is the
  supply-chain mitigation instead.
- Before enforcing, watch the console for `challenges.cloudflare.com` (Clerk bot-protection, if enabled —
  would need adding to script-src + frame-src) and `clerk-telemetry.com` (connect-src; non-breaking).

---

## [1.8.3] — 2026-08-31

Cold audit (2026-08-31) remediation — **Wave 1: frontend correctness, a11y & config-safety.**

### Fixed
- **config.toml: added the missing `verify_jwt=false` blocks for `disconnect-discogs`, `delete-account`,
  `finalize-connect` (#30)** — each verifies Clerk in-handler, so a config-driven deploy would otherwise
  401 them. Config only; no redeploy needed — it prevents a future break.
- **Sign-in no longer risks a spurious error card mid-hydration (#32)** — `render()` guards on the Clerk
  user object, not just `isSignedIn`.
- **Genre chip counts now match what clicking the chip returns (#33)** — the filter is styles-only, like
  the counts (and guards a non-array `styles`).
- **Import loops no longer stop early if a page response omits `pages` (#35)** — `d.done` is the terminator.
- **Rate-limit backoff widened 30s → 60s to clear Discogs' ~60s window (#36).**
- **Detail modal no longer fabricates country "US" for unknown / still-loading releases (#34)** — shows "—".
- **Wantlist remove keeps keyboard focus reachable (#31)** — focus moves to UNDO after a remove.

### Added
- **Page titles reflect the crate (#45)** — "TraxWax — My Crate" on your own, "TraxWax — {name}'s Crate"
  on a friend's.
- **All Discogs links open in a new tab (#46)** — the landing footer attribution now matches the app.
- Search input `aria-label` (part of #37).

### Known follow-ups (tracked)
- #37 (partial): modal `inert` moves to Wave 4 (#44, with the modal-container refactor); sub-44px tap
  targets (AAA — already AA-compliant) and the landing theme FOUC (nit) remain, pending a design call.

---

## [1.8.2] — 2026-08-31

### Changed
- **Card meta footer now bottom-aligns within a grid row.** The divider and the `year · style` line (with
  the price, or `✕ REMOVE` on the wantlist) sit on a shared baseline across a row regardless of title
  length, instead of floating up under shorter titles next to a tall multi-line title. Card content flexes
  to fill the row-stretched height; the footer is pinned to the bottom.

---

## [1.8.1] — 2026-08-31

### Added
- **THE WANTLIST empty state now fits the moment** (completes the wantlist-remove redesign). Two variants,
  both on the existing empty-state layout: when you've just cleared the list yourself this session —
  "The wantlist is clear." with a single BACK TO THE CRATE; when it's genuinely empty (fresh account, or
  nothing wanted on Discogs) — "Nothing on the wantlist yet" with BUILD YOUR WANTLIST ON DISCOGS + RE-SYNC.
  An in-session flag picks between them and resets on reload. (The design's "bring them all back" restore-all
  was intentionally dropped — the per-item undo snackbar is the safety net, and it would otherwise mean a
  batch of Discogs re-adds reversing already-committed deletes.)

---

## [1.8.0] — 2026-08-31

Wantlist remove control redesign (from the design handoff). The empty-state redesign is intentionally
deferred pending discussion.

### Changed
- **THE WANTLIST remove control is now quiet and reversible.** The full-width `✕ REMOVE FROM WANTLIST`
  button under every card (a "wall of black boxes" that out-weighed the covers) is replaced by an
  underlined `✕ REMOVE` action in the card's meta row, opposite `year · style`. Removing a record drops
  it from the grid immediately and shows an undo snackbar naming the record; the Discogs delete commits
  when the snackbar is dismissed or times out (~6s), and **UNDO cancels it with no round-trip**. A new
  removal commits the previous pending one. `JUST IN` is suppressed in the wantlist view. The remove
  control in the detail modal routes through the same flow.

---

## [1.7.0] — 2026-08-31

### Added
- **The active tab is remembered across reloads** — THE CRATE / THE TIMELINE / THE LEDGER / THE WANTLIST
  now reflect in the URL (e.g. `/app#wantlist`), so a reload lands you back on the tab you were on instead
  of always THE CRATE, and the tab is linkable. Only tabs valid for the crate you're viewing are restored
  (THE WANTLIST is your own crate only); a stale or invalid hash falls back to THE CRATE and the URL is
  normalized to the actual tab on load.

---

## [1.6.2] — 2026-08-31

### Fixed
- **Wantlist button really lines up with its neighbors now (#29)** — v1.6.1 matched the CSS values but
  the modal button stayed shorter and smaller, because a native `<button>` on macOS renders with the
  system control appearance and clamps its font size and height regardless of the CSS. Adding
  `appearance:none` (+ `-webkit-appearance:none`) lets it honor the styles, so it matches VIEW ON DISCOGS
  / LISTEN. Applied to the card want-button as well.

---

## [1.6.1] — 2026-08-31

### Fixed
- **Wantlist button in the detail modal now matches its neighbors (#29)** — it had reused the compact
  card style, so it rendered slightly shorter and with a smaller font than the VIEW ON DISCOGS / LISTEN
  buttons below it. It now uses the sibling action-button size (10.5px type, 7px 10px padding) and the
  three line up. The crate/wantlist cards keep the compact style.

---

## [1.6.0] — 2026-08-31

Wave 2 Stage B2 — **ADD / REMOVE to wantlist: the first Discogs write.** TraxWax can now mutate your
Discogs account (wantlist only). This completes **Wave 2 — Wantlists & the match matrix.** New Edge
Function `wantlist-write` + frontend; no migration.

### Added
- **Add to wantlist from a friend's crate** — an ＋ ADD TO WANTLIST control on records you don't already
  own (card + detail modal) writes the release to your Discogs wantlist and mirrors it locally; the
  WANT/HAVE badge, the MATCHES stat, and your WANTLIST tab all update live.
- **Remove from wantlist**, two ways — the same control flips to ✕ REMOVE on a friend's crate (a toggle),
  and every card on your WANTLIST tab has an inline ✕ REMOVE with an UNDO toast.

### Security
- `wantlist-write` verifies the Clerk token itself, scopes every read/write to that user, and writes to
  Discogs **first** (mirroring into `wantlist_items` only on success). The add path seeds the shared
  catalog **server-authoritatively** — it never accepts client-supplied catalog content (which
  `seed_releases` would merge over the shared rows every user sees). Hardened by an independent
  pre-build verification pass (caught + designed out a client-seed catalog-defacement hole) and a
  post-build adversarial audit to convergence.

---

## [1.5.1] — 2026-08-31

Wave 2 Stage B1 follow-ups — the two cold-audit trackers (#26, #27). Frontend only; no migrations,
no Edge Function changes.

### Fixed
- **Wantlist import now fires on every RE-SYNC path (#26)** — an in-crate RE-SYNC never triggered a
  wantlist re-import, and an account-page RE-SYNC deferred it to the next crate visit. A single guarded
  `triggerWantlistSync()` now runs after any collection import (in-crate, account, first connect) and is
  also consumed early on any signed-in load, so the account-RE-SYNC path no longer waits for a later
  visit. The wantlist import and the enrichment drain are now sequential, so the wantlist insert can no
  longer trip the enrich stall guard.

### Changed
- **THE WANTLIST tab polish (#27)** — the empty state speaks in the wantlist's own voice (no more
  collection-voiced "ADD RECORDS / RE-SYNC" implying the crate); the header reads `N ON WANTLIST` and
  drops the always-zero COLORED cell; the colored-wax and color facet chips no longer appear as inert
  filters on the wantlist (matching what actually filters there); and WANT/HAVE badge state is folded
  into each card's accessible name so a screen reader announces it as part of the card.

---

## [1.5.0] — 2026-08-31

Wave 2 Stage B1 — **Wantlists & the match matrix become visible.** The read path: the friend match
matrix, WANT/HAVE badges, THE WANTLIST view, and an independent wantlist-visibility toggle. (ADD TO
WANTLIST — the first Discogs write — is Stage B2.) Migrations `0018`+`0019` + frontend; no Edge Function changes.

### Added
- **THE WANTLIST view** — a 4th crate tab (own crate) showing your Discogs wantlist as browsable cards,
  reusing the full filter/sort machinery.
- **Match matrix on a friend's crate** — WANT/HAVE badges (`ON YOUR WANTLIST` / `YOU OWN THIS`) on their
  records, and a MATCHES header stat (`YOU WANT n THEY HAVE · THEY WANT n YOU HAVE`), via a new
  consent-gated `crate_match` RPC.
- **Independent wantlist-visibility toggle** — share your wantlist with friends separately from your crate
  (`wantlist_visibility` + `private.can_view_wantlist` + a friend-read RLS policy on `wantlist_items`).
- **First-connect wantlist import** — a new user's wantlist imports on first connect, not only on RE-SYNC
  (Stage A follow-up).

### Security
- `crate_match` returns uniform nulls for no-such-user / own / not-shared — no existence or friendship
  probe — and gates the two match directions independently (crate consent for you-want-they-have; wantlist
  consent for they-want-you-have). The viewer's own wants/haves that feed the badges are read scoped to the
  viewer (`.eq('user_id', …)`), never through the friend-read RLS. All verified against the live DB.

### Fixed (end-of-phase cold audit, pre-release)
- **THE WANTLIST tab rendered a blank body** — the `showGrid` render gate had no `wantlist` branch. It now
  renders the card grid, is keyboard-navigable (roving tabindex + arrow keys), and hides the `EST.`
  collection-value cell.
- **`crate_match` over-counted** when a collection held multiple instances of the same release (a JOIN
  multiplied by instance count) — switched to an EXISTS semi-join (migration `0019`). Verified: duplicate
  instances now count once.
- **The colored-wax facet no longer zeroes the wantlist** (wantlist rows carry no vinyl variant).

### Known follow-ups (tracked)
- Wantlist import-trigger robustness (the in-crate RE-SYNC path, account-reload timing, and the
  concurrent enrich-drain stall guard on first connect) — self-healing across visits; filed for a fix.
- THE WANTLIST tab's empty-state copy, header cell labels, and inert facet chips still speak in "collection"
  terms, plus badge aria association — a UX/a11y polish pass.

---

## [1.4.10] — 2026-08-31

Wave 2 Stage A (backend): the wantlist data path. **No user-facing surface** — the match matrix,
WANT/HAVE badges, THE WANTLIST view, and ADD-TO-WANTLIST are Stage B (the v1.5.0 cut). Backend + frontend.

### Added
- **`wantlist_items` table** (migration `0017`) — a user's Discogs wantlist, same Restricted posture as
  `collection_items` (own-token import, own-read RLS, deleted on disconnect/deletion). Friend-read RLS
  deferred to Stage B.
- **Wantlist import** — `import-collection` gains a `kind: collection|wantlist` param (shared
  auth/decrypt/watermark/seed/sweep; only the Discogs endpoint, target table, and row mapping differ).
  Runs silently in the background after a RE-SYNC, so the crate still renders as fast as today.
- **Client-driven adaptive rate-limit pacing** — the wantlist import reads Discogs'
  `X-Discogs-Ratelimit-Remaining` and backs off before 429s (wantlist import ~doubles per-sync load on a
  shared-IP budget); the existing 30s 429-retry stays as the backstop.

### Changed
- **`pending_enrichment` work-discovery now covers owned ∪ wanted** releases, and the enrich boot gate
  closes on `owned + wanted === 0` (was `owned === 0`) — so a wantlist-only user's wanted releases get
  enriched instead of skipped. Verified: no double-count for a release both owned and wanted.
- `import_status` (the collection boot-gate signal) is written **only by the collection pass** — the
  background wantlist pass sweeps on its watermark and never touches it (found in the Stage A audit).
- `unlink_discogs_account` + `delete_account` also delete wantlist rows (Wave 1 friendship/invite deletes preserved).

---

## [1.4.9] — 2026-08-30

Wave 1 backend hardening — clears the remaining items in #16, #17, #18. DB migration (`0016`) + frontend.

### Added
- **Per-inviter cap on active friend invites (25).** `create_friend_invite` (migration `0016`) rejects
  when the caller already holds 25 unused, unexpired invites (`too_many_invites`, surfaced with human
  copy in the account UI). Its expired-sweep now keeps *used* rows, matching 0015's soft-consume. (#16 item 3)

### Security
- **Dropped the `anon` reach into schema `private`.** Revoked `anon` EXECUTE on `private.can_view_crate`
  and USAGE on schema `private`; `anon` never reads `collection_items`, so it never needed either
  (matches the rest of the Wave 1 posture). Verified no anon path depends on it. (#16 item 4)
- **#16 item 5 (FK friendships/invites → profiles) deferred by decision** — the auth-adjacent tables use
  procedural integrity deliberately (`delete_account` + the `no_profile` guards); documented in the
  migration header.

### Fixed
- **`bootCrate()` binds its document/window listeners at most once** (`__twListenersBound` guard, #18).
  The listeners use stable module-level refs the DOM already de-dupes, so this is belt-and-suspenders
  that future-proofs against a later inline/arrow-listener refactor; no behavior change today.
- **Analytics `before-send` now strips `?query` + `#fragment` from the referrer too** (not just the
  pageview url), and is fully self-contained rather than trusting the tag's `data-exclude-search/hash`
  to cover `payload.referrer` — a gap surfaced by a belated pass-2 audit of the v1.4.8 Umami token-leak
  fix. Low severity (only bounded `?connect=` status codes were ever at risk on the referrer; handles
  and the invite `/i/<code>` token are path-masked on both fields). Folded in here. (follow-up to #24)

### Performance (investigated, accepted — #17)
- The friend-crate read evaluates `private.can_view_crate` **per row** (EXPLAIN ANALYZE: ~5.7k buffer
  hits, 1,861 loops, **32.7ms** on the largest real crate). Left in place deliberately: this per-row RLS
  check is the **sole server-side authorization** for crate reads — the client picks the crate via
  `.eq('user_id', …)` and `get_crate_owner` gates only the profile/UI (see the v1.4.2 cross-crate leak
  fix), so the policy must **not** be relaxed. Accepted for its cost at current scale; revisit alongside
  the broader `auth_rls_initplan` optimization if crates/users grow. The invite cap is best-effort
  (non-atomic if a user races themselves) — acceptable for anti-abuse.

---

## [1.4.8] — 2026-08-30

Analytics event coverage. Frontend only. Builds on the v1.4.7 Umami scaffold.

### Added
- **Activation funnel:** `connect_started`, `connect_completed`, `connect_failed` `{reason}`,
  `import_started`, `import_failed` `{reason, page}` — joining the existing `import_completed`
  `{items}`. Turns raw counts into a funnel with visible drop-off, and doubles as lightweight
  connect/import error monitoring.
- **Churn + social:** `discogs_disconnected` and `account_deleted` (the two exit doors);
  `invite_created` and `invite_accepted` (Wave 1 viral loop; accept fires only on a genuinely
  new accept, not a re-open of an already-used link).
- **Engagement:** `filter_used` `{kind}` (genre/color/colored) and `record_opened` `{source}`
  (crate/timeline) alongside the existing `view_change` `{view}`.

### Privacy
- **Failure `reason`s are fixed enum buckets, never raw error messages** — a caught `.message`
  can carry a token or URL, so `import_failed` maps to `rate_limit`/`auth`/`network`/`other` and
  `connect_failed` emits only known connect-status keys (else `other`). No event carries a
  username, search query, artist/title, price, friend handle, or record id.

### Fixed
- **Capability tokens no longer reach Umami in the initial pageview URL** (hardening of the
  v1.4.7 before-send guard, found by an adversarial audit of this change). The Umami script loads
  before `boot.js` strips one-time codes from the URL, so the first auto-pageview captured the raw
  `location.href`. The mask now also collapses `/i/<invite-code>` → `/i/:code`, and
  `data-exclude-search`/`data-exclude-hash` on the tag strip the `?connect=…` query and the OAuth
  `#twcode=…` fragment before send. (Discogs Restricted data was never exposed — these are
  TraxWax's own capability tokens — but they don't belong in a third party's logs.)

---

## [1.4.7] — 2026-08-30

Privacy-first analytics scaffold (Umami Cloud, Hobby/free). Frontend only. **Inert until the
website ID is set** — see the setup note below.

### Added
- **Umami Cloud analytics** on both entry points (`public/index.html`, `public/app/index.html`).
  Cookieless, no PII, no consent banner, no server or Supabase involvement. Chosen for the free
  Hobby tier (100k events/mo) and its fit with the project's privacy posture.
- **Custom events (guarded, no-op without the tracker):** `import_completed` with an item **count**
  (boot.js, on import success) and `view_change` with the tab id (app.js, CRATE/TIMELINE/LEDGER).
- **`track()` helper** in app.js and boot.js — actions and counts only; never a username, price,
  or any Restricted Discogs field.

### Privacy choices (each a one-line revert)
- **`data-before-send` guard** (`twUmamiBeforeSend`) masks the `/app/<username>` path segment (and
  internal referrer) before anything is sent, so no Discogs handle leaves the app. `document.title`
  is static, so nothing leaks around the mask.
- **`data-do-not-track`** honors the browser DNT signal (drop for fuller numbers).
- **`data-domains="traxwax.com"`** so preview/localhost traffic doesn't report.

### Setup required (Lane)
- Create the site in Umami Cloud, then replace `REPLACE_WITH_UMAMI_WEBSITE_ID` in both HTML files
  and confirm the script `src` host matches the dashboard snippet. The tracker no-ops until then.

---

## [1.4.6] — 2026-08-30

The crate header's tagline now cycles. Frontend only.

### Changed
- **"filed by whim" is now "filed by _{one of 50}_".** The last word of the owner line
  (`<name>'s shelf · filed by <word>`) is drawn at random on each page load from a 50-word list —
  `whim`, `serendipity`, `tea leaves`, `dumb luck`, `pure spite`, `the needle's whim`, and 44 more.
  The word is frozen per load, so it holds steady across filter/sort/view re-renders and only
  reshuffles on a real reload. Owner's own crate only; a visitor's shelf keeps its plain
  `<name>'s shelf`. The list lives once in `app.js` (`FILED_BY`) and the tagline is appended at the
  render site — `boot.js` no longer bakes the suffix into `ownerLine`.

---

## [1.4.5] — 2026-08-30

Auth-aware root routing. Frontend only.

### Changed
- **Signed-in visitors to `traxwax.com` now go straight to their crate.** The landing page reads
  Clerk's `__client_uat` cookie before first paint and redirects to `/app` when signed in (which
  routes on to `/app/<username>`); signed-out visitors see the landing as before. No Clerk SDK on
  the landing, and it degrades safely (a stale cookie just lands on `/app`, which re-verifies).
- **Signing out returns you to the landing page** (`/`) — the footer sign-out link, the account
  SIGN OUT row, and post-account-deletion all redirect there now.

A logged-out deep link to `/app` still shows the sign-in card (unchanged) — that's the way in.

Closes #23.

---

## [1.4.4] — 2026-08-30

Fixed the Clerk sign-in / sign-up card, which had drifted into a mess of stray rings, a glossy
gradient button, and misaligned boxes. Frontend only.

### Fixed
- **Sign-in card restyled to the flat TraxWax look.** Clerk's current build outlines every control
  with a box-shadow *ring* (not a border) and wraps the card in a drop-shadowed `.cl-cardBox` — none
  of which the mount-time `appearance` object overrode (its color/font/radius and `display` rules
  apply; its `border`/`box-shadow` rules silently lose to Clerk's own). Moved the flat frame — killed
  rings, flat accent button with the TraxWax offset shadow, no card shadow, hairline divider, hidden
  "last used" badge — into a `.cl-*` CSS block in `styles.css` that also follows light/dark **live**
  via tokens (the mount-time appearance couldn't). Simplified `boot.clerk.js` to just the palette/type
  variables and the header/footer `display:none` the appearance actually honors.

Closes #22.

---

## [1.4.3] — 2026-08-30

Friends account surface redesigned for legibility (Design Kit v2). Frontend only.

### Changed
- **Friends page is now three labeled sections** instead of one flat column — **VISIBILITY**,
  **INVITE A FRIEND**, and **YOUR FRIENDS · N** (live count), each a mono label + hairline rule over
  one ink-bordered container, in the order you act on them. The visibility card's sub-line reads
  "… · currently ON/OFF"; the friends list sits in a single container with a transparent divider on
  the last row; the no-friends state is a hairline box, not an empty ink container. Friend rows keep
  the username beside the name and the name-line link to the crate (v1.4.2), alongside the VIEW
  CRATE → tag. Composes from existing tokens — no new tokens, type, or components. A reusable
  `sectionLabel()` helper is in place for future settings sections.

### Removed
- The **RE-SYNC button in the main crate header** — it's mirrored on the account → Discogs page,
  a more appropriate home. (Dead `_lastSyncedLabel()` helper removed.)

Closes #21.

---

## [1.4.2] — 2026-08-30

Friends UX polish + two data-correctness fixes.

### Fixed
- **Cross-crate leak (the "M Ward" bug).** Viewing your own crate could mix in a friend's shared
  records. The own-crate reads relied on row-level security that the Wave 1 friend-read policy
  legitimately widens, so they now scope explicitly to your own `user_id` — the crate provider and
  both record-count queries (account page + first-import gate). Friends' rows can no longer appear
  on your shelf or in your counts.
- **Re-opening a used invite.** A friend who opened an invite link they'd already accepted saw
  "invalid or expired." Invites now **soft-consume** (the row is kept, marked used), so a re-open by
  the acceptor reports **"Already connected"** instead of alarming. Also hardened: testing your own
  link no longer burns it, and a missing profile is guarded (migration 0015).

### Added
- **Two-step REMOVE friend.** REMOVE arms to "REALLY REMOVE?" and only removes on the second click
  (4s auto-disarm), matching the DISCONNECT DISCOGS idiom — no accidental unfriending.
- **Friend-crate indicator strip.** A thin bar above the header on a friend's crate reads
  "Viewing <name>'s crate" with a "← Back to your crate" link.
- **Invite "COPY" button** + a plain lifetime line: "Works once · expires in 14 days."
- **Sign-out** row in the account navigation.
- **Friend rows show the username** next to the display name ("Tommy Perkins (tommyp)"), and the whole
  name line is now the link to their crate (the separate "VIEW CRATE →" is folded in). A friend who
  isn't sharing stays plain text with the "Not sharing right now" note — no dead link.

---

## [1.4.1] — 2026-08-30

Account UX consolidation + polish from the Wave 1 end-of-wave cold audit. Frontend/docs only.

### Changed
- **One tab, not two.** The account **SHARING** tab is merged into **FRIENDS**: the
  crate-visibility toggle now sits at the top of FRIENDS, above the invite link and friend list.

### Fixed
- A friend's **empty crate** no longer speaks in the owner's voice or shows a dead RE-SYNC button.
- Card **"SEE ON DISCOGS →"** opens in a new tab (matching the modal), instead of navigating the
  crate away.
- A friend who's toggled sharing off shows **"Not sharing right now"** instead of a dead VIEW CRATE
  link.
- REMOVE buttons carry per-friend `aria-label`s; keyboard focus is preserved after a removal.
- Invite-creation errors show human copy, not internal status tokens.

### Docs / notes
- Reconciled the price-suppression language across the terms summary + roadmap: it's best-effort
  field suppression + client rendering, **not** a hard server boundary (the boundary is the
  `collection_items` friend-read RLS). Recorded two intentional behaviors (a viewer must connect
  their own Discogs before browsing a friend's crate; a disconnect keeps friendships + visibility).
  Backend-hardening backlog filed as #16–#18.

---

## [1.4.0] — 2026-08-30

**Friends & shared crates** (social roadmap Wave 1). You can now share your crate with friends you
invite, and browse theirs — read-only, and never with prices. Sharing is off by default.

### Added
- **Consent + friends, in ACCOUNT.** A SHARING toggle ("Friends can see my crate", private by
  default, per-dataset) and a FRIENDS section: create a single-use invite link, see your friends,
  and remove one (removal is instant and mutual).
- **Invite links** — `/i/<code>`. A single-use, 14-day code; only its hash is stored. The link
  survives sign-up/sign-in, so a brand-new friend can accept it.
- **Read-only friend crates** — visit `/app/<friend>` to browse a consenting friend's shelf: their
  covers, titles, and record detail, with their name on the shelf. No prices anywhere (each price
  cell links to Discogs instead); no RE-SYNC, no account controls, no estimated value.
- **Privacy:** a crate that doesn't exist and one that simply hasn't been shared with you render
  identically — the app never confirms whether a username exists.

### Backend (migrations 0012–0014, `live-stats`)
- `friendships` + `friend_invites` tables, `profiles.crate_visibility`, friend-readable RLS on
  `collection_items`, and browser-callable RPCs (`create/accept/remove` invite, `list_friends`,
  `get_crate_owner`). `delete_account` extended to remove friendship + invite rows.
- The friend-authorization choke point (`can_view_crate`) lives in a non-exposed `private` schema;
  `live-stats` suppresses price server-side for a friend's crate via a `service_role`-only decision
  function. All three DB changes were adversarially audited.

---

## [1.3.4] — 2026-08-30

### Fixed
- **Profile photo now updates in place.** After uploading a new photo on the account page,
  the nav-header avatar (the "top" one) kept showing the old image until a full reload — the
  upload succeeded and the "Photo updated." status fired, but only the form's avatar refreshed.
  Both avatars now update the moment the upload completes. (Found during the W0.3 Profiles V5
  E2E confirmation; the upload itself always round-tripped correctly to Clerk.)

---

## [1.3.3] — 2026-08-30

Accessibility polish (social-roadmap **W0.4**) — the keyboard and screen-reader debt owed
since v0.5.0 planning, cleared. `app.js` only; no schema, RLS, or Edge-function change.

### Added
- **The detail modal is a real dialog** — `role="dialog"`, `aria-modal="true"`, and
  `aria-labelledby` pointing at the title. Opening it moves focus into the dialog; **Tab and
  Shift-Tab cycle within it**; Escape closes; on close, focus returns to the card that opened
  it. The trap **survives the async stats/tracklist re-render** — focus is no longer thrown
  back to the close button when live data lands.
- **Roving keyboard focus across the crate grid (Tab-into-cell).** The grid is now a single
  tab stop: **arrow keys and Home/End** move between record covers. The **focused** card's
  artist / title / color controls become Tab-reachable, so keyboard users keep every filter
  (arrows to pick a record, Tab to dive into its actions) without walking thousands of buttons.

### Notes
- `aria-live` on the result count shipped in v1.3.2; the modal cover already served the ~600px
  `cover_image` (not the 150px `thumb`), verified here — both W0.4 line items already satisfied.
- Known follow-up (pre-existing, not in this patch): mark the background `inert` / `aria-hidden`
  while the modal is open, for screen-reader browse-mode isolation.

---

## [1.3.2] — 2026-08-29

The **design-surfaces pass** (Claude Design Kit v2). The crate was designed; nothing around
it was. This rebuilds every non-crate surface into one shell system, with no change to any
schema, RLS policy, or Edge Function. Spec: `docs/design-surfaces-spec.md`; surface→file
map: `docs/design-screen-map.md`. Cut as a patch by decision, to keep the social-roadmap
wave→version map stable (`docs/social-roadmap.md` W0.5).

### Added
- **A real landing page** (`public/index.html`): wordmark bar, hero, a three-up pitch, a
  crate screenshot slot, a dark position slab (the Wave-5 public-crates slot), and the two
  required Discogs attribution notices. Two CTAs — `CREATE AN ACCOUNT` and `SIGN IN` — where
  before there was no path to sign-up from the landing at all.
- **The account surface as a route** — `/account` and `/account/discogs`, outside the
  `/app/<username>` grammar so it can never collide with a Discogs username. Left nav
  (`PROFILE` · `SHARING` _soon_ · `FRIENDS` _soon_ · `DISCOGS` · `DANGER ZONE`), a connection
  panel with handle / record count / last sync + `RE-SYNC NOW`, and escalating
  disconnect→delete. Replaces the old three-box modal.
- **A distinct empty-crate state** (S17): a brand-new user whose Discogs collection is empty
  now sees "Nothing on the shelf yet," not the filter-empty "0 RESULTS · CLEAR THE FILTERS"
  (advice that couldn't help, since no filters were set).
- **`boot.ui.js`** — the shell system: buttons (five variants, real `disabled`), labelled
  fields, a square toggle, a progress bar, the wordmarked state card, a reusable empty-state
  pattern, `trapFocus`, the whole account page, and a `COPY` table so a voice pass never means
  grepping nine template literals. **`boot.clerk.js`** — the Clerk `appearance` (theme-aware).
- **Reserved-but-dormant** design for the social waves: consent toggle, card-badge classes +
  helpers, the friend-crate price cell, the landing public-crates slot. Nothing emits them
  yet; wiring them later is a data change, not a redesign.
- `aria-live` on the crate's result count (the one accessibility debt this pass cleared).

### Changed
- All nine system states (auth, onboarding, connect + 13 errors, import running/failed,
  importing-paused, no-crate-here, verifying, unexpected-error) now render through the state
  card, each with a status kicker. Import progress is a real bar with a record count; on
  failure the bar **stays and goes grey** at the page it reached.
- Auth is "TraxWax chrome, stock card": our frame, Clerk's component inside it, themed via
  `variables` + a short `elements` list so a Clerk update can't break the frame.
- Sign-up carries a `STEP 1/2/3 OF 3` counter; sign-in stays one door.
- **No-crate-here** keeps a grey (non-error) rule and copy that is true of both "no such user"
  and (in Wave 1) "hasn't shared with you" — so the page never confirms a username to a
  stranger.

### Fixed
- The disconnect and delete buttons are genuinely `disabled` when not yet armed/confirmed,
  not the old `opacity:.45` that was still clickable.
- **Landing tape** now pins the whole poster to the background at its four corners — the app's
  treatment (top strips on the red bar, bottom strips hanging off the footer) — instead of the
  two mid-poster placements that didn't read. (The hero's `overflow:hidden`, which had also
  been clipping the old tape, is gone; `overflow-x:clip` on the outer landing guards side-scroll.)
- **Landing accessibility pass** (`/impeccable audit`): the required footer Discogs link is
  now `--bg` + underline (15:1, was 3.99:1 accent-on-black); the three-up kickers use a
  theme-aware accent mix that clears AA on the dark band (4.8:1 / 6.0:1); the below-fold hero
  is `loading="lazy"`; the top-bar CTA holds a 44px touch target on phones; and the section
  ledes/headlines are real `<h2>`s for screen-reader structure.

### Notes
- **Landing hero captured** (`public/screenshots/crate-hero.jpg`, 2560×1840): a light-theme
  band off Lane's live crate — header + style filters + two `JUST IN` rows, covers loaded,
  varied wax. JPEG q88 (~800KB, vs ~4MB PNG; it doubles as the OG card). The `<img>` keeps an
  `onerror` skeleton fallback regardless. (Design spec named it `.png`; JPEG is the right call
  for a photographic hero.)
- **Landing color rework** (Lane, 2026-08-29): the top bar goes red (app-style, with a
  white/black button on it like the crate header), the middle three-up band goes black, the
  position slab goes grey, and the footer goes black — all through the theme-flipping
  `--ink`/`--bar`/`--bg` tokens so both light and dark stay legible (one fix: the three-up
  note uses a `color-mix` muted, since a raw `--muted` would render light-on-light on the
  band's inverted dark-theme value). The hero cover slot holds the finished cover mosaic
  exported from the design comp (`public/screenshots/hero-mosaic.jpg`).
- **Landing header + copy** (Lane): the wordmark is now app-sized and **breaks the frame** —
  straddling the bar/hero seam, half on the red bar and half on the white hero, left-aligned
  over the hero copy — with the sign-in / sign-up actions pulled in to align with the hero
  content below. The hero headline is **"Dig your own crate."** (accent second line), sized to
  fill the copy column; the sub-line and the three "file by…" notes are tightened to one line
  each, and "Free · your data stays yours · no marketplace" now sits under the CTA button.
- `public/_redirects` + `public/_headers` gained the `/account` route; `_routes.json`
  unchanged. **Verify a hard cold-load of `/account/discogs` post-deploy** — a Cloudflare
  rewrite is the one thing that can't be tested locally.
- Design reference material is now committed: `github.md` (repo root — the Design team's sync
  anchor, with an as-built reconciliation of the `/account` divergence) and `docs/design-source/`
  (the runnable `TraxWax Surfaces.dc.html` + its `support.js`/`records.js`/`screenshots/` and
  `DESIGN-KIT-V1.md`). Reference only — outside `public/`, so not web-served.

---

## [1.3.1] — 2026-08-29

### Changed
- The avatar button now **floats in the true upper-right corner** of the header, above
  the white controls bar, instead of sitting inline at the end of it (Lane's visual
  review of the live v1.3.0). Positioned absolutely like the tape decorations; slightly
  larger (36px); mobile gets a tighter corner offset.

---

## [1.3.0] — 2026-08-29

Profiles: the social groundwork. Plan: `docs/phase-2-profiles-plan.md` (rev 2, twice
audited). Migration 0011 is live; deploy order was migration-first by design.

### Added
- **Avatar button**: the header ACCOUNT text button is now a circle avatar in the upper
  right — your Clerk photo (Google users get theirs automatically; photo-less users get
  Clerk's initials avatar), with a house head-and-shoulders icon as the empty fallback.
- **Profile fields** in the account modal: photo upload (via Clerk — hosting/CDN/resizing
  included), first/last name, bio (≤200), location, collecting-since, and two https
  links. All optional; stored own-row-private until a future social phase deliberately
  exposes them.
- **A skippable "Whose crate is this?" card** after sign-in when the name is missing —
  email/password signups only; Google users arrive complete. Clerk's signup form now
  collects names going forward (dashboard setting).

### Architecture
- Clerk owns identity (name + photo); `ensureProfile` one-way-syncs `display_name` +
  `avatar_url` into `profiles` each boot so future social features can query them.
  `avatar_url` is constraint-pinned to Clerk's image host; all profile fields carry DB
  CHECK constraints. Profile fields survive disconnect and die with account deletion.

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
