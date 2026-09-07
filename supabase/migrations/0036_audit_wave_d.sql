-- 0036_audit_wave_d.sql — cold-audit v1.25, Wave D (perf & scale): D1 #90, D2 #91, D3 #92,
-- D8a/c #97, D9 #98. (D4/D6/D7/D8b are Edge-function changes; D5 is client-side.)
--
-- D1 (#90): get_social_feed was O(friends × 6 heavy aggregates) — per friend it made 9
--   consent probes and up to 6 _feed_overlap* calls, EACH of which re-materialized the
--   caller's ~1,861-row sides from scratch (≈180 aggregate materializations + ≈270 probes
--   per header load at 30 friends), with 16 un-wrapped auth.jwt() calls. Rewritten as ONE
--   set-based statement: the caller's three sides materialize once, each friend gets exactly
--   three consent probes, overlaps are six semi-joins over shared CTEs, friends capped at
--   100. Output contract byte-compatible (same keys, same per-set distinct/sort/limit-200,
--   jsonb key order is normalized by jsonb either way). The now-unused _feed_overlap helpers
--   are DROPPED — B5 (#73) already flagged them as a ready-made overlap oracle.
--
-- D2 (#91): the friend wantlist was the last table-wide friend RLS read
--   (wantlist_select_friends): private.can_view_wantlist is SECURITY DEFINER, never
--   inlined, so a 500-row wantlist cost 500 definer invocations — and the policy exposed
--   id / raw user_id (Clerk sub) / created_at / updated_at, exactly the columns 0021
--   deliberately stripped from the crate read. get_friend_wantlist mirrors 0021's
--   projection; the policy drops; can_view_wantlist loses its authenticated grant (its one
--   role-level caller is gone — B5's deferred cleanup).
--
-- D3 (#92): the probe-shaped indexes the newer RPCs assume. selling_you_want (0031) and the
--   feed probe (user_id, release_id) point lookups; collection_items and inventory_items
--   only had (user_id) — a 200-listing shop cost ~370k row visits PER FRIEND per
--   list_friends call. (wantlist_items already has unique(user_id, release_id) — verified.)
--   Plus a partial index for pending_enrichment's PENDING class (tracks-null, keyed
--   release_id — matches its order-by/limit exactly). The refresh class stays unindexed on
--   purpose (audit F2): its OR-of-two-thresholds predicate + (gone_at is null)-first sort
--   can't use a single expression index, and releases is small enough that honesty beats a
--   dead index.
--
-- D8a (#97a): seed_releases raised "cannot affect row a second time" on an intra-batch
--   duplicate release_id — unreachable only because the sole caller dedupes; the contract
--   now enforces it itself (DISTINCT ON, keep the last occurrence like the caller's Map did).
-- D8c (#97c): create_friend_invite returned 'ok' on unique_violation beside a comment
--   claiming "client retries" — the retry could never happen. Now returns 'retry' (client
--   change regenerates the code and retries once).
--
-- D9 (#98): 0031 guards master_id <> 0, 0033's replacement (above) inherits the writers'
--   0→NULL normalization — but nothing STOPPED a future writer storing raw 0, which would
--   make every no-master release any-match every other. Normalize any strays, then CHECK.

-- ── D3 (#92): indexes first (the D1 rewrite wants them in place) ─────────────────────────
create index if not exists collection_items_user_release_idx
  on public.collection_items (user_id, release_id);
create index if not exists inventory_items_user_release_idx
  on public.inventory_items (user_id, release_id) where status = 'for_sale';
create index if not exists releases_pending_idx
  on public.releases (release_id) where tracks is null;

-- ── D9 (#98): normalize strays, then forbid the footgun ──────────────────────────────────
update public.releases set master_id = null where master_id = 0;
alter table public.releases drop constraint if exists releases_master_id_chk;
alter table public.releases
  add constraint releases_master_id_chk check (master_id is null or master_id > 0);

-- ── D1 (#90): get_social_feed, set-based ─────────────────────────────────────────────────
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
  -- The caller's three sides, materialized ONCE (0033 rebuilt these up to 6× per friend).
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
  my_have_unlisted as (   -- "#4 you have, unlisted": my crate minus my for-sale (0033 semantics verbatim)
    select mc.release_id, mc.master_id from my_crate mc
     where mc.release_id not in (select release_id from my_inv)),
  -- One consent probe per friend per flag (0033 made nine). Hard cap: 100 friends per call.
  friends as (
    select f.friend_id, pr.discogs_username, pr.display_name, pr.avatar_url,
           private.can_view_crate(v_sub, f.friend_id)    as can_crate,
           private.can_view_wantlist(v_sub, f.friend_id) as can_want,
           private.can_view_forsale(v_sub, f.friend_id)  as can_forsale
      from public.friendships f
      join public.profiles pr on pr.user_id = f.friend_id
     where f.user_id = v_sub
     order by f.friend_id
     limit 100),
  -- Friend-side rows, one scan per table across ALL friends, consent-gated per row source.
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
  -- The six overlap sets. Match predicate is 0033's verbatim: exact release, or (any-mode)
  -- their master present and equal to mine (null masters never match — D9's CHECK now also
  -- forbids the 0 that would have made this predicate lie).
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
  -- Per (set, friend): distinct, sorted, capped at 200 — 0033's per-call shape, preserved.
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
grant execute on function public.get_social_feed() to authenticated;

-- The helpers are unreferenced now; B5 flagged them as an any-two-users oracle. Gone.
drop function if exists private._feed_overlap(text, text, text, text);
drop function if exists private._feed_overlap_unlisted(text, text);

-- ── D2 (#91): friend-wantlist projection, 0021's idiom exactly ───────────────────────────
-- Emits release_id/added/vinyl + release fields + master_id; strips the surrogate id (ord),
-- the raw Clerk sub, and both timestamps the old policy leaked. '[]' for every deny case.
create or replace function public.get_friend_wantlist(p_username text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(t) - 'ord' order by t.ord), '[]'::jsonb)
  from (
    select wi.id as ord,
           wi.release_id, wi.added, wi.vinyl,
           r.artist, r.title, r.year, r.label, r.styles, r.genres, r.thumb, r.cover_image,
           r.master_id
      from public.profiles p
      join public.wantlist_items wi on wi.user_id = p.user_id
      left join public.releases r on r.release_id = wi.release_id
     where lower(p.discogs_username) = lower(p_username)
       and private.can_view_wantlist((select auth.jwt())->>'sub', p.user_id)
  ) t;
$$;
revoke all on function public.get_friend_wantlist(text) from public, anon;
grant execute on function public.get_friend_wantlist(text) to authenticated;

-- The RPC is now the sole friend read path for the wantlist; the table-wide policy goes,
-- and with it can_view_wantlist's last role-level caller — minimum grants, per B5.
drop policy if exists wantlist_select_friends on public.wantlist_items;
revoke all on function private.can_view_wantlist(text, text) from public, anon, authenticated;
grant execute on function private.can_view_wantlist(text, text) to service_role;

-- ── D8a (#97a): seed_releases enforces its own intra-batch dedupe ────────────────────────
-- Body = 0024's, with the source de-duplicated (keep the LAST occurrence per release_id —
-- the caller's Map semantics). A second caller can no longer explode a whole import.
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
revoke all on function public.seed_releases(jsonb) from public, anon, authenticated;
grant execute on function public.seed_releases(jsonb) to service_role;

-- ── D8c (#97c): a hash collision now says so ─────────────────────────────────────────────
-- Body = 0034's (retention sweep included), with the exception handler telling the truth.
create or replace function public.create_friend_invite(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub    text := auth.jwt()->>'sub';
  v_active int;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  if not exists (select 1 from public.profiles where user_id = v_sub) then
    return jsonb_build_object('status','no_profile');
  end if;
  delete from public.friend_invites
   where expires_at < now()
     and (used_at is null or expires_at < now() - interval '30 days');
  select count(*) into v_active
    from public.friend_invites
   where inviter_id = v_sub and used_at is null and expires_at > now();
  if v_active >= 25 then return jsonb_build_object('status','too_many_invites'); end if;
  insert into public.friend_invites (code_hash, inviter_id) values (p_code_hash, v_sub);
  return jsonb_build_object('status','ok');
exception
  when unique_violation then return jsonb_build_object('status','retry');   -- D8c #97: the client NOW actually retries with a fresh code
end;
$$;
revoke all on function public.create_friend_invite(text) from public, anon;
grant execute on function public.create_friend_invite(text) to authenticated;

-- ── Apply-time verification ──────────────────────────────────────────────────────────────
-- 1. select indexname from pg_indexes where indexname in
--      ('collection_items_user_release_idx','inventory_items_user_release_idx',
--       'releases_pending_idx');                                       -- 3 rows
-- 2. select count(*) from public.releases where master_id = 0;         -- 0
-- 3. select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--     where n.nspname='private' and proname like '_feed%';             -- 0 rows (dropped)
-- 4. select polname from pg_policy where polname='wantlist_select_friends';  -- 0 rows
-- 5. select proacl::text from pg_proc where proname='can_view_wantlist';     -- no authenticated
-- 6. get_social_feed() as a real user: compare against a hand-computed overlap (the 0033
--    apply did crate_you_want=5 vs hand intersection — repeat that check).
-- 7. seed_releases with an intra-batch duplicate: no "cannot affect row a second time".
