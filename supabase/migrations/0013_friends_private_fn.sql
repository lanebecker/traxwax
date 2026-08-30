-- 0013_friends_private_fn.sql — Wave 1 security follow-up (advisor 0029, caught at apply time).
-- 0012 created can_view_crate in `public`, which PostgREST exposes as /rest/v1/rpc/can_view_crate.
-- Because it takes arbitrary (viewer, owner) args, any signed-in user could probe whether ANY two
-- people are friends-with-consent — a friendship-graph privacy leak. Move it into a `private`
-- schema that PostgREST does not expose. It stays usable inside the collection_items RLS policy
-- (which requires the querying role to hold EXECUTE — verified) and inside get_crate_owner.
-- live-stats does its authorization inline (admin table reads), NOT via this function.

create schema if not exists private;
grant usage on schema private to authenticated, anon, service_role;

create or replace function private.can_view_crate(p_viewer text, p_owner text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_viewer = p_owner
    or exists (
      select 1
        from public.profiles pr
        join public.friendships f
          on f.user_id = p_viewer and f.friend_id = p_owner
       where pr.user_id = p_owner
         and pr.crate_visibility = 'friends'
    );
$$;
revoke all on function private.can_view_crate(text, text) from public;
grant execute on function private.can_view_crate(text, text) to authenticated, anon, service_role;

-- Repoint the collection_items friend policy to the private function.
drop policy if exists collection_select_friends on public.collection_items;
create policy collection_select_friends on public.collection_items
  for select using (private.can_view_crate(auth.jwt()->>'sub', user_id));

-- Repoint get_crate_owner (SECURITY DEFINER, so it may call the private function).
create or replace function public.get_crate_owner(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub text := auth.jwt()->>'sub';
  v record;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  select user_id, discogs_username, display_name, avatar_url, bio, location,
         collecting_since, link1, link2
    into v
    from public.profiles
   where lower(discogs_username) = lower(p_username);
  if not found then return jsonb_build_object('status','no_crate'); end if;
  if not private.can_view_crate(v_sub, v.user_id) then
    return jsonb_build_object('status','no_crate');
  end if;
  return jsonb_build_object('status','ok', 'owner', jsonb_build_object(
    'user_id', v.user_id, 'discogs_username', v.discogs_username,
    'display_name', v.display_name, 'avatar_url', v.avatar_url, 'bio', v.bio,
    'location', v.location, 'collecting_since', v.collecting_since,
    'link1', v.link1, 'link2', v.link2));
end;
$$;

-- Drop the exposed public version now that the policy and get_crate_owner use the private one.
drop function if exists public.can_view_crate(text, text);
