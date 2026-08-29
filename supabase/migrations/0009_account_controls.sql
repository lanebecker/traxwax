-- 0009_account_controls.sql — Phase 2: disconnect, account deletion, authenticated
-- finalize (GitHub #8; closes the Stage B link-CSRF acceptance).
-- Plan: docs/phase-2-account-plan.md (rev 2, twice audited).

-- ── Pending links: the callback parks a completed OAuth result here; only a browser
--    holding the one-time code AND signed in as the flow starter can finalize it.
--    RLS on, ZERO policies: service_role only, like discogs_credentials.
create table if not exists public.discogs_pending_links (
  user_id                 text primary key,
  discogs_username        text not null,
  oauth_token_enc         text not null,
  oauth_token_secret_enc  text not null,
  finalize_code_hash      text not null unique,
  created_at              timestamptz not null default now(),
  expires_at              timestamptz not null default (now() + interval '15 minutes')
);
alter table public.discogs_pending_links enable row level security;

-- ── Finalize. Lookup BY CODE HASH (possession), then sub equality (identity) — see the
--    plan's CSRF section for why lookup-by-sub is the broken design. Returns status
--    jsonb, never raises: an uncaught raise would roll back the consume-delete.
create or replace function public.finalize_discogs_link(p_sub text, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.discogs_pending_links%rowtype;
begin
  delete from public.discogs_pending_links where expires_at < now();

  -- ATOMIC consume, keyed on the code hash (audit rev1-F2: a select-then-delete lets two
  -- concurrent finalize calls both pass the existence check — the exact race the
  -- callback's own state-consume comment warns about — and deleting by user_id could
  -- destroy a NEWER pending row while finalizing a stale one). The sweep above makes an
  -- expired row a lookup miss, so expired uniformly reports no_pending.
  -- (The UNIQUE constraint on finalize_code_hash keeps this in the ≤1-row regime;
  -- a multi-row RETURNING INTO would raise, uncaught — a safe, unreachable failure.)
  delete from public.discogs_pending_links
   where finalize_code_hash = p_code_hash
  returning * into v;
  if not found then
    return jsonb_build_object('status', 'no_pending');
  end if;

  if v.user_id is distinct from p_sub then
    return jsonb_build_object('status', 'link_not_yours');
  end if;

  begin
    perform public.link_discogs_account(
      v.user_id, v.discogs_username, v.oauth_token_enc, v.oauth_token_secret_enc);
  exception
    when unique_violation then return jsonb_build_object('status', 'handle_taken');
    when no_data_found    then return jsonb_build_object('status', 'no_profile');
  end;

  return jsonb_build_object('status', 'ok', 'username', v.discogs_username);
end;
$$;

-- ── Disconnect: credential + imported items + any in-flight handshake/pending link go;
--    the profile survives, reset to the never-connected shape (0006's re-link rule,
--    generalized: ownership rows are Restricted Data tied to the connection).
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

-- ── Account deletion: everything TraxWax stores, profile row included. The Clerk user
--    is deliberately untouched (shared identity across future apps — Lane 2026-08-29).
--    The shared releases catalog is CC0 and unaffected.
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
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  delete from public.profiles              where user_id = p_user_id;
  return jsonb_build_object('status', 'ok', 'existed', v_existed);
end;
$$;

revoke execute on function public.finalize_discogs_link(text, text)
  from public, anon, authenticated;
revoke execute on function public.unlink_discogs_account(text)
  from public, anon, authenticated;
revoke execute on function public.delete_account(text)
  from public, anon, authenticated;
grant execute on function public.finalize_discogs_link(text, text) to service_role;
grant execute on function public.unlink_discogs_account(text)      to service_role;
grant execute on function public.delete_account(text)              to service_role;
