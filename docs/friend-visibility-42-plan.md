# Friend-visibility #42 — projected friend-crate read (plan)

Status: **EXECUTED — shipped as v1.9.2 (2026-09-02).** Verification-pass clean (5 runbook fixes applied
pre-execute); migration `0021` applied via break-glass + post-verified; remediation-audit Pass-1 (1 LOW
fixed: the RPC emitted the internal `collection_items.id` — stripped via `to_jsonb(t) - 'ord'`) + Pass-2
clean → converged. #43 and #47 are NOT in this change (they ride the friend-crate-view design bundle).

## Problem (#42)

`collection_select_friends` (recreated in `0020` as a table-wide `SELECT ... TO authenticated USING
(private.can_view_crate(...))`) lets a consented friend read **every column** of the owner's
`collection_items` rows — including `folder` (the owner's Discogs folder label, e.g. "To Sell") and
`instance_id` (an internal Discogs id). The crate grid never displays those; the frontend friend read
(`public/boot.js` line 350-352) already selects only `release_id, added, rating, vinyl` + release fields.
But because the RLS policy is table-wide, a friend could hand-craft `supabase.from('collection_items')
.select('folder, instance_id').eq('user_id', <owner>)` and pull them.

**Decision (Lane, 2026-09-01):** ratings STAY visible to friends. So the projection keeps `rating` and
omits only `folder` + `instance_id`. This is defense-in-depth (no visible grid change).

## Fix

Replace the table-wide friend SELECT with a **SECURITY DEFINER projection RPC** `get_friend_crate` that
returns exactly the display columns (incl. `rating`, excl. `folder`/`instance_id`), gated on
`private.can_view_crate`. Point the frontend friend read at the RPC, then **drop**
`collection_select_friends` so the raw table is no longer friend-readable at all.

Unaffected by the policy drop (verified): the OWNER's own read (`collection_select_own`, boot.js line 200
and the count reads at 638/1091, all `.eq('user_id', <self>)`); `crate_match` and `get_friend_crate`
(both SECURITY DEFINER — they read `collection_items` as the definer, bypassing RLS); `TraxWaxMatchCtx`
(reads the VIEWER's own rows, line 379). The only RLS-based friend read of `collection_items` is boot.js
line 350, which this change swaps to the RPC.

---

## Task 1 — migration `supabase/migrations/0021_friend_crate_projection.sql`

Create the file with EXACTLY this content:

```sql
-- 0021_friend_crate_projection.sql — cold-audit #42 (friend-crate read projection).
-- collection_select_friends (0012→0013→0020) is a table-wide friend SELECT, so a consented friend can
-- read the owner's `folder` (Discogs folder label) + `instance_id` (internal Discogs id) even though the
-- crate grid never shows them. Decision (Lane 2026-09-01): ratings STAY visible to friends. So expose the
-- friend crate through a SECURITY DEFINER projection that keeps `rating` and omits folder/instance_id,
-- gated on private.can_view_crate, and DROP the table-wide friend policy so the raw columns are no longer
-- friend-readable. Returns a jsonb ARRAY (not setof) so no PostgREST db-max-rows cap can silently truncate
-- a large crate; an unauthorized/absent viewer gets '[]' (no existence probe, mirrors crate_match's shape).

create or replace function public.get_friend_crate(p_username text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(t) order by t.ord), '[]'::jsonb)
  from (
    select ci.id as ord,
           ci.release_id, ci.added, ci.rating, ci.vinyl,
           r.artist, r.title, r.year, r.label, r.styles, r.genres, r.thumb, r.cover_image
      from public.profiles p
      join public.collection_items ci on ci.user_id = p.user_id
      left join public.releases r on r.release_id = ci.release_id
     where lower(p.discogs_username) = lower(p_username)
       and private.can_view_crate(auth.jwt()->>'sub', p.user_id)
  ) t;
$$;
revoke all on function public.get_friend_crate(text) from public, anon;
grant execute on function public.get_friend_crate(text) to authenticated;

-- The RPC is now the sole friend read path for the crate; remove the table-wide friend SELECT.
drop policy if exists collection_select_friends on public.collection_items;
```

Notes for the executor:
- `ord` (= `ci.id`) is included in the row so the array is ordered by insertion (matching the old
  `.order('id')`); the frontend ignores `ord`.
- `left join releases` mirrors the old embed (a row with no catalog match still returns, with null
  release fields → the frontend coalesces to '' / 0 / []).
- Do NOT touch `wantlist_select_friends` — wantlist_items has no folder/rating/instance_id (only
  `release_id, added, …`); its projection is #43/#47's concern, not this change.

Apply via the armed break-glass connector (`apply_migration`, name `friend_crate_projection`, the SQL
body above).

### Post-apply verification (read-only connector or psql)

1. **RPC exists, is SECURITY DEFINER, has search_path:**
   ```sql
   select prosecdef, proconfig
     from pg_proc where proname = 'get_friend_crate';
   ```
   Expected: `prosecdef = t`, `proconfig` contains `search_path=public`.
2. **Grants: authenticated only (not anon/public):**
   ```sql
   select grantee, privilege_type from information_schema.routine_privileges
    where routine_name = 'get_friend_crate';
   ```
   Expected: a row for `authenticated` EXECUTE; NO `anon` / `PUBLIC` row.
3. **Projection omits folder + instance_id:**
   ```sql
   select pg_get_functiondef('public.get_friend_crate(text)'::regprocedure) not like '%folder%'
      and pg_get_functiondef('public.get_friend_crate(text)'::regprocedure) not like '%instance_id%'
      and pg_get_functiondef('public.get_friend_crate(text)'::regprocedure) like '%rating%';
   ```
   Expected: `t` (no folder, no instance_id, keeps rating).
4. **Friend policy dropped; owner read policy remains:**
   ```sql
   select policyname from pg_policies where tablename = 'collection_items' order by policyname;
   ```
   Expected: `collection_select_own` ONLY — and NO `collection_select_friends`. **There is NO
   `collection_write_own` policy** — it was dropped in `0006_audit_hardening.sql` (client write grants
   revoked there); do NOT "restore" it if you see it missing. One row is the correct result.
5. **Advisors:** `get_advisors` security — the only new lint should be the expected browser-callable
   SECURITY DEFINER flag on `get_friend_crate` (same class as `crate_match` in 0018). No new RLS/exposure
   lint.

### Functional probes (transaction, ROLLED BACK — never committed)

Run as the definer/service connection, setting the viewer sub via a claims override where the test harness
allows, OR reason from the definition if role-switching isn't available. The intended matrix:
- viewer = a consented friend of owner → `get_friend_crate('<owner>')` returns a jsonb array of the owner's
  crate rows, each with `rating` present and NO `folder`/`instance_id` keys.
- viewer = NOT a friend (owner crate private) → returns `[]` (not an error, no rows).
- `p_username` = nonexistent → returns `[]`.
- After the policy drop: `set role authenticated` + a non-owner sub, `select folder from
  collection_items where user_id = '<owner>'` → 0 rows (the raw table is no longer friend-readable).

---

## Task 2 — frontend: swap the friend crate read to the RPC (`public/boot.js`)

In `installFriendCrateProviders(owner)`, replace the entire `window.TraxWaxData` definition. FIND
(currently lines ~346-371):

```js
  window.TraxWaxData = async () => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('collection_items')
        .select('release_id, added, rating, vinyl, ' +
          'releases ( artist, title, year, label, styles, genres, thumb, cover_image )')
        .eq('user_id', owner.user_id)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error('friend collection query failed: ' + error.message);
      for (const it of data ?? []) {
        const rel = it.releases || {};
        rows.push({
          id: it.release_id,
          artist: rel.artist || '', title: rel.title || '', year: rel.year || 0,
          label: rel.label || '', styles: rel.styles || [], genres: rel.genres || [],
          vinyl: it.vinyl || '', thumb: rel.thumb || '', cover_image: rel.cover_image || '',
          added: it.added || '', rating: it.rating || 0,
          price: null, crating: null, crcount: null, have: null, want: null,
        });
      }
      if (!data || data.length < 1000) break;
    }
    return rows;
  };
```

REPLACE with (reads the projected RPC; the RPC already enforces the crate gate + returns all rows in one
ordered jsonb array, so no pagination and no table select):

```js
  // #42: friend crate read goes through the get_friend_crate projection RPC (keeps rating, omits the
  // owner's folder + instance_id, which the table-wide RLS policy used to expose). SECURITY DEFINER +
  // gated on can_view_crate; returns the full ordered array in one call.
  window.TraxWaxData = async () => {
    const { data, error } = await supabase.rpc('get_friend_crate', { p_username: owner.discogs_username });
    if (error) throw new Error('friend collection query failed: ' + error.message);
    return (data ?? []).map((it) => ({
      id: it.release_id,
      artist: it.artist || '', title: it.title || '', year: it.year || 0,
      label: it.label || '', styles: it.styles || [], genres: it.genres || [],
      vinyl: it.vinyl || '', thumb: it.thumb || '', cover_image: it.cover_image || '',
      added: it.added || '', rating: it.rating || 0,
      price: null, crating: null, crcount: null, have: null, want: null,
    }));
  };
```

Also update the stale comment at boot.js ~309-311 (the block header for `installFriendCrateProviders`):
FIND `Reads the friend's collection via the collection_select_friends RLS policy —\n   paginated +
inline-mapped EXACTLY like installCrateProviders (only .eq('user_id', ...) differs).` and REPLACE the
"Reads the friend's collection via …" sentence with: `Reads the friend's collection via the
get_friend_crate projection RPC (#42 — keeps rating, omits folder/instance_id; the old table-wide
collection_select_friends policy is dropped).`

### Task 2b — fix the now-stale confidentiality-boundary comment in `live-stats`

`supabase/functions/live-stats/index.ts` (~117-119) says the friend-crate boundary "is the
collection_items RLS … enforced by private.can_view_crate (0013)." live-stats is **functionally
unaffected** (it authorizes via `crate_view_decision`/0014 + admin reads, never a client RLS read), but
the boundary is now `get_friend_crate`, not the dropped RLS policy. FIND:
```ts
  // best-effort UX for the friend-view context, NOT a confidentiality boundary — that boundary is
  // the collection_items RLS (which release IDs are in whose crate), enforced by
  // private.can_view_crate (0013). A client omitting `owner` gets the (global) price, as it does
```
REPLACE:
```ts
  // best-effort UX for the friend-view context, NOT a confidentiality boundary — that boundary is
  // which release IDs are in whose crate, enforced by private.can_view_crate (0013) via the
  // get_friend_crate projection RPC (#42; the table-wide collection_items friend RLS policy was dropped).
  // A client omitting `owner` gets the (global) price, as it does
```
(Comment only — do NOT redeploy live-stats. This is not a break-glass Edge change; it just keeps the
source comment honest for the next reader.)

### Verify

```
cd "<repo>/public" && node --check boot.js
```
Expected: no output (exit 0). Any SyntaxError fails the task.

Grep checks:
```
grep -n "get_friend_crate" boot.js          # expect: the rpc call in TraxWaxData (+ the comment)
grep -n "from('collection_items')" boot.js   # expect: 4 reads, ALL own-scoped (.eq('user_id', self/me)): ~200 own crate, ~379 TraxWaxMatchCtx (viewer's own), ~638 + ~1091 own counts — and NO friend read (.eq('user_id', owner…)). Line numbers shift up ~14 after the block shrinks.
```

---

## Deploy sequencing (read before applying)

Migration `0021` **creates the RPC and drops the friend policy in one apply**, so there is a brief window
where the two halves can disagree:
- If the migration is applied but the new `boot.js` isn't live yet, the OLD frontend still runs the RLS
  table-select at boot.js:350, which now returns **0 rows** → a friend viewing a shared crate sees it
  **empty** until the Pages deploy lands.
- Pushing the frontend first doesn't help either — it would call `get_friend_crate` before the RPC exists.

Mitigation (small blast radius — solo-owner app, friend-crate views are rare): **apply the migration and
land the `git push` (Cloudflare Pages auto-deploy) in the same short window.** Apply migration → immediately
run the handoff push → confirm the Pages build is live. A friend loading a crate in the ~1-2 min gap sees
an empty crate, self-healing on reload. If you want zero gap, split into two migrations (create RPC now,
drop policy after the deploy is confirmed) — not necessary here, noted for completeness.

## Rollback

`0021` is additive except the policy drop. To revert: `create policy collection_select_friends on
public.collection_items for select to authenticated using (private.can_view_crate(auth.jwt()->>'sub',
user_id));` (the 0020 form), `drop function if exists public.get_friend_crate(text);`, and revert the
boot.js `TraxWaxData` to the table-select+pagination form above. No data migration to unwind.

## Audit plan

After build, before commit: remediation-audit Pass-1 (independent, break this) — the RPC cannot leak a
non-consented crate (gate inside; `[]` for non-friend/absent/own-not-applicable); the projection truly
omits folder + instance_id; dropping `collection_select_friends` breaks NO other read (own reads,
crate_match, TraxWaxMatchCtx all verified independent); the frontend row shape out of the RPC matches what
`app.js` consumes (id/artist/title/year/label/styles/genres/vinyl/thumb/cover_image/added/rating + null
stat fields); ordering preserved; a large crate isn't truncated. Then the narrow Pass-2 over any reworked
hunks. Converge (run by default).
