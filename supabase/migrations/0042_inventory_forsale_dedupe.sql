-- 0042_inventory_forsale_dedupe.sql — Cold audit v1.31, #135 (T2.13).
--
-- inventory_items legitimately allows a user MULTIPLE for-sale listings of one release (the UNIQUE is
-- on (user_id, listing_id) — two copies of a pressing = two rows, same release_id). But the surfacing is
-- one-per-release: boot.js builds Map<release_id → listing_id> and paints a single FOR SALE badge, while
-- get_friend_forsale and get_public_crate's for-sale block emitted ONE object PER LISTING (order by id).
-- So a two-listing release produced two same-release objects → the Map's last write won nondeterministically
-- (one buy-link unreachable), and the array length disagreed with list_friends.selling_you_want, which
-- counts collection rows per release via EXISTS (= 1). Reproduced RED→GREEN on local Postgres 16.
--
-- Fix — collapse to ONE deterministic listing per release in the projections. The multi-copy TABLE stays
-- intact on purpose: a hard (user_id, release_id) UNIQUE would reject legitimate two-copy data and break
-- the per-listing import (upsert on (user_id, listing_id)). DISTINCT ON (release_id) ordered by listing_id
-- picks the lowest (oldest, IMMUTABLE) listing_id — stable across imports, unlike updated_at, which the
-- touch trigger churns every sync. This realigns the arrays with the per-release count and feeds boot.js
-- unambiguous data (no JS change). list_friends is unchanged (already per-release). Surfacing "N copies for
-- sale" is a deliberate future feature, tracked separately — not here.
--
-- Also add the status CHECK the readers have always assumed: the import writes only 'for_sale'
-- (import-collection/index.ts) and every reader filters status='for_sale', so the domain is exactly
-- {'for_sale'}; widening it later (a lifecycle status) is a deliberate one-line migration.
--
-- Replay-safe: CHECK drop-then-add; CREATE OR REPLACE; grants re-asserted (B5/#73 posture).

-- 1. status domain. Drop-then-add is idempotent; ADD validates existing rows (all 'for_sale' today).
alter table public.inventory_items drop constraint if exists inventory_items_status_check;
alter table public.inventory_items
  add constraint inventory_items_status_check check (status in ('for_sale'));

-- 2. get_friend_forsale — one listing per release, deterministic (lowest listing_id).
create or replace function public.get_friend_forsale(p_username text)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('release_id', d.release_id, 'listing_id', d.listing_id)
                            order by d.release_id), '[]'::jsonb)
  from (
    select distinct on (ii.release_id) ii.release_id, ii.listing_id
      from public.profiles p
      join public.inventory_items ii on ii.user_id = p.user_id and ii.status = 'for_sale'
     where lower(p.discogs_username) = lower(p_username)
       and private.can_view_forsale(auth.jwt()->>'sub', p.user_id)
     order by ii.release_id, ii.listing_id   -- #135: DISTINCT ON keeps the lowest listing_id per release
  ) d;
$function$;

-- 3. get_public_crate — verbatim from the live definition; ONLY the pub_fs block gains the same dedup.
create or replace function public.get_public_crate(p_slug text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
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
    -- #135 (T2.13): one deterministic listing per release (lowest listing_id), so the array agrees
    -- with the per-release count and boot.js's Map<release_id→listing_id> is unambiguous.
    select coalesce(jsonb_agg(jsonb_build_object('release_id', d.release_id,
                                                 'listing_id', d.listing_id)
                              order by d.release_id), '[]'::jsonb) into j_fs
    from (
      select distinct on (ii.release_id) ii.release_id, ii.listing_id
        from public.inventory_items ii
       where ii.user_id = v.user_id and ii.status = 'for_sale'
       order by ii.release_id, ii.listing_id
    ) d;
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

-- 4. Grants (B5/#73). CREATE OR REPLACE preserves the ACL; re-assert so the file is correct standalone.
revoke all on function public.get_friend_forsale(text) from public, anon;
grant execute on function public.get_friend_forsale(text) to authenticated;

revoke all on function public.get_public_crate(text) from public;
grant execute on function public.get_public_crate(text) to anon, authenticated;
