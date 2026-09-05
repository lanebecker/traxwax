-- 0032_master_year.sql — Wave 5a: original-release (master) year for the Collection DNA card.
-- releases.year is the PRESSING year; the DNA "decades" card must read the master's original-release
-- year (a 2024 repress of a 1971 LP must count as the 1970s, not the 2020s). master_year is deduplicated
-- CC0 catalog data (many pressings share one master), filled by the enrich-release master-backfill drain;
-- this migration adds the column + partial index + surfaces the work via pending_enrichment.
-- Plan: docs/wave-5a-master-year-plan.md (verification-passed — the RPC rewrite preserves 0017's `wanted`
-- + collection∪wantlist union verbatim and appends only master_total + master).

-- ── The column. NULL = "not yet resolved"; 0 = "resolved, no usable master year" (sentinel → client falls
--    back to pressing year); >0 = the real original-release year.
alter table public.releases add column if not exists master_year int;

-- ── Partial index so the drain's "which rows still need a master year" scan stays cheap as it fills.
create index if not exists releases_master_year_pending_idx
  on public.releases (master_id)
  where master_year is null and master_id is not null;

-- ── pending_enrichment: 0017 body VERBATIM (owned, wanted, and the collection∪wantlist union across all four
--    work subqueries) + a THIRD class, master-year backfill. COLLECTION-scoped (mirrors the DNA card's own-
--    collection scope; wantlist master years aren't spent on). Returns {release_id, master_id} so the handler
--    dedupes by master with no re-query. CREATE OR REPLACE preserves name/signature/grants; the currently
--    deployed handler ignores the two new keys until its v-next lands.
create or replace function public.pending_enrichment(p_user_id text, p_limit integer)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'owned', (select count(*) from public.collection_items ci
               where ci.user_id = p_user_id),
    'wanted', (select count(*) from public.wantlist_items wi
               where wi.user_id = p_user_id),
    'total', (select count(*)
                from public.releases r
               where r.tracks is null
                 and ( exists (select 1 from public.collection_items ci
                                where ci.user_id = p_user_id and ci.release_id = r.release_id)
                    or exists (select 1 from public.wantlist_items wi
                                where wi.user_id = p_user_id and wi.release_id = r.release_id) )),
    'pending', coalesce((select jsonb_agg(t.release_id)
                from (select r.release_id
                        from public.releases r
                       where r.tracks is null
                         and ( exists (select 1 from public.collection_items ci
                                        where ci.user_id = p_user_id and ci.release_id = r.release_id)
                            or exists (select 1 from public.wantlist_items wi
                                        where wi.user_id = p_user_id and wi.release_id = r.release_id) )
                       order by r.release_id
                       limit p_limit) t), '[]'::jsonb),
    'refresh_total', (select count(*)
                from public.releases r
               where r.tracks is not null
                 and ( (r.gone_at is not null and r.gone_at < now() - interval '7 days')
                    or (r.gone_at is null and r.enriched_at < now() - interval '180 days') )
                 and ( exists (select 1 from public.collection_items ci
                                where ci.user_id = p_user_id and ci.release_id = r.release_id)
                    or exists (select 1 from public.wantlist_items wi
                                where wi.user_id = p_user_id and wi.release_id = r.release_id) )),
    'refresh', coalesce((select jsonb_agg(t.release_id)
                from (select r.release_id
                        from public.releases r
                       where r.tracks is not null
                         and ( (r.gone_at is not null and r.gone_at < now() - interval '7 days')
                            or (r.gone_at is null and r.enriched_at < now() - interval '180 days') )
                         and ( exists (select 1 from public.collection_items ci
                                        where ci.user_id = p_user_id and ci.release_id = r.release_id)
                            or exists (select 1 from public.wantlist_items wi
                                        where wi.user_id = p_user_id and wi.release_id = r.release_id) )
                       order by (r.gone_at is null), coalesce(r.gone_at, r.enriched_at)
                       limit p_limit) t), '[]'::jsonb),
    -- ── NEW (Wave 5a): master-year backfill. Collection-scoped, enriched, real master, no master_year yet.
    'master_total', (select count(*)
                from public.releases r
               where r.tracks is not null
                 and r.master_id is not null and r.master_id <> 0 and r.master_year is null
                 and exists (select 1 from public.collection_items ci
                              where ci.user_id = p_user_id and ci.release_id = r.release_id)),
    'master', coalesce((select jsonb_agg(jsonb_build_object('release_id', t.release_id, 'master_id', t.master_id))
                from (select r.release_id, r.master_id
                        from public.releases r
                       where r.tracks is not null
                         and r.master_id is not null and r.master_id <> 0 and r.master_year is null
                         and exists (select 1 from public.collection_items ci
                                      where ci.user_id = p_user_id and ci.release_id = r.release_id)
                       order by r.master_id
                       limit p_limit) t), '[]'::jsonb)
  );
$$;
