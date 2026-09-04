# Wave 4 — "Selling, via Discogs" — DESIGN BRIEF (for Claude Design)

**Purpose.** This brief hands Claude Design every design decision that must be made to implement Wave 4 in
full. It is written to be self-contained — you do not need the codebase to answer it. Return a spec (styling,
copy, placement, states, data mapping) for each decision below; Lane brings it back to engineering to build.

**What Wave 4 is (social-roadmap §7).** Commerce-shaped **without touching commerce**. TraxWax never stores a
price, never processes a sale, never shows a number. It surfaces *that a record is for sale* and links out to
the live Discogs listing, where price/condition/checkout actually live. The payoff feature is **"Tommy is
selling 2 records you want"** — a friend's for-sale inventory ∩ your wantlist. The roadmap calls it "the whole
roadmap's best idea… three imports and one join."

---

## THE LOAD-BEARING CONSTRAINT (read first — it shapes every decision)

The Discogs API Terms split data in two. TraxWax may store **CC0 catalog data** (titles, tracklists, artists)
forever. It may **never persist Restricted data** — prices, marketplace listings-as-data, community stats, and
*which releases a user owns*. Wave 4's rule, therefore:

- **No price is ever stored or displayed in TraxWax.** Not on a badge, not in the ledger, nowhere. The price's
  only home is the Discogs listing page, reached by a link.
- The DB stores only `inventory_items(release_id, listing_id, status)` — enough to know *a record is listed*
  and to build the deep link. **No price column.**
- For-sale visibility on a friend's crate is **consent-gated** exactly like crate/wantlist visibility, and is
  purged on disconnect/account-deletion like all imported ownership data.

Every "should we show…" answer that would put a number, a total, or a price-derived figure into TraxWax is
answered NO by this constraint. Design within it.

---

## THE DESIGN SYSTEM AS IT SHIPS TODAY (build on this, not the older roadmap assumptions)

Two Wave-4 "reserved slots" the original spec named have MOVED since it was written (post-#28 any-pressing,
post-#47 friend-card redesign, post-account-restructure). Design against the CURRENT reality below.

**Tokens (light; dark values exist under `[data-theme]` — use the var names, never hardcode):**
`--bg #eceef0` · `--panel #ffffff` · `--bar #d8dade` · `--ink #16171a` · `--muted #54585f` · `--faint #666a72`
· `--line #16171a` · `--hair #d6d8dc` · `--accent #e8194b` · `--on-accent #fff` · `--shadow #16171a` ·
`--skel #e4e6e9`. Type: Anton (wordmark) · Barlow Condensed 600/700 (headlines, control titles) · IBM Plex
Mono 400–700 (labels, sublines, badges) · Archivo 400–800 (eyebrows, body).

**The cover badge slot (as-shipped, richer than the original 2-kind spec).** Badges sit on the cover's right
edge, stack downward at 24px (`tw-badge-1` top:8px, `tw-badge-2` top:32px), **cap of 2**. There are now **five
kinds**, not three:
| kind | style | text | axis |
|---|---|---|---|
| `you` | accent fill | ON YOUR WANTLIST | you want this exact release |
| `you-outline` | accent **outline** | A PRESSING YOU WANT | (any-pressing mode) you want another pressing |
| `both` | ink fill | YOU OWN THIS | you own this exact release |
| `both-outline` | ink **outline** | YOU OWN A PRESSING | (any-pressing mode) you own another pressing |
| `else` | panel + ink rule | **FOR SALE** (reserved, unused) | action lives elsewhere (Discogs) |

The engine already reserves a `FOR SALE` badge (`else` kind, `.tw-badge-else`) and a `forSale` Set hook —
Wave 4 populates it. The original "2 is safe because want/own are mutually exclusive" logic is now strained:
in any-pressing mode a record can be BOTH "a pressing you want" AND separately for-sale — and want-vs-own is
still exclusive, but the outline variants add cases. **This is decision B below.**

**The friend-crate card meta cell (post-#47).** The old "SEE ON DISCOGS →" price cell (old §9.4) is **retired** —
the Discogs link moved to the detail modal ("VIEW ON DISCOGS ↗"). On a friend's crate the card's meta cell now
holds the **viewer's own + WANT ⇄ ✕ REMOVE toggle** (or nothing if the viewer owns the record). On the OWN
crate it holds the price (own-only, Restricted). So Wave 4's "for sale" indicator can no longer live in the
"SEE ON DISCOGS" cell — that cell is gone. **This is decision C below.**

**The friend-crate header match sentence (post-#43/#47).** Renders: *"{OWNER} HAS {n} ALBUMS YOU WANT, AND YOU
HAVE {n} ALBUMS THEY WANT."* — owner name white, connective grey, the two counts are white underlined **links**
that filter the crate to that overlap. Private directions say "…IS PRIVATE" instead of a count. **Decision D**
asks where "selling N you want" joins this.

**The SHARING account tab (just rebuilt, v1.15.0 — this is NEW since the roadmap).** SHARING is its own nav tab
(PROFILE · FRIENDS · SHARING · DISCOGS · DANGER ZONE). It holds:
- **VISIBILITY** — ONE bordered box, caption "WHO CAN SEE YOUR SHELVES", two hairline-separated rows: **My
  crate** and **My wantlist**, each with a **PRIVATE ▸ FRIENDS segmented control** (not a toggle).
- **MATCHING** — a segmented EXACT PRESSING / ANY PRESSING control.
The whole tab is now a **segmented-control surface**. The roadmap assumed for-sale consent would be "a third
toggle row" — but toggles are gone; it would now be a third *segmented row*. **This is decision E below.**

**Sharing is now ON by default (v1.15.1).** New users default to `crate_visibility`/`wantlist_visibility` =
`friends`. Bear this in mind for the for-sale consent default (decision E).

**The friend list row.** name + one meta line + a one-word REMOVE action. Roadmap says both Wave 3's activity
pulse AND Wave 4's "selling N you want" want that one meta line. **Decision D covers the collision.**

---

## THE DECISIONS

For each: I give the context, the real options, and any constraint. Please return a concrete choice with exact
styling/copy/placement/states, in the same token + type vocabulary above.

### A. SELL THIS — the deep link on your OWN records
Zero-API: a link to `https://www.discogs.com/sell/post/{release_id}` (Discogs' prefilled "list this for sale"
form). Appears only on your own crate. The roadmap says it can even ship standalone before the rest of Wave 4.
- **A1. Placement.** The detail modal already has a "VIEW ON DISCOGS ↗" action. Is SELL THIS a second action
  beside it in the modal? A different treatment (it's a *create* action, not a view)? Does it also appear on
  the card face, or modal-only?
- **A2. Copy + style.** "SELL THIS" / "SELL ON DISCOGS ↗" / "LIST FOR SALE ↗"? Which button variant (it's an
  outbound action to a form — accent primary, or secondary)? New-tab affordance (↗).
- **A3. Conditionality.** Show on every own record always? Suppress (or change to "EDIT LISTING ↗") when the
  record is ALREADY in your inventory (you've already listed it)? What does an already-listed own record's
  action say?

### B. The FOR SALE badge — stacking + priority in the now-5-kind grammar  ★ the hard one
FOR SALE must appear on for-sale records: on your OWN crate (records you've listed) and, consent-gated, on a
FRIEND's crate (records they're selling). The `else`/`.tw-badge-else` kind + `forSale` Set already exist.
- **B1. The 2-badge cap under the new grammar.** A friend-crate record can simultaneously be: (a) on your
  wantlist (`you`) or a-pressing-you-want (`you-outline`), (b) you-own / own-a-pressing (`both`/`both-outline`),
  and (c) FOR SALE by the friend. Want and own are still mutually exclusive, so max two *relationship* badges +
  FOR SALE = the cap holds at 2 ONLY if FOR SALE never co-occurs with a second… but "a pressing you want" +
  "for sale" is exactly the payoff case and both want to show. **Define the priority order and the cap
  behavior:** which 2 badges win when 3 apply? Is "ON YOUR WANTLIST + FOR SALE" the sacred pair (the whole
  point of the wave)? Should FOR SALE ever be dropped, or should the cap rise to accommodate it on the friend
  crate specifically?
- **B2. FOR SALE styling + copy.** Confirm/refine the reserved `else` treatment (panel + ink rule). Copy:
  "FOR SALE" vs "SELLING" vs "FOR SALE ↗". Does the badge itself carry the ↗ / read as a link, or is the link
  behavior on the whole card/modal?
- **B3. Interaction.** Clicking FOR SALE → new tab to the Discogs listing (`/sell/item/{listing_id}` or the
  release marketplace page — Design picks the destination that best shows *this seller's* listing). On the OWN
  crate, does your own FOR SALE badge link to your listing (to manage it)?
- **B4. Own vs friend.** Same badge both places, or visually distinguished (your own listing vs a friend's)?

### C. Reconciling "for sale" with the friend-crate meta cell
The meta cell on a friend card is now the +WANT/✕REMOVE toggle (or empty if owned). "For sale" info therefore
can't reuse the old price-cell slot.
- **C1.** Is FOR SALE **only** a cover badge (decision B), leaving the meta cell as the +WANT toggle untouched?
  Or does the meta cell gain a small "FOR SALE ↗" affordance in addition to / instead of the badge?
- **C2.** The high-value combined card — a friend is selling a record you want — needs to make *both* facts
  legible at once: "you want this" AND "it's for sale, here's the link." Show how that single card reads
  (badge stack? badge + meta link? a combined treatment?), because this is the card the whole wave exists to
  produce.

### D. The compound — "TOMMY IS SELLING 2 RECORDS YOU WANT"
Friend's-for-sale ∩ your-wantlist. Roadmap says it lives on the crate header AND the friend list.
- **D1. Friend-crate header.** The header already has the two-clause match sentence (albums you want / they
  want). Does selling become a **third clause**, a **separate line** beneath it, or a distinct highlighted
  callout (it's more actionable than the match counts — it implies "go buy")? Is the count a **link/filter**
  like the existing two (filter the crate to "for sale ∩ my wants")? If it's a filter, it's a new match-filter
  chip — specify its label + removable-chip treatment to match the existing youWant/theyWant filters.
- **D2. Friend-list row meta line.** §9.6 says both Wave 3's activity pulse and this "selling N you want"
  replace the single meta line. **Resolve the collision:** if a friend both has a pulse ("added 3 this week")
  AND is selling records you want, which shows? Priority? Alternate? Can the row carry two? (Removal must stay
  one word — don't grow the row's action.)
- **D3. Zero state.** When a friend is selling nothing you want (the common case), the header/row simply omit
  the selling clause — confirm there's no empty "selling 0" noise.

### E. For-sale consent in the SHARING tab (now a segmented surface)
- **E1. Is for-sale a separate visibility axis at all?** Two models: (i) **its own control** — a third row in
  the VISIBILITY box ("My records for sale", PRIVATE ▸ FRIENDS segmented), independent of crate visibility; or
  (ii) **rides crate visibility** — a friend who can see your crate sees your for-sale badges on it, no extra
  switch (simpler, but couples the two). Which model? (The Terms don't force a separate switch; this is a
  product/UX call. Note: a friend can only see a for-sale badge on a crate they can already see, so an
  independent for-sale=FRIENDS while crate=PRIVATE would have nowhere to render — address that if you pick (i).)
- **E2. If it's a third row:** exact placement in the 1c box (a third hairline row under My crate / My
  wantlist?), title + subline copy ("My records for sale" / "The records you've listed on Discogs"?), and its
  default (sharing now defaults ON — should for-sale also default FRIENDS, or PRIVATE given it's commerce-y?).
- **E3.** Does the SHARING intro copy ("Who sees what, and how matches read") need to widen to mention selling?

### F. Own-crate for-sale management + the LEDGER
- **F1. A FOR SALE facet?** The crate has composable facet filters (style, color, year…). Add a "for sale"
  facet so you can filter your own crate to just your listings? On friend crates too (filter to their
  listings)?
- **F2. The LEDGER.** THE LEDGER is the owner's private analytics view. Wave 4 could add "N records listed" —
  but **no price/total** (Terms). Is a bare count ("14 LISTED") useful, or does listing-without-value add
  nothing worth the pixels? Design's call on whether the ledger gets a for-sale stat at all.

### G. Inventory import UX
Inventory import mirrors the collection/wantlist import pipeline (client-driven, own token). Mostly reuses
existing patterns, but:
- **G1.** Does inventory get its own re-sync affordance, or ride the existing RE-SYNC on the DISCOGS/account
  tab? Any status indicator ("inventory last synced …")?
- **G2.** First-run: when does inventory import happen — automatically alongside collection/wantlist, or only
  once the user opts into for-sale sharing? (Ties to decision E.)

### H. Empty + edge states (reuse the `emptyState` pattern where possible)
- **H1.** You have no listings (empty inventory) — does anything render, or is FOR SALE simply absent?
- **H2.** A for-sale record whose listing has since been delisted/sold (the `listing_id` 404s) — how does the
  badge/link degrade? (It can't know the sale completed without a fetch.)
- **H3.** A friend is selling but you can't see their crate (crate PRIVATE) — where, if anywhere, does
  "selling N you want" surface? (Ties to E1.)

### I. Legibility of "link, not price"
Because TraxWax shows no numbers, a user must understand a FOR SALE badge is a *link to where the price lives*,
not a missing price. Any affordance needed to make that obvious (the ↗, hover copy, a one-time hint)?

---

## CONSTRAINTS FOR YOUR SPEC
- **No new primitives if avoidable.** Reuse: the badge grammar (`.tw-badge-*`), the segmented control
  (`segBtn`/`visSegBtn` idiom), the `emptyState` pattern, `sectionLabel`, the match-sentence clause structure,
  the match-filter removable-chip. Flag it explicitly if a decision truly needs a new component.
- **The 2-badge cap is load-bearing** (cover geometry). If FOR SALE forces a rethink, say so and give the new
  rule precisely (decision B).
- **Mobile:** the friend card already goes 2-up at ≤599px (style category drops, meta stays one row) and the
  header sentence stacks at ≤640px. Any for-sale addition must survive both.
- **A11y:** badges carry their label into the card's accessible name; segmented controls are `aria-pressed`
  groups; links out are real `<a target="_blank" rel="noopener">`.
- **Data available to design against:** `inventory_items(release_id, listing_id, status)` — NO price. The
  compound is `inventory_items(friend) ⋈ wantlist_items(viewer)` on `release_id`, consent-gated.

## WHAT TO RETURN (per decision)
For each of A–I: the **choice**, the **exact styling** (tokens + type + sizes/padding), the **copy**
(verbatim strings), the **placement** (which surface/slot), the **states** (default / active / empty / error),
and the **data mapping** (what field drives what). Screenshots/mocks in the kit style are ideal, as with the
#28 and account-redesign kits. Where a decision is genuinely Lane's product call rather than a design call,
say so and give your recommendation.
