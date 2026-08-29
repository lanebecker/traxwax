-- 0010_catalog_refresh.sql — Phase 2: catalog refresh (GitHub #3, cold audit #15).
-- 404 tombstones retry after 7 days; deep fields re-fetch after 180 days; basic
-- metadata is merged (empty-guarded, last-import-wins) on every import.
-- Plan: docs/phase-2-catalog-refresh-plan.md (rev 2, twice audited).

-- ── Tombstone marker. tracks='[]' alone is ambiguous: a real release with no
--    tracklist and a 404 both wrote []. gone_at set on 404, cleared on success.
alter table public.releases add column if not exists gone_at timestamptz;

-- ── Work discovery, extended. Same name/signature/grants as 0008 (CREATE OR REPLACE
--    preserves both); returns a SUPERSET of the old keys so the deployed enrich-release
--    v4 keeps working until v5 lands. New work ('pending') alone drives the boot gate;
--    'refresh' is tombstones due (7d) then stale rows (180d), oldest first.
create or replace function public.pending_enrichment(p_user_id text, p_limit integer)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'owned', (select count(*) from public.collection_items ci
               where ci.user_id = p_user_id),
    'total', (select count(*)
                from public.releases r
               where r.tracks is null
                 and exists (select 1 from public.collection_items ci
                              where ci.user_id = p_user_id
                                and ci.release_id = r.release_id)),
    'pending', coalesce((select jsonb_agg(t.release_id)
                from (select r.release_id
                        from public.releases r
                       where r.tracks is null
                         and exists (select 1 from public.collection_items ci
                                      where ci.user_id = p_user_id
                                        and ci.release_id = r.release_id)
                       order by r.release_id
                       limit p_limit) t), '[]'::jsonb),
    'refresh_total', (select count(*)
                from public.releases r
               where r.tracks is not null
                 and ( (r.gone_at is not null and r.gone_at < now() - interval '7 days')
                    or (r.gone_at is null and r.enriched_at < now() - interval '180 days') )
                 and exists (select 1 from public.collection_items ci
                              where ci.user_id = p_user_id
                                and ci.release_id = r.release_id)),
    'refresh', coalesce((select jsonb_agg(t.release_id)
                from (select r.release_id
                        from public.releases r
                       where r.tracks is not null
                         and ( (r.gone_at is not null and r.gone_at < now() - interval '7 days')
                            or (r.gone_at is null and r.enriched_at < now() - interval '180 days') )
                         and exists (select 1 from public.collection_items ci
                                      where ci.user_id = p_user_id
                                        and ci.release_id = r.release_id)
                       -- Tombstones before stale; oldest first within each class.
                       order by (r.gone_at is null), coalesce(r.gone_at, r.enriched_at)
                       limit p_limit) t), '[]'::jsonb)
  );
$$;

-- ── Empty-guarded metadata merge: last-import-wins, but a degraded incoming value
--    ('' / 0 / empty array) never stomps a real one. Seeds are the ONLY writer of the
--    basic fields, so this is the single merge point. Insert path uses the incoming
--    row as-is (matching today's seed). service_role-only like every writer RPC.
create or replace function public.seed_releases(p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.releases
    (release_id, artist, title, year, label, styles, genres, thumb, cover_image)
  select (r->>'release_id')::bigint,
         coalesce(r->>'artist', ''),
         coalesce(r->>'title', ''),
         coalesce((r->>'year')::int, 0),
         coalesce(r->>'label', ''),
         -- WITH ORDINALITY pins element order (rev1-F5: bare array_agg order is
         -- unguaranteed by spec, even if reliable in practice).
         coalesce((select array_agg(x.v order by x.o)
                     from jsonb_array_elements_text(r->'styles') with ordinality x(v, o)), '{}'),
         coalesce((select array_agg(x.v order by x.o)
                     from jsonb_array_elements_text(r->'genres') with ordinality x(v, o)), '{}'),
         coalesce(r->>'thumb', ''),
         coalesce(r->>'cover_image', '')
    from jsonb_array_elements(p_rows) r
   -- Deterministic row order (rev1-F6): DO UPDATE takes row locks; two concurrent
   -- imports upserting overlapping releases in different orders could deadlock.
   order by 1
  on conflict (release_id) do update set
    artist      = case when excluded.artist      <> '' then excluded.artist      else releases.artist      end,
    title       = case when excluded.title       <> '' then excluded.title       else releases.title       end,
    year        = case when excluded.year        <> 0  then excluded.year        else releases.year        end,
    label       = case when excluded.label       <> '' then excluded.label       else releases.label       end,
    styles      = case when coalesce(array_length(excluded.styles, 1), 0) > 0 then excluded.styles else releases.styles end,
    genres      = case when coalesce(array_length(excluded.genres, 1), 0) > 0 then excluded.genres else releases.genres end,
    thumb       = case when excluded.thumb       <> '' then excluded.thumb       else releases.thumb       end,
    cover_image = case when excluded.cover_image <> '' then excluded.cover_image else releases.cover_image end;
end;
$$;

revoke execute on function public.seed_releases(jsonb) from public, anon, authenticated;
grant execute on function public.seed_releases(jsonb) to service_role;
