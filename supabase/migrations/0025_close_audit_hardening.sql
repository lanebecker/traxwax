-- 0025_close_audit_hardening.sql — end-of-phase cold-audit remediation (2026-09-03).
-- All four items are backend-only, additive-safe, and verified against the live grant/policy state.
--
-- (A) wantlist_items lockdown. 0017 created `wantlist_write_own FOR ALL` + left the anon/authenticated DML
--     grants, mirroring the PRE-hardening collection_items posture. But wantlist_items has the SAME posture as
--     collection_items (0006 AUDIT #2): its ONLY legitimate writers are the service-role wantlist-write /
--     import-collection functions — "Discogs is the source of truth, write there first, mirror on success."
--     A direct client write let a user desync their mirror and inflate the "they want / you have" count friends
--     see. Match the 0006 collection lockdown. Service_role bypasses RLS + keeps its grants, so the functions
--     are unaffected; SELECT (own + friends) is retained.
-- (B) Revoke inert DML grants that today rely SOLELY on RLS-policy absence to deny (defense-in-depth): a future
--     broad policy would otherwise silently open them. Only revoke a command that has NO client policy —
--     friend_invites KEEPS delete (friend_invites_delete_own) + select; profiles KEEPS insert/update/select.
-- (C) Pin profiles_guard's search_path (the one function missing the pin every other has; advisor 0011). It
--     references only NEW/OLD/current_user — no schema-qualified objects — so `= public` is safe + conventional.
-- (D) auth_rls_initplan perf (advisor): wrap auth.jwt() in a scalar subselect so Postgres evaluates it ONCE per
--     query instead of once per row — measurable on a ~1,861-row own-crate scan. ALTER POLICY (not drop/recreate)
--     preserves each policy's role + command; only the USING/WITH CHECK expression changes.

-- (A) wantlist_items — drop the client write policy + revoke DML
drop policy if exists wantlist_write_own on public.wantlist_items;
revoke insert, update, delete on public.wantlist_items from anon, authenticated;

-- (B) revoke inert DML grants (keep every command that has a client policy)
revoke insert, update, delete on public.friendships    from anon, authenticated;  -- writes go through remove_friend / accept_friend_invite (SECURITY DEFINER); keep select
revoke insert, update          on public.friend_invites  from anon, authenticated;  -- KEEP delete (friend_invites_delete_own) + select
revoke delete                  on public.profiles        from anon, authenticated;  -- KEEP insert/update/select (own upsert + profile edit)

-- (C) pin the guard's search_path
alter function public.profiles_guard() set search_path = public;

-- (D) initplan perf — wrap ONLY auth.jwt() in the subselect, then ->> 'sub'. This is the canonical form
--     Supabase's auth_rls_initplan linter recognizes ( (select auth.jwt()) ->> 'sub' ), not the whole-expr
--     wrap; both are InitPlan-evaluated-once, but only this clears the advisor.
alter policy collection_select_own     on public.collection_items using (((select auth.jwt()) ->> 'sub') = user_id);
alter policy friend_invites_delete_own on public.friend_invites   using (((select auth.jwt()) ->> 'sub') = inviter_id);
alter policy friend_invites_select_own on public.friend_invites   using (((select auth.jwt()) ->> 'sub') = inviter_id);
alter policy friendships_select_own    on public.friendships      using (((select auth.jwt()) ->> 'sub') = user_id);
alter policy profiles_insert_own       on public.profiles         with check (((select auth.jwt()) ->> 'sub') = user_id);
alter policy profiles_select_own       on public.profiles         using (((select auth.jwt()) ->> 'sub') = user_id);
alter policy profiles_update_own       on public.profiles         using (((select auth.jwt()) ->> 'sub') = user_id) with check (((select auth.jwt()) ->> 'sub') = user_id);
alter policy wantlist_select_own       on public.wantlist_items   using (((select auth.jwt()) ->> 'sub') = user_id);
alter policy wantlist_select_friends   on public.wantlist_items   using (private.can_view_wantlist((select auth.jwt()) ->> 'sub', user_id));
