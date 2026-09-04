-- 0027_inventory.sql — Wave 4 Stage 1. The caller's Discogs for-sale inventory, terms-clean (NO price).
-- Mirrors the HARDENED collection_items posture from the start (0006): RLS on, own-SELECT only, DML revoked,
-- service-role-write only (the import writes it). A friend-read policy + forsale_visibility consent arrive in
-- Stage 2 — this migration is own-data only.

create table if not exists public.inventory_items (
  id          bigint generated always as identity primary key,
  user_id     text   not null,
  release_id  bigint not null references public.releases(release_id),
  listing_id  bigint not null,
  status      text   not null default 'for_sale',
  updated_at  timestamptz not null default now(),
  unique (user_id, listing_id)
);
create index if not exists inventory_items_user_idx on public.inventory_items (user_id);

-- updated_at stamped on every write (same trigger fn collection_items/wantlist_items use), so the import's
-- final-page stale sweep (delete … where updated_at < watermark) works identically for inventory.
drop trigger if exists inventory_items_touch on public.inventory_items;
create trigger inventory_items_touch before insert or update on public.inventory_items
  for each row execute function public.touch_updated_at();

alter table public.inventory_items enable row level security;

-- SELECT: own rows only, initplan form (matches every other *_own policy since 0025).
create policy inventory_select_own on public.inventory_items
  for select using (((select auth.jwt()) ->> 'sub') = user_id);

-- Hardened writes: client cannot write; only the service-role import pipeline does (it bypasses RLS).
grant select on public.inventory_items to anon, authenticated;
revoke insert, update, delete on public.inventory_items from anon, authenticated;

-- Per-kind import watermark (like import_started_collection/_wantlist, 0022) so the inventory sweep is
-- steered by the persisted page-1 DB clock, never a client echo.
alter table public.profiles add column if not exists import_started_inventory timestamptz;

-- Purge inventory on disconnect + account deletion (right-to-erasure; ownership data dies with the link).
create or replace function public.unlink_discogs_account(p_user_id text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not exists (select 1 from public.profiles where user_id = p_user_id) then
    return jsonb_build_object('status', 'no_profile');
  end if;
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.wantlist_items        where user_id = p_user_id;   -- Wave 2 Stage A
  delete from public.inventory_items       where user_id = p_user_id;   -- Wave 4 Stage 1
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
$function$;

create or replace function public.delete_account(p_user_id text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_existed boolean;
begin
  v_existed := exists (select 1 from public.profiles where user_id = p_user_id);
  delete from public.friendships           where user_id = p_user_id or friend_id = p_user_id;
  delete from public.friend_invites        where inviter_id = p_user_id;
  update public.friend_invites set accepted_by = null where accepted_by = p_user_id;   -- #40
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.wantlist_items        where user_id = p_user_id;
  delete from public.inventory_items       where user_id = p_user_id;   -- Wave 4 Stage 1
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  delete from public.profiles              where user_id = p_user_id;
  return jsonb_build_object('status','ok','existed', v_existed);
end;
$function$;
