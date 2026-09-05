# Wave 5 — "Share the shelf (off-platform)" — design brief + decisions register

Status: DRAFT for Lane. Purpose: (1) scope Wave 5 from the roadmap, (2) enumerate every decision — design and
otherwise — needed to get it moving, (3) mark which decisions gate the rest, and which parts go to Claude Design
vs. need Lane / engineering calls. Nothing here is built until each piece gets its own write-plan → verification-
pass → build → audit, per the rituals.

## SETTLED (Lane, 2026-09-04)
- **§A1 Sequencing = CLEAN-FIRST.** Ship **5a = DNA card + shareable filtered-view URLs** now (terms-clean,
  frontend-only, no anon, no migration, no break-glass). Then **5b = the public-crate tier** as its own gated
  release.
- **§C "public" = truly public (option a):** anyone with the link, **even signed-out** — a non-TraxWax visitor
  opens `/c/<slug>` and sees the crate (name/avatar/bio/DNA, no prices, no Discogs username). This is the 5b lift
  (no-auth boot path + anonymous read surface + OG rendering) and the piece that needs the terms gate.
- **§A2 Letter = DISCUSS FIRST**, and **rework it for truly-public** before sending (the current draft is framed
  friends-only; truly-public is a broader ask). Not blocking — 5a needs no letter; the letter + terms work are a
  **5b entry criterion**, handled when we start 5b.
- **Immediate path:** build 5a. The **DNA card** is the Claude Design piece (decisions §D below); the
  **filtered-view URLs** are a small engineering plan (§E). 5b decisions (§B slugs/anon/OG, §C scope) are parked
  until 5a ships and we open the terms discussion.

Source: `docs/social-roadmap.md` §8 (Wave 5) + §3 W0.5 (design-surfaces reserved slots) + `docs/design-surfaces-
spec.md` §9.8. Roadmap target v1.8.0 (indicative; semver = next free minor at ship).

## The four things Wave 5 contains
1. **Collection DNA card** — a shareable image (client-side canvas → download, no server): decade histogram,
   top styles, colored-wax %, total count, collecting-since. **Aggregate-only, terms-clean by construction** —
   no ownership lists, no prices.
2. **Public visibility tier** (`crate_visibility: 'public'`) + shareable crate URLs + OG unfurl cards. **The big
   lift, and the one with a terms gate** — anonymous visitors, a new RLS grant surface, a no-auth boot path,
   server-side OG rendering, and TraxWax-chosen slugs (Discogs usernames are themselves Restricted).
3. **Shareable filtered-view URLs** — the current filter/sort/tab state serialized to the query string; works on
   own + public crates. Small, terms-clean.
4. **TraxWax Wrapped** (roadmap slots this for December, its own cut) — counts/aggregates only. **Out of scope
   for this brief; decided closer to December.**

## The load-bearing split (why sequencing is decision #1)
Three of the four pieces are **terms-clean today**: the DNA card and Wrapped are aggregates of the owner's own
data; filtered-view URLs are just app state. The **public tier is the only piece that needs a fresh terms
gate** — the roadmap's own §8/§1 note: *the "service to your application's users" argument does NOT cover
anonymous visitors*, and this is *where written confirmation from Discogs is most valuable*. That draft letter
(W0.2b) has been ready-to-send since Wave 0. So Wave 5 naturally splits, and how we sequence it is the first
call.

---

## DECISIONS REGISTER

### §A — Sequencing & terms  ★ GATING (Lane) — decide first, it shapes everything below
- **A1. How to sequence the public tier vs. the terms gate.** Options:
  - *(a) Clean-first (recommended):* ship **5a = DNA card + shareable filtered-view URLs** now (both terms-clean,
    no anon, no new RLS), and gate **5b = the public tier** on sending the Discogs letter. Delivers shareable
    value immediately; de-risks the big lift.
  - *(b) Ask + build in parallel* (the Wave 1 posture): send the letter AND build the public tier now on the
    reasoned position; flip it off if Discogs objects.
  - *(c) Everything at once* on the reasoned position, letter optional.
- **A2. Send the Discogs letter now?** It's drafted (roadmap §W0.2b), sharpened with the clause citations +
  WantLister precedent. It's most valuable right before the public tier. (This is a Lane action — Claude can't
  send mail on your behalf.)
- **A3. Public tier go/no-go if no reply.** If the letter goes unanswered for N weeks, do we ship the public
  tier anyway on the reasoned position, or hold it? (Defines the 5b entry criterion.)

### §B — Public-crate architecture  (Lane + engineering) — only if 5b is in play
- **B1. Slug scheme.** Discogs usernames are Restricted, so public URLs can't be `/app/<discogs_username>`.
  Options: user-chosen vanity slug (`/c/lanes-crate`), a random opaque token (`/c/a1b2c3`), or a slug seeded
  from `display_name` with a uniqueness suffix. Trade-off: memorable/shareable vs. leaks-nothing vs. collisions.
- **B2. Anonymous read path.** A `get_public_crate(slug)` SECURITY DEFINER RPC (mirrors `get_friend_crate`) vs.
  anon SELECT RLS policies on the tables. The RPC keeps the anon grant surface tiny (one function, no table
  policies) — consistent with the #42 pattern; recommend that, but it's an architecture call.
- **B3. No-auth boot path.** `boot.js` currently requires Clerk before rendering a crate. A public crate must
  render for a signed-out visitor. Decision: a separate lightweight boot path (no Clerk load) for `/c/<slug>`.
- **B4. OG image rendering.** OG unfurl cards need a per-crate image at a crawlable URL. The site is static
  (Cloudflare Pages, no server). Options: a Cloudflare Pages Function, a Supabase Edge Function rendering the
  card, or pre-generated images on publish. This is the heaviest new infra in the wave.
- **B5. Route wiring.** `/c/<slug>` added to `public/_redirects` (mirroring `/account`), + `_routes.json` /
  `_headers` implications for a no-auth, crawlable page (the CSP + the Clerk-key hardcoding in the app shell both
  assume an authed app — a public page may need its own shell or a gated script load).

### §C — Public-crate product scope  (Lane) — only if 5b is in play
- **C1. Which datasets go public — SETTLED (Lane, 2026-09-05): PER-TAB, all three.** Public is NOT crate-only.
  It's a **three-way selector mirroring the friends model** — `crate_visibility`, `wantlist_visibility`, and
  `forsale_visibility` each independently settable to `'public'` via an expanded selector, so a user chooses
  exactly which of the three tabs the world sees. (Supersedes the earlier "crate-only for v1" recommendation.)
  Each of the three existing visibility columns already accepts the enum amendment; 5b adds `'public'` to all
  three + the anon-read surface for each.
  - **Terms note for `forsale` public:** for-sale is the one with a marketplace wrinkle. TraxWax already shows
    for-sale as a *badge that links out to the Discogs listing* and **never shows a price** — and a seller's
    listings are public on Discogs' own seller pages — so a public for-sale tab is "these are for sale → view
    on Discogs," not a mirrored marketplace. The Discogs letter must name for-sale explicitly (it does, as
    reworked) so this is covered by the same written confirmation.
- **C2. Is `'public'` one flag or its own axis — per-tab (see C1).** Each visibility column gets `'public'` as
  the top of its ladder (private → friends → public); public is a superset of friends (public ⇒ friends also
  see). The three are independent: a user can be crate-public but wantlist-friends and for-sale-private, any
  combination. The expanded selector (Design piece for 5b) presents all three.
- **C3. What a public crate shows about the owner.** Display name, avatar, bio, collecting-since — all
  owner-published profile fields (safe). Confirm the Discogs username is NEVER shown (it's Restricted) — the
  slug replaces it as the public identity.
- **C4. Prices/stats on a public crate.** Same rule as friends: no price ever; per-release community stats only
  under a *viewer's* token — but an anonymous visitor has no token, so a public crate shows **catalog data
  only** (no live-stats at all). Confirm that's acceptable (public crates are covers + titles + years, no
  community numbers).

### §D — Collection DNA card  ★ THE Claude Design piece for 5a — DESIGN-READY (revised, Lane 2026-09-04)
> **REVISED 2026-09-04.** The stat set is no longer a fixed five — it is now an **open palette (Design's call
> which and how many)**, and Design returns **THREE distinct card designs** the user chooses between inside
> TraxWax. See the **DNA CARD — MINI-BRIEF ADDENDUM** at the bottom of this doc for the full palette (13
> candidate stats with data sources + terms status) and the three-variant directive. The bullets below are the
> **unchanged fixed frame**; the addendum supersedes the old "keep the five" content rule.

A shareable image of the owner's collection, generated client-side and downloaded. **SETTLED PARAMETERS**
(the fixed frame — design within these):
- **Format: one square, 1080×1080**, downloaded as PNG. Versatile across texts/IG/Discord. (No landscape or
  story variants in 5a; the landscape OG image is a separate 5b concern.)
- **Content: an open stat palette — see the addendum.** Strictly aggregate — never any record titles or a list
  of what's owned, never a price. Design chooses which stats each of the three cards shows and how many; the
  only honesty rule that carries: collecting-since is a profile field the owner published, not a computed
  aggregate — label it as such, not as "collecting for N years" unless that reads clearly from the same field.
- **Own-crate only.** Generated from your own collection (the data's already client-side). Not from friend/
  public crates in 5a.
- **Branding + MANDATORY attribution:** carries a TraxWax mark AND the Discogs attribution ("Data provided by
  Discogs") — the terms require the attribution to travel on the off-platform artifact. Non-negotiable, must be
  legible on **all three** cards.
- **Rendering: client-side `<canvas>` → `toBlob` → download.** No server round-trip (keeps it terms-clean +
  free). The brutalist TraxWax visual language (Anton/Barlow Condensed/IBM Plex Mono, the ink/accent palette,
  hard shadows) should carry onto the cards so they read as unmistakably TraxWax.
- **What Design should return: THREE 1080×1080 layouts** (see the addendum for how different they should be) —
  each showing how its chosen stats compose, its viz treatments, its hero stat, where the TraxWax mark + Discogs
  attribution sit, light + dark treatments if applicable, PLUS the "share your DNA" entry-point affordance
  (where/how the generate button appears — likely THE LEDGER or the account/profile) and a sense of how the
  **user picks among the three** (the variant chooser).

### §E — Shareable filtered-view URLs  (engineering, small)
- **E1. Serialization.** Which state travels: view/tab, genres, colored/color, search, sort/dir, forSaleOnly,
  match filter? Query string vs. the existing `#hash` tab convention (which already carries the tab). Recommend
  query params for facets + keep the hash for the tab, applied at bootCrate.
- **E2. Scope.** Own crate + public crates; friend crates too? (A filtered friend-crate link only works for
  someone who's also that person's friend — degrades to the base crate otherwise.)

### §F — Landing page slot  (design, already reserved)
- The landing `.tw-land-slab` (dark band above the footer) is the reserved public-crates slot (W0.5). Decision:
  what fills it — shared-crate example cards, a DNA-card preview, an OG-unfurl example — and the fourth
  `FILE BY FRIEND` cell in the three-up strip. Claude Design territory.

---

## What goes to Claude Design — THIS PASS (5a)
Two pieces:
1. **§D — the Collection DNA card** — square 1080×1080, own-only, mandatory Discogs attribution, canvas,
   TraxWax visual language — but now **THREE distinct designs** drawing from an **open 13-stat palette (Design
   picks which/how many)**, with the user choosing among the three inside TraxWax. Full palette + three-variant
   directive in the **MINI-BRIEF ADDENDUM** at the bottom of this doc (supersedes the old "keep the five" rule).
2. **The two SHARE affordances** (Lane, 2026-09-04) for the filtered-view URLs (§E): a **persistent "Share my
   crate"** control and a **contextual "Share this filtered view"** control. Design decides **placement, look,
   labels/icons, and the empty-vs-filtered distinction**. Engineering context for Design: the URL already
   reflects the current filters, and both buttons just fire one click action (`data-act="copyLink"`) that copies
   `location.href` + shows a "Link copied" snackbar — so Design is free on form and placement; the wiring is
   trivial. Candidate homes: the filter bar, the crate header, and/or the SHOWING active-filters rail. Both can
   coexist (persistent = share the whole crate; contextual = share exactly what's on screen).

NOT in this pass:
- **§E filtered-view URLs MECHANISM** — pure engineering (query-string serialization + parse + the clipboard
  helper); Claude builds it directly, no design. Only the buttons above are Design's.
- **§B/§C/§F — the public-crate tier's visuals** (public-crate treatment, the slug identity + signed-out header,
  the OG unfurl card, the landing `.tw-land-slab` fill) — a SEPARATE, later Design pass, opened when 5b starts
  (after 5a ships + the terms discussion). Left in this doc as the register for that pass.

## Recommended path (for Lane to accept or redirect)
Ship **5a first** (DNA card + filtered-view URLs — terms-clean, immediate share value, small), **send the Discogs
letter in parallel**, and hold the **public tier (5b)** as its own release gated on the terms answer (or a
Lane-set timeout). This mirrors the roadmap's own "consent before growth" logic and keeps the risky anonymous-
visitor surface behind the one piece that actually needs the terms gate.

---

## DNA CARD — MINI-BRIEF ADDENDUM (Lane, 2026-09-04) — supersedes §D's "keep the five" content rule

**What changed, in one line:** the DNA card's data is no longer a fixed five-stat set. It is now an **open
palette of ~13 aggregate stats, none required**, and Design returns **THREE distinct card designs** rather than
one. The user will pick which of the three to generate/share **inside TraxWax**.

**Why three:** Lane wants to ship three genuinely different DNA cards and let each user choose their favorite in
the app. For that to be worth doing, the three can't be recolors of one layout — they need different information
hierarchies and different viz treatments, which is why the palette is deliberately broad: **so each design can
draw a different subset and feel like its own thing.**

### The palette (all own-crate, aggregate, terms-clean, computable client-side)
Design picks which stats each card uses and how many — there is **no required stat** and no fixed count. Keep the
attribution + own-only + 1080×1080 + canvas + TraxWax visual language from §D on **all three**.

| Stat | What it is | Client-side source | Notes |
|---|---|---|---|
| Decade histogram | Count of records per decade (bar chart) | `year` | The original hero-candidate; a strong backbone viz. |
| Peak decade | Your single biggest decade, pulled out as a hero number | `year` | Derived from the same histogram data — a focal callout. |
| Year span / oldest pressing | Earliest→newest pressing year (e.g. 1968–2025), or your oldest record's year | `year` | A *range*, reads very differently from a count. |
| Total count | Records in the crate | row count | The simplest anchor number. |
| Top styles | Most-represented styles, a ranked top 3–5 | `styles[]` | Category ranking — names no owned item. |
| Top genres | Same as top styles but the broader genre bucket | `genres[]` | Distinct from styles; a coarser taste cut. |
| Top artists | Your most-collected artists, a top 3–5 | `artist` | **Terms note below** — names artists you own. |
| Top labels | Most-represented labels, a top 3–5 | `label` | **Terms note below** — a crate-digger signal. |
| Colored-wax % | Share of the crate on colored vinyl | `vinyl` (isColored) | The original percentage stat. |
| Colored-vs-black split | Two-segment bar of colored vs black | `vinyl` | A richer visual than the bare %. |
| Collection breadth | Count of distinct styles (or artists, or genres) | `styles[]`/`artist`/`genres[]` | "How eclectic" in one number. |
| Growth over time | Records added over time (sparkline), or "+N added this year" | `added` (ISO date) | The one stat with *motion/trend*. |
| Collecting-since | The year you started collecting | profile field (`TraxWaxOwner.collectingSince`) | **Owner-published profile field, NOT a computed aggregate** — label honestly (not "collecting for N years" unless it reads clearly). |

Optional bonus if a design wants it: **average / count of rated records** (`rating`) — sparse data, so treat as
a nice-to-have, not a backbone.

**One data-quality caveat — format breakdown (LP · 12″ · 7″):** Lane picked this for the palette, and it's a
great second chart, but `vinyl` is a **single free-text descriptor** per record (it doubles as the color-variant
field), not a structured format list — so bucketing into LP/12″/7″ will be **approximate and possibly sparse**.
Design may absolutely mock it up; engineering will validate coverage before a shipped card leans on it, and may
fall back to a coarser split if the data's too thin. Flagging so it isn't treated as a clean enum.

### The three-variant directive (what Design returns)
Three complete 1080×1080 cards, each:
- Drawing a **different subset** of the palette with a **different information hierarchy** — e.g. one "stat-wall"
  dense grid, one "single hero + supporting" minimal, one "chart-forward" with the histogram/sparkline as the
  centerpiece. Different enough that a user has a real choice, not a palette-swap.
- Complete and self-standing (each reads on its own), all in the TraxWax visual language, all carrying the
  **mandatory Discogs attribution** legibly and the TraxWax mark.
- Light + dark treatments if applicable.
- Plus: the **"share your DNA" entry point** (where/how the generate affordance lives — likely THE LEDGER or the
  account/profile), and a sense of the **variant chooser** — how a user browses the three and picks one.

### Downstream engineering note (NOT Design's job — flagged for the card build, task #166)
"User chooses which of the three inside TraxWax" adds three engineering pieces beyond rendering one card:
(1) a **variant-picker UI**, (2) a **persisted per-user choice** — a `profiles` column (needs a small migration
+ break-glass) or, lighter, `localStorage` if the choice needn't follow the user across devices (a Lane call at
build time), and (3) the canvas generator must support **all three layouts** from the same client-side data.
None of this blocks Design; it's the build scope that the three-variant decision implies, captured here so it's
not a surprise when the kit lands.

### Terms note (top artists / top labels)
Naming your most-collected artists/labels is **aggregate, own-crate, owner-generated, voluntary** — the same
basis on which "top styles" and "colored-wax %" were already cleared. It exposes **no Discogs-Restricted data**
(no prices, no community/marketplace stats) and is not a browsable list of holdings; it's a taste summary the
owner chooses to publish on their own card (the Spotify-Wrapped basis). Clean for the **own-only 5a card.** The
only place naming owned entities would need a fresh look is the **public 5b tier** (anonymous viewers), which is
already gated behind the Discogs letter — out of scope here. Attribution stays mandatory on every variant.
