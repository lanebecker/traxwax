# Feature Roadmap — TraxWax

Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.
Minor releases add features; patch releases fix bugs without changing behaviour.
The current version is in the `VERSION` file at the repo root; the README badge is
kept in sync with it by `.github/workflows/sync-version-badge.yml`.

**Current version: `1.14.0`** — live at [traxwax.com](https://traxwax.com). The per-release detail below
stops at v1.4.5; for v1.5.0 onward (wantlists + match matrix, THE OVERLAP, the cold-audit waves, the
friends/social wave, any-pressing #28, CSP enforce #38, the end-of-phase cold audit) see `CHANGELOG.md`,
which is the authoritative release-by-release record.

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

### v1.0.0 — Multi-user (launched 2026-08-29)

The substantial one: Clerk login, per-user Discogs OAuth (per-user tokens
AES-256-GCM at rest), client-driven import + shared CC0 catalog enrichment,
the read-path flip to Supabase, live-only Restricted data. Four staged phases
(auth shell → OAuth → import/enrich → the flip), each twice-audited, plus an
end-of-phase cold audit. Spec: `docs/multi-user-spec.md`.

### v1.0.1 — Post-launch bug batch

Search debounce + caret preservation; local-month JUST IN/THIS MONTH;
cache-control headers (stale-deploy fix); enrichment discovery as one join RPC;
per-user connect cooldown; dead-code sweep. GitHub #2, #4, #5, #6, #7, #9.

### v1.1.0 — Account controls

Disconnect Discogs, TraxWax-data deletion (Clerk identity untouched), and the
authenticated finalize step that closes the accepted Stage B link-CSRF.
GitHub #8; plan: `docs/phase-2-account-plan.md`.

### v1.2.0 — Catalog refresh

Dated 404 tombstones (7-day retry), 180-day deep-field TTL, and empty-guarded
last-import-wins metadata merge on every import. GitHub #3;
plan: `docs/phase-2-catalog-refresh-plan.md`.

### v1.3.0 — Profiles

Circle avatar button, profile fields (photo/name/bio/location/collecting-since/links)
with Clerk-owned identity synced to the DB, skippable onboarding card. The groundwork
for social. Plan: `docs/phase-2-profiles-plan.md`.

### v1.3.1 — Avatar reposition

The avatar button floats in the true upper-right corner of the header, above the
controls bar (Lane's visual review of live v1.3.0).

### v1.3.2 — Design-surfaces pass

The whole non-crate UI rebuilt into one shell system: a new landing page, TraxWax
chrome around the Clerk auth card, the nine bare system states turned into a single
wordmarked "state card," the account **modal turned into a route** (`/account`,
`/account/discogs`), and a real empty-crate state distinct from filter-empty. New
modules `public/boot.ui.js` (+ `boot.clerk.js`); no schema, RLS, or Edge-function change.
Carries reserved space for every social wave. Spec: `docs/design-surfaces-spec.md`;
surface→file map: `docs/design-screen-map.md`. (Cut as a patch by decision, keeping the
social-roadmap wave→version map stable.)

### v1.3.3 — Accessibility polish (W0.4)

The keyboard/screen-reader debt owed since v0.5.0 planning, cleared. The detail modal is now
a proper dialog (`role="dialog"` + `aria-modal` + `aria-labelledby`) with a focus trap that
returns focus to the invoking card on close and survives the async stats/tracklist re-render.
The crate grid is a single tab stop with **Tab-into-cell roving**: arrow keys (+ Home/End)
move between covers, and the focused card's artist/title/color controls become Tab-reachable
so no filter is lost to keyboard users. (`aria-live` on the result count shipped in v1.3.2;
the modal cover already used `cover_image`, verified.) `app.js` only — no schema/RLS/Edge
change. Follow-up noted: `inert`/`aria-hidden` the background behind the open modal for
screen-reader browse mode (pre-existing; not in this patch).

### v1.3.4 — Profile photo updates in place

Bug fix from the W0.3 Profiles V5 E2E confirmation: after a photo upload, the account
nav-header avatar kept the old image until a full reload (only the form avatar refreshed).
Both now update on upload. The upload itself always persisted correctly to Clerk.

### v1.4.0 — Friends & shared crates (social roadmap Wave 1)

The consent wall, the friendship graph, and the first cross-user crate views. Opt-in
(default private), single-use invite links (`/i/<code>`), read-only friend crates with
server-side price suppression, and instant mutual revocation. Backend: migrations 0012–0014
(friendships, invites, `crate_visibility`, friend-read RLS, `private.can_view_crate`,
`crate_view_decision`) + `live-stats` suppression. Every DB change and the frontend were
adversarially audited. Plan + audit record: `docs/wave-1-plan.md`. Issues #11–#15.

### v1.4.1 — Account UX consolidation + Wave 1 cold-audit polish

Merged the SHARING tab into FRIENDS (toggle at the top). Frontend/doc fixes from the end-of-wave
cold audit: friend empty-crate voice, "SEE ON DISCOGS" new-tab, non-sharing-friend dimming, REMOVE
a11y, invite error copy; and reconciled the price-suppression docs (best-effort field suppression,
not a hard boundary — the boundary is the friend-read RLS). Backend-hardening backlog: #16–#18.

### v1.4.2 — Friends UX polish + data-correctness fixes

Two fixes and four polish items on the Wave 1 surface. **Fixed:** the "M Ward" cross-crate leak
(own-crate reads now scope to your own `user_id`, so the friend-read RLS can't widen them into your
shelf or counts); and re-opening an already-accepted invite now reports "Already connected" via
**soft-consumed** invites (migration 0015, which also stops an inviter burning their own test link
and guards a missing profile). **Added:** two-step REMOVE friend, a friend-crate indicator strip
with a back link, an invite COPY button + "Works once · expires in 14 days," and a sign-out row.
Frontend + one migration; the batch was twice adversarially audited (remediation-audit).

### v1.4.3 — Friends surface redesign (Design Kit v2)

The Friends account page rebuilt for legibility: one flat column → an intro block plus three
labeled sections (VISIBILITY / INVITE A FRIEND / YOUR FRIENDS · N, live count), each a mono label
+ hairline rule over one ink-bordered container, in the order the user acts on them. Consistent
container borders, a single-structure friend row (name-link + handle + status + VIEW CRATE →),
transparent last-row divider, and a hairline empty state. A reusable `sectionLabel()` helper is now
available for future settings sections. Also removed the RE-SYNC button from the crate header (it's
mirrored in account → Discogs). Frontend only, all existing tokens; jsdom-verified (56 checks) with
a static render preview. Spec: `Design/traxwax-friends-redesign/FRIENDS-SPEC.md`. Issue #21.

### v1.4.4 — Sign-in card restyle

Fixed the Clerk sign-in / sign-up card, which had drifted into stray rings, a glossy gradient
button, and misaligned boxes as Clerk's DOM changed under the mount-time `appearance` object. The
flat TraxWax frame now lives in a token-based `.cl-*` CSS block in `styles.css` (so it follows
light/dark live), with `boot.clerk.js` trimmed to the variables + `display` rules the appearance
actually honors. Diagnosed and validated live against the real Clerk DOM in both themes. Issue #22.

### v1.4.5 — Auth-aware root routing

`traxwax.com` now sends a signed-in visitor straight to their crate (the landing reads Clerk's
`__client_uat` cookie before first paint and redirects to `/app`), and signing out returns you to
the landing page. A logged-out deep link to `/app` still shows the sign-in card. Frontend only
(`index.html`, `boot.js`); redirect predicate unit-tested against the live cookie shapes. Issue #23.

---

## Next

The standalone accessibility backlog is cleared. What's next is the social roadmap —
`docs/social-roadmap.md`, Wave 1 (friends & consented crates → v1.4.0) onward. Interstitial
polish items get filed as they arise.

---

## Retired

- **The Cowork artifact** (`lanes-record-collection`) — the original home of this
  project. Superseded by this site; see the project `CLAUDE.md` for the sunset
  record.

## Unscheduled / under consideration

- **In-app settings** — surface the kit's authored props (theme, accent, columns,
  `showPrices`, `ownerLine`) as real product settings.
- **"What to play tonight?"** random pick; shareable filtered-view URLs.
