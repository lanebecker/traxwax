-- 0020_wave3_backend_integrity.sql — cold-audit Wave 3 (backend integrity: #40 + #41).
-- #40: delete_account deleted the user's OWN invites (inviter_id) but left friend_invites.accepted_by =
--      the deleted user's Clerk sub on invites they ACCEPTED (owned by another inviter) — a right-to-
--      erasure residue. Null accepted_by on those rows; keep used_at so the single-use invite stays
--      consumed (can't be re-accepted), just de-identified.
-- #41: 0016 revoked anon's USAGE on schema `private` + EXECUTE on can_view_crate. But the friend-read RLS
--      policies (collection_select_friends 0013, wantlist_select_friends 0018) call private.can_view_*,
--      evaluated by the QUERYING role. anon holds Supabase-baseline table SELECT, so an anon SELECT now
--      errors ("permission denied for schema private") instead of returning empty — fail-closed today (the
--      app reads only as authenticated) but a landmine for the Wave-5 'public' crate direction, which needs
--      anon reads. Scope the two friend policies TO authenticated so anon never reaches the private.* call;
--      anon then evaluates only the owner-only policy (sub = user_id → false → 0 rows, no error). No change
--      for authenticated (they already matched these policies).

-- ── #40: de-identify consumed invites on account deletion ─────────────────────────────────────────
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
  update public.friend_invites set accepted_by = null where accepted_by = p_user_id;   -- #40
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.wantlist_items        where user_id = p_user_id;
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  delete from public.profiles              where user_id = p_user_id;
  return jsonb_build_object('status','ok','existed', v_existed);
end;
$$;
revoke all on function public.delete_account(text) from public, anon, authenticated;
grant execute on function public.delete_account(text) to service_role;

-- ── #41: scope the friend-read policies TO authenticated (anon never reaches private.*) ───────────
drop policy if exists collection_select_friends on public.collection_items;
create policy collection_select_friends on public.collection_items
  for select to authenticated using (private.can_view_crate(auth.jwt()->>'sub', user_id));

drop policy if exists wantlist_select_friends on public.wantlist_items;
create policy wantlist_select_friends on public.wantlist_items
  for select to authenticated using (private.can_view_wantlist(auth.jwt()->>'sub', user_id));
