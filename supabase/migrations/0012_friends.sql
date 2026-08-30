-- 0012_friends.sql — Wave 1: friendships, single-use invites, crate visibility, friend-read.
-- Depends on 0011 (profiles display fields). All functions are SECURITY DEFINER with a pinned
-- search_path; the browser-callable ones derive identity from auth.jwt()->>'sub' INTERNALLY.

-- ── crate_visibility on profiles ────────────────────────────────────────────────
-- Written extensibly (rev1-F6): Wave 5 adds 'public' by amending this CHECK, not rebuilding.
alter table public.profiles
  add column if not exists crate_visibility text not null default 'private';
alter table public.profiles
  drop constraint if exists profiles_crate_visibility_chk;
alter table public.profiles
  add constraint profiles_crate_visibility_chk
  check (crate_visibility in ('private','friends'));   -- Wave 5: add 'public' here

-- The 0007 profiles_guard trigger forces only OAuth-owned columns; crate_visibility is
-- user-writable via the existing profiles_update_own policy + table UPDATE grant (0007).

-- ── friendships (symmetric, stored as two rows) ─────────────────────────────────
-- Two rows per friendship (a->b and b->a) so RLS/lookup predicates stay a single-index probe.
create table if not exists public.friendships (
  user_id    text not null,             -- the viewer side (auth.jwt()->>'sub')
  friend_id  text not null,             -- the other party
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
alter table public.friendships enable row level security;
-- Own-side SELECT only: you can read rows where YOU are the viewer side. Used by the friend
-- list. (Reading the FRIEND's profile/crate goes through can_view_crate, not this policy.)
create policy friendships_select_own on public.friendships
  for select using (auth.jwt()->>'sub' = user_id);
-- No INSERT/UPDATE/DELETE policies for anon/authenticated: friendships are created/removed ONLY
-- through the SECURITY DEFINER RPCs below. (Same posture as the secret tables: RLS on, writes
-- locked to definer/service paths.)
create index if not exists friendships_friend_idx on public.friendships (friend_id);

-- ── friend_invites (single-use codes; only the hash is stored) ──────────────────
create table if not exists public.friend_invites (
  code_hash  text primary key,          -- sha256hex of the plaintext code (never store plaintext)
  inviter_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days')
);
alter table public.friend_invites enable row level security;
-- The inviter may list + delete (revoke) their own unused invites; accept happens via the RPC.
create policy friend_invites_select_own on public.friend_invites
  for select using (auth.jwt()->>'sub' = inviter_id);
create policy friend_invites_delete_own on public.friend_invites
  for delete using (auth.jwt()->>'sub' = inviter_id);
create index if not exists friend_invites_inviter_idx on public.friend_invites (inviter_id);

-- ── can_view_crate: the single choke point ──────────────────────────────────────
-- STABLE so the planner can evaluate it once per (viewer,owner) when user_id is constant in the
-- scan (friend-crate reads filter `where user_id = <owner>`). SECURITY DEFINER so it can read
-- friendships + profiles regardless of the caller's own RLS.
create or replace function public.can_view_crate(p_viewer text, p_owner text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_viewer = p_owner
    or exists (
      select 1
        from public.profiles pr
        join public.friendships f
          on f.user_id = p_viewer and f.friend_id = p_owner
       where pr.user_id = p_owner
         and pr.crate_visibility = 'friends'
    );
$$;

-- ── collection_items: friend-readable SELECT (the highest-risk change) ───────────
-- Permissive policy ORed with the existing collection_select_own. can_view_crate already returns
-- true for viewer==owner, so this alone would suffice; own is kept for clarity + a fast path.
create policy collection_select_friends on public.collection_items
  for select using (public.can_view_crate(auth.jwt()->>'sub', user_id));

-- ── create_friend_invite (browser-callable) ─────────────────────────────────────
create or replace function public.create_friend_invite(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub text := auth.jwt()->>'sub';
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  if not exists (select 1 from public.profiles where user_id = v_sub) then
    return jsonb_build_object('status','no_profile');
  end if;
  delete from public.friend_invites where expires_at < now();           -- sweep
  insert into public.friend_invites (code_hash, inviter_id) values (p_code_hash, v_sub);
  return jsonb_build_object('status','ok');
exception
  when unique_violation then return jsonb_build_object('status','ok');   -- hash collision = retry client-side; treat as benign
end;
$$;

-- ── accept_friend_invite (browser-callable, atomic consume + mutual insert) ──────
-- Mirrors finalize_discogs_link: sweep expired, atomic DELETE ... RETURNING keyed on the hash,
-- identity checks return a status (never raise), mutual rows inserted idempotently.
create or replace function public.accept_friend_invite(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub text := auth.jwt()->>'sub';
  v_inviter text;
  v_uname text;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  delete from public.friend_invites where expires_at < now();

  delete from public.friend_invites
   where code_hash = p_code_hash
  returning inviter_id into v_inviter;
  if not found then return jsonb_build_object('status','invalid_or_expired'); end if;

  if v_inviter = v_sub then return jsonb_build_object('status','own_invite'); end if;

  -- Mutual friendship, idempotent (a re-accept must not error).
  insert into public.friendships (user_id, friend_id) values (v_sub, v_inviter)
    on conflict do nothing;
  insert into public.friendships (user_id, friend_id) values (v_inviter, v_sub)
    on conflict do nothing;

  select discogs_username into v_uname from public.profiles where user_id = v_inviter;
  return jsonb_build_object('status','ok', 'friend_username', coalesce(v_uname,''));
end;
$$;

-- ── remove_friend (browser-callable, deletes BOTH directions = instant revocation) ──
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
  return jsonb_build_object('status','ok');
end;
$$;

-- ── list_friends (browser-callable, returns the display projection for each friend) ──
create or replace function public.list_friends()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', pr.user_id,
           'discogs_username', pr.discogs_username,
           'display_name', pr.display_name,
           'avatar_url', pr.avatar_url,
           'crate_visibility', pr.crate_visibility
         ) order by lower(coalesce(pr.display_name, pr.discogs_username, pr.user_id))), '[]'::jsonb)
    from public.friendships f
    join public.profiles pr on pr.user_id = f.friend_id
   where f.user_id = auth.jwt()->>'sub';
$$;

-- ── get_crate_owner (browser-callable, display projection IF authorized, else no_crate) ──
-- Privacy: 'no_crate' is returned identically for "no such username" and "exists but not shared
-- with you" — the caller can never distinguish the two.
create or replace function public.get_crate_owner(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub text := auth.jwt()->>'sub';
  v record;
begin
  if v_sub is null then return jsonb_build_object('status','no_auth'); end if;
  select user_id, discogs_username, display_name, avatar_url, bio, location,
         collecting_since, link1, link2
    into v
    from public.profiles
   where lower(discogs_username) = lower(p_username);
  if not found then return jsonb_build_object('status','no_crate'); end if;
  if not public.can_view_crate(v_sub, v.user_id) then
    return jsonb_build_object('status','no_crate');
  end if;
  return jsonb_build_object('status','ok', 'owner', jsonb_build_object(
    'user_id', v.user_id, 'discogs_username', v.discogs_username,
    'display_name', v.display_name, 'avatar_url', v.avatar_url, 'bio', v.bio,
    'location', v.location, 'collecting_since', v.collecting_since,
    'link1', v.link1, 'link2', v.link2));
end;
$$;

-- ── delete_account: amend to remove friendship + invite rows on BOTH sides (rev1-F11) ──
-- Full redefinition (adds two deletes; order before profiles delete).
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
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  delete from public.profiles              where user_id = p_user_id;
  return jsonb_build_object('status','ok','existed', v_existed);
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────────
-- Browser-callable RPCs: authenticated only (they self-identify via auth.jwt()). Revoke the
-- default PUBLIC/anon EXECUTE first, for parity with the rest of the migration's hardening.
revoke all on function public.create_friend_invite(text) from public, anon;
revoke all on function public.accept_friend_invite(text) from public, anon;
revoke all on function public.remove_friend(text)        from public, anon;
revoke all on function public.list_friends()             from public, anon;
revoke all on function public.get_crate_owner(text)      from public, anon;
grant execute on function public.create_friend_invite(text) to authenticated;
grant execute on function public.accept_friend_invite(text) to authenticated;
grant execute on function public.remove_friend(text)        to authenticated;
grant execute on function public.list_friends()             to authenticated;
grant execute on function public.get_crate_owner(text)      to authenticated;
-- can_view_crate is referenced inside the collection_items RLS policy, whose predicate is
-- executed by the QUERYING role — so `authenticated` needs EXECUTE or the policy errors. Safe to
-- expose: it is a self-contained boolean (SECURITY DEFINER) that leaks nothing. service_role
-- also needs it for live-stats' admin.rpc('can_view_crate', ...).
revoke all on function public.can_view_crate(text, text) from public, anon;
grant execute on function public.can_view_crate(text, text) to authenticated, service_role;
-- delete_account stays service_role-only (called by the delete-account Edge Function).
revoke all on function public.delete_account(text) from public, anon, authenticated;
grant execute on function public.delete_account(text) to service_role;
