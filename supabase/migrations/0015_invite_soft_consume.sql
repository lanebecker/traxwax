-- 0015_invite_soft_consume.sql — v1.4.2.
-- An invite that was already accepted, then re-opened by the same person, previously reported
-- "invalid or has expired" (the code had been hard-deleted on accept, so we couldn't tell "you
-- already used this" from "never existed"). Switch friend_invites to SOFT consume: mark used_at +
-- accepted_by and KEEP the row, so a re-open by the acceptor returns 'already_accepted'. Also folds
-- in Wave 1 hardening from #16: a no_profile guard on accept, the own_invite check BEFORE consuming
-- (so testing your own link no longer burns it), and an index on expires_at.

alter table public.friend_invites add column if not exists used_at     timestamptz;
alter table public.friend_invites add column if not exists accepted_by text;
create index if not exists friend_invites_expires_idx on public.friend_invites (expires_at);

create or replace function public.accept_friend_invite(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub text := auth.jwt()->>'sub';
  v_inviter    text;
  v_used_at    timestamptz;
  v_accepted   text;
  v_expires    timestamptz;
  v_uname      text;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  if not exists (select 1 from public.profiles where user_id = v_sub) then
    return jsonb_build_object('status','no_profile');
  end if;

  -- Housekeeping: drop expired invites that were never accepted. USED rows are kept so a re-open
  -- can still report 'already_accepted'.
  delete from public.friend_invites where expires_at < now() and used_at is null;

  select inviter_id, used_at, accepted_by, expires_at
    into v_inviter, v_used_at, v_accepted, v_expires
    from public.friend_invites where code_hash = p_code_hash;
  if not found then return jsonb_build_object('status','invalid_or_expired'); end if;

  -- Already consumed: if THIS user accepted it, tell them they're already connected; otherwise
  -- it's spent (don't reveal who used it).
  if v_used_at is not null then
    if v_accepted = v_sub then
      select discogs_username into v_uname from public.profiles where user_id = v_inviter;
      return jsonb_build_object('status','already_accepted','friend_username',coalesce(v_uname,''));
    end if;
    return jsonb_build_object('status','invalid_or_expired');
  end if;

  if v_expires < now() then return jsonb_build_object('status','invalid_or_expired'); end if;
  -- Own invite: return BEFORE consuming, so an inviter testing their own link doesn't burn it.
  if v_inviter = v_sub then return jsonb_build_object('status','own_invite'); end if;

  -- Atomic consume: only the first concurrent caller flips used_at.
  update public.friend_invites set used_at = now(), accepted_by = v_sub
    where code_hash = p_code_hash and used_at is null;
  if not found then
    -- Lost a race (a concurrent accept just consumed it). Re-read to answer correctly.
    select accepted_by into v_accepted from public.friend_invites where code_hash = p_code_hash;
    if v_accepted = v_sub then
      select discogs_username into v_uname from public.profiles where user_id = v_inviter;
      return jsonb_build_object('status','already_accepted','friend_username',coalesce(v_uname,''));
    end if;
    return jsonb_build_object('status','invalid_or_expired');
  end if;

  -- Mutual friendship, idempotent.
  insert into public.friendships (user_id, friend_id) values (v_sub, v_inviter) on conflict do nothing;
  insert into public.friendships (user_id, friend_id) values (v_inviter, v_sub) on conflict do nothing;
  select discogs_username into v_uname from public.profiles where user_id = v_inviter;
  return jsonb_build_object('status','ok','friend_username',coalesce(v_uname,''));
end;
$$;
