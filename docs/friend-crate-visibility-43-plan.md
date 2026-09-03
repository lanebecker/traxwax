# Friend-crate visibility #43 — implementation plan

Status: **EXECUTED — shipped as v1.11.0 (2026-09-03).** Verification-pass caught 8 (1 CRITICAL false-PRIVATE,
1 MAJOR non-executable 4b, + 6) — all fixed pre-build; migration 0023 applied + post-verified; remediation-audit
Pass-1 essentially clean (no leak, no C1, migration byte-correct) with 1 LOW (a boot.js flag default made
fail-closed) → converged. Lane approved the derived dark lock tokens. Needs **break-glass** (one migration; no
Edge). Builds on committed v1.10.0/#47. Design source of record:
`Design/traxwax-issue-43-redesign/friend-crate-visibility/FRIEND-CRATE-VISIBILITY-SPEC.md` (+ screenshots).
Sequencing: **push v1.10.0 (#47) first** so this builds on a clean base and versions stay separate.

## Scope — the five decisions + the backend bug

1. **The #43 bug + visibility flags (backend).** `get_crate_owner` authorizes only on `can_view_crate`, so a
   friend who shared their *wantlist* but not their crate gets `no_crate` and can't load the page. Fix:
   authorize on `can_view_crate OR can_view_wantlist`, and RETURN both booleans so the frontend can lock/land.
2. **Locked tabs (1b)** — a section the visitor can't see stays as a greyed, lock-glyphed, **clickable** tab
   that lands an inline "private" panel. Timeline & Ledger lock/unlock **with** the crate.
3. **Landing** — first shared section; the locked tab stays visible; both-private never reaches this view
   (boot.js already serves the S16 "no crate" card).
4. **Empty vs. private copy** — three friend-voiced states (shared-empty / private-panel / real-zero), no
   Add CTA, third-person.
5. **Match sentence** — a private direction reports "PRIVATE," never a false "NO ALBUMS."
6. **Count = set (Decision 5)** — derive each match count from the overlap set, so count and filter can't
   disagree. This retires the `crate_match` RPC from the sentence and makes the post-write recount instant.

New tokens `--lock #b4b7bd` / `--lockbg #f0f1f3` (kit §Design tokens) are added to `styles.css` (they are not
currently defined — the only new tokens this pass, and specified verbatim by the kit).

---

## Task 1 — migration `supabase/migrations/0023_get_crate_owner_visibility.sql`

Create with EXACTLY this content (body = the current 0013 `get_crate_owner` plus the OR-gate + two flags):

```sql
-- 0023_get_crate_owner_visibility.sql — cold-audit #43.
-- get_crate_owner authorized ONLY on can_view_crate, so a friend who shared their WANTLIST but kept their
-- crate private got 'no_crate' and couldn't load the page at all. Authorize on can_view_crate OR
-- can_view_wantlist, and RETURN both booleans so the frontend can render locked tabs + land on the shared
-- section. Both-private (or not-friends / no-such-user) still returns 'no_crate' — no existence probe.
create or replace function public.get_crate_owner(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub text := auth.jwt()->>'sub';
  v record;
  v_can_crate boolean;
  v_can_want  boolean;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  select user_id, discogs_username, display_name, avatar_url, bio, location,
         collecting_since, link1, link2
    into v
    from public.profiles
   where lower(discogs_username) = lower(p_username);
  if not found then return jsonb_build_object('status','no_crate'); end if;
  v_can_crate := private.can_view_crate(v_sub, v.user_id);
  v_can_want  := private.can_view_wantlist(v_sub, v.user_id);
  if not (v_can_crate or v_can_want) then
    return jsonb_build_object('status','no_crate');   -- both closed / not shared → S16, no existence probe
  end if;
  return jsonb_build_object('status','ok',
    'can_view_crate', v_can_crate,
    'can_view_wantlist', v_can_want,
    'owner', jsonb_build_object(
      'user_id', v.user_id, 'discogs_username', v.discogs_username,
      'display_name', v.display_name, 'avatar_url', v.avatar_url, 'bio', v.bio,
      'location', v.location, 'collecting_since', v.collecting_since,
      'link1', v.link1, 'link2', v.link2));
end;
$$;
```
(No grant change — `get_crate_owner` is already `authenticated`-executable.) Apply via break-glass
(`apply_migration`, name `get_crate_owner_visibility`).

### Post-apply verification (read-only connector)
1. Definition carries the OR-gate + flags:
   ```sql
   select pg_get_functiondef('public.get_crate_owner(text)'::regprocedure) like '%can_view_wantlist%'
      and pg_get_functiondef('public.get_crate_owner(text)'::regprocedure) like '%can_view_crate%'
      and pg_get_functiondef('public.get_crate_owner(text)'::regprocedure) like '%or v_can_want%';
   ```
   Expected `t`.
2. `get_advisors` security — no NEW lint (get_crate_owner keeps `search_path`, stays the same 0029 class).
3. Functional matrix (transaction, ROLLED BACK — set the JWT claim where the harness allows, else reason):
   own → `ok`, both flags true; a friend with crate `friends`/wantlist `private` → `ok`,
   `can_view_crate=true, can_view_wantlist=false`; crate `private`/wantlist `friends` → `ok`,
   `can_view_crate=false, can_view_wantlist=true`; both `private` → `no_crate`; nonexistent username →
   `no_crate`.

---

## Task 2 — `public/styles.css`: add the two lock tokens

Add to BOTH token blocks. In `:root` (light; styles.css ~line 8, after `--skel:#e4e6e9;`):
```css
  --lock:#b4b7bd; --lockbg:#f0f1f3;
```
In `body[data-theme="dark"]` (~line 14, after `--skel:#212329;`) — the kit gives **only light values**, so these
dark equivalents are DERIVED to sit in the dark palette (`--lock` a dim label between `--hair #2b2d33` and
`--faint #9ea2a9`; `--lockbg` a faint fill near `--bar #212329`). **⚑ Flag for Lane** — kit under-specified
dark; confirm or tweak:
```css
  --lock:#6b6f77; --lockbg:#202227;
```

---

## Task 3 — `public/boot.js`: pass the flags + load the owner-wantlist id set

### 3a — capture the flags on the friend route
FIND:
```js
      const { data } = await supabase.rpc('get_crate_owner', { p_username: routeUsername });
      if (data && data.status === 'ok') friendOwner = data.owner;
```
REPLACE:
```js
      const { data } = await supabase.rpc('get_crate_owner', { p_username: routeUsername });
      if (data && data.status === 'ok') {
        friendOwner = data.owner;
        friendOwner._canViewCrate = data.can_view_crate === true;      // #43 visibility flags
        friendOwner._canViewWantlist = data.can_view_wantlist === true;
      }
```

### 3b — expose the flags + an owner-wantlist-ids provider (`installFriendCrateProviders`)
In `installFriendCrateProviders(owner)`, extend `window.TraxWaxViewer` to carry the flags, and add a
lightweight owner-wantlist-ids provider (for the set-derived match count — Decision 5). FIND:
```js
  window.TraxWaxViewer = { isOwn: false, ownerUserId: owner.user_id, ownerProfile: owner };
```
REPLACE:
```js
  window.TraxWaxViewer = { isOwn: false, ownerUserId: owner.user_id, ownerProfile: owner,
    canViewCrate: owner._canViewCrate !== false, canViewWantlist: owner._canViewWantlist === true };  // #43
  // #43 (Decision 5): the owner's wantlist IDs — for the set-derived "they want / you have" count (so the
  // count and the filter share one source and can't disagree). ID-only, under the same wantlist RLS gate.
  window.TraxWaxOwnerWantIds = async () => {
    if (owner._canViewWantlist !== true) return new Set();   // wantlist private → unknown, not zero
    const ids = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('wantlist_items')
        .select('release_id').eq('user_id', owner.user_id).order('id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error('friend wantlist-ids query failed: ' + error.message);
      for (const it of data ?? []) ids.add(it.release_id);
      if (!data || data.length < 1000) break;
    }
    return ids;
  };
```
(Note: the OWN path DOES set `TraxWaxViewer = { isOwn: true, ownerUserId: null, ownerProfile: null }` — so
`IS_OWN()` is true there and `CAN_VIEW_CRATE/WANTLIST` short-circuit `true` BEFORE reading any flag; the
`canViewCrate/canViewWantlist` fields exist only on the friend object. Friend-only in effect, as intended —
Verification L1.)

---

## Task 4 — `public/app.js`: state, flags, and the set-derived counts

### 4a — helpers: visibility + set-derived match counts
Add near the top of app.js (after `IS_OWN`), module-level:
```js
// #43: friend-crate section visibility. Own crate → both true. Friend → the get_crate_owner flags.
const CAN_VIEW_CRATE    = () => IS_OWN() || !window.TraxWaxViewer || window.TraxWaxViewer.canViewCrate === true;
const CAN_VIEW_WANTLIST = () => IS_OWN() || !window.TraxWaxViewer || window.TraxWaxViewer.canViewWantlist === true;
// Which section a view belongs to for locking: crate/timeline/ledger ride the crate; wantlist is its own.
const _viewLocked = (view) => (view === 'wantlist') ? !CAN_VIEW_WANTLIST() : !CAN_VIEW_CRATE();

// #43 (Decision 5): match counts derived from the SETS, so a count can never disagree with the filter it
// links to. you_want_they_have = |viewerWants ∩ owner-crate|; they_want_you_have = |viewerHas ∩ owner-wantlist|.
// A `null` count means the direction is PRIVATE — driven ONLY by the visibility flag, NEVER by a not-yet-loaded
// set. (Verification C1: the sets — RECORDS, __twMatchCtx, __twOwnerWantIds — are all AWAITED in bootCrate
// before the first render (Task 7b), so a SHARED direction always yields a real count (0+), never a transient
// null that would misread as "PRIVATE".)
function _matchCounts(){
  const ctx = window.__twMatchCtx;
  const out = { youWant: null, theyWant: null };   // null ⇔ the direction is PRIVATE (flag false)
  if (CAN_VIEW_CRATE()){
    let n = 0; if (ctx && ctx.viewerWants) for (const r of (RECORDS||[])) if (ctx.viewerWants.has(r.id)) n++;
    out.youWant = n;   // shared → a real count (0+)
  }
  if (CAN_VIEW_WANTLIST()){
    let n = 0; const ids = window.__twOwnerWantIds; if (ctx && ctx.viewerHas && ids) for (const id of ids) if (ctx.viewerHas.has(id)) n++;
    out.theyWant = n;  // shared → a real count (0+); ids awaited at boot, so ready at first paint
  }
  return out;
}
```
(`RECORDS` is the loaded owner crate; `window.__twOwnerWantIds` is set — awaited — in bootCrate, Task 7. Both
are the same data their links filter, so `count = overlap` holds by construction. Private is flag-driven, so a
shared-but-empty overlap correctly reads as a real 0, and a private direction reads as PRIVATE — never confused.)

### 4b — the match sentence (rewrite the #47 strip for private clauses + set-counts)
The #47 friend strip computes the sentence from `window.__twMatchCounts`. Replace ONLY the sentence-building
block; the strip's `return \`<div class="tw-friend-strip"…>\`` wrapper below it is UNCHANGED and stays. FIND:
```js
      const o=window.TraxWaxOwner||{}; const mc=window.__twMatchCounts||{};
      const owner=(o.displayName||o.ownerUsername||'A friend');
      const sentence =
        `<span style="color:#fff">${esc(owner.toUpperCase())}</span> HAS ` +
        _matchPart(mc.you_want_they_have|0, 'YOU WANT', 'matchYouWant') +
        ', AND YOU HAVE ' +
        _matchPart(mc.they_want_you_have|0, 'THEY WANT', 'matchTheyWant') + '.';
```
REPLACE:
```js
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
```
`_matchPart(n,tail,act)` (from #47) renders `NO ALBUMS`/`ONE ALBUM`/`n ALBUMS` and links only when `n>0`.
Decision 5's link-integrity is now automatic: the count IS the overlap-set size, and the link filters to that
same set. (The strip wrapper — mono 10px `.16em`, `rgba(255,255,255,.62)` — is outside this FIND, unchanged.)

### 4c — retire the `crate_match`/`__twMatchCounts` path from the frontend
With set-derived counts the sentence recomputes from the flipped `viewerWants`/`viewerHas` on the next
`render()`, so the server recount is gone. Exact removals:
- **`friendAdd` (app.js ~1026):** delete the `_refreshMatchCounts();` line.
- **`friendRemove` (app.js ~1045):** it passes `_refreshMatchCounts` as the 5th (`onCommit`) arg —
  `_beginDeferredRemove(id, rec, revert, 'friend', _refreshMatchCounts);`. Change the 5th arg to `null`
  (matching the own-wantlist remove at ~1111): `_beginDeferredRemove(id, rec, revert, 'friend', null);`.
  (Leaving the bare reference would `ReferenceError` on the next friend-crate remove commit once the function
  is deleted — Verification MD1.)
- **`_refreshMatchCounts` (app.js ~1051-1053):** delete the whole function.
- **boot.js `TraxWaxMatchCounts` provider (`installFriendCrateProviders`):** delete the
  `window.TraxWaxMatchCounts = async () => {…}` block.
- The bootCrate `__twMatchCounts` reset + load are removed in **Task 7b**. After all removals,
  `grep -n "__twMatchCounts\|_refreshMatchCounts\|TraxWaxMatchCounts" app.js boot.js` must return NOTHING.
  (The `crate_match` RPC stays in the DB — unused, harmless; drop in a later cleanup. No other reader of
  `__twMatchCounts` exists — the pill's match cells were removed in #47.)
- The `matchYouWant`/`matchTheyWant` handlers (#47) are unchanged (they set `matchFilter` + view).

---

## Task 5 — `public/app.js`: locked tabs (1b)

### 5a — the lock glyph + a locked `tab()` variant
Add a module-level constant + extend `tab()`. Lock glyph (kit §Lock glyph):
```js
const LOCK_SVG = '<svg width="10" height="12" viewBox="0 0 24 24" aria-hidden="true" style="margin-right:6px; vertical-align:-1px"><rect x="4" y="10" width="16" height="11" rx="1.5" fill="currentColor"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.6"></path></svg>';
```
Extend `tab(id,label)` so a locked section renders the lock treatment (still `data-act="view"` + clickable →
lands the panel; per kit the tab is NOT disabled). FIND the current `tab`:
```js
function tab(id,label){
  const on = state.view===id;
  return `<button data-act="view" data-arg="${id}" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.12em; padding:11px 18px; background:transparent; border:0; border-right:1px solid var(--hair); border-bottom:3px solid ${on?'var(--accent)':'transparent'}; color:${on?'var(--ink)':'var(--muted)'}">${label}</button>`;
}
```
REPLACE:
```js
function tab(id,label){
  const on = state.view===id;
  const locked = _viewLocked(id);   // #43: greyed + lock glyph, still clickable → locked panel
  if (locked){
    return `<button data-act="view" data-arg="${id}" aria-label="${esc(label)} (private)" title="Private" style="display:inline-flex; align-items:center; font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.12em; padding:11px 18px; background:var(--lockbg); border:0; border-right:1px solid var(--hair); border-bottom:3px solid ${on?'var(--lock)':'transparent'}; color:var(--lock); cursor:pointer">${LOCK_SVG}${label}</button>`;
  }
  return `<button data-act="view" data-arg="${id}" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.12em; padding:11px 18px; background:transparent; border:0; border-right:1px solid var(--hair); border-bottom:3px solid ${on?'var(--accent)':'transparent'}; color:${on?'var(--ink)':'var(--muted)'}">${label}</button>`;
}
```
(Tabs row is unchanged otherwise — `THE CRATE / THE TIMELINE / THE LEDGER` + `${DB_MODE()?tab('wantlist',…):''}`
from #47. On a friend crate, whichever section is private renders locked.)

---

## Task 6 — `public/app.js`: the locked panel + the three empty/private states

### 6a — `lockedPanelHtml(section)` (the inline "private" panel, kit §Decision 3-B)
Add a builder that renders the private panel for `'crate'` or `'wantlist'`, reusing `emptyCrateHtml`'s
layout shell + tokens (lock badge, eyebrow, headline, body, CTA). Exact copy (kit, with Lane's tweak):
- **crate private** (locked Crate/Timeline/Ledger land here; only reachable when the wantlist IS shared):
  eyebrow `THE CRATE · PRIVATE`; headline `{owner} keeps their crate closed.`; body
  `Their wantlist is open, though — ` + link `browse their wants here →` (`data-act="view" data-arg="wantlist"`).
- **wantlist private**: badge lock; eyebrow `THE WANTLIST · PRIVATE`; headline `{owner}'s wantlist is private.`;
  body `They're keeping their hunt to themselves. The crate's still open.`; CTA `BACK TO THE CRATE →`
  (`data-act="view" data-arg="crate"`).
Both carry the 14–15px lock glyph badge (kit) so they read as *closed*, not empty. `{owner}` = `esc(displayName
|| ownerUsername)`. Third-person; NO Add CTA.

### 6b — friend shared-but-empty wantlist (state A) in `emptyCrateHtml`
`emptyCrateHtml` today: `isWant = own && view==='wantlist'` → a *friend's* empty wantlist falls to the crate
copy. Add a friend-wantlist branch (kit §Decision 3-A): eyebrow `THEIR WANTLIST · 0`; headline
`{owner} isn't hunting anything.`; body `Nothing on their wantlist right now. The crate's where the records
are.`; CTA `BACK TO THE CRATE →` (`data-act="view" data-arg="crate"`). Reached only when the wantlist is
SHARED and genuinely empty (`!IS_OWN() && view==='wantlist' && CAN_VIEW_WANTLIST() && WANTLIST_RECORDS.length===0`).
(A friend's empty *crate* keeps its existing friend copy.)

### 6c — render(): route a locked view to the panel
In `render()`, before the grid/empty branches, add: if the current view is locked, the content is the locked
panel. FIND:
```js
  const showGrid=(s.view==='crate' || s.view==='wantlist') && v.filtered.length>0;   // Wave 2 B1: the wantlist reuses the card grid
  const showTimeline=s.view==='timeline' && v.filtered.length>0;
  const showStats=s.view==='ledger' && v.filtered.length>0;
  const showEmpty=v.filtered.length===0;
```
REPLACE:
```js
  const lockedSection = !IS_OWN() && _viewLocked(s.view) ? (s.view==='wantlist' ? 'wantlist' : 'crate') : null;  // #43
  const showGrid=!lockedSection && (s.view==='crate' || s.view==='wantlist') && v.filtered.length>0;
  const showTimeline=!lockedSection && s.view==='timeline' && v.filtered.length>0;
  const showStats=!lockedSection && s.view==='ledger' && v.filtered.length>0;
  const showEmpty=!lockedSection && v.filtered.length===0;
```
Then where `content` is assembled (the `if(showGrid)…else if(showTimeline)…else if(showStats)…else if(showEmpty)…`
chain), add a FIRST branch: `if (lockedSection){ content = lockedPanelHtml(lockedSection); }`. (Locked views
skip the facet bar's active state naturally — filtered is irrelevant; the panel replaces the content area only.
The header, tabs, footer still render.)

---

## Task 7 — `public/app.js`: routing/landing + load the owner-wantlist ids (bootCrate)

### 7a — land on the first shared section
`bootCrate` picks `_bootView` from the URL hash, defaulting to `'crate'`. Make the default the first SHARED
section, and drop a hash that points at a locked section. FIND:
```js
  let _bootView = 'crate';
  try { const h = (location.hash||'').replace(/^#/,''); if (_validTabs.has(h)) _bootView = h; } catch(e){}
  state.view = _bootView;
```
REPLACE:
```js
  // #43: default to the first SHARED section (crate open → crate; crate private + wantlist open → wantlist).
  // both-private never reaches here — boot.js served the S16 no-crate card.
  let _bootView = CAN_VIEW_CRATE() ? 'crate' : 'wantlist';
  try { const h=(location.hash||'').replace(/^#/,''); if (_validTabs.has(h) && !(!IS_OWN() && _viewLocked(h))) _bootView = h; } catch(e){}
  state.view = _bootView;
```

### 7b — load the owner-wantlist id set (AWAITED) + retire the `__twMatchCounts` load
Replace the bootCrate friend match-load so it AWAITS `__twOwnerWantIds` (ready at first paint —
Verification C1) and drops the retired `__twMatchCounts`. FIND:
```js
      window.__twMatchCtx = null; window.__twMatchCounts = null;
      if (!IS_OWN() && window.TraxWaxMatchCtx) {
        try { window.__twMatchCtx = await window.TraxWaxMatchCtx(); } catch (e) { window.__twMatchCtx = null; }
        try { window.__twMatchCounts = await window.TraxWaxMatchCounts(); } catch (e) { window.__twMatchCounts = null; }
      }
```
REPLACE:
```js
      window.__twMatchCtx = null; window.__twOwnerWantIds = null;
      if (!IS_OWN() && window.TraxWaxMatchCtx) {
        try { window.__twMatchCtx = await window.TraxWaxMatchCtx(); } catch (e) { window.__twMatchCtx = null; }
        // #43: AWAIT the owner-wantlist ids so the "they want" count is ready at first paint — never a
        // transient null that _matchCounts would misread as PRIVATE (Verification C1). Fetch failure → empty
        // set (best-effort real 0 on a shared list; self-heals on reload), never "PRIVATE" (that's flag-driven).
        try { window.__twOwnerWantIds = await window.TraxWaxOwnerWantIds(); } catch (e) { window.__twOwnerWantIds = new Set(); }
      }
```
(This is the site of the old `__twMatchCounts` reset+load — both retired here per Task 4c. The `__twOwnerWantIds`
reset lives here too, so no separate top-of-bootCrate reset is needed.)

---

## Verify
```
cd "<repo>/public" && node --check app.js && node --check boot.js
```
Grep: `grep -n "CAN_VIEW_CRATE\|CAN_VIEW_WANTLIST\|_viewLocked\|lockedPanelHtml\|_matchCounts\|__twOwnerWantIds" app.js`;
`grep -n "TraxWaxOwnerWantIds\|canViewCrate\|_refreshMatchCounts\|TraxWaxMatchCounts" boot.js app.js` (expect
`_refreshMatchCounts`/`TraxWaxMatchCounts` GONE). `grep -n "\-\-lock" styles.css` (expect the two tokens).

Manual matrix (deploy): crate-open/wantlist-private → wantlist tab locked → clicking it lands the wantlist-
private panel; sentence "…THEIR WANTLIST IS PRIVATE." crate-private/wantlist-open → lands on THE WANTLIST;
Crate/Timeline/Ledger locked → land the crate-private panel with "browse their wants here →"; sentence
"{NAME}'S CRATE IS PRIVATE. YOU HAVE {m} …". both-open → unchanged (#47). both-private → S16 card (boot.js).
Real-zero shared → normal grid + "NO ALBUMS" (real zero). Count on each link == the filtered grid size.

## Deploy sequencing
Migration 0023 is a pure `create or replace` (widens access + adds fields) — safe to apply just before the
frontend push, but it MUST NOT ship far ahead of this frontend: once it returns `ok` to a wantlist-only
visitor, the OLD frontend would drop them on a broken empty crate. Apply migration → push the frontend in the
same window (like #42).

## Rollback
Revert the app.js/boot.js/styles.css commit; `create or replace get_crate_owner` back to the 0013 body (crate-
only gate, no flags). No data migration.

## Audit plan
remediation-audit Pass-1 (break this): a private section can NEVER leak rows (RLS returns [] + the flags only
gate copy; get_friend_crate/wantlist reads are the actual guard); `_matchCounts` returns null (→ "PRIVATE")
for a private direction and never a false 0; the count always equals the link's filtered set; locked tabs are
clickable + land the right panel, never a dead grid; landing picks a shared section; both-private still hits
S16; owner crate + both-open friend crate byte-unchanged; retiring `crate_match`/`_refreshMatchCounts` breaks
no reactive update (add/remove a want → sentence recomputes from sets); XSS-safe (owner strings esc'd). Narrow
Pass-2 over rework. Converge.
