# Wave 5b — Public crate tier — Claude Design brief

Status: DRAFT for the Claude Design pass. **Gated (build-wise) on the Discogs letter** (W0.2b, reworked for
truly-public + all three tabs, Lane sending) — but design can proceed in parallel; nothing *ships* until the
terms answer comes back (or a Lane-set timeout). Companions: `docs/wave-5-design-brief.md` (the §B/§C/§F
register + the SETTLED decisions), the 5a kit in `traxwax-wave5-design/` (the design language + tokens the
public tier inherits), `docs/design-surfaces-spec.md` (landing + token reference).

---

## 1. What 5b is (one paragraph)

The **public tier** lets a user opt a given tab — **crate, wantlist, and for-sale, each independently** — to
"public," so that **anyone with the link, including signed-out visitors,** can view it at **`/c/<slug>`**,
rendered in the TraxWax interface. It's conceptually the same as the public collection and seller pages on
discogs.com, but in our brutalist idiom. This brief covers the **design surfaces**. The mechanism behind them —
the slug scheme, the anonymous-read RPC, the no-auth boot path, and the server-side OG image rendering — is
engineering (see §6), and Design should assume it exists.

---

## 2. Locked constraints (the fixed frame — design *within* these)

1. **Per-tab public (Lane, 2026-09-05).** `crate_visibility`, `wantlist_visibility`, `forsale_visibility` each
   independently go to `'public'`. A public page shows **only the tabs the owner made public** — it may be 1, 2,
   or 3 of them, in any combination. Design the tab row for a **variable set** (a crate-only public page shows
   THE CRATE + its TIMELINE + LEDGER; no WANTLIST/for-sale tabs).
2. **Anonymous viewer = no Discogs token → catalog data only.** Covers, titles, years, tracklists, styles,
   colored-wax — yes. **Never** prices, marketplace pricing, or community / have / want stats (there's no
   viewer token to fetch Restricted data under). For-sale items appear as a **"for sale — view on Discogs"**
   pointer that links out to the listing — **never a price**.
3. **Identity is the slug, never the Discogs username.** The owner is shown by **display name + avatar + bio +
   collecting-since** (owner-published profile fields). The Discogs username is **never** rendered. The URL is
   **`/c/<slug>`**, not `/app/<discogs_username>`.
4. **Attribution is mandatory on every public surface** — the two notices the Discogs API Terms require (the
   do-follow "Data provided by Discogs" link + the affiliation disclaimer), same as the app and landing footers,
   **and on the OG card**.
5. **Reuse the app's visual language and views.** THE CRATE / THE TIMELINE / THE LEDGER, the card grid, the
   composable facet filters, and the tokens (Anton · Barlow Condensed · IBM Plex Mono · Archivo; the
   ink/accent/hair palette; hard offset shadows; radius 0 everywhere). A public crate must read as
   *unmistakably the same app* — minus the owner-only chrome. Light + dark both (the app is theme-aware).

---

## 3. The four surfaces to design

### 3a. Public-crate treatment — the anonymous view of the crate / wantlist / for-sale
Start from the **existing signed-in crate views** and **strip every owner-only affordance**, then design the
signed-out chrome around them.

- **Remove (owner-only):** RE-SYNC, the account nav / avatar menu, +WANT / remove-from-wantlist, for-sale
  management, the header **EST. value**, the **Collection DNA** "Share your DNA" band (own-only), and the
  friend-only match sentences / "N you want" callouts. No prices anywhere.
- **Keep:** the card grid + covers, the facet filters (style · colored-wax · color · search · single-control
  sort), THE TIMELINE, and THE LEDGER's **catalog-derived aggregates only** (records, styles, decades,
  colored-wax % — nothing price/value-derived). The **shareable filter URLs from 5a work here** too
  (`/c/<slug>?g=Rock&wax=1`), so the anon view must paint a pre-filtered first load.
- **Variable tab row:** show only the public tabs (see §2.1). Design how the tab row reads with 1, 2, or 3
  sections, and where a section is public vs not.
- **States to design:** (a) a healthy multi-tab public crate; (b) a public tab with **zero items**; (c) a slug
  that **doesn't resolve** → a "no crate here" 404 in the TraxWax idiom; (d) a crate that **was public and the
  owner just made private** → a graceful "this crate is private now" (not a raw error); (e) **mobile** (≤640px)
  — the app grid already goes 6→2 columns; confirm the public chrome stacks.

### 3b. Signed-out header / slug identity
The chrome that frames the anon `/c/<slug>` page.

- **Wordmark:** the TraxWax mark (now a link to the landing page, per the recent header-link change).
- **Owner identity block:** avatar + display name + bio + collecting-since. **No `@discogs_username`.** Frame it
  clearly as **"<name>'s crate on TraxWax."**
- **Top-of-funnel CTA:** an anon visitor is a prospect — a tasteful **"Start your own crate" / "Sign in"**
  affordance (candidate home: the header's right cluster, where the app's theme toggle sits). This is the one
  conversion moment on the page; make it inviting, not naggy.
- **No owner controls** (account, re-sync). Theme toggle may stay.
- A subtle **"you're viewing a shared crate"** cue so the visitor understands they're not signed in.
- Mobile stack (the app header stacks at ≤640px — the public header needs its own).

### 3c. OG unfurl card
The per-crate image that renders when a `/c/<slug>` link is pasted into Slack / iMessage / Discord / social.

- **Format:** landscape **1200×630** (standard OG), server-rendered per crate. Distinct from the **DNA card**
  (square 1080×1080, owner-generated, downloaded) — the OG card is for link previews.
- **Content:** the owner's **display name + "'s crate on TraxWax"**, a few **catalog-only aggregates** (record
  count, top styles, colored-wax %), the **TraxWax mark + Discogs attribution**, and ideally a hint of covers (a
  strip or mosaic). No prices, no username.
- **Degradation:** design for a crate with **few covers**, a **very long display name**, and a **wantlist-only
  or for-sale-only** public page (the card should still make sense).
- Note: the landing `crate-hero.jpg` already doubles as a **generic** OG image (`public/index.html` comment,
  line ~134); the per-crate OG is the upgrade — a real card, not a screenshot.

### 3d. Landing `.tw-land-slab` fill + the FILE BY FRIEND cell
The reserved full-bleed dark band above the landing footer — Wave 5's slot — currently a "No marketplace. No
feed." position statement (`public/index.html` ~145). Reuse the existing landing classes so it drops in without
touching the hero.

- **Slab fill:** the public-crates story — shared-crate example cards, a DNA-card preview, and/or an OG-unfurl
  example. Design's call which reads best. Classes: `.tw-land-slab`, `.tw-land-slab-h`, `.tw-land-slab-list`.
- **Fourth three-up cell:** extend the strip (currently FILE BY STYLE / FILE BY COLOR / FILE BY REGRET,
  `public/index.html` ~106) to a **fourth `FILE BY FRIEND` cell** by the same grid — kicker + lede + note in the
  established playful voice (the existing ledes: "Post-punk, on pink, from 2019", "We speak variant", "The
  damage, itemized"). Classes: `.tw-land-three`, `.tw-land-kick`, `.tw-land-lede`, `.tw-land-note`.

---

## 4. One more surface 5b needs (beyond the §F four — flagged for Lane)
Not in the four Lane quoted, but 5b can't function without it and it's a genuine design piece:

- **The expanded visibility selector** on the account **SHARING** tab. Today each of crate/wantlist/for-sale has
  a private ↔ friends control; 5b adds **`public`** as the top of each ladder (**private → friends → public**),
  as a **per-tab, three-way** selector. Design how the three read together, how "public" is distinguished
  (it's the one that exposes to signed-out strangers — it should feel weightier than "friends"), how the
  **slug** is shown/edited, and the copy that makes the stakes clear (per-tab, revocable, no prices, identified
  by display name not username). Reuses the existing segmented-control idiom on the SHARING tab. *(Include or
  split this out — Lane's call; noted here so Design has the full 5b picture.)*

---

## 5. What Design returns
- The **public-crate treatment**: all view states (healthy / empty tab / 404 / un-published), the variable tab
  set, the signed-out chrome, mobile.
- The **signed-out header + slug identity + the "start your own" / sign-in CTA.**
- The **OG unfurl card** (1200×630 layout + degradation cases).
- The **landing slab fill + the FILE BY FRIEND fourth cell** (using the existing landing classes).
- *(+ the expanded per-tab public selector, if kept in this pass.)*
- Light + dark treatments where applicable; the brutalist TraxWax language throughout.

## 6. NOT Design's — the engineering boundary (assume these exist)
- **Slug scheme** (§B1): vanity `/c/lanes-crate` vs opaque token vs display-name-seeded-with-suffix — an
  architecture call; Design assumes `/c/<slug>` resolves.
- **Anonymous-read RPC** `get_public_crate(slug)` (§B2), the **no-auth boot path** (§B3 — the app currently
  requires Clerk before rendering), **route wiring** (`/c/<slug>` in `_redirects`, CSP/shell implications, §B5),
  and the **server-side OG rendering** (Pages Function / Edge, §B4 — the site is static). All engineering.
- The three visibility columns already exist; 5b adds `'public'` to each enum + the anon grant surface —
  engineering.

## 7. Terms recap — the non-negotiables (restated for Design)
- **No prices, no marketplace pricing, no community/have/want stats** on any anon public surface — page, card,
  OG, or landing example.
- **Slug, never the Discogs username.**
- **Attribution on every public surface and the OG card.**
- **Aggregate / catalog-only** for the anonymous viewer.
