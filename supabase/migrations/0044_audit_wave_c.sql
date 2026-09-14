-- 0044_audit_wave_c.sql — cold-audit v1.31, Wave C (database hygiene):
--   #157 (T3.8b): get_social_feed — drop the undocumented `friends limit 100` (restore 0033's uncapped
--                 contract; the per-set 200-id cap stays). Silent, arbitrary, permanent truncation removed.
--   #159 (T3.8d): pending_enrichment — each work-class matching set is materialized ONCE, so its count and
--                 its ordered/limited list read the same rows (the refresh class was the only true double
--                 full-scan; pending/master were index-served). Same predicates/limits/jsonb shape; the
--                 refresh + master lists gain a release_id tiebreaker so pagination is DETERMINISTIC (0032
--                 left ties arbitrary). The consumer (enrich-release) de-dupes and drains, so it is
--                 order-tolerant; result SET is unchanged except that ties straddling p_limit are now
--                 resolved deterministically instead of arbitrarily.
--   #205:         seed_releases — `artist` becomes FIRST-writer-wins (fill only when the stored value is
--                 empty). Guarantees a full re-import can never change an existing non-empty artist, and lets
--                 the import-collection inventory seedRow safely carry a (cleaned) best-effort artist for
--                 for-sale-only releases. Every other field stays last-writer-wins-on-non-empty (enrich
--                 writes them with higher fidelity later; artist is the sole fidelity-asymmetry field).
--   #160 (T3.8e): drop three bare (user_id) indexes shadowed by leading-user_id composites (pure write
--                 amplification). The 0032 master-year partial index is NOT dropped — its drain is not
--                 complete (1020 rows pending, idx_scan 4425); that drop is a later cleanup.
--
-- No data migration. All three function bodies are CREATE OR REPLACE (name/signature/ACL preserved); the
-- revoke/grant lines reproduce the current ACL exactly and are idempotent.

-- ── #157 (T3.8b): get_social_feed, uncapped friends. Body is 0036's def VERBATIM except the single
--    `limit 100` line is removed from the `friends` CTE. Per-set distinct/sort/limit-200 unchanged. ─────────
create or replace function public.get_social_feed()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub text := (select auth.jwt()->>'sub');
  v_any boolean;
  v_out jsonb;
begin
  if v_sub is null then return '[]'::jsonb; end if;
  v_any := (coalesce((select match_mode from public.profiles where user_id = v_sub), 'exact') = 'any');

  with
  my_crate as (
    select c.release_id, r.master_id
      from public.collection_items c join public.releases r on r.release_id = c.release_id
     where c.user_id = v_sub),
  my_wants as (
    select w.release_id, r.master_id
      from public.wantlist_items w join public.releases r on r.release_id = w.release_id
     where w.user_id = v_sub),
  my_inv as (
    select i.release_id, r.master_id
      from public.inventory_items i join public.releases r on r.release_id = i.release_id
     where i.user_id = v_sub and i.status = 'for_sale'),
  my_have_unlisted as (
    select mc.release_id, mc.master_id from my_crate mc
     where mc.release_id not in (select release_id from my_inv)),
  -- #157 (T3.8b): NO `limit` here. 0036 added `limit 100`, undocumented vs 0033 and contradicting 0036's own
  -- "byte-compatible" header; it truncated friends arbitrarily (order by opaque Clerk sub) and permanently.
  friends as (
    select f.friend_id, pr.discogs_username, pr.display_name, pr.avatar_url,
           private.can_view_crate(v_sub, f.friend_id)    as can_crate,
           private.can_view_wantlist(v_sub, f.friend_id) as can_want,
           private.can_view_forsale(v_sub, f.friend_id)  as can_forsale
      from public.friendships f
      join public.profiles pr on pr.user_id = f.friend_id
     where f.user_id = v_sub
     order by f.friend_id),
  their_crate as (
    select fr.friend_id, c.release_id, r.master_id
      from friends fr
      join public.collection_items c on c.user_id = fr.friend_id
      join public.releases r on r.release_id = c.release_id
     where fr.can_crate),
  their_wants as (
    select fr.friend_id, w.release_id, r.master_id
      from friends fr
      join public.wantlist_items w on w.user_id = fr.friend_id
      join public.releases r on r.release_id = w.release_id
     where fr.can_want),
  their_inv as (
    select fr.friend_id, i.release_id, r.master_id
      from friends fr
      join public.inventory_items i on i.user_id = fr.friend_id and i.status = 'for_sale'
      join public.releases r on r.release_id = i.release_id
     where fr.can_forsale),
  ov as (
    select 'forsale_you_want' as k, t.friend_id, t.release_id
      from their_inv t where exists (select 1 from my_wants m
        where m.release_id = t.release_id or (v_any and t.master_id is not null and m.master_id = t.master_id))
    union all
    select 'crate_you_want', t.friend_id, t.release_id
      from their_crate t where exists (select 1 from my_wants m
        where m.release_id = t.release_id or (v_any and t.master_id is not null and m.master_id = t.master_id))
    union all
    select 'they_want_you_sell', t.friend_id, t.release_id
      from their_wants t where exists (select 1 from my_inv m
        where m.release_id = t.release_id or (v_any and t.master_id is not null and m.master_id = t.master_id))
    union all
    select 'they_want_you_have', t.friend_id, t.release_id
      from their_wants t where exists (select 1 from my_have_unlisted m
        where m.release_id = t.release_id or (v_any and t.master_id is not null and m.master_id = t.master_id))
    union all
    select 'crate_you_own', t.friend_id, t.release_id
      from their_crate t where exists (select 1 from my_crate m
        where m.release_id = t.release_id or (v_any and t.master_id is not null and m.master_id = t.master_id))
    union all
    select 'mutual_want', t.friend_id, t.release_id
      from their_wants t where exists (select 1 from my_wants m
        where m.release_id = t.release_id or (v_any and t.master_id is not null and m.master_id = t.master_id))),
  capped as (
    select k, friend_id, jsonb_agg(release_id order by release_id) as ids
      from (select k, friend_id, release_id,
                   row_number() over (partition by k, friend_id order by release_id) as rn
              from (select distinct k, friend_id, release_id from ov) d) x
     where rn <= 200
     group by k, friend_id),
  per_friend as (
    select friend_id, jsonb_object_agg(k, ids) as sets from capped group by friend_id)
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id',            fr.friend_id,
      'discogs_username',   fr.discogs_username,
      'display_name',       fr.display_name,
      'avatar_url',         fr.avatar_url,
      'can_crate',          fr.can_crate,
      'can_want',           fr.can_want,
      'can_forsale',        fr.can_forsale,
      'forsale_you_want',   coalesce(pf.sets->'forsale_you_want',   '[]'::jsonb),
      'crate_you_want',     coalesce(pf.sets->'crate_you_want',     '[]'::jsonb),
      'they_want_you_sell', coalesce(pf.sets->'they_want_you_sell', '[]'::jsonb),
      'they_want_you_have', coalesce(pf.sets->'they_want_you_have', '[]'::jsonb),
      'crate_you_own',      coalesce(pf.sets->'crate_you_own',      '[]'::jsonb),
      'mutual_want',        coalesce(pf.sets->'mutual_want',        '[]'::jsonb)
    )), '[]'::jsonb)
    into v_out
    from friends fr
    left join per_friend pf on pf.friend_id = fr.friend_id;

  return v_out;
end;
$$;
revoke all on function public.get_social_feed() from public, anon;
grant execute on function public.get_social_feed() to authenticated;   -- service_role keeps its existing grant

-- ── #159 (T3.8d): pending_enrichment, one scan of `releases` per work-class. Predicates, limits and jsonb
--    shape match 0032's def; refresh/master lists add a release_id tiebreaker (deterministic pagination).
--    Only the count+list duplication is collapsed. Each class CTE is MATERIALIZED (also auto-materialized by
--    being referenced twice) → single scan. ─────────────────────────────────────────────────────────────
create or replace function public.pending_enrichment(p_user_id text, p_limit integer)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with
  pend as materialized (
    select r.release_id
      from public.releases r
     where r.tracks is null
       and ( exists (select 1 from public.collection_items ci
                      where ci.user_id = p_user_id and ci.release_id = r.release_id)
          or exists (select 1 from public.wantlist_items wi
                      where wi.user_id = p_user_id and wi.release_id = r.release_id) )
  ),
  refr as materialized (
    select r.release_id,
           (r.gone_at is null) as gone_is_null,
           coalesce(r.gone_at, r.enriched_at) as sort_ts
      from public.releases r
     where r.tracks is not null
       and ( (r.gone_at is not null and r.gone_at < now() - interval '7 days')
          or (r.gone_at is null and r.enriched_at < now() - interval '180 days') )
       and ( exists (select 1 from public.collection_items ci
                      where ci.user_id = p_user_id and ci.release_id = r.release_id)
          or exists (select 1 from public.wantlist_items wi
                      where wi.user_id = p_user_id and wi.release_id = r.release_id) )
  ),
  mast as materialized (
    select r.release_id, r.master_id
      from public.releases r
     where r.tracks is not null
       and r.master_id is not null and r.master_id <> 0 and r.master_year is null
       and exists (select 1 from public.collection_items ci
                    where ci.user_id = p_user_id and ci.release_id = r.release_id)
  )
  select jsonb_build_object(
    'owned', (select count(*) from public.collection_items ci
               where ci.user_id = p_user_id),
    'wanted', (select count(*) from public.wantlist_items wi
               where wi.user_id = p_user_id),
    'total', (select count(*) from pend),
    'pending', coalesce((select jsonb_agg(t.release_id)
                from (select release_id from pend
                       order by release_id
                       limit p_limit) t), '[]'::jsonb),
    'refresh_total', (select count(*) from refr),
    'refresh', coalesce((select jsonb_agg(t.release_id)
                from (select release_id from refr
                       order by gone_is_null, sort_ts, release_id   -- #159: release_id tiebreaker = deterministic
                       limit p_limit) t), '[]'::jsonb),
    'master_total', (select count(*) from mast),
    'master', coalesce((select jsonb_agg(jsonb_build_object('release_id', t.release_id, 'master_id', t.master_id))
                from (select release_id, master_id from mast
                       order by master_id, release_id   -- #159: release_id tiebreaker (master_id has ties) = deterministic
                       limit p_limit) t), '[]'::jsonb)
  );
$$;
revoke all on function public.pending_enrichment(text, integer) from public, anon, authenticated;
grant execute on function public.pending_enrichment(text, integer) to service_role;

-- ── #205: seed_releases — artist first-writer-wins; every other field unchanged. Body is 0036's def
--    (DISTINCT ON intra-batch dedupe kept) with the SINGLE artist ON CONFLICT line inverted. ───────────────
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
    from (select distinct on ((e.val->>'release_id')::bigint) e.val as r
            from jsonb_array_elements(p_rows) with ordinality e(val, ord)
           order by (e.val->>'release_id')::bigint, e.ord desc) s
   order by 1
  on conflict (release_id) do update set
    -- #205: FIRST-writer-wins for artist — keep the stored value whenever it is non-empty, else take the
    -- incoming one. Makes a full re-import provably unable to change an existing non-empty artist, and lets
    -- a for-sale-only release keep the (cleaned) artist the inventory seedRow now supplies.
    artist      = case when releases.artist      <> '' then releases.artist      else excluded.artist      end,
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
revoke all on function public.seed_releases(jsonb) from public, anon, authenticated;
grant execute on function public.seed_releases(jsonb) to service_role;

-- ── #160 (T3.8e): drop the three bare (user_id) indexes shadowed by leading-user_id composites. Pure write
--    amplification; every WHERE user_id = X access migrates to the composite. IF EXISTS = replay-safe.
--    (releases_master_year_pending_idx is intentionally KEPT — its master-year drain is not complete.)
drop index if exists public.collection_items_user_idx;
drop index if exists public.wantlist_items_user_idx;
drop index if exists public.inventory_items_user_idx;

-- ── Apply-time verification ──────────────────────────────────────────────────────────────
-- 1. select count(*) from pg_indexes where schemaname='public'
--      and indexname in ('collection_items_user_idx','wantlist_items_user_idx','inventory_items_user_idx');  -- 0
-- 2. select 1 from pg_indexes where indexname='releases_master_year_pending_idx';                            -- 1 (kept)
-- 3. get_social_feed() as a real user: friend count in the payload == (select count(*) from friendships where user_id=<me>).
-- 4. pending_enrichment(<user>, 200) == the pre-deploy value for the same user (differential, see §5).
-- 5. select proacl::text from pg_proc where proname in
--      ('get_social_feed','pending_enrichment','seed_releases');   -- unchanged from §1.
