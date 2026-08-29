-- 0007_profiles_guard_trigger.sql — launch-day hotfix
--
-- 0006 closed the username-squatting hole (#1) with COLUMN-level grants: authenticated got
-- INSERT(user_id) + UPDATE(user_id, display_name) and no table-level INSERT/UPDATE. That
-- passed a raw-SQL test but broke the live app: PostgREST's upsert path checks the INSERT
-- privilege at the TABLE level, so ensureProfile's `.upsert({user_id})` got
-- "permission denied for table profiles" for every brand-new user. (It never surfaced on
-- the dev/preview instance because Lane's profile row already existed; production Clerk
-- issues fresh subs, so the first real INSERT is the first production sign-in.)
--
-- Fix: restore table-level INSERT/UPDATE so PostgREST is satisfied, and enforce the
-- anti-squatting invariant with a BEFORE INSERT OR UPDATE trigger instead. The trigger is
-- SECURITY INVOKER (default) so current_user reflects the REAL caller: 'authenticated' for a
-- direct PostgREST write, but 'service_role' (edge functions) or 'postgres' (the SECURITY
-- DEFINER link_discogs_account RPC) for the legitimate writers -- those are skipped. A direct
-- user write can therefore only ever touch user_id and display_name; the OAuth-owned columns
-- are forced to their safe values on insert and pinned to their prior values on update.

grant insert, update on table public.profiles to authenticated;

create or replace function public.profiles_guard() returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      -- A user may create only their own bare row; OAuth-owned columns start empty.
      new.discogs_username     := null;
      new.discogs_connected_at := null;
      new.last_import_at       := null;
      new.import_status        := 'idle';
    elsif tg_op = 'UPDATE' then
      -- A user may change display_name (and their own PK); nothing else moves.
      new.discogs_username     := old.discogs_username;
      new.discogs_connected_at := old.discogs_connected_at;
      new.last_import_at       := old.last_import_at;
      new.import_status        := old.import_status;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_trg on public.profiles;
create trigger profiles_guard_trg
  before insert or update on public.profiles
  for each row execute function public.profiles_guard();
