# TraxWax — The Social Roadmap

**Rev 4 — 2026-08-29 (rev 1 verification-passed: REVISE-FIRST, 1 CRITICAL + 6 MAJOR +
4 MINOR, all folded — Audit record at bottom; the CRITICAL became a Lane decision,
recorded in §1. Rev 3 folded the two-pass terms/community research — W0.2a findings
1–11 — into §1, W0.2b's letter, Wave 2, and the assumptions register. Rev 4 folds the
**v1.3.2 design-surfaces pass**: W0.5 records what shipped, every wave gains a **▸ Design
(ready now)** note tying it to the reserved elements in `docs/design-surfaces-spec.md` §9,
and the `/account` routing decision's consequence for the invite/public-crate routes is
captured in W0.5 + Waves 1/5.)** The captured brainstorm (Lane + Claude, 2026-08-29) turned into a
development sequence: waves of implementation, the release cut for each, and the rituals
that keep documentation and hygiene current. This is a SEQUENCING document — each wave
still gets its own implementation plan at the junior-engineer bar, twice audited, before a
line of its code executes. Nothing here overrides that.

Current shipped version at time of writing: **v1.3.2** — the **design-surfaces pass** (the
whole non-crate UI rebuilt into one shell system: landing, auth chrome, nine system states,
the account page as a route, the empty crate). It carries **deliberate reserved space for
every wave below**; the map from wave → design element is in each wave's **▸ Design (ready
now)** note, sourced from `docs/design-surfaces-spec.md` §9. See **W0.5**. (Profiles +
floating avatar shipped in v1.3.0/v1.3.1.) Users: 2 (lanebecker, SoundAbounds/Tommy).

---

## 1. The load-bearing constraint, restated once

The Discogs API terms make *which releases a user owns* Restricted Data, alongside
prices/marketplace/community stats. Everything social below stands on one position:

> **Consented sharing of a user's own data.** A user explicitly opts in to showing their
> crate (and later wantlist / for-sale shelf) to chosen audiences. The data was imported
> under their own OAuth token, is kept fresh by their own re-syncs (v1.2.0 machinery),
> and dies by the disconnect/deletion machinery (v1.1.0). Discogs itself offers public
> collections as a user choice; TraxWax's sharing is the same choice, made by the same
> owner, in a non-commercial context — and where sharing IS the service, the terms'
> "no longer than necessary to provide a service to your application's users" caching
> clause reads in our favor.

Hard rules that never bend, wave to wave:

- **Prices and valuations NEVER appear on anyone else's crate** — not in overlap views,
  not in badges, not in aggregates. The FOR SALE path shows *that* something is listed;
  the price lives on the Discogs listing page behind the link.
- **Restricted per-release stats reach a viewer only via `live-stats` under the VIEWER's
  own token** (the established pattern) — each user sees data Discogs authorized to them.
- **Aggregate-only artifacts may travel off-platform** (DNA cards, Wrapped): decade
  histograms, style percentages, counts — never ownership lists, never prices.
- **Sharing is opt-in, default private, revocable instantly**, and disconnect/deletion
  semantics extend to every new imported dataset (wantlist, inventory) in the same
  migration that creates it — never as a follow-up.
- **Rate budgets stay per-user**: every import/refresh/live call runs under the token of
  the user it serves.
- **We drive traffic TO discogs.com and never touch commerce**: no checkout, no money,
  no affiliate anything. Discogs handles every transaction.

**The honest part (rev1-F1, decided by Lane 2026-08-29):** this position REVERSES the
standing conclusion in `Discogs-API-Terms-Summary.md`, which called member-to-member
collection visibility "the transfer the terms forbid" and recommended written
confirmation from Discogs first. The decision on record: **ask + build in parallel** —
Lane sends Discogs a short written question about consented member-to-member sharing
(W0.2b), while Wave 1 proceeds friends-only for a population of invited people, with
instant revocation and server-side price suppression as the containment story. If
Discogs objects, sharing turns off with one visibility flip and the imported data model
is unchanged. W0.2 rewrites the terms summary to carry BOTH the old conclusion and this
reasoned reversal, clause by clause, plus the outreach record — so every later plan
cites one reconciled analysis, not two contradictory ones.

---

## 2. The release rituals (unchanged, restated so the waves can reference them)

Per RELEASE (every version cut):
1. Phase plan at the write-plan bar → independent verification-pass audit → narrow pass
   on rework → CONVERGED before execution.
2. DB-first rollout order whenever a migration exists; migrations applied + verified live
   before any dependent frontend push.
3. Verification battery: syntax, migration checks + negative probes (synthetic rows only
   — real users exist now), RPC/RLS state-matrix tests, forged-token 401s on any new/
   changed Edge Function, jsdom baked-mode harness, live E2E.
4. `CHANGELOG.md` entry + `VERSION` bump + `docs/roadmap.md` shipped entry in the SAME
   commit as the code; commit message carries `Closes #N` for each issue.
5. `log.md` entry; handoff as one Mac `&&` chain (commit → pull --rebase → push).

Per WAVE (after its last release):
6. End-of-wave cold audit (independent agent, argue-down triage, surviving findings →
   GitHub issues before fixing).
7. Documentation cold audit: README, DEPLOY, both CLAUDE.mds, spec/as-built notes,
   memory. The Aug-29 audit proved docs rot in ONE day of shipping; waves are the
   cadence that keeps it bounded.
8. Roadmap review: re-sequence remaining waves against what the wave taught us.

Per wave, GitHub: a milestone per wave (`gh api` Mac-side), issues per feature filed
when the wave's plan is approved.

---

## 3. Wave 0 — Clear the runway (no release; chores + one document)

Prerequisites that block everything, none of them features:

- **W0.1 — Supabase connector conversion.** The project-scoped connector goes read-only;
  a separately-armed break-glass connector handles migrations/deploys (Spinbound's
  pattern). This is standing debt, now active with real users in the DB. Lane-side
  config; Claude verifies both connectors' postures afterward.
- **W0.2 — The consent-model terms write-up.** Rewrite the relevant section of
  `Discogs-API-Terms-Summary.md` to reconcile the standing "transfer the terms forbid"
  conclusion with the consented-sharing position (§1), clause by clause, with
  feature-by-feature sensitivity notes and the never-do list. Verification-pass audited
  like any substantial doc.
- **W0.2a — Research findings (2026-08-29, forum + current TOU archaeology), for the
  W0.2 rewrite to build on.** The full CURRENT API TOU (last updated 2025-05-27 — newer
  than the basis of our summary) materially strengthens the consent position:
  1. The Restricted Data license **explicitly grants** "access and use the Restricted
     Data Content and Our API **to create and run websites and applications**" — apps
     displaying Restricted data to their users is the contemplated use, or the grant
     means nothing.
  2. The TOU defines collection/wantlist as "**Optional categories that user may
     display**" — Discogs' own model treats visibility of these categories as the
     owner's choice.
  3. The API itself enforces that model: another user's collection is fetchable only
     when that user set it public on discogs.com. Discogs resolved the 2007-era privacy
     debate (forum thread 146978, staff participating) by making the owner's setting
     the control — and 15+ years of third-party collection-display apps (Facebook
     embeds, MMM-Discogs household displays, the "Share Your Discogs App!" showcase)
     have operated on it since.
  4. The "Transfer Restricted Data to any third party" clause, read against the
     app-building grant and the parallel prohibition on "**selling or giving** … Our
     API, the Content, **or access**," is best read as barring redistribution of the
     data/access itself (datasets, syndication, bulk conveyance) — not display inside
     your app to your app's own users. The strict alternative reading would outlaw
     every price widget and collection viewer ever built on this API.
  5. Still absolute regardless of reading: no prices/marketplace data shown to others
     (we suppress server-side), no commercial use, 6h freshness, no ad/marketing
     platforms. The roadmap already honors all.
  No forum thread contains a definitive modern staff ruling on member-to-member display
  specifically — the written question (W0.2b) remains worthwhile insurance, now
  sharpened to cite the clauses above.

  **Second research pass (2026-08-29, recent-years intel — wave-consequential):**
  6. **Discogs ACQUIRED WantLister (June 2024)** — a third-party API app doing want/have
     matching across users. They bought it rather than banning it: the strongest
     available legitimacy signal for Wave 2's match matrix, cited in the letter.
  7. **Rate limits are per SOURCE IP** (60/min authenticated, per the official
     announcements + `X-Discogs-Ratelimit-*` headers), not per token. Our Edge Functions
     share Supabase egress IPs — simultaneous imports by multiple users may contend for
     one budget. Fine at 2 users (observed); **Wave 2's plan adds header-driven adaptive
     pacing** (read `X-Discogs-Ratelimit-Remaining`, slow down before 429s) since the
     wantlist import roughly doubles per-sync load. Unique User-Agent requirement:
     already satisfied (`TraxWax/1.0 +https://traxwax.com`).
  8. **`data.discogs.com` publishes monthly CC0 database dumps** — a rate-limit-free
     path for catalog metadata at scale. Not needed now; recorded as the Wave-6-era
     alternative if per-user enrichment ever strains (whole-catalog refresh from dumps,
     API reserved for per-user Restricted data).
  9. **Endpoint stability:** the recently "removed" `/marketplace/search` was
     UNDOCUMENTED (never production-supported); documented endpoints have been stable
     since the 2014 v2 consolidation. Wave 2 (wantlist CRUD) and Wave 4 (inventory) ride
     documented endpoints. A GraphQL API is in development with REST explicitly not
     deprecated; the official Python client was handed to the community — watch, not
     worry.
  10. **Company weather (balanced):** Discogs was sold; layoffs and July-2025 fee
     increases produced documented seller discontent and reported sales declines — AND
     the official mobile app is actively developed (new app, updated 2024+; Lane is a
     daily user). Read: business-model turbulence at the marketplace layer, continued
     product investment. Implications: keep TraxWax's baked-fallback resilience, couple
     only to documented API surface, expect terms evolution (they reserve the right to
     charge for API access), and note the disaffected-collector community is also an
     audience.
  11. **`/sell/post/{release_id}` verified live** (2026-08-29): auth-gated, resumes
     after Discogs login, lands on the prefilled listing form. Wave 4's zero-API deep
     link stands.
- **W0.2b — The written question to Discogs (Lane sends).** Short, factual, non-leading;
  logged in the terms summary with the send date and any reply. Rewritten 2026-08-29
  after the research pass — now cites the specific clauses and the WantLister precedent:

  > *Subject: API terms question — consented collection sharing between our app's users*
  >
  > *Hi — I run TraxWax (traxwax.com), a small non-commercial hobby app on your API.
  > Users connect their own Discogs accounts via OAuth 1.0a and browse their own
  > collections. We show both required attribution notices, store only CC0 catalog data
  > durably, and fetch prices/marketplace data live per user under that user's own
  > token, within the 6-hour freshness rule.*
  >
  > *We'd like to add a feature where a user explicitly opts in to showing their
  > collection (and later wantlist) to specific friends they invite inside the app —
  > conceptually like a public collection on discogs.com, but scoped to chosen people,
  > instantly revocable, and never including prices or marketplace data.*
  >
  > *Our reading of the API TOU is that this fits the Restricted Data license to
  > "create and run websites and applications" — since collection and wantlist are
  > defined there as categories a user "may display," and the visibility choice stays
  > with the data's owner — and that the "transfer to any third party" restriction is
  > aimed at redistributing data or access itself rather than consented in-app display
  > (we note similar member-to-member want/have functionality existed in WantLister
  > prior to your acquisition of it). Could you confirm that reading, or let us know
  > what you'd prefer we change? Happy to adjust to whatever you're comfortable with.*
- **W0.3 — Profiles V5 E2E confirmation** (leftover from v1.3.x): avatar loads under the
  custom Clerk domain (the img.clerk.com hypothesis), modal fields persist, photo upload
  round-trips. Plus Tommy's name appearing in his profile row on his next visit — the
  first organic test of the sync.
- **W0.4 — Accessibility polish. SHIPPED v1.3.3 (2026-08-30).** All four line items done:
  `aria-live` on the result count (v1.3.2); detail-modal focus-trap + focus restore
  (returns to the invoking card, survives the async stats/tracklist re-render); roving
  grid focus (single tab stop, arrows + Home/End across covers, **Tab-into-cell** so the
  focused card's artist/title/color controls stay keyboard-reachable — the "full roving"
  model would have stranded those filters, a WCAG 2.1.1 fail caught in remediation-audit);
  and the `cover_image` modal cover (already satisfied by `deco()`, verified). `app.js`
  only. **NOTE:** the modal reuses `trapFocus`'s *selector convention* via a re-render-safe
  controller in `app.js` rather than calling `boot.ui.js`'s `trapFocus` directly — app.js is
  dependency-free and `render()` rebuilds the DOM wholesale, which `trapFocus`'s one-shot
  capture cannot survive. Known follow-up: `inert`/`aria-hidden` the background behind the
  open modal (pre-existing; deferred).
- **W0.5 — The design-surfaces pass. SHIPPED v1.3.2 (2026-08-29).** The nine bare system
  states, the auth chrome, the landing page, and the account surface were rebuilt into one
  shell system. Full spec `docs/design-surfaces-spec.md` (read its as-built note); surface →
  file map `docs/design-screen-map.md`; companion crate spec `docs/design-crate-spec.md`;
  the runnable design doc + its sources at `docs/design-source/` (open `TraxWax
  Surfaces.dc.html` locally for all 20 frames); the Design team's sync anchor at repo-root
  `github.md` (carries an as-built reconciliation of the `/account` divergence).
  Two decisions on record (Lane, 2026-08-29):
  1. **The account surface routes at `/account` and `/account/discogs`, OUTSIDE `/app`** —
     not `/app/account` with a reserved-word carve-out. **Consequence for later waves:** the
     spec's plan to reserve `i`/`invite` inside a `RESERVED_SEGMENTS` set is MOOT — no such
     set exists. Wave 1's invite-accept path and Wave 5's public-crate URLs each need their
     own top-level route (e.g. `/i/<code>`, `/c/<slug>`), added to `public/_redirects` the
     same way `/account` was (rewrite to the `/app/` shell). Decide their shape in-wave.
  2. **Cut as a PATCH (v1.3.2), leaving the wave → version map below untouched** (Wave 1 is
     still v1.4.0, etc.). Heftier than a usual patch; a deliberate call to keep the map
     stable, per the rev1-F10 note that version pairings are indicative targets.
  **What is BUILT NOW but deliberately dormant** (wire it in the named wave, don't rebuild):
  `UI.toggle` (consent switches — W1/2/4), `UI.emptyState` (reused empty states — W1/2/3),
  `.tw-badge-*` + `badgesHtml`/`badgesFor` (match badges — W2), `priceCellHtml` (friend-crate
  price cell — W1), the account nav's disabled `SHARING`/`FRIENDS` `SOON` rows (W1), and the
  landing `.tw-land-slab` (public-crates slot — W5). The landing hero was captured
  2026-08-29 → `public/screenshots/crate-hero.jpg` (2560×1840, JPEG; also the OG card).

## 4. Wave 1 — Friends & consented crates → **v1.4.0**

The consent wall, the friendship graph, and the first time anyone sees anyone else's
records. Deliberately friends-only: no public crates, no discovery — the current user
base is two people who know each other.

- **Schema (rev1-F3):** `friendships` + `friend_invites` (code storage, TTL'd), and —
  because clients cannot insert rows naming other users under this project's RLS regime —
  an **accept-invite SECURITY DEFINER RPC** (atomic consume-code-create-mutual-row, the
  `finalize_discogs_link` shape). `profiles.crate_visibility` (`private` default |
  `friends`) — **written extensibly** (rev1-F6): the CHECK constraint and every policy
  built so Wave 5 can add `'public'` by amendment, not rebuild. RLS: friend-readable
  SELECT policies on
  `collection_items` + the profile DISPLAY fields (display_name, avatar_url, bio,
  location, collecting_since, links) gated on `crate_visibility` + friendship existence
  — **the highest-risk RLS change in the roadmap; the wave plan's audit prompt names it
  explicitly** (a leak here is other people's Restricted data).
- **Consent UI:** ACCOUNT modal gains "Who can see your crate" (private/friends) and a
  FRIENDS section (invite link, friend list, remove — removal is instant revocation both
  directions). **Consent is PER DATASET, decided now (rev1-F7):** the crate toggle covers
  the crate only; Wave 2 adds a separate wantlist toggle, Wave 4 a for-sale toggle — a
  Wave-1 opt-in never silently expands to expose data that didn't exist yet.
- **Price suppression is server-side (rev1-F4):** `live-stats` gains a visit context
  (or the visit path uses a distinct kind) that OMITS `price` from the response when the
  viewed record is not the viewer's own — the "prices never on anyone else's crate" rule
  is enforced where the data originates, not by the client politely not rendering it.
- **`delete_account` amended in this wave's migration** to remove friendship + invite
  rows (rev1-F11) — deletion semantics extend in the same migration, per ritual.
- **Visiting:** `/app/<username>` resolves for friends of a consenting owner. Read-only
  crate: no RE-SYNC, no ACCOUNT modal-of-theirs; their avatar + display name + bio in
  the header (the v1.3.0 groundwork pays off); owner line becomes THEIR shelf's voice.
  Modal stats fetch via `live-stats` under the VIEWER's token (pattern unchanged).
- **Not-found vs not-friends** renders identically (privacy: don't confirm a username
  exists to a stranger).
- **▸ Design (ready now) — from the v1.3.2 pass, spec §9.1–9.7:**
  - **Consent UI:** the crate visibility control is `UI.toggle` (built now, spec §4.3); one
    row per dataset — this wave adds the crate toggle only (§9.5). Turn the account nav's
    disabled `SHARING`/`FRIENDS` `SOON` rows into live links (`boot.ui.js` `NAV`), and
    **delete the profile-section line "Nobody sees any of this yet…"** the day
    `crate_visibility` ships (§9.7).
  - **FRIENDS list empty state:** `UI.emptyState({kicker:'NO FRIENDS YET', …})` — reuse the
    pattern, do not author a new one (§9.9).
  - **Visiting a friend's crate (S18, §9.2):** the owner line is the profile slot → avatar +
    display name + `COLLECTING SINCE`; the stat strip takes match cells by **appending** with
    a hairline divider, so **`EST. VALUE` must not be load-bearing** (it legally cannot appear
    on a friend's crate and simply drops out). No `RE-SYNC`, no account button on their crate.
  - **Price cell (§9.4, the most breakable detail):** on a friend's crate every price arrives
    `null` (suppressed server-side in `live-stats`). Render `priceCellHtml(rec, /*isOwn*/false)`
    → `SEE ON DISCOGS →`. The cell must ALWAYS render or card heights reflow between shelves.
  - **Not-found vs not-friends (§9.1, PRIVACY-CRITICAL):** reuse the SAME `UI.COPY.noCrate`
    render (S10, grey rule) for both cases — never differ by one character. Not-found already
    uses it; point the not-friends path at the identical render.
  - **Invite-accept route:** because the account page went to `/account` (no
    `RESERVED_SEGMENTS`), add the invite path as its own top-level route (e.g. `/i/<code>`)
    in `public/_redirects`, mirroring `/account`. See W0.5.
- **Cut v1.4.0** when Lane and Tommy can see each other's crates and revocation
  round-trips. CHANGELOG headline: "Friends & shared crates."

## 5. Wave 2 — Wantlists & the match matrix → **v1.5.0**

The strategic unlock. Overlap without wants is trivia; haves×wants is utility.

- **Schema:** `wantlist_items` (user_id, release_id, added — same Restricted posture as
  collection_items: own-token import, friend-readable under the same consent gate,
  deleted on disconnect/deletion — the unlink/delete RPCs are amended IN THIS WAVE's
  migration). Wantlist releases seed the shared CC0 catalog through `seed_releases`
  exactly like collection imports (release-keyed and ownership-agnostic — verified).
  **Honest scope (rev1-F2):** the enrich loop's request/pacing/tombstone logic carries
  over unchanged, but the WORK-DISCOVERY layer is real Wave-2 design: `pending_enrichment`
  joins `collection_items` in all five subqueries, and `enrich-release` closes the
  `last_import_at` boot gate on `owned === 0` — a wantlist-only user's wanted releases
  would never enrich and the gate's completion semantics must be redefined for combined
  collection+wantlist imports. A named plan item, not a footnote.
- **Import:** wantlist page-loop in the import pipeline (Discogs wantlist endpoint,
  user's token, chunked like Stage C); rides the existing RE-SYNC button. **Plus
  header-driven adaptive pacing** (research finding 7): rate limits are per SOURCE IP
  and our Edge Functions share egress — the import loops start reading
  `X-Discogs-Ratelimit-Remaining` and slowing before 429s, since wantlist import
  roughly doubles per-sync load and simultaneous users contend for one budget.
- **Precedent note (research finding 6):** Discogs acquired WantLister (June 2024), a
  third-party API app doing cross-user want/have matching — this wave's exact shape,
  bought rather than banned.
- **The match RPC:** for viewer V on friend F's crate — V.wants ∩ F.haves and
  F.wants ∩ V.haves, one SECURITY DEFINER function, both consent-gated.
- **UI:** WANT badge (viewer's want, friend's have) and HAVE badge ("you own this too")
  while browsing a friend's crate; a MATCHES stat block on their crate header ("YOU WANT
  12 THEY HAVE · THEY WANT 4 YOU HAVE"); THE WANTLIST as a view of one's own crate;
  one-click ADD TO WANTLIST on any record in a friend's crate (Discogs API PUT under the
  viewer's own token, then local row insert — stays consistent with next import).
- **▸ Design (ready now) — from the v1.3.2 pass, spec §9.3:**
  - **Card badges:** `.tw-badge-you` (accent — true about YOU → `ON YOUR WANTLIST`),
    `.tw-badge-both` (ink — true about BOTH → `YOU OWN THIS`), `.tw-badge-else` (panel + rule
    — action lives ELSEWHERE → `FOR SALE`). CSS shipped; helpers `badgesHtml(badges)` and
    `badgesFor(rec, ctx)` are in `app.js`, uncalled. Feed `ctx = {viewerWants, viewerHas,
    forSale}` from the match RPC and render `badgesHtml` in the card's cover wrapper (already
    `position:relative` for `JUST IN`). **Two-badge cap; wantlist/you-own are mutually
    exclusive** — that is what makes the cap safe. Grammar is fixed at design time — keep it.
  - **MATCHES stat block** on the friend's crate header: append cells with the hairline-divider
    pattern (§9.2), same mechanism as Wave 1's match cells.
  - **"No matches" empty state:** `UI.emptyState` again (§9.9).
- **Cut v1.5.0**: "Wantlists & the match matrix."

## 6. Wave 3 — THE OVERLAP → **v1.6.0**

The affinity showpiece, riding on Wave 1's consent + Wave 2's data.

- **THE OVERLAP view** — a fourth tab that appears only when visiting a friend's crate:
  records in common as a grid, a brutalist stat block ("217 IN COMMON · 12% OF YOUR
  SHELF · 17% OF THEIRS"), filterable by the standard facets.
- **Taste-match score:** cosine similarity over style/genre/decade/label vectors —
  computed from data we already hold, zero API calls; rendered as "87% MATCH" with the
  top three shared styles.
- **"Rarest shared record" (renamed, rev1-F8):** overlap ranked by Discogs-wide
  community have-counts (fetched sparsely via the viewer's `live-stats`, ≤6h cache;
  budget-capped sub-view). It can honestly say "only 43 collectors on Discogs have
  this" — it can never establish "only you two," so it doesn't claim to.
- **Activity pulse (small, durable):** "Tommy added 3 records this week — 1 is on your
  wantlist" on the friend list. Derived from collection_items.added deltas (a pulse RPC —
  in the appendix now, rev1-F9), with the honest caveats: `added` is date-granular
  Discogs data that only refreshes when the FRIEND re-syncs — the pulse reads "as of
  Tommy's last sync," and the UI says so. No feed infra, no notifications yet.
- **▸ Design (ready now) — from the v1.3.2 pass, spec §9.6/§9.9:**
  - **Empty overlap** reuses `UI.emptyState` (§9.9).
  - **Activity pulse** on the friend row REPLACES the row's meta line — it does not change the
    three-line row shape (§9.6). Same slot Wave 4's "selling 2 you want" will reuse.
- **Cut v1.6.0**: "The Overlap."

## 7. Wave 4 — Selling, via Discogs → **v1.7.0**

Commerce-shaped without touching commerce.

- **SELL THIS deep link** on one's own records (modal):
  `https://www.discogs.com/sell/post/{release_id}` — prefilled listing form on Discogs.
  Zero API. (This single feature could ship early in any wave if the itch strikes.)
- **Inventory import:** the user's Discogs marketplace inventory (own token, same
  pipeline pattern) → `inventory_items` (release_id, listing_id, status; NO PRICE
  STORED — the terms posture stays clean and the link is the price's home). Same
  disconnect/deletion amendments, same wave.
- **FOR SALE badges + shelf:** on one's own crate and (consent-gated) on friends' —
  each badge links to the live Discogs listing where price/condition/checkout live.
- **The compound feature:** friend's-for-sale ∩ your-wantlist — "TOMMY IS SELLING 2
  RECORDS YOU WANT" on the crate header and friend list. The whole roadmap's best idea;
  it is three imports and one join.
- **▸ Design (ready now) — from the v1.3.2 pass, spec §9.3/§9.5/§9.6:**
  - **FOR SALE badge** is already the third badge in the grammar — `.tw-badge-else` (panel +
    ink rule, "action lives elsewhere"), stacking under a wantlist/you-own badge (§9.3).
  - **For-sale consent** is the third `UI.toggle` row in the account SHARING section (§9.5) —
    the switch is built; only the dataset is new.
  - **"Selling N you want"** rides the friend row's meta line (§9.6), same slot as Wave 3's
    pulse.
  - **SELL THIS deep link** on one's own records lives in the detail modal (`app.js`),
    `https://www.discogs.com/sell/post/{release_id}` — verified live 2026-08-29 (W0.2a #11).
- **Cut v1.7.0**: "The record store between friends."

## 8. Wave 5 — Share the shelf (off-platform) → **v1.8.0**, then Wrapped

Growth mechanics, aggregate-only, terms-clean by construction.

- **Collection DNA card:** a shareable image (canvas-rendered client-side, downloaded —
  no server) — decade histogram, top styles, colored-wax %, count, plus
  collecting-since (a profile field the owner chose to publish, not an aggregate —
  labeled honestly, rev1-F11). No ownership lists, no prices.
- **Public visibility tier** (`crate_visibility: 'public'`) + shareable crate URLs +
  OG-image cards so links unfurl. Public arrives HERE, not in Wave 1 — by now consent
  UX, revocation, and the RLS surface have three waves of hardening behind them.
  **Honest scope (rev1-F6):** this is the roadmap's second-biggest lift, not a garnish —
  anonymous-visitor RLS policies (a whole new grant surface), a no-auth boot path in
  boot.js, server-side OG rendering, and a fresh terms gate: the "service to your
  application's users" argument does NOT cover anonymous visitors, and the terms summary
  flags that **Discogs usernames are themselves Restricted** — public crate URLs likely
  need TraxWax-chosen slugs rather than `/app/<discogs_username>`. Wave 5's plan re-opens
  the terms analysis as an entry criterion; this is also where written confirmation from
  Discogs is most valuable if not already obtained (see §1).
- **Shareable filtered-view URLs** (the long-parked roadmap item) — state serialized to
  the query string, works on own/public crates.
- **▸ Design (ready now) — from the v1.3.2 pass, spec §9.8:**
  - **The landing position slab** (`.tw-land-slab`, the full-bleed dark band above the footer)
    is the public-crates slot — shared-crate cards, a DNA-card preview, or an OG unfurl example
    drop in **without touching the hero**. The three-up strip extends to a fourth cell
    (`FILE BY FRIEND`) by the same grid.
  - **Public-crate URLs:** Discogs usernames are themselves Restricted, so public crates likely
    need TraxWax-chosen slugs rather than `/app/<discogs_username>`. Route them top-level (e.g.
    `/c/<slug>`) via `public/_redirects`, mirroring `/account` — the `i`/`invite` reservation
    the spec assumed does NOT exist (W0.5, decision 1). OG per-crate rendering replaces the
    landing's `crate-hero.png` OG image.
- **Cut v1.8.0**: "Share the shelf."
- **TraxWax Wrapped → v1.9.0**, cut in December: **counts and aggregates only**
  (rev1-F5) — pickups COUNT, styles drift, DNA evolution, collecting streaks; never an
  ownership list in the shareable artifact, and never spending. (If owner-published
  "highlight records" ever join Wrapped, that's an explicit argued exception to the
  off-platform rule, decided then.)

## 9. Wave 6 — Community (→ v2.0.0, when the room has people)

Explicitly parked until the user count justifies it: activity feeds with notifications,
discovery (browse public crates by style/era), local collectors (the location field
earns its keep), "most-owned on TraxWax" catalog stats, comments/reactions (moderation
burden — needs real thought), asymmetric follows. **v2.0.0 is the public-community
turn** — the major bump marks the posture change from private tool to social platform,
and it re-opens the terms analysis + a security cold audit as entry criteria.

## 10. Interstitials — solo features to slot between waves as palate cleansers

**Version-number rule (rev1-F10):** features ALWAYS bump the minor, per semver — so the
wave→version pairings above are indicative targets, not reservations. Minors are
allocated in actual ship order; an interstitial that ships between waves takes the next
free minor and the wave numbers slide. Patches stay reserved for fixes.

Any of these can ship between waves without disturbing the sequence:
custom shelves/tags ("grails" begs to be shared later — quiet social groundwork),
random-record-tonight, duplicate detection, a listening log, richer LEDGER analytics.
Rule: an interstitial never blocks a wave and never introduces a new imported dataset
(that is wave-tier work because of the deletion-semantics ritual).

## 11. Sequencing rationale + assumptions register

- **Consent before data, data before display, display before growth.** Wave 1 builds the
  wall; 2 fills the shelves both directions; 3–4 make it delightful and useful; 5 opens
  the windows; 6 opens the doors.
- **Riskiest assumption:** the consented-sharing terms position (W0.2 pins it; the
  research pass materially strengthened it — license grant, "may display" definition,
  WantLister precedent — and W0.2b's letter is now insurance rather than permission).
  Second: friend-readable RLS correctness (Wave 1's audit focus). Third — UPGRADED by
  research finding 7: rate budgets are per SOURCE IP, not per token, and our Edge
  Functions share egress; contention is invisible at 2 users and arrives with
  simultaneous syncs (mitigation: adaptive header-driven pacing lands in Wave 2; the
  429 backoff machinery already exists). Fourth: platform evolution — Discogs' business
  layer is turbulent (sale, layoffs, fee discontent) even as product investment
  continues (the official app is actively developed); we couple only to documented
  endpoints, keep the baked fallback alive, and treat `data.discogs.com` CC0 dumps as
  the at-scale catalog alternative.
- **Cheapest test of everything:** Lane + Tommy, friends-only, Waves 1–2. Every social
  mechanic gets a real two-person shakedown before it matters at ten.

---

## Appendix — projected schema/function growth (sketch, superseded by wave plans)

| Wave | New tables | New/changed functions | Amended RPCs |
|---|---|---|---|
| 1 | friendships · friend_invites (+crate_visibility col) | accept-invite RPC · live-stats visit-context (price suppression) | delete_account (friendship + invite rows) |
| 2 | wantlist_items | import-wantlist (or import-collection v2 param) · match RPC · enrich-release gate redesign | unlink + delete (wantlist rows) · pending_enrichment (wantlist joins ×5 + owned semantics) |
| 3 | none | overlap/taste RPCs · activity-pulse RPC | — |
| 4 | inventory_items | import-inventory | unlink + delete (inventory rows) |
| 5 | public slugs (usernames are Restricted) + share tokens | anon-RLS surface · no-auth boot path · og-card function | policies amended for 'public' |

---

## Audit record — rev 1 → rev 2 (2026-08-29)

Independent verification: REVISE-FIRST. **F1 (CRITICAL):** §1's consent position
contradicted the project's own standing terms conclusion without acknowledging it;
elevated to Lane, decided **ask + build in parallel** (§1, W0.2/W0.2b). **F2:** Wave 2's
"v1.2.0 machinery needs no changes" was false and self-contradictory — the
work-discovery RPC, its owned-gate semantics, and the last_import_at completion
definition are named plan items now. **F3:** Wave 1 understated its own invite
mechanism (invite storage + accept RPC added; "none — RLS does the work" corrected).
**F4:** the unchanged live-stats pattern would have shipped prices onto friends' crates
— server-side visit-context suppression specified. **F5:** Wrapped's "year's pickups"
was an ownership list in a shareable artifact — now counts/aggregates only. **F6:**
Wave 5's public tier honestly scoped (anon-RLS, no-auth boot, OG rendering, Restricted
usernames → slugs, its own terms gate). **F7:** consent made per-dataset, decided now.
**F8:** "Only you two own this" renamed to what the data can support. **F9:** pulse
caveats + RPC. **F10:** semver rule replaces pre-pinned minors. **F11:** prose/appendix
mismatches reconciled. Verified correct by the same pass: seed_releases
ownership-agnosticism, 0009 amendment scheduling, live-stats friend-viewing (modulo F4),
merged not-found/not-friends rendering, rituals-vs-practice, W0-vs-standing-debts,
version numbering.
