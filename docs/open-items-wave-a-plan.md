# Open items — Wave A plan (2A ledger/timeline social · 2B header mobile · 2C card 2-up · #37 FOUC)

Status: **EXECUTED — shipped as v1.12.0 (2026-09-03).** Verification-pass caught 5 (1 MAJOR: mobile avatar
modeled on the wrong element; + tap-target + missing release step) — all fixed pre-build; built; remediation-
audit Pass-1 CLEAN (byte-exact desktop-parity + no price leak + owner unchanged), no rework → converged.
**Frontend only — no migration, no Edge, no break-glass.** Builds on committed v1.11.0/#43. Design source of record:
`Design/traxwax-remaining-design-issues/traxwax-open-items/TRAXWAX-OPEN-ITEMS-SPEC.md` (+ screenshots).

Scope (Lane's calls): implement 2A, 2B, 2C, and the **#37 landing-FOUC** fix. **#28 is NOT here** (its own
Wave B). **#37 tap-targets stay as-is** (no change). **#10 skipped.** The any-pressing *badge/count variants*
(outlined strips) are #28's; Wave A ships **exact-mode only** (the default and only mode until #28), so
`_matchCounts` / the overlap surfaces here use exact `release_id` matching, which is all that exists today.

Files touched: `public/index.html`, `public/app/index.html`, `public/styles.css`, `public/app.js`.

---

## Task 1 — #37 · Kill the landing theme FOUC (pre-paint)

**Root cause (confirmed):** `index.html`'s head script computes the theme synchronously but **applies it on
`DOMContentLoaded`** (after first paint), so a dark-preference visitor sees a light flash. `app/index.html`
has **no** pre-paint theme script at all (app.js's `initTheme` runs post-load). Fix: apply the theme
**synchronously, before the body content paints**, on both entry points. TraxWax themes off `body[data-theme]`
(app.js `setTheme` sets `document.body.dataset.theme`), and `body` doesn't exist in `<head>` — so the correct
spot is a blocking inline script as the **first child of `<body>`** (runs before the body's visible content is
laid out/painted). Inline scripts are CSP-allowed (`script-src` includes `'unsafe-inline'`; the head already
has inline scripts).

### 1a — `public/index.html`: move theme application to a synchronous body-top script
FIND (the head IIFE's theme lines):
```js
    /* Theme before first paint — mirrors initTheme() in app.js. Without this the landing
       page renders light-only regardless of preference, then the crate snaps to dark. */
    var t; try { t = localStorage.getItem('tw_theme'); } catch(e){}
    if(!t) t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    document.addEventListener('DOMContentLoaded', function(){ document.body.dataset.theme = t; });
```
REPLACE (drop the theme block from the head IIFE — the redirect logic around it stays; theme moves to body-top):
```js
    /* Theme is applied pre-paint by the body-top script (see <body>) — mirrors initTheme() in app.js. */
```
Then add, as the **first line inside `<body>`** (immediately after `<body>`):
```html
<script>/* #37: apply theme BEFORE the body paints — kills the light→dark flash for dark-preference visitors */
(function(){try{var t=localStorage.getItem('tw_theme')||((window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light');document.body.dataset.theme=t;}catch(e){}})();</script>
```

### 1b — `public/app/index.html`: add the same pre-paint script
Add the identical `<script>` block as the **first child of `<body>`** in `public/app/index.html`. (app.js's
`initTheme()` still runs later and is idempotent — it re-reads the same `tw_theme` and sets the same value, so
there's no conflict; this just removes the pre-app-load flash on the crate shell too.)

### Verify
- Grep: `grep -n "DOMContentLoaded" index.html` → the theme DOMContentLoaded listener is GONE.
- `grep -n "body.dataset.theme" index.html app/index.html` → each has the body-top synchronous set.
- Manual: with `localStorage.tw_theme='dark'` (or OS dark), hard-reload `/` and `/app` — no light flash before
  the dark paint.

---

## Task 2 — 2C · The friend card at 2-up (≤599px)

Design 2C: at 2 columns keep the meta footer **one row** — drop the **style category** (keep the year + the
compact `+ WANT`/`✕ REMOVE` control unchanged), and **shrink the cover badges one notch**. Bottom-align is
untouched. Style still lives on the vinyl-color row + the modal, so nothing is lost.

### 2a — `public/app.js`: wrap the style category so CSS can drop it
FIND (the card meta year·style span, ~line 401):
```js
        <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; line-height:1.35; color:var(--faint); text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0">${esc(r.year)} · ${esc(r.style1)}</span>
```
REPLACE (wrap the `· style1` in a `.tw-card-style` span; year stays bare):
```js
        <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; line-height:1.35; color:var(--faint); text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0">${esc(r.year)}<span class="tw-card-style"> · ${esc(r.style1)}</span></span>
```

### 2b — `public/styles.css`: drop the category + shrink badges at ≤599
Add to the mobile rules. The grid hits 2 columns at `≤599px`, so gate on that (not 640) so the category
survives at 3-up. Append inside a `@media (max-width:599px)` block (create one; there's already a `599px` grid
rule near the top — add a dedicated block after the mobile group, or extend the existing `599px` rule area):
```css
@media (max-width:599px){
  .tw-card-style { display:none; }                 /* 2C: drop the style category; year + control stay one row */
  .tw-badge { font-size:7.5px; padding:2px 5px; }  /* 2C: shrink cover badges one notch (keep right-edge placement) */
}
```
(The `.tw-badge` base keeps `right:-7px; transform:rotate(2deg)` — placement unchanged, only type/pad shrink.
`JUST IN` sits on the left edge, so the two never collide.)

### Verify
- `grep -n "tw-card-style" app.js styles.css` → span in app.js + the `display:none` rule.
- Manual at 390px: friend card footer is one row (year + `+ WANT`/`✕ REMOVE`); badges legible, not crowding the
  art; footers still bottom-aligned across a row.

---

## Task 3 — 2B · The friend header on a phone (≤640px)

Design 2B: the **match sentence stacks into two full-width tappable rows** (each a ≥44px target, hairline
divider), **`← BACK TO YOUR CRATE` on its own row on top**; identity = wordmark → name → handle with the avatar
pinned top-right; the pill trims to `{n} IN CRATE` (COLORED/THIS MONTH already `.tw-hide-mobile`). Private/zero
clauses stay plain text (no link), per #43.

This is the intricate one: the friend strip currently emits **one flowing sentence string** (a 4-branch build
from #43). We refactor it to expose the two **clauses** so desktop flows and mobile stacks — and the refactor
**collapses #43's 4-branch into one expression** (identical desktop output; verify below).

### 3a — `public/app.js`: rebuild the friend strip (clauses + desktop-flow + mobile-rows)
FIND the current friend strip IIFE (the `${!IS_OWN()?(()=>{ … })():''}` block that builds `let sentence` via
the four `if/else` branches and returns the `tw-friend-strip` div). Its shape:
```js
    ${!IS_OWN()?(()=>{
      const o=window.TraxWaxOwner||{};
      const owner=(o.displayName||o.ownerUsername||'A friend');
      const mc=_matchCounts();
      const nameSpan = `<span style="color:#fff">${esc(owner.toUpperCase())}</span>`;
      let sentence;
      if (mc.youWant !== null && mc.theyWant !== null){                    // both shared
        sentence = `${nameSpan} HAS ` + _matchPart(mc.youWant,'YOU WANT','matchYouWant')
                 + ', AND YOU HAVE ' + _matchPart(mc.theyWant,'THEY WANT','matchTheyWant') + '.';
      } else if (mc.youWant !== null){                                     // wantlist private
        sentence = `${nameSpan} HAS ` + _matchPart(mc.youWant,'YOU WANT','matchYouWant')
                 + '. THEIR WANTLIST IS PRIVATE.';
      } else if (mc.theyWant !== null){                                    // crate private
        sentence = `${nameSpan}’S CRATE IS PRIVATE. YOU HAVE `
                 + _matchPart(mc.theyWant,'THEY WANT','matchTheyWant') + '.';
      } else {                                                             // both private — unreachable (→ S16); belt-and-suspenders
        sentence = `${nameSpan}’S CRATE IS PRIVATE. THEIR WANTLIST IS PRIVATE.`;
      }
      return `<div class="tw-friend-strip" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 24px; background:#16171a; color:rgba(255,255,255,.62); font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.16em; text-transform:uppercase">
      <span>${sentence}</span>
      <a href="/app" style="color:#fff; text-decoration:underline; white-space:nowrap">← Back to your crate</a>
    </div>`;})():''}
```
REPLACE:
```js
    ${!IS_OWN()?(()=>{
      const o=window.TraxWaxOwner||{};
      const owner=(o.displayName||o.ownerUsername||'A friend');
      const mc=_matchCounts();
      const nameSpan = `<span style="color:#fff">${esc(owner.toUpperCase())}</span>`;
      const bothShared = (mc.youWant !== null && mc.theyWant !== null);
      // Two standalone clauses (each reads alone → each can be its own mobile row). Private → plain, no link (#43).
      const c1 = (mc.youWant !== null)
        ? `${nameSpan} HAS ` + _matchPart(mc.youWant,'YOU WANT','matchYouWant')
        : `${nameSpan}’S CRATE IS PRIVATE`;
      const c2 = (mc.theyWant !== null)
        ? 'YOU HAVE ' + _matchPart(mc.theyWant,'THEY WANT','matchTheyWant')
        : 'THEIR WANTLIST IS PRIVATE';
      // Desktop: one flowing sentence — ", AND " joins two shared clauses; ". " otherwise. (Same output as the
      // #43 4-branch: both-shared "…YOU WANT, AND YOU HAVE …"; one-private "… . …".)
      const desktop = `${c1}${bothShared ? ', AND ' : '. '}${c2}.`;
      // Mobile: two rows; the "AND" connective rides row 2 only when both are shared (per the kit render).
      const row2 = `${bothShared ? 'AND ' : ''}${c2}`;
      return `<div class="tw-friend-strip" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 24px; background:#16171a; color:rgba(255,255,255,.62); font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.16em; text-transform:uppercase">
      <span class="tw-fs-desktop">${desktop}</span>
      <div class="tw-fs-mobile">
        <div class="tw-fs-row">${c1}</div>
        <div class="tw-fs-row">${row2}</div>
      </div>
      <a class="tw-fs-back" href="/app" style="color:#fff; text-decoration:underline; white-space:nowrap">← Back to your crate</a>
    </div>`;})():''}
```
(Source order is [desktop, mobile, back] so desktop shows sentence-left / back-right via `space-between`; mobile
uses `order` to lift BACK to the top — see CSS. The two count links appear in both the desktop span and the
mobile rows; whichever set is `display:none` isn't in the a11y tree or clickable, so no double-announce.)

### 3b — `public/styles.css`: desktop-vs-mobile toggle + stacked rows
Base (outside any media query — desktop default): the mobile block is hidden.
```css
.tw-fs-mobile { display:none; }
```
Inside the existing `@media (max-width:640px)` block (alongside the other `.tw-header` rules), add:
```css
  .tw-friend-strip { flex-direction:column !important; align-items:stretch !important; gap:0 !important; padding:0 !important; }
  .tw-fs-desktop { display:none; }
  .tw-fs-mobile { display:block; }
  .tw-fs-back { order:-1; padding:11px 14px; }                 /* BACK on top */
  .tw-fs-row { display:flex; align-items:center; min-height:44px; padding:10px 14px; border-top:1px solid rgba(255,255,255,.14); }
  .tw-fs-row a { display:inline-flex; align-items:center; min-height:44px; }   /* Md1: the count LINK itself fills row height → a real ≥44px tap target, not just the text baseline */
```
(Each `.tw-fs-row` is ≥44px with a hairline top-border for the divider between BACK / clause 1 / clause 2, and
the inner count `<a>` is itself made 44px tall so the tappable area — not just the underlined text — meets the
target.)

### 3c — identity + pill on mobile (Verification M1 correction)
**Important:** `.tw-avatar` is the **owner-only** account chip (`app.js`, gated `DB_MODE() && IS_OWN()`) — it is
NOT rendered on a friend crate, so the existing mobile `.tw-avatar` rule does nothing here. The **friend**
avatar is an unclassed 46px `<span>` sitting **inside** the identity block, to the **left** of the name (from
#47's `tw-headL` friend branch). To deliver Design 2B's "wordmark → name → handle, avatar pinned top-right" we
must (a) class both elements and (b) on mobile, pin the friend avatar top-right and stack `.tw-headL`.

**app.js edits** (in the #47 friend identity block inside `tw-headL`):
- Add `class="tw-friend-avatar"` to the **46px avatar span** — FIND `<span style="width:46px; height:46px;`
  and add the class attribute: `<span class="tw-friend-avatar" style="width:46px; height:46px;` (that
  `width:46px; height:46px;` opener is unique to the friend avatar).
- Add `class="tw-friend-name"` to the **name span** — FIND the name span whose text is `${esc(name)}’s Crate`
  (Barlow Condensed 26px) and add `class="tw-friend-name"` to it.

**CSS — inside the `@media (max-width:640px)` block** (the friend header is inside `.tw-header`, which is
`position:relative`, so an absolute avatar anchors to it):
```css
  .tw-headL { flex-direction:column !important; align-items:flex-start !important; gap:8px; padding-right:56px; }  /* stack wordmark→name/handle; clear the pinned avatar */
  .tw-friend-avatar { position:absolute; top:12px; right:14px; }   /* pin top-right on mobile (was inline-left) */
  .tw-friend-name { text-wrap:balance; }                            /* long names balance across ≤2 lines, don't clip mid-word */
```
(Removes the earlier wrong `.tw-avatar`/`.tw-headL > div { padding-right }` model and the empty rule. The
COLORED/THIS-MONTH pill cells already drop via `.tw-hide-mobile`, leaving `{n} IN CRATE`; LIGHTS OUT stays.
Handle sub-line stays `@handle · COLLECTING SINCE {year}`; the kit's "SINCE" compression is optional polish —
omit unless it overflows at 360px in testing.)

### Verify
- Refactor parity (desktop): for each state (both-shared / wantlist-private / crate-private), the `desktop`
  string equals the pre-refactor #43 sentence exactly. Confirm by reasoning + a jsdom render at desktop width.
- `node --check app.js`. Manual at 390px: BACK on its own top row; each clause its own ≥44px row with a
  divider; both count links tappable; name balances (doesn't clip mid-word) and clears the avatar; pill shows
  just `IN CRATE`.

---

## Task 4 — 2A · A friend's TIMELINE & THE LEDGER (de-priced, social)

Design 2A: **both views stay** (not private → no locked-tab). Drop every price-dependent element on a friend's
crate, recast copy to guest voice, and make **overlap** the ledger's centerpiece. **Owner crate is unchanged.**
Overlap is computed in **exact mode** (Wave A); #28 later upgrades the same surfaces to any-pressing.

### 4a — TIMELINE: drop the value line for a friend (`public/app.js`, render `showTimeline` block)
FIND (the value-line span in the timeline date column):
```js
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--faint)">${grp.valueLabel}</span>
```
REPLACE (own keeps the "$X of regret" line; a friend gets count-only):
```js
          ${IS_OWN() ? `<span style="font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--faint)">${grp.valueLabel}</span>` : ''}
```
(Design's optional per-month dominant style is explicitly omittable — count-only is acceptable; not built.)

### 4b — `_matchCounts` already exists (#43) — add a shared-list helper
`_matchCounts()` (from #43) returns `{youWant, theyWant}` (null = private). For the ledger we need the actual
overlap **records** with their badge. Add a module-level helper near `_matchCounts` (app.js):
```js
// 2A: the shared-taste overlap records for a friend's LEDGER (exact mode; #28 adds any-pressing variants later).
//  (a) THEIR crate ∩ YOUR wants  → badge "ON YOUR WANTLIST" (accent)   [from RECORDS + viewerWants]
//  (b) THEIR wantlist ∩ YOUR haves → badge "YOU OWN THIS"   (ink)      [from WANTLIST_RECORDS + viewerHas]
// (b) needs the friend's wantlist DISPLAY rows; the ledger triggers that load (Task 4e). Until then (b) is empty.
function _overlapRecords(){
  const ctx = window.__twMatchCtx; if (!ctx) return [];
  const out = [];
  if (ctx.viewerWants) for (const r of (RECORDS||[])) if (ctx.viewerWants.has(r.id)) out.push({ rec:r, kind:'you' });   // ON YOUR WANTLIST
  if (ctx.viewerHas && Array.isArray(WANTLIST_RECORDS))
    for (const r of WANTLIST_RECORDS) if (ctx.viewerHas.has(r.id)) out.push({ rec:r, kind:'both' });                    // YOU OWN THIS
  return out;
}
```
(`kind:'you'`/`'both'` reuse the existing badge grammar: `.tw-badge-you` accent, `.tw-badge-both` ink.)

### 4c — `computeVals` bigStats: friend variant (`ESTIMATED VALUE → IN COMMON`, guest notes)
FIND the `bigStats:[ … ]` array in `computeVals`:
```js
    bigStats:[
      {label:'Records', value:all.length.toLocaleString('en-US'), note:'Counted honestly. Twice.', color:'var(--ink)'},
      {label:'Estimated value', value:state.headerValue||valueLabel(total), note:priced.length?'Median of Discogs lows.':'Live Discogs estimate.', color:'var(--accent)'},
      {label:'On colored wax', value:coloredCount+'', note:Math.round((coloredCount/all.length)*100)+'% of the shelf.', color:'var(--ink)'},
      {label:'Added this month', value:newCount+'', note:'A restrained month, relatively.', color:'var(--ink)'},
    ],
```
REPLACE (branch on `IS_OWN()`; friend swaps the value slot for `IN COMMON` and recasts every note to guest
voice — kit §2A):
```js
    bigStats: IS_OWN() ? [
      {label:'Records', value:all.length.toLocaleString('en-US'), note:'Counted honestly. Twice.', color:'var(--ink)'},
      {label:'Estimated value', value:state.headerValue||valueLabel(total), note:priced.length?'Median of Discogs lows.':'Live Discogs estimate.', color:'var(--accent)'},
      {label:'On colored wax', value:coloredCount+'', note:Math.round((coloredCount/all.length)*100)+'% of the shelf.', color:'var(--ink)'},
      {label:'Added this month', value:newCount+'', note:'A restrained month, relatively.', color:'var(--ink)'},
    ] : (()=>{ const _mc=_matchCounts(); const _ic=(_mc.youWant||0)+(_mc.theyWant||0); return [
      {label:'Records', value:all.length.toLocaleString('en-US'), note:'In their crate.', color:'var(--ink)'},
      {label:'In common', value:_ic.toLocaleString('en-US'), note:'Where your shelves meet.', color:'var(--accent)'},
      {label:'On colored wax', value:coloredCount+'', note:Math.round((coloredCount/all.length)*100)+'% of their shelf.', color:'var(--ink)'},
      {label:'Added this month', value:newCount+'', note:'Their latest finds.', color:'var(--ink)'},
    ]; })(),
```

### 4d — render LEDGER: swap "The expensive end" → "WHERE YOU OVERLAP" for a friend
In the `showStats` block, the SECOND panel is "The expensive end" (the priciest list). FIND its header +
list open:
```js
        <div style="padding:22px 24px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">The expensive end</span>
          <div style="display:flex; flex-direction:column; margin-top:14px">${
            v.priciest.length ? v.priciest.map(r=>`
```
Change ONLY the panel's content selection so a friend gets the overlap panel. The cleanest surgical form: make
the whole second `<div style="padding:22px 24px">…</div>` panel conditional. REPLACE the panel opening above
with a branch that, for a friend, renders `overlapPanelHtml()` and, for the owner, renders the existing
"expensive end" markup. Concretely, wrap:
```js
        ${IS_OWN() ? `<div style="padding:22px 24px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">The expensive end</span>
          <div style="display:flex; flex-direction:column; margin-top:14px">${
            v.priciest.length ? v.priciest.map(r=>`
```
…and at the **matching close** of that panel (the `</div></div>` that ends the expensive-end panel, just before
the `.tw-ledger-panels` closing `</div>`) append the friend branch:
```js
          }</div>
        </div>` : overlapPanelHtml()}
```
> Executor note: this edit spans a large template region. Do it as TWO precise edits — (1) prepend
> `${IS_OWN() ? ` before `<div style="padding:22px 24px">` at the expensive-end panel open, and (2) replace the
> panel's closing `</div>\n        </div>` (the expensive-end wrapper close) with `</div>\n        </div>` + ` : overlapPanelHtml()}`.
> Read the exact closing lines first to anchor (2). The "Most-filed styles" panel (first panel) is unchanged.

Add the builder `overlapPanelHtml()` near `lockedPanelHtml` (reuses the priciest-row geometry + the badge
grammar):
```js
/* 2A: the friend LEDGER's second panel — the records you both care about (exact mode; #28 adds any-pressing). */
function overlapPanelHtml(){
  const rows = _overlapRecords();
  const badge = (kind) => kind==='both'
    ? '<span style="font-family:\'IBM Plex Mono\',monospace; font-size:9px; font-weight:800; letter-spacing:.1em; padding:3px 6px; background:var(--ink); color:var(--bg)">YOU OWN THIS</span>'
    : '<span style="font-family:\'IBM Plex Mono\',monospace; font-size:9px; font-weight:800; letter-spacing:.1em; padding:3px 6px; background:var(--accent); color:var(--on-accent)">ON YOUR WANTLIST</span>';
  const list = rows.length ? rows.map(({rec,kind})=>{ const r=deco(rec); return `
            <button data-act="open" data-arg="${r.id}" style="display:flex; align-items:center; gap:12px; padding:8px 0; border:0; border-bottom:1px solid var(--hair); background:transparent; text-align:left; width:100%">
              <div role="img" aria-label="${esc(r.coverAlt)}" style="width:38px; height:38px; flex:none; border:1px solid var(--line); background:var(--skel); background-image:${r.coverBg}; background-size:cover; background-position:center">${r.coverPlaceholder}</div>
              <span style="flex:1; min-width:0; display:flex; flex-direction:column; gap:2px">
                <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(r.artist)}</span>
                <span style="font-family:'Barlow Condensed',sans-serif; font-size:17px; font-weight:600; line-height:1.05">${esc(r.title)}</span>
              </span>
              ${badge(kind)}
            </button>`; }).join('')
    : `<span style="font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--faint); line-height:1.6">No shared records yet.</span>`;
  return `<div style="padding:22px 24px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">Where you overlap</span>
          <div style="display:flex; flex-direction:column; margin-top:14px">${list}</div>
        </div>`;
}
```
(Any-pressing outlined variants — "YOU OWN A PRESSING" / "A PRESSING YOU WANT" — are #28; not built here.)

### 4e — load the friend wantlist DISPLAY rows for the ledger's (b) half
The ledger's overlap (b) reads `WANTLIST_RECORDS` (display), which today loads only on the wantlist tab. Extend
the lazy-load trigger so a **friend's ledger** also loads it. In `case 'view'` (app.js) and the bootCrate
hash-restore, the current condition is `arg==='wantlist'`. Generalize to also fire for a friend's ledger.
FIND (case 'view'):
```js
      if (arg==='wantlist' && WANTLIST_RECORDS===null && window.TraxWaxWantlistData) {
```
REPLACE:
```js
      if ((arg==='wantlist' || (arg==='ledger' && !IS_OWN())) && WANTLIST_RECORDS===null && window.TraxWaxWantlistData) {
```
And the mirror in bootCrate (the hash-restore wantlist load, currently `if (state.view==='wantlist' && WANTLIST_RECORDS===null …)`):
```js
      if ((state.view==='wantlist' || (state.view==='ledger' && !IS_OWN())) && WANTLIST_RECORDS===null && window.TraxWaxWantlistData) {
```
(Both keep the existing `.then((rows)=>{ WANTLIST_RECORDS=rows; render(); })` — so the ledger paints IN COMMON +
the (a) overlap immediately, then the (b) half fills when the wantlist rows arrive. IN COMMON's *count* is exact
from the start: `_matchCounts.theyWant` uses `__twOwnerWantIds` (ids, awaited at boot), independent of the
display rows.)

### Verify
- `node --check app.js`. Friend ledger: 4 stats = `RECORDS · IN COMMON · ON COLORED WAX · ADDED THIS MONTH`
  with guest notes; second panel = "WHERE YOU OVERLAP" listing the shared records with the right badges (or
  "No shared records yet."); styles chart unchanged. Friend timeline: no value line. **Owner** ledger/timeline
  byte-unchanged.

---

## Release (standard closeout, after the audit)
Frontend-only, no break-glass. Bump `VERSION` → **1.12.0**, add a `CHANGELOG.md` entry (2A social ledger/
timeline · 2B mobile header · 2C mobile card · #37 landing FOUC), append `log.md`, mark this plan EXECUTED, and
hand Lane the one-`&&`-chain git push. The commit **`Closes #37`** — its four sub-items are now all resolved:
search label (v1.8.3), modal-inert (v1.9.1), sub-44px tap targets (Lane declined — no change), and the landing
theme FOUC (this). 2A/2B/2C are design-kit items, not issues, so nothing else to close.

## Rollback
Frontend-only, additive. Revert the `index.html` / `app/index.html` / `styles.css` / `app.js` commit. No
data/DB/Edge.

## Audit plan
remediation-audit Pass-1 (break this): the FOUC script runs pre-paint on both entry points and never throws
(try/catch); 2C drops the category only at ≤599 (survives at 3-up) and badges stay placed; 2B's desktop
`desktop` string is byte-identical to the #43 sentence for all states (no regression to the shipped header),
mobile rows are ≥44px + both links tappable + private clauses plain, and the refactor didn't break the match
filter; 2A's IN COMMON count = the overlap set size, WHERE YOU OVERLAP shows the correct records/badges and
loads the wantlist rows for (b), the owner ledger/timeline are unchanged, and no price data leaks onto a
friend's views; XSS-safe (owner strings esc'd). Narrow Pass-2 over rework. Converge.
