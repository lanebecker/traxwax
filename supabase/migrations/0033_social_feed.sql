-- 0033_social_feed.sql — read-only aggregate for the header status feed (#59).
-- Per friend, the CURRENT overlap release-id sets between the caller and that friend, each gated by the existing consent helpers.
-- The client diffs these against a localStorage baseline to decide what is "new". No history, no writes, no price.

-- helper 1: friend-side release_ids overlapping the caller, exact or (any-mode) master. Bounded.
create or replace function private._feed_overlap(p_their_kind text, p_their_user text, p_my_kind text, p_my_user text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_any boolean := (coalesce((select match_mode from public.profiles where user_id = p_my_user),'exact') = 'any');
  v_out jsonb;
begin
  with their_rows as (
    select t.release_id, r.master_id from (
      select release_id from public.collection_items where p_their_kind='crate' and user_id=p_their_user
      union all
      select release_id from public.wantlist_items  where p_their_kind='wants' and user_id=p_their_user
      union all
      select release_id from public.inventory_items where p_their_kind='inv'   and user_id=p_their_user and status='for_sale'
    ) t join public.releases r on r.release_id = t.release_id
  ),
  my_rows as (
    select m.release_id, r.master_id from (
      select release_id from public.collection_items where p_my_kind='crate' and user_id=p_my_user
      union all
      select release_id from public.wantlist_items  where p_my_kind='wants' and user_id=p_my_user
      union all
      select release_id from public.inventory_items where p_my_kind='inv'   and user_id=p_my_user and status='for_sale'
    ) m join public.releases r on r.release_id = m.release_id
  )
  select coalesce(jsonb_agg(rid order by rid), '[]'::jsonb) into v_out
  from (
    select distinct tr.release_id as rid
    from their_rows tr
    where exists (
      select 1 from my_rows mr
      where mr.release_id = tr.release_id
         or (v_any and tr.master_id is not null and mr.master_id = tr.master_id)
    )
    order by 1
    limit 200
  ) s;
  return v_out;
end;
$$;

-- helper 2: their wantlist INTERSECT (my crate MINUS my inventory) — the "you have, unlisted" split (#4).
create or replace function private._feed_overlap_unlisted(p_their_user text, p_my_user text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_any boolean := (coalesce((select match_mode from public.profiles where user_id = p_my_user),'exact') = 'any');
  v_out jsonb;
begin
  with their_wants as (
    select w.release_id, r.master_id from public.wantlist_items w
    join public.releases r on r.release_id = w.release_id where w.user_id = p_their_user
  ),
  my_have as (
    select c.release_id, r.master_id from public.collection_items c
    join public.releases r on r.release_id = c.release_id where c.user_id = p_my_user
  ),
  my_listed as (select release_id from public.inventory_items where user_id = p_my_user and status='for_sale')
  select coalesce(jsonb_agg(rid order by rid), '[]'::jsonb) into v_out
  from (
    select distinct tw.release_id as rid
    from their_wants tw
    where exists (
      select 1 from my_have mh
      where (mh.release_id = tw.release_id or (v_any and tw.master_id is not null and mh.master_id = tw.master_id))
        and mh.release_id not in (select release_id from my_listed)
    )
    order by 1
    limit 200
  ) s;
  return v_out;
end;
$$;

-- the aggregate: one object per friend of the caller.
create or replace function public.get_social_feed()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',            f.friend_id,
    'discogs_username',   pr.discogs_username,
    'display_name',       pr.display_name,
    'avatar_url',         pr.avatar_url,
    'can_crate',          private.can_view_crate(auth.jwt()->>'sub', f.friend_id),
    'can_want',           private.can_view_wantlist(auth.jwt()->>'sub', f.friend_id),
    'can_forsale',        private.can_view_forsale(auth.jwt()->>'sub', f.friend_id),
    'forsale_you_want',   case when private.can_view_forsale(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('inv',   f.friend_id, 'wants', auth.jwt()->>'sub') else '[]'::jsonb end,
    'crate_you_want',     case when private.can_view_crate(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('crate', f.friend_id, 'wants', auth.jwt()->>'sub') else '[]'::jsonb end,
    'they_want_you_sell', case when private.can_view_wantlist(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('wants', f.friend_id, 'inv',   auth.jwt()->>'sub') else '[]'::jsonb end,
    'they_want_you_have', case when private.can_view_wantlist(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap_unlisted(f.friend_id, auth.jwt()->>'sub') else '[]'::jsonb end,
    'crate_you_own',      case when private.can_view_crate(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('crate', f.friend_id, 'crate', auth.jwt()->>'sub') else '[]'::jsonb end,
    'mutual_want',        case when private.can_view_wantlist(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('wants', f.friend_id, 'wants', auth.jwt()->>'sub') else '[]'::jsonb end
  )), '[]'::jsonb)
  from public.friendships f
  join public.profiles pr on pr.user_id = f.friend_id
  where f.user_id = auth.jwt()->>'sub';
$$;

revoke all on function private._feed_overlap(text,text,text,text) from public, anon;
revoke all on function private._feed_overlap_unlisted(text,text) from public, anon;
grant execute on function private._feed_overlap(text,text,text,text) to authenticated, service_role;
grant execute on function private._feed_overlap_unlisted(text,text) to authenticated, service_role;
revoke all on function public.get_social_feed() from public, anon;
grant execute on function public.get_social_feed() to authenticated;
