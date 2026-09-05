# Wave 5a — master_year data lift (Card A honesty) — plan

Status: DRAFT for verification-pass + Lane (break-glass armed 2026-09-04). Companion to Design's
`wave-5a-write-plan.md` (frontend) and the design kit. This plan is the **backend prerequisite** Lane chose
("data lift first", 2026-09-04): Card A's decade histogram must read the **original-release (master) year**,
not the pressing year. Today `releases.year` is the pressing year, so a 2024 repress of a 1971 LP reads
"2020s" — the lede "released this decade" is literally false on that data.

Repo: `traxwax-clone`. Migration **0032** (0031 is latest). Break-glass connector for apply/deploy:
`d833898f-0ee4-4638-8cb9-4b3e8d29d994` (NEW — must `ToolSearch select:` its `apply_migration` /
`deploy_edge_function` / `execute_sql` before use). Read-only connector for verify:
`ba10f8ee-7e43-4baf-a529-f248c6fdad0b`.

## The shape of the fix
`master_year` is a **separate, deduplicated enrichment dimension** on the shared CC0 `releases` catalog. It is
NOT wired into the import/enrich release-GET (that would double every import's Discogs calls). Instead a
low-priority drain class fetches each **distinct master once** (`GET /masters/{id}`, CC0 `year`) and writes it
to **all sibling pressings at once** (`UPDATE … WHERE master_id = $id`). The forward path already stores
`master_id` (enrich-release #28), so nothing about import changes.

## Sequencing (why this is a backend precursor)
The drain runs only in Lane's browser (his OAuth token, via enrich-release). So:
1. **Apply 0032 + deploy enrich-release + ship the boot.js drain-signal change** (this plan).
2. **Lane opens the app; the drain backfills `master_year`** — deduped, ~distinct-masters Discogs calls at
   ≤60/min (~25–45 min of app-open time). I **monitor** the null-count to 0 via the read-only connector.
3. Only once `master_year` is fully populated does **Card A read true** (until then `releaseYear` falls back to
   pressing year — the card degrades gracefully, never wrong-forever).

Two ways to package this against Design's frontend (Lane's call, see "Release packaging" at the bottom):
- **One release (recommended):** ship backend + frontend together; Card A self-heals to master-year within the
  first ~40 min of app-open time. Simple git.
- **Two releases (strict "data first"):** ship this backend precursor, drain to completion (I verify), then
  ship the DNA-card frontend on a fully-backfilled column. Card A is honest the instant it appears; costs a
  second release + a partial `git add`.

---

## Task 1 — Migration `0032_master_year.sql`

```sql
-- 0032_master_year.sql — Wave 5a: original-release (master) year for the Collection DNA card.
-- releases.year is the PRESSING year; the DNA "decades" card must read the master's original-release
-- year. master_year is deduplicated CC0 catalog data (many pressings share one master), filled by the
-- enrich-release master-backfill drain (this migration only adds the column + surfaces the work).

-- ── The column. Nullable = "not yet resolved". 0 = "resolved, no usable master year" (sentinel; the
--    client falls back to pressing year). >0 = the real original-release year.
alter table public.releases add column if not exists master_year int;

-- ── Partial index so the drain's "which rows still need a master year" scan is cheap and never a seq scan
--    over the whole catalog as it fills.
create index if not exists releases_master_year_pending_idx
  on public.releases (master_id)
  where master_year is null and master_id is not null;

-- ── Widen pending_enrichment: add a THIRD work class, master-year backfill. This is a SUPERSET of the
--    LIVE 0017 body (VERIFIED against supabase/migrations/0017_wantlist.sql:36-86 — 0017 supersedes 0010:
--    it adds `wanted` and broadens all four work subqueries to (collection ∪ wantlist)). We preserve 0017
--    EXACTLY and append only `master_total` + `master`. CREATE OR REPLACE keeps name/signature/grants; the
--    deployed handler ignores the two new keys until its v-next lands. master rows = owned-or-wanted, already
--    enriched (tracks present), real master_id, no master_year yet. Returns {release_id, master_id} so the
--    handler dedupes by master in the batch with no re-query.
--    (Master backfill is scoped to the COLLECTION only, mirroring the DNA card's own-collection scope —
--    wantlist releases don't feed the card, so we don't spend Discogs calls on their master years.)
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
                       limit p_limit) t), '[]'::jsonb),
    -- ── NEW (Wave 5a): master-year backfill. COLLECTION-scoped (not wantlist), enriched, real master, no
    --    master_year yet. jsonb_build_object gives the handler {release_id, master_id} to dedupe by master.
    'master_total', (select count(*)
                from public.releases r
               where r.tracks is not null
                 and r.master_id is not null and r.master_id <> 0 and r.master_year is null
                 and exists (select 1 from public.collection_items ci
                              where ci.user_id = p_user_id and ci.release_id = r.release_id)),
    'master', coalesce((select jsonb_agg(jsonb_build_object('release_id', t.release_id, 'master_id', t.master_id))
                from (select r.release_id, r.master_id
                        from public.releases r
                       where r.tracks is not null
                         and r.master_id is not null and r.master_id <> 0 and r.master_year is null
                         and exists (select 1 from public.collection_items ci
                                      where ci.user_id = p_user_id and ci.release_id = r.release_id)
                       order by r.master_id      -- group siblings so a batch tends to cover distinct masters
                       limit p_limit) t), '[]'::jsonb)
  );
$$;
```
No grant changes (CREATE OR REPLACE preserves the 0008/0010/0017 service_role-only grant). No RLS change.
**VERIFICATION-PASS FIX (defect 1):** an earlier draft rebuilt this from 0010, which would have DROPPED
`wanted` + the wantlist union and broken wantlist enrichment for every user. The body above is 0017 verbatim
plus the two master keys — re-diff against `0017_wantlist.sql:42-86` before applying.
**Not in this migration:** `get_friend_crate` is NOT amended — the DNA card is own-crate only, so friend
reads don't need `master_year` (noted out-of-scope; a future card that runs on friend crates would add it).

### Post-apply verify (read-only connector)
```sql
select column_name,data_type from information_schema.columns
 where table_name='releases' and column_name='master_year';                       -- 1 row, integer
-- VERIFICATION-PASS FIX (defect 3): pending_enrichment returns ONE jsonb scalar — extract keys from it, never
-- a column-definition list (`as x(...)` on a scalar function errors). master_total ≈ owned-with-master; batch ≤5.
select (pending_enrichment('<lane user_id>', 5)->>'master_total')::int   as master_total,
       jsonb_array_length(pending_enrichment('<lane user_id>', 5)->'master') as batch;
-- Regression guard for defect 1 — 0017's keys must survive the rewrite:
select (pending_enrichment('<lane user_id>', 5) ? 'wanted') as has_wanted;   -- must be true
```

---

## Task 2 — enrich-release master-backfill class (`supabase/functions/enrich-release/index.ts`)

Add master work as a THIRD batch class, processed after new + refresh, within the same `BUDGET`. Master-GET
only (these rows are already enriched — no release GET). Dedupe by `master_id` within the run; write every
sibling at once; sentinel `0` on a permanent no-year so the row exits the pending set (never wedges).

**2a.** After the existing `refreshIds`/`refreshTotal` reads (~line 111), add:
```ts
  const masterTotal = Number(work?.master_total ?? 0);
  const masterRows: Array<{ release_id: number; master_id: number }> =
    Array.isArray(work?.master) ? work.master.map((m: Record<string, unknown>) =>
      ({ release_id: Number(m.release_id), master_id: Number(m.master_id) })) : [];
```

**2b.** The "no work at all" early-out (~line 113) must also account for master work — change nothing in the
`owned===0 && wanted===0` guard (that's genuinely-empty imports), but the `totalPending === 0` early-return
(~line 130) must fall through when master work exists. Replace the `if (batch.length === 0) return …` inside
that block so it only returns when new AND refresh AND master are all empty:
```ts
    if (batch.length === 0 && masterRows.length === 0) {
      return json({ enriched: 0, remaining: 0, refreshed: 0, refresh_pending: refreshTotal, master_pending: masterTotal });
    }
```

**2c.** After the new+refresh `for` loop completes (after ~line 216, before `const remaining = …`), add the
master-backfill pass on leftover budget. It dedupes by master_id, paces every Discogs call, and writes
siblings:
```ts
  // ── Master-year backfill (Wave 5a). Lowest priority: only leftover budget, never holds the boot gate
  //    (master rows are already enriched; they are absent from totalPending/remaining). One GET per DISTINCT
  //    master; the UPDATE fills every sibling pressing, so the null-count collapses far faster than 1 row/call.
  let masterFilled = 0;                                   // sibling ROWS filled this run (drives master_pending)
  if (!rateLimited) {
    const leftover = BUDGET - batch.length;               // budget not spent on new/refresh
    const seen = new Set<number>();
    const distinct: number[] = [];
    for (const m of masterRows) { if (m.master_id && !seen.has(m.master_id)) { seen.add(m.master_id); distinct.push(m.master_id); } }
    for (let j = 0; j < distinct.length && j < leftover; j++) {
      const mid = distinct[j];
      await sleep(GAP_MS);                                // pace EVERY master GET (they count toward 60/min)
      const mres = await fetch(`https://api.discogs.com/masters/${mid}`, {
        headers: { 'User-Agent': DISCOGS_UA, Authorization: oauthHeader({
          oauth_consumer_key: consumerKey, oauth_nonce: nonce(), oauth_token: userToken,
          oauth_signature: `${consumerSecret}&${userSecret}`, oauth_signature_method: 'PLAINTEXT',
          oauth_timestamp: timestamp() }) },
      });
      if (mres.status === 429) { rateLimited = true; break; }          // stop; client waits 30s
      let my = 0;                                                       // 0 = resolved, no usable year (sentinel)
      if (mres.status === 404) { my = 0; }                              // master gone → sentinel, exits pending
      else if (!mres.ok) { continue; }                                  // transient → leave null, retry later
      else { try { const mj = JSON.parse(await mres.text()); const y = Number(mj.year);
             my = (Number.isFinite(y) && y > 1900) ? y : 0; } catch { continue; } }
      const { data: upd, error: mErr } = await admin.from('releases')
        .update({ master_year: my }).eq('master_id', mid).is('master_year', null).select('release_id');
      if (mErr) { console.error('master_year update failed:', mid, mErr.message); continue; }
      masterFilled += Array.isArray(upd) ? upd.length : 0;
    }
  }
```

**2d.** The final response (~line 224) adds `master_pending`. **VERIFICATION-PASS FIX (defect 2):** report the
RPC's freshly-recomputed owned-null count `masterTotal` directly — do NOT subtract `masterFilled`. `masterFilled`
counts catalog-wide sibling rows (owned + non-owned, since the UPDATE is `.eq('master_id',mid)` over the shared
catalog), while `masterTotal` counts owned-null only; subtracting the two can clamp `master_pending` to 0 while
owned rows for un-fetched masters are still null, and boot.js's `if(work===0) break` would then STRAND the
backfill. Letting the RPC recount each call makes the signal monotonic and only-zero-when-truly-done (at most
one harmless tail loop). `masterFilled` stays as a console/log figure only.
```ts
  return json({ enriched, remaining, refreshed,
    refresh_pending: Math.max(0, refreshTotal - refreshed),
    master_pending: masterTotal,   // RPC recount; NOT masterTotal - masterFilled (defect 2)
    rate_limited: rateLimited });
```
Rate-limit posture unchanged: master GETs are paced `GAP_MS`; a 429 sets `rateLimited` and breaks; the client
already waits 30s on `rate_limited`. `.is('master_year', null)` on the UPDATE means a sibling already filled by
an earlier run is never rewritten (idempotent, and `masterFilled` counts only real fills).

**Deploy:** `deploy_edge_function` (break-glass). Config unchanged (`verify_jwt=false`, existing secrets;
the master GET reuses the already-decrypted per-user OAuth creds — no new secret).

---

## Task 3 — client projection + drain signal (`public/boot.js`)

**3a.** Own-crate read SELECT (~line 202) — add `master_year` to the embedded `releases(...)`:
```js
    .select('release_id, added, rating, vinyl, ' +
      'releases ( artist, title, year, label, styles, genres, thumb, cover_image, master_year )')
```
**3b.** Own-crate mapping (~line 209-216) — add `releaseYear`, master-year-first with a graceful pressing-year
fallback (covers null = not-yet-resolved AND 0 = sentinel):
```js
      releaseYear: (rel.master_year && rel.master_year > 0) ? rel.master_year : (rel.year || 0),
```
**3c.** Drain stop-condition (~line 603) — keep the background drain running until master backfill is also
done:
```js
        const work = d.remaining + (d.refresh_pending || 0) + (d.master_pending || 0);
```
**Not touched:** the own WANTLIST read (`TraxWaxWantlistData`) and the friend/other-crate reads — the DNA card
is own-crate + collection-only, so `releaseYear` is only needed on the own collection read. (Parity noted as
out-of-scope; a future friend/wantlist DNA card would add it there.)

`node --check public/boot.js` after.

---

## Task 4 — backfill execution + monitoring (no code; ops)

After 0032 + enrich-release + boot.js ship, Lane opens the app. `backgroundEnrich` drains master_year
(deduped). **Monitor to completion** via the read-only connector:
```sql
select count(*) as pending_masters
  from public.releases r
  join public.collection_items ci on ci.release_id = r.release_id
 where ci.user_id = '<lane user_id>'
   and r.master_id is not null and r.master_id <> 0 and r.master_year is null;
```
Poll until `0`. Spot-check a known reissue reads its original decade:
```sql
select release_id, year as pressing, master_year, artist, title from public.releases
 where master_year is not null and master_year <> year order by random() limit 10;
```
Expect rows where `master_year < year` (e.g. an 80s album pressed in the 2020s). Then confirm Card A's peak
decade shifts off "2020s" for Lane's crate.

Rate math: ~1,861 records collapse to the distinct-master count (each master fetched once, siblings written
together). At ≤54 GET/min sustained (1.1s pacing) that's ~25–45 min of continuous app-open draining, with the
occasional 30s rate-limit pause. Hands-off; no action beyond leaving the tab open.

---

## Task 5 — the DNA-card frontend (Design's `wave-5a-write-plan.md`)
Built per Design's plan (dna.js stats+renderer, app.js share buttons + DNA band + picker + export,
styles.css mobile, `_headers` adds `/dna.js`). `computeStats` reads `r.releaseYear ?? r.year`; with 3b above,
`releaseYear` is always populated (master-or-pressing), so Card A is correct once the backfill lands. Build
corrections already noted vs Design's plan: picker card-B/C blurbs use the SPEC §4 text (B "Four anchors and
your top three styles. The ledger read."; C "…two supporting facts."); verify `dna.js` `isColored()` matches
`app.js` exactly (a parity check on the colored count).

---

## Verification / tests
1. `node --check` on boot.js + app.js + `deno check` (or lint) intent on enrich-release (can't run Deno
   locally in the sandbox; rely on the connector's deploy validation + a careful read).
2. Post-apply SQL checks (Task 1) + backfill monitor (Task 4).
3. After a partial drain, confirm the response carries `master_pending` decreasing and the drain keeps looping
   past `remaining===0 && refresh_pending===0`.
4. remediation-audit (Pass-1 + narrow Pass-2) over the 0032 + enrich-release + boot.js diff before commit —
   attack: the sentinel-0 vs null semantics (no wedge, no rewrite), the dedupe/sibling-write correctness, the
   `.is('master_year', null)` idempotency, the drain never holding the boot gate, the pace/429 posture, and
   `releaseYear` fallback (0 sentinel → pressing year, never a 0-year record in the histogram).

## Release packaging (Lane's call)
- **One release (recommended):** backend + Design's frontend together; Card A self-heals to master-year within
  ~40 min of app-open time post-deploy. Simplest.
- **Two releases:** this backend precursor first (version bump, no visible change), drain to completion (I
  verify pending_masters=0), then the DNA-card frontend on a fully-backfilled column. Honors "data first"
  literally; costs a second release + a scoped `git add` (backend touches boot.js + supabase/**, holding
  app.js's uncommitted URL mechanism for release 2).

## Out of scope / parked
- `get_friend_crate` / wantlist `master_year` projection — own-collection card only for 5a.
- Forward-path master GET inside import/enrich — deliberately avoided (would double import Discogs calls);
  master_year is a separate deduped drain.
- `profiles.dna_variant` cross-device pick (Design D2: localStorage for 5a).
