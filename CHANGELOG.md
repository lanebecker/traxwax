# Changelog

All notable changes to TraxWax are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

---

## [Unreleased]

_Nothing yet._

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
