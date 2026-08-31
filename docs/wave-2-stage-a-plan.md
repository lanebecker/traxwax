# Wave 2 — Stage A plan (backend): wantlist schema, import, enrich redesign

**Status:** DRAFT — awaiting the verification pass, then Lane's review + break-glass.
**Scope:** Stage A of Wave 2 (backend-first, de-risk). Ships the wantlist data path end to end —
schema, import, and the enrich work-discovery/gate redesign — with **no user-facing surface**.
The match RPC, WANT/HAVE badges, MATCHES stat block, THE WANTLIST view, ADD TO WANTLIST, and
wantlist friend-visibility are **Stage B** (a separate plan).

**Decisions locked (Lane, 2026-08-31):**
1. Wantlist import **reuses `import-collection`** with a `kind: 'collection' | 'wantlist'` param
   (shared auth/decrypt/watermark/seed/sweep — one audit surface).
2. Adaptive rate-limit pacing is **client-driven**: the Edge Function returns
   `X-Discogs-Ratelimit-Remaining`; `importLoop` widens the inter-page gap when it is low.
3. Wantlist **friend-visibility deferred to Stage B** — Stage A adds own-read RLS only.

**Proposed version:** `v1.4.10` (Stage A is invisible backend plumbing; no UI). Stage B becomes the
user-facing `v1.5.0` "Wantlists & the match matrix" cut. Confirm with Lane at ship time.

---

## Load-bearing risk (why this is Stage A alone)

`enrich-release` closes the boot gate on `pending_enrichment.owned === 0`
(`supabase/functions/enrich-release/index.ts:109`, comment "A legitimately empty collection is a
completed import. Close the gate."). All five `pending_enrichment` subqueries
(`supabase/migrations/0010_catalog_refresh.sql:14-59`) discover work only via
`exists (collection_items …)`. So a wantlist-only user (0 collection rows, N wanted rows) would:
(a) trip `owned === 0` and have the gate closed immediately, and (b) never have their wanted
releases discovered for enrichment. Both must be fixed for combined collection+wantlist imports.

The fix is narrow: broaden the four **work** subqueries to `collection ∪ wantlist`, add a `wanted`
count beside `owned`, and change the empty-gate check to `(owned + wanted) === 0`. `remaining`
(`total − enriched`) then covers combined work automatically, because `total` broadens with the
others. `seed_releases` is release-keyed and ownership-agnostic (`0010:65-101`), so wantlist
releases seed through it unchanged — no change there.

---

## Deployment order (each step is backward-compatible; intermediate states are safe)

1. **Migration `0017`** (break-glass) — creates `wantlist_items`, redesigns `pending_enrichment`
   (adds `wanted`, broadens work subqueries), amends `unlink_discogs_account` + `delete_account`.
   Safe alone: the table is empty, so `wanted` is 0 and the broadened subqueries add nothing; the
   deployed (old) `enrich-release` still reads `owned` (still present) and behaves exactly as today.
2. **Deploy `enrich-release`** (break-glass) — reads the new `wanted`, uses `(owned+wanted)===0`.
   Safe: `wantlist_items` is still empty, so `wanted` is 0 and behavior is identical to today.
3. **Deploy `import-collection`** (break-glass) — accepts `kind`. Safe: nothing calls
   `kind:'wantlist'` until the frontend ships; `kind` defaults to `'collection'`.
4. **Push frontend** (Cloudflare auto-deploy) — `importLoop` runs the wantlist pass after the
   collection pass. This is the step that first writes `wantlist_items`.

Rolling back is the reverse; because each step is a no-op until the next arrives, a partial deploy
never corrupts state.

---

## Task 1 — Migration `supabase/migrations/0017_wantlist.sql` (break-glass: apply_migration)

**Pre-apply check (run first, read-only):** confirm the live `delete_account` body still matches
0012's (friendships + friend_invites deletes present) so the redefinition below does not regress it:

```sql
select pg_get_functiondef('public.delete_account(text)'::regprocedure);
```

Expected: a body containing `delete from public.friendships` and `delete from public.friend_invites`.
If it differs, STOP and reconcile before applying. Do the same for `unlink_discogs_account` (its
redefinition below is also a full-body rewrite; 0009 is the last definer but confirm):

```sql
select pg_get_functiondef('public.unlink_discogs_account(text)'::regprocedure);
```
Expected: the 0009 body (deletes collection_items, credentials, oauth_state, pending_links; resets profile).

**Migration file — complete contents:**

```sql
-- 0017_wantlist.sql — Wave 2 Stage A: wantlist data path (schema + work-discovery redesign).
-- No user-facing surface — the match RPC, badges, and THE WANTLIST view are Stage B.
-- Depends on 0016. wantlist_items mirrors collection_items' Restricted posture: own-token
-- import, deleted on disconnect/deletion. Friend-read RLS is DEFERRED to Stage B (the match
-- RPC is SECURITY DEFINER and needs no friend-read policy).

-- ── wantlist_items: which releases a user WANTS. One row per (user, release). ────
create table if not exists public.wantlist_items (
  id           bigint generated always as identity primary key,
  user_id      text   not null,
  release_id   bigint not null references public.releases(release_id),
  added        date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, release_id)
);
create index if not exists wantlist_items_user_idx    on public.wantlist_items (user_id);
create index if not exists wantlist_items_release_idx on public.wantlist_items (release_id);

-- Same db-clock updated_at trigger as collection_items (reuse touch_updated_at from 0004), so
-- import's stale-sweep (updated_at < started_at) works identically.
drop trigger if exists wantlist_items_touch on public.wantlist_items;
create trigger wantlist_items_touch
  before insert or update on public.wantlist_items
  for each row execute function public.touch_updated_at();

-- ── RLS: owner-only read + write (mirror collection_select_own / collection_write_own, 0001).
--    Writes happen via the service_role import (which bypasses RLS); the write policy exists so
--    the posture matches collection_items exactly. Friend-read is Stage B. ────────────────────
alter table public.wantlist_items enable row level security;
create policy wantlist_select_own on public.wantlist_items
  for select using (auth.jwt()->>'sub' = user_id);
create policy wantlist_write_own on public.wantlist_items
  for all using (auth.jwt()->>'sub' = user_id)
          with check (auth.jwt()->>'sub' = user_id);

-- ── pending_enrichment: broaden the FOUR work subqueries from collection-only to
--    (collection ∪ wantlist), and add a `wanted` count beside `owned`. `owned` keeps its
--    meaning (collection count). CREATE OR REPLACE preserves the 0008/0010 grants
--    (service_role only). Signature unchanged, so enrich-release's call is untouched. ────────
create or replace function public.pending_enrichment(p_user_id text, p_limit integer)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'owned', (select count(*) from public.collection_items ci
               where ci.user_id = p_user_id),
    'wanted', (select count(*) from public.wantlist_items wi
               where wi.user_id = p_user_id),
    'total', (select count(*)
                from public.releases r
               where r.tracks is null
                 and ( exists (select 1 from public.collection_items ci
                                where ci.user_id = p_user_id and ci.release_id = r.release_id)
                    or exists (select 1 from public.wantlist_items wi
                                where wi.user_id = p_user_id and wi.release_id = r.release_id) )),
    'pending', coalesce((select jsonb_agg(t.release_id)
                from (select r.release_id
                        from public.releases r
                       where r.tracks is null
                         and ( exists (select 1 from public.collection_items ci
                                        where ci.user_id = p_user_id and ci.release_id = r.release_id)
                            or exists (select 1 from public.wantlist_items wi
                                        where wi.user_id = p_user_id and wi.release_id = r.release_id) )
                       order by r.release_id
                       limit p_limit) t), '[]'::jsonb),
    'refresh_total', (select count(*)
                from public.releases r
               where r.tracks is not null
                 and ( (r.gone_at is not null and r.gone_at < now() - interval '7 days')
                    or (r.gone_at is null and r.enriched_at < now() - interval '180 days') )
                 and ( exists (select 1 from public.collection_items ci
                                where ci.user_id = p_user_id and ci.release_id = r.release_id)
                    or exists (select 1 from public.wantlist_items wi
                                where wi.user_id = p_user_id and wi.release_id = r.release_id) )),
    'refresh', coalesce((select jsonb_agg(t.release_id)
                from (select r.release_id
                        from public.releases r
                       where r.tracks is not null
                         and ( (r.gone_at is not null and r.gone_at < now() - interval '7 days')
                            or (r.gone_at is null and r.enriched_at < now() - interval '180 days') )
                         and ( exists (select 1 from public.collection_items ci
                                        where ci.user_id = p_user_id and ci.release_id = r.release_id)
                            or exists (select 1 from public.wantlist_items wi
                                        where wi.user_id = p_user_id and wi.release_id = r.release_id) )
                       order by (r.gone_at is null), coalesce(r.gone_at, r.enriched_at)
                       limit p_limit) t), '[]'::jsonb)
  );
$$;

-- ── Amend unlink_discogs_account (0009): also delete wantlist rows on disconnect. Full
--    redefinition = the 0009 body + one delete. ──────────────────────────────────────────────
create or replace function public.unlink_discogs_account(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where user_id = p_user_id) then
    return jsonb_build_object('status', 'no_profile');
  end if;
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.wantlist_items        where user_id = p_user_id;   -- Wave 2 Stage A
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  update public.profiles
     set discogs_username     = null,
         discogs_connected_at = null,
         last_import_at       = null,
         import_status        = 'idle'
   where user_id = p_user_id;
  return jsonb_build_object('status', 'ok');
end;
$$;

-- ── Amend delete_account: full redefinition of the CURRENT (0012) body — which deletes
--    friendships + friend_invites — PLUS the wantlist delete. Using 0009's body here would
--    REGRESS Wave 1. Verified against the pre-apply pg_get_functiondef check above. ──────────
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
  delete from public.wantlist_items        where user_id = p_user_id;   -- Wave 2 Stage A
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  delete from public.profiles              where user_id = p_user_id;
  return jsonb_build_object('status','ok','existed', v_existed);
end;
$$;

-- Grants unchanged by CREATE OR REPLACE; re-assert for parity with the source migrations.
revoke all on function public.unlink_discogs_account(text) from public, anon, authenticated;
revoke all on function public.delete_account(text)         from public, anon, authenticated;
grant execute on function public.unlink_discogs_account(text) to service_role;
grant execute on function public.delete_account(text)         to service_role;
```

**Post-apply verification (read-only, break-glass execute_sql):**

```sql
-- (a) wantlist_items exists with the right shape + trigger + policies
select count(*) as cols from information_schema.columns
  where table_schema='public' and table_name='wantlist_items';           -- expect 6
select tgname from pg_trigger where tgrelid='public.wantlist_items'::regclass
  and not tgisinternal;                                                   -- expect wantlist_items_touch
select polname from pg_policies where schemaname='public' and tablename='wantlist_items';
  -- expect wantlist_select_own, wantlist_write_own
-- (b) pending_enrichment returns `wanted` and stays correct for a collection-only user:
select public.pending_enrichment('user_3IZFPY6vhx0S404HmkSdaWKEtGs', 5)
  -> 'wanted';                                                            -- expect 0 (no wants yet)
-- (c) both RPCs carry the wantlist delete
select pg_get_functiondef('public.unlink_discogs_account(text)'::regprocedure) ilike '%wantlist_items%';
select pg_get_functiondef('public.delete_account(text)'::regprocedure) ilike '%wantlist_items%'
   and pg_get_functiondef('public.delete_account(text)'::regprocedure) ilike '%friendships%';  -- both true
```

Also write the file to the repo verbatim (committed after apply, per DEPLOY.md convention).

---

## Task 2 — `supabase/functions/enrich-release/index.ts` gate fix (break-glass: deploy_edge_function)

Change the two lines that read work discovery and the empty-gate check. **Exact edits:**

Replace (currently lines 103):
```ts
  const ownedCount = Number(work?.owned ?? 0);
```
with:
```ts
  const ownedCount = Number(work?.owned ?? 0);
  const wantedCount = Number(work?.wanted ?? 0);   // Wave 2 Stage A: wantlist-only users have owned=0
```

Replace (currently line 109):
```ts
  if (ownedCount === 0) {
```
with:
```ts
  if (ownedCount === 0 && wantedCount === 0) {
```

No other change. `totalPending` (`work.total`) and `remaining` (`total − enriched`) already broaden
because `pending_enrichment.total` now counts owned ∪ wanted un-enriched releases. Redeploy.

---

## Task 3 — `supabase/functions/import-collection/index.ts` (`kind` param + wantlist mapping + pacing)

Three changes. **(3a) Parse and validate `kind`.** After the `page` validation block (currently
ends **line 82**, `if (!Number.isInteger(page) …) return json({ error: 'bad_request' }, 400);`), the
body already destructures `{ page, started_at }`; extend it and add:

```ts
  const kind = body.kind === 'wantlist' ? 'wantlist' : 'collection';   // default preserves today
```
(Add `kind?: unknown` to the `body` type annotation.)

**(3b) A per-kind descriptor.** Immediately after the `admin` client is created (currently
**lines 84-87**), add:

```ts
  // Wave 2 Stage A: one function, two kinds. Only the endpoint, list key, target table,
  // conflict key, and row mapping differ; auth/decrypt/watermark/seed/sweep are shared.
  const KIND = kind === 'wantlist'
    ? {
        path: (u: string) => `https://api.discogs.com/users/${encodeURIComponent(u)}/wants`,
        listKey: 'wants',
        table: 'wantlist_items',
        conflict: 'user_id,release_id',
        // wants have basic_information + date_added + id (release id); NO instance_id.
        mapItem: (r: Record<string, unknown>, releaseId: number) => ({
          user_id: userId, release_id: releaseId,
          added: typeof r.date_added === 'string' ? r.date_added.slice(0, 10) : null,
        }),
        needsInstanceId: false,
      }
    : {
        path: (u: string) => `https://api.discogs.com/users/${encodeURIComponent(u)}/collection/folders/0/releases`,
        listKey: 'releases',
        table: 'collection_items',
        conflict: 'user_id,instance_id',
        mapItem: (r: Record<string, unknown>, releaseId: number) => ({
          user_id: userId, release_id: releaseId,
          instance_id: Number(r.instance_id),
          folder: r.folder_id != null ? String(r.folder_id) : '',
          rating: Number(r.rating ?? 0) || 0,
          added: typeof r.date_added === 'string' ? r.date_added.slice(0, 10) : null,
          vinyl: ((r.basic_information as Record<string, unknown>)?.formats as Array<{ text?: string }>)?.[0]?.text ?? '',
        }),
        needsInstanceId: true,
      };
```

**(3c) Use the descriptor** in the four places that are currently collection-specific:

- **Page URL** — replace the `const pageUrl = …` line with:
  ```ts
  const pageUrl = `${KIND.path(prof.discogs_username)}?page=${page}&per_page=100&sort=added&sort_order=desc`;
  ```
  (Discogs `/wants` accepts `sort=added&sort_order=desc` too; the desc-sort deletion caveat in the
  existing comment applies identically.)
- **List extraction** — replace `const entries = Array.isArray(d.releases) ? d.releases : [];` with:
  ```ts
  const entries = Array.isArray((d as Record<string, unknown>)[KIND.listKey])
    ? (d as Record<string, unknown>)[KIND.listKey] as Array<Record<string, unknown>> : [];
  ```
  (Also widen the `d` type: add `wants?: Array<Record<string, unknown>>;` beside `releases?`.)
- **Row mapping** — inside the `for (const r of entries)` loop, keep `releaseId`/`instanceId`
  parsing but gate the instance requirement on the kind. Replace the validity check:
  ```ts
  if (!Number.isInteger(releaseId) || (KIND.needsInstanceId && !Number.isInteger(instanceId))) {
    console.error('entry missing release/instance id; kind', kind, 'fields:', Object.keys(r as object).join(','));
    return json({ error: 'unexpected_shape' }, 502);
  }
  ```
  and replace the `items.push({ … })` object with `items.push(KIND.mapItem(r, releaseId));`. The
  `seeds.set(...)` block is unchanged (both kinds seed from `basic_information`).
- **Upsert + sweep** — replace `.from('collection_items').upsert(items, { onConflict: 'user_id,instance_id' })`
  with `.from(KIND.table).upsert(items, { onConflict: KIND.conflict })`, and the final-page sweep
  `.from('collection_items').delete()…` with `.from(KIND.table).delete().eq('user_id', userId).lt('updated_at', startedAt)`.

**(3d) Adaptive pacing — return the rate header.** After the `if (!res.ok)` check on the page fetch
(currently **line 163** — the page-fetch failure check, NOT the mapping block near line 205), read
the header once:
```ts
  const rateRemaining = Number(res.headers.get('X-Discogs-Ratelimit-Remaining'));
```
There is a **single** `return json(...)` in this function (currently **line 262**); the `done` flag
already distinguishes final-page from normal within it. Change that one return
`return json({ page, pages, items: totalItems, started_at: startedAt, done });` to:
```ts
  return json({ page, pages, items: totalItems, started_at: startedAt, done,
    rate_remaining: Number.isFinite(rateRemaining) ? rateRemaining : null, kind });
```

`import_status` transitions stay per-kind (page-1 → 'running', final page → 'idle'). The brief
'idle' between the collection and wantlist passes is invisible: the frontend is inside `importLoop`
showing its own progress card the whole time and does not re-read `import_status` mid-loop.

Redeploy.

---

## Task 4 — `public/boot.js`: background wantlist import (post-reload) + client pacing

**Decision (Lane, 2026-08-31): BACKGROUND.** Collection imports and the crate renders exactly as
today; the wantlist imports silently afterward. So `importLoop`, `runImport`, `setProgress`, and the
`import_completed` event are **UNCHANGED** — `import_completed` correctly reports the collection count.
Because `onResync` reloads to show the fresh crate (which would kill an in-flight background task), the
wantlist import is deferred to the post-reload load via a sessionStorage flag.

**(4a) A silent wantlist import loop.** Add immediately after `importLoop` (i.e. after
`public/boot.js:411`):

```js
/* Wave 2 Stage A: silent wantlist import — the same page-loop as importLoop but kind='wantlist',
   no progress UI, client-driven adaptive pacing. Throws on give-up; the caller logs and moves on. */
async function wantlistImportLoop() {
  let page = 1, pages = 1, startedAt = null;
  do {
    const t0 = Date.now();
    const d = await _pipeAttempt(() => _pipeCall('import-collection',
      Object.assign({ page, kind: 'wantlist' }, startedAt ? { started_at: startedAt } : {})));
    pages = d.pages; startedAt = d.started_at;
    if (d.done) break;
    page++;
    const elapsed = Date.now() - t0;
    // Client-driven adaptive pacing: back off hard when Discogs' shared-IP budget runs low,
    // else the normal elapsed-aware 1.1s pace. The 429 retry in _pipeAttempt is the backstop.
    const rr = Number(d.rate_remaining);
    const gap = (Number.isFinite(rr) && rr < 15) ? 2500 : Math.max(0, 1100 - elapsed);
    await new Promise((r) => setTimeout(r, gap));
  } while (page <= pages && page <= 500);
}
```

**(4b) Flag a wantlist re-sync when RE-SYNC runs.** Change `onResync` (currently
`public/boot.js:568`) to set the flag before the reload:

```js
    onResync: async () => {
      const ok = await runImport();
      if (ok) {
        try { sessionStorage.setItem('tw_wantlist_due', '1'); } catch (e) {}
        window.location.reload();
      }
    },
```

**(4c) Run the deferred wantlist import on the next crate load, before the enrich drain.** In the
**owner's-own-crate** DB-mode render path — adjacent to the existing on-load `backgroundEnrich()`
call — add the flag check (fire-and-forget, never blocks render):

```js
  // Wave 2 Stage A: a just-completed collection RE-SYNC set this flag; import the wantlist silently,
  // THEN drain enrichment (which now discovers wanted releases). backgroundEnrich's _enrichRunning
  // guard + its per-iteration pending_enrichment re-read make the ordering safe either way.
  let _wlDue = false;
  try { _wlDue = sessionStorage.getItem('tw_wantlist_due') === '1'; } catch (e) {}
  if (_wlDue) {
    try { sessionStorage.removeItem('tw_wantlist_due'); } catch (e) {}
    wantlistImportLoop().then(() => backgroundEnrich())
      .catch((e) => console.warn('wantlist import stopped:', e));
  }
```

**Placement guard — load-bearing:** this MUST live in the owner's-own-crate branch only, never in
`installFriendCrateProviders` (you never import a friend's wantlist). At execution, re-read boot.js's
own-crate render branch and confirm the exact insertion line next to its `backgroundEnrich()` call —
do not trust a memorized line number here (the verification pass flagged line drift elsewhere).

Optional: `track('wantlist_imported')` (no payload) at the end of `wantlistImportLoop` for a Stage-A
funnel signal. `node --check public/boot.js` after the edits.

---

## Task 5 — Verification (break-glass execute_sql, all rolled back; + local checks)

**State-matrix probe.** For each user shape, insert synthetic rows in a `begin … rollback`, then call
`pending_enrichment` and assert the gate-relevant fields. Reuse a real release id that is un-enriched
or synthesize one. Template (fill the four cases):

```sql
begin;
insert into public.profiles (user_id) values ('probe_w2');
-- CASE: wantlist-only. Give the user 1 wanted release whose catalog row has tracks IS NULL.
insert into public.releases (release_id, artist, title) values (999000001, 'Probe', 'W2') on conflict do nothing;
update public.releases set tracks = null where release_id = 999000001;
insert into public.wantlist_items (user_id, release_id) values ('probe_w2', 999000001);
select public.pending_enrichment('probe_w2', 5) as work;   -- expect owned=0, wanted=1, total>=1, pending contains 999000001
rollback;
```

Assert across the four cases:
- **wantlist-only** (owned 0, wanted ≥1, wanted release un-enriched): `owned=0`, `wanted=1`,
  `total ≥ 1`, `pending` includes the wanted release. (Confirms the gate will NOT close early and the
  release is discovered.)
- **combined** (collection + wantlist, overlapping and disjoint): `total` counts the union, no
  double-count of a release both owned and wanted.
- **collection-only regression** (owned ≥1, wanted 0): identical numbers to today's `pending_enrichment`
  for the same user (run the OLD shape's expectation: `wanted=0`, `total`/`pending` unchanged).
- **empty** (owned 0, wanted 0): `owned=0`, `wanted=0`, `total=0`, `pending=[]` — enrich-release's
  `(owned+wanted)===0` closes the gate (the intended behavior).

**RPC-deletion probe** (rolled back): create a synthetic user with collection + wantlist + friendship
rows, call `unlink_discogs_account` then re-query — wantlist rows gone, and separately `delete_account`
removes wantlist AND still removes friendships/friend_invites (no Wave 1 regression).

**Local checks:** `node --check public/boot.js`; TypeScript sanity on the two Edge Functions via
`deno check supabase/functions/import-collection/index.ts supabase/functions/enrich-release/index.ts`
(if deno is unavailable in the sandbox, a careful read + the Supabase deploy's own type check stands in).

**Live E2E (post-deploy, real accounts):** Lane RE-SYNCs; confirm (a) collection still imports and the
crate renders unchanged, (b) `wantlist_items` populates with his Discogs wants, (c) enrichment drains
to completion for wanted-but-not-owned releases, (d) the boot gate still closes (crate loads). A
wantlist-only test account, if available, is the highest-value check.

---

## Task 6 — Adversarial audit loop (to convergence — standing Wave 2 rule)

After the code is written and Task 5's probes are green, BEFORE the frontend push:
- **Pass 1:** independent adversarial audit (subagent) of the whole Stage A diff — migration,
  both Edge Functions, frontend. Hunts: the work-discovery redesign correctness (no release
  double-counted; wantlist-only user enriches; collection-only unchanged); the gate change
  (`(owned+wanted)===0`) has no path that closes early or never; the `kind` reuse did not break the
  collection path (watermark/sweep still scoped correctly, per-kind); the sweep can't cross tables;
  RLS on `wantlist_items` is own-only and writes are service-role; deployment-order safety.
- **Narrow passes:** every pass that produces rework gets its own narrow pass, until one converges
  with no rework (the discipline confirmed this session — a functional spot-check is NOT a pass).

---

## Task 7 — Version, docs, close, handoff

- `VERSION` → `1.4.10` (confirm with Lane; Stage A is invisible backend).
- `CHANGELOG.md` — new entry (Added: wantlist import + wantlist_items; Changed: pending_enrichment
  work-discovery now covers owned ∪ wanted, enrich gate closes on owned+wanted; adaptive pacing).
- `log.md` (project root) — append the Stage A entry.
- `supabase/migrations/0017_wantlist.sql` committed (already applied).
- GitHub: file the Wave 2 Stage A tracking issue if one doesn't exist; the commit references it.
- Mac handoff: `rm -f .git/index.lock && git add -A && git commit -m "…" && git pull --rebase origin main && git push`.
- Lane disarms break-glass after the migration + both deploys land.

---

## Verification pass (independent agent, 2026-08-31) — VERDICT: EXECUTE-READY after these fixes

**Verified CORRECT (do not re-litigate):** no `delete_account` regression — last definer is
`0012_friends.sql:210-229`, the redefinition preserves all 7 deletes (incl. friendships +
friend_invites) and adds wantlist. `pending_enrichment` broadens all four work subqueries with **no
double-count** (EXISTS-OR over one `releases` row) and preserves the refresh predicates/ordering;
`enrich-release` is its only consumer and reads only still-present keys (deploy step 1-before-2 safe).
enrich `:103`/`:109` edits are the only `owned` references and are sufficient. `import-collection`
`kind` reuse preserves seed-before-items (FK), per-kind watermark/sweep scoping, and the collection
mapping field-for-field. Mirrors (`touch_updated_at`, `collection_select_own`, table shape) correct.
Deployment order safe. No Stage-B leak.

**Corrections applied to this doc:** Task 3 line refs (3a→82, 3b→84-87, 3d page-fetch check→163 not
205, single `return`→262); the "BOTH return objects" misreading → the one return at 262; setProgress
cite 463→466; added a pre-apply body check for `unlink_discogs_account`.

**Resolved (Lane, 2026-08-31): BACKGROUND.** Task 4 is finalized for the background design —
`importLoop`/`runImport`/`setProgress`/`import_completed` unchanged (analytics reports the collection
count), a silent `wantlistImportLoop` deferred to the post-reload load via the `tw_wantlist_due` flag,
sequenced before the enrich drain. **Remaining execution-time items (not blockers):** confirm the
Discogs `/users/<user>/wants` response shape against Lane's own `/wants` before the frontend push;
refresh the now-imprecise enrich `index.ts:110` comment (the gate also checks `wanted`); and confirm
the exact 4c insertion line in boot.js's own-crate branch at execution (do not trust a memorized line).

## Self-review (write-plan checklist)

- **Spec coverage:** schema (T1) · import + pacing (T3, T4) · enrich redesign (T1 RPC + T2 gate) ·
  disconnect/delete amend (T1) · verification (T5) · audit (T6) · ship (T7). All Stage-A roadmap
  items covered; match RPC / badges / MATCHES / WANTLIST view / ADD-TO-WANTLIST / friend-visibility
  explicitly deferred to Stage B.
- **Placeholder scan:** no "TBD" / "add appropriate error handling" / "similar to Task N" / bare
  "write tests for the above" — every code step carries complete code.
- **Name/type consistency:** `kind` values `'collection'|'wantlist'`; response field `rate_remaining`;
  RPC field `wanted`; table `wantlist_items`; conflict keys `user_id,release_id` (wantlist) vs
  `user_id,instance_id` (collection) — consistent across T1–T5.
