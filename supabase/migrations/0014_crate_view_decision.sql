-- 0014_crate_view_decision.sql — Wave 1 follow-up (audit of #12).
-- live-stats decided price suppression / friend-view authorization INLINE, which (a) duplicated
-- private.can_view_crate, (b) resolved the owner username with `.ilike(owner)` — treating a
-- client string as a LIKE pattern, so usernames containing `_`/`%` matched the wrong rows and
-- 403'd legitimately-authorized friends, and (c) would diverge from the DB when Wave 5 adds
-- 'public'. Replace all of that with ONE service_role-only function that resolves the owner
-- LITERALLY (lower()=lower(), matching get_crate_owner) and reuses private.can_view_crate.
--
-- Returns: 'own' (viewer is the owner) | 'allowed' (consented friend) | 'denied' (exists, not
-- allowed) | 'no_owner' (no such username). live-stats maps: own -> show price; allowed ->
-- suppress price; denied/no_owner -> 403.
--
-- service_role ONLY — NOT granted to authenticated/anon, so it is never a probeable RPC (unlike
-- 0012's mistake with can_view_crate). Only the live-stats Edge Function (service role) calls it.

create or replace function public.crate_view_decision(p_viewer text, p_owner_username text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner text;
begin
  select user_id into v_owner
    from public.profiles
   where lower(discogs_username) = lower(p_owner_username);
  if not found then return 'no_owner'; end if;
  if v_owner = p_viewer then return 'own'; end if;
  if private.can_view_crate(p_viewer, v_owner) then return 'allowed'; end if;
  return 'denied';
end;
$$;

revoke all on function public.crate_view_decision(text, text) from public, anon, authenticated;
grant execute on function public.crate_view_decision(text, text) to service_role;
