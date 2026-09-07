-- 0035_audit_wave_b.sql — cold-audit v1.25, Wave B (abuse & auth): B3 #71, B4 #72, B5 #73.
--
-- B3 (#71): the connect cooldown was check-then-act — N parallel requests all passed the
--   <10s SELECT before any placeholder INSERT committed, so one user with Promise.all could
--   drain the site-wide request_token budget every 10s. The fix is structural: at most ONE
--   discogs_oauth_state row per user (partial-free unique index below), and connect-discogs
--   arms via UPDATE-with-time-predicate → INSERT → conflict=429 (deployed with this
--   migration). Under READ COMMITTED the second concurrent UPDATE re-evaluates its predicate
--   after the first's row lock releases, sees created_at=now, matches zero rows, falls to
--   INSERT, hits 23505, and 429s — the race is now impossible by construction.
--   The touch-don't-delete arm also preserves the pass-2 property (an in-flight real
--   handshake from another tab keeps its token/secret; only created_at moves).
--
-- B4 (#72): invite links executed accept_friend_invite on page OPEN — a GET-driven consent
--   grant. The client now shows a confirmation card first; this read-only preview RPC tells
--   the code-holder who is asking, revealing nothing a subsequent accept would not
--   (status vocabulary identical to accept_friend_invite; no state change, no sweep).
--
-- B5 (#73): private-schema ACL normalization. can_view_forsale (0028) shipped with default
--   PUBLIC EXECUTE (the one gate that skipped the revoke ritual); _feed_overlap* (0033) were
--   granted to authenticated though nothing role-level calls them (a ready-made any-two-users
--   overlap oracle if `private` is ever exposed); can_view_crate kept an authenticated+anon
--   grant made dead when 0021 dropped the table-wide crate policy. Minimum grants below.
--   can_view_wantlist KEEPS authenticated: wantlist_select_friends (RLS) executes it as the
--   querying role — that is the one genuine role-level caller (goes away with D2/#91).

-- ── B3 (#71): one state row per user ─────────────────────────────────────────────────────
-- Dedupe first (keep the newest row per user; ties broken by ctid). These are throwaway
-- 15-minute handshake rows. One edge (audit F5): a user holding an in-flight REAL
-- handshake plus a newer cooldown placeholder loses the real row — their pending
-- authorize dead-ends at 'unknown_or_used' and they reconnect. Tiny window, self-healing.
-- ⚠ DEPLOY ORDER (audit F1): apply THIS MIGRATION FIRST, then deploy connect-discogs.
-- The new function's only refusal path is the 23505 conflict this index creates —
-- function-first would leave connect entirely unthrottled until the index lands.
delete from public.discogs_oauth_state a
 using public.discogs_oauth_state b
 where a.user_id = b.user_id
   and (a.created_at, a.ctid) < (b.created_at, b.ctid);

drop index if exists discogs_oauth_state_user_uidx;
create unique index discogs_oauth_state_user_uidx
  on public.discogs_oauth_state (user_id);

-- ── B4 (#72): read-only invite preview ───────────────────────────────────────────────────
create or replace function public.get_invite_preview(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub      text := auth.jwt()->>'sub';
  v_inviter  text;
  v_used_at  timestamptz;
  v_accepted text;
  v_expires  timestamptz;
  v_uname    text;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  if not exists (select 1 from public.profiles where user_id = v_sub) then
    return jsonb_build_object('status','no_profile');
  end if;

  select inviter_id, used_at, accepted_by, expires_at
    into v_inviter, v_used_at, v_accepted, v_expires
    from public.friend_invites where code_hash = p_code_hash;
  if not found then return jsonb_build_object('status','invalid_or_expired'); end if;

  -- Same disclosure rules as accept_friend_invite: a spent code reveals nothing unless
  -- YOU were the acceptor; an expired code reveals nothing; your own code says so.
  if v_used_at is not null then
    if v_accepted = v_sub then
      select discogs_username into v_uname from public.profiles where user_id = v_inviter;
      return jsonb_build_object('status','already_accepted','friend_username',coalesce(v_uname,''));
    end if;
    return jsonb_build_object('status','invalid_or_expired');
  end if;
  if v_expires < now() then return jsonb_build_object('status','invalid_or_expired'); end if;
  if v_inviter = v_sub then return jsonb_build_object('status','own_invite'); end if;

  select discogs_username into v_uname from public.profiles where user_id = v_inviter;
  return jsonb_build_object('status','ok','inviter_username',coalesce(v_uname,''));
end;
$$;
revoke all on function public.get_invite_preview(text) from public, anon;
grant execute on function public.get_invite_preview(text) to authenticated;

-- ── B5 (#73): private.* minimum grants ───────────────────────────────────────────────────
-- can_view_crate: no RLS policy evaluates it since 0021; definer callers (crate_view_decision,
-- get_friend_crate, get_social_feed, can_view_forsale) run as the owner and need no grant.
revoke all on function private.can_view_crate(text, text) from public, anon, authenticated;
grant execute on function private.can_view_crate(text, text) to service_role;

-- can_view_wantlist: wantlist_select_friends (RLS, 0018→0025) executes it AS the querying
-- role — authenticated stays until D2 (#91) replaces the policy with a projection RPC.
revoke all on function private.can_view_wantlist(text, text) from public, anon;
grant execute on function private.can_view_wantlist(text, text) to authenticated, service_role;

-- can_view_forsale: the 0028 omission — default PUBLIC EXECUTE stood until now. No role-level
-- caller exists; definer callers need no grant.
revoke all on function private.can_view_forsale(text, text) from public, anon, authenticated;
grant execute on function private.can_view_forsale(text, text) to service_role;

-- _feed_overlap*: SECURITY DEFINER, trust their caller-supplied user ids, consent-gated only
-- by get_social_feed's CASE arms — nothing role-level may execute them, ever.
revoke all on function private._feed_overlap(text, text, text, text) from public, anon, authenticated;
grant execute on function private._feed_overlap(text, text, text, text) to service_role;
revoke all on function private._feed_overlap_unlisted(text, text) from public, anon, authenticated;
grant execute on function private._feed_overlap_unlisted(text, text) to service_role;

-- ── Apply-time verification ──────────────────────────────────────────────────────────────
-- 1. select indexdef from pg_indexes where indexname='discogs_oauth_state_user_uidx';
-- 2. select count(*) = count(distinct user_id) from public.discogs_oauth_state;  -- true
-- 3. select proname, proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--     where n.nspname='private';   -- only can_view_wantlist lists authenticated
-- 4. select proname, proacl::text from pg_proc where proname='get_invite_preview';
-- 5. Concurrency: two parallel inserts for one user_id — second must raise 23505.
