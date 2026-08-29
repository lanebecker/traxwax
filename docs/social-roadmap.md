# TraxWax — The Social Roadmap

**Rev 2 — 2026-08-29 (rev 1 verification-passed: REVISE-FIRST, 1 CRITICAL + 6 MAJOR +
4 MINOR, all folded — Audit record at bottom; the CRITICAL became a Lane decision,
recorded in §1).** The captured brainstorm (Lane + Claude, 2026-08-29) turned into a
development sequence: waves of implementation, the release cut for each, and the rituals
that keep documentation and hygiene current. This is a SEQUENCING document — each wave
still gets its own implementation plan at the junior-engineer bar, twice audited, before a
line of its code executes. Nothing here overrides that.

Current shipped version at time of writing: **v1.3.1** (profiles + floating avatar).
Users: 2 (lanebecker, SoundAbounds/Tommy).

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
- **W0.2b — The written question to Discogs (Lane sends).** Short, factual, non-leading;
  logged in the terms summary with the send date and any reply. Draft:

  > *Subject: API terms question — consented collection sharing between our app's users*
  >
  > *Hi — I run TraxWax (traxwax.com), a small non-commercial hobby app built on your
  > API. Users connect their own Discogs accounts via OAuth and view their own
  > collections. We display the required attribution and store only CC0 catalog data
  > durably; prices/marketplace data are fetched live per user under their own token.*
  >
  > *We'd like to let a user explicitly opt in to showing their collection to friends
  > they invite inside the app (similar to a public collection on discogs.com, but
  > scoped to chosen users). The data would still be imported under the owner's own
  > OAuth authorization, refreshed by their own syncs, deleted when they disconnect,
  > and would never include prices or marketplace data. Is this consistent with the
  > API terms' restrictions on Restricted Data? Happy to adjust our approach to
  > whatever you prefer.*
- **W0.3 — Profiles V5 E2E confirmation** (leftover from v1.3.x): avatar loads under the
  custom Clerk domain (the img.clerk.com hypothesis), modal fields persist, photo upload
  round-trips. Plus Tommy's name appearing in his profile row on his next visit — the
  first organic test of the sync.
- **W0.4 (optional, if the runway-clearing feels thin) — Accessibility polish** as
  v1.3.2/v1.4.0-adjacent: modal focus-trap + focus restore, roving grid focus,
  `aria-live` result count, `cover_image` modal cover. It has waited since v0.5.0
  planning; friends browsing each other's crates makes keyboard/screen-reader quality
  more visible, not less.

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
  user's token, chunked like Stage C); rides the existing RE-SYNC button.
- **The match RPC:** for viewer V on friend F's crate — V.wants ∩ F.haves and
  F.wants ∩ V.haves, one SECURITY DEFINER function, both consent-gated.
- **UI:** WANT badge (viewer's want, friend's have) and HAVE badge ("you own this too")
  while browsing a friend's crate; a MATCHES stat block on their crate header ("YOU WANT
  12 THEY HAVE · THEY WANT 4 YOU HAVE"); THE WANTLIST as a view of one's own crate;
  one-click ADD TO WANTLIST on any record in a friend's crate (Discogs API PUT under the
  viewer's own token, then local row insert — stays consistent with next import).
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
- **Riskiest assumption:** the consented-sharing terms position (W0.2 exists to pin it).
  Second: friend-readable RLS correctness (Wave 1's audit focus). Third: per-user rate
  budgets absorbing wantlist+inventory imports on RE-SYNC (mitigation: staged page
  loops already pace; watch Tommy-scale reality in Wave 2).
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
