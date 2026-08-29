-- 0006_audit_hardening.sql — Phase 1 cold-audit pre-merge batch (issue #1)
--
-- AUDIT #1: profiles_update_own was column-unrestricted, so any signed-in user could set
-- discogs_username to any handle -- squatting that permanently blocks the real owner from
-- connecting (unique index -> handle_taken). RLS scopes ROWS; column control is GRANTs.
-- The client legitimately writes only user_id (the ensureProfile upsert, whose ON CONFLICT
-- DO UPDATE needs UPDATE(user_id)) and, someday, display_name. Everything OAuth-owned
-- becomes service-role-only.

revoke insert, update on table public.profiles from anon, authenticated;
grant insert (user_id) on public.profiles to authenticated;
grant update (user_id, display_name) on public.profiles to authenticated;

-- AUDIT #2 + #27: collection_items has no legitimate client writer (the import pipeline is
-- service_role), so the write policy and write grants go; and instance_id was nullable
-- under unique(user_id, instance_id), where NULLs are distinct and the constraint doesn't
-- bind. Live data has zero NULLs and the import hard-errors on missing ids -- encode it.

drop policy if exists collection_write_own on public.collection_items;
revoke insert, update, delete on table public.collection_items from anon, authenticated;
alter table public.collection_items alter column instance_id set not null;

-- AUDIT #29: pin search_path on the two Stage C helpers (live advisor WARN). Bodies use
-- only pg_catalog builtins, so the empty path is safe.

alter function public.db_now() set search_path = '';
alter function public.touch_updated_at() set search_path = '';

-- AUDIT #8 (amended by the report-verification round): re-linking a DIFFERENT Discogs
-- account previously rendered the old account's collection under the new name, because
-- last_import_at survived the re-link. And the old account's ownership rows are Restricted
-- data tied to that account -- they must not persist past the re-link at all. On a username
-- change: delete the items and null the gate, one transaction. Same-account re-link (token
-- refresh) keeps everything.

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
declare
  v_old text;
begin
  select discogs_username into v_old
    from public.profiles where user_id = p_user_id;
  if not found then
    raise exception 'no profile for user_id %', p_user_id
      using errcode = 'P0002';   -- no_data_found
  end if;

  if v_old is distinct from p_username then
    delete from public.collection_items where user_id = p_user_id;
    update public.profiles
       set discogs_username     = p_username,
           discogs_connected_at = now(),
           import_status        = 'idle',
           last_import_at       = null
     where user_id = p_user_id;
  else
    update public.profiles
       set discogs_username     = p_username,
           discogs_connected_at = now(),
           import_status        = 'idle'
     where user_id = p_user_id;
  end if;

  insert into public.discogs_credentials (user_id, oauth_token, oauth_token_secret)
       values (p_user_id, p_token_enc, p_secret_enc)
  on conflict (user_id) do update
          set oauth_token        = excluded.oauth_token,
              oauth_token_secret = excluded.oauth_token_secret;
end;
$$;
