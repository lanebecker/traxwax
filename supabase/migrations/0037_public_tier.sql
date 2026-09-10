-- 0037_public_tier.sql — Wave 5b T1 (plan: docs/wave-5b-plan.md, rev 3).
-- 1) 'public' joins the three visibility ladders (the CHECKs 0012/0018/0028 reserved for this).
-- 2) public_slug — the /c/<slug> identity (Discogs usernames are Restricted; the slug replaces them).
-- 3) og_palette — the owner's OG-card palette (D-PAL: white|red|black, default red).
-- 4) get_public_crate(p_slug) — THE ENTIRE anonymous read surface: one SECURITY DEFINER function,
--    no table policies for anon (mirrors the #42 projection-RPC posture). Unknown slug and
--    all-private slug both return NULL — indistinguishable by design (spec §6/§10).
-- 5) private.can_view_* amended so the FRIEND tier survives an owner going public (plan
--    verification F1): public is a superset of friends; predicates only, bodies otherwise verbatim.

-- ── 1. Visibility CHECKs ──────────────────────────────────────────────────────────────
alter table public.profiles drop constraint if exists profiles_crate_visibility_chk;
alter table public.profiles add constraint profiles_crate_visibility_chk
  check (crate_visibility in ('private','friends','public'));

alter table public.profiles drop constraint if exists profiles_wantlist_visibility_chk;
alter table public.profiles add constraint profiles_wantlist_visibility_chk
  check (wantlist_visibility in ('private','friends','public'));

alter table public.profiles drop constraint if exists profiles_forsale_visibility_chk;
alter table public.profiles add constraint profiles_forsale_visibility_chk
  check (forsale_visibility in ('private','friends','public'));

-- ── 2. Slug + palette (user-owned columns) ────────────────────────────────────────────
-- profiles_guard (0034 body) pins only OAuth columns + import watermarks, so the client updates
-- these under profiles_update_own RLS with no guard amendment. ≤18 chars, lowercase a-z 0-9 hyphen,
-- no leading/trailing hyphen (vanity URLs; the 18 cap is the OG footer one-line rule, header spec §7 O3).
alter table public.profiles add column if not exists public_slug text;
alter table public.profiles drop constraint if exists profiles_public_slug_chk;
alter table public.profiles add constraint profiles_public_slug_chk
  check (public_slug is null
         or public_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,16}[a-z0-9])?$');
create unique index if not exists profiles_public_slug_uq on public.profiles (public_slug);

alter table public.profiles add column if not exists og_palette text not null default 'red';
alter table public.profiles drop constraint if exists profiles_og_palette_chk;
alter table public.profiles add constraint profiles_og_palette_chk
  check (og_palette in ('white','red','black'));

-- ── 3. The anonymous read RPC ─────────────────────────────────────────────────────────
-- Projection = get_friend_crate (0024) MINUS rating, PLUS added + vinyl. NEVER price fields,
-- NEVER discogs_username — except `handle`, returned ONLY to an authenticated FRIEND for the
-- /app/{handle} redirect (spec §1). forsale is E1-gated (public for-sale requires a public crate).
-- display_name reduced server-side to "First L." (D-NAME). relation computed only under a JWT.
create or replace function public.get_public_crate(p_slug text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_sub  text := auth.jwt()->>'sub';
  v      record;
  pub_crate boolean; pub_want boolean; pub_fs boolean;
  v_rel  text := 'stranger';
  v_handle text := null;
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

  -- All-private ≡ unknown slug: byte-identical NULL (spec §6/§10).
  if not (pub_crate or pub_want) then return null; end if;

  -- Relation, for the client's redirect decisions (spec §1: owner → /app, friend → /app/{handle}).
  if v_sub is not null then
    if v_sub = v.user_id then
      v_rel := 'owner';
    elsif exists (select 1 from public.friendships f
                   where f.user_id = v_sub and f.friend_id = v.user_id) then
      v_rel := 'friend';
      v_handle := v.discogs_username;   -- the ONLY path a username leaves this function, friends only
    end if;
  end if;
  if v_rel <> 'stranger' then
    return jsonb_build_object('status','redirect','relation',v_rel,'handle',v_handle);
  end if;

  -- "First L." (D-NAME). Single-word names pass through; empty names get a neutral label.
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
             r.thumb, r.cover_image, r.master_id
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
             r.thumb, r.cover_image, r.master_id
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

-- ── 4. The FRIEND tier survives an owner going public (F1). Bodies verbatim from the live
--       defs (dumped 2026-09-10) except the visibility predicates: public ⊇ friends. The
--       friendship-row condition is untouched — these still answer for friend/self viewers only;
--       anonymous access remains get_public_crate's alone.
create or replace function private.can_view_crate(p_viewer text, p_owner text)
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
         and pr.crate_visibility in ('friends','public')
    );
$function$;

create or replace function private.can_view_wantlist(p_viewer text, p_owner text)
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
         and pr.wantlist_visibility in ('friends','public')
    );
$function$;

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
         and pr.crate_visibility   in ('friends','public')
         and pr.forsale_visibility in ('friends','public')
    );
$function$;

-- ── 5. Grants — the whole new anon surface is this one function ──────────────────────
revoke all on function public.get_public_crate(text) from public;
grant execute on function public.get_public_crate(text) to anon, authenticated;
