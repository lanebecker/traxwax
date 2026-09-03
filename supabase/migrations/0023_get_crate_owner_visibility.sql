-- 0023_get_crate_owner_visibility.sql — cold-audit #43.
-- get_crate_owner authorized ONLY on can_view_crate, so a friend who shared their WANTLIST but kept their
-- crate private got 'no_crate' and couldn't load the page at all. Authorize on can_view_crate OR
-- can_view_wantlist, and RETURN both booleans so the frontend can render locked tabs + land on the shared
-- section. Both-private (or not-friends / no-such-user) still returns 'no_crate' — no existence probe.
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
  v_can_crate boolean;
  v_can_want  boolean;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  select user_id, discogs_username, display_name, avatar_url, bio, location,
         collecting_since, link1, link2
    into v
    from public.profiles
   where lower(discogs_username) = lower(p_username);
  if not found then return jsonb_build_object('status','no_crate'); end if;
  v_can_crate := private.can_view_crate(v_sub, v.user_id);
  v_can_want  := private.can_view_wantlist(v_sub, v.user_id);
  if not (v_can_crate or v_can_want) then
    return jsonb_build_object('status','no_crate');   -- both closed / not shared → S16, no existence probe
  end if;
  return jsonb_build_object('status','ok',
    'can_view_crate', v_can_crate,
    'can_view_wantlist', v_can_want,
    'owner', jsonb_build_object(
      'user_id', v.user_id, 'discogs_username', v.discogs_username,
      'display_name', v.display_name, 'avatar_url', v.avatar_url, 'bio', v.bio,
      'location', v.location, 'collecting_since', v.collecting_since,
      'link1', v.link1, 'link2', v.link2));
end;
$$;
