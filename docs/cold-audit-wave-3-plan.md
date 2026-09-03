# Cold audit — Wave 3 plan (backend & DB integrity)

Status: EXECUTED — shipped as v1.9.0 (migration 0020, 2026-09-01). Historical plan record. (Was: DRAFT — verified (verification-pass 2026-08-31). Needs **break-glass** — one migration apply; no
Edge redeploy). Target version **v1.9.0**.

## Scope

The two clean, verified backend-integrity findings. **#42, #43, and now #39 are pulled out** of this wave:

- **#42 / #43** → friend-visibility product track (with #47): #42 needs a product decision on friend
  rating-visibility + a frontend change; #43's one-line RPC fix produces an empty-crate UX with no
  friend-wantlist browse to justify it. (See their GitHub comments.)
- **#39** → deferred. The verification pass showed the proposed `least(startedAt, db_now)` clamp is a
  no-op: `db_now` read at sweep time is *newer* than every freshly-upserted row, so it would still sweep
  them in exactly the skew case it targets. Sparing fresh rows needs a **trustworthy page-1 start time**,
  which the stateless final-page invocation only has via the untrusted client watermark — the correct fix
  is a protocol change (persist page-1's `db_now` server-side and sweep against that), disproportionate to
  a **low-severity** bug (self-crafted by the user's own authenticated client, self-scoped to their own
  collection, transient, self-healing on next import). Left open with that approach documented (#39).

Shipping this wave:

- **#40** — `delete_account` leaves the deleted user's Clerk sub in `friend_invites.accepted_by` (erasure
  residue). Migration.
- **#41** — migration 0016 revoked anon's reach into schema `private`, but the friend-read RLS policies
  call `private.can_view_*`; an anon SELECT now errors instead of returning empty (Wave-5 landmine).
  Migration.

Nothing here changes a table's columns; #40/#41 are a function + two policies. No frontend change, no Edge
change. One migration (0020), applied via break-glass.

---

## Task 1 — migration `supabase/migrations/0020_wave3_backend_integrity.sql`

Create the file with EXACTLY this content. (The `delete_account` body is the current live one from
`0017_wantlist.sql:115-135`, with one added line; the policies are the current ones from `0013:34-36`
and `0018:34-36`, re-created with `to authenticated`.)

```sql
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
```

Apply (break-glass, armed connector or Supabase CLI):
```
supabase migration up   # or the break-glass apply_migration with the file's contents
```

### Post-apply verification (run under the read-only connector or psql)

1. **delete_account body carries the new line:**
   ```sql
   select pg_get_functiondef('public.delete_account(text)'::regprocedure) like '%accepted_by = null%';
   ```
   Expected: `t`.
2. **Friend policies are now role-scoped to authenticated:**
   ```sql
   select polname, roles::regrole[] from pg_policy
   where polname in ('collection_select_friends','wantlist_select_friends');
   ```
   Expected: both list `{authenticated}` (not `{public}`/`{0}`).
3. **The owner policies are unchanged and still cover the tables** (sanity):
   ```sql
   select tablename, policyname, roles from pg_policies
   where tablename in ('collection_items','wantlist_items') order by tablename, policyname;
   ```
   Expected: `collection_select_own`, `collection_select_friends` (authenticated), and the wantlist
   equivalents present; no policy dropped by accident.
4. **Advisors** (`get_advisors` security): no new lint (the function keeps `search_path`; policies unchanged
   in shape).

---

## Rollback

`0020` is additive/idempotent (`create or replace` + `drop policy if exists`/`create`). To revert #41,
re-create the two policies without `to authenticated` (the 0013/0018 form). To revert #40, `create or
replace` `delete_account` without the `accepted_by` line. No data migration to unwind. No Edge change in
this wave.

## Audit plan

After build, before commit: independent pass-1 adversarial audit of the migration — the `delete_account`
body matches the live one plus exactly the one added line; the `to authenticated` scoping doesn't lock out
authenticated readers or the owner path; no `search_path`/grant regression. Narrow pass to convergence.
State-matrix probes where safe (delete_account de-identifies `accepted_by`; an anon SELECT on
collection_items / wantlist_items returns empty, not an error).
