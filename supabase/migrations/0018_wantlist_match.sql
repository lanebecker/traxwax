-- 0018_wantlist_match.sql — Wave 2 Stage B1: wantlist visibility + the match RPC (read path).
-- Depends on 0017 (wantlist_items). Mirrors the Wave 1 crate-consent shape exactly, for wantlists.

-- ── wantlist_visibility on profiles (independent of crate_visibility). Extensible like
--    crate_visibility (0012): Wave 5 adds 'public' by amending this CHECK. ─────────────────────
alter table public.profiles
  add column if not exists wantlist_visibility text not null default 'private';
alter table public.profiles
  drop constraint if exists profiles_wantlist_visibility_chk;
alter table public.profiles
  add constraint profiles_wantlist_visibility_chk
  check (wantlist_visibility in ('private','friends'));   -- Wave 5: add 'public' here

-- ── private.can_view_wantlist: the wantlist choke point. Mirrors private.can_view_crate (0013)
--    but gates on wantlist_visibility. In the `private` schema so PostgREST does NOT expose it.
create or replace function private.can_view_wantlist(p_viewer text, p_owner text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    p_viewer = p_owner
    or exists (
      select 1
        from public.profiles pr
        join public.friendships f
          on f.user_id = p_viewer and f.friend_id = p_owner
       where pr.user_id = p_owner
         and pr.wantlist_visibility = 'friends'
    );
$$;
revoke all on function private.can_view_wantlist(text, text) from public, anon;
grant execute on function private.can_view_wantlist(text, text) to authenticated, service_role;

-- ── wantlist_items: friend-readable SELECT under the wantlist gate. ORed with wantlist_select_own.
create policy wantlist_select_friends on public.wantlist_items
  for select using (private.can_view_wantlist(auth.jwt()->>'sub', user_id));

-- ── crate_match: browser-callable match counts for the MATCHES stat. SECURITY DEFINER; returns
--    NULLs uniformly for no-such-user / own / not-shared so it is not an existence/friendship probe.
--    you_want_they_have: your wantlist ∩ their collection — gated on can_view_crate.
--    they_want_you_have: their wantlist ∩ your collection — gated on can_view_wantlist.
create or replace function public.crate_match(p_owner_username text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_sub   text := auth.jwt()->>'sub';
  v_owner text;
  v_ywth  int;
  v_twyh  int;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  select user_id into v_owner from public.profiles
   where lower(discogs_username) = lower(p_owner_username);
  if not found or v_owner = v_sub then
    return jsonb_build_object('status','ok','you_want_they_have',null,'they_want_you_have',null);
  end if;
  if private.can_view_crate(v_sub, v_owner) then
    select count(*) into v_ywth
      from public.wantlist_items myw
      join public.collection_items theirc
        on theirc.release_id = myw.release_id and theirc.user_id = v_owner
     where myw.user_id = v_sub;
  end if;
  if private.can_view_wantlist(v_sub, v_owner) then
    select count(*) into v_twyh
      from public.wantlist_items theirw
      join public.collection_items myc
        on myc.release_id = theirw.release_id and myc.user_id = v_sub
     where theirw.user_id = v_owner;
  end if;
  return jsonb_build_object('status','ok','you_want_they_have',v_ywth,'they_want_you_have',v_twyh);
end;
$$;
revoke all on function public.crate_match(text) from public, anon;
grant execute on function public.crate_match(text) to authenticated;
