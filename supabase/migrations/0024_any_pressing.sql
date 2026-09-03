-- 0024_any_pressing.sql — #28 (optional any-pressing / master-level matching).
-- (1) releases.master_id: the Discogs MASTER (album) id, captured free from basic_information (import) and the
--     release GET (enrich). Nullable — one-offs have no master, and un-backfilled rows read as exact-only.
-- (2) seed_releases merges master_id (import path).
-- (3) profiles.match_mode: the VIEWER's reading preference ('exact' default | 'any'); user-settable (the
--     profiles_guard only pins OAuth columns), read-only w.r.t. RLS.
-- (4) get_friend_crate returns master_id so the friend crate can badge any-pressing matches.

alter table public.releases add column if not exists master_id bigint;

alter table public.profiles
  add column if not exists match_mode text not null default 'exact';
alter table public.profiles
  drop constraint if exists profiles_match_mode_chk;
alter table public.profiles
  add constraint profiles_match_mode_chk check (match_mode in ('exact','any'));

-- seed_releases: same body as 0010 + master_id (insert col, seed value, empty-guarded merge).
create or replace function public.seed_releases(p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.releases
    (release_id, artist, title, year, label, styles, genres, thumb, cover_image, master_id)
  select (r->>'release_id')::bigint,
         coalesce(r->>'artist', ''),
         coalesce(r->>'title', ''),
         coalesce((r->>'year')::int, 0),
         coalesce(r->>'label', ''),
         coalesce((select array_agg(x.v order by x.o)
                     from jsonb_array_elements_text(r->'styles') with ordinality x(v, o)), '{}'),
         coalesce((select array_agg(x.v order by x.o)
                     from jsonb_array_elements_text(r->'genres') with ordinality x(v, o)), '{}'),
         coalesce(r->>'thumb', ''),
         coalesce(r->>'cover_image', ''),
         nullif(nullif(r->>'master_id',''),'0')::bigint   -- Discogs sends master_id 0 for no-master releases → store NULL
    from jsonb_array_elements(p_rows) r
   order by 1
  on conflict (release_id) do update set
    artist      = case when excluded.artist      <> '' then excluded.artist      else releases.artist      end,
    title       = case when excluded.title       <> '' then excluded.title       else releases.title       end,
    year        = case when excluded.year        <> 0  then excluded.year        else releases.year        end,
    label       = case when excluded.label       <> '' then excluded.label       else releases.label       end,
    styles      = case when coalesce(array_length(excluded.styles, 1), 0) > 0 then excluded.styles else releases.styles end,
    genres      = case when coalesce(array_length(excluded.genres, 1), 0) > 0 then excluded.genres else releases.genres end,
    thumb       = case when excluded.thumb       <> '' then excluded.thumb       else releases.thumb       end,
    cover_image = case when excluded.cover_image <> '' then excluded.cover_image else releases.cover_image end,
    master_id   = case when excluded.master_id is not null then excluded.master_id else releases.master_id end;
end;
$$;

revoke execute on function public.seed_releases(jsonb) from public, anon, authenticated;
grant execute on function public.seed_releases(jsonb) to service_role;

-- get_friend_crate: add master_id to the projection (rest identical to 0021's strip-ord form).
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
           r.artist, r.title, r.year, r.label, r.styles, r.genres, r.thumb, r.cover_image, r.master_id
      from public.profiles p
      join public.collection_items ci on ci.user_id = p.user_id
      left join public.releases r on r.release_id = ci.release_id
     where lower(p.discogs_username) = lower(p_username)
       and private.can_view_crate(auth.jwt()->>'sub', p.user_id)
  ) t;
$$;
revoke all on function public.get_friend_crate(text) from public, anon;
grant execute on function public.get_friend_crate(text) to authenticated;
