# Import future-skew watermark #39 — persist the page-1 watermark (plan)

Status: **EXECUTED — shipped as v1.9.3 (2026-09-02), bundled with #48.** Verification-pass clean (4 LOW
runbook fixes applied pre-execute); migration 0022 applied + import-collection redeployed (v7) via
break-glass + post-verified; remediation-audit Pass-1 verified both fixes correct (no CRITICAL/MAJOR; 2
accepted LOWs documented below) → converged with no rework. Approach: **Option A — persist the page-1
DB-clock watermark server-side; the final-page sweep uses THAT, never the client echo.** No client change;
no new secret.

## Problem (#39)

`import-collection` mints the stale-sweep watermark from the DB clock on page 1 (`db_now`, line ~149) and
returns it. On pages ≥2 the client echoes `started_at`, and the server range-validates it with **+5 min of
future tolerance** (lines ~166-181). The final-page sweep is `delete().eq('user_id',userId).lt('updated_at',
startedAt)`. A caller who echoes a `started_at` up to +5 min in the future makes the sweep delete rows whose
trigger `updated_at` (≈ real now) is `< startedAt` — **including the rows just upserted this run** — a
transient self-wipe of the caller's own `collection_items`/`wantlist_items`. Self-scoped + self-healing
(`last_import_at` stays null → re-imports next load), but a real footgun.

Clamping to `db_now` at sweep time does NOT fix it (verified in the Wave-3 pass): on the final page `db_now`
is *newer* than the freshly-upserted rows, so the fresh rows still fall under the clamp. The only trustworthy
watermark is the **true page-1 server clock**, which the client cannot be trusted to echo faithfully.

## Fix (Option A)

Persist the page-1 `db_now` per kind on `profiles`; on the final page, sweep against the **persisted**
value (in-memory when page 1 IS the final page), never the client echo. The client echo stays in the
response for continuity but is no longer authoritative for deletion — so **boot.js is unchanged**.

Confirmed safe: `profiles` has only `profiles_select_own` / `_insert_own` / `_update_own` (migration 0001) —
**no friend SELECT policy**; friends read profiles only via `get_crate_owner` (SECURITY DEFINER, fixed
projection that excludes the new columns). The new columns are owner-only timestamps, read/written by the
service-role Edge function. importLoop (boot.js ~448-462) and wantlistImportLoop (~466-483) only store and
re-echo `d.started_at`; the response shape is unchanged, so they need no edit.

---

## Task 1 — migration `supabase/migrations/0022_import_watermark.sql`

Create the file with EXACTLY this content:

```sql
-- 0022_import_watermark.sql — cold-audit #39 (import future-skew self-wipe).
-- import-collection minted the stale-sweep watermark from db_now on page 1 and then trusted the CLIENT's
-- echo on pages >=2 (with +5min future tolerance). A forged +future echo made the final-page sweep
-- (delete where updated_at < started_at) delete the rows just upserted this run — a transient self-wipe.
-- Fix: persist the page-1 db_now server-side, per kind, and sweep against THAT (never the client echo).
-- Owner-only columns (profiles has no friend SELECT policy; get_crate_owner's projection excludes them).
alter table public.profiles
  add column if not exists import_started_collection timestamptz,
  add column if not exists import_started_wantlist   timestamptz;
```

Apply via break-glass (`apply_migration`, name `import_watermark`, the SQL above).

### Post-apply verification (read-only connector)
```sql
select column_name, data_type from information_schema.columns
 where table_schema='public' and table_name='profiles'
   and column_name in ('import_started_collection','import_started_wantlist')
 order by column_name;
```
Expected: two rows, both `timestamp with time zone`.

---

## Task 2 — `import-collection` Edge function (`supabase/functions/import-collection/index.ts`)

### 2a — add `wmCol` to the KIND descriptor

In the `KIND` object, add a `wmCol` field to BOTH branches.

FIND (the wantlist branch head):
```ts
    ? {
        path: (u: string) => `https://api.discogs.com/users/${encodeURIComponent(u)}/wants`,
        listKey: 'wants',
        table: 'wantlist_items',
        conflict: 'user_id,release_id',
        needsInstanceId: false,
```
REPLACE:
```ts
    ? {
        path: (u: string) => `https://api.discogs.com/users/${encodeURIComponent(u)}/wants`,
        listKey: 'wants',
        table: 'wantlist_items',
        conflict: 'user_id,release_id',
        wmCol: 'import_started_wantlist',
        needsInstanceId: false,
```

FIND (the collection branch head):
```ts
    : {
        path: (u: string) => `https://api.discogs.com/users/${encodeURIComponent(u)}/collection/folders/0/releases`,
        listKey: 'releases',
        table: 'collection_items',
        conflict: 'user_id,instance_id',
        needsInstanceId: true,
```
REPLACE:
```ts
    : {
        path: (u: string) => `https://api.discogs.com/users/${encodeURIComponent(u)}/collection/folders/0/releases`,
        listKey: 'releases',
        table: 'collection_items',
        conflict: 'user_id,instance_id',
        wmCol: 'import_started_collection',
        needsInstanceId: true,
```

### 2b — persist the watermark on page 1

FIND:
```ts
    startedAt = dbNow as string;
    // Wave 2 Stage A: only the collection pass writes import_status (the boot gate). A stray
    // 'running' from the background wantlist pass would trigger a spurious backgroundHeal on reload.
    if (kind === 'collection') {
      const { error: runErr } = await admin.from('profiles')
        .update({ import_status: 'running' }).eq('user_id', userId);
      if (runErr) {
        console.error('running-state update failed:', runErr.message);
        return json({ error: 'store_failed' }, 500);
      }
    }
```
REPLACE:
```ts
    startedAt = dbNow as string;
    // #39: persist the page-1 DB-clock watermark server-side (per kind) so the final-page sweep uses THIS
    // value, never the client's echo — a forged +future echo could otherwise delete the freshly-upserted
    // rows. Collection ALSO flips import_status='running' (the boot gate); a stray 'running' from the
    // background wantlist pass would trigger a spurious backgroundHeal on reload, so only collection sets it.
    const p1Update: Record<string, unknown> = { [KIND.wmCol]: startedAt };
    if (kind === 'collection') p1Update.import_status = 'running';
    const { error: runErr } = await admin.from('profiles')
      .update(p1Update).eq('user_id', userId);
    if (runErr) {
      console.error('page-1 watermark/state update failed:', runErr.message);
      return json({ error: 'store_failed' }, 500);
    }
```

### 2c — sweep against the persisted watermark (not the echo)

FIND:
```ts
  const done = page >= pages;
  if (done) {
    const { error: sweepErr } = await admin.from(KIND.table)
      .delete().eq('user_id', userId).lt('updated_at', startedAt);
    if (sweepErr) console.error(KIND.table + ' stale sweep failed:', sweepErr.message);
    if (kind === 'collection') {   // collection owns import_status; wantlist sweeps on the watermark only
      const { error: idleErr } = await admin.from('profiles')
        .update({ import_status: 'idle' }).eq('user_id', userId);
      if (idleErr) console.error('idle-state update failed:', idleErr.message);
    }
```
REPLACE:
```ts
  const done = page >= pages;
  if (done) {
    // #39: sweep against the AUTHORITATIVE page-1 watermark — in-memory when page 1 IS the final page,
    // else the value page 1 persisted (NEVER the client echo, which a caller could forge into the future
    // to wipe its own fresh rows). If it's missing, SKIP the sweep (stale rows are safe and self-heal on
    // the next full import) rather than delete against a bad bound.
    let sweepWm: string | null = startedAt;
    if (page > 1) {
      const { data: wmRow, error: wmErr } = await admin.from('profiles')
        .select(KIND.wmCol).eq('user_id', userId).maybeSingle();
      if (wmErr) console.error('watermark read failed:', wmErr.message);
      sweepWm = wmRow ? ((wmRow as Record<string, unknown>)[KIND.wmCol] as string | null) : null;
    }
    if (!sweepWm) {
      console.error(KIND.table + ' stale sweep skipped: no page-1 watermark');
    } else {
      const { error: sweepErr } = await admin.from(KIND.table)
        .delete().eq('user_id', userId).lt('updated_at', sweepWm);
      if (sweepErr) console.error(KIND.table + ' stale sweep failed:', sweepErr.message);
    }
    if (kind === 'collection') {   // collection owns import_status; wantlist sweeps on the watermark only
      const { error: idleErr } = await admin.from('profiles')
        .update({ import_status: 'idle' }).eq('user_id', userId);
      if (idleErr) console.error('idle-state update failed:', idleErr.message);
    }
```
(The trailing `}` and the final-page comment below it are unchanged.)

### 2d — refresh the stale header comment

FIND (lines 1-2):
```ts
/* Stage C: chunked collection import. One invocation = one Discogs page (<=100 items).
 * The frontend drives page 1..pages; the server keeps no cursor state.
```
REPLACE:
```ts
/* Stage C: chunked collection import. One invocation = one Discogs page (<=100 items).
 * The frontend drives page 1..pages; the server keeps no page CURSOR, but DOES persist a per-kind page-1
 * watermark (profiles.import_started_<kind>, #39) so the final-page stale-sweep can't be steered by a
 * forged client echo of started_at.
```

Also update the page-≥2 echo comment to note it's no longer authoritative. FIND:
```ts
  // ── Watermark: minted from the DATABASE clock on page 1 (same clock the trigger
  //    stamps rows with); rejected -- not clamped -- when an echo is out of range. ──
```
REPLACE:
```ts
  // ── Watermark: minted from the DATABASE clock on page 1 (same clock the trigger stamps rows with) and
  //    PERSISTED to profiles.import_started_<kind> (#39). The page->=2 client echo below is kept for
  //    response continuity + range-validated, but the final-page sweep uses the PERSISTED value, so a
  //    forged echo can no longer steer the delete. ──
```

### Verify
```
cd "<repo>/supabase/functions" && deno check import-collection/index.ts
```
Expected: no errors. (If `deno` is unavailable in the sandbox, rely on the type reasoning + the Edge
deploy's own build step, which rejects a type error.)

Grep checks:
```
grep -n "wmCol" import-collection/index.ts        # expect: 5 — 2 descriptor defs, the page-1 update key, + 2 in the sweep (.select(KIND.wmCol) and [KIND.wmCol])
grep -n "lt('updated_at'" import-collection/index.ts   # expect: ONE sweep, now against sweepWm (not startedAt)
```

Deploy via break-glass (`deploy_edge_function`, slug `import-collection`, the whole edited file). `verify_jwt`
stays false (the function self-verifies the Clerk token); no config change.

### Post-deploy functional probe (transaction, ROLLED BACK — or reason from code)
Simulate: set `profiles.import_started_collection = now() + interval '5 min'` for a test user with a fresh
`collection_items` row (updated_at ≈ now); confirm the OLD behavior would `delete ... lt(updated_at, now+5m)`
(wipes the fresh row), and that the NEW sweep reads the persisted value. Since the fix's whole point is that
the persisted value is the TRUE page-1 db_now (always ≤ the fresh rows' updated_at), a fresh row is never
swept. Prefer reasoning + a rolled-back probe over touching real rows.

---

## Deploy sequencing
Migration 0022 is purely additive (two nullable columns) — safe to apply before the Edge deploy (the old
function simply never reads/writes them). Apply migration → deploy `import-collection` → then the git push
(the migration file + the .ts source travel with it; the Edge fn is already live from the deploy). No
empty-state window like #42 (this doesn't drop anything).

## Known limitations & guard notes

- **`profiles_guard` trigger (0007) does not interfere.** The BEFORE INSERT/UPDATE guard that pins
  OAuth-owned profile columns runs its column-pinning only when `current_user in ('authenticated','anon')`;
  the Edge function writes as `service_role` (the `admin` client), which the guard skips — and
  `import_started_*` are not in the pinned set regardless. The page-1 `.update()` succeeds.
- **Same-kind concurrent-import race (accepted, self-healing).** Before this change each request swept
  against its own in-memory/echoed watermark, so two concurrent same-user *same-kind* imports were isolated.
  After it they share one persisted column: run B's page-1 can overwrite run A's watermark with a later
  value, and run A's final sweep would then read the newer bound and transiently over-delete A's
  not-yet-re-upserted rows. This is same-user-only, already discouraged by `import_status`, self-scoped, and
  self-healing (`last_import_at` stays null → a clean re-import next load). **Accepted** — not worth
  per-run state; the pre-existing design carries the same class of race on `import_status`.

- **Page-1-skip sweeps against a stale watermark (accepted, informational).** A caller that never invokes
  page 1 but calls a page ≥2 as the final page sweeps against whatever `import_started_<kind>` holds — null
  (→ skip, safe) or a prior completed import's value (→ deletes rows older than that stale bound). It
  **cannot** wipe the rows upserted in that call (their `updated_at = now()` ≥ any stale bound), so it is
  strictly *less* severe than the original #39 self-wipe and does not reintroduce it; the real client always
  starts at page 1. Caught by the #39 Pass-1 audit; accepted as a self-attack, self-scoped, self-healing edge
  (a fix would need a per-run marker = more state, disproportionate).

## Rollback
Revert the `import-collection` commit and redeploy the prior version; the columns can stay (harmless) or be
dropped (`alter table public.profiles drop column import_started_collection, drop column
import_started_wantlist;`). No data migration to unwind.

## Audit plan
remediation-audit Pass-1 (independent, break this): can a forged echo still wipe fresh rows (it must not —
the sweep reads the persisted value)? Does a single-page import (page 1 = final) still sweep correctly with
the in-memory watermark? Does a wantlist page-1 now correctly persist its own watermark without touching
import_status (the collection boot gate)? Does the concurrent collection+wantlist case stay isolated (per-kind
columns)? Any path where `sweepWm` is wrongly null → stale rows linger (safe) vs wrongly set → over-delete?
Type-safety of the `KIND.wmCol` dynamic select. Then the narrow Pass-2 over any rework. Converge.
