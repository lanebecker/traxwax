-- 0019_crate_match_distinct.sql — Wave 2 Stage B1 fix (cold audit): crate_match over-counted.
-- 0018 computed the two match counts with a plain JOIN to collection_items, which is unique on
-- (user_id, instance_id) NOT (user_id, release_id) — a user owning K copies of a release inflated
-- the count by K. Switch to EXISTS (semi-join): each wantlist row (unique per release) is counted
-- once iff the other side owns the release. No behavior change other than the corrected count.
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
     where myw.user_id = v_sub
       and exists (select 1 from public.collection_items theirc
                    where theirc.user_id = v_owner and theirc.release_id = myw.release_id);
  end if;
  if private.can_view_wantlist(v_sub, v_owner) then
    select count(*) into v_twyh
      from public.wantlist_items theirw
     where theirw.user_id = v_owner
       and exists (select 1 from public.collection_items myc
                    where myc.user_id = v_sub and myc.release_id = theirw.release_id);
  end if;
  return jsonb_build_object('status','ok','you_want_they_have',v_ywth,'they_want_you_have',v_twyh);
end;
$$;
