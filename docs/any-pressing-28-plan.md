# #28 — Optional "match any pressing" (Wave B) — plan

Status: DRAFT for verification-pass + review. Needs **break-glass** (migration `0024` + two Edge deploys:
enrich-release, import-collection). Target version **v1.13.0** (builds on committed v1.12.0). Design source:
`Design/traxwax-remaining-design-issues/traxwax-open-items/TRAXWAX-OPEN-ITEMS-SPEC.md` **Part 1** + screenshots
`1-any-pressing-account-control.png`, `2-any-pressing-badges.png`. Lane's calls: match-mode stored on
**profiles** (cross-device); exact-pressing stays the default.

## The idea
Today a "match" is an exact Discogs **release** (`release_id`). #28 adds an opt-in **ANY PRESSING** mode that
also matches on the **master** (`master_id` = the album/work). It's the **viewer's** own global preference,
applied symmetrically to both match directions; it changes **reads only** (sentence counts, badges, overlap,
match filters) — never writes (`+ WANT` always adds the exact release you're viewing).

## master_id — capture is free; the catalog fills organically
`releases` has no `master_id` today. Both Discogs responses we already fetch carry it: an import's
`basic_information.master_id` (no extra call) and the enrich `GET /releases/{id}`'s `master_id`. So we capture
it in `seed_releases` (import) + `enrich-release`. **No forced full-catalog backfill:** a user's re-sync fills
their own records' master_id fast (basic_information), enrich fills the rest over its normal drain, and a
release whose `master_id` is still null **behaves exactly like a true no-master release — exact-only, silently**
(kit §1.5). So any-pressing "lights up" per record as master_ids arrive; nothing is ever broken mid-fill.

---

## Task 1 — migration `supabase/migrations/0024_any_pressing.sql` (break-glass)

Create with EXACTLY this content:
```sql
-- 0024_any_pressing.sql — #28 (optional any-pressing / master-level matching).
-- (1) releases.master_id: the Discogs MASTER (album) id, captured free from basic_information (import) and the
--     release GET (enrich). Nullable — one-offs have no master, and un-backfilled rows read as exact-only.
-- (2) seed_releases merges master_id (import path).
-- (3) profiles.match_mode: the VIEWER's reading preference ('exact' default | 'any'); user-settable (the
--     profiles_guard only pins OAuth columns), read-only w.r.t. RLS.
-- (4) get_friend_crate returns master_id so the friend crate can badge any-pressing matches.

alter table public.releases add column if not exists master_id bigint;

alter table public.profiles
  add column if not exists match_mode text not null default 'exact';
alter table public.profiles
  drop constraint if exists profiles_match_mode_chk;
alter table public.profiles
  add constraint profiles_match_mode_chk check (match_mode in ('exact','any'));

-- seed_releases: same body as 0010 + master_id (insert col, seed value, empty-guarded merge).
create or replace function public.seed_releases(p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.releases
    (release_id, artist, title, year, label, styles, genres, thumb, cover_image, master_id)
  select (r->>'release_id')::bigint,
         coalesce(r->>'artist', ''),
         coalesce(r->>'title', ''),
         coalesce((r->>'year')::int, 0),
         coalesce(r->>'label', ''),
         coalesce((select array_agg(x.v order by x.o)
                     from jsonb_array_elements_text(r->'styles') with ordinality x(v, o)), '{}'),
         coalesce((select array_agg(x.v order by x.o)
                     from jsonb_array_elements_text(r->'genres') with ordinality x(v, o)), '{}'),
         coalesce(r->>'thumb', ''),
         coalesce(r->>'cover_image', ''),
         nullif(nullif(r->>'master_id',''),'0')::bigint   -- Discogs sends master_id 0 for no-master releases → store NULL
    from jsonb_array_elements(p_rows) r
   order by 1
  on conflict (release_id) do update set
    artist      = case when excluded.artist      <> '' then excluded.artist      else releases.artist      end,
    title       = case when excluded.title       <> '' then excluded.title       else releases.title       end,
    year        = case when excluded.year        <> 0  then excluded.year        else releases.year        end,
    label       = case when excluded.label       <> '' then excluded.label       else releases.label       end,
    styles      = case when coalesce(array_length(excluded.styles, 1), 0) > 0 then excluded.styles else releases.styles end,
    genres      = case when coalesce(array_length(excluded.genres, 1), 0) > 0 then excluded.genres else releases.genres end,
    thumb       = case when excluded.thumb       <> '' then excluded.thumb       else releases.thumb       end,
    cover_image = case when excluded.cover_image <> '' then excluded.cover_image else releases.cover_image end,
    master_id   = case when excluded.master_id is not null then excluded.master_id else releases.master_id end;
end;
$$;

-- get_friend_crate: add master_id to the projection (rest identical to 0021's strip-ord form).
create or replace function public.get_friend_crate(p_username text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(t) - 'ord' order by t.ord), '[]'::jsonb)
  from (
    select ci.id as ord,
           ci.release_id, ci.added, ci.rating, ci.vinyl,
           r.artist, r.title, r.year, r.label, r.styles, r.genres, r.thumb, r.cover_image, r.master_id
      from public.profiles p
      join public.collection_items ci on ci.user_id = p.user_id
      left join public.releases r on r.release_id = ci.release_id
     where lower(p.discogs_username) = lower(p_username)
       and private.can_view_crate(auth.jwt()->>'sub', p.user_id)
  ) t;
$$;
revoke all on function public.get_friend_crate(text) from public, anon;
grant execute on function public.get_friend_crate(text) to authenticated;
```
Apply via break-glass (`apply_migration`, name `any_pressing`).

### Post-apply verification (read-only connector)
- `releases.master_id` + `profiles.match_mode` exist (match_mode `not null default 'exact'`, CHECK
  `{exact,any}`).
- `pg_get_functiondef('public.seed_releases(jsonb)')` contains `master_id`; `get_friend_crate` def contains
  `r.master_id`.
- `get_advisors` security: no new lint (get_friend_crate keeps the expected 0029 class; no new exposure).
- Sanity: `select count(*) filter (where master_id is not null) as have_master, count(*) as total from
  public.releases;` (expect have_master=0 pre-backfill — fills as re-syncs/enrich run).

---

## Task 2 — Edge: capture master_id (break-glass deploys)

### 2a — `import-collection` seed carries `master_id`
The `Bi` type + the seed row. FIND the `Bi` type (it lists basic_information fields) and add `master_id?: number;`.
Then FIND the `seeds.set(releaseId, { … })` object and add `master_id: bi.master_id || null,` alongside
`cover_image`. **Use `|| null`, not `?? null`** — Discogs returns `master_id: 0` (not null/absent) for releases
with no master, and `|| null` normalizes that `0` to null so no-master rows read as exact-only.
(`basic_information.master_id` is present on both collection and wantlist items — free.) Deploy
`import-collection` via break-glass (include `functions/_shared/discogs.ts`; `verify_jwt` stays false).

### 2b — `enrich-release` captures `master_id`
FIND the main `admin.from('releases').update({ tracks: tracklist, country: … , … })` and add
`master_id: (rel.master_id as number) || null,` (**`|| null`** — normalizes Discogs' no-master `0` to null,
same as the import path). (The tombstone/404 update leaves master_id untouched/null — correct.)
Deploy `enrich-release` via break-glass.

(Optional accelerant, NOT in this wave: broaden `pending_enrichment` to also gate on `master_id is null` for a
systematic background fill. Not needed for correctness — organic fill + graceful exact fallback covers it.)

---

## Task 3 — `public/boot.js`: the setting + master data

### 3a — read match_mode + expose it
- FIND the `ensureProfile` profiles `.select('display_name, avatar_url, bio, location, collecting_since, link1,
  link2, crate_visibility, wantlist_visibility')` and append `, match_mode`.
- Where the viewer's own `profile` is in hand at boot (after ensureProfile, before routing), set the global the
  renderer reads: `window.__twMatchMode = (profile && profile.match_mode) || 'exact';` (set it for BOTH the own
  and friend routes — it's the VIEWER's preference regardless of whose crate is shown).

### 3b — the update path (mirror onSetWantlistVisibility)
Next to `onSetVisibility` (boot.js ~713, the crate-visibility dep — note: it is `onSetVisibility`, NOT
`onSetCrateVisibility`) / `onSetWantlistVisibility` (~718) in the account deps, add:
```js
    onSetMatchMode: async (mode) => {   // #28: viewer's own reading preference; direct update under profiles_update_own RLS
      const { error } = await supabase.from('profiles')
        .update({ match_mode: mode }).eq('user_id', window.Clerk.user.id);
      if (error) throw new Error(error.message);
      window.__twMatchMode = mode;   // reflect immediately so a later crate view reads the new mode
    },
```
(No separate hand-through needed: `renderAccount(profile)` passes the WHOLE profile row into
`accountPageHtml({ profile })`, so once 3a adds `match_mode` to the ensureProfile select, `o.profile.match_mode`
is present automatically — `friendsSection` reads it directly.)

### 3c — master sets in `TraxWaxMatchCtx` (viewer's own) — AND fix the 1,000-row cap
FIND the friend `TraxWaxMatchCtx` (boot.js ~410) and REPLACE its body. Two changes: (1) add master_id via the
releases embed; (2) **paginate both selects** — the current body has NO `.range()`, so PostgREST silently caps
the viewer's own collection/wantlist at 1,000 rows. Lane owns ~1,861, so `viewerHas` is truncated **today** in
v1.12.0 — undercounting YOU-OWN-THIS badges, `theyWant`, and IN COMMON on every friend's crate. (Pre-existing
bug, unrelated to #28 but living in the exact function this task rewrites — **file a GitHub issue** for it, file-
then-close under this version.) Mirror the `.order('id').range(from, from+999)` loop the sibling providers use:
```js
  window.TraxWaxMatchCtx = async () => {
    const me = window.Clerk.user.id;
    const pull = async (table) => {           // paginate — PostgREST caps any select at 1,000 rows
      const ids = new Set(), masters = new Set();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from(table)
          .select('release_id, releases(master_id)').eq('user_id', me)
          .order('id', { ascending: true }).range(from, from + 999);
        if (error) throw new Error('match ctx failed (' + table + '): ' + error.message);
        for (const r of data ?? []) { ids.add(r.release_id); const m = r.releases && r.releases.master_id; if (m) masters.add(m); }
        if (!data || data.length < 1000) break;
      }
      return { ids, masters };
    };
    const [w, c] = await Promise.all([pull('wantlist_items'), pull('collection_items')]);
    return {
      viewerWants: w.ids, viewerWantsMasters: w.masters,
      viewerHas:   c.ids, viewerHasMasters:   c.masters,
    };
  };
```
(`if (m)` — not `!= null` — so Discogs' no-master sentinel `0` never enters the master sets.)

### 3d — `TraxWaxOwnerWantIds` → owner wantlist entries {id, master}
The theyWant any-pressing count must iterate the owner's wantlist records (id + master) so a record matched
both ways isn't double-counted. Change the provider to return an **array of `{id, master}`** (still id-only
weight + master), and rename the global to `__twOwnerWants`. REPLACE the provider:
```js
  window.TraxWaxOwnerWantIds = async () => {
    if (owner._canViewWantlist !== true) return [];   // wantlist private → unknown, not zero
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('wantlist_items')
        .select('release_id, releases(master_id)').eq('user_id', owner.user_id).order('id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error('friend wantlist-ids query failed: ' + error.message);
      for (const it of data ?? []) out.push({ id: it.release_id, master: (it.releases && it.releases.master_id) || null });
      if (!data || data.length < 1000) break;
    }
    return out;
  };
```
(bootCrate stores it in `window.__twOwnerWants` — see Task 4d; keep the awaited-at-boot pattern.)

### 3e — master_id on the friend crate + wantlist rows
- Friend `TraxWaxData` (get_friend_crate consumer): the RPC now returns `master_id`; add `master_id: it.master_id || null,`
  to the mapped record.
- Friend `TraxWaxWantlistData`: add `releases ( … , master_id )` to its select and `master_id: rel.master_id || null,`
  to the mapped record (so WHERE-YOU-OVERLAP (b) rows carry master for badge classification).
- (`|| null` throughout — never store/carry Discogs' no-master `0`.)

---

## Task 4 — `public/app.js`: mode-aware matching

### 4a — the mode helper
Add near `_matchCounts` (module-level):
```js
const MATCH_ANY = () => window.__twMatchMode === 'any';   // #28: viewer's reading preference (default 'exact')
```

### 4b — `_matchCounts` counts exact OR (any-pressing) master matches
REPLACE `_matchCounts` so each direction counts a record when its release matches OR (any-mode) its master
matches — iterating records so nothing double-counts. `youWant` iterates `RECORDS` (friend crate);
`theyWant` iterates `window.__twOwnerWants` ({id,master} entries). PRIVATE stays flag-driven (null):
```js
function _matchCounts(){
  const ctx = window.__twMatchCtx;
  const any = MATCH_ANY();
  const out = { youWant: null, theyWant: null };
  if (CAN_VIEW_CRATE()){
    let n = 0;
    if (ctx && ctx.viewerWants) for (const r of (RECORDS||[]))
      if (ctx.viewerWants.has(r.id) || (any && r.master_id && ctx.viewerWantsMasters && ctx.viewerWantsMasters.has(r.master_id))) n++;
    out.youWant = n;
  }
  if (CAN_VIEW_WANTLIST()){
    let n = 0; const ow = window.__twOwnerWants;
    if (ctx && ctx.viewerHas && Array.isArray(ow)) for (const e of ow)
      if (ctx.viewerHas.has(e.id) || (any && e.master && ctx.viewerHasMasters && ctx.viewerHasMasters.has(e.master))) n++;
    out.theyWant = n;
  }
  return out;
}
```

### 4c — `badgesFor`: exact (solid) vs any-pressing (outlined) — kit §1.3
REPLACE `badgesFor` so a record badges exact-first, then master-only (any mode). Kinds: `you` (accent fill),
`you-outline` (accent outline, "A PRESSING YOU WANT"), `both` (ink fill), `both-outline` (ink outline,
"YOU OWN A PRESSING"):
```js
function badgesFor(rec, ctx){
  if (!ctx) return [];
  const any = MATCH_ANY(); const m = rec.master_id;
  const out = [];
  if (ctx.viewerWants && ctx.viewerWants.has(rec.id))                          out.push({ kind:'you',         label:'ON YOUR WANTLIST' });
  else if (any && m && ctx.viewerWantsMasters && ctx.viewerWantsMasters.has(m)) out.push({ kind:'you-outline', label:'A PRESSING YOU WANT' });
  else if (ctx.viewerHas && ctx.viewerHas.has(rec.id))                          out.push({ kind:'both',        label:'YOU OWN THIS' });
  else if (any && m && ctx.viewerHasMasters && ctx.viewerHasMasters.has(m))     out.push({ kind:'both-outline',label:'YOU OWN A PRESSING' });
  if (ctx.forSale && ctx.forSale.has(rec.id))                                   out.push({ kind:'else',        label:'FOR SALE' });
  return out;
}
```
(Order matches the current exact-first want-then-have grammar; the two any-pressing rows only fire in any mode
and only when there's a master and no exact match.) Add the two outline kinds to `BADGE_CLASS`:
```js
const BADGE_CLASS = { you: 'tw-badge-you', both: 'tw-badge-both', else: 'tw-badge-else',
  'you-outline': 'tw-badge-you-outline', 'both-outline': 'tw-badge-both-outline' };
```

### 4d — bootCrate: store __twOwnerWants + reset; unchanged await pattern
Rename the reset + load global from `__twOwnerWantIds` to `__twOwnerWants`:
- The bootCrate friend load (from #43): `window.__twOwnerWants = null;` reset and
  `try { window.__twOwnerWants = await window.TraxWaxOwnerWantIds(); } catch(e){ window.__twOwnerWants = []; }`.
  (Grep for the old `__twOwnerWantIds` name and update ALL references: `_matchCounts` (line 58), the stale
  comment at line 525 ("…it uses `__twOwnerWantIds`…" — reword to `__twOwnerWants`), and bootCrate reset (1445)
  + load (1451). The load's catch initializer changes from `= new Set()` to `= []` — the global is now an array.)

### 4e — `_overlapRecords`: include any-pressing matches + carry the badge kind
REPLACE so it mirrors `badgesFor`'s exact/any classification for both halves (uses `deco` on the raw rows):
```js
function _overlapRecords(){
  const ctx = window.__twMatchCtx; if (!ctx) return [];
  const any = MATCH_ANY(); const out = [];
  for (const r of (RECORDS||[])){
    if (ctx.viewerWants && ctx.viewerWants.has(r.id)) out.push({ rec:r, kind:'you' });
    else if (any && r.master_id && ctx.viewerWantsMasters && ctx.viewerWantsMasters.has(r.master_id)) out.push({ rec:r, kind:'you-outline' });
  }
  if (Array.isArray(WANTLIST_RECORDS)) for (const r of WANTLIST_RECORDS){
    if (ctx.viewerHas && ctx.viewerHas.has(r.id)) out.push({ rec:r, kind:'both' });
    else if (any && r.master_id && ctx.viewerHasMasters && ctx.viewerHasMasters.has(r.master_id)) out.push({ rec:r, kind:'both-outline' });
  }
  return out;
}
```
And `overlapPanelHtml`'s `badge(kind)` (from Wave A) gains the two outline variants (panel-fill + colored rule):
```js
  const badge = (kind) => ({
    both:          '…background:var(--ink); color:var(--bg)…YOU OWN THIS',
    'both-outline':'…background:var(--panel); color:var(--ink); border:1.5px solid var(--ink)…YOU OWN A PRESSING',
    you:           '…background:var(--accent); color:var(--on-accent)…ON YOUR WANTLIST',
    'you-outline': '…background:var(--panel); color:var(--accent); border:1.5px solid var(--accent)…A PRESSING YOU WANT',
  }[kind]);
```
(Executor: expand each to the full `<span style="…9px mono 800…">LABEL</span>` like Wave A's two, with the
fill/outline per the map. Keep the same 9px/padding.)

### 4f — want-control: a "you own it" card hides inline + WANT; the modal keeps it for own-a-pressing (kit §1.4)
Define one shared helper (module-level, next to `MATCH_ANY`):
```js
// True when the VIEWER owns this record exactly, or (any mode) owns a different pressing of the same master.
function _viewerOwns(r){
  const ctx = window.__twMatchCtx; if (!ctx || !ctx.viewerHas) return false;
  return ctx.viewerHas.has(r.id) || (MATCH_ANY() && r.master_id && ctx.viewerHasMasters && ctx.viewerHasMasters.has(r.master_id));
}
```
Apply it in the two friend-facing surfaces (owner branches unchanged):

**`metaCellHtml` — TWO `!IS_OWN` branches, both need the guard:**
- The **wantlist** branch (line 362) already returns '' on `ctx.viewerHas.has(r.id)` → REPLACE that condition
  with `_viewerOwns(r)` (now also covers own-a-pressing).
- The **crate** branch (lines 371-375) has **no own-guard at all today** — so even an exact "YOU OWN THIS" card
  currently shows `+ WANT`, inconsistent with the wantlist tab and the modal, which both suppress it. Insert,
  right after `const ctx = window.__twMatchCtx;` (line 371) and before the `wanted` line:
  `if (_viewerOwns(r)) return '';`
  This is a **behavior change to the exact case** (an exact-owned record on a friend's crate stops showing
  `+ WANT`), made to match the wantlist tab + modal + the card's own "YOU OWN THIS" badge. **Flag to Lane at
  review** (UX change — CLAUDE.md L5) — it's a consistency fix, not just #28, but it lands here because #28's kit
  §1.4 makes card-level own-suppression a stated requirement.

**`wantControlHtml` (line 344, the `!IS_OWN` branch)** — the modal. Exact "YOU OWN THIS" stays suppressed (line
344 unchanged, `if (ctx.viewerHas && ctx.viewerHas.has(r.id)) return '';`). For own-a-pressing, the modal
**keeps** `+ ADD TO WANTLIST` (kit §1.4 — the purist can still want the specific pressing), so add NOTHING here:
`wantControlHtml` is only ever called with `inModal=true` (line 964) + the own-crate path, so the any-pressing
suppression must NOT live here. (The inline suppression is entirely in `metaCellHtml`, which is card-only.)

(The `+ WANT` toggle for records you neither own nor want is unchanged. `friendAdd`/`friendRemove` always act on
the exact release — unchanged.)

### 4g — the match sentence is unchanged
`_matchPart` + the strip already read the (now mode-aware) `_matchCounts`; the counts grow in any mode with no
wording change (kit §1.3 "no mode tag on the strip"). Nothing to edit here beyond 4b.

---

## Task 5 — `public/boot.ui.js`: the MATCHING account section (segmented control)

Add a **MATCHING** section to `friendsSection(o)` directly under the VISIBILITY block (after the two visibility
rows, before `sectionLabel('INVITE A FRIEND')`). Reuse `sectionLabel` + the bordered-row pattern; a two-label
**segmented** control (not a toggle), default reads `o.profile.match_mode || 'exact'`:
```js
    sectionLabel('MATCHING') +
    '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; border:1.5px solid var(--line); padding:16px 18px">' +
      '<div style="display:flex; flex-direction:column; gap:3px">' +
        '<span style="' + COND + '; font-size:21px; font-weight:700; line-height:1; color:var(--ink)">How overlaps are counted</span>' +
        '<span style="' + MONO + '; font-size:10.5px; color:var(--muted)">Changes how you read matches on everyone’s crate. Doesn’t change what you add.</span>' +
      '</div>' +
      // segmented EXACT | ANY (mono, bordered; selected = ink fill). Two <button data-mm> segments.
      '<div id="tw-match-seg" role="group" aria-label="Matching mode" style="display:flex; border:1.5px solid var(--line); flex:none">' +
        segBtn('exact', 'EXACT PRESSING', mm) + segBtn('any', 'ANY PRESSING', mm) +
      '</div>' +
    '</div>' +
```
where `mm = (o.profile && o.profile.match_mode) || 'exact'` (compute at the top of `friendsSection` next to
`vis`), and a small local helper:
```js
  function segBtn(v, label, cur){
    const on = cur === v;
    return '<button data-mm="' + v + '" aria-pressed="' + on + '" style="' + MONO + '; font-size:10.5px; ' +
      'letter-spacing:.06em; padding:8px 12px; border:0; cursor:pointer; ' +
      (on ? 'background:var(--ink); color:var(--panel)' : 'background:var(--panel); color:var(--muted)') + '">' + label + '</button>';
  }
```
Helper text under the row (kit §1.1: "EXACT — the same pressing on both lists (the default). ANY — any pressing
of the same album counts.") — render as a mono `--faint` line below the bordered row.

Wire it (mirror `wireWlVisToggle`) — a `wireMatchSeg()` that delegates clicks on `#tw-match-seg [data-mm]`:
```js
  function wireMatchSeg(){
    const seg = root.querySelector('#tw-match-seg'); if (!seg) return;
    seg.addEventListener('click', async (e)=>{
      const b = e.target.closest('[data-mm]'); if (!b) return;
      const mode = b.getAttribute('data-mm');
      const smsg = (t)=>{ const el=$('tw-share-msg'); if(el) el.textContent=t||''; };
      try {
        await deps.onSetMatchMode(mode);
        seg.querySelectorAll('[data-mm]').forEach((x)=>{ const on=x.getAttribute('data-mm')===mode;
          x.setAttribute('aria-pressed', on);
          x.style.background = on ? 'var(--ink)' : 'var(--panel)'; x.style.color = on ? 'var(--panel)' : 'var(--muted)'; });
        smsg(mode==='any' ? 'Matching any pressing now.' : 'Matching exact pressings now.');
      } catch(e){ smsg('Couldn’t change that: ' + ((e && e.message) || e)); }
    });
  }
  wireMatchSeg();
```
(Add `onSetMatchMode` to the `deps` typedef comment near line 252. `friendsSection` is the account render — the
MATCHING control shows only on the owner's own account page, which is correct: it's the viewer's own setting.)

---

## Task 6 — `public/styles.css`: outlined badge variants
Next to `.tw-badge-you` / `.tw-badge-both`, add (panel fill + colored rule, mirroring `.tw-badge-else`'s outline
idiom):
```css
.tw-badge-you-outline  { background:var(--panel); color:var(--accent); border:1.5px solid var(--accent); }
.tw-badge-both-outline { background:var(--panel); color:var(--ink);    border:1.5px solid var(--ink); }
```
(The base `.tw-badge` padding is `3px 6px`; a 1.5px border shifts size ~3px — acceptable, matches `.tw-badge-else`.
Confirm the strip still sits flush on the cover right-edge; nudge padding to `2px 5px` on the outline variants if
it grows the strip visibly.)

---

## Backfill / rollout
No forced pass. `master_id` fills via: (1) any user's **re-sync** (import seed, basic_information — fast, Lane's
own ~1,861 in one import pass); (2) **enrich** capturing it as records enrich/refresh. Un-backfilled rows read
exact-only (kit §1.5), so any-pressing simply strengthens as the catalog fills. Optional later accelerant:
broaden `pending_enrichment` to `master_id is null`.

## Deploy sequencing
Migration `0024` is additive (columns + `create or replace`), safe to apply first. Deploy `import-collection`
+ `enrich-release`. Then the frontend push. The frontend reads `master_id`/`match_mode` defensively (null →
exact), so a brief gap between migration and frontend is harmless. Ordering: migration → 2 Edge deploys →
frontend push. (Recommend Lane re-syncs once after, to fill his own master_ids and see any-pressing light up.)

## Rollback
Revert the frontend commit. Edge: redeploy prior enrich/import (or leave — the extra master_id write is inert
without the frontend). Columns/RPC changes are additive; leave them (harmless) or revert `seed_releases`/
`get_friend_crate` to their 0021/0010 forms and drop the two columns.

## Audit plan
remediation-audit Pass-1 (break this): master_id capture is correct (seed merge empty-guarded; enrich sets it;
null-safe everywhere); ANY mode never leaks a non-consented crate (RLS unchanged; master sets are the viewer's
OWN data); exact mode is byte-unchanged (MATCH_ANY false → all the `any &&` branches dead → identical to
v1.12.0); no double-count in `_matchCounts` (iterate-records, exact-first); badges pick exactly one kind
(exact-first, then master, else nothing); "YOU OWN A PRESSING" hides the inline + WANT but the modal keeps it;
the segmented control writes match_mode (RLS + guard allow it) and re-renders; the `__twOwnerWantIds →
__twOwnerWants` rename has no stragglers; the profiles select carries match_mode; owner crate + exact-mode
friend crate unregressed. Narrow Pass-2 over rework. Converge.

---

## STATUS — EXECUTED (v1.13.0, 2026-09-03)
Shipped. Migration 0024 applied via break-glass; import-collection (v8) + enrich-release (v7) redeployed;
frontend built across boot.js/app.js/boot.ui.js/styles.css. Verification-pass folded 4 MEDIUM + 4 LOW pre-build.
Adversarial audit (remediation-audit) Pass-1 found 2 MAJOR INTRODUCED — the `matches()` matchFilter was
exact-only (count↔grid disagreement in ANY mode) and the 0024 `.sql` file was missing from the tree — both
fixed; MEDIUM (card/modal own-a-pressing divergence) confirmed intended (kit §1.4); LOW-1 (badgesFor reorder)
rejected as it would break count↔badge agreement; LOW-2 comment fixed. Pass-2 over the rework: CLEAN → converged.
Also filed #49 (TraxWaxMatchCtx 1,000-row cap, pre-existing, fixed here). Commit closes #28, #49.
