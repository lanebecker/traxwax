-- 0004_stage_c_import.sql — Phase 1 Stage C
--
-- Re-import cleanup needs to distinguish rows touched by the CURRENT import from rows a
-- previous import wrote for records since deleted on Discogs. The watermark comparison must
-- use ONE clock: a trigger stamps every insert/update with the database's now(), and the
-- import mints its started_at from the same clock via db_now(). Edge-instance clocks are
-- deliberately not trusted -- different pages of one import can run on different instances.

alter table public.collection_items
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists collection_items_touch on public.collection_items;
create trigger collection_items_touch
  before insert or update on public.collection_items
  for each row execute function public.touch_updated_at();

-- The import's watermark source. service_role only, same posture as link_discogs_account.
create or replace function public.db_now() returns timestamptz
language sql stable as $$ select now() $$;

revoke all on function public.db_now() from public, anon, authenticated;
grant execute on function public.db_now() to service_role;

-- Round-2 audit MAJOR-2: import_status='error' (stored credentials unreadable) previously
-- had NO exit -- reconnecting via the OAuth flow wrote new credentials but left the error
-- flag, so the boot path dead-ended forever. A successful re-link is exactly the event
-- that invalidates the error state, so the link RPC now clears it. Same body as migration
-- 0003 otherwise; create-or-replace keeps grants (execute stays service_role-only).
create or replace function public.link_discogs_account(
  p_user_id      text,
  p_username     text,
  p_token_enc    text,
  p_secret_enc   text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set discogs_username     = p_username,
         discogs_connected_at = now(),
         import_status        = 'idle'
   where user_id = p_user_id;

  if not found then
    raise exception 'no profile for user_id %', p_user_id
      using errcode = 'P0002';   -- no_data_found
  end if;

  insert into public.discogs_credentials (user_id, oauth_token, oauth_token_secret)
       values (p_user_id, p_token_enc, p_secret_enc)
  on conflict (user_id) do update
          set oauth_token        = excluded.oauth_token,
              oauth_token_secret = excluded.oauth_token_secret;
end;
$$;
