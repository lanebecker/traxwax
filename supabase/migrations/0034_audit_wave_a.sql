-- 0034_audit_wave_a.sql — cold-audit v1.25, Wave A (data lifecycle): A1 #62, A4 #65, A7 #68.
--
-- A1 (#62): link_discogs_account was never amended when wantlist_items (0017) and
--   inventory_items (0027) were added. A changed-handle re-link deleted only
--   collection_items, so the OLD Discogs account's wantlist + for-sale rows survived,
--   attributed to the new handle and visible to consenting friends (wantlist_select_friends,
--   get_friend_forsale, crate_match, get_social_feed) until the next full import of that
--   kind. 0006's own rule: Restricted rows "must not persist past the re-link at all."
--   The three per-kind import watermarks (0022/0027) are reset for the same reason — a
--   stale watermark must not steer the NEW account's first sweep.
--
-- A4 (#65): profiles_guard (0007) pins the four OAuth-owned columns but not the
--   import_started_* watermarks that 0022 moved server-side PRECISELY to stop client
--   steering of the final-page sweep. authenticated holds table-level UPDATE on profiles
--   (0007), so the watermarks were freely PATCHable via PostgREST — re-opening the exact
--   self-wipe (future watermark → sweep deletes the just-imported rows) and
--   indefinite-retention (past watermark → sweep deletes nothing) attacks 0022 closed.
--   ⚠ create or replace RESETS a function's stored settings (proconfig), so 0025-C's
--   search_path pin is restated INLINE below — omitting it would silently un-pin the guard.
--
-- A7 (#68): used invites were retained forever — an unbounded, permanent "X invited Y at T"
--   ledger — and remove_friend left friend_invites.accepted_by naming the ex-friend,
--   readable by the inviter via friend_invites_select_own long after the friendship ended
--   (delete_account nulls it; un-friending did not). Soft-consume (0015) exists so a
--   re-opened link can answer 'already_accepted'; that answer needs days, not eternity:
--   used rows now die 30 days past expiry, and remove_friend clears accepted_by in both
--   directions. No client code reads accepted_by (verified: zero references in public/).

-- ── A1 (#62): link_discogs_account — full Restricted cleanup on a handle change ──────────
-- Body = 0006's, plus the wantlist/inventory deletes and the watermark resets.

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
    delete from public.wantlist_items   where user_id = p_user_id;   -- A1 #62 (0017 gap)
    delete from public.inventory_items  where user_id = p_user_id;   -- A1 #62 (0027 gap)
    update public.profiles
       set discogs_username          = p_username,
           discogs_connected_at      = now(),
           import_status             = 'idle',
           last_import_at            = null,
           import_started_collection = null,                          -- A1 #62
           import_started_wantlist   = null,                          -- A1 #62
           import_started_inventory  = null                           -- A1 #62
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

-- create or replace preserves ACLs, but restate the posture so it reads true standalone
-- (the B5/#73 lesson: the ritual only protects when it is never skipped).
revoke all on function public.link_discogs_account(text, text, text, text) from public, anon, authenticated;
grant execute on function public.link_discogs_account(text, text, text, text) to service_role;

-- ── A4 (#65): profiles_guard — pin the import watermarks ─────────────────────────────────
-- Body = 0007's, plus the three import_started_* columns. search_path restated per header ⚠.

create or replace function public.profiles_guard() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      -- A user may create only their own bare row; OAuth-owned columns start empty.
      new.discogs_username          := null;
      new.discogs_connected_at      := null;
      new.last_import_at            := null;
      new.import_status             := 'idle';
      new.import_started_collection := null;   -- A4 #65
      new.import_started_wantlist   := null;   -- A4 #65
      new.import_started_inventory  := null;   -- A4 #65
    elsif tg_op = 'UPDATE' then
      -- A user may change display_name (and their own PK); nothing else moves.
      new.discogs_username          := old.discogs_username;
      new.discogs_connected_at      := old.discogs_connected_at;
      new.last_import_at            := old.last_import_at;
      new.import_status             := old.import_status;
      new.import_started_collection := old.import_started_collection;   -- A4 #65
      new.import_started_wantlist   := old.import_started_wantlist;     -- A4 #65
      new.import_started_inventory  := old.import_started_inventory;    -- A4 #65
    end if;
  end if;
  return new;
end $$;

-- Trigger unchanged (0007's profiles_guard_trg still points here); legitimate writers
-- (service_role edge functions, the postgres-owned SECURITY DEFINER RPCs) still skip the
-- current_user gate exactly as before.

-- ── A7 (#68): invite retention + accepted_by lifecycle ───────────────────────────────────
-- Sweep rule, both entry points: unused rows die at expiry (as before); USED rows now die
-- 30 days past expiry — long enough for every realistic 'already_accepted' re-open, no
-- permanent social-graph residue.

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

  -- Housekeeping (A7 #68): unused rows die at expiry; used rows are kept 30 days past
  -- expiry so a re-open can still report 'already_accepted', then die too.
  delete from public.friend_invites
   where expires_at < now()
     and (used_at is null or expires_at < now() - interval '30 days');

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
revoke all on function public.accept_friend_invite(text) from public, anon;
grant execute on function public.accept_friend_invite(text) to authenticated;

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
  -- Sweep (A7 #68): unused rows die at expiry; used rows die 30 days past expiry.
  delete from public.friend_invites
   where expires_at < now()
     and (used_at is null or expires_at < now() - interval '30 days');
  -- Cap: at most 25 live (unused, unexpired) invites per inviter.
  select count(*) into v_active
    from public.friend_invites
   where inviter_id = v_sub and used_at is null and expires_at > now();
  if v_active >= 25 then return jsonb_build_object('status','too_many_invites'); end if;
  insert into public.friend_invites (code_hash, inviter_id) values (p_code_hash, v_sub);
  return jsonb_build_object('status','ok');
exception
  when unique_violation then return jsonb_build_object('status','ok');   -- hash collision = client retries
                                                                         -- (return value is wrong — D8c #97, fixed in Wave D, NOT here)
end;
$$;
revoke all on function public.create_friend_invite(text) from public, anon;
grant execute on function public.create_friend_invite(text) to authenticated;

create or replace function public.remove_friend(p_friend_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub text := auth.jwt()->>'sub';
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  delete from public.friendships
   where (user_id = v_sub and friend_id = p_friend_id)
      or (user_id = p_friend_id and friend_id = v_sub);
  -- A7 (#68): un-friending also de-identifies the invite that created the link, in both
  -- directions (either party may have been the inviter). Same de-identification
  -- delete_account already performs (#40); idempotent, safe when no invite exists.
  update public.friend_invites set accepted_by = null
   where (inviter_id = v_sub       and accepted_by = p_friend_id)
      or (inviter_id = p_friend_id and accepted_by = v_sub);
  return jsonb_build_object('status','ok');
end;
$$;
revoke all on function public.remove_friend(text) from public, anon;
grant execute on function public.remove_friend(text) to authenticated;

-- ── Apply-time verification (run via break-glass execute_sql after apply) ────────────────
-- 1. Guard still pinned + new pins present:
--    select proconfig from pg_proc where proname = 'profiles_guard';         -- {search_path=public}
--    select prosrc like '%import_started_collection%' from pg_proc where proname = 'profiles_guard';
-- 2. link fn covers all three item tables:
--    select prosrc like '%wantlist_items%' and prosrc like '%inventory_items%'
--      from pg_proc where proname = 'link_discogs_account';
-- 3. ACLs unchanged (service_role-only link; authenticated invite RPCs):
--    select proname, proacl from pg_proc
--     where proname in ('link_discogs_account','accept_friend_invite','create_friend_invite','remove_friend');
-- 4. Sweep semantics: insert a used row expired 40 days -> create_friend_invite as any user deletes it;
--    a used row expired 5 days survives (already_accepted still answerable).
