# TraxWax — design brief for Claude Design (#28 + open design items)

This is a briefing packet for a design partner who does **not** have the codebase. It gives the context to
answer a set of open design questions well. TraxWax is a web app that shows anyone's Discogs vinyl collection
as a browsable, filterable crate, behind a login, with a light social layer (friends can see each other's
crates + wantlists and see where their tastes overlap). No framework; a clean editorial visual language.

**Design language (shared vocabulary):** Anton wordmark; **Barlow Condensed** for headlines; **IBM Plex Mono**
for labels/eyebrows/body chrome; **Archivo** for prose. Core tokens: `--ink #16171a`, `--muted #54585f`,
`--faint #666a72`, `--accent #e8194b` (a hot pink-red), `--hair #d6d8dc`, and the crate header's black context
strip `#16171a`. A hard, printed-matter feel (offset shadows, tape decorations, mono labels in caps). The
guiding voice on someone else's crate is **"you're a guest on their shelf"**: third-person, no pricing, no
editing their lists.

---

# PART 1 — #28 · Optional master-level ("any pressing") matching

## How matching works today (exact-pressing)

Every record — in a collection or a wantlist — is a specific Discogs **release** (a `release_id`): one exact
pressing, e.g. *the 2016 UK 180g reissue* of an album, distinct from *the 1978 US original* or *a red-vinyl
variant*. The whole social/overlap layer keys on **`release_id` equality**:

- **Match sentence** (top of a friend's crate): *"TRAXY WAXY HAS 3 ALBUMS YOU WANT, AND YOU HAVE 1 ALBUM THEY
  WANT."* — the two counts are the size of the overlap between your lists and theirs, computed as identical
  `release_id`s.
- **Card badges:** a small cover strip reads **"ON YOUR WANTLIST"** (this exact release is on your wantlist) or
  **"YOU OWN THIS"** (this exact release is in your collection).
- **Match links / filters:** clicking a count filters their crate/wantlist down to just the overlapping
  releases.

**The problem #28 raises:** two collectors can want or own **the same album in different pressings** — and today
that is *not* a match. TraxWax's owner (Lane) is a specificity purist — he wants the *exact* pressing and likes
that the match is exact. But many users think in **albums**, not pressings: "you have that record I want"
means *any* pressing. So #28 is an **optional, opt-in "match any pressing" mode** — exact stays the default.

## The Discogs data model (why this matters)

Discogs is two-tiered: a **master** (`master_id`) is the album/work; a **release** (`release_id`) is one
specific pressing of that master. "Any-pressing" matching = compare **`master_id`s** instead of `release_id`s.

**Feasibility constraint Design should know:** the app's catalog currently stores **only `release_id`, never
`master_id`.** So this is **not a pure front-end toggle** — it requires a backend data addition (capture each
release's `master_id` from Discogs and backfill the catalog). Also, not every release has a master (true
one-offs, some bootlegs, some self-releases have no master) — those can only ever match exactly. This shapes
rollout (a data backfill) and one of the edge cases below.

## Open design questions for #28

1. **Where the control lives, and its shape.** A per-user setting seems right (it's a personal preference for
   how *you* read overlaps). The app already has an **account/settings page** with per-section visibility
   toggles (crate `private ⇄ friends`, wantlist `private ⇄ friends`). Should "match: **exact pressing ⇄ any
   pressing**" sit there as a matching binary? Is a two-state toggle enough, or is there a middle ground
   (e.g., "same album, but flag when it's a different pressing")? Default = **exact** (Lane's preference).

2. **Whose setting governs a shared view.** Overlap is inherently relational. Most natural: it's the
   **viewer's own** setting — it changes how *you* see *your* overlaps with anyone's crate, symmetrically for
   both directions of the sentence ("albums you want" and "albums they want"). Confirm that's the right mental
   model, or propose another.

3. **How an any-pressing match reads differently from an exact one.** When any-pressing mode is ON and you own
   a *different* pressing of an album on their wantlist:
   - Does the **badge** change wording — e.g. "YOU OWN THIS" (exact) vs. "YOU OWN A PRESSING" / "YOU OWN
     ANOTHER PRESSING" (master)? Or does one badge cover both and the distinction doesn't matter to the user?
   - Same question for **"ON YOUR WANTLIST"** when it's a master-level match.
   - Does the **match sentence** wording change at all? ("albums you want" already reads album-ish, but the
     *count* changes when the mode flips — should anything signal that these counts are now album-level?)
   - Is there a small, quiet **visual cue** (a marker, a different weight/color) that a given match is
     master-level rather than exact — for users who, like Lane, care about the difference — or is that
     over-fussy?

4. **Scope of the toggle.** It should govern the **match/overlap surfaces only** (sentence, badges, match
   filters). It should **not** change the write actions: adding to your own wantlist (`+ WANT`) always adds the
   *specific* release you're looking at (you can't "want an abstract album"). Confirm that separation reads
   cleanly, or flag where the two might blur (e.g., if you own pressing A and their wantlist has pressing B,
   and any-pressing mode says "YOU OWN A PRESSING" — is a `+ WANT` even offered there? Probably not, since you
   already own a version).

5. **The no-master edge.** A release with no Discogs master can only match exactly. In any-pressing mode, does
   it just quietly behave as exact (no special treatment), or does it warrant a micro-affordance? Recommend the
   least-fussy option.

**What a good answer looks like:** a recommended placement + default, a decision on badge/sentence wording for
the three match states (exact match, any-pressing match, no match), a call on whether to visually distinguish
master vs exact, and the scoping/edge rulings — enough that engineering can build without further design
round-trips.

---

# PART 2 — Discussed but not yet filed

Three surfaces we've flagged but not yet specced. Context + open questions for each.

## 2A · A friend's TIMELINE and THE LEDGER (the price problem)

**Context.** A crate has three views, switched by tabs: **THE CRATE** (a card grid), **THE TIMELINE** (records
grouped by the month you added them), and **THE LEDGER** (a stats dashboard). Two of the three lean heavily on
**price/value**, which is **Restricted Discogs data we never show on someone else's crate**:

- **THE TIMELINE** groups records by add-month; each month currently shows a count **and a value line**
  (playfully, *"$420 of regret"*). On a friend's crate, price is null, so that value line is empty/zero.
- **THE LEDGER** shows four big stats — **Records · ESTIMATED VALUE · On colored wax · Added this month** — plus
  **"Most-filed styles"** (a bar chart) and **"The expensive end"** (the five priciest records). On a friend's
  crate: ESTIMATED VALUE is blank, "The expensive end" already degrades to a placeholder line ("per-record
  prices return in a future update…"), and the priciest list is empty. The copy is also **owner-voiced /
  first-person** ("Counted honestly. Twice.", "$X of regret") — wrong for a guest.

So today, on a friend's crate, both non-crate views render half-empty and in the wrong voice.

**Open questions.**
1. **Do TIMELINE and THE LEDGER belong on a friend's crate at all?** Options: keep them (re-worked for no
   price), trim them to a subset, or hide them for friends entirely (with, or without, a "not shown on someone
   else's crate" note). Note that #43 (just shipped) established a **locked-tab** pattern — a tab can render an
   informational panel instead of content — so "present but re-pointed" is cheap to do consistently.
2. **If they stay, what replaces the price-dependent pieces?**
   - TIMELINE: drop the value line (count-per-month only), or re-point it to a **non-price** per-month stat?
   - LEDGER: swap **ESTIMATED VALUE** for a non-price headline stat (oldest year? most-filed decade/label? a
     genre spread?), and replace **"The expensive end"** with a non-price panel.
3. **Should a friend's LEDGER lean social instead of financial?** With value off the table, the interesting
   thing about *their* shelf, to *you*, is the **overlap** — could the LEDGER surface the match/shared-taste
   data (what you both own, where you diverge) as its centerpiece? Or is that overreach?
4. **Voice.** Re-cast any surviving copy to **third-person, guest voice** to match the rest of the friend view.

## 2B · The friend-crate header on mobile (≤640px)

**Context.** The friend header (shipped in v1.10.0) has, top to bottom: a **black context strip** carrying the
full **match sentence** + a `← BACK TO YOUR CRATE` link; a **red identity band** with the TraxWax wordmark, a
**46px avatar**, **"{Name}'s Crate"** (Barlow Condensed 26px), and a sub-line **"@handle · COLLECTING SINCE
{year}"**; a **stat pill** (`{n} IN CRATE · {n} COLORED · +{n} THIS MONTH`); and a **LIGHTS OUT** theme toggle.

The current mobile rules (≤640px) were tuned for the **owner** header, before these friend elements existed:
the header stacks to a single column, the last two pill cells (COLORED, THIS MONTH) are **hidden on mobile**,
and the avatar floats to the top-right. The **new friend elements have not been designed for narrow width.**

**Open questions.**
1. **The match sentence is a full sentence** and can get long (*"{NAME} HAS 12 ALBUMS YOU WANT, AND YOU HAVE 3
   ALBUMS THEY WANT."*). On a phone it will **wrap to 2–3 lines** inside the black strip. Is wrapping fine, or
   should it restructure on mobile (e.g., stack the two clauses as separate lines, or shorten)? The two counts
   are **tap targets** (links that filter) — they must stay comfortably tappable when wrapped (ties to #37).
2. **The identity band** (wordmark + avatar + name + handle/since) — how should it stack on a phone? Does the
   name truncate? Where do the avatar and the `← BACK` link go so both stay reachable one-thumb?
3. **The stat pill** currently trims to just "{n} IN CRATE" on mobile — right call for a friend, or should a
   different cell survive?
4. The friend header is **taller** than the owner header (extra sentence + identity block). On a small screen
   that pushes the actual crate far down — is the vertical budget acceptable, or should something collapse or
   move behind a tap?

## 2C · The friend card + cover strips on mobile

**Context.** The card (redesigned v1.8.5) has a cover, artist/title, a color-of-vinyl row, and a **meta footer**:
year · style on the left, and on the right either a price (your own crate) or the **+ WANT ⇄ ✕ REMOVE** control
(a friend's crate — writes *your* wantlist). Covers can also carry a small **strip badge**: "ON YOUR WANTLIST"
or "YOU OWN THIS". The grid steps down responsively **6 → 5 → 4 → 3 → 2 columns**, hitting **2 columns at
≤599px** — so on a phone the cards are quite narrow.

**Open questions.**
1. At **2-column** width, does the meta footer (year · style on the left, `+ WANT` / `✕ REMOVE` on the right)
   fit, or does it crowd/wrap? What's the graceful behavior when the style name is long? (Tap-target sizing
   here overlaps with **#37**'s sub-44px concern.)
2. The **cover strip badges** — legible and well-placed at narrow width, or do they crowd the art? Should they
   shrink, re-position, or drop on the smallest sizes?
3. The meta footer **bottom-aligns** within a grid row (so uneven card heights line up) — does that hold at
   2-column, or does anything break?

**What a good answer looks like (2A–2C):** for each, a clear call on keep/trim/hide + the specific copy or
layout treatment, in the existing tokens and the guest voice — enough for engineering to implement directly.

---

*Reference material available if useful: the shipped friend-crate header + visibility kits
(`traxwax-friend-header-redesign`, `traxwax-issue-43-redesign`) show the established patterns and copy voice
these should harmonize with.*
