-- 0017_wantlist.sql — Wave 2 Stage A: wantlist data path (schema + work-discovery redesign).
-- No user-facing surface — the match RPC, badges, and THE WANTLIST view are Stage B.
-- Depends on 0016. wantlist_items mirrors collection_items' Restricted posture: own-token
-- import, deleted on disconnect/deletion. Friend-read RLS is DEFERRED to Stage B (the match
-- RPC is SECURITY DEFINER and needs no friend-read policy).

-- ── wantlist_items: which releases a user WANTS. One row per (user, release). ────
create table if not exists public.wantlist_items (
  id           bigint generated always as identity primary key,
  user_id      text   not null,
  release_id   bigint not null references public.releases(release_id),
  added        date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, release_id)
);
create index if not exists wantlist_items_user_idx    on public.wantlist_items (user_id);
create index if not exists wantlist_items_release_idx on public.wantlist_items (release_id);

-- Same db-clock updated_at trigger as collection_items (reuse touch_updated_at from 0004), so
-- import's stale-sweep (updated_at < started_at) works identically.
drop trigger if exists wantlist_items_touch on public.wantlist_items;
create trigger wantlist_items_touch
  before insert or update on public.wantlist_items
  for each row execute function public.touch_updated_at();

-- ── RLS: owner-only read + write (mirror collection_select_own / collection_write_own, 0001).
alter table public.wantlist_items enable row level security;
create policy wantlist_select_own on public.wantlist_items
  for select using (auth.jwt()->>'sub' = user_id);
create policy wantlist_write_own on public.wantlist_items
  for all using (auth.jwt()->>'sub' = user_id)
          with check (auth.jwt()->>'sub' = user_id);

-- ── pending_enrichment: broaden the FOUR work subqueries to (collection ∪ wantlist), add `wanted`.
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
                       limit p_limit) t), '[]'::jsonb)
  );
$$;

-- ── Amend unlink_discogs_account (0009 body + wantlist delete). ─────────────────────────────
create or replace function public.unlink_discogs_account(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where user_id = p_user_id) then
    return jsonb_build_object('status', 'no_profile');
  end if;
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.wantlist_items        where user_id = p_user_id;   -- Wave 2 Stage A
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  update public.profiles
     set discogs_username     = null,
         discogs_connected_at = null,
         last_import_at       = null,
         import_status        = 'idle'
   where user_id = p_user_id;
  return jsonb_build_object('status', 'ok');
end;
$$;

-- ── Amend delete_account (CURRENT 0012 body — friendships + friend_invites — + wantlist). ────
create or replace function public.delete_account(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existed boolean;
begin
  v_existed := exists (select 1 from public.profiles where user_id = p_user_id);
  delete from public.friendships           where user_id = p_user_id or friend_id = p_user_id;
  delete from public.friend_invites        where inviter_id = p_user_id;
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.wantlist_items        where user_id = p_user_id;   -- Wave 2 Stage A
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  delete from public.profiles              where user_id = p_user_id;
  return jsonb_build_object('status','ok','existed', v_existed);
end;
$$;

revoke all on function public.unlink_discogs_account(text) from public, anon, authenticated;
revoke all on function public.delete_account(text)         from public, anon, authenticated;
grant execute on function public.unlink_discogs_account(text) to service_role;
grant execute on function public.delete_account(text)         to service_role;
