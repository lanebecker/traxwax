-- 0008_bug_batch.sql — post-launch bug batch (issues #4, #6)
--
-- ISSUE #4 (cold audit #16): enrich-release discovered its work with ~18 DB round trips
-- per invocation (a paginated owned-ids scan working around PostgREST's silent 1,000-row
-- cap, then chunked IN-list pending probes) — roughly 6,700 queries to enrich a fresh
-- 1,861-item collection. One join RPC replaces the whole discovery pass and returns the
-- three numbers the function needs in a single trip.
--
-- SECURITY DEFINER and service-role-only, same posture as link_discogs_account: p_user_id
-- is the Edge Function's VERIFIED Clerk sub, so this must never be reachable with a
-- client-chosen user id. Idempotent: create or replace + revoke/grant are safely re-runnable.

create or replace function public.pending_enrichment(p_user_id text, p_limit integer)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    -- Items the caller owns (rows, not distinct releases): 0 means "empty collection —
    -- close the import gate", mirroring the old owned-set check.
    'owned', (select count(*) from public.collection_items ci
               where ci.user_id = p_user_id),
    -- Distinct owned releases still un-enriched. tracks IS NULL is the pending flag
    -- (enriched_at is stamped even on seed rows and cannot be used — Stage C).
    'total', (select count(*)
                from public.releases r
               where r.tracks is null
                 and exists (select 1 from public.collection_items ci
                              where ci.user_id = p_user_id
                                and ci.release_id = r.release_id)),
    -- This invocation's batch, oldest release-id first for a stable drain order.
    'pending', coalesce((select jsonb_agg(t.release_id)
                from (select r.release_id
                        from public.releases r
                       where r.tracks is null
                         and exists (select 1 from public.collection_items ci
                                      where ci.user_id = p_user_id
                                        and ci.release_id = r.release_id)
                       order by r.release_id
                       limit p_limit) t), '[]'::jsonb)
  );
$$;

revoke execute on function public.pending_enrichment(text, integer)
  from public, anon, authenticated;
grant execute on function public.pending_enrichment(text, integer) to service_role;

-- ISSUE #6 (cold audit #20, dead code sweep): profiles.display_name was never read or
-- written by any client or function — the 0007 guard trigger doesn't touch it, boot.js
-- never selects it, and no UI surfaces it. The 0006 column-level UPDATE grant that named
-- it disappears with the column. Re-add deliberately if profiles ever grow a display name.

alter table public.profiles drop column if exists display_name;
