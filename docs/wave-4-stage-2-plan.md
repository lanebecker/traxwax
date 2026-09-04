# Wave 4 — STAGE 2 — the social half — plan

Status: DRAFT for verification-pass + Lane review. **Needs break-glass** (migration `0028` + RPCs). Design
source: `Design/traxwax-wave4-design/wave-4/SPEC.md` decisions **E** (gated consent), **D** (the compound),
**H** (edges). Builds on Stage 1 (v1.16.0, shipped): `inventory_items`, the own-crate for-sale surfaces, and the
`window.__twInventory` / `forSaleHref` / `badgesFor forSale` / `state.forSaleOnly` frontend machinery — Stage 2
reuses ALL of it, just pointed at a *friend's* consented inventory. Target **v1.17.0**.

## The load-bearing rule (unchanged from Stage 1)
No price, ever. Friend for-sale is release_id + listing_id only, consent-gated, and every outbound link goes to
Discogs. A for-sale fact appears **only on a crate you can already see** (H3).

## The consent model (E) — for-sale rides *under* crate visibility
`forsale_visibility ∈ {private, friends}`, **default private (opt-in)**, and effective ONLY when
`crate_visibility = 'friends'`. So a viewer sees a friend's for-sale iff: they're friends **and** the owner's
crate is friends-visible **and** the owner's forsale is friends-visible. This is exactly `can_view_crate` AND
`forsale_visibility='friends'` — mirrored as a new `private.can_view_forsale`.

## Scope
IN: E consent row (gated/locked), friend-crate FOR SALE badges + facet (reuse Stage 1 via the friend inventory
Map), D1 the "— TWO FOR SALE —" header callout + the `SHOWING [YOU WANT n][FOR SALE n]` filter chips, H edges.
**D2 (the friends-list "Selling N you want" line) is a SEPARATE DECISION — see the D2 box; recommend deferring
to a small follow-up** because it needs a per-friend fan-out the rest of Stage 2 doesn't.

---

## Task 1 — migration `supabase/migrations/0028_forsale_visibility.sql` (break-glass)

```sql
-- 0028_forsale_visibility.sql — Wave 4 Stage 2. The for-sale consent axis + the consent-gated friend read.
-- forsale_visibility rides UNDER crate visibility: effective only when crate_visibility='friends'.

-- 1. Consent column. DEFAULT private (opt-in) — unlike crate/wantlist (0026 flipped those to 'friends');
--    selling is a distinct intent and must not be advertised by the sharing default.
alter table public.profiles
  add column if not exists forsale_visibility text not null default 'private';
alter table public.profiles
  add constraint profiles_forsale_visibility_chk check (forsale_visibility in ('private','friends'));
-- profiles_guard() pins only the OAuth columns, so a user updates their OWN forsale_visibility under the
-- existing profiles_update_own RLS — no new policy. (Same as crate_visibility/match_mode.)

-- 2. The gate — mirrors private.can_view_crate + the forsale_visibility condition. In the `private` schema
--    (NOT exposed to PostgREST), SECURITY DEFINER, so it reads friendships/profiles regardless of caller RLS.
create or replace function private.can_view_forsale(p_viewer text, p_owner text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select
    p_viewer = p_owner
    or exists (
      select 1
        from public.profiles pr
        join public.friendships f
          on f.user_id = p_viewer and f.friend_id = p_owner
       where pr.user_id = p_owner
         and pr.crate_visibility  = 'friends'
         and pr.forsale_visibility = 'friends'
    );
$function$;

-- 3. get_crate_owner also reports can_view_forsale, so the frontend knows whether to load friend for-sale.
--    (create-or-replace the EXISTING function — body copied verbatim from the live def, +v_can_forsale.)
create or replace function public.get_crate_owner(p_username text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_sub text := auth.jwt()->>'sub';
  v record;
  v_can_crate boolean;
  v_can_want  boolean;
  v_can_forsale boolean;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  select user_id, discogs_username, display_name, avatar_url, bio, location,
         collecting_since, link1, link2
    into v
    from public.profiles
   where lower(discogs_username) = lower(p_username);
  if not found then return jsonb_build_object('status','no_crate'); end if;
  v_can_crate   := private.can_view_crate(v_sub, v.user_id);
  v_can_want    := private.can_view_wantlist(v_sub, v.user_id);
  v_can_forsale := private.can_view_forsale(v_sub, v.user_id);
  if not (v_can_crate or v_can_want) then
    return jsonb_build_object('status','no_crate');
  end if;
  return jsonb_build_object('status','ok',
    'can_view_crate', v_can_crate,
    'can_view_wantlist', v_can_want,
    'can_view_forsale', v_can_forsale,
    'owner', jsonb_build_object(
      'user_id', v.user_id, 'discogs_username', v.discogs_username,
      'display_name', v.display_name, 'avatar_url', v.avatar_url, 'bio', v.bio,
      'location', v.location, 'collecting_since', v.collecting_since,
      'link1', v.link1, 'link2', v.link2));
end;
$function$;

-- 4. The consent-gated friend for-sale read — mirrors get_friend_crate exactly (SQL SECURITY DEFINER,
--    aggregate-in-one-call, gate in the WHERE). Projection is release_id + listing_id ONLY (the viewer needs
--    listing_id for the /sell/item/{listing_id} badge link). status='for_sale' gate (H2). NO price column exists.
create or replace function public.get_friend_forsale(p_username text)
returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('release_id', ii.release_id, 'listing_id', ii.listing_id)
                            order by ii.id), '[]'::jsonb)
  from public.profiles p
  join public.inventory_items ii on ii.user_id = p.user_id and ii.status = 'for_sale'
 where lower(p.discogs_username) = lower(p_username)
   and private.can_view_forsale(auth.jwt()->>'sub', p.user_id);
$function$;

-- 5. Grants — get_friend_forsale is called by the client via supabase.rpc(); expose to authenticated
--    (mirror get_friend_crate's grant). can_view_forsale stays private (unexposed), like can_view_crate.
revoke all on function public.get_friend_forsale(text) from public, anon;
grant execute on function public.get_friend_forsale(text) to authenticated;
```
Apply via break-glass (`apply_migration`, name `forsale_visibility`).

### Post-apply verification (read-only connector)
- `profiles.forsale_visibility` exists (text NOT NULL default 'private') + the CHECK constraint; all 4 existing
  users read `'private'` (opt-in — nobody's for-sale is exposed until they flip it).
- `private.can_view_forsale` exists; probe it: `(me, me)`→true; a friend pair where owner forsale='private'→
  false; flip that owner to forsale='friends' in a **rolled-back** txn → true; a non-friend → false.
- `get_crate_owner` def contains `can_view_forsale`; calling it for a friend returns the new key.
- `get_friend_forsale` exists, `grant execute` to authenticated only (aclexplode); returns `[]` for a
  non-consented/non-friend owner, and the friend's `{release_id, listing_id}` array when consented (rolled-back
  probe). `get_advisors security`: no new lint (it's the same SECURITY-DEFINER-with-internal-gate class as
  get_friend_crate/get_crate_owner — the expected 0029 baseline).
- Confirm `get_friend_forsale` NEVER returns a price field (projection is release_id + listing_id only).

---

## Task 2 — `public/boot.js`

### 2a — map the new flag (friend route)
At the `get_crate_owner` result mapping (~`boot.js:1158-1162`, beside `_canViewCrate`/`_canViewWantlist`):
`friendOwner._canViewForSale = data.can_view_forsale === true;` (fail-closed).

### 2b — the friend for-sale provider (in `installFriendCrateProviders(owner)`)
Mirror `TraxWaxOwnerWantIds`'s gate-then-fetch shape, but via the RPC (one call, definer-gated):
```js
  // Wave 4 Stage 2: the friend's consented for-sale listings → release_id → listing_id. The RPC is
  // can_view_forsale-gated + returns [] when not shared, so a private/un-consented friend yields an empty Map.
  window.TraxWaxFriendForSale = async () => {
    if (owner._canViewForSale !== true) return new Map();   // not shared → empty (never guess)
    const { data, error } = await supabase.rpc('get_friend_forsale', { p_username: owner.discogs_username });
    if (error) throw new Error('friend for-sale query failed: ' + error.message);
    const map = new Map();
    for (const it of (Array.isArray(data) ? data : [])) map.set(it.release_id, it.listing_id);
    return map;
  };
```
(Own-crate `installCrateProviders` keeps `TraxWaxInventory` from Stage 1; the friend installer gets this one.)

### 2c — expose the viewer's own consent to the account page (E)
- **REQUIRED edit (not "confirm"):** `ensureProfile`'s select at `boot.js:165` does NOT include
  `forsale_visibility` today — ADD it beside `crate_visibility, wantlist_visibility, match_mode`, or the E row
  paints with neither segment active.
- `renderAccount` passes the whole profile as `o.profile` (`boot.js:743`), and `sharingSection` reads the
  sibling rows nested (`o.profile.crate_visibility` etc.). So the E row reads `o.profile.forsale_visibility`
  (default value) and `o.profile.crate_visibility` (lock decision) — **do NOT add parallel top-level keys**;
  match the crate/wantlist rows exactly.
- Add a `bindAccountPage` dep `onSetForsaleVisibility: async (v) => { const { error } = await supabase.from('profiles').update({ forsale_visibility: v }).eq('user_id', window.Clerk.user.id); if (error) throw new Error(error.message); }` (mirror `onSetVisibility`).

---

## Task 3 — `public/boot.ui.js`

### 3a — the E consent row (third VISIBILITY row)
In `sharingSection`'s VISIBILITY box (the 1c segmented box with the My-crate + My-wantlist rows, which read
`o.profile.crate_visibility` / `o.profile.wantlist_visibility` nested), add a THIRD hairline row **"My records
for sale"** / subline **"The records you've listed on Discogs."** with the same `visSegBtn` PRIVATE|FRIENDS
idiom (`#tw-vis-forsale-seg`, `data-vis`), reading `o.profile.forsale_visibility`. **Gating (E1):** when
`o.profile.crate_visibility !== 'friends'`, render the row LOCKED — a lock glyph, greyed/`aria-disabled` segments, and
the inline reason **"Open your crate to friends first — that's where for-sale shows."** — instead of the live
segmented control. When crate IS friends-visible, render the live control defaulting to `o.forsaleVisibility`.
Wire it in `bindAccountPage`: `wireVisSeg('tw-vis-forsale-seg', deps.onSetForsaleVisibility, 'for-sale')` — but
ONLY when the live (unlocked) control was rendered (guard on element presence, which `bindAccountPage` already
does). Widen the SHARING intro body (E3) to: *"Your shelves are private by default. Open them to the friends
you've added — including what you've listed for sale. Prices always live on Discogs, never here."*

### 3b — H1 empty note
When the viewer has no listings, the E row still shows; add a quiet **"Nothing listed yet"** note under it when
their own inventory is empty. [Executor: `renderAccount` can pass an `inventoryCount` (already added in Stage 1)
— show the note when `o.inventoryCount === 0` and the row is unlocked.]

---

## Task 4 — `public/app.js` — friend for-sale + the D compound

### 4a — load the friend's for-sale into the crate context (bootCrate friend branch)
In `bootCrate`, the friend branch (`if (!IS_OWN() && window.TraxWaxMatchCtx)`, ~`app.js:1530`), after
`__twMatchCtx` loads, ALSO load the friend inventory and wire it so the Stage 1 surfaces light up on the friend
crate:
```js
    try { window.__twInventory = await window.TraxWaxFriendForSale(); } catch (e) { window.__twInventory = new Map(); }
    if (window.__twMatchCtx) window.__twMatchCtx.forSale = window.__twInventory;   // badgesFor reads ctx.forSale.has()
```
Now, with no other change: the FOR SALE badge (badgesFor already emits it from `ctx.forSale`), `forSaleHref`
(reads `__twInventory.get` → the friend's `/sell/item/{listing}`), and the FOR SALE facet
(`state.forSaleOnly` + `__twInventory.has`) all work on the friend crate. The own-only surfaces stay correct:
the modal `LIST FOR SALE` action is `IS_OWN()`-gated (hidden), the ledger for-sale stat is in the IS_OWN
bigStats branch (friend branch untouched).

### 4b — the modal header FOR SALE ● marker on a friend's listed record
Stage 1 gated the header marker on `IS_OWN() && __twInventory.has`. Widen to `window.__twInventory &&
window.__twInventory.has(rec.id)` (drop `IS_OWN()`) so a friend's listed record also shows the FOR SALE ●
marker in the modal — the LIST/EDIT action stays `IS_OWN()`-gated below it. (A friend viewer gets the marker +
the existing SEE ON DISCOGS → link; the badge on the card is the primary link.)

### 4c — D1 the "— TWO FOR SALE —" header callout
In the friend match sentence (`~app.js:839-864`), `c1` renders `{NAME} HAS {n} YOU WANT`. Add the for-sale
subset inline. Compute the overlap = the friend's for-sale releases that the viewer wants:
```js
  const _fsWant = (window.__twInventory && window.__twMatchCtx && window.__twMatchCtx.viewerWants)
    ? [...window.__twInventory.keys()].filter(id => window.__twMatchCtx.viewerWants.has(id)).length : 0;
```
**CRITICAL — count/filter integrity (#43, the recurring #28/#47 bug):** `_fsWant` MUST use the SAME predicate
`matches()` applies for `matchFilter='youWant' + forSaleOnly`, iterating `RECORDS` (the rendered crate), not
`__twInventory.keys()`. The filter is MASTER-AWARE (`match_mode`), so an exact-only intersection under-counts in
any mode AND iterating inventory keys can count a release not in the crate. Use:
```js
  const _fsWant = (window.__twInventory && window.__twMatchCtx) ? (RECORDS||[]).filter(r =>
    window.__twInventory.has(r.id) && (
      (window.__twMatchCtx.viewerWants && window.__twMatchCtx.viewerWants.has(r.id)) ||
      (MATCH_ANY() && r.master_id && window.__twMatchCtx.viewerWantsMasters && window.__twMatchCtx.viewerWantsMasters.has(r.master_id))
    )).length : 0;
```
This is byte-for-byte the two `matches()` clauses (`app.js:266` forSale + `app.js:278-286` youWant), so the
callout count EQUALS what the filter shows, in both exact and any modes.

When `_fsWant >= 1` AND `mc.youWant` is shown (crate visible), render the callout between c1 and c2, em-dash
set, as a black-on-white **in-app** link (NO ↗) that applies both filters:
`— <a data-act="matchSellingYouWant" style="background:#fff; color:var(--ink); font-family:'IBM Plex Mono',monospace; font-size:9.5px; font-weight:700; padding:2px 7px; text-decoration:underline; cursor:pointer">${_num(_fsWant)} FOR SALE</a> —`
where `_num(n)` spells 1–9, numerals 10+ (D "number form in prose"). Splice it so the desktop sentence reads
`{c1} — {callout} — {bothShared?'AND ':''}{c2}.` and the mobile row-2 carries it too. The callout renders only
when `_fsWant>=1` (D3 zero-state: omitted otherwise).

### 4d — the `matchSellingYouWant` shortcut + the SHOWING chips
Add a click case: `case 'matchSellingYouWant': state.view='crate'; state.matchFilter='youWant';
state.forSaleOnly=true; render(); break;` — applies the two existing composable filters at once (no new chip
type). The active-filter chips already exist: the `MATCH` chip (`matchFilter='youWant'` → "YOU WANT · THEY
HAVE", `computeVals` ~653) and the `FORSALE` chip (Stage 1). **Verify** they both appear in the SHOWING rail
when both are on and each is independently removable (the `MATCH` chip's `rm` clears `matchFilter`; the
`FORSALE` chip's `rm` clears `forSaleOnly`). **SETTLED (Lane, 2026-09-04): KEEP the established chip labels** — "YOU WANT · THEY HAVE" (MATCH) and
"For sale" (FORSALE), unchanged. Do NOT retrofit the SPEC's numeral-count form (it would touch the shared #47
match-filter UI). The header callout still spells the count ("— TWO FOR SALE —").
[Executor: confirm the facet's `_forSaleSet`/`__twInventory` is present on the friend crate so the FORSALE chip
+ count render there — it is, via 4a.]

### 4e — the `_num` prose helper
Add `function _num(n){ const w=['zero','one','two','three','four','five','six','seven','eight','nine']; return n<10?w[n]:String(n); }` near the match-sentence helpers. Use it in the callout (4c). (The existing match
sentence uses raw numerals in `_matchPart`; D's spell-out rule is specific to the prose callout — do not
retrofit `_matchPart`, whose "YOU WANT n" clicks read as counts.)

---

## D2 — the friends-list "Selling N you want" line — **SETTLED: DEFERRED** (Lane, 2026-09-04) — out of Stage 2
SPEC D2 adds a per-friend meta line "Selling N you want" (priority: selling > activity-pulse > base) to the
FRIENDS list. Two issues make it heavier than the rest of Stage 2: (1) there is **no activity-pulse tier today**
(the list shows only "Sharing their crate" / "Not sharing"), so the full ladder is partly net-new; (2) it needs
**per-friend** for-sale∩your-wants counts — either N calls to `get_friend_forsale` (one per friend) + your
wantlist, or a `list_friends` RPC extension to compute `selling_you_want` server-side. Neither is hard, but it's
a self-contained chunk that doesn't share code with 4a–4e. **Recommend: ship Stage 2 without D2, add it as a
tiny follow-up** (extend `list_friends` to return `selling_you_want` per friend, gated; render selling→base in
`renderFriendsList:614`). If Lane wants it in Stage 2, the plan gains a `list_friends` create-or-replace + the
one render line.

---

## Post-build verification
- `node --check` all three JS files.
- Live: a friend who has **not** turned on for-sale (default) → their crate shows NO for-sale (badge/facet/
  header callout all absent); `get_friend_forsale` returns `[]`. A friend who flips forsale=FRIENDS (and crate
  is friends) → their listed records show the FOR SALE ↗ badge (→ THEIR listing), the FOR SALE facet appears,
  and if you want any, the header reads "— n FOR SALE —" and clicking it filters to the overlap. Your own crate
  is unchanged (Stage 1). The E row is locked while your crate is private, live when it's friends.
- H3: set crate=private while forsale=friends → `can_view_forsale` returns false (crate condition fails) → no
  exposure. H2: a delisted row (status≠for_sale) → excluded by the RPC's `status='for_sale'`.

## Audit plan
remediation-audit Pass-1 (break this), focus the **consent gate as the crown jewel**: prove no for-sale leaks
when forsale=private, when crate=private (even if forsale=friends), or between non-friends — reproduce
`get_friend_forsale` returning `[]` in each; prove the frontend never renders a friend badge from a stale
own-crate `__twInventory` (the bootCrate friend branch must overwrite it, never inherit); prove the D1 count =
the filtered set (link-integrity, #43 rule); confirm no price anywhere in the new RPC or provider. Narrow
Pass-2 over rework. Converge.

---

## Verification-pass ledger (independent no-context agent, before Lane review)
The agent confirmed the **migration + consent gate are safe to apply — no for-sale leak on any path** (self→
true; forsale=private→false; crate=private even with forsale=friends→false, H3; non-friend→false; denied viewer
gets `[]` not null; no price emittable; grants match `get_friend_crate`; `get_crate_owner` byte-faithful +
only additive). Four defects, fixed in-plan:
- **[FIXED — Task 4c] MAJOR:** the D1 `_fsWant` count iterated `__twInventory.keys()` with an exact-only
  intersection while the filter it opens is master-aware (`match_mode`) — the exact #28/#47 count-vs-filter
  bug the SPEC's #43 rule forbids. Now computed with the same predicate `matches()` uses, over `RECORDS`.
- **[FIXED — Task 2c/3a] MINOR:** the E row was told to read new top-level `crateVisibility`/`forsaleVisibility`
  keys; the sibling rows read `o.profile.*` nested. Switched to `o.profile.forsale_visibility` /
  `o.profile.crate_visibility`.
- **[FIXED — Task 2c] MINOR:** `ensureProfile`'s select (`boot.js:165`) is genuinely missing
  `forsale_visibility` — promoted from "confirm" to a REQUIRED edit.
- **[FLAGGED — Task 4d] MINOR:** the SPEC's numeral chip-count form vs the live labels — surfaced as a design
  decision for Lane rather than silently kept.

**Verified CORRECT:** the gate on every leak path; `get_crate_owner` field-by-field faithful; `get_friend_forsale`
`[]`-not-null + price-unemittable + `status='for_sale'` gate + authenticated-only grant; `bootCrate` resets
`__twInventory=null` before both branches so no stale own-Map self-leak; the FOR SALE badge survives a
`__twMatchCtx` failure via the card ctx fallback; own-only surfaces (modal LIST/EDIT, ledger stat) stay
`IS_OWN()`-gated; every cited source anchor exists; E/D1/H covered, D2 correctly flagged as a decision.
