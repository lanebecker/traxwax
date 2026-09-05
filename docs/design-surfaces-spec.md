> **FURTHER AS-OF NOTE:** beyond the v1.3.2 note below, the UI has changed substantially — the FILED UNDER
> style tray, FOR SALE + THE WANTLIST tabs, the header SHARE/LIGHTS/ACCOUNT icon trio, the ledger BY DECADE
> chart + Collection DNA band, and the account tabs (a live SHARING + FRIENDS and a standalone DANGER ZONE).
> The §5 "SOON" / "drawn, not built" notes on S13/S15/S16 are stale — those surfaces shipped in Wave 1. For
> current UI truth read `public/app.js` + `public/boot.ui.js` + `CHANGELOG.md`.
>
> **AS-BUILT NOTE (v1.3.2, 2026-08-29).** This spec was implemented into production in the
> v1.3.2 design pass. Two deviations from the handoff, both decided by Lane:
> 1. **The account surface routes at `/account` and `/account/discogs`** (spec §6's
>    recommended option), NOT `/app/account` with a reserved-word carve-out. There is no
>    `RESERVED_SEGMENTS` set; `public/_redirects` rewrites `/account` and `/account/*` to the
>    SPA shell, and `boot.js` branches on `segments[0] === 'account'`.
> 2. **Accessibility scope was held to this spec** plus one free win — `aria-live` on the
>    crate's result count. The detail-modal focus trap, roving grid focus, and `cover_image`
>    modal cover were **W0.4, since SHIPPED in v1.3.3** (see §7 checklist + the CHANGELOG).
>    `trapFocus` IS wired on the account page, as specified; the modal uses a re-render-safe
>    controller in `app.js` sharing `trapFocus`'s selector (rationale in `app.js` + W0.4 note).
>
> Everything else shipped as written. Screen→file map: `docs/design-screen-map.md`.
> Companion crate spec: `docs/design-crate-spec.md`.

# TraxWax — Surfaces Spec (Design Kit v2)

Companion to **Design Kit v1** (`kit/TRAXWAX-DESIGN-SPEC.md`), which specifies the crate.
This document specifies **everything else**: the landing page, the auth chrome, the nine
system states, the account surface, and the crate's own empty state.

Authoritative source: **`TraxWax Surfaces.dc.html`** — 20 surfaces, light and dark, opens
in any browser. Surfaces are referenced below by their ids (`S1`–`S20`).

Written against `lanebecker/traxwax@main`, 2026-08-29. Current shipped version v1.3.1.

---

## 1. What was wrong, in one paragraph

The crate was designed; nothing around it was. `boot.js`'s `notice()` rendered **nine
distinct states** as centred muted text in a bare 640px column — no wordmark, no frame, no
status, no hierarchy — and the account modal was three stacked bordered boxes with a `✕`
glyph, an `rgba` shadow instead of the offset-shadow token, and seven identical
placeholder-only inputs. None of it was wrong so much as unauthored. The tokens and the
type system were already right; only the assembly was missing.

## 2. Tokens — none added

**Every surface in this pass composes from the thirteen tokens already in `styles.css`.**
No new custom properties, no new hex values, one deliberate exception:

| Exception | Value | Why |
|---|---|---|
| Wordmark block | `#16171a` literal | Kit v1 §1 pins the block as black in **both** themes. In dark it gains a `1.5px solid var(--line)` border so it doesn't dissolve into `--panel`. |
| Avatar circle (no photo) | `background:#fff` | The house user glyph is a fixed-ink SVG shape; a `--skel` fill makes it invisible in dark. |

New token *usages* worth recording:

| Token | New role in this pass |
|---|---|
| `--muted` | The "not an error" top rule on S10, and the stopped progress fill on S8 |
| `--bar` | Progress-bar track; the landing three-up band |
| `--hair` | The border on an **empty** field (a filled field gets `--line`) |
| `--ink` / `--bg` | The landing position slab inverts them, so it reads correctly in both themes with no theme-specific rule |
| `--faint` | Disabled button text, field hints, the saved-at timestamp |

Contrast verified: `--muted` on `--ink` clears AA in both themes (the slab). `--faint` is
still forbidden on `--bar` — use `--muted`, per Kit v1 §2.

## 3. Type — unchanged, with role additions

Same four families. New roles only:

| Role | Family | Spec |
|---|---|---|
| State-card headline | Barlow Condensed 700 | 36px / `line-height:1` (30px ≤640px) |
| Status kicker | IBM Plex Mono 700 | 9.5px / `letter-spacing:.18em` / uppercase |
| Landing hero | Anton | `clamp(46px, 7.6vw, 96px)` / `line-height:.9` |
| Landing eyebrow | IBM Plex Mono 700 | 11px / `letter-spacing:.22em` |
| Landing three-up lede | Barlow Condensed 700 | 27px |
| Field label | IBM Plex Mono 700 | 9.5px / `.16em` / uppercase, **above** the input |
| Account section head | Barlow Condensed 700 | 32px |
| Nav item | IBM Plex Mono 700 | 11px / `.12em` |

Nothing below 9px. The 8.5px `SOON` chip is the single exception and carries no
information a sighted user needs — it's redundant with the disabled row state.

---

## 4. The shell system (S0)

### 4.1 Buttons — five variants, one rule

**THE RULE: accent is the affirmative color.** A destructive action starts *outlined* and
only earns the accent fill once armed. The product already had two-step confirmation (the
arming disconnect, the typed `DELETE`); now the color says which step you're on.

| Variant | Border | Background | Text | Shadow |
|---|---|---|---|---|
| `primary` | `1.5px var(--line)` | `var(--accent)` | `var(--on-accent)` | `3px 3px 0 var(--shadow)` |
| `secondary` | `1.5px var(--line)` | `var(--panel)` | `var(--ink)` | `3px 3px 0 var(--shadow)` |
| `quiet` | `1.5px var(--hair)` | `var(--panel)` | `var(--muted)` | none |
| `danger` | `1.5px var(--accent)` | `var(--panel)` | `var(--accent)` | none |
| `dangerArmed` | `1.5px var(--line)` | `var(--accent)` | `var(--on-accent)` | `3px 3px 0 var(--shadow)` |
| `disabled` | `1.5px var(--hair)` | `var(--bg)` | `var(--faint)` | none |

Shared: mono 11.5px/700, `letter-spacing:.12em`, uppercase, `padding:11px 18px`,
`border-radius:0`. `:active` on shadowed variants → `box-shadow:0 0 0` +
`transform:translate(3px,3px)` (the button presses into its own shadow).
Sizes: `sm` 10.5px/`9px 14px` · `lg` 12px/`14px 22px` with a 4px shadow.

**A disabled button must be genuinely `disabled`.** The old delete button was
`opacity:.45` and still clickable.

### 4.2 Fields

Labels are **mono caps above the input**, never placeholders. The old modal used
placeholder-as-label, which vanishes the moment the field is filled — with seven identical
inputs, a saved profile was unreadable.

```
label   mono 9.5px/700 · .16em · uppercase · var(--muted)
input   mono 12px · padding 10px 11px · radius 0 · width 100%
        border 1.5px  var(--line)   filled
                      var(--hair)   empty
                      var(--accent) error   ← label also turns accent
hint    mono 10px · var(--faint), or var(--accent) in the error state
```

### 4.3 Toggle — new component

Square knob, no radius. `46×24` track, `1.5px solid var(--line)`, `padding:2px`; knob
`17×17`. Off: `--bar` track, `--ink` knob, knob left. On: `--accent` track, `--on-accent`
knob, knob right. Always `role="switch"` + `aria-checked` + `aria-label`.

Used **three times by Wave 4** (crate / wantlist / for-sale consent). Built now so the
first consent UI isn't also the first toggle.

### 4.4 Progress bar — new component

`height:14px`, `1.5px solid var(--line)`, `padding:2px`, track `--bar`, fill `--accent`.
No animation, no radius, no transition. **Stopped state: fill goes `--muted` and stays on
screen at the position it reached.**

### 4.5 The state card — the centrepiece

One card for all nine states. `540px`, `max-width:100%`.

```
┌─ 5px accent rule (or --muted for non-errors) ─────────────┐
│  [TRAXWAX]  ← black block, rotate(-1.2deg), top:-17px left:24px
│                                    ▓▓▓▓  ← tape, top:-9px right:40px
│  KICKER · STATUS          mono 9.5px/700 .18em accent
│  Headline                 Barlow Condensed 36px/700
│  Body copy                Archivo 13px/1.65 --muted
│  ┌ problem slab ┐         border-left 4px accent, bg --bg   (errors only)
│  [ extra ]                progress bar / panel / form
│  [ actions ]              flex row, gap 12
│  ── hairline ──
│  footer                   mono 10.5px --faint (sign-out, <details>)
└───────────────────────────────────────────────────────────┘
panel: var(--panel) · border 1.5px var(--line) · shadow 6px 6px 0 var(--shadow)
page:  min-height 100vh · padding 96px 20px 60px · align-items flex-start
```

The wordmark hung over the corner plus one tape strip is what makes a bare system message
read as the same artifact as the crate. **The kicker is required on every state** — it's
the line that says where you are, and it's the slot any future state fills.

### 4.6 The empty-state block — a pattern, not a surface

Centred: 112px framed disc (74px `--bar` circle, 22px `--accent` label) → mono kicker →
Barlow 38px headline → Archivo 13.5px line (`max-width:48ch`) → one or two actions.

Built as a function with the signature `emptyState({kicker, headline, body, actions, icon})`.
**Wave 1's "no friends yet", Wave 2's "no matches" and Wave 3's empty overlap reuse it
verbatim.** Authoring a second empty state from scratch is the failure mode this exists to
prevent.

---

## 5. Surfaces

### S1 · Landing page → `public/index.html`

Was a one-screen door with a single CTA and no sign-in path. Now: bar → hero → three-up →
proof → position slab → attribution.

- **Wordmark fixed.** It was set in accent-red Anton type; Kit v1 §1 specifies a black
  block with white knockout, rotated `-1.2deg`. This was the one place the brand
  contradicted its own spec.
- **Two CTAs.** `CREATE AN ACCOUNT` → `/app?mode=signup`, `SIGN IN` → `/app`. There was
  previously no route to sign-up from the landing page at all.
- Copy of record: eyebrow `FOR PEOPLE WITH TOO MUCH VINYL`; hero `YOU OWN RECORDS, / NOW
  FIND THEM.` (second line accent); three-up ledes `Post-punk, on pink, from 2019` / `We
  speak variant` / `The damage, itemized`.
- **American spelling throughout** (`color`, not `colour`).
- Attribution footer uses the stacked left-aligned treatment (link, `<br>`, disclaimer) —
  the two-column version wrapped badly at every intermediate width.
- Twelve cover tiles at `rotate(1.4deg)`, flattening to a 6-across row ≤900px.

### S2 / S3 · Auth — "TraxWax chrome, stock card"

Our state card; Clerk's component inside it. Clerk is themed through `variables` plus a
short `elements` list (`card`, `header`, `footer` suppressed; fields, buttons, divider
restyled) and nothing more, so a Clerk update can't break the frame. Config in
`clerk.appearance.js`, including the dark-theme trade-off.

Sign-up carries `STEP 1 OF 3`; the counter continues through S4 (`2 OF 3`) and S5
(`3 OF 3`). Sign-in has no counter — it's one door.

### S4 · Onboarding

Real avatar affordance (house icon + `UPLOAD A PHOTO`) replacing a bare `<input type=file>`.
Labelled fields. `SAVE AND CONTINUE` primary, `SKIP FOR NOW` quiet. Vertical stack because
Wave 1's first-run sharing question belongs here as a fourth row.

### S5 / S6 · Connect Discogs

Adds a **reassurance panel** (`WHAT WE READ` / "Your collection, and nothing else. We never
write to your Discogs account, never touch the marketplace, and never see your password.").
This is the screen where someone hands over an OAuth token.

All thirteen `CONNECT_ERRORS` render through one treatment: **status → kicker, human
sentence → problem slab, retry stays a primary button.** Previously an unstyled red
sentence above the body copy.

### S7 / S8 · Import

`page N of M` was already computed and rendered as prose. Now a real bar plus a right-hand
record count. The background-enrichment caveat is stated once, quietly, instead of
surprising people when tracklists are missing.

On failure the bar **stays and goes grey**. Seeing how far it got is what makes "nothing is
lost" believable.

### S9 · Importing is paused

The only state whose sole action is destructive → `danger` (outlined) treatment, no
primary. Headline changed from "Import needs attention" (a category) to "Importing is
paused" (a consequence).

### S10 · No crate here — **PRIVACY-CRITICAL**

Grey top rule (`--muted`), grey kicker `PRIVATE SHELF`. Not an error; must not alarm
someone who mistyped a URL. Copy: *"This crate is private, or it doesn't exist. That's all
we'll say about it."* — the second sentence signals deliberate withholding, which reads as
more trustworthy than a bland 404.

**Constraint:** in Wave 1 this render serves both *no such user* and *exists but hasn't
shared with you*. If they differ by one character, the page confirms a username's existence
to a stranger. See §9.1.

### S11 · Something went sideways

Raw exception text was the body copy. It moves into a collapsed `<details>` labelled
`TECHNICAL DETAIL` — still there when debugging with a user, no longer the first thing they
read.

### S12 · Finishing the link

Sub-two-second state: no buttons, no sign-out. Five hard blocks filling. **No spinner** —
the kit doesn't have one and shouldn't gain one.

### S13–S16 · The account surface → a route

`/app/account` and `/app/account/discogs`, 1040px panel, red header band matching the
crate, 236px left nav.

**Why a page, not a modal:**

1. Wave 1 adds a friends list — *browsable content*, rows with avatars, gaining an activity
   pulse in Wave 3. That is a page.
2. Three consent toggles by Wave 4, each needing a sentence about what it exposes. A modal
   punishes explanatory copy; a page rewards it.
3. Accepting an invite needs somewhere to land. A URL beats "open the modal, scroll".

Nav: `PROFILE` · `SHARING` (SOON) · `FRIENDS` (SOON) · `DISCOGS` · rule · `DANGER ZONE`.
The nav header carries avatar + display name + Discogs handle — the only place in the
product that says which account you're operating on.

New in **S14**: a connection panel stating what's actually connected — handle, record
count, last sync — plus `RE-SYNC NOW`. The old modal's entire confirmation was "Connected
to Discogs as **lanebecker**" in 11px grey. Disconnect and delete sit in one column
separated by a hard black rule, escalating.

**S15 / S16 are drawn, not built.** Dashed borders, `SOON` chips, disabled nav rows. They
exist in the design doc to prove the shape holds; `boot.ui.js` ships the nav entries with
nothing behind them.

### S17 · An empty crate

A real state. Today a new user with an empty Discogs collection lands on `0 RESULTS ·
Nothing filed under that · CLEAR THE FILTERS` — advice that cannot help, since no filters
are set. The distinction, stated once:

```
records.length === 0                     → the crate is empty
records.length > 0 && shown.length === 0  → the filters excluded everything
```

Header keeps its zeroes. Do not hide the stat strip; it's the thing that fills in.

### S18 · Visiting someone else's crate — **space only, ▸ Wave 1**

Not for build. It exists so today's owner header is designed knowing the visitor variant is
coming. See §9.2.

### S19 · The badge slot — **reserve now, use in Wave 2**

See §9.3.

### S20 · Dark

Every surface verified on the dark token set. Wordmark stays black + gains a `--line`
border; shadows go pure black; accent drops to `#e01046`; avatar circle keeps `#fff`.

---

## 6. Routing

`/app/account` **collides with the `/app/<username>` grammar** and currently resolves to
"No crate here". Add a reserved-segment set checked before username parsing:

```js
const RESERVED_SEGMENTS = new Set(['account','settings','sign-in','sign-up','i','invite']);
```

Two consequences:

1. A Discogs user named `account` can no longer reach their crate. Vanishingly unlikely,
   but real. **Safer alternative: route the account page at `/account`, outside the `/app`
   prefix — no collision at all, one `_routes.json` entry.** Recommended.
2. `public/_routes.json` + the Pages fallback must serve `/app/account` from
   `public/app/index.html`. **Verify with a cold hard reload**, not client-side nav.

`i` / `invite` are reserved now for Wave 1's invite-accept path, so the grammar doesn't
need re-litigating then.

---

## 7. Accessibility

Requirements introduced by this pass:

- Every input has a real `<label for>`. Every toggle is `role="switch"` +
  `aria-checked` + `aria-label`.
- The account page's status line is `role="status" aria-live="polite"` — save results are
  announced.
- The problem slab is `role="alert"`.
- Decorative tape and the empty-state disc are `aria-hidden="true"`.
- `boot.ui.js` exports `trapFocus(container, onEscape)`, returning a teardown that restores
  focus to the previously focused element.
- Focus ring stays `2px solid var(--accent)` at 2px offset via the existing
  `*:focus-visible` rule.

Standing debts this pass made *more* visible (owed since v0.5.0) — **all SHIPPED in v1.3.3
(W0.4)**:

1. ~~Detail-modal focus trap + restore focus to the invoking card.~~ Shipped — plus a real
   `role="dialog"`/`aria-modal`/`aria-labelledby`, and the trap survives async re-renders.
2. ~~`aria-live` on the crate's result count.~~ Shipped v1.3.2.
3. ~~Roving arrow-key focus across the grid.~~ Shipped — single tab stop, arrows + Home/End,
   **Tab-into-cell** so the focused card's artist/title/color controls stay keyboard-reachable.
4. ~~Modal cover from `cover_image`, not the 150px `thumb`.~~ Already satisfied by `deco()`,
   verified.

---

## 8. Responsive

State cards: `max-width:100%`, shadow → 4px, padding → `32px 18px 22px`, headline → 30px.
Account page ≤820px: the nav becomes a horizontal strip above the content (the row-based
markup survives it — the other reason it's a page). ≤640px the form grid goes single
column. Landing: hero stacks ≤900px, tiles flatten to 6-across and lose their rotation, the
`SIGN IN` text link drops ≤640px so the bar can't wrap into the wordmark.

Tap targets stay ≥44px on all controls at mobile sizes.

---

## 9. ▸ Roadmap accommodations

**This section is the point of the package.** Each item is space deliberately left in a
design that ships now, so a later wave is a data change rather than a redesign. Written for
whoever picks this up months from now — including future sessions of Claude.

### 9.1 The merged not-found / not-friends render (S10) — Wave 1

Wave 1 makes `/app/<username>` resolve for friends of a consenting owner. The failure path
must be **byte-identical** for "no such user" and "exists but hasn't shared with you", or
the page becomes a username oracle for strangers.

`UI.COPY.noCrate` is written to be true of both cases. The rules: never add a per-case
detail, never add "ask them for an invite", never vary the kicker, never vary the rule
color. If a future requirement seems to need a distinction, it doesn't — it needs a
different surface.

### 9.2 The crate header's visitor variant (S18) — Wave 1

- The owner line (`Lane's shelf · filed by <word>`, the trailing word cycling per load from
  `FILED_BY` in `app.js` since v1.4.6) is the **profile slot**. It becomes
  avatar + display name + `COLLECTING SINCE`.
- The stat strip takes match numbers by **appending cells with a hairline divider**. So
  `EST. VALUE` simply drops out on someone else's shelf and nothing reflows. **This is why
  `EST. VALUE` must not be load-bearing in the header layout** — on a friend's crate it
  cannot legally appear.
- The grey bar beneath the red band is where visiting context lives (`READ-ONLY · NO
  RE-SYNC · NO ACCOUNT · NO PRICES`, back link). The red band's geometry stays identical in
  both modes.
- No `RE-SYNC`, no account button on someone else's crate.

### 9.3 The card badge slot (S19) — Wave 2

**Slot:** the cover's right edge, mirroring `JUST IN` on the left, stacking downward at
24px intervals. **Two badges maximum.**

**Grammar, decided at design time:**

| Fill | Means | Example |
|---|---|---|
| `--accent` | true about **you** | `ON YOUR WANTLIST` |
| `--ink` | true about **both** of you | `YOU OWN THIS` |
| `--panel` + ink rule | the action lives **elsewhere** | `FOR SALE` |

Wantlist and you-own-this are mutually exclusive by definition, so they can never both
consume the slot; `FOR SALE` stacks under either. That's what makes the cap of two safe.
Classes shipped in `styles.additions.css`; helpers in `app.additions.js`.

### 9.4 The price cell — Wave 1, and the most breakable detail here

Wave 1 suppresses price **server-side**: `live-stats` omits `price` when the record isn't
the viewer's own. Every record on a friend's crate therefore arrives `price == null`.

**The cell must always render.** The meta row is `align-items:flex-start` specifically so
the price holds position when the left line wraps; if the cell disappears, card heights
shift between your shelf and theirs and the grid visibly reflows on navigation.

| Case | Contents |
|---|---|
| Own record, price known | `$34` — accent, mono 11px/700 |
| Own record, price unknown | `—` — faint em-dash |
| Friend's record | `SEE ON DISCOGS →` — accent, mono 9.5px/700, links out |

The third form fills the cell *and* puts the price where it legally lives: on the Discogs
listing page, behind the link. Never a number, never an empty cell.

### 9.5 Per-dataset consent (S15) — Waves 1, 2, 4

One row per dataset, each with its own toggle and its own sentence about what it exposes.
Four rows fit without redesign. **A Wave-1 opt-in must never silently expand** to cover a
dataset that didn't exist yet — which is why it's four switches and not one dropdown.

### 9.6 The friend row (S16) — Waves 1, 3, 4

Three-line slot: name, one meta line, one action. Wave 3's activity pulse and Wave 4's
"selling 2 you want" **replace the meta line** — they don't change the row. Removal is
instant revocation in both directions, so the action stays a single word.

### 9.7 The account nav is the growth axis (S13)

`SHARING` absorbs Wave 4's for-sale settings rather than becoming a sixth nav item. The
copy line *"Nobody sees any of this yet — your crate is private"* is written to be **deleted
the day Wave 1 ships**.

### 9.8 The landing position slab (S1) — Wave 5

The full-bleed dark band above the footer is the public-crates slot: shared-crate cards, a
DNA-card preview, or an OG unfurl example drop in **without touching the hero**. The
three-up strip likewise extends to four cells (`FILE BY FRIEND`).

Note the Wave-5 terms gate: Discogs usernames are themselves Restricted, so public crate
URLs likely need TraxWax-chosen slugs rather than `/app/<discogs_username>`. Reserving
`i`/`invite` now (§6) keeps that door open.

### 9.9 The empty-state pattern (§4.6) — Waves 1–3

Three future empty states are already specified by building this one as a function. Do not
author a second from scratch.

---

## 10. Acceptance checklist

- [ ] No `notice()` call sites remain; `shell()` is deleted.
- [ ] Every state card has a kicker.
- [ ] All thirteen connect errors render in the problem slab, each with a sensible kicker.
- [ ] Import failure leaves a grey bar at the page it stopped on.
- [ ] `/app/account` and `/app/account/discogs` cold-load correctly.
- [ ] `/app/notauser` renders S10 with the **grey** rule.
- [ ] `/app/account` while signed out → sign-in card, no crash.
- [ ] Delete button is genuinely `disabled` until `DELETE` is typed.
- [ ] Disconnect arms before acting, and arming changes it to `dangerArmed`.
- [ ] Empty Discogs collection → S17, not `0 RESULTS`.
- [ ] Filter-empty still → the existing zero-results state.
- [ ] Landing page: both CTAs route correctly; attribution notices present.
- [ ] Dark theme on all 20 surfaces; no leaked hex but the wordmark's `#16171a`.
- [ ] 390px on all surfaces; no horizontal scroll.
- [ ] Tab order reaches every field on the account page and returns to the nav.
- [ ] No new CSS custom properties introduced.

---

## 11. Assets

| Asset | State | Action |
|---|---|---|
| `screenshots/crate-hero.png` | **MISSING** | Capture fresh. The repo's `01-crate-light.png` was taken before covers loaded — empty skeleton tiles, em-dash prices, `— EST.` in the header. Requirements: full-width, light theme, covers loaded, prices populated, at least one `JUST IN` badge visible, varied wax swatches in the visible rows. It is the largest piece of evidence on the landing page. |
| Fonts | present | Anton · Archivo · Barlow Condensed · IBM Plex Mono, already loaded on both entry points. `public/index.html` must load **Barlow Condensed** too — the current landing page omits it, and the three-up ledes need it. |
| Icons | none needed | The house user glyph is the only icon; it's inline SVG in `boot.ui.js`. No icon font, no sprite. |
| OG image | uses `crate-hero.png` | Fine until Wave 5 introduces per-crate OG rendering. |

---

## 12. File map

| Package file | Destination |
|---|---|
| `index.html` | `public/index.html` (replace) |
| `styles.additions.css` | append to `public/styles.css` |
| `boot.ui.js` | `public/boot.ui.js` (new) |
| `clerk.appearance.js` | merge into `boot.js`, or `public/boot.clerk.js` (new) |
| `app.additions.js` | merge into `public/app.js` |
| `boot.integration.md` | reference — the ordered edit list for `boot.js` |
| this file | suggest `docs/design-surfaces-spec.md` |
