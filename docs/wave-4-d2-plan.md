# Wave 4 — D2 — the friends-list "Selling N you want" line — plan

Status: DRAFT for verification-pass + Lane review. **Needs break-glass** (`list_friends` RPC replace, migration
`0031`). The deferred piece of Wave 4 Stage 2's decision D. Design: `Design/traxwax-wave4-design/wave-4/SPEC.md`
D2. Lane's scope call (2026-09-04): **Selling → base, skip the activity-pulse tier** (no pulse data exists;
future add). Target **v1.19.0**.

## What D2 is
On the FRIENDS list (Account → SHARING/FRIENDS), each friend's meta line becomes, by priority:
1. **`Selling N you want`** (accent) when the friend is selling ≥1 record you want — an **in-app link** (NO ↗)
   that opens their crate pre-filtered to for-sale ∩ your wants.
2. else the existing base line: **`Sharing their crate`** / **`Not sharing right now`**.
(The SPEC's middle "activity pulse" tier is skipped per Lane — the ladder collapses to selling → base.)

## The one subtlety — count MUST equal the filtered crate (#43)
Clicking the line opens the friend's crate with the **`matchSellingYouWant`** shortcut we shipped in D1
(`state.matchFilter='youWant' + state.forSaleOnly=true`). That crate filter is **match-mode-aware**: in the
viewer's `any` mode, `matches()` counts a for-sale record whose *master* the viewer wants, not just the exact
release (app.js: `viewerWants.has(r.id) || (MATCH_ANY() && r.master_id && viewerWantsMasters.has(r.master_id))`).
D1's header callout `_fsWant` was made master-aware for exactly this reason (the Stage-2 verification-pass fix).
**So D2's `selling_you_want` count must be master-mode-aware too**, or the friends-list number will disagree with
both D1's header and the crate it opens. In the default `exact` mode (everyone today) exact == master, no
difference; the master branch only matters for a viewer who flipped to `any`.

---

## Task 1 — migration `supabase/migrations/0031_list_friends_selling.sql` (break-glass)

`create or replace` `list_friends()` to add a `selling_you_want` field per friend. Body = the live def (verbatim)
+ the new field. The count is consent-gated (`private.can_view_forsale`) and mirrors the crate's youWant∩forSale
predicate, honoring the viewer's `match_mode`.

```sql
-- 0031_list_friends_selling.sql — Wave 4 D2. Add a per-friend "selling_you_want" count to list_friends so the
-- FRIENDS list can show "Selling N you want". The count is consent-gated (can_view_forsale) and mirrors the
-- crate's matchSellingYouWant filter (for-sale ∩ your wants, master-aware in the viewer's 'any' mode) so the
-- friends-list number equals D1's header callout and the crate it opens (#43 count==filter).
create or replace function public.list_friends()
returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  with me as (select auth.jwt()->>'sub' as sub),
       mm as (select coalesce((select match_mode from public.profiles where user_id = (select sub from me)), 'exact') as mode)
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', pr.user_id,
           'discogs_username', pr.discogs_username,
           'display_name', pr.display_name,
           'avatar_url', pr.avatar_url,
           'crate_visibility', pr.crate_visibility,
           'selling_you_want',
             case when private.can_view_forsale((select sub from me), pr.user_id) then (
               select count(distinct ii.release_id)
                 from public.inventory_items ii
                 left join public.releases rii on rii.release_id = ii.release_id
                where ii.user_id = pr.user_id
                  and ii.status = 'for_sale'
                  -- #43 (verification-pass): the crate this count opens renders only the friend's COLLECTION
                  -- (get_friend_crate = collection_items ⋈ releases), and the crate filter + D1's header both
                  -- count over that collection. A for-sale listing NOT in the friend's collection can never be
                  -- a crate card, so it must NOT be counted here, or count > the filtered crate.
                  and exists (select 1 from public.collection_items ci
                               where ci.user_id = pr.user_id and ci.release_id = ii.release_id)
                  and (
                    exists (select 1 from public.wantlist_items wi
                             where wi.user_id = (select sub from me) and wi.release_id = ii.release_id)
                    or ( (select mode from mm) = 'any' and rii.master_id is not null and rii.master_id <> 0
                         and exists (select 1 from public.wantlist_items wi
                                       join public.releases rw on rw.release_id = wi.release_id
                                      where wi.user_id = (select sub from me) and rw.master_id = rii.master_id) )
                  )
             ) else 0 end
         ) order by lower(coalesce(pr.display_name, pr.discogs_username, pr.user_id))), '[]'::jsonb)
    from public.friendships f
    join public.profiles pr on pr.user_id = f.friend_id
   where f.user_id = (select sub from me);
$function$;
```
No grant change (create-or-replace preserves the existing `authenticated` execute grant). Apply via break-glass
(`apply_migration`, name `list_friends_selling`).

### Post-apply verification (read-only connector)
- `list_friends` def contains `selling_you_want`; existing grant unchanged (authenticated execute, no anon).
- Because all users are currently `forsale='friends'` + `match_mode='exact'`: for a real friend pair, call the
  count logic and confirm it equals `|friend for-sale ∩ my wantlist|` (exact). Confirm a non-consented owner
  (temporarily reason via can_view_forsale=false) yields 0 — the `case` returns 0 without running the subquery.
- `get_advisors security`: `list_friends` stays the same expected 0029 class (already flagged); no NEW lint.
- Sanity: the count never exceeds the friend's for-sale size and never counts a release twice (count distinct).

---

## Task 2 — `public/boot.ui.js` — the friends-list line
In `renderFriendsList` (~577-660), the `status` var (~643-645) is the base line. Replace it so a friend selling
≥1 record you want shows the selling line instead:
```js
      const sellN = Number(f.selling_you_want || 0);
      const status = (sharing && sellN > 0)
        ? '<a href="/app/' + encodeURIComponent(uname) + '#selling" style="' + MONO + '; font-size:10.5px; ' +
          'font-weight:700; letter-spacing:.04em; color:var(--accent); text-decoration:none">' +
          'Selling ' + sellN + ' you want</a>'   // in-app link (NO ↗); opens their crate filtered to for-sale ∩ your wants
        : (sharing
          ? '<span style="' + MONO + '; font-size:10.5px; letter-spacing:.04em; color:var(--muted)">Sharing their crate</span>'
          : '<span style="' + MONO + '; font-size:10.5px; letter-spacing:.04em; color:var(--faint)">Not sharing right now</span>');
```
- `sellN` only ever >0 when `sharing` is true (the count is consent-gated server-side, and consent requires
  crate=friends), but the `sharing &&` guard is belt-and-suspenders.
- Number form: SPEC D2 shows a bare numeral ("Selling 2 you want") — a numeral, not spelled out (the spell-out
  rule is for the prose header callout only). Keep the numeral.
- The existing `VIEW CRATE →` action (~646-649) stays as-is.

## Task 3 — `public/app.js` — the `#selling` deep-link in bootCrate
The friends-list link lands on `/app/{username}#selling` (a full navigation). `bootCrate` must detect it and
open the crate pre-filtered. In the hash-restore block (~1525-1534), after the tab logic:
```js
  // Wave 4 D2: the FRIENDS-list "Selling N you want" link deep-links here. Open the crate filtered to
  // for-sale ∩ your wants (the same matchSellingYouWant filter D1's header callout applies). Only on a
  // friend crate whose crate is viewable (for-sale shows on the crate); __twInventory + __twMatchCtx load
  // below, so the flags take effect at first render.
  let _bootSelling = false;
  try { if ((location.hash||'') === '#selling' && !IS_OWN() && CAN_VIEW_CRATE()) { _bootView = 'crate'; _bootSelling = true; } } catch(e){}
```
`_bootView`/`state.view` are set as today. Then, right after `state.view = _bootView;` and the reset at
`state.matchFilter=null` (1513, which runs earlier), apply the filter when `_bootSelling`:
```js
  if (_bootSelling) { state.matchFilter = 'youWant'; state.forSaleOnly = true; }
```
And the URL-normalize (1534) must PRESERVE `#selling` (else it strips it as a non-tab):
```js
  try { history.replaceState(null, '', location.pathname + location.search +
        (_bootSelling ? '#selling' : (_bootView==='crate'?'':'#'+_bootView))); } catch(e){}
```
[Executor: place the `_bootSelling` filter application after line 1531 `state.view = _bootView;`. Confirm
`CAN_VIEW_CRATE()` + `IS_OWN()` are in scope there (they are — used at 1529). `#selling` is not in `_validTabs`,
so line 1530 leaves `_bootView` at its default and the new block overrides — no conflict.]

## Task 4 — `public/boot.js` — confirm `selling_you_want` flows through
`onListFriends` returns the raw `list_friends` rpc `data`, so `f.selling_you_want` reaches `renderFriendsList`
with no change. [Executor: verify `onListFriends` returns `data` as-is (~boot.js:813); no edit expected.]

---

## Post-build verification
- `node --check` boot.ui.js + app.js.
- Live: a friend selling ≥1 record you want shows "Selling N you want" (accent) on the FRIENDS list; clicking
  it lands on their crate with the SHOWING rail already reading `[YOU WANT n][FOR SALE n]` and the grid = the
  overlap, and the count N equals what the crate shows. A friend selling nothing you want (or not consented, or
  crate private) shows the base line. Reload of `/app/{friend}#selling` re-applies the filter (hash preserved).
  Own crate + non-friends unaffected.
- Count integrity: for the default `exact` mode, D2 count == D1 header count == crate filtered rows. (Any-mode:
  same, via the master branch.)

## Verification-pass ledger (independent no-context agent, before Lane review)
- **[FIXED — Task 1] MAJOR (#43 count≠filter):** the `#selling` crate renders only the friend's COLLECTION
  (`get_friend_crate` = `collection_items ⋈ releases`), and both the crate filter and D1's header count over
  that collection — but the original SQL counted ALL for-sale inventory ∩ wants with no collection join, so a
  for-sale listing not in the friend's collection would inflate the count above the crate it opens. Added an
  `exists collection_items` check so the count = collection ∩ inventory ∩ wants, matching the crate + D1.
  (Latent today — 0 for-sale rows are outside a collection — but structurally unenforced and likely at scale.)
- **[FIXED — Task 1] MINOR:** the master branch excluded `null` but not the `0` no-master sentinel the frontend
  also excludes (`viewerWantsMasters` drops 0/null). Added `and rii.master_id <> 0`. (Any-mode only; no live
  rows have master 0 today.)
- **Verified CORRECT:** SQL executes cleanly (CTEs + correlated subquery + ordered jsonb_agg), preserves all 5
  existing fields + order-by, consent gate airtight (0 for a non-consented friend, no price emittable), reads
  the viewer's own wantlist + the friend's inventory (no swap), `count(distinct)` avoids double-count + duplicate
  listings, `match_mode` coalesced, `private.can_view_forsale` callable; the `#selling` deep-link ordering is
  sound (`__twMatchCtx` + `__twInventory` load before the first `render()`; flags set after the reset; own/
  non-viewable crates inert; hash preserved on normalize; empty result recoverable via the SHOWING chips); the
  base-line fallback is byte-faithful; `onListFriends` passes the field through; pulse tier explicitly skipped.

## Audit plan
remediation-audit Pass-1 (break this): the crown check is **count == filter** (now collection ∩ inventory ∩ wants) — reproduce that
`selling_you_want` (SQL) equals the crate's matchSellingYouWant filtered set in BOTH exact and any modes
(construct a master-only-want case); prove the count is consent-gated (0 when forsale private / crate private /
non-friend) and never leaks a non-consented friend's for-sale size; prove the `#selling` deep-link can't apply
the filter on an own crate or a non-viewable crate; confirm no price anywhere; confirm the count-distinct never
double-counts. Narrow Pass-2 over rework. Converge.
