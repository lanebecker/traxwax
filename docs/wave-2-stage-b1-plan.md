# Wave 2 — Stage B1 plan: the match matrix + THE WANTLIST view (read path)

**Status:** DRAFT — awaiting the verification pass, then Lane's review + break-glass.
**Scope:** Stage B1 = the entire **read** path that makes the wantlist visible. **ADD TO WANTLIST
(the first Discogs write) is Stage B2** — not here.

**Decisions locked (Lane, 2026-08-31):**
1. **Separate `wantlist_visibility`** toggle, independent of `crate_visibility` (its own consent + RLS).
2. **Read-first** staging (this is B1; the Discogs write is B2).
3. **THE WANTLIST is a 4th top-level tab** (THE CRATE / THE TIMELINE / THE LEDGER / THE WANTLIST),
   shown only on your **own** crate.

**Delivery:** migration `0018` (break-glass) + **frontend only** — no Edge Function deploys (the match
RPC is browser-callable; first-connect wantlist import reuses the already-deployed `import-collection`).

**Proposed version:** `v1.5.0` — the user-facing "Wantlists & the match matrix" cut. Confirm at ship.

---

## The consent model (the load-bearing design)

Two independent gates:
- **Crate** (`crate_visibility` + `private.can_view_crate`, shipped Wave 1) — governs seeing someone's
  **collection** (their haves).
- **Wantlist** (`wantlist_visibility` + `private.can_view_wantlist`, NEW here) — governs seeing someone's
  **wantlist** (their wants).

The WANT/HAVE **badges** on a friend's crate match **your own** wants/haves against the friend's
displayed records — so they need **no** consent gate (your own data). The one consented read is
**"they want, you have"** — the friend's wantlist ∩ your collection — used only in the MATCHES stat.

---

## Task 1 — Migration `supabase/migrations/0018_wantlist_match.sql` (break-glass: apply_migration)

**Pre-apply check (read-only):** confirm base is `0017`:
```sql
select max(version) from supabase_migrations.schema_migrations;   -- expect 20260831... (0017)
```

**Migration — complete contents:**
```sql
-- 0018_wantlist_match.sql — Wave 2 Stage B1: wantlist visibility + the match RPC (read path).
-- Depends on 0017 (wantlist_items). Mirrors the Wave 1 crate-consent shape exactly, for wantlists.

-- ── wantlist_visibility on profiles (independent of crate_visibility). Extensible like
--    crate_visibility (0012): Wave 5 adds 'public' by amending this CHECK. ─────────────────────
alter table public.profiles
  add column if not exists wantlist_visibility text not null default 'private';
alter table public.profiles
  drop constraint if exists profiles_wantlist_visibility_chk;
alter table public.profiles
  add constraint profiles_wantlist_visibility_chk
  check (wantlist_visibility in ('private','friends'));   -- Wave 5: add 'public' here
-- User-writable via the existing profiles_update_own policy (the 0007 guard forces only
-- OAuth-owned columns; wantlist_visibility is user-owned, exactly like crate_visibility).

-- ── private.can_view_wantlist: the wantlist choke point. Mirrors private.can_view_crate (0013)
--    but gates on wantlist_visibility. In the `private` schema so PostgREST does NOT expose it as
--    a probeable friendship-graph RPC (the 0013 lesson). ───────────────────────────────────────
create or replace function private.can_view_wantlist(p_viewer text, p_owner text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    p_viewer = p_owner
    or exists (
      select 1
        from public.profiles pr
        join public.friendships f
          on f.user_id = p_viewer and f.friend_id = p_owner
       where pr.user_id = p_owner
         and pr.wantlist_visibility = 'friends'
    );
$$;
revoke all on function private.can_view_wantlist(text, text) from public, anon;
grant execute on function private.can_view_wantlist(text, text) to authenticated, service_role;

-- ── wantlist_items: friend-readable SELECT under the wantlist gate. ORed with wantlist_select_own
--    (0017). Same posture as collection_select_friends (0013). ────────────────────────────────
create policy wantlist_select_friends on public.wantlist_items
  for select using (private.can_view_wantlist(auth.jwt()->>'sub', user_id));

-- ── crate_match: browser-callable match counts for the MATCHES stat. SECURITY DEFINER so it can
--    read both parties' rows under the consent gates. Returns NULLs (never distinguishes "no such
--    user" from "not shared") so it is not an existence/friendship probe. ──────────────────────
--    you_want_they_have: your wantlist ∩ their collection — gated on can_view_crate.
--    they_want_you_have: their wantlist ∩ your collection — gated on can_view_wantlist.
create or replace function public.crate_match(p_owner_username text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_sub   text := auth.jwt()->>'sub';
  v_owner text;
  v_ywth  int;
  v_twyh  int;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  select user_id into v_owner from public.profiles
   where lower(discogs_username) = lower(p_owner_username);
  -- Uniform null result for "no such user" AND "own crate" AND "not shared": never leak existence.
  if not found or v_owner = v_sub then
    return jsonb_build_object('status','ok','you_want_they_have',null,'they_want_you_have',null);
  end if;
  if private.can_view_crate(v_sub, v_owner) then
    select count(*) into v_ywth
      from public.wantlist_items myw
      join public.collection_items theirc
        on theirc.release_id = myw.release_id and theirc.user_id = v_owner
     where myw.user_id = v_sub;
  end if;
  if private.can_view_wantlist(v_sub, v_owner) then
    select count(*) into v_twyh
      from public.wantlist_items theirw
      join public.collection_items myc
        on myc.release_id = theirw.release_id and myc.user_id = v_sub
     where theirw.user_id = v_owner;
  end if;
  return jsonb_build_object('status','ok','you_want_they_have',v_ywth,'they_want_you_have',v_twyh);
end;
$$;
revoke all on function public.crate_match(text) from public, anon;
grant execute on function public.crate_match(text) to authenticated;
```

**Post-apply verification (read-only):**
```sql
-- column + check + policy + functions exist
select column_default from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name='wantlist_visibility';  -- 'private'
select policyname from pg_policies where tablename='wantlist_items';   -- wantlist_select_own, wantlist_select_friends
select has_function_privilege('authenticated','public.crate_match(text)','execute');            -- true
select has_function_privilege('anon','private.can_view_wantlist(text,text)','execute');          -- false
```
Plus the rolled-back match probe (Task 5) and `get_advisors` (expect no new lint). Write the file to
the repo (committed after apply).

---

## Task 2 — `public/boot.js` providers

**(2a) Own-crate wantlist data provider.** In `installCrateProviders(profile)` (the own-crate provider
installer, defined at `boot.js:178`, called at **`boot.js:1019`** in the own-crate render path), add a
`window.TraxWaxWantlistData` alongside the existing `window.TraxWaxData`, paginated + mapped
IDENTICALLY to `TraxWaxData` but from `wantlist_items` and scoped to the OWN user:

```js
  window.TraxWaxWantlistData = async () => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('wantlist_items')
        .select('release_id, added, ' +
          'releases ( artist, title, year, label, styles, genres, thumb, cover_image )')
        .eq('user_id', profile.user_id)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error('wantlist query failed: ' + error.message);
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

**(2b) Friend-crate match context + counts.** In `installFriendCrateProviders(owner)`
(**`boot.js:280`**), after `window.TraxWaxData` is installed (~:331), add two providers:

```js
  // Wave 2 B1: the VIEWER's own wants + haves as id Sets — the badges match these against the
  // friend's displayed records (own data, no consent gate). Loaded once when the friend crate mounts.
  window.TraxWaxMatchCtx = async () => {
    const me = window.Clerk.user.id;                 // the VIEWER's own sub — NOT owner.user_id
    const [w, c] = await Promise.all([
      supabase.from('wantlist_items').select('release_id').eq('user_id', me),
      supabase.from('collection_items').select('release_id').eq('user_id', me),
    ]);
    if (w.error || c.error) throw new Error('match ctx failed');
    return {
      viewerWants: new Set((w.data ?? []).map((r) => r.release_id)),
      viewerHas:   new Set((c.data ?? []).map((r) => r.release_id)),
    };
  };
  // The MATCHES stat counts (consent-gated server-side; nulls when not shared).
  window.TraxWaxMatchCounts = async () => {
    const { data, error } = await supabase.rpc('crate_match', { p_owner_username: owner.discogs_username });
    if (error) return null;
    return data;   // { status, you_want_they_have, they_want_you_have }
  };
```
(**CRITICAL — both reads MUST scope to the viewer with `.eq('user_id', me)`.** `collection_items` and
`wantlist_items` each carry a friend-read policy (`collection_select_friends` 0013;
`wantlist_select_friends` 0018), so an UNSCOPED select returns the viewer's rows **UNION every
friend-shared row they can see — including the very owner's whole collection** → `YOU OWN THIS` on every
card, and other friends' wants mislabeled `ON YOUR WANTLIST`. This is the v1.4.2 `boot.js:203` leak
class. `owner.user_id` is the FRIEND — never use it for the viewer's own sets. Caught by the B1
verification pass.)

**(2c) First-connect wantlist import** (Stage A audit MINOR-1). The wantlist currently imports only on
RE-SYNC (`tw_wantlist_due` set in `onResync`, **boot.js:588**, flag at **:592**). To also import it the
first time — via ANY first-import path, not just a fresh `runImport` — set the SAME flag at the TOP of
the `if (!profile.last_import_at) {` block (**boot.js:959**), so the existing flag-check at
**:1009-1015** (own-crate path) fires `wantlistImportLoop` after whichever branch runs: interrupted
resume (:986), fresh first import (:996), OR the already-populated `count>0` branch (:993, which does
**not** call `runImport` — the path Stage A's fix would have missed). This first-import path does NOT
reload (unlike onResync), so the flag set at :959 is read at :1009 in the same render pass; it's
idempotent if it fires on a couple of loads before `last_import_at` is set. Insert:
```js
  if (!profile.last_import_at) {
    try { sessionStorage.setItem('tw_wantlist_due', '1'); } catch (e) {}   // Wave 2 B1: first-connect wantlist import
```
Confirm the exact block line at execution.

---

## Task 3 — `public/app.js` THE WANTLIST tab + badges + MATCHES stat

**(3a) Wantlist dataset + lazy load.** Add near `RECORDS` (`app.js:166`):
```js
let WANTLIST_RECORDS = null;   // null = not yet loaded; [] = loaded-empty
```
`computeVals()` (`app.js:375`) currently reads `RECORDS`. Change its source line to switch on the view:
```js
  const source = (state.view === 'wantlist' && WANTLIST_RECORDS) ? WANTLIST_RECORDS : RECORDS;
```
and use `source` everywhere `computeVals` currently reads `RECORDS` for the record set (confirm each
`RECORDS` reference inside `computeVals` at execution; the modal helpers at `:616/:810/:874` are NOT in
computeVals and stay on `RECORDS`).

**(3b) The 4th tab (own crate only).** The tab bar (`app.js:554`) is
`${tab('crate','THE CRATE')}${tab('timeline','THE TIMELINE')}${tab('ledger','THE LEDGER')}`. Append,
gated on own crate:
```js
${IS_OWN() ? tab('wantlist','THE WANTLIST') : ''}
```
The `view` action handler (`app.js:865`, `case 'view'`) must lazy-load the wantlist on first switch:
```js
    case 'view':
      state.view = arg;
      if (arg === 'wantlist' && WANTLIST_RECORDS === null && window.TraxWaxWantlistData) {
        WANTLIST_RECORDS = [];                       // guard against re-entry while loading
        track('view_change', { view: arg });
        window.TraxWaxWantlistData().then((rows) => { WANTLIST_RECORDS = rows; render(); })
          .catch((e) => { console.warn('wantlist load failed', e); WANTLIST_RECORDS = null; });
        render();                                    // immediate: shows the (empty) loading state
        break;
      }
      track('view_change', { view: arg });
      render();
      break;
```
(Baked/local-dev mode has no `TraxWaxWantlistData`; the guard `window.TraxWaxWantlistData &&` makes the
tab a no-op there — acceptable, THE WANTLIST is a DB-mode feature. Alternatively hide the tab unless
`DB_MODE()`; prefer `IS_OWN() && DB_MODE()` on the tab at 3b.)

**(3c) WANT/HAVE badges on a friend crate.** In the card render, the cover wrapper
(`app.js:265`, `position:relative`) holds the `JUST IN` badge (`:269`). After it, add:
```js
      ${badgesHtml(badgesFor(r, window.__twMatchCtx || null))}
```
`__twMatchCtx` is set (once) when a friend crate mounts — see 3d. On the own crate it stays null →
`badgesFor` returns `[]` → no badges. (`badgesHtml`/`badgesFor` already exist, `:340/:346`.)

**(3d) Load match ctx + counts when a friend crate boots.** In `bootCrate()` (`app.js:930`), in the
DB-mode branch, after `RECORDS = await window.TraxWaxData()` (`:939`), when NOT own:
```js
  // Reset first (defensive, N1): a stale friend-crate ctx must never render badges on the own crate.
  window.__twMatchCtx = null; window.__twMatchCounts = null;
  if (!IS_OWN() && window.TraxWaxMatchCtx) {
    try { window.__twMatchCtx = await window.TraxWaxMatchCtx(); } catch (e) { window.__twMatchCtx = null; }
    try { window.__twMatchCounts = await window.TraxWaxMatchCounts(); } catch (e) { window.__twMatchCounts = null; }
  }
```
(Awaited here because the badges + stat need it before first render; both are small single-round-trip
reads. If either fails, badges/stat degrade to absent.)

**(3e) MATCHES stat cells on the friend header.** The header stat strip (`app.js:526`, the `IN CRATE`
cell and siblings) shows cells only relevant to the crate. On a friend crate (`!IS_OWN()`), append two
cells (hairline-divider pattern, §9.2) from `window.__twMatchCounts` when present and non-null:
```js
${(!IS_OWN() && window.__twMatchCounts && window.__twMatchCounts.you_want_they_have != null)
  ? `<span style="padding:6px 10px; border-right:1.5px solid #16171a">YOU WANT ${window.__twMatchCounts.you_want_they_have} THEY HAVE</span>` : ''}
${(!IS_OWN() && window.__twMatchCounts && window.__twMatchCounts.they_want_you_have != null)
  ? `<span style="padding:6px 10px; border-right:1.5px solid #16171a">THEY WANT ${window.__twMatchCounts.they_want_you_have} YOU HAVE</span>` : ''}
```
(Each cell appears only when its count is non-null, i.e. that direction is consented. `null` → the cell
is omitted, never shown as 0.) Exact cell placement/copy to be reviewed against the design at execution.

`node --check public/app.js public/boot.js` after the edits.

---

## Task 4 — `public/boot.ui.js` + `public/boot.js`: the wantlist-visibility toggle

**(4a)** In `friendsSection(o)` (`boot.ui.js:432`), the VISIBILITY section (`:451-462`) has one toggle
(`tw-vis-toggle`, reads `o.profile.crate_visibility`). Add a SECOND toggle immediately below it, reading
`o.profile.wantlist_visibility`:
```js
    '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; ' +
      'border:1.5px solid var(--line); border-top:0; padding:16px 18px">' +
      '<div style="display:flex; flex-direction:column; gap:3px">' +
        '<span style="' + COND + '; font-size:21px; font-weight:700; line-height:1; ' +
          'color:var(--ink)">Friends can see my wantlist</span>' +
        '<span id="tw-wlvis-sub" style="' + MONO + '; font-size:10.5px; color:var(--muted)">' +
          'Independent of your crate · currently ' + (wlOn ? 'ON' : 'OFF') + '</span>' +
      '</div>' +
      toggle({ id: 'tw-wlvis-toggle', on: wlOn, label: 'Friends can see my wantlist' }) +
    '</div>' +
```
with `const wlOn = ((o.profile && o.profile.wantlist_visibility) || 'private') === 'friends';` beside
the existing `vis`/`on` (`:433-434`). Wire its handler in `bindAccountPage` (mirror the `tw-vis-toggle`
binding) to call `deps.onSetWantlistVisibility(newValue)` (callbacks live on `deps`, not `o` — boot.ui.js:726) and update `#tw-wlvis-sub`. Confirm the exact
`bindAccountPage` binding site at execution.

**(4b)** In `boot.js`, the account wiring passes `onSetVisibility` (`boot.ui.js:252` documents it). Add a
sibling `onSetWantlistVisibility: async (v) => { const { error } = await supabase.from('profiles')
.update({ wantlist_visibility: v }).eq('user_id', window.Clerk.user.id); if (error) throw new
Error(error.message); }` (mirror the existing `onSetVisibility` implementation exactly — find it in
boot.js's account provider block and copy its shape). Also add `wantlist_visibility` to the profile
`select(...)` wherever the account page reads the profile, and to `ownerInfo`'s projection if the toggle
reads it from there. Confirm exact sites at execution.

---

## Task 5 — Verification (break-glass execute_sql, rolled back; + local)

**Match-RPC state matrix** (rolled back). Build viewer V + owner F with known overlaps and both
visibility flags, then call `crate_match` **as V** (`set local role authenticated` + jwt claims, as in
Stage A's EXPLAIN probe):
- **Both shared, overlaps:** V wants {a,b}, F has {b,c}; F wants {c,d}, V has {d,e}; F.crate=friends,
  F.wantlist=friends, friendship both ways → `you_want_they_have = 1` (b), `they_want_you_have = 1` (d).
- **Crate shared, wantlist private:** `you_want_they_have` = the count; `they_want_you_have = null`.
- **Not friends:** both `null` (no leak).
- **Own username:** both `null`, status ok (no self-match).
- **Nonexistent username:** both `null`, status ok (indistinguishable from not-shared — no existence leak).
- **RLS:** as V (authenticated, jwt=V), `select … from wantlist_items where user_id = F` returns rows
  ONLY when F.wantlist_visibility='friends' AND the friendship exists; 0 rows otherwise.

**Local:** `node --check public/app.js public/boot.js`; render-preview or targeted read of the 4th tab +
badge + MATCHES-cell HTML.

**Live E2E (post-deploy):** Lane + a friend (Tommy) — toggle wantlist visibility, view each other's
crates, confirm the badges + MATCHES cells appear/hide per consent, and THE WANTLIST tab shows the
owner's wants.

---

## Task 6 — Adversarial audit loop (to convergence — standing rule)

Pass 1 (independent subagent) over the whole B1 diff — migration (esp. `crate_match` leak surface + the
new RLS policy interplay with the own-select policy + `multiple_permissive_policies`), the 4th-tab
source-switch (does any `RECORDS` reader in the render path get missed → wrong dataset?), the badge/ctx
own-vs-friend gating, the MATCHES null-vs-0 handling, the toggle wiring. Then narrow passes until one
converges with no rework (functional spot-checks are NOT a pass — the discipline confirmed this wave).

---

## Task 7 — Version, docs, close, handoff

- `VERSION` → `1.5.0` (confirm; the user-facing wave cut).
- `CHANGELOG.md`, `log.md` (project root), commit `0018` after apply.
- GitHub: file/close the Stage B1 tracking issue; the MINOR-1 first-connect item is resolved here.
- Handoff: Mac `rm -f .git/index.lock && git add -A && git commit -m "…" && git pull --rebase origin main && git push`. **No Edge deploys this stage.** Lane disarms break-glass after the migration.

---

## Verification pass (independent agent, 2026-08-31) — VERDICT after fixes: EXECUTE-READY

**Fixed in this doc:** **(C1, CRITICAL)** `TraxWaxMatchCtx`'s two reads now `.eq('user_id', me)` — an
unscoped select would pull friend-shared rows through `collection_select_friends`/`wantlist_select_friends`
(the v1.4.2 leak class) and fire YOU-OWN-THIS on every friend-crate card. **(M1)** boot.js line refs
corrected (`installFriendCrateProviders` :280, `installCrateProviders` call :1019, `onResync` :588 /
flag :592, first-import :986/:996). **(M2)** first-connect import now flags at the top of the
`!last_import_at` block (:959) so the `count>0` path is covered too. **(M3)** `pg_policies.policyname`.
**(M4)** handler is `deps.onSetWantlistVisibility`. **(N1)** defensive `__twMatchCtx` reset at friend boot.

**Verified CORRECT (do not re-litigate):** `private.can_view_wantlist` mirrors `can_view_crate` exactly;
`crate_match` is NOT an existence/friendship probe (uniform nulls for no-user/own/not-shared) and its
`count(*)`/gating give sound null-vs-0 semantics; `profiles_guard` (0007) does NOT null
`wantlist_visibility`, so the toggle write succeeds; **`computeVals` reads the record set in exactly one
place (`const all=RECORDS`, app.js:378) — the 4th-tab `source`-switch is complete**; badge own-vs-friend
gating via `__twMatchCtx || null` is correct; MATCHES `!= null` shows 0 but omits unconsented; the
account profile read is `ensureProfile`'s select (boot.js:165, add `wantlist_visibility` there);
`onSetVisibility` exists at boot.js:598 as the mirror template; no Stage-B2 (Discogs write) leaked in.

**Open (decide at execution, not blockers):** the failed-wantlist-load state (N2 — avoid the RECORDS
fallback; leave a sentinel/error state) and empty-wantlist copy (N3 — `emptyCrateHtml` speaks in
collection terms). The MATCHES cell divider (N4) is already flagged for design review.

## Self-review (write-plan checklist)

- **Spec coverage:** match RPC (T1) · wantlist consent+RLS (T1) · badges (T3c/d) · MATCHES stat
  (T3e) · THE WANTLIST 4th tab (T3a/b) · wantlist toggle (T4) · first-connect import (T2c) ·
  verification (T5) · audit (T6) · ship (T7). ADD TO WANTLIST (Discogs write) explicitly deferred to B2.
- **Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N"; complete code in each code
  step. (Several "confirm exact line at execution" notes are deliberate — they mark insertions into
  functions whose full body should be re-read at execution, not hand-waved logic.)
- **Name/type consistency:** `wantlist_visibility` values `'private'|'friends'`; RPC `crate_match` fields
  `you_want_they_have`/`they_want_you_have` (null when unconsented); globals `WANTLIST_RECORDS`,
  `__twMatchCtx`, `__twMatchCounts`; view id `'wantlist'` — consistent across T1–T5.
