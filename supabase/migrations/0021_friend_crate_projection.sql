-- 0021_friend_crate_projection.sql — cold-audit #42 (friend-crate read projection).
-- collection_select_friends (0012→0013→0020) is a table-wide friend SELECT, so a consented friend can
-- read the owner's `folder` (Discogs folder label) + `instance_id` (internal Discogs id) even though the
-- crate grid never shows them. Decision (Lane 2026-09-01): ratings STAY visible to friends. So expose the
-- friend crate through a SECURITY DEFINER projection that keeps `rating` and omits folder/instance_id,
-- gated on private.can_view_crate, and DROP the table-wide friend policy so the raw columns are no longer
-- friend-readable. Returns a jsonb ARRAY (not setof) so no PostgREST db-max-rows cap can silently truncate
-- a large crate; an unauthorized/absent viewer gets '[]' (no existence probe, mirrors crate_match's shape).

create or replace function public.get_friend_crate(p_username text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  -- `- 'ord'` strips the internal collection_items.id (used only to preserve insertion order) from
  -- the emitted object, so the friend payload leaks NO internal id (not instance_id, not the surrogate).
  select coalesce(jsonb_agg(to_jsonb(t) - 'ord' order by t.ord), '[]'::jsonb)
  from (
    select ci.id as ord,
           ci.release_id, ci.added, ci.rating, ci.vinyl,
           r.artist, r.title, r.year, r.label, r.styles, r.genres, r.thumb, r.cover_image
      from public.profiles p
      join public.collection_items ci on ci.user_id = p.user_id
      left join public.releases r on r.release_id = ci.release_id
     where lower(p.discogs_username) = lower(p_username)
       and private.can_view_crate(auth.jwt()->>'sub', p.user_id)
  ) t;
$$;
revoke all on function public.get_friend_crate(text) from public, anon;
grant execute on function public.get_friend_crate(text) to authenticated;

-- The RPC is now the sole friend read path for the crate; remove the table-wide friend SELECT.
drop policy if exists collection_select_friends on public.collection_items;
