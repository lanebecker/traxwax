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
--    Body copied verbatim from the live def; the ONLY additions are v_can_forsale (decl + assign + json key).
--    forsale is deliberately NOT added to the (crate or want) access gate — it must not grant crate access.
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

-- 5. Grants — get_friend_forsale is called by the client via supabase.rpc(); expose to authenticated only
--    (mirror get_friend_crate). can_view_forsale stays private (unexposed), like can_view_crate.
revoke all on function public.get_friend_forsale(text) from public, anon;
grant execute on function public.get_friend_forsale(text) to authenticated;
