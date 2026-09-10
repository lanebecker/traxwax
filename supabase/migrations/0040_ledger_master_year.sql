-- 0040_ledger_master_year.sql — CHECK-IN 2 (v1.31.0) remediation-audit finding 1.
-- The BY DECADE ledger panel bins on the ORIGINAL-release year (releases.master_year, 0032),
-- pressing year as fallback — the owner projection has done this since Wave 5a, but the friend
-- and public RPCs never returned master_year, so their histograms binned a 1998 repress of a
-- 1974 LP in the 1990s. Now that the panel renders for every viewer (friend gained it in
-- CHECK-IN 2), all three tiers must agree. Both functions are their prior bodies (0024 / 0039)
-- + r.master_year in the row projections; grants unchanged. master_year is catalog data
-- (per-release, no owner fields), so nothing new is exposed to anon.

create or replace function public.get_friend_crate(p_username text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(t) - 'ord' order by t.ord), '[]'::jsonb)
  from (
    select ci.id as ord,
           ci.release_id, ci.added, ci.rating, ci.vinyl,
           r.artist, r.title, r.year, r.label, r.styles, r.genres, r.thumb, r.cover_image, r.master_id, r.master_year
      from public.profiles p
      join public.collection_items ci on ci.user_id = p.user_id
      left join public.releases r on r.release_id = ci.release_id
     where lower(p.discogs_username) = lower(p_username)
       and private.can_view_crate(auth.jwt()->>'sub', p.user_id)
  ) t;
$$;
revoke all on function public.get_friend_crate(text) from public, anon;
grant execute on function public.get_friend_crate(text) to authenticated;

create or replace function public.get_public_crate(p_slug text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_sub  text := auth.jwt()->>'sub';
  v      record;
  pub_crate boolean; pub_want boolean; pub_fs boolean;
  v_name text;
  j_crate jsonb := '[]'::jsonb; j_want jsonb := '[]'::jsonb; j_fs jsonb := '[]'::jsonb;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,16}[a-z0-9])?$' then
    return null;
  end if;

  select user_id, discogs_username, display_name, avatar_url, collecting_since,
         crate_visibility, wantlist_visibility, forsale_visibility, og_palette
    into v
    from public.profiles
   where public_slug = p_slug;
  if not found then return null; end if;

  pub_crate := v.crate_visibility    = 'public';
  pub_want  := v.wantlist_visibility = 'public';
  pub_fs    := v.forsale_visibility  = 'public' and pub_crate;   -- E1: for-sale rides under crate

  -- Relation FIRST (0038): an owner or friend under a JWT gets their redirect whatever the
  -- visibility state — the friend tier is theirs regardless (can_view_* gates it server-side),
  -- and the owner's CLOSED page keys off 'open'. Strangers fall through to the all-private
  -- gate below and stay indistinguishable from an unknown slug.
  if v_sub is not null then
    if v_sub = v.user_id then
      return jsonb_build_object('status','redirect','relation','owner',
                                'open', (pub_crate or pub_want));
    elsif (v.crate_visibility <> 'private' or v.wantlist_visibility <> 'private')
          and exists (select 1 from public.friendships f
                       where f.user_id = v_sub and f.friend_id = v.user_id) then
      return jsonb_build_object('status','redirect','relation','friend',
                                'handle', v.discogs_username);
    end if;
  end if;

  -- All-private ≡ unknown slug for everyone who remains (spec §6/§10).
  if not (pub_crate or pub_want) then return null; end if;

  v_name := case
    when v.display_name is null or btrim(v.display_name) = '' then 'A Collector'
    when position(' ' in btrim(v.display_name)) = 0 then btrim(v.display_name)
    else split_part(btrim(v.display_name), ' ', 1) || ' ' ||
         upper(left(regexp_replace(btrim(v.display_name), '^.*\s', ''), 1)) || '.'
  end;

  if pub_crate then
    select coalesce(jsonb_agg(to_jsonb(t) - 'ord' order by t.ord), '[]'::jsonb) into j_crate
    from (
      select ci.id as ord, ci.release_id, ci.added, ci.vinyl,
             r.artist, r.title, r.year, r.label, r.styles, r.genres,
             r.thumb, r.cover_image, r.master_id, r.master_year
        from public.collection_items ci
        left join public.releases r on r.release_id = ci.release_id
       where ci.user_id = v.user_id
    ) t;
  end if;

  if pub_want then
    select coalesce(jsonb_agg(to_jsonb(t) - 'ord' order by t.ord), '[]'::jsonb) into j_want
    from (
      select wi.id as ord, wi.release_id, wi.added, wi.vinyl,
             r.artist, r.title, r.year, r.label, r.styles, r.genres,
             r.thumb, r.cover_image, r.master_id, r.master_year
        from public.wantlist_items wi
        left join public.releases r on r.release_id = wi.release_id
       where wi.user_id = v.user_id
    ) t;
  end if;

  if pub_fs then
    select coalesce(jsonb_agg(jsonb_build_object('release_id', ii.release_id,
                                                 'listing_id', ii.listing_id)
                              order by ii.id), '[]'::jsonb) into j_fs
    from public.inventory_items ii
    where ii.user_id = v.user_id and ii.status = 'for_sale';
  end if;

  return jsonb_build_object(
    'status','ok',
    'relation','stranger',
    'owner', jsonb_build_object(
      'display_name', v_name,
      'avatar_url', v.avatar_url,
      'collecting_since', v.collecting_since,
      'og_palette', v.og_palette),
    'sections', jsonb_build_object('crate', pub_crate, 'wantlist', pub_want, 'forsale', pub_fs),
    'crate', j_crate,
    'wantlist', j_want,
    'forsale', j_fs);
end;
$function$;
