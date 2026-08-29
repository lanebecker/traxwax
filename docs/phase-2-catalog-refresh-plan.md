# Phase 2 — Catalog refresh: tombstone retries, TTL re-enrichment, live metadata

**Rev 2 — 2026-08-29 (rev 1 independently verified: EXECUTE-READY with amendments, all
folded in — Audit record at bottom). Closes GitHub issue #3** (cold audit #15): `enrich-release` writes
`tracks: []` on 404 permanently (wrong for transient 404s), and the shared catalog's
basic metadata is the first importer's snapshot forever — `enriched_at` is stamped but
never read.

## Locked policy (Lane, 2026-08-29)

- **Basic metadata** (artist/title/year/label/styles/genres/thumb/cover_image):
  refreshed on every import, **last-import-wins** — the data is already in hand on each
  collection page, zero extra API calls.
- **404 tombstones**: retried after **7 days**, under the token of an owner, using
  leftover enrichment budget.
- **Deep fields** (tracks/country/released/videos): re-fetched when `enriched_at` is
  older than **180 days**, same budget, lowest priority.

## Design

**Disambiguating tombstones.** `tracks = []` currently means BOTH "Discogs has no
tracklist" (a real 200) and "404 tombstone". New nullable column `releases.gone_at`:
set on a 404 write, cleared on any successful enrich. Retry key: `gone_at < now() - 7 days`.

**Priority order inside the existing budget (5/invocation, 1.1s pacing, caller's token,
caller-owned releases only):** new (`tracks is null`) → tombstones due → stale. New work
alone drives `remaining` and therefore the `last_import_at` boot gate — refresh work can
never hold a user's first render hostage.

**Empty-guarded metadata merge.** A naive `upsert` with last-writer-wins would let one
degraded API response (blank `cover_image`, `year: 0`) stomp good catalog data. The seed
therefore goes through a `seed_releases` RPC whose `ON CONFLICT DO UPDATE` keeps the
existing value whenever the incoming one is empty (`''`/`0`/`{}`). Basic fields are only
ever written by seeds (enrichment writes only the deep fields), so this merge is the
single writer of those columns.

**Rollout-order safety.** The replaced `pending_enrichment` returns a superset of its
old keys (`owned`/`total`/`pending` unchanged), so the deployed enrich-release v4 keeps
working between migration and its v5 deploy. Old boot.js reading a v5 response treats the
absent-then-present `refresh_pending` as falsy and behaves exactly as today.

## Confirmed facts (measured before writing)

- `import-collection/index.ts` seeds via
  `admin.from('releases').upsert([...seeds.values()], { onConflict: 'release_id', ignoreDuplicates: true })`
  (the only writer of basic fields); each seed row is exactly
  `{release_id, artist, title, year, label, styles, genres, thumb, cover_image}` with the
  deep fields deliberately absent. Empty defaults are `''`, `0`, `[]`.
- `enrich-release/index.ts` (v4, deployed): work discovery is one
  `pending_enrichment(p_user_id, p_limit)` RPC returning `{owned,total,pending}`; the
  404 branch writes `tracks: [], country: '', released: '', videos: [], enriched_at`
  and counts as `enriched`; success clears nothing (no `gone_at` yet); `remaining =
  total - enriched` gates `last_import_at`.
- `boot.js` `backgroundEnrich()` loop: breaks on `d.remaining === 0`; waits 30s on
  `d.rate_limited` without counting toward the guard; `noProgress` increments when
  `d.remaining >= prevRemaining`, trips at 3.
- `releases` schema (0001): basic fields + `tracks/country/released/videos jsonb/text` +
  `enriched_at timestamptz not null default now()`. No `gone_at`, no `updated_at`.
- `pending_enrichment` (migration **0008**, not 0009 — rev1-F3) is SECURITY DEFINER,
  `search_path = public`, granted to service_role only; argument names/types below match
  it exactly, so `CREATE OR REPLACE` is valid and preserves grants and ownership.
- Current live data: 1,859 releases, 0 with `tracks is null`, 0 tombstones
  (`tracks = '[]'` count to be measured in Task V1 before deciding it's 0).

---

## Task 1 — Migration `supabase/migrations/0010_catalog_refresh.sql`

```sql
-- 0010_catalog_refresh.sql — Phase 2: catalog refresh (GitHub #3, cold audit #15).
-- 404 tombstones retry after 7 days; deep fields re-fetch after 180 days; basic
-- metadata is merged (empty-guarded, last-import-wins) on every import.

-- ── Tombstone marker. tracks='[]' alone is ambiguous: a real release with no
--    tracklist and a 404 both wrote []. gone_at set on 404, cleared on success.
alter table public.releases add column if not exists gone_at timestamptz;

-- ── Work discovery, extended. Same name/signature/grants as 0008 (CREATE OR REPLACE
--    preserves both); returns a SUPERSET of the old keys so the deployed enrich-release
--    v4 keeps working until v5 lands. New work ('pending') alone drives the boot gate;
--    'refresh' is tombstones due (7d) then stale rows (180d), oldest first.
create or replace function public.pending_enrichment(p_user_id text, p_limit integer)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'owned', (select count(*) from public.collection_items ci
               where ci.user_id = p_user_id),
    'total', (select count(*)
                from public.releases r
               where r.tracks is null
                 and exists (select 1 from public.collection_items ci
                              where ci.user_id = p_user_id
                                and ci.release_id = r.release_id)),
    'pending', coalesce((select jsonb_agg(t.release_id)
                from (select r.release_id
                        from public.releases r
                       where r.tracks is null
                         and exists (select 1 from public.collection_items ci
                                      where ci.user_id = p_user_id
                                        and ci.release_id = r.release_id)
                       order by r.release_id
                       limit p_limit) t), '[]'::jsonb),
    'refresh_total', (select count(*)
                from public.releases r
               where r.tracks is not null
                 and ( (r.gone_at is not null and r.gone_at < now() - interval '7 days')
                    or (r.gone_at is null and r.enriched_at < now() - interval '180 days') )
                 and exists (select 1 from public.collection_items ci
                              where ci.user_id = p_user_id
                                and ci.release_id = r.release_id)),
    'refresh', coalesce((select jsonb_agg(t.release_id)
                from (select r.release_id
                        from public.releases r
                       where r.tracks is not null
                         and ( (r.gone_at is not null and r.gone_at < now() - interval '7 days')
                            or (r.gone_at is null and r.enriched_at < now() - interval '180 days') )
                         and exists (select 1 from public.collection_items ci
                                      where ci.user_id = p_user_id
                                        and ci.release_id = r.release_id)
                       -- Tombstones before stale; oldest first within each class.
                       order by (r.gone_at is null), coalesce(r.gone_at, r.enriched_at)
                       limit p_limit) t), '[]'::jsonb)
  );
$$;

-- ── Empty-guarded metadata merge: last-import-wins, but a degraded incoming value
--    ('' / 0 / empty array) never stomps a real one. Seeds are the ONLY writer of the
--    basic fields, so this is the single merge point. Insert path uses the incoming
--    row as-is (matching today's seed). service_role-only like every writer RPC.
create or replace function public.seed_releases(p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.releases
    (release_id, artist, title, year, label, styles, genres, thumb, cover_image)
  select (r->>'release_id')::bigint,
         coalesce(r->>'artist', ''),
         coalesce(r->>'title', ''),
         coalesce((r->>'year')::int, 0),
         coalesce(r->>'label', ''),
         -- WITH ORDINALITY pins element order (rev1-F5: bare array_agg order is
         -- unguaranteed by spec, even if reliable in practice).
         coalesce((select array_agg(x.v order by x.o)
                     from jsonb_array_elements_text(r->'styles') with ordinality x(v, o)), '{}'),
         coalesce((select array_agg(x.v order by x.o)
                     from jsonb_array_elements_text(r->'genres') with ordinality x(v, o)), '{}'),
         coalesce(r->>'thumb', ''),
         coalesce(r->>'cover_image', '')
    from jsonb_array_elements(p_rows) r
   -- Deterministic row order (rev1-F6): DO UPDATE takes row locks; two concurrent
   -- imports upserting overlapping releases in different orders could deadlock.
   order by 1
  on conflict (release_id) do update set
    artist      = case when excluded.artist      <> '' then excluded.artist      else releases.artist      end,
    title       = case when excluded.title       <> '' then excluded.title       else releases.title       end,
    year        = case when excluded.year        <> 0  then excluded.year        else releases.year        end,
    label       = case when excluded.label       <> '' then excluded.label       else releases.label       end,
    styles      = case when coalesce(array_length(excluded.styles, 1), 0) > 0 then excluded.styles else releases.styles end,
    genres      = case when coalesce(array_length(excluded.genres, 1), 0) > 0 then excluded.genres else releases.genres end,
    thumb       = case when excluded.thumb       <> '' then excluded.thumb       else releases.thumb       end,
    cover_image = case when excluded.cover_image <> '' then excluded.cover_image else releases.cover_image end;
end;
$$;

revoke execute on function public.seed_releases(jsonb) from public, anon, authenticated;
grant execute on function public.seed_releases(jsonb) to service_role;
```

**Verify after apply**:

```sql
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='releases' and column_name='gone_at') as gone_at_col,  -- 1
  (select array_agg(distinct grantee order by grantee) from information_schema.routine_privileges
    where routine_schema='public' and routine_name='seed_releases') as seed_grantees,                 -- {postgres,service_role}
  (select array_agg(distinct grantee order by grantee) from information_schema.routine_privileges
    where routine_schema='public' and routine_name='pending_enrichment') as pe_grantees;              -- {postgres,service_role}
```

## Task 2 — `supabase/functions/import-collection/index.ts`: seed through the RPC

Replace:

```ts
    // SEED FIRST. Migration 0005 added collection_items.release_id -> releases(release_id);
    // inserting an item whose release row does not exist yet now violates the FK, so the
    // catalog seed must land before the items that reference it.
    // ignoreDuplicates: an already-enriched (or already-seeded) release row is NEVER
    // overwritten -- seeding must not regress tracks back to null.
    const { error: seedErr } = await admin.from('releases')
      .upsert([...seeds.values()], { onConflict: 'release_id', ignoreDuplicates: true });
```

with:

```ts
    // SEED FIRST. Migration 0005 added collection_items.release_id -> releases(release_id);
    // inserting an item whose release row does not exist yet now violates the FK, so the
    // catalog seed must land before the items that reference it.
    // Phase 2 (#3): seeds now MERGE — last-import-wins on the basic fields, so Discogs
    // community corrections propagate on every import. The seed_releases RPC (0010)
    // empty-guards each field ('' / 0 / [] never stomp a real value), and seeds carry no
    // deep fields, so enrichment (tracks etc.) cannot regress.
    const { error: seedErr } = await admin.rpc('seed_releases',
      { p_rows: [...seeds.values()] });
```

(The error handling below it — `if (seedErr) { … 'store_failed' }` — is unchanged.)

## Task 3 — `supabase/functions/enrich-release/index.ts` v5: process refresh work

Edit 3a — replace the discovery block's tail (from `const ownedCount` through the
`if (totalPending === 0) { … }` early return) with:

```ts
  const ownedCount = Number(work?.owned ?? 0);
  const totalPending = Number(work?.total ?? 0);
  const newIds: number[] = Array.isArray(work?.pending) ? work.pending.map(Number) : [];
  const refreshTotal = Number(work?.refresh_total ?? 0);
  const refreshIds: number[] = Array.isArray(work?.refresh) ? work.refresh.map(Number) : [];

  if (ownedCount === 0) {
    // A legitimately empty collection is a completed import. Close the gate.
    const { error: emptyErr } = await admin.from('profiles')
      .update({ last_import_at: new Date().toISOString() }).eq('user_id', userId);
    if (emptyErr) console.error('last_import_at (empty) failed:', emptyErr.message);
    return json({ enriched: 0, remaining: 0, refreshed: 0, refresh_pending: 0 });
  }

  // Phase 2 (#3): NEW work first (it alone drives `remaining` and the boot gate),
  // leftover budget goes to refresh work — tombstone retries (7d), then stale rows
  // (180d), as ordered by the RPC. The gate closes on new work exactly as before;
  // refresh can never hold a first render hostage.
  const batch: Array<{ rid: number; isNew: boolean }> = [
    ...newIds.map((rid) => ({ rid, isNew: true })),
    ...refreshIds.map((rid) => ({ rid, isNew: false })),
  ].slice(0, BUDGET);

  if (totalPending === 0) {
    const { error: noneErr } = await admin.from('profiles')
      .update({ last_import_at: new Date().toISOString() }).eq('user_id', userId);
    if (noneErr) console.error('last_import_at (none-pending) failed:', noneErr.message);
    if (batch.length === 0) {
      return json({ enriched: 0, remaining: 0, refreshed: 0, refresh_pending: refreshTotal });
    }
    // No new work, but refresh work exists: fall through and process it.
  }
```

Edit 3b — replace the loop header and counters:

```ts
  let enriched = 0;
  let rateLimited = false;
  for (let i = 0; i < batch.length; i++) {
    const rid = batch[i];
```

with:

```ts
  let enriched = 0;    // NEW-work completions only: drives `remaining` and the gate
  let refreshed = 0;   // refresh completions (tombstone retries + stale re-fetches)
  let rateLimited = false;
  for (let i = 0; i < batch.length; i++) {
    const { rid, isNew } = batch[i];
```

Edit 3c — the 404 branch: replace its update payload and counter with:

```ts
      const { error: goneErr } = await admin.from('releases').update({
        tracks: [], country: '', released: '', videos: [],
        enriched_at: new Date().toISOString(),
        // Phase 2 (#3): the tombstone is now DATED, so it retries after 7 days instead
        // of being permanent. A re-tombstone (still 404 on retry) re-dates it.
        gone_at: new Date().toISOString(),
      }).eq('release_id', rid);
      if (goneErr) console.error('404 tombstone failed:', rid, goneErr.message);
      else if (isNew) enriched++;
      else refreshed++;
      continue;
```

Edit 3d — the success-path update gains `gone_at: null`, and the counter splits:

```ts
    const { error: upErr } = await admin.from('releases').update({
      tracks: tracklist,
      country: (rel.country as string) ?? '',
      released: (rel.released_formatted as string) || (rel.released as string) || '',
      videos,
      enriched_at: new Date().toISOString(),
      gone_at: null,   // Phase 2 (#3): a success clears any tombstone.
    }).eq('release_id', rid);
    if (upErr) { console.error('enrich update failed:', rid, upErr.message); continue; }
    if (isNew) enriched++;
    else refreshed++;
```

Edit 3e — the tail:

```ts
  const remaining = totalPending - enriched;
  if (remaining === 0) {
    const { error: doneErr } = await admin.from('profiles')
      .update({ last_import_at: new Date().toISOString() }).eq('user_id', userId);
    if (doneErr) console.error('last_import_at update failed:', doneErr.message);
  }
  return json({ enriched, remaining, refreshed,
    refresh_pending: Math.max(0, refreshTotal - refreshed), rate_limited: rateLimited });
```

(Also update the file's header comment first paragraph to mention refresh work; and note
the `if (totalPending === 0)` early-return no longer returns before refresh work — the
gate update stays, the return goes conditional, per Edit 3a.)

## Task 4 — `public/boot.js`: the drain loop learns about refresh work

Replace inside `backgroundEnrich()`:

```js
      let prevRemaining = Infinity, noProgress = 0;
      for (let i = 0; i < 500; i++) {
        let d;
        try { d = await _pipeAttempt(() => _pipeCall('enrich-release', {})); }
        catch (e) { console.warn('background enrich stopped:', e); break; }
        if (d.remaining === 0) break;
        if (d.rate_limited) {
          await new Promise((r) => setTimeout(r, 30000));
          continue;
        }
        noProgress = d.remaining >= prevRemaining ? noProgress + 1 : 0;
        prevRemaining = d.remaining;
        if (noProgress >= 3) {
          console.warn('enrichment stalled at', d.remaining, '— resumes next visit');
          break;
        }
      }
```

with:

```js
      let prevWork = Infinity, noProgress = 0;
      for (let i = 0; i < 500; i++) {
        let d;
        try { d = await _pipeAttempt(() => _pipeCall('enrich-release', {})); }
        catch (e) { console.warn('background enrich stopped:', e); break; }
        // Phase 2 (#3): the loop drains refresh work (tombstone retries, stale rows)
        // after new work. refresh_pending is absent from pre-v5 responses → 0 → the
        // loop behaves exactly as before during rollout.
        const work = d.remaining + (d.refresh_pending || 0);
        if (work === 0) break;
        if (d.rate_limited) {
          await new Promise((r) => setTimeout(r, 30000));
          continue;
        }
        noProgress = work >= prevWork ? noProgress + 1 : 0;
        prevWork = work;
        if (noProgress >= 3) {
          console.warn('enrichment stalled at', work, 'pending — resumes next visit');
          break;
        }
      }
```

Progress accounting sanity: every processed refresh id leaves the due set (success
re-stamps `enriched_at` + clears `gone_at`; a re-tombstone re-dates `gone_at` 7 days
out), so `work` decreases on any productive round — except the accepted edge in Open
item 5 (a row crossing the 180-day boundary mid-drain cancels one completion for one
round) — and the guard still trips only on genuine stalls (repeated non-404 errors).

## Task 5 — Verification battery

- **V1 (pre-execution measurement):** `select count(*) from public.releases where
  tracks = '[]'::jsonb;` — the plan assumes 0 live tombstones; if any exist, they are
  legacy-ambiguous rows and stay tombstone-free (`gone_at` null → treated as
  fully-enriched genuinely-empty tracklists; acceptable, documented here).
- **V2 syntax:** esbuild on both functions; `node --check public/app.js` untouched;
  esbuild `public/boot.js`.
- **V3 migration checks** per Task 1's verify block.
- **V4 RPC state matrix** (rev1-F1: the RPC is ownership-gated, so the synthetic user
  MUST own the rows). Setup, in this order (0005 FK requires releases first): insert 5
  `releases` rows with ids 999999011–015 — A: `tracks` null; B: `tracks='[]'::jsonb,
  gone_at=now()`; C: `tracks='[]'::jsonb, gone_at=now()-interval '8 days'`; D:
  `tracks='[{"pos":"A1"}]'::jsonb, enriched_at=now()-interval '181 days'`; E:
  `tracks='[{"pos":"A1"}]'::jsonb` (fresh default enriched_at). Then insert 5
  `collection_items` rows for user `cr_test_user` referencing them (instance_id = the
  release id; no profiles row needed — collection_items.user_id has no FK). Expect
  `pending=[A]`, `total=1`, `refresh=[C, D]` in that order, `refresh_total=2`; B and E
  in neither list. Cleanup in reverse order (items, then releases).
- **V5 seed merge semantics** (same synthetic rows): call `seed_releases` with a row
  carrying new artist + empty cover for release E → artist updates, cover survives;
  and a full row for a NEW release id → inserted with `tracks` null.
- **V6 forged token → 401** on `enrich-release` and `import-collection` after deploys
  (browser probe from traxwax.com, expect `{"error":"invalid_token"}`).
- **V7 live E2E (Lane, after the push):** poison-and-heal probes on owned rows via SQL:
  (a) set one release's `artist = 'ZZZ_PROBE'` → RE-SYNC → artist restored by the
  merge; (b) set one release's `gone_at = now() - interval '8 days'` → reload the crate
  → background drain re-fetches it within a minute (verify `gone_at` back to null,
  `enriched_at` fresh); (c) set one release's `enriched_at = now() - interval '181
  days'` → reload → same healing. All three probes verified by SQL readback.

## Task 6 — Docs, version, handoff

- `CHANGELOG.md` `[1.2.0]`: catalog refresh (tombstone retries, TTL re-enrichment,
  live metadata merge). `VERSION` → `1.2.0`.
- `docs/roadmap.md`: move "Catalog refresh path (GitHub #3)" from Next to Shipped.
- Handoff chain commit: `Closes #3`.

## Rollout order (safety-critical)

1. Migration 0010 (RPC superset keeps deployed v4 functions working).
2. Deploy enrich-release v5, then import-collection v3.
3. Frontend push (boot.js loop).
Between 2 and 3, old boot.js + new functions (rev1-F2 correction): each visit's final
invocation still processes up to 5 refresh rows before returning `remaining: 0` — so
refresh TRICKLES at ≤5/visit until the new loop lands, rather than waiting entirely.
Either way: no breakage window.

## Open items / accepted edges

1. Un-owned releases (every owner deleted their account/collection) are never refreshed —
  nobody's token covers them, and nobody renders them either. Acceptable.
2. The 500-iteration loop cap bounds one visit's refresh drain to ~2,500 rows; a bigger
  backlog resumes next visit. Fine at any plausible catalog size per user.
3. Legacy `tracks='[]'` rows (V1) cannot be distinguished retroactively; they refresh
  through the 180-day TTL path eventually.
4. **Accepted (rev1-F4):** refresh-only rounds stamp `last_import_at` twice per
  invocation (the 3a gate write + the 3e tail write). Harmless — the gate is a
  null-check, and v4 already re-stamps every visit via its none-pending branch; the
  `lastSyncedAt` tooltip creep is pre-existing behavior.
5. **Accepted (rev1-F8):** `work` can hold steady across one invocation when a row
  crosses the 180-day boundary mid-drain (+1 cancels a completion), costing one
  `noProgress` increment; it cannot trip the guard (needs 3 consecutive) by itself.
6. **Verify-block note (rev1-F7):** the grantee check's real pass condition is
  "contains service_role, contains none of anon/authenticated/PUBLIC" — the exact set
  depends on the migration-executing role.

---

## Audit record — rev 1 → rev 2 (2026-08-29)

Independent no-context verification of rev 1: **EXECUTE-READY with amendments**. All
folded: **F1 (MAJOR)** — the V4 battery omitted the `collection_items` ownership rows
the RPC gates on (would have returned all-zeroes) and never pinned `tracks` values for
states C/D; setup now fully specified with insert/cleanup order. **F3** — two
`pending_enrichment` citations said 0009; it lives in 0008 (one was headed into the
committed migration comment). **F2** — the rollout section claimed old-boot visits
would drain no refresh work; they trickle ≤5/visit (conclusion unchanged). **F4/F8** —
double-stamp and boundary-crossing wobble now recorded as accepted. **F5** — array_agg
order pinned WITH ORDINALITY. **F6** — `order by 1` on the insert-select removes a
theoretical concurrent-import deadlock under DO UPDATE row locks. **F7** — grantee
check's pass condition restated. Verified correct by the same pass: all replace-anchors
byte-exact against the current files, the empty-guard merge regression-free, gate
semantics branch-identical to v4, both rollout directions compatible, V7 timing
realistic, arithmetic, and the modal's static-file fallback already DB-first (no change
needed).
