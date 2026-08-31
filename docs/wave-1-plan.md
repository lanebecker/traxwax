# Wave 1 — Friends & Consented Crates → v1.4.0 (implementation plan)

**Status:** REV 2 — TWICE-AUDITED, CONVERGED. Pass 1 (verification-pass): REVISE — 1 CRITICAL +
6 MAJOR + 8 MINOR, all folded. Pass 2 (narrow, over the rework): CONVERGED — no CRITICAL/MAJOR,
one MINOR line-citation drift, folded. Cleared to execute (DB-first, break-glass; per-change
remediation-audits still apply at build time). Audit record at the bottom.
**Target release:** v1.4.0. **Depends on:** v1.3.4 (current head), migration **0011** (latest).
**Written:** 2026-08-30, from a full current-state recon of the repo.

Read this alongside `docs/social-roadmap.md` §4 (the wave's intent) and
`Discogs-API-Terms-Summary.md` (the consent model this rests on). This plan is written for a
no-context engineer: exact files, complete code, exact commands. Where it **diverges** from the
roadmap it says so and why.

---

## 0. Scope, constraints, and order of operations

**In scope (roadmap §4):** the consent wall, the friendship graph, and the first time anyone sees
anyone else's crate. Friends-only — no public crates, no discovery (those are Wave 5).

**Ships when:** Lane and Tommy can invite each other, see each other's crates, and revoke — and
prices never appear on anyone else's crate.

**Hard rules that do not bend (from `Discogs-API-Terms-Summary.md`):**
- **Prices never appear on anyone else's crate.** The friend-crate UI renders no number
  (`priceCellHtml`), and `live-stats` suppresses the price field for a friend-view request (§2) —
  defense in depth. Release price/stats are GLOBAL data, so this field-suppression is best-effort UX,
  NOT a hard boundary; the enforced boundary is the `collection_items` friend-read RLS (which releases
  a user owns). See §2's audit note.
- **Sharing is opt-in, default private, per-dataset, instantly revocable.** `crate_visibility`
  defaults to `'private'`. This wave adds the **crate** dataset only.
- **Restricted stats reach a viewer only under the VIEWER's own token** (the established
  `live-stats` pattern, unchanged).
- **Not-found and not-friends render identically** — never confirm a username exists to a stranger.

**DB-FIRST ROLLOUT ORDER (do not reorder):**
1. Task 1 — apply migration `0012` (requires **arming the TraxWax Break-Glass connector**; the
   standing connector is read-only since W0.1). Verify live (Task 8 SQL matrix) BEFORE any
   frontend or Edge push.
2. Task 2 — deploy the `live-stats` change (also break-glass / `deploy_edge_function`). Verify
   forged-token + price-suppression probes (Task 8) BEFORE the frontend push.
3. Tasks 3–6 — frontend (`boot.js`, `boot.ui.js`, `app.js`, `_redirects`), pushed together on
   `main` (Cloudflare auto-deploys). The frontend degrades safely if run against the old DB, but
   do not push it before Tasks 1–2 are verified live.
4. Task 7 — release paperwork (VERSION/CHANGELOG/roadmap) in the SAME commit as the frontend.
5. Task 8 — full verification battery. Task 9 — commit/handoff.

**Break-glass reminder:** migrations and Edge deploys need the writable connector. Ask Lane to
arm `Supabase — TraxWax — Break-Glass`, do Tasks 1–2, then ask him to disconnect it. Everything
else (frontend) is git-only.

---

## Naming contract (used across every task — keep consistent)

- Tables: `public.friendships`, `public.friend_invites`. Column on `public.profiles`:
  `crate_visibility text not null default 'private'`.
- Functions (all `security definer`, `set search_path = public`):
  `public.can_view_crate(p_viewer text, p_owner text) returns boolean` (STABLE);
  `public.create_friend_invite(p_code_hash text) returns jsonb`;
  `public.accept_friend_invite(p_code_hash text) returns jsonb`;
  `public.remove_friend(p_friend_id text) returns jsonb`;
  `public.list_friends() returns jsonb`;
  `public.get_crate_owner(p_username text) returns jsonb`.
- The four browser-callable RPCs (`create_friend_invite`, `accept_friend_invite`, `remove_friend`,
  `list_friends`, `get_crate_owner`) derive the caller identity from **`auth.jwt()->>'sub'`
  INSIDE the function** — never from a parameter. `can_view_crate` takes explicit args because it
  is used inside an RLS policy where the row's `user_id` is the owner.
- Invite code: a URL-safe random string generated **client-side**; only its SHA-256 hex hash is
  stored (mirrors the finalize-code pattern in `_shared/discogs.ts` `sha256hex`). The plaintext
  lives only in the `/i/<code>` link the inviter shares.
- Invite link shape: `https://traxwax.com/i/<code>` (top-level route, §6).
- Frontend globals: `window.TraxWaxViewer = { isOwn, ownerUserId, ownerProfile }` (installed by
  boot.js before importing app.js; see Task 3/5).

---

## The architectural decision the auditor must scrutinize (RLS vs projection RPC)

The recon found **no existing policy that scopes a row to a *related* user**, and two hard blockers:
`profiles` has own-row-only SELECT; `collection_items` has owner-only SELECT.

- **`collection_items` → friend-readable RLS SELECT policy.** Every column of `collection_items`
  (release_id, folder, rating, added, vinyl, instance_id) is shareable crate data, so a row-level
  policy exposes nothing that shouldn't be shared. The policy calls `can_view_crate(viewer, owner)`.
- **`profiles` → NOT a friend-readable RLS policy; a `SECURITY DEFINER` projection RPC instead.**
  RLS is row-level, not column-level: a friend-readable row policy on `profiles` would also expose
  `import_status`, `last_import_at`, `discogs_connected_at`, `created_at` — not display data. So
  `profiles` keeps own-row-only SELECT, and friends read the **display projection** through
  `get_crate_owner` / `list_friends`, which return only
  `{user_id, discogs_username, display_name, avatar_url, bio, location, collecting_since, link1, link2}`.
  **This is a deliberate divergence from roadmap §4's phrase "friend-readable SELECT policies on …
  the profile DISPLAY fields"** — RLS cannot restrict to fields, and the projection RPC is the
  correct, tighter mechanism. Flagged here so the audit judges it on purpose, not by accident.

`can_view_crate` is the single choke point for "may V see O's crate": `V = O`, **or** `O.crate_visibility = 'friends'` AND a friendship row `(V → O)` exists. It is used in (a) the `collection_items` RLS policy, (b) `get_crate_owner`, (c) `live-stats` price-suppression auth. One definition, three call sites — a leak or a laxness lives in exactly one place.

---

## Task 1 — Migration `0012_friends.sql` (schema, functions, RLS, deletion amendment)

**File:** `supabase/migrations/0012_friends.sql` (new). **Apply via break-glass**
(`apply_migration`, name `friends`). Complete contents:

```sql
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
```

**⚠ APPLIED + AMENDED BY 0013 (2026-08-30).** 0012 applied clean and its state matrix passed, but
the security advisor flagged that `public.can_view_crate` — taking arbitrary `(viewer, owner)` —
was callable at `/rest/v1/rpc/can_view_crate` by any signed-in user, letting them probe the
friendship graph. **Migration `0013_friends_private_fn.sql` moves the function to a `private`
schema** (not PostgREST-exposed), repoints the `collection_items` policy + `get_crate_owner` to
`private.can_view_crate`, and drops the public version. The RLS policy still works (verified: the
querying role needs EXECUTE, which is granted in `private`; a friend read returns the row under the
real `authenticated` role). `live-stats` (Task 2) authorizes **inline** rather than via the RPC,
since `private.*` isn't reachable through PostgREST. The five browser RPCs stay public+authenticated
by design (each self-identifies via `auth.jwt()` and acts only as the caller — the advisor's WARN on
them is expected and accepted).

**Why browser-callable RPCs here (not Edge Functions like finalize):** invites carry no secrets
(no token decryption), so they don't need the service-role Edge wrapper. They are `SECURITY
DEFINER` and self-identify via `auth.jwt()->>'sub'`, so a client cannot act as another user. This
is a **new pattern** for this repo (existing DEFINER RPCs are service_role-only) — the audit
should confirm each RPC (a) reads identity only from `auth.jwt()`, never a param, and (b) returns
statuses rather than raising in a way that could leak existence.

**Apply + immediate verification (break-glass connector):**
```
apply_migration(name="friends", query=<the file above>)
```
Then run, and confirm the exact output:
```sql
select column_name, column_default from information_schema.columns
 where table_name='profiles' and column_name='crate_visibility';
-- expect: crate_visibility | 'private'::text

select policyname from pg_policies where tablename='collection_items' order by 1;
-- expect: collection_select_friends, collection_select_own

select proname from pg_proc where proname in
 ('can_view_crate','create_friend_invite','accept_friend_invite','remove_friend',
  'list_friends','get_crate_owner') order by 1;
-- expect all six
```

---

## Task 2 — `live-stats`: server-side price suppression on a friend's crate

**File:** `supabase/functions/live-stats/index.ts`. Deploy via break-glass
(`deploy_edge_function`). The recon pinned the shape: `kind:'release'` returns `price` from
Discogs `lowest_price` unconditionally, cache key `release:${releaseId}` is **global**.

**Change:** the `release` request gains an optional `owner` (a Discogs username of the crate being
viewed). The server decides suppression — the client cannot assert "this is mine."

**⚠ ORDER IS THE WHOLE POINT (verification-pass rev1-C1).** The function does
`cacheKey = kind==='value' ? \`value:${userId}\` : \`release:${releaseId}\`` (line 109), then
`const cached = cacheGet(cacheKey); if (cached) return json(cached);` (**lines 110–111**). The
cache key is **global** and warmed by any owner's own view, so it holds a **priced** payload.
Therefore the authorization + suppression MUST run **before** line 110, and the cached return at
111 MUST be suppressed too — otherwise a friend hits the early return and gets the real price, and
a merely-connected non-friend gets cached Restricted stats. Placing this "after cacheGet" (the
rev-1 mistake) is unreachable on a cache hit.

**2a. Widen the body type + parse `owner`.** The declaration is
`let body: { kind?: unknown; id?: unknown };` (line 89). Change it to add `owner`:
```ts
let body: { kind?: unknown; id?: unknown; owner?: unknown };
```
and, where `{kind,id}` are read, also read:
```ts
const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
```

**2b. Authorization + suppression decision — place BEFORE `cacheKey`/`cacheGet` (before line 109),
for the `kind:'release'` case only.** Delegate the whole decision to ONE `service_role`-only DB
function, `crate_view_decision` (migration **0014**), which resolves the owner username LITERALLY
(`lower()=lower()`, matching `get_crate_owner`) and reuses `private.can_view_crate`. This replaced
an earlier inline version that used `.ilike(owner)` — a LIKE-pattern match on client input that
mis-matched usernames containing `_`/`%` (audit of #12, finding A). `crate_view_decision` is
`service_role`-only (revoked from `authenticated`/`anon`), so it is never a probeable RPC.
```ts
let suppressPrice = false;
if (kind === 'release' && owner) {
  const { data: decision, error: decErr } = await admin.rpc('crate_view_decision',
    { p_viewer: userId, p_owner_username: owner });
  if (decErr || decision == null) return json({ error: 'unexpected' }, 500);   // fail closed
  if (decision === 'allowed') suppressPrice = true;                            // consented friend
  else if (decision !== 'own') return json({ error: 'forbidden' }, 403);       // 'denied' | 'no_owner'
}
```
`admin` is the existing service-role client (recon `index.ts:101-104`). **Honest scoping (audit of
#12, finding B):** because release `price`/community stats are GLOBAL per-release data (any
connected user can already fetch them for their own crate), this suppression is **best-effort UX**
for the friend-view context, not a confidentiality boundary. The real boundary — *which release IDs
sit in whose crate* — is the `collection_items` RLS via `private.can_view_crate` (0013), which is
intact. A client that omits `owner` gets the global price (as it does for its own crate); the
friend-crate UI never renders a number regardless (`priceCellHtml`, Task 5).

**2c. Suppress on EVERY return — the cached one and both fresh ones.** Change the cache early
return (line 111) and wrap the two `release`-branch `return json(out)` sites:
```ts
// line 110–111, replace:
const cached = cacheGet(cacheKey);
if (cached) return json(suppressPrice ? { ...cached, price: null } : cached);
...
// each release-branch `return json(out)` (the 404 out and the success out) becomes:
return json(suppressPrice ? { ...out, price: null } : out);
```
The cache stays keyed `release:${releaseId}` (global, priced); suppression is applied to the copy
returned to a friend, so the cache is never poisoned and a friend never receives a price. The 403
above it means a non-friend never reaches the cache at all.

**Client contract:** own-crate modal calls send no `owner` (unchanged, priced). Friend-crate modal
calls send `owner: <friend username>` (Task 5). Omitting `owner` on a friend crate would NOT leak
price only because the friend provider always sends it (Task 3d) — but defense-in-depth: the
client also renders `priceCellHtml(rec,false)` (Task 5), which never prints a number regardless of
what the server returns. **Suppression does not depend on the client cooperating for the authz
gate** (the 403 is server-only); it depends on the client sending `owner` only for the price-field
nicety, which the dead-simple `priceCellHtml` backstops.

**Deploy + verify (Task 8b has the cache-hit probe explicitly).**

---

## Task 3 — `boot.js`: invite route, invite-accept, friend-crate resolution + providers

**File:** `public/boot.js`.

**3a. The `/i/<code>` route.** In `render()` (recon: route parse at `boot.js:525-526`, the
`/account` branch at `boot.js:541-545`), add a sibling branch **immediately after** the account
branch. It must be reachable while signed in; a signed-out visitor is bounced to sign-in by the
existing guard (`boot.js:528-531`) and the code is preserved in the URL so it still works after
sign-in (the URL is unchanged by the sign-in card). Complete branch:
```js
if (segments[0] && segments[0].toLowerCase() === 'i' && segments[1]) {
  await acceptInvite(decodeURIComponent(segments[1]));   // renders its own result card, then routes on
  return;
}
```

**3b. `acceptInvite(code)`** — new function. Hashes the code client-side (SubtleCrypto), calls the
RPC, shows a result card, then sends the user to their crate. Place near `renderAccount`:
```js
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function acceptInvite(code) {
  let res;
  try {
    const { data, error } = await supabase.rpc('accept_friend_invite',
      { p_code_hash: await sha256hex(code) });
    if (error) throw error;
    res = data;
  } catch (e) { res = { status: 'error', message: (e && e.message) || String(e) }; }
  const home = '/app';
  if (res.status === 'ok') {
    const who = res.friend_username ? ('@' + res.friend_username) : 'your friend';
    notice('You’re connected', 'You and ' + who + ' can now see each other’s crates.',
      false, { kicker: 'FRIENDS', actions: UI.btnLink('GO TO YOUR CRATE', home, { variant: 'primary' }) });
  } else {
    const msg = {
      invalid_or_expired: 'That invite link is invalid or has expired. Ask your friend for a fresh one.',
      own_invite: 'That’s your own invite link — share it with a friend instead.',
      no_auth: 'Please sign in first, then open the link again.',
    }[res.status] || 'Something went wrong accepting that invite.';
    notice('Invite couldn’t be used', msg, true,
      { kicker: 'FRIENDS', actions: UI.btnLink('GO TO YOUR CRATE', home, { variant: 'secondary' }) });
  }
}
```
(`notice(...)` and `UI.btnLink` are the existing helpers used by the account/S10 renders — recon
confirms `notice` is boot.js's state-card renderer.)

**3c. Friend-crate resolution.** In the non-owner branch (recon `boot.js:713-725`, the S10
return), insert a friend-authorization check BEFORE the S10 `notice(...noCrate...)`:
```js
if (routeUsername.toLowerCase() !== profile.discogs_username.toLowerCase()) {
  // Wave 1: is this a friend's shared crate? get_crate_owner returns 'no_crate' for BOTH
  // "no such user" and "not shared with you" — so this branch never reveals existence.
  let owner = null;
  try {
    const { data } = await supabase.rpc('get_crate_owner', { p_username: routeUsername });
    if (data && data.status === 'ok') owner = data.owner;
  } catch (e) { owner = null; }
  if (owner) {
    installFriendCrateProviders(owner);       // §3d
    await import('/app.js');
    await window.TraxWaxBootCrate();
    return;
  }
  // else: fall through to the existing S10 render (unchanged) ↓
  notice(UI.COPY.noCrate.headline, UI.COPY.noCrate.body, true, {
    kicker: UI.COPY.noCrate.kicker, rule: 'muted',
    actions: UI.btnLink(UI.COPY.noCrate.cta, '/app', { variant: 'secondary' }),
  });
  return;
}
```

**3d. `installFriendCrateProviders(owner)`** — new, parallels `installCrateProviders(profile)`
(recon `boot.js:178-258`). **There is NO reusable `mapRow` or `releaseDataProvider` (rev1-M2):
`installCrateProviders` maps rows INLINE and paginates (its own comment: PostgREST caps a select
at 1,000 rows and users own ~1,861). This function reproduces that inline mapping + pagination
verbatim**, changing only: `.eq('user_id', owner.user_id)`, the `owner` arg on the stats call, and
the omission of Refresh/Account. The `select(...)` string is the REAL one
(`release_id, added, rating, vinyl, releases(...)` — no `folder`/`instance_id`, rev1-M3). It
defines its own `fnCall` (the own-crate one is local to `installCrateProviders`, returns null on
`!ok` — rev1-M11).
```js
function installFriendCrateProviders(owner) {
  const fnCall = async (path, payload) => {
    const token = await window.Clerk.session.getToken();
    const r = await fetch(SUPABASE_URL + '/functions/v1/' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return null;
    return r.json().catch(() => null);
  };
  window.TraxWaxViewer = { isOwn: false, ownerUserId: owner.user_id, ownerProfile: owner };
  window.TraxWaxOwner = {
    ownerLine: (owner.display_name || owner.discogs_username) + '’s shelf',
    lastSyncedAt: null,
    displayName: owner.display_name || '',
    avatarUrl: owner.avatar_url || '',
    isOwn: false,
    ownerUsername: owner.discogs_username,
  };
  // Friend-readable via the collection_select_friends RLS policy. Paginated + inline-mapped
  // EXACTLY like installCrateProviders (only .eq('user_id', owner.user_id) differs).
  window.TraxWaxData = async () => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('collection_items')
        .select('release_id, added, rating, vinyl, ' +
          'releases ( artist, title, year, label, styles, genres, thumb, cover_image )')
        .eq('user_id', owner.user_id)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error('friend collection query failed: ' + error.message);
      for (const it of data ?? []) {
        const rel = it.releases || {};
        rows.push({
          id: it.release_id,
          artist: rel.artist || '', title: rel.title || '', year: rel.year || 0,
          label: rel.label || '', styles: rel.styles || [], genres: rel.genres || [],
          vinyl: it.vinyl || '', thumb: rel.thumb || '', cover_image: rel.cover_image || '',
          added: it.added || '', rating: it.rating || 0,
          price: null, crating: null, crcount: null, have: null, want: null,
        });
      }
      if (!data || data.length < 1000) break;
    }
    return rows;
  };
  // CC0 catalog (public-read RLS) — identical to installCrateProviders' inline arrow.
  window.TraxWaxReleaseData = async (id) => {
    const { data, error } = await supabase
      .from('releases').select('tracks, country, released, videos')
      .eq('release_id', id).maybeSingle();
    if (error || !data || data.tracks == null) return null;
    return { tracks: data.tracks || [], country: data.country || '',
      released: data.released || '', videos: data.videos || [] };
  };
  // Per-release stats under the VIEWER's own token; price suppressed server-side via `owner`.
  window.TraxWaxStats = async (id) =>
    id == null ? {} : fnCall('live-stats', { kind: 'release', id, owner: owner.discogs_username });
  // Deliberately NO window.TraxWaxRefresh / window.TraxWaxAccount — read-only friend crate.
}
```

**3e. Own-crate path sets the viewer flag too.** Where `installCrateProviders(profile)` runs for
the owner (recon `boot.js:768-771`), set `window.TraxWaxViewer = { isOwn: true, ownerUserId: null,
ownerProfile: null }` (full shape, rev1-M13) and add `isOwn: true,` to the object returned by
`ownerInfo` (recon `boot.js:259-269`) so app.js has one flag to branch on.

**3f-pre. Make `crate_visibility` readable (rev1-C/M4).** `ensureProfile`'s `.select(...)` (recon
`boot.js:164-165`) does NOT currently include `crate_visibility`, so `profile.crate_visibility`
is always `undefined` and the SHARING toggle would be stuck OFF. Add the column to that select:
```js
// in ensureProfile: append crate_visibility to the .select(...) column list
.select('user_id, discogs_username, import_status, last_import_at, ' +
  'display_name, avatar_url, bio, location, collecting_since, link1, link2, crate_visibility')
```
This makes `profile.crate_visibility` available to `renderAccount` → `accountPageHtml` (which
already receives `profile`), so `sharingSection` reads `o.profile.crate_visibility` (Task 4c) — no
`onGetVisibility` dep is needed (removed, rev1-M4).

**3f. Account deps for SHARING/FRIENDS.** In the `renderAccount` deps object (recon: deps
documented at `boot.ui.js:242-251`, built in `boot.js` near the onSaveProfile/onUploadPhoto
block), add:
```js
onSetVisibility: async (v) => {
  const { error } = await supabase.from('profiles')
    .update({ crate_visibility: v }).eq('user_id', window.Clerk.user.id);
  if (error) throw new Error(error.message);
},
onListFriends: async () => {
  const { data, error } = await supabase.rpc('list_friends');
  if (error) throw new Error(error.message);
  return data || [];
},
onCreateInvite: async () => {
  // random URL-safe code; store only its hash; return the shareable link.
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const { data, error } = await supabase.rpc('create_friend_invite', { p_code_hash: await sha256hex(code) });
  if (error) throw new Error(error.message);
  if (data.status !== 'ok') throw new Error(data.status);
  return location.origin + '/i/' + code;
},
onRemoveFriend: async (friendId) => {
  const { error } = await supabase.rpc('remove_friend', { p_friend_id: friendId });
  if (error) throw new Error(error.message);
},
```

---

## Task 4 — `boot.ui.js`: activate SHARING + FRIENDS sections

**File:** `public/boot.ui.js`.

**4a. NAV.** Turn the two dormant rows live (recon `boot.ui.js:252-258`): remove `soon: true` from
the `sharing` and `friends` entries.
```js
const NAV = [
  { id: 'profile', label: 'PROFILE' },
  { id: 'sharing', label: 'SHARING' },
  { id: 'friends', label: 'FRIENDS' },
  { id: 'discogs', label: 'DISCOGS' },
  { id: 'danger', label: 'DANGER ZONE', danger: true, target: 'discogs' },
];
```

**4b. Route the two sections (fix ALL THREE normalization sites — rev1-M9).** `accountPageHtml`
(recon `boot.ui.js:416-441`) normalizes at **line 417** `const section = o.section === 'discogs' ?
'discogs' : 'profile';`, passes that `section` to **`accountNav(section, o)` (line 440)** (the
left-nav active highlight), and branches the body at **line 441**. Rewrite line 417 so all four
sections survive, and use that `section` in BOTH the nav call and the body branch:
```js
// line 417 — was: const section = o.section === 'discogs' ? 'discogs' : 'profile';
const section = ['discogs', 'sharing', 'friends'].includes(o.section) ? o.section : 'profile';
// line 441 body branch — use `section`, not o.section, so nav highlight and body agree:
(section === 'discogs' ? discogsSection(o)
  : section === 'sharing' ? sharingSection(o)
  : section === 'friends' ? friendsSection(o)
  : profileSection(o))
```
And in `boot.js`'s `renderAccount` sub parse (recon: the `/account` branch at `boot.js:541-545`
currently maps only `discogs`, else `profile`), pass any of `profile|sharing|friends|discogs`
through, e.g.:
```js
const valid = ['profile', 'sharing', 'friends', 'discogs'];
const sub = valid.includes((segments[1] || '').toLowerCase()) ? segments[1].toLowerCase() : 'profile';
await renderAccount(profile, sub);
```
`hrefFor` (recon `boot.js:456`, `(id)=> id==='profile'?'/account':'/account/'+id`) already produces
`/account/sharing` and `/account/friends` for the NAV rows — no change needed there.

**4c. `sharingSection(o)`** — new. This function lives IN `boot.ui.js`, so it calls the section
helpers by their BARE exported names (`toggle`, `sectionHead`, `emptyState`, `avatar`) — **NOT
`UI.toggle` etc.; `UI` is the import alias that exists only in `boot.js` (rev1-M8).** Reads the
saved value from `o.profile.crate_visibility` (available now that `ensureProfile` selects it —
Task 3f-pre; the `accountPageHtml` options object carries `profile`, rev1-M4). `toggle` signature
is `{id, on, label}` (recon `boot.ui.js:88-99`):
```js
function sharingSection(o) {
  const vis = (o.profile && o.profile.crate_visibility) || 'private';
  return '' +
  '<div style="padding:28px 30px 34px; display:flex; flex-direction:column; gap:26px">' +
    sectionHead('SHARING', 'Who can see your crate',
      'Your crate is private by default. Turn this on to let friends you’ve added browse it. ' +
      'Prices never appear on anyone else’s crate. You can turn this off any time.') +
    '<div id="tw-share-msg" role="status" aria-live="polite" style="' + MONO + '; font-size:11.5px; color:var(--accent); min-height:0"></div>' +
    '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; ' +
      'border:1.5px solid var(--hair); padding:16px">' +
      '<div style="display:flex; flex-direction:column; gap:3px">' +
        '<span style="' + COND + '; font-size:18px; font-weight:700; color:var(--ink)">Friends can see my crate</span>' +
        '<span style="' + MONO + '; font-size:10px; color:var(--faint)">Only people you’ve added as friends</span>' +
      '</div>' +
      toggle({ id: 'tw-vis-toggle', on: vis === 'friends', label: 'Friends can see my crate' }) +
    '</div>' +
  '</div>';
}
```

**4d. `friendsSection(o)`** — new. Invite button + friend list; empty state via `emptyState`
(bare; recon `boot.ui.js:186-208`):
```js
function friendsSection(o) {
  return '' +
  '<div style="padding:28px 30px 34px; display:flex; flex-direction:column; gap:22px">' +
    sectionHead('FRIENDS', 'People who can see your crate', '') +
    '<div id="tw-friends-msg" role="status" aria-live="polite" style="' + MONO + '; font-size:11.5px; color:var(--accent); min-height:0"></div>' +
    '<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">' +
      '<button id="tw-invite-btn" style="' + btnStyle('primary') + '">CREATE AN INVITE LINK</button>' +
      '<input id="tw-invite-link" readonly style="' + MONO + '; font-size:11px; padding:8px 10px; ' +
        'flex:1; min-width:220px; border:1.5px solid var(--line); background:var(--panel); ' +
        'color:var(--ink); display:none">' +
    '</div>' +
    '<div id="tw-friends-list"></div>' +
  '</div>';
}
```

**4e. `bindAccountPage` wiring.** In `bindAccountPage` (recon `boot.ui.js:448+`), add blocks that
run when their elements exist (the function is called for every section; guard on `$('id')`).

**The toggle repaint uses re-render, not a class (rev1-M5): `toggle()` sets NO class — its on/off
state is baked into inline styles at render time. So on success we replace the node with a freshly
rendered `toggle()` (correct styling by construction) and re-attach the listener.** Factor the
wiring into a named function so it can re-bind the new node:
```js
function wireVisToggle(root, deps) {
  const vt = root.querySelector('#tw-vis-toggle');
  if (!vt) return;
  vt.addEventListener('click', async () => {
    const now = vt.getAttribute('aria-checked') === 'true';
    const next = now ? 'private' : 'friends';
    const smsg = (t) => { const el = root.querySelector('#tw-share-msg'); if (el) el.textContent = t || ''; };
    try {
      await deps.onSetVisibility(next);
      // re-render from the SAME renderer so the knob position/colors are always correct
      const holder = document.createElement('div');
      holder.innerHTML = toggle({ id: 'tw-vis-toggle', on: next === 'friends', label: 'Friends can see my crate' });
      vt.replaceWith(holder.firstElementChild);
      wireVisToggle(root, deps);   // the replacement node has no listener yet
      smsg(next === 'friends' ? 'Friends can now see your crate.' : 'Your crate is private again.');
    } catch (e) { smsg('Couldn’t change that: ' + ((e && e.message) || e)); }
  });
}
// ...call once from bindAccountPage:
wireVisToggle(root, deps);

// FRIENDS
const inviteBtn = root.querySelector('#tw-invite-btn');
if (inviteBtn) {
  const fmsg = (t) => { const el = $('tw-friends-msg'); if (el) el.textContent = t || ''; };
  inviteBtn.addEventListener('click', async () => {
    fmsg('Creating a link…');
    try {
      const link = await deps.onCreateInvite();
      const box = $('tw-invite-link');
      if (box) { box.style.display = ''; box.value = link; box.focus(); box.select(); }
      fmsg('Copy this link and send it to your friend. It works once and expires in 14 days.');
    } catch (e) { fmsg('Couldn’t create a link: ' + ((e && e.message) || e)); }
  });
  renderFriendsList(root, deps);   // §4f
}
```

**4f. `renderFriendsList(root, deps)`** — new helper; uses `emptyState` for the empty case and
`avatar` for rows (bare names):
```js
async function renderFriendsList(root, deps) {
  const host = root.querySelector('#tw-friends-list');
  if (!host) return;
  let friends = [];
  try { friends = await deps.onListFriends(); } catch (e) { host.innerHTML = ''; return; }
  if (!friends.length) {
    host.innerHTML = emptyState({
      kicker: 'NO FRIENDS YET',
      headline: 'Invite someone to compare crates',
      body: 'Create an invite link above and send it to a friend. Once they accept, you’ll each be able to browse the other’s shelf.',
    });
    return;
  }
  host.innerHTML = friends.map((f) =>
    '<div style="display:flex; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid var(--hair)">' +
      avatar(f.avatar_url, 40) +
      '<div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:2px">' +
        '<span style="' + COND + '; font-size:16px; font-weight:700; color:var(--ink)">' +
          esc(f.display_name || f.discogs_username || 'Friend') + '</span>' +
        '<a href="/app/' + encodeURIComponent(f.discogs_username || '') + '" style="' + MONO +
          '; font-size:10px; color:var(--accent); text-decoration:none">VIEW CRATE →</a>' +
      '</div>' +
      '<button data-remove-friend="' + esc(f.user_id) + '" style="' + btnStyle('secondary') +
        '; font-size:10px">REMOVE</button>' +
    '</div>').join('');
  host.querySelectorAll('[data-remove-friend]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await deps.onRemoveFriend(btn.getAttribute('data-remove-friend')); await renderFriendsList(root, deps); }
      catch (e) { btn.disabled = false; }
    });
  });
}
```
**Bare names only (rev1-M8):** these functions are added INSIDE `boot.ui.js`, so they call
`toggle`, `emptyState`, `avatar`, `sectionHead`, `btnStyle`, `esc`, `MONO`, `COND` by their bare
exported names — never `UI.*` (that alias exists only in `boot.js`). All exist per recon; use them
verbatim. The toggle repaint is handled by re-rendering (4e), not by any class.

---

## Task 5 — `app.js`: read-only friend-crate rendering + price cell

**File:** `public/app.js`. Recon: `SETTINGS.ownerLine` (line 16, overridden in `bootCrate` from
`window.TraxWaxOwner`), the header/account-button block (`app.js:483-506`), `DB_MODE()` gating,
and the dormant `priceCellHtml(rec,isOwn)` (`app.js:324-341`, never called).

**5a. A viewer flag.** Add near the top-of-file state:
```js
const IS_OWN = () => !window.TraxWaxViewer || window.TraxWaxViewer.isOwn !== false;
```

**5b. Suppress owner-only affordances on a friend crate.**
- **Account avatar button** (recon `app.js:498-503`, guarded on `DB_MODE()` only): change the
  guard to `${DB_MODE() && IS_OWN() ? ( … avatar button … ) : ''}` so a friend crate has no
  account button.
- **RE-SYNC button** (recon `app.js:495`, guarded on `DB_MODE()` only — NOT on `TraxWaxRefresh`):
  change its guard to `${DB_MODE() && window.TraxWaxRefresh ? ( … ) : ''}`. The friend provider
  omits `TraxWaxRefresh`, so RE-SYNC disappears on a friend crate.
- **EST. value cell** (recon `app.js:492`, `${esc(s.headerValue || valueLabel(v.total))} EST.`):
  on a friend crate the friend stats provider returns `{}` for the whole-collection call, so
  `valueLabel(v.total)` would render **`$0 EST.`** (rev1-M15). Render the whole `<span>` only when
  `IS_OWN()`: wrap it `${IS_OWN() ? '<span …>' + esc(s.headerValue || valueLabel(v.total)) + ' EST.</span>' : ''}`.
  (Roadmap §9.2: "EST. VALUE must not be load-bearing … it simply drops out.")
- The owner line already comes from `window.TraxWaxOwner.ownerLine` (friend's shelf) — no change.

**5c. Price cell — friend crate only; DO NOT touch the own crate (rev1-M6/M10).** In DB mode the
own crate shows NO price cell (`SETTINGS.showPrices` is false; per-record price is Restricted,
modal-only), and adding one would be an unrequested design change to Lane's own crate (L5). So:
- **Card** (recon `app.js:259`, `${showP?\`<span …>${r.priceLabel}</span>\`:''}`): render the
  existing own-crate cell when `IS_OWN()`, and the SEE-ON-DISCOGS cell only on a friend crate:
  ```js
  ${IS_OWN() ? (showP ? `<span style="…">${r.priceLabel}</span>` : '') : priceCellHtml(r, false)}
  ```
- **Modal "LOWEST SALE" cell** (recon: `priceLabel` defined `app.js:590`, rendered in the accent
  cell at `app.js:635`, inside the modal container at 608-611) rendering
  `${priceLabel}` where `priceLabel = st.price!=null ? money(st.price) : '—'`: keep `priceLabel`
  for the owner; on a friend crate show the link instead (there is NO separate cell — rev1-M6):
  ```js
  ${IS_OWN() ? priceLabel : `<a href="https://www.discogs.com/release/${encodeURIComponent(rec.id)}" rel="noopener" style="color:var(--on-accent); text-decoration:underline">SEE ON DISCOGS →</a>`}
  ```
This wires the dormant `priceCellHtml` for the card friend case and inlines the equivalent link in
the modal's fixed accent cell. A friend crate never prints a `$` number in either place.

**5d. Modal stats on a friend crate.** `_loadStats` calls `window.TraxWaxStats(id)` (recon
`app.js:806`), which on a friend crate routes through the friend provider (sends `owner`; server
returns `price:null` per Task 2, and 403s a non-friend). Defense-in-depth: even if the server
returned a price, 5c renders the link, not a number. Verify the modal prints no `$` on a friend
crate.

**5e. No own-only modal actions exist in Wave 1** (SELL THIS is Wave 4; ADD TO WANTLIST is Wave 2).
No change.

**5f. Third price render — the LEDGER "expensive end" panel** (recon `app.js:457`, another
`${r.priceLabel}`). No change needed: on a friend crate every `price` is `null`, so `v.priciest`
is empty and the panel shows its existing graceful fallback text — identical to the own crate's
DB-mode behavior today (prices are already null in DB mode). No `$` leak, no regression. Left as-is
deliberately; noted so a future editor doesn't "fix" it.

---

## Task 6 — `_redirects`: the `/i/<code>` route

**File:** `public/_redirects`. Recon quoted the file; mirror the `/account` pair (destination
`/app/` with trailing slash; must stay outside `/api/*`). Append:
```
# Wave 1: invite-accept route. Same rewrite mechanics as /account — serve the SPA shell with the
# URL preserved so boot.js reads /i/<code> and runs acceptInvite(). Outside /api/*.
/i         /app/  200
/i/*       /app/  200
```
No change to `_routes.json` (Functions stay pinned to `/api/*`). `_headers` already marks the
shell no-cache.

---

## Task 7 — Release paperwork (same commit as the frontend push)

- `VERSION` → `1.4.0`.
- `CHANGELOG.md` → a `## [1.4.0] — <date>` entry: "Friends & shared crates" — consent toggle,
  single-use invite links, friend list + removal (instant, both directions), read-only friend
  crates with server-side price suppression, `/i/<code>` accept route. Note the migration (0012)
  and the `live-stats` change.
- `docs/roadmap.md` → current version `1.4.0`; add a Shipped entry; move Wave 1 from social-roadmap
  "next" to shipped.
- `docs/social-roadmap.md` → mark Wave 1 SHIPPED; note the RLS-vs-projection divergence as
  as-built.
- Commit message carries `Closes #<wave-1 issues>` for each issue filed from this plan (Task 9).

---

## Task 8 — Verification battery (run BEFORE calling the wave done)

**8a. Migration + RLS state matrix (SQL, on the live DB with synthetic rows only — real users
exist).** Create two synthetic users S1, S2 with profiles + a couple of `collection_items` each,
then assert the truth table. Use the break-glass connector; DELETE the synthetic rows in a
`finally`. Concretely, run and confirm each expected value:
```sql
-- setup: S1, S2 profiles + one collection_items row each; S1 crate_visibility='friends', no friendship yet.
-- (a) stranger cannot see: expect 0 rows
select public.can_view_crate('S2','S1');                 -- expect false (not friends)
-- (b) make them friends (both rows), re-check
insert into public.friendships values ('S2','S1',now()),('S1','S2',now());
select public.can_view_crate('S2','S1');                 -- expect true
-- (c) owner flips to private
update public.profiles set crate_visibility='private' where user_id='S1';
select public.can_view_crate('S2','S1');                 -- expect false (revocation via visibility)
-- (d) self always true
select public.can_view_crate('S1','S1');                 -- expect true
```
Then, impersonating each JWT via PostgREST is not available in SQL — instead assert the POLICY
predicate directly: with S1 visibility='friends' and the friendship present,
`select count(*) from collection_items where user_id='S1' and public.can_view_crate('S2','S1')`
returns S1's row count; with visibility='private' it must be gated (the policy would return no
rows for S2). Confirm the DELETE-based cleanup runs.

**8b. Forged / cross-user JWT probes (Edge, against `live-stats`).** With a valid JWT for S2 (or a
crafted test token if the harness supports it):
- `kind:'release', id:<x>, owner:<S1 username>` while **not** friends → **403 forbidden**.
- same after friending, S1 visibility='friends' → **200, `price: null`**, other stats present.
- `kind:'release', id:<x>` with **no** `owner` (own crate) → **200, price present**.
- **CACHE-HIT PROBE (rev1-C1 — the disqualifying bug):** FIRST call `kind:'release', id:<x>` with
  no owner as S1 (warms the global `release:<x>` cache with the real price). THEN, as S2 (friend of
  S1), call `kind:'release', id:<x>, owner:<S1 username>` → must be **200 with `price: null`**, NOT
  the warm price. Then as a NON-friend S3 → must be **403**, NOT a cached 200. If either returns the
  cached priced payload, the Task 2 ordering fix regressed.
- A forged token (bad signature) → **401** (existing behavior; confirm unchanged).

**8c. RPC identity probes.** Confirm `accept_friend_invite`/`create_friend_invite`/`remove_friend`
ignore any attempt to act as another user: they read `auth.jwt()->>'sub'` only. Confirm
`accept_friend_invite` with an expired/invalid hash → `invalid_or_expired`; with the inviter's own
JWT → `own_invite`; a second accept of a consumed code → `invalid_or_expired` (single-use).

**8d. jsdom baked-mode harness (no regressions).** Rebuild the scratch harness (see
`docs/phase-2-account-plan.md` §5 for the pattern; a working copy of the approach lives in the
W0.4 session notes / `log.md`). Assert: the crate still renders in baked mode; a **friend-crate**
render path (with `window.TraxWaxViewer = {isOwn:false, ...}` and a stub `TraxWaxData`) shows no
`data-act="account"` button, no RE-SYNC, the owner line is the friend's, and every price cell is
`SEE ON DISCOGS →` (never a `$` number). Assert the account page renders the SHARING toggle and the
FRIENDS empty state.

**8e. Live E2E (Lane + Tommy, ~5 min).** Lane: SHARING → on; FRIENDS → create link. Tommy: open
`/i/<code>` → accepted card → open `/app/lanebecker` → sees Lane's crate, prices show
`SEE ON DISCOGS →`, a record modal shows community stats but no price. Lane: FRIENDS → REMOVE
Tommy → Tommy reloads `/app/lanebecker` → S10 (identical to a bogus username). Lane: SHARING → off
→ Tommy (if still friends) → S10. Confirm not-found (`/app/zzznobody`) and not-friends render
byte-identically.

---

## Task 9 — GitHub milestone, issues, commit/handoff

- Create the Wave 1 milestone (Mac-side): `gh api repos/lanebecker/traxwax/milestones -f
  title="Wave 1 — Friends & consented crates" -f state=open`.
- File one issue per feature area (schema/RLS, live-stats suppression, consent UI, friend-crate
  view, invite route) so each commit can carry `Closes #N`. Attach them to the milestone.
- DB-first: apply + verify migration (Task 1, 8a) and deploy + verify live-stats (Task 2, 8b)
  under break-glass; ask Lane to disconnect break-glass after.
- Frontend: one `&&` chain Mac-side (`rm -f .git/index.lock && git add -A && git commit -m "v1.4.0
  … Closes #… #…" && git pull --rebase origin main && git push`), commit AFTER the DB is live.
- `log.md` entry; end-of-wave cold audit + documentation cold audit (per social-roadmap §2).

---

## Open decisions folded in (so the executor doesn't re-litigate)

- **Single-use invite codes** (Lane, 2026-08-30). Reusable-link fallback is tracked in **issue
  #10**, out of scope here.
- **Invite route `/i/<code>`**, top-level, mirroring `/account` (roadmap W0.5 decision 1: no
  `RESERVED_SEGMENTS` set exists).
- **`profiles` display via projection RPC, not a friend-read RLS policy** — documented divergence
  (see "The architectural decision …" above). `collection_items` via RLS policy.
- **Browser-callable `SECURITY DEFINER` RPCs** for invites/friends (no secrets involved), identity
  from `auth.jwt()` — new pattern for this repo, called out for the audit.

---

## Audit record — rev 1 → rev 2 (2026-08-30)

**Pass 2 (narrow, over the rework only): CONVERGED.** No CRITICAL/MAJOR. Verified sound: the Task 2
cache-order fix (403 + suppression provably run before the `index.ts:110` cache read; `suppressPrice`
in scope at all three returns; `admin` client available; only the 409-not-connected return precedes
it), the Task 3d inline mapping/pagination/select matching `installCrateProviders` verbatim, the
`crate_visibility` trace into `accountPageHtml`, the three-site section normalization, the toggle
re-render (real `toggle()` returns a single `<button>` root with `id`/`role=switch`/`aria-checked`),
the app.js substitutions, and the Task 1 grants. One MINOR folded: Task 5c line citations corrected
(card cell 245→259; modal `priceLabel` 590/rendered 635), plus a 5f note that the LEDGER
"expensive end" price render (app.js:457) is null-safe on a friend crate.

**Pass 1 (verification-pass): REVISE.** Independent no-context agent, target = this document. All
findings folded into rev 2; kept here (struck where the fix lands) so a killed finding is not
re-discovered from scratch next round.

- **~~C1 (CRITICAL) — price/stats leak via the cache early return.~~** `live-stats` returns the
  cached payload at `index.ts:111` BEFORE the rev-1 suppression at line 153, and the cache key is
  global/priced. A friend got the real price; a connected non-friend got cached Restricted stats.
  **Fixed:** Task 2 now runs the authz 403 + `suppressPrice` decision BEFORE `cacheGet`, and the
  cached return itself is suppressed. Task 8b adds an explicit cache-hit probe.
- **~~M2 — `mapRow`/`releaseDataProvider` don't exist.~~** `installCrateProviders` maps inline.
  **Fixed:** Task 3d now reproduces the inline mapping verbatim.
- **~~M3 — wrong projection + no pagination in the friend query.~~** Real select is
  `release_id, added, rating, vinyl, releases(...)`, paginated to beat PostgREST's 1,000 cap.
  **Fixed:** Task 3d uses the real select + the range loop.
- **~~M4 — SHARING toggle can't reflect the saved value.~~** `ensureProfile` didn't select
  `crate_visibility`, and `sharingSection` read a dep on the wrong object. **Fixed:** Task 3f-pre
  adds the column to the select; 4c reads `o.profile.crate_visibility`; `onGetVisibility` removed.
- **~~M5 — toggle repaint used a nonexistent class.~~** `toggle()` sets inline styles, no class.
  **Fixed:** 4e re-renders the toggle from the same renderer and re-binds.
- **~~M6 — Task 5c/5d contradicted each other on the modal price + a nonexistent second cell.~~**
  **Fixed:** 5c gives the exact card + single accent-cell edits; friend crate shows the link, owner
  shows `priceLabel`.
- **~~M9 — only one of three section-normalization sites patched.~~** **Fixed:** 4b rewrites line
  417 and uses `section` in both the nav call and the body branch.
- **~~M7 (minor→folded) — `body` type not widened for `owner`.~~** **Fixed:** 2a widens the type.
  **~~M8 — `UI.*` used inside boot.ui.js.~~** **Fixed:** all §4 code uses bare names.
  **~~M10 — wiring the card price cell changed the OWN crate (L5).~~** **Fixed:** 5c leaves the own
  card untouched; the SEE-ON-DISCOGS cell is friend-only. **~~M12 — PUBLIC/anon EXECUTE not
  revoked from the 5 RPCs.~~** **Fixed:** Task 1 revokes them. **~~M13 — `TraxWaxViewer` own-shape
  drift.~~** **Fixed:** 3e sets the full shape. **~~M15 — friend header showed `$0 EST.`~~**
  **Fixed:** 5b hides the EST cell on a friend crate.
- **M11 (accepted) —** friend stats provider now uses its own `fnCall` (null on `!ok`), matching
  the own-crate provider rather than `_pipeCall`. Folded into Task 3d.
- **M14 (open, verified-by-test) —** `auth.jwt()->>'sub'` inside a `SECURITY DEFINER` *body* has no
  in-repo precedent (existing DEFINER RPCs take the sub as a param; `auth.jwt()` appears only in
  RLS policies). It is sound in Supabase (PostgREST sets `request.jwt.claims` as a transaction GUC
  that survives the definer role switch), and Task 8c probes it live. **Contingency:** if 8c shows
  `auth.jwt()` is null inside the body, wrap the five RPCs in thin service-role Edge Functions that
  pass the JWT-verified sub as a param (the `finalize-connect` pattern) — a mechanical change that
  does not alter the schema or the RLS.

**Verified SOUND by the pass (do not re-litigate):** the `delete_account` amendment preserves all
five original table deletes; `can_view_crate` returns true only for self or consented friend;
the two `collection_items` SELECT policies OR correctly with no widening; EXECUTE on
`can_view_crate` to `authenticated` is required and granted; the S10 not-found/not-friends render
is identical; `crate_visibility` is client-writable past the 0007 guard; `priceCellHtml` exists and
is dead; `_redirects` mechanics; 0011 is latest and 0012 is free.
