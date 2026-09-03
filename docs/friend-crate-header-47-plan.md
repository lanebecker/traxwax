# Friend-crate header #47 — implementation plan

Status: **EXECUTED — shipped as v1.10.0 (2026-09-02).** Verification-pass clean (1 MEDIUM + 2 LOW folded in
pre-build; Lane approved the 3 design questions in §0); built; remediation-audit Pass-1 caught 1 CRITICAL
(the friend-wantlist ✕REMOVE would have deleted the viewer's own wantlist — fixed by owner-gating the remove
control) + accepted MEDIUM/LOWs; Pass-2 over the fix clean → converged. **Addon (Lane, pre-commit):** the
friend wantlist is not merely read-only — it now carries the viewer's OWN `+ WANT`/`✕ REMOVE` toggle
(`data-act="want"` → friendAdd/friendRemove; owned → no control), consistent with the friend crate and
non-destructive to the friend. Independently audited clean (destructive `wantRemove` stays IS_OWN-gated). Frontend only
(`public/app.js` + `public/boot.js`) — no migration, no Edge, no break-glass. Design source:
`Design/traxwax-friend-header-redesign/friend-crate-header/`
(`FRIEND-CRATE-HEADER-SPEC.md` + `design-source/Friend Crate Header.dc.html` + screenshots).

## Scope (what the spec actually requires)

The spec is four header changes, but two of them are only *actionable* with supporting work, so this is more
than markup:
1. **Match sentence** in the black strip (replaces "Viewing X's crate") — owner name white, connective grey,
   two counts as white links. **The links must FILTER** the crate/wantlist to the overlap sets → a new
   `state.matchFilter` honored by `matches()`, plus its clear affordance.
2. **Owner-identity block** in the red band (avatar · `{Name}'s Crate` · `@handle · COLLECTING SINCE {year}`)
   — needs `collecting_since` passed into `TraxWaxOwner` (boot.js).
3. **Trimmed joined pill** (`IN CRATE · COLORED · +n THIS MONTH`; drop the two match cells; `EST.` stays
   owner-only).
4. **THE WANTLIST tab** on a friend's crate — needs a **friend wantlist data provider** (boot.js;
   `installFriendCrateProviders` doesn't install one today) and is match-link-2's destination.

All from existing tokens/components — no new tokens, hex, type roles, or components (spec §7, §8).

---

## §0 — Design/scope questions for Lane (resolve at review, before build)

1. **Match-filter EXIT.** The spec specifies how a match link ENTERS a filtered view but not how the user
   leaves it. Proposal: the match filter appears as a **removable chip in the existing active-filter row**
   (the same `v.active` mechanism genre/artist/search already use) — e.g. `MATCH · YOU WANT · THEY HAVE ✕`.
   The spec says the active-filter row is "unchanged"; this doesn't restructure it, just lets the match filter
   live there like any other facet. **OK, or do you want a different exit** (e.g. no chip, cleared only by a
   tab click)?
2. **THE WANTLIST tab when the owner shared their crate but NOT their wantlist.** Per spec the tab shows
   whenever `DB_MODE()`. If the owner's `wantlist_visibility` is `private`, the friend read returns 0 rows
   (RLS blocks `can_view_wantlist`) → the tab renders **empty**. The "locked/private" treatment for that case
   is **#43's** job. Proposal: ship the tab per spec now; the empty-when-unshared state is a known interaction
   handed to #43. **OK to defer, or gate the tab on wantlist-shared in this change?**
3. **Manual tab switch clears the match filter.** After following match-link-1 (crate + youWant), clicking
   another tab clears `matchFilter` (a fresh context). Reasonable? (The match links themselves set it.)

(Item: the spec's `<a href="#" data-act>` links need a `preventDefault` guard — a correctness fix, not a
design question; handled in Task A2.)

---

## Task B1 — pass `collecting_since` into the friend `TraxWaxOwner` (`public/boot.js`)

`installFriendCrateProviders(owner)` builds `TraxWaxOwner` without `collecting_since` (which `get_crate_owner`
returns and the header sub-line needs; it's an `integer` year per migration 0011). FIND:
```js
  window.TraxWaxOwner = {
    ownerLine: (owner.display_name || owner.discogs_username) + '’s shelf',
    lastSyncedAt: null,
    displayName: owner.display_name || '',
    avatarUrl: owner.avatar_url || '',
    isOwn: false,
    ownerUsername: owner.discogs_username,
  };
```
REPLACE:
```js
  window.TraxWaxOwner = {
    ownerLine: (owner.display_name || owner.discogs_username) + '’s shelf',
    lastSyncedAt: null,
    displayName: owner.display_name || '',
    avatarUrl: owner.avatar_url || '',
    isOwn: false,
    ownerUsername: owner.discogs_username,
    collectingSince: owner.collecting_since || null,   // #47 header sub-line ("COLLECTING SINCE {year}")
  };
```

## Task B2 — add a friend wantlist data provider (`public/boot.js`)

`installFriendCrateProviders` installs `TraxWaxData` (crate) but NOT `TraxWaxWantlistData`, so a friend's
WANTLIST tab has no data. Add one, mirroring the own provider (line ~224) but scoped to the owner and read
under the `wantlist_select_friends` RLS policy (wantlist_items has no sensitive columns — release_id/added
only — so no #42-style projection is needed). Add immediately AFTER the friend `TraxWaxData` definition (the
`window.TraxWaxData = async () => { ... };` that ends with the `.map(...)` from #42), inside
`installFriendCrateProviders`:
```js
  // #47: THE WANTLIST tab on a friend's crate reads THEIR wantlist (read-only), under the
  // wantlist_select_friends RLS gate (can_view_wantlist). Returns [] if the owner hasn't shared it.
  window.TraxWaxWantlistData = async () => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('wantlist_items')
        .select('release_id, added, ' +
          'releases ( artist, title, year, label, styles, genres, thumb, cover_image )')
        .eq('user_id', owner.user_id)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error('friend wantlist query failed: ' + error.message);
      for (const it of data ?? []) {
        const rel = it.releases || {};
        rows.push({
          id: it.release_id,
          artist: rel.artist || '', title: rel.title || '', year: rel.year || 0,
          label: rel.label || '', styles: rel.styles || [], genres: rel.genres || [],
          vinyl: '', thumb: rel.thumb || '', cover_image: rel.cover_image || '',
          added: it.added || '', rating: 0,
          price: null, crating: null, crcount: null, have: null, want: null,
        });
      }
      if (!data || data.length < 1000) break;
    }
    return rows;
  };
```
(Executor: confirm the insertion point is INSIDE `installFriendCrateProviders` — after its `TraxWaxData`,
before `TraxWaxMatchCtx`. Grep `grep -n "installFriendCrateProviders\|TraxWaxWantlistData\|TraxWaxMatchCtx" boot.js`
should show the new provider between the friend `TraxWaxData` and `TraxWaxMatchCtx`.)

---

## Task A1 — `state.matchFilter` (`public/app.js`)

FIND:
```js
const state = {
  theme:'light', view:'crate', query:'', genres:[], coloredOnly:false,
  artist:null, color:null, sort:'added', dir:-1, detailId:null, headerValue:null,
};
```
REPLACE:
```js
const state = {
  theme:'light', view:'crate', query:'', genres:[], coloredOnly:false,
  artist:null, color:null, sort:'added', dir:-1, detailId:null, headerValue:null,
  matchFilter:null,   // #47: null | 'youWant' (crate ∩ viewerWants) | 'theyWant' (wantlist ∩ viewerHas)
};
```

## Task A2 — `preventDefault` for in-app `<a data-act>` links (`public/app.js`)

The match sentence renders `<a href="#" data-act="...">`. `onClick` does not preventDefault, so a bare
`href="#"` would scroll to top / push `#` into the URL. Add a guard (the real `← Back to your crate` link has
NO `data-act`, so it is unaffected). FIND:
```js
function onClick(e){
  const t=e.target.closest('[data-act]'); if(!t) return;
```
REPLACE:
```js
function onClick(e){
  const t=e.target.closest('[data-act]'); if(!t) return;
  if(t.tagName==='A') e.preventDefault();   // #47: in-app <a data-act> links (match sentence) never navigate
```

## Task A3 — match filter in `matches()` (`public/app.js`)

FIND (the end of `matches`):
```js
  if(s.query){
    const q=s.query.toLowerCase();
    const hay=(r.artist+' '+r.title+' '+r.label+' '+(r.styles||[]).join(' ')+' '+r.vinyl).toLowerCase();
    if(!hay.includes(q)) return false;
  }
  return true;
}
```
REPLACE:
```js
  if(s.query){
    const q=s.query.toLowerCase();
    const hay=(r.artist+' '+r.title+' '+r.label+' '+(r.styles||[]).join(' ')+' '+r.vinyl).toLowerCase();
    if(!hay.includes(q)) return false;
  }
  // #47: match filter (friend crate only) — the two match-sentence links narrow to the overlap sets.
  if(s.matchFilter){
    const ctx=window.__twMatchCtx;
    if(!ctx) return false;   // sets not loaded yet → show nothing rather than the whole shelf under a match chip
    if(s.matchFilter==='youWant'){ if(!(ctx.viewerWants && ctx.viewerWants.has(r.id))) return false; }
    else if(s.matchFilter==='theyWant'){ if(!(ctx.viewerHas && ctx.viewerHas.has(r.id))) return false; }
  }
  return true;
}
```

## Task A4 — match chip in `computeVals` `active[]` (`public/app.js`)

FIND:
```js
  if(s.query) active.push({kind:'SEARCH',value:s.query});
```
REPLACE:
```js
  if(s.query) active.push({kind:'SEARCH',value:s.query});
  if(s.matchFilter==='youWant') active.push({kind:'MATCH',value:'YOU WANT · THEY HAVE'});
  else if(s.matchFilter==='theyWant') active.push({kind:'MATCH',value:'THEY WANT · YOU HAVE'});
```

## Task A5 — `removeFacet` handles `MATCH` (`public/app.js`)

FIND:
```js
function removeFacet(kind, val){
  if(kind==='STYLE') toggleGenre(val);
  else if(kind==='WAX') state.coloredOnly=false;
  else if(kind==='ARTIST') state.artist=null;
  else if(kind==='COLOR') state.color=null;
  else if(kind==='SEARCH') state.query='';
}
```
REPLACE:
```js
function removeFacet(kind, val){
  if(kind==='STYLE') toggleGenre(val);
  else if(kind==='WAX') state.coloredOnly=false;
  else if(kind==='ARTIST') state.artist=null;
  else if(kind==='COLOR') state.color=null;
  else if(kind==='SEARCH') state.query='';
  else if(kind==='MATCH') state.matchFilter=null;   // #47
}
```

## Task A6 — `clearAll` clears the match filter (`public/app.js`)

FIND:
```js
    case 'clearAll': state.genres=[]; state.coloredOnly=false; state.artist=null; state.color=null; state.query=''; render(); break;
```
REPLACE:
```js
    case 'clearAll': state.genres=[]; state.coloredOnly=false; state.artist=null; state.color=null; state.query=''; state.matchFilter=null; render(); break;
```

## Task A7 — manual tab switch clears the match filter (`public/app.js`)

FIND:
```js
    case 'view':
      state.view=arg;
```
REPLACE:
```js
    case 'view':
      state.view=arg;
      state.matchFilter=null;   // #47: a manual tab switch is a fresh context; the match filter is set only by the match links
```

## Task A8 — match-link handlers (`public/app.js`)

Add two cases. FIND:
```js
    case 'closeDetail': state.detailId=null; renderModal(); break;
```
REPLACE:
```js
    case 'closeDetail': state.detailId=null; renderModal(); break;
    case 'matchYouWant':   // #47: their crate, narrowed to records you want that they have
      state.view='crate'; state.matchFilter='youWant'; track('match_filter', { dir: 'youWant' });
      try { history.replaceState(null, '', location.pathname + location.search); } catch(e){}
      render(); break;
    case 'matchTheyWant':  // #47: their wantlist, narrowed to records they want that you have
      state.view='wantlist'; state.matchFilter='theyWant'; track('match_filter', { dir: 'theyWant' });
      try { history.replaceState(null, '', location.pathname + location.search + '#wantlist'); } catch(e){}
      if (WANTLIST_RECORDS===null && window.TraxWaxWantlistData) {   // lazy-load the friend wantlist, as case 'view' does
        WANTLIST_RECORDS=[];
        window.TraxWaxWantlistData().then((rows)=>{ WANTLIST_RECORDS=rows; render(); })
          .catch((e)=>{ console.warn('wantlist load failed', e); WANTLIST_RECORDS=null; });
      }
      render(); break;
```
(Note: these set `matchFilter` AFTER the view; they do NOT go through `case 'view'` — which would clear it.)

## Task A9 — the match sentence (friend strip) (`public/app.js`)

Add two module-level helpers next to `matches()` (place directly ABOVE `function matches(r){`):
```js
// #47: friend-crate match sentence pieces (spec §3). `n` is a match count from __twMatchCounts.
function _matchAlbums(n){ return n === 1 ? 'ONE ALBUM' : (n === 0 ? 'NO ALBUMS' : n + ' ALBUMS'); }
function _matchPart(n, tail, act){   // tail: 'YOU WANT' | 'THEY WANT'
  const label = _matchAlbums(n) + ' ' + tail;
  const link = "color:#fff; text-decoration:underline; text-underline-offset:3px; text-decoration-color:rgba(255,255,255,.5)";
  return n > 0
    ? `<a href="#" data-act="${act}" style="${link}">${label}</a>`
    : `<span style="color:#fff">${label}</span>`;   // zero side: white, no link
}
```
Then replace the friend strip. FIND:
```js
    ${!IS_OWN()?`<div class="tw-friend-strip" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 24px; background:#16171a; color:#fff; font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.08em; text-transform:uppercase">
      <span>Viewing ${esc((window.TraxWaxOwner&&(window.TraxWaxOwner.displayName||window.TraxWaxOwner.ownerUsername))||'a friend')}’s crate</span>
      <a href="/app" style="color:#fff; text-decoration:underline; white-space:nowrap">← Back to your crate</a>
    </div>`:''}
```
REPLACE:
```js
    ${!IS_OWN()?(()=>{
      const o=window.TraxWaxOwner||{}; const mc=window.__twMatchCounts||{};
      const owner=(o.displayName||o.ownerUsername||'A friend');
      const sentence =
        `<span style="color:#fff">${esc(owner.toUpperCase())}</span> HAS ` +
        _matchPart(mc.you_want_they_have|0, 'YOU WANT', 'matchYouWant') +
        ', AND YOU HAVE ' +
        _matchPart(mc.they_want_you_have|0, 'THEY WANT', 'matchTheyWant') + '.';
      return `<div class="tw-friend-strip" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 24px; background:#16171a; color:rgba(255,255,255,.62); font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.16em; text-transform:uppercase">
      <span>${sentence}</span>
      <a href="/app" style="color:#fff; text-decoration:underline; white-space:nowrap">← Back to your crate</a>
    </div>`;})():''}
```
(Zero-count sides render white + unlinked; both-zero reads as a clean sentence with no dangling links, per
spec §3. `mc.you_want_they_have|0` coerces null→0 so the copy is always complete even before/without a match
load.)

## Task A10 — owner-identity block in the red band (`public/app.js`)

`tw-headL` currently renders the logo + one mono `ownerLine` span for both own and friend. Branch it: keep the
mono line for the owner; render the S18 identity block for a friend (spec §4). FIND:
```js
      <div class="tw-headL" style="display:flex; align-items:flex-end; gap:14px">
        <span style="background:#16171a; color:#fff; font-family:'Anton',sans-serif; font-size:44px; line-height:1; text-transform:uppercase; letter-spacing:.01em; padding:12px 14px 10px; transform:rotate(-1.2deg)">TraxWax</span>
        <span style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:rgba(255,255,255,.92); padding-bottom:6px">${esc(SETTINGS.ownerLine + (IS_OWN() ? ' · filed by ' + FILED_BY_WORD : ''))}</span>
      </div>
```
REPLACE:
```js
      <div class="tw-headL" style="display:flex; align-items:flex-end; gap:14px">
        <span style="background:#16171a; color:#fff; font-family:'Anton',sans-serif; font-size:44px; line-height:1; text-transform:uppercase; letter-spacing:.01em; padding:12px 14px 10px; transform:rotate(-1.2deg)">TraxWax</span>
        ${IS_OWN()
          ? `<span style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:rgba(255,255,255,.92); padding-bottom:6px">${esc(SETTINGS.ownerLine + ' · filed by ' + FILED_BY_WORD)}</span>`
          : (()=>{ const o=window.TraxWaxOwner||{}; const av=o.avatarUrl||'';
              const glyph='<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.2" r="4.2" fill="#16171a"/><path d="M3.5 21c1.4-4.4 4.6-6.6 8.5-6.6s7.1 2.2 8.5 6.6z" fill="#16171a"/></svg>';
              const name=(o.displayName||o.ownerUsername||'A friend');
              const since=o.collectingSince ? (' · COLLECTING SINCE ' + esc(String(o.collectingSince))) : '';
              return `<div style="display:flex; align-items:center; gap:12px; padding-bottom:2px">
                <span style="width:46px; height:46px; flex:none; border:1.5px solid #16171a; border-radius:50%; overflow:hidden; background:#fff; display:inline-flex; align-items:center; justify-content:center">${av?`<img src="${esc(av)}" alt="" style="width:100%; height:100%; object-fit:cover; display:block">`:glyph}</span>
                <span style="display:flex; flex-direction:column; gap:3px">
                  <span style="font-family:'Barlow Condensed',sans-serif; font-size:26px; font-weight:700; line-height:1; color:#fff">${esc(name)}’s Crate</span>
                  <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:rgba(255,255,255,.85)">@${esc(o.ownerUsername||'')}${since}</span>
                </span>
              </div>`;})()}
      </div>
```
(Capital C in "Crate" per §4. No account/settings button on a friend's crate — the `data-act="account"` avatar
button at ~641 is already gated `DB_MODE() && IS_OWN()`, so it does not render here; unchanged.)

## Task A11 — trim the match cells from the joined pill (`public/app.js`)

FIND (the EST cell + the two friend match-cell lines — the EST line is kept as an anchor so no blank line is
left behind):
```js
          ${(IS_OWN() && s.view!=='wantlist')?`<span style="padding:6px 10px; border-right:1.5px solid #16171a">${esc(s.headerValue || valueLabel(v.total))} EST.</span>`:''}
          ${(!IS_OWN() && window.__twMatchCounts && window.__twMatchCounts.you_want_they_have != null)?`<span class="tw-hide-mobile" style="padding:6px 10px; border-right:1.5px solid #16171a">YOU WANT ${window.__twMatchCounts.you_want_they_have} THEY HAVE</span>`:''}
          ${(!IS_OWN() && window.__twMatchCounts && window.__twMatchCounts.they_want_you_have != null)?`<span class="tw-hide-mobile" style="padding:6px 10px; border-right:1.5px solid #16171a">THEY WANT ${window.__twMatchCounts.they_want_you_have} YOU HAVE</span>`:''}
```
REPLACE (keep the EST line, drop the two match lines):
```js
          ${(IS_OWN() && s.view!=='wantlist')?`<span style="padding:6px 10px; border-right:1.5px solid #16171a">${esc(s.headerValue || valueLabel(v.total))} EST.</span>`:''}
```
So the friend pill is `{n} IN CRATE · {n} COLORED · +{n} THIS MONTH` (the `IN CRATE`/`COLORED`/`THIS MONTH`
cells at ~632/633/637 are untouched; `EST.` stays `IS_OWN`-gated). Owner pill unchanged.

## Task A12 — add THE WANTLIST tab on a friend's crate (`public/app.js`)

FIND:
```js
      ${tab('crate','THE CRATE')}${tab('timeline','THE TIMELINE')}${tab('ledger','THE LEDGER')}${(IS_OWN() && DB_MODE())?tab('wantlist','THE WANTLIST'):''}
```
REPLACE:
```js
      ${tab('crate','THE CRATE')}${tab('timeline','THE TIMELINE')}${tab('ledger','THE LEDGER')}${DB_MODE()?tab('wantlist','THE WANTLIST'):''}
```
Also widen the hash-restore `_validTabs` gate so a reloaded `#wantlist` is honored on a friend's crate. FIND:
```js
  const _validTabs = new Set(['crate','timeline','ledger']);
  if (IS_OWN() && DB_MODE()) _validTabs.add('wantlist');
```
REPLACE:
```js
  const _validTabs = new Set(['crate','timeline','ledger']);
  if (DB_MODE()) _validTabs.add('wantlist');   // #47: friend crates get THE WANTLIST too
```

## Task A13 — reset `matchFilter` on (re)boot (`public/app.js`)

`state.matchFilter` is per-crate/per-context state, exactly like `WANTLIST_RECORDS` / `detailId` /
`__twMatchCtx` which `bootCrate` already resets defensively so one crate's state never bleeds into the next.
Reset it there too. FIND:
```js
  WANTLIST_RECORDS=null;   // Wave 2 B1: fresh dataset per boot (defense-in-depth: own↔friend/user changes never bleed the wrong dataset)
  state.detailId = null;   // #44/#37: never inherit a stale open modal across a (re)boot
```
REPLACE:
```js
  WANTLIST_RECORDS=null;   // Wave 2 B1: fresh dataset per boot (defense-in-depth: own↔friend/user changes never bleed the wrong dataset)
  state.matchFilter=null;  // #47: match filter is per-crate context — never inherit it across a (re)boot
  state.detailId = null;   // #44/#37: never inherit a stale open modal across a (re)boot
```

## Release (standard post-build, after the audit)
Frontend-only, so no break-glass. Bump `VERSION` → `1.10.0`, add a `CHANGELOG.md` entry, append `log.md`,
mark this plan EXECUTED, and hand Lane the one-`&&`-chain git push (`Closes #47`). Same shape as every
frontend wave — not a distinct task list item here, just the closeout.

---

## Verify
```
cd "<repo>/public" && node --check app.js && node --check boot.js
```
Grep checks:
```
grep -n "matchFilter" app.js          # state, matches, computeVals, removeFacet, clearAll, case 'view', bootCrate reset, 2 handlers
grep -n "matchYouWant\|matchTheyWant" app.js   # 2 handler cases + the 2 _matchPart call sites (via helper)
grep -n "TraxWaxWantlistData" boot.js  # own (installCrateProviders) + NEW friend (installFriendCrateProviders)
grep -n "collectingSince" boot.js app.js       # boot sets it; app reads it in the identity block
```
Manual walkthrough (after build, in review or on deploy):
- Friend crate: strip reads the match sentence; the two counts underline as links; zero side is white + not a
  link; both-zero reads clean.
- Click "N ALBUMS YOU WANT" → THE CRATE, grid narrows to records you want that they have; a `MATCH · YOU WANT
  · THEY HAVE` chip appears and clears the filter when ✕'d (and via CLEAR/clearAll); manual tab switch clears it.
- Click "N ALBUMS THEY WANT" → THE WANTLIST (loads their wantlist), grid narrows to records they want that you
  have.
- Red band shows avatar + `{Name}'s Crate` + `@handle · COLLECTING SINCE {year}`; avatar falls back to the
  glyph; no account button.
- Pill = `IN CRATE · COLORED · +n THIS MONTH`; no match cells, no EST.
- Owner crate unchanged (strip absent, mono ownerLine + filed-by, full pill with EST., wantlist tab as before).

## Rollback
Frontend-only, additive. Revert the `app.js` + `boot.js` commit. No data/DB/Edge involved.

## Audit plan
After build: remediation-audit Pass-1 (break this) — the match filter can't leak (shows nothing until
`__twMatchCtx` loads; owner-crate never sets matchFilter); the friend wantlist provider is gated by RLS
(can_view_wantlist) and returns [] when unshared, never errors the tab; the sentence copy/pluralization/zero
rules match spec §3; the identity block escapes owner-controlled strings (name/handle/avatar via `esc`/attr);
`preventDefault` doesn't break the real BACK link or other anchors; owner header byte-unchanged. Narrow Pass-2
over rework. Converge.
