-- 0016_friends_hardening.sql — clears the surviving items from #16 (Wave 1 backend hardening).
-- Items 1, 2 and the expires_at index shipped in 0015. This migration handles:
--   Item 3 — cap active (unused, unexpired) invites per inviter at 25; align create's sweep with
--            0015 (keep USED rows so accept can still answer already_accepted).
--   Item 4 — drop the unnecessary anon reach into schema private / can_view_crate.
-- Item 5 (FK friendships/friend_invites -> profiles) is DEFERRED by decision (2026-08-31, Lane):
--   the auth-adjacent tables use procedural integrity on purpose (delete_account cleans both
--   sides; the no_profile guards block bad inserts), matching the secret-table style. FKs (esp.
--   accepted_by ON DELETE SET NULL + an apply-time orphan check) add surface for marginal benefit
--   at this scale. Revisit if that posture changes.

-- ── Item 3: per-inviter active-invite cap ────────────────────────────────────────
create or replace function public.create_friend_invite(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub    text := auth.jwt()->>'sub';
  v_active int;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  if not exists (select 1 from public.profiles where user_id = v_sub) then
    return jsonb_build_object('status','no_profile');
  end if;
  -- Sweep only UNUSED expired rows (keep used rows so accept can still answer already_accepted).
  delete from public.friend_invites where expires_at < now() and used_at is null;
  -- Cap: at most 25 live (unused, unexpired) invites per inviter.
  select count(*) into v_active
    from public.friend_invites
   where inviter_id = v_sub and used_at is null and expires_at > now();
  if v_active >= 25 then return jsonb_build_object('status','too_many_invites'); end if;
  insert into public.friend_invites (code_hash, inviter_id) values (p_code_hash, v_sub);
  return jsonb_build_object('status','ok');
exception
  when unique_violation then return jsonb_build_object('status','ok');   -- hash collision = client retries
end;
$$;
revoke all on function public.create_friend_invite(text) from public, anon;
grant execute on function public.create_friend_invite(text) to authenticated;

-- ── Item 4: tighten anon out of the private schema ───────────────────────────────
revoke execute on function private.can_view_crate(text, text) from anon;
revoke usage on schema private from anon;
