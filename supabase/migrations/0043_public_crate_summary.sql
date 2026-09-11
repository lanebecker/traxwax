-- 0043_public_crate_summary.sql — cold audit v1.31 / #200 (absorbs #158, T3.8c).
--
-- get_public_crate returns the whole crate (1.40 MB for 1,876 rows). functions/c and functions/og
-- call it on EVERY anon request and parse it only to derive a count, a top style, and six cover
-- URLs — per-request Worker CPU that trips Cloudflare's 1102 limit on ~10% of requests, so ~1 in 10
-- shared links renders no card / no page. This adds get_public_crate_summary: a PROJECTION of
-- get_public_crate with byte-identical gating (slug / profile / visibility / relation-first /
-- all-private / display-name), but on the 'ok' path it returns only the hot path's needs — count,
-- top 3 styles, six cover URLs — computed in Postgres. get_public_crate is UNCHANGED; the browser
-- render (boot.js) still calls it. Keep the GATING block below in lockstep with get_public_crate.

create or replace function public.get_public_crate_summary(p_slug text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_sub  text := auth.jwt()->>'sub';
  v      record;
  pub_crate boolean; pub_want boolean; pub_fs boolean;
  v_name  text;
  v_count integer := 0;
  v_styles jsonb  := '[]'::jsonb;
  v_covers jsonb  := '[]'::jsonb;
begin
  -- GATING — copied from public.get_public_crate statement-for-statement (keep in lockstep).
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

  -- Relation FIRST (0038): owner/friend under a JWT get their redirect whatever the visibility.
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

  -- All-private == unknown slug for everyone who remains (spec 6/10).
  if not (pub_crate or pub_want) then return null; end if;

  v_name := case
    when v.display_name is null or btrim(v.display_name) = '' then 'A Collector'
    when position(' ' in btrim(v.display_name)) = 0 then btrim(v.display_name)
    else split_part(btrim(v.display_name), ' ', 1) || ' ' ||
         upper(left(regexp_replace(btrim(v.display_name), '^.*\s', ''), 1)) || '.'
  end;

  -- PROJECTION — derive the hot path's scalars from the LEADING public section.
  -- Leading section = crate when crate is public, else wantlist (mirrors functions/c + functions/og).
  -- count = leading section row count (get_public_crate LEFT JOINs releases, so it counts items).
  -- top_styles = top 3 by record count; ties broken by TRUE first appearance = (item id, then
  --   style index within the item's styles array), via unnest ... with ordinality + a global
  --   row_number(), so it matches JS Object.keys(styleCounts) insertion order + a stable count-desc
  --   sort exactly (min(item id) alone would tie styles first co-occurring in one release).
  -- covers = the 6 most-recent rows' cover URLs (thumb || cover_image), recency = added desc then
  --   item id desc; nullif('') reproduces JS `||` falsy-on-empty-string; the https filter + fetch +
  --   collapse stay in functions/og.
  if pub_crate then
    select count(*)::int into v_count
      from public.collection_items ci where ci.user_id = v.user_id;

    select coalesce(jsonb_agg(style order by cnt desc, first_seq asc), '[]'::jsonb) into v_styles
      from (
        select st as style, count(*) as cnt, min(seq) as first_seq
          from (
            select u.st,
                   row_number() over (order by ci.id, u.ord) as seq
              from public.collection_items ci
              join public.releases r on r.release_id = ci.release_id
              cross join lateral unnest(r.styles) with ordinality as u(st, ord)
             where ci.user_id = v.user_id
          ) z
         group by st
         order by cnt desc, first_seq asc
         limit 3
      ) s;

    select coalesce(jsonb_agg(url order by rn), '[]'::jsonb) into v_covers
      from (
        select coalesce(nullif(r.thumb,''), nullif(r.cover_image,'')) as url,
               row_number() over (order by ci.added desc, ci.id desc) as rn
          from public.collection_items ci
          left join public.releases r on r.release_id = ci.release_id
         where ci.user_id = v.user_id
         order by ci.added desc, ci.id desc
         limit 6
      ) x
     where x.url is not null;
  else
    select count(*)::int into v_count
      from public.wantlist_items wi where wi.user_id = v.user_id;

    select coalesce(jsonb_agg(style order by cnt desc, first_seq asc), '[]'::jsonb) into v_styles
      from (
        select st as style, count(*) as cnt, min(seq) as first_seq
          from (
            select u.st,
                   row_number() over (order by wi.id, u.ord) as seq
              from public.wantlist_items wi
              join public.releases r on r.release_id = wi.release_id
              cross join lateral unnest(r.styles) with ordinality as u(st, ord)
             where wi.user_id = v.user_id
          ) z
         group by st
         order by cnt desc, first_seq asc
         limit 3
      ) s;

    select coalesce(jsonb_agg(url order by rn), '[]'::jsonb) into v_covers
      from (
        select coalesce(nullif(r.thumb,''), nullif(r.cover_image,'')) as url,
               row_number() over (order by wi.added desc, wi.id desc) as rn
          from public.wantlist_items wi
          left join public.releases r on r.release_id = wi.release_id
         where wi.user_id = v.user_id
         order by wi.added desc, wi.id desc
         limit 6
      ) x
     where x.url is not null;
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
    'count', v_count,
    'top_styles', v_styles,
    'covers', v_covers);
end;
$function$;

-- Grants: match get_public_crate's reach exactly (anon, authenticated, service_role); public revoked.
revoke all on function public.get_public_crate_summary(text) from public;
grant execute on function public.get_public_crate_summary(text) to anon, authenticated, service_role;
