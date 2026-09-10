-- 0041_finalize_link_authz.sql — Cold audit v1.31, #131 (T2.9).
--
-- finalize_discogs_link consumed the pending row (DELETE … RETURNING) BEFORE checking ownership,
-- then returned 'link_not_yours' on a mismatch — but the row was already gone. So any caller who
-- presented someone else's one-time finalize code DESTROYED that victim's in-flight pending link
-- (the victim's own finalize then hit 'no_pending' and they had to re-run the whole OAuth handshake).
-- Reproduced RED→GREEN on a local Postgres 16 before shipping.
--
-- Fix: authorize INSIDE the delete predicate. finalize_code_hash is UNIQUE, so adding
-- `and user_id = p_sub` keeps the ≤1-row regime (no new race — the rev1-F2 code_hash predicate
-- stays) while turning a non-owner into a no-op miss: nothing is deleted, and the response is
-- 'no_pending' — indistinguishable from an unknown/expired code, so it never even confirms the
-- code existed. The old 'link_not_yours' status is therefore unreachable and removed; its now-dead
-- handler in supabase/functions/finalize-connect/index.ts (403) and the boot.ui.js COPY entry are
-- harmless dead code, cleaned up whenever finalize-connect is next redeployed (no redeploy needed
-- for THIS change — the RPC body lives in the DB).
--
-- Replay-safe: CREATE OR REPLACE, search_path pinned, no schema change.

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

  -- ATOMIC consume keyed on the (UNIQUE) code hash AND the caller. Authorizing here means a caller
  -- who does not own this pending row matches nothing → no_pending, and the owner's row is never
  -- destroyed by someone else presenting the code. The unique constraint keeps this ≤1 row, so a
  -- multi-row RETURNING INTO cannot arise.
  delete from public.discogs_pending_links
   where finalize_code_hash = p_code_hash
     and user_id = p_sub
  returning * into v;
  if not found then
    -- Covers "no such / expired code" AND "the code isn't yours" — never distinguish them.
    return jsonb_build_object('status', 'no_pending');
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

-- B5/#73 discipline: restate the SECURITY DEFINER posture so this migration is correct standalone
-- (CREATE OR REPLACE preserves the existing ACL, but if the function were ever created solely by
-- this file it would default to PUBLIC EXECUTE — unacceptable for a definer fn taking an arbitrary
-- p_sub). service_role only; the finalize-connect edge fn calls it with the service key.
revoke all on function public.finalize_discogs_link(text, text) from public, anon, authenticated;
grant execute on function public.finalize_discogs_link(text, text) to service_role;
