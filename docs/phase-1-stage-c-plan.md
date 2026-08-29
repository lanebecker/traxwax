# TraxWax Phase 1 Stage C — Import & enrich (implementation plan)

Parent: `docs/phase-1-plan.md` (Stage A and Stage B **complete and verified**, 2026-08-28).
Design: `docs/multi-user-spec.md` §5, §6, §7, §8. Predecessor: `docs/phase-1-stage-b-plan.md`.

**Revision 3** (2026-08-28). Rev 1 was audited by an independent no-context agent before
execution: **2 CRITICALs** (the PostgREST 1,000-row cap silently truncating the enrichment
scan; an interrupted enrichment being permanently unrecoverable), 4 MAJORs, 10 minors. Rev 2
fixed those — and a **narrow second pass over the rework itself** then found 2 fresh MAJORs
*introduced by the fixes* (a zero-tolerance edge-vs-DB clock check that could hard-kill the
import, and an `error` state whose documented recovery was a no-op). All folded in below;
both rounds are documented in the **Audit record** at the end.

**Definition of done:** a signed-in, Discogs-connected user landing on their crate URL sees
an import progress screen that pulls their entire Discogs collection into
`collection_items` under **their own OAuth token**, seeds any unknown releases into the
shared CC0 `releases` catalog, enriches those releases with tracklists, and then falls
through to the existing render path. Concretely for Lane: ~1,861 `collection_items` rows,
`releases` grows to cover all ~1,859 distinct owned release ids with **zero null
tracklists**, `profiles.last_import_at` set, `import_status` back to `idle`, re-running the
import is a no-op, and traxwax.com production is untouched.

---

## Decisions locked (2026-08-28, with Lane)

| Decision | Choice |
|---|---|
| Import trigger | **Auto-start**: connect flows straight into import (spec §4); progress UI, no extra click |
| Read path | **Unchanged in Stage C.** The crate still renders baked `collection.json`; the flip to Supabase is Stage D. The `BAKED_CRATE_OWNER` guard stays. |
| User-facing re-sync | **Deferred to Stage D.** The machinery is idempotent and re-runnable operationally (clear `last_import_at`), but no button ships now. |

## Confirmed facts (measured, not assumed)

**From `build/refresh_collection.py`, which walks this exact endpoint in production weekly:**

- Endpoint: `GET https://api.discogs.com/users/<username>/collection/folders/0/releases?page=N&per_page=100`
  (folder `0` = "All"). Response: `{ pagination: { pages, items, ... }, releases: [...] }`.
- Per entry: `r.id` is the **release id**, `r.date_added` is ISO (first 10 chars = date),
  `r.rating` is the user's personal 0–5, `r.basic_information` (`bi`) carries the CC0 seed
  fields. Production mapping, ported including **`clean()`**: artist = joined
  `bi.artists[].name` **with the Discogs disambiguation suffix stripped** ("Prince (2)" →
  "Prince" — omitting this was rev 1's M-1; the 1,851 backfilled rows are suffix-free, so a
  seed without the strip would fracture artist grouping); title = `bi.title` trimmed; year =
  `bi.year`; label = `bi.labels[0].name`; styles/genres = arrays; vinyl variant =
  `bi.formats[0].text`; `bi.thumb` / `bi.cover_image` = image URLs. Empty-string fallbacks
  (not null) for `label`/`thumb`/`cover_image`/`vinyl`, and rating **0 stays 0** — matching
  the backfilled rows byte-for-byte so Stage D renders old and new identically.
- **`instance_id` and `folder_id` are NOT captured by the production script** (it dedupes to
  one row per release). They are documented fields of each collection entry (`r.instance_id`,
  `r.folder_id`) and `instance_id` was observed in this project's Discogs MCP output, but
  this plan has not re-measured them on the live endpoint. Task C7 step 3 verifies them on
  page 1 **before the full run**, and the code treats a missing `instance_id` as a hard error
  rather than silently importing null instance keys.

**From the deployed data + Supabase (measured 2026-08-28):**

- `collection.json` holds **1,861 items across 1,859 distinct release ids** (two owned
  twice); `public.releases` holds **1,851 fully-enriched rows** → the import must seed **8**
  new releases and enrich exactly those 8. (Numbers may drift by a few if records were added
  on Discogs since; treat as ≥, not =.)
- `releases.tracks` in the DB (backfilled from the deployed `releases/*.json`) uses the shape
  `[{pos, title, dur}]`, headings excluded; `videos` is `[{title, uri}]` capped at 3;
  `released` prefers `released_formatted`. Enrichment MUST write these exact shapes or
  Stage D's modal renders inconsistently across old and new rows.
- **`releases.enriched_at` is `not null default now()`** — a seeded-but-unenriched row gets a
  timestamp anyway. Enrichment detection therefore keys on **`tracks is null`**, never on
  `enriched_at`.
- **Hosted PostgREST returns at most 1,000 rows per request, silently** (`db-max-rows`).
  Any unbounded `.select()` over `collection_items` is therefore wrong by construction for
  a >1,000-item collection — rev 1's C-1. Every read in this plan is either paginated with
  `.range()` or bounded by construction.
- `collection_items` exists with `unique (user_id, instance_id)`, owner-only RLS, and **no
  `updated_at` column** (Task C1 adds it — re-import cleanup needs a watermark).
- `profiles.import_status` allows only `idle | running | error` — there is **no `done`**.
  "Done" = `idle` **with `last_import_at` set — and `last_import_at` is set by the
  enrichment phase, not the import phase** (rev 1's C-2: setting it on the final import page
  made an interrupted enrichment permanently unrecoverable, since the boot gate would never
  re-enter). The gate re-runs the whole idempotent pipeline until enrichment reports zero
  remaining.
- Stage B proved live: PLAINTEXT-signed authenticated GETs work (`/oauth/identity` succeeded
  in the real flow), the JWKS verification pattern works, and `_shared/discogs.ts`'s
  `decrypt()` round-trips (selfTest runs on every callback invocation).

**Discogs rate limit:** 60 req/min per authenticated token (spec §7). Lane's run is 19 page
requests + 8 enrichment requests — inside one minute's budget. The enrichment loop paces
**every** request (success or failure — rev 1 paced only successes) and the frontend backs
off on a reported rate-limit, so a large new user drains safely.

---

## Architecture decisions

**Client-driven, chunked, stateless import.** One `import-collection` invocation processes
exactly one Discogs page (≤100 items) and returns `{page, pages, items, done, started_at}`;
the frontend loops `page = 1..pages`. Why not one long invocation: Edge Functions have
wall-clock limits a large collection would breach, a mid-run failure would restart from zero,
and the loop gives the progress UI real numbers for free. The server keeps **no cursor
state** — idempotent upserts make repeated or concurrent calls harmless (worst case: the same
page is written twice, identically).

**Identity: exactly the Stage B pattern.** `jwtVerify` against Clerk's JWKS (issuer + `azp`
checked), `verify_jwt: false` at the platform gate, nothing else may derive a user id. The
import can only ever touch the **caller's** rows: `user_id` comes from the verified `sub`,
the Discogs token is decrypted from *that* user's `discogs_credentials` row, and every write
is scoped to it.

**Re-import cleanup via watermark — DB-clocked, tamper-bounded.** Every
`collection_items` write is stamped `updated_at = now()` **by a database trigger** (not the
edge instance's clock: page 1 and page 12 can run on different edge instances, and clock
skew could mark fresh rows older than the watermark — rev 1 minor 2). The page-1 invocation
mints `started_at` from the **same database clock** (`db_now()` RPC) and returns it; the
client echoes it on later calls; the final page deletes the caller's rows with
`updated_at < started_at` — removing records deleted on Discogs since the last import. The
client can lie about `started_at`, so the server **rejects** (not clamps) anything outside
`[now − 24h, now]`, and the blast radius of a lie is **the caller's own rows only** — which
RLS already lets them delete directly, so nothing new is exposed.

**Import completes in two phases; only the second closes the gate.** The final import page
sets `import_status = 'idle'` but **not** `last_import_at`. `enrich-release` sets
`last_import_at` when it computes `remaining === 0`. Consequence: an interruption anywhere —
mid-import or mid-enrichment — leaves `last_import_at` null, and the next page load re-runs
the whole pipeline idempotently (already-imported pages are cheap upserts;
already-enriched releases drop out of the pending query). A user could call `enrich-release`
directly to mark their own import "done" early — but their profile row is their own under
RLS anyway, so this grants nothing new.

**Catalog seeding is free; enrichment is budgeted and cannot wedge.** The collection pages
already carry every CC0 column except `tracks/country/released/videos`, so the import seeds
unknown `releases` rows from `basic_information` at zero extra API cost — with
`ignoreDuplicates: true` so an existing enriched row is **never clobbered back to a seed**.
`enrich-release` then fills the four missing fields via `get_release`: at most **5 releases
per invocation, with a 1.1 s gap before every request after the first, success or failure**;
a 429 stops the batch and is reported as `rate_limited` so the frontend waits 30 s; a **404
writes `tracks: []`** (the release is gone from Discogs — an honest empty tracklist, and it
exits the pending set rather than wedging it forever); other failures stay pending and the
frontend stops after three consecutive no-progress calls instead of spinning.

**Restricted-data compliance (spec §8):** *which releases a user owns* is Restricted → it
lands only in `collection_items` (owner-only RLS), fetched under the user's own token, as a
working store. The shared `releases` writes are CC0 fields only — the enrichment mapping
deliberately drops `community`, `lowest_price`, have/want, and does not even request price
currency conversion (`curr_abbr` is gone — rev 1 minor 5).

**Failure posture.** A failed page fetch returns an error code; the frontend retries with
backoff (skipping retries on non-retryable 4xx) and, if it gives up, `last_import_at` is
still null — so the next load resumes automatically. `import_status = 'error'` is reserved
for non-retryable states (stored credentials unreadable) and the frontend renders a distinct
dead-end for it instead of hammering the function on every load (rev 1's M-3).

---

## Task C1 — Migration 0004: watermark column, trigger, DB clock, and the error-state exit

Create **`supabase/migrations/0004_stage_c_import.sql`**:

```sql
-- 0004_stage_c_import.sql — Phase 1 Stage C
--
-- Re-import cleanup needs to distinguish rows touched by the CURRENT import from rows a
-- previous import wrote for records since deleted on Discogs. The watermark comparison must
-- use ONE clock: a trigger stamps every insert/update with the database's now(), and the
-- import mints its started_at from the same clock via db_now(). Edge-instance clocks are
-- deliberately not trusted -- different pages of one import can run on different instances.

alter table public.collection_items
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists collection_items_touch on public.collection_items;
create trigger collection_items_touch
  before insert or update on public.collection_items
  for each row execute function public.touch_updated_at();

-- The import's watermark source. service_role only, same posture as link_discogs_account.
create or replace function public.db_now() returns timestamptz
language sql stable as $$ select now() $$;

revoke all on function public.db_now() from public, anon, authenticated;
grant execute on function public.db_now() to service_role;

-- Round-2 audit MAJOR-2: import_status='error' (stored credentials unreadable) previously
-- had NO exit -- reconnecting via the OAuth flow wrote new credentials but left the error
-- flag, so the boot path dead-ended forever. A successful re-link is exactly the event
-- that invalidates the error state, so the link RPC now clears it. Same body as migration
-- 0003 otherwise; create-or-replace keeps grants (execute stays service_role-only).
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
begin
  update public.profiles
     set discogs_username     = p_username,
         discogs_connected_at = now(),
         import_status        = 'idle'
   where user_id = p_user_id;

  if not found then
    raise exception 'no profile for user_id %', p_user_id
      using errcode = 'P0002';   -- no_data_found
  end if;

  insert into public.discogs_credentials (user_id, oauth_token, oauth_token_secret)
       values (p_user_id, p_token_enc, p_secret_enc)
  on conflict (user_id) do update
          set oauth_token        = excluded.oauth_token,
              oauth_token_secret = excluded.oauth_token_secret;
end;
$$;
```

Apply with the TraxWax MCP connector (`apply_migration`, name `0004_stage_c_import`).

**Verify:**

```sql
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='collection_items'
      and column_name='updated_at')                             as col,
  (select count(*) from pg_trigger
    where tgname='collection_items_touch' and not tgisinternal) as trg,
  has_function_privilege('anon',         'public.db_now()', 'execute') as anon_can,
  has_function_privilege('service_role', 'public.db_now()', 'execute') as svc_can;
```
**Expected:** `1 | 1 | false | true`.

## Task C2 — Deploy `import-collection`

Create **`supabase/functions/import-collection/index.ts`**:

```ts
/* Stage C: chunked collection import. One invocation = one Discogs page (<=100 items).
 * The frontend drives page 1..pages; the server keeps no cursor state.
 *
 * Identity: Stage B pattern exactly. verify_jwt is FALSE at the platform gate (it cannot
 * validate Clerk RS256); jwtVerify below is the ONLY source of user id. Every row this
 * function reads or writes is scoped to that verified user.
 *
 * The final page sets import_status='idle' but NOT last_import_at -- enrich-release owns
 * that, so an interruption anywhere in the two-phase pipeline resumes on next load. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';
import { DISCOGS_UA, oauthHeader, nonce, timestamp, decrypt }
  from '../_shared/discogs.ts';

const CLERK_ISSUER = 'https://brave-buffalo-7127.clerk.accounts.dev';
const APP_ORIGIN   = 'https://multi-user.traxwax.pages.dev';

const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));

const CORS = {
  'Access-Control-Allow-Origin': APP_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/** Discogs disambiguation suffix: "Prince (2)" -> "Prince". Port of clean() in
    build/refresh_collection.py -- the 1,851 backfilled rows are suffix-free, and the
    shared catalog must stay consistent. */
function cleanName(s: string): string {
  return s.replace(/\s*\(\d+\)\s*$/, '').trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    return await handle(req);
  } catch (e) {
    console.error('unexpected:', (e as Error).message);
    return json({ error: 'unexpected' }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  // ── Identity first (before config/body), same ordering rationale as Stage B ──
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'missing_token' }, 401);
  let userId: string;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: CLERK_ISSUER });
    if (!payload.sub) throw new Error('no sub claim');
    if (payload.azp && payload.azp !== APP_ORIGIN) throw new Error('azp mismatch');
    userId = payload.sub;
  } catch (e) {
    console.error('clerk token rejected:', (e as Error).message);
    return json({ error: 'invalid_token' }, 401);
  }

  const consumerKey = Deno.env.get('DISCOGS_CONSUMER_KEY');
  const consumerSecret = Deno.env.get('DISCOGS_CONSUMER_SECRET');
  const encKey = Deno.env.get('DISCOGS_TOKEN_ENC_KEY');
  if (!consumerKey || !consumerSecret || !encKey) return json({ error: 'not_configured' }, 500);

  // ── Input: { page, started_at? } ─────────────────────────────────────────────
  let body: { page?: unknown; started_at?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const page = Number(body.page);
  // 500-page cap = 50,000 items. A collection beyond it cannot finish and would loop;
  // acceptable at launch scale, revisit if a real user ever approaches it.
  if (!Number.isInteger(page) || page < 1 || page > 500) {
    return json({ error: 'bad_request' }, 400);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── The caller's own credentials + username ─────────────────────────────────
  const { data: prof } = await admin.from('profiles')
    .select('discogs_username').eq('user_id', userId).maybeSingle();
  const { data: cred } = await admin.from('discogs_credentials')
    .select('oauth_token, oauth_token_secret').eq('user_id', userId).maybeSingle();
  if (!prof?.discogs_username || !cred) return json({ error: 'not_connected' }, 409);

  let userToken: string, userSecret: string;
  try {
    userToken = await decrypt(cred.oauth_token, encKey);
    userSecret = await decrypt(cred.oauth_token_secret, encKey);
  } catch (e) {
    // Non-retryable: the stored credential is unreadable. Surface as error state; the
    // frontend renders a dead-end for import_status='error' instead of retrying.
    console.error('credential decrypt failed:', (e as Error).message);
    await admin.from('profiles').update({ import_status: 'error' }).eq('user_id', userId);
    return json({ error: 'credentials_unreadable' }, 500);
  }

  // ── Watermark: minted from the DATABASE clock on page 1 (same clock the trigger
  //    stamps rows with); rejected -- not clamped -- when an echo is out of range. ──
  let startedAt: string;
  if (page === 1) {
    const { data: dbNow, error: nowErr } = await admin.rpc('db_now');
    if (nowErr || !dbNow) {
      console.error('db_now failed:', nowErr?.message);
      return json({ error: 'store_failed' }, 500);
    }
    startedAt = dbNow as string;
    const { error: runErr } = await admin.from('profiles')
      .update({ import_status: 'running' }).eq('user_id', userId);
    if (runErr) {
      console.error('running-state update failed:', runErr.message);
      return json({ error: 'store_failed' }, 500);
    }
  } else {
    const s = typeof body.started_at === 'string' ? Date.parse(body.started_at) : NaN;
    const ageMs = Date.now() - s;
    // Round-2 audit MAJOR-1: this validation runs on a DIFFERENT edge instance than the
    // one that minted started_at from the DB clock, so a zero-tolerance `ageMs < 0` could
    // hard-fail a legitimate page-2 when this instance's clock trails the DB by more than
    // the inter-page gap. Tolerate 5 minutes of future skew: a slightly-future watermark
    // still cannot delete fresh rows -- the sweep is strict lt() against trigger stamps
    // that are >= the true db_now.
    if (Number.isNaN(s) || ageMs < -5 * 60 * 1000 || ageMs > 24 * 3600 * 1000) {
      return json({ error: 'bad_request' }, 400);
    }
    // NOTE: Date.parse truncates Postgres microseconds DOWN to milliseconds, so this
    // re-serialized watermark is up to 999us EARLIER than page 1's raw string. That is
    // the conservative direction for a strict-lt delete (spares, never deletes). Do not
    // "fix" this by rounding up.
    startedAt = new Date(s).toISOString();
  }

  // ── One collection page, under the CALLER's token. PLAINTEXT does not sign the
  //    URL, so query parameters need no signature treatment. NOTE on sort: desc-by-added
  //    means a DELETION on Discogs mid-import shifts later pages up and can skip one item,
  //    which the final sweep then removes until the next re-import. Rare and self-limiting;
  //    accepted. Additions mid-import are safe (they land on page 1 of the NEXT run). ──
  const pageUrl = `https://api.discogs.com/users/${encodeURIComponent(prof.discogs_username)}` +
    `/collection/folders/0/releases?page=${page}&per_page=100&sort=added&sort_order=desc`;
  const res = await fetch(pageUrl, {
    headers: {
      'User-Agent': DISCOGS_UA,
      Authorization: oauthHeader({
        oauth_consumer_key: consumerKey,
        oauth_nonce: nonce(),
        oauth_token: userToken,
        oauth_signature: `${consumerSecret}&${userSecret}`,
        oauth_signature_method: 'PLAINTEXT',
        oauth_timestamp: timestamp(),
      }),
    },
  });
  if (!res.ok) {
    console.error('collection page failed, status', res.status);
    return json({ error: 'discogs_failed', status: res.status }, 502);
  }
  let d: {
    pagination?: { pages?: number; items?: number };
    releases?: Array<Record<string, unknown>>;
  };
  try { d = JSON.parse(await res.text()); }
  catch { console.error('collection page non-JSON body'); return json({ error: 'discogs_failed' }, 502); }

  const pages = Number(d.pagination?.pages ?? 1);
  const totalItems = Number(d.pagination?.items ?? 0);
  const entries = Array.isArray(d.releases) ? d.releases : [];

  // ── Map rows. A missing instance_id is a HARD error: silently importing null
  //    instance keys would collapse rows into one under the unique constraint. ──
  type Bi = {
    id?: number; title?: string; year?: number;
    artists?: Array<{ name?: string }>; labels?: Array<{ name?: string }>;
    styles?: string[]; genres?: string[]; formats?: Array<{ text?: string }>;
    thumb?: string; cover_image?: string;
  };
  const items: Array<Record<string, unknown>> = [];
  const seeds = new Map<number, Record<string, unknown>>();
  for (const r of entries) {
    const bi = (r.basic_information ?? {}) as Bi;
    const releaseId = Number(r.id ?? bi.id);
    const instanceId = Number(r.instance_id);
    if (!Number.isInteger(instanceId) || !Number.isInteger(releaseId)) {
      console.error('entry missing instance_id/release id; field names:',
        Object.keys(r as object).join(','));
      return json({ error: 'unexpected_shape' }, 502);
    }
    // Field defaults mirror build/refresh_collection.py exactly: '' not null for the
    // string fields, and rating 0 stays 0 -- so backfilled and imported rows are
    // indistinguishable to Stage D. updated_at is ABSENT: the trigger stamps it.
    items.push({
      user_id: userId,
      release_id: releaseId,
      instance_id: instanceId,
      folder: r.folder_id != null ? String(r.folder_id) : '',
      rating: Number(r.rating ?? 0) || 0,
      added: typeof r.date_added === 'string' ? r.date_added.slice(0, 10) : null,
      vinyl: bi.formats?.[0]?.text ?? '',
    });
    if (!seeds.has(releaseId)) {
      seeds.set(releaseId, {
        release_id: releaseId,
        artist: (bi.artists ?? []).map((a) => cleanName(a.name ?? '')).filter(Boolean).join(', '),
        title: (bi.title ?? '').trim(),
        year: bi.year ?? 0,
        label: bi.labels?.[0]?.name ?? '',
        styles: bi.styles ?? [],
        genres: bi.genres ?? [],
        thumb: bi.thumb ?? '',
        cover_image: bi.cover_image ?? '',
        // tracks/country/released/videos deliberately absent: seeds have tracks = null,
        // which is exactly what enrich-release keys on.
      });
    }
  }

  if (items.length > 0) {
    const { error: itemErr } = await admin.from('collection_items')
      .upsert(items, { onConflict: 'user_id,instance_id' });
    if (itemErr) {
      console.error('collection upsert failed:', itemErr.message);
      return json({ error: 'store_failed' }, 500);
    }
    // ignoreDuplicates: an already-enriched (or already-seeded) release row is NEVER
    // overwritten -- seeding must not regress tracks back to null.
    const { error: seedErr } = await admin.from('releases')
      .upsert([...seeds.values()], { onConflict: 'release_id', ignoreDuplicates: true });
    if (seedErr) {
      console.error('release seed failed:', seedErr.message);
      return json({ error: 'store_failed' }, 500);
    }
  }

  // ── Final page: sweep stale rows, then idle. last_import_at is NOT set here --
  //    enrich-release owns it, so an interrupted enrichment resumes on next load. ──
  const done = page >= pages;
  if (done) {
    const { error: sweepErr } = await admin.from('collection_items')
      .delete().eq('user_id', userId).lt('updated_at', startedAt);
    if (sweepErr) console.error('stale sweep failed:', sweepErr.message);
    const { error: idleErr } = await admin.from('profiles')
      .update({ import_status: 'idle' }).eq('user_id', userId);
    if (idleErr) console.error('idle-state update failed:', idleErr.message);
    // Both failures are log-only: last_import_at is still null, so the pipeline re-runs
    // idempotently on next load and gets another chance.
  }

  return json({ page, pages, items: totalItems, started_at: startedAt, done });
}
```

**Deploy** with `deploy_edge_function`:

- `name`: `import-collection` · `entrypoint_path`: `import-collection/index.ts` ·
  `verify_jwt`: **`false`**
- `files`: `import-collection/index.ts` (above) **and** `_shared/discogs.ts` (the existing
  repo file, byte-for-byte — it is uploaded per-function; redeploy all four functions if it
  ever changes).

## Task C3 — Deploy `enrich-release`

Create **`supabase/functions/enrich-release/index.ts`**:

```ts
/* Stage C: budgeted CC0 enrichment. Fills tracks/country/released/videos for releases the
 * CALLER owns that are still un-enriched (tracks is null), at most BUDGET per invocation,
 * paced 1.1s before EVERY request after the first (success or failure) -- the caller's own
 * token pays, and must stay under 60/min even on all-failure batches.
 *
 * Sets profiles.last_import_at when remaining reaches 0: that is what closes the boot
 * gate, so an interrupted enrichment re-runs on next load (see the Stage C plan).
 *
 * Writes ONLY CC0 catalog fields. community/have/want/lowest_price are Restricted Data and
 * are deliberately never requested nor stored (spec section 8). */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';
import { DISCOGS_UA, oauthHeader, nonce, timestamp, decrypt }
  from '../_shared/discogs.ts';

const CLERK_ISSUER = 'https://brave-buffalo-7127.clerk.accounts.dev';
const APP_ORIGIN   = 'https://multi-user.traxwax.pages.dev';
const BUDGET = 5;
const GAP_MS = 1100;

const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));

const CORS = {
  'Access-Control-Allow-Origin': APP_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    return await handle(req);
  } catch (e) {
    console.error('unexpected:', (e as Error).message);
    return json({ error: 'unexpected' }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'missing_token' }, 401);
  let userId: string;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: CLERK_ISSUER });
    if (!payload.sub) throw new Error('no sub claim');
    if (payload.azp && payload.azp !== APP_ORIGIN) throw new Error('azp mismatch');
    userId = payload.sub;
  } catch (e) {
    console.error('clerk token rejected:', (e as Error).message);
    return json({ error: 'invalid_token' }, 401);
  }

  const consumerKey = Deno.env.get('DISCOGS_CONSUMER_KEY');
  const consumerSecret = Deno.env.get('DISCOGS_CONSUMER_SECRET');
  const encKey = Deno.env.get('DISCOGS_TOKEN_ENC_KEY');
  if (!consumerKey || !consumerSecret || !encKey) return json({ error: 'not_configured' }, 500);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: cred } = await admin.from('discogs_credentials')
    .select('oauth_token, oauth_token_secret').eq('user_id', userId).maybeSingle();
  if (!cred) return json({ error: 'not_connected' }, 409);
  let userToken: string, userSecret: string;
  try {
    userToken = await decrypt(cred.oauth_token, encKey);
    userSecret = await decrypt(cred.oauth_token_secret, encKey);
  } catch (e) {
    // Same non-retryable posture as import-collection (round-2 audit minor 2).
    console.error('credential decrypt failed:', (e as Error).message);
    await admin.from('profiles').update({ import_status: 'error' }).eq('user_id', userId);
    return json({ error: 'credentials_unreadable' }, 500);
  }

  // ── The caller's owned release ids, PAGINATED. PostgREST silently caps any single
  //    select at 1,000 rows (measured fact above; rev 1's C-1) -- an unbounded select
  //    here would silently ignore ~half of a 1,861-item collection. ──────────────
  const owned = new Set<number>();
  for (let from = 0; ; from += 1000) {
    const { data: rows, error: idErr } = await admin.from('collection_items')
      .select('release_id').eq('user_id', userId)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (idErr) { console.error('own-ids query failed:', idErr.message); return json({ error: 'store_failed' }, 500); }
    for (const row of rows ?? []) owned.add(row.release_id as number);
    if (!rows || rows.length < 1000) break;
  }
  if (owned.size === 0) {
    // A legitimately empty collection is a completed import. Close the gate.
    const { error: emptyErr } = await admin.from('profiles')
      .update({ last_import_at: new Date().toISOString() }).eq('user_id', userId);
    if (emptyErr) console.error('last_import_at (empty) failed:', emptyErr.message);
    return json({ enriched: 0, remaining: 0 });
  }

  // ── Which of those are still un-enriched. tracks IS NULL is the flag: enriched_at is
  //    NOT NULL DEFAULT now(), stamped even on seed rows, and cannot be used. The
  //    IN-list is chunked at 200 ids to stay under URL length limits; each chunk's
  //    result is bounded by the chunk size, so the row cap cannot bite here. ──────
  const ownedArr = [...owned];
  const pending: number[] = [];
  for (let i = 0; i < ownedArr.length; i += 200) {
    const chunk = ownedArr.slice(i, i + 200);
    const { data: rows, error: pErr } = await admin.from('releases')
      .select('release_id').in('release_id', chunk).is('tracks', null);
    if (pErr) { console.error('pending query failed:', pErr.message); return json({ error: 'store_failed' }, 500); }
    for (const row of rows ?? []) pending.push(row.release_id as number);
  }
  if (pending.length === 0) {
    const { error: noneErr } = await admin.from('profiles')
      .update({ last_import_at: new Date().toISOString() }).eq('user_id', userId);
    if (noneErr) console.error('last_import_at (none-pending) failed:', noneErr.message);
    return json({ enriched: 0, remaining: 0 });
  }

  let enriched = 0;
  let rateLimited = false;
  const batch = pending.slice(0, BUDGET);
  for (let i = 0; i < batch.length; i++) {
    const rid = batch[i];
    // Pace EVERY request after the first -- including after failures. Pacing only
    // successes (rev 1's M-2) let an all-404 batch fire 5 requests back-to-back.
    if (i > 0) await sleep(GAP_MS);
    const res = await fetch(`https://api.discogs.com/releases/${rid}`, {
      headers: {
        'User-Agent': DISCOGS_UA,
        Authorization: oauthHeader({
          oauth_consumer_key: consumerKey,
          oauth_nonce: nonce(),
          oauth_token: userToken,
          oauth_signature: `${consumerSecret}&${userSecret}`,
          oauth_signature_method: 'PLAINTEXT',
          oauth_timestamp: timestamp(),
        }),
      },
    });
    if (res.status === 429) {
      console.error('rate limited at release', rid);
      rateLimited = true;
      break;   // report it; the frontend waits 30s before the next invocation
    }
    if (res.status === 404) {
      // Deleted/inaccessible on Discogs. An honest empty tracklist exits the pending
      // set -- otherwise this release wedges the queue forever (rev 1's M-2d).
      const { error: goneErr } = await admin.from('releases').update({
        tracks: [], country: '', released: '', videos: [],
        enriched_at: new Date().toISOString(),
      }).eq('release_id', rid);
      if (goneErr) console.error('404 tombstone failed:', rid, goneErr.message);
      else enriched++;
      continue;
    }
    if (!res.ok) {
      console.error('get_release failed:', rid, res.status);
      continue; // stays pending; the frontend's no-progress guard stops the loop
    }
    let rel: Record<string, unknown>;
    try { rel = JSON.parse(await res.text()); }
    catch { console.error('get_release non-JSON:', rid); continue; }

    // EXACTLY the deployed shape: [{pos,title,dur}] minus headings; videos capped at 3;
    // released prefers released_formatted. Matches build/refresh_collection.py.
    const tracklist = (Array.isArray(rel.tracklist) ? rel.tracklist : [])
      .filter((t: Record<string, unknown>) => t.type_ !== 'heading')
      .map((t: Record<string, unknown>) => ({
        pos: (t.position as string) ?? '',
        title: (t.title as string) ?? '',
        dur: (t.duration as string) ?? '',
      }));
    const videos = (Array.isArray(rel.videos) ? rel.videos : []).slice(0, 3)
      .map((v: Record<string, unknown>) => ({
        title: (v.title as string) ?? '',
        uri: (v.uri as string) ?? '',
      }));

    const { error: upErr } = await admin.from('releases').update({
      tracks: tracklist,
      country: (rel.country as string) ?? '',
      released: (rel.released_formatted as string) || (rel.released as string) || '',
      videos,
      enriched_at: new Date().toISOString(),
    }).eq('release_id', rid);
    if (upErr) { console.error('enrich update failed:', rid, upErr.message); continue; }
    enriched++;
  }

  const remaining = pending.length - enriched;
  if (remaining === 0) {
    const { error: doneErr } = await admin.from('profiles')
      .update({ last_import_at: new Date().toISOString() }).eq('user_id', userId);
    if (doneErr) console.error('last_import_at update failed:', doneErr.message);
  }
  return json({ enriched, remaining, rate_limited: rateLimited });
}
```

**Deploy** with `deploy_edge_function`:

- `name`: `enrich-release` · `entrypoint_path`: `enrich-release/index.ts` ·
  `verify_jwt`: **`false`**
- `files`: `enrich-release/index.ts` and `_shared/discogs.ts`.

## Task C4 — Extend `supabase/config.toml`

Append to the existing **`supabase/config.toml`** (below the two Stage B stanzas):

```toml
[functions.import-collection]
verify_jwt = false

[functions.enrich-release]
verify_jwt = false
```

(Same rationale as Stage B: the platform gate cannot validate Clerk tokens; identity is
verified in-handler. A CLI deploy must not silently re-enable it.)

## Task C5 — Frontend: auto-import with progress

**Three edits** in **`public/boot.js`**.

**Edit 1** — `ensureProfile` must return the import fields. Find (occurs once):

```js
    .select('user_id, discogs_username, import_status')
```

Replace with:

```js
    .select('user_id, discogs_username, import_status, last_import_at')
```

**Edit 2** — insert the import phase between ownership match and the baked-crate guard.
Find (occurs once):

```js
  // Pre-Stage-D guard — see BAKED_CRATE_OWNER above.
  if (profile.discogs_username.toLowerCase() !== BAKED_CRATE_OWNER) {
```

Replace with:

```js
  // ── Stage C: the import pipeline runs before anything renders, and re-runs until
  //    enrichment closes the gate by setting last_import_at (both phases are idempotent,
  //    so a resume from any interruption point just re-covers cheap ground). ──
  if (profile.import_status === 'error') {
    notice('Import needs attention',
      'Your stored Discogs connection could not be read, so importing is paused.<br><br>' +
      'This is on us — a reconnect flow is coming. Nothing of yours is lost.', true);
    return;
  }
  if (!profile.last_import_at) {
    const ok = await runImport();
    if (!ok) return;            // runImport rendered the error state itself
  }

  // Pre-Stage-D guard — see BAKED_CRATE_OWNER above.
  if (profile.discogs_username.toLowerCase() !== BAKED_CRATE_OWNER) {
```

**Edit 3** — add the import driver. Find (occurs once, module scope):

```js
function mountAuth() {
```

Replace with:

```js
/* Stage C import driver. Renders its own progress UI via notice(), drives the chunked
   import-collection loop then the enrich-release loop, and returns true when the caller
   may continue rendering. On give-up it renders an error notice and returns false —
   and because last_import_at is only set server-side when enrichment finishes, any
   give-up or tab-close resumes automatically on the next load. */
async function runImport() {
  const setLine = (msg) => {
    const el = document.getElementById('tw-import-line');
    if (el) el.textContent = msg;
  };
  notice('Filing your records',
    'Pulling your collection from Discogs. This runs once and takes under a minute for ' +
    'most crates.<br><br><div id="tw-import-line" style="color:var(--accent); ' +
    "font-family:'IBM Plex Mono',monospace; font-size:12px; letter-spacing:.08em\">" +
    'Contacting Discogs…</div>', true);

  const call = async (path, payload) => {
    const token = await window.Clerk.session.getToken();
    const r = await fetch(SUPABASE_URL + '/functions/v1/' + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(d.error || ('HTTP ' + r.status));
      err.status = r.status;
      throw err;
    }
    return d;
  };

  // Retries with backoff — but NOT on non-retryable 4xx (bad request, auth, not
  // connected): those fail identically every time and retrying just delays the truth.
  const attempt = async (fn) => {
    const delays = [2000, 5000, 10000];
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if ([400, 401, 403, 409].includes(e && e.status)) throw e;
        if (i >= delays.length) throw e;
        setLine('Hiccup (' + ((e && e.message) || e) + ') — retrying…');
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  };

  try {
    let page = 1, pages = 1, startedAt = null;
    do {
      const d = await attempt(() => call('import-collection',
        startedAt ? { page, started_at: startedAt } : { page }));
      pages = d.pages; startedAt = d.started_at;
      setLine('Importing — page ' + d.page + ' of ' + d.pages +
        ' (' + d.items + ' records)');
      if (d.done) break;
      page++;
      // Modest inter-page pace: ~48 pages/min worst case keeps a very large collection
      // under the 60/min token budget without slowing a normal import noticeably.
      await new Promise((r) => setTimeout(r, 250));
    } while (page <= pages && page <= 500);

    // Enrichment: loop until the server reports zero remaining. A rate-limit report
    // waits 30s; repeated calls with no progress (the guard trips on the fourth
    // consecutive zero-progress call) mean something upstream is stuck — stop WITHOUT
    // failing the whole flow (tracklists fill in on a later visit, because
    // last_import_at is only set when remaining hits 0).
    let prevRemaining = Infinity, noProgress = 0;
    for (let i = 0; i < 500; i++) {
      const d = await attempt(() => call('enrich-release', {}));
      if (d.remaining === 0) break;
      setLine('Filling in tracklists — ' + d.remaining + ' to go');
      noProgress = d.remaining >= prevRemaining ? noProgress + 1 : 0;
      prevRemaining = d.remaining;
      if (noProgress >= 3) {
        console.warn('enrichment stalled at', d.remaining, '— continuing; will resume next visit');
        break;
      }
      if (d.rate_limited) {
        setLine('Discogs asked us to slow down — waiting 30s (' + d.remaining + ' to go)');
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
    return true;
  } catch (e) {
    console.error(e);
    notice('Import hit a wall',
      'We could not finish pulling your collection from Discogs. Nothing is lost — ' +
      'reloading this page picks up where it left off.<br><br>' +
      '<a href="" style="color:var(--accent)">Reload and resume</a>', true);
    return false;
  }
}

function mountAuth() {
```

`notice()`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` are module-level in `boot.js` already.
(`runImport` is used above its definition — legal for a hoisted function declaration.)

## Task C6 — Commit and deploy the frontend

```
cd "/Users/lanebecker-wmf/Documents/Claude.nosync/Projects/Lane's Record Collection/traxwax-clone" && git add -A && git commit -m "Stage C — collection import & CC0 enrichment" && git push
```

Plain push to `multi-user` (no bot commits there — same reasoning as Stage B's Task B9).
**Expected:** push succeeds; Cloudflare rebuilds the preview; `traxwax.com` untouched.

## Task C7 — Verify Stage C

**1. All four functions ACTIVE.** `list_edge_functions`: `connect-discogs`,
`connect-discogs-callback`, `import-collection`, `enrich-release`, all `verify_jwt: false`.

**2. Forged token rejected on both new functions.**

```
curl -s -o /dev/null -w 'import: %{http_code}\n' -X POST \
  https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/import-collection \
  -H 'Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyX2ZvcmdlZCJ9.' \
  -H 'Content-Type: application/json' -d '{"page":1}'
curl -s -o /dev/null -w 'enrich: %{http_code}\n' -X POST \
  https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/enrich-release \
  -H 'Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyX2ZvcmdlZCJ9.'
```
**Expected: `401` twice.** A `200` on import means anyone can trigger imports as anyone —
stop. (Valid before the frontend ships: identity is checked before anything else.)

**3. Shape probe before the full run.** Signed in on the preview, in the browser console
(async IIFE — Safari rejects top-level await):

```js
(async () => {
  const t = await window.Clerk.session.getToken();
  const r = await fetch('https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/import-collection', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t,
      apikey: 'sb_publishable_RLxgLYBzZoh5YCkYJ3NJZw_8BLFMIWg',
      'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 1 }) });
  console.log(r.status, await r.json());
})();
```
**Expected:** `200` and `{page: 1, pages: 19, items: ~1861, started_at: "...", done: false}`.
An `unexpected_shape` error here means `instance_id` is not where the plan believes — stop
and inspect the function log's field-name line before proceeding. (This intentionally leaves
`import_status = 'running'` and `last_import_at` null, so the UI flow in step 4 re-runs
page 1 idempotently.)

**4. The real flow.** Reload `/app/lanebecker`. **Expected:** "Filing your records" with a
page counter climbing to 19, then a brief tracklist line, then the baked crate renders
normally. Total under ~90 seconds.

**5. The database is right.**

```sql
select count(*)                        as items,
       count(distinct release_id)      as distinct_releases,
       count(*) filter (where instance_id is null) as null_instances,
       min(updated_at)                 as oldest_touch
from public.collection_items where user_id like 'user\_%';
```
**Expected:** items ≈ 1,861 (≥ 1,859), `distinct_releases` ≈ 1,859, `null_instances` **0**,
`oldest_touch` within the import window.

```sql
select count(*) as total,
       count(*) filter (where tracks is null) as unenriched
from public.releases;
```
**Expected:** `total` ≈ 1,859 (grew from 1,851), `unenriched` **0**.

```sql
select import_status, last_import_at from public.profiles where discogs_username='lanebecker';
```
**Expected:** `idle`, recent timestamp — and it was written by `enrich-release`, not the
import (the two-phase gate).

**6. Idempotency + stale sweep.** Run:

```sql
update public.profiles set last_import_at = null where discogs_username='lanebecker';
```
Reload `/app/lanebecker`; the import re-runs. Then:

```sql
select count(*) from public.collection_items;
```
**Expected:** the same count as step 5 — no duplicates (upsert held) and no mass deletion
(the sweep only removes rows the fresh run did not touch), and `last_import_at` is set again
(this time by the enrich call finding zero pending).

**7. New-release enrichment shape matches the backfill.** Compare the newest-enriched and
oldest-enriched rows:

```sql
select release_id, enriched_at,
       array_agg(distinct k order by k) as track_keys
from (
  (select release_id, enriched_at, tracks from public.releases
    where tracks is not null and jsonb_array_length(tracks) > 0
    order by enriched_at desc limit 1)
  union all
  (select release_id, enriched_at, tracks from public.releases
    where tracks is not null and jsonb_array_length(tracks) > 0
    order by enriched_at asc limit 1)
) r, lateral jsonb_object_keys(r.tracks->0) as k
group by release_id, enriched_at;
```
**Expected:** two rows (one new, one backfilled), both with `track_keys = {dur,pos,title}` —
identical shapes, nothing extra.

**8. Production untouched.** `https://traxwax.com` → 200, the single-user crate.

---

## Rollback

```sql
delete from public.collection_items where user_id = '<clerk id>';
update public.profiles set import_status='idle', last_import_at=null
 where user_id = '<clerk id>';
```

Seeded/enriched `releases` rows are CC0 catalog data and deliberately stay — they are
correct regardless of who imported them.

## Open items

1. **Re-import cadence.** Collection ownership is Restricted Data; today it refreshes only
   when an import runs. A periodic or user-triggered re-sync lands with Stage D's UI.
2. **Enrichment at scale.** The per-invocation budget serializes a large new user's backlog
   through their browser session. Fine for launch scale; a server-side queue is the Phase 2
   shape if it ever hurts.
3. **`APP_ORIGIN`/`CLERK_ISSUER` hardcoded to preview/dev** in both new functions — same
   Stage D flip and Clerk-production items as Stage B (its Open items 1–2).
4. **The link-CSRF acceptance** (Stage B Open item 6) now also covers import: an attacker
   who completed that attack could import the victim's collection into their own crate.
   The Phase 2 authenticated-finalize fix closes both at once.
5. **`folder` stores the Discogs folder id as text**, not the folder name. Folder names
   need a `/collection/folders` call and matter only when the UI grows folder facets
   (Stage D at the earliest).
6. **`import_status = 'error'` recovery** works through reconnection: migration 0004 amends
   `link_discogs_account` to reset the status to `idle` on a successful re-link, so operator
   recovery is: delete the `discogs_credentials` row and clear `discogs_username` (resurfaces
   the Connect button); the user reconnects and the error state clears itself. A user-facing
   disconnect/reconnect flow is still Phase 2.
7. **Collections beyond 50,000 items** hit the 500-page cap and cannot finish (the gate
   stays open and re-imports every load). Implausible at launch scale; revisit if real.

---

## Audit record — round 1 (rev 1 → rev 2, 2026-08-28)

Rev 1 was audited by an independent no-context agent before execution.

**CRITICAL — fixed**

- **C-1 — the enrichment scan silently saw at most 1,000 of the caller's rows.** Hosted
  PostgREST caps any select at 1,000 rows with no error; rev 1's unbounded
  `select('release_id')` over 1,861 `collection_items` built the owned-set from an arbitrary
  ~54% of the collection, so `remaining` could reach 0 with null tracklists left — and it
  would likely have passed for Lane by luck and broken on the first >1,000-item user. Rev 1
  even worried about the URL-length cap on `.in()` one line below while missing this.
  **Fixed:** the owned-ids read is paginated with `.order('id').range(from, from+999)` until
  a short page; the fact is recorded in Confirmed facts so future queries respect it.
- **C-2 — an interrupted enrichment was permanently unrecoverable.** Rev 1 set
  `last_import_at` on the final import page, before enrichment; the boot gate keys on
  `last_import_at`, so closing the tab during "Filling in tracklists" skipped enrichment
  forever (no user re-sync exists in Stage C), violating the definition of done and both of
  rev 1's own claims about resumability. **Fixed:** the import's final page sets only
  `import_status='idle'`; `enrich-release` sets `last_import_at` when `remaining === 0`
  (including the legitimately-empty-collection case). Any interruption in either phase now
  resumes on next load.

**MAJOR — fixed**

- **M-1 — "production mapping, reused verbatim" was false: the `clean()` suffix-strip was
  dropped**, so seeded artist names would carry Discogs "(2)" disambiguators while the 1,851
  backfilled rows do not, fracturing Stage D's artist grouping. **Fixed:** `cleanName()`
  ports the regex.
- **M-2 — the rate-limit story was not what the code enforced.** The 1.1 s gap fired only
  after successes (an all-404 batch fired 5 requests back-to-back); a 429 returned HTTP 200
  so the frontend's backoff never engaged and it re-invoked instantly; a permanently-failing
  release never left the pending set, so the frontend could spin 500 unpaced iterations —
  rev 1's own "must not wedge the queue" comment documented the failure and then routed it
  around the handler. **Fixed:** the gap is unconditional (by loop index); 429 is reported
  as `rate_limited` and the frontend waits 30 s; 404 writes an honest `tracks: []`
  tombstone and exits the pending set; the frontend stops after three consecutive
  no-progress calls without failing the flow.
- **M-3 — `import_status='error'` (non-retryable by definition) was retried forever** by
  the boot gate, with no user exit. **Fixed:** the boot path branches on `error` and renders
  a distinct dead-end notice; operator recovery documented as Open item 6.
- **M-4 — "Two edits" undercounted three, and Edit 2's resume comment overpromised** (it
  was true only for import-phase interruptions under rev 1's C-2 design). **Fixed** with the
  C-2 redesign; the comment is now accurate for both phases.

**MINOR — fixed:** prose said "clamps" where the code rejects (aligned: rejects);
`updated_at` came from the edge instance's clock and `started_at` from another instance's —
clock skew could sweep fresh rows (now: DB trigger stamps rows and `db_now()` mints the
watermark, one clock); seed/item field defaults diverged from the backfill (`''` vs null,
rating 0→null — now byte-matched); verification step 7 compared one row against nothing (now
newest vs oldest); `?curr_abbr=USD` requested price conversion the function discards
(dropped); `attempt()` retried non-retryable 4xx (now rethrows immediately);
mid-import deletions on Discogs can skip one item under desc sort (accepted, code comment);
the 500-page cap wedges >50k-item collections (accepted, Open item 7); the
running/idle/sweep writes were unchecked (now checked — page-1 failures return
`store_failed`, final-page failures log and rely on the still-open gate);
the architecture blurb omitted `items` from the response shape (fixed).

**Confirmed correct by the audit, no change needed:** all three `boot.js` find-strings
byte-for-byte and unique, with `notice()`/`SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY`
module-level and the insertion honoring both locked decisions; all five `_shared/discogs.ts`
imports exported; every schema premise (unique constraint for `onConflict`, nullable
`instance_id` defused by the hard error, `text[]`/`jsonb` coercions, `import_status` check,
`enriched_at` default making `tracks is null` the right flag); `ignoreDuplicates` compiling
to `ON CONFLICT DO NOTHING`; the identity pattern diffed equal to the deployed
`connect-discogs`; no cross-user reach; nothing Restricted stored; all arithmetic (19 pages,
8 to enrich, 2 invocations, 27 calls/min for Lane); endpoint + sort matching production; the
enrichment shape verified live against the newest DB row; cross-references to Stage B Open
items and parent M9 counts; branch state making C6's plain push correct; and bidirectional
DoD ↔ task coverage.

---

## Audit record — round 2 (rev 2 → rev 3, 2026-08-28)

The rev-1 fixes were themselves audited by a second independent no-context agent (narrow
pass, rework only). **No CRITICALs** — the round-1 fixes were verified genuinely implemented
and sound, including the highest-risk seam (watermark precision: Date.parse truncates
Postgres microseconds DOWN, the conservative direction for a strict-lt sweep — verified
empirically). But the rework introduced two fresh MAJORs:

**MAJOR — fixed**

- **R2-M1 — the rework re-introduced the cross-clock comparison it was built to eliminate.**
  `started_at` was minted from the DB clock, but the echo validation on pages ≥ 2 compared
  it against the *edge instance's* `Date.now()` with zero negative tolerance — an instance
  whose clock trailed the DB by more than the inter-page gap would 400, which `attempt()`
  correctly refuses to retry, hard-killing the import identically on every reload while the
  skew persisted. **Fixed:** 5 minutes of future-skew tolerance (a slightly-future watermark
  still cannot delete fresh rows — the sweep is strict `lt` against trigger stamps ≥ the
  true mint).
- **R2-M2 — `import_status='error'` had no exit, and the documented recovery was a no-op.**
  Nothing ever cleared the error flag: the boot error-branch returns before `runImport()`,
  and reconnecting via OAuth wrote fresh credentials but `link_discogs_account` left the
  status untouched — the documented operator recovery led straight back to the same
  dead-end with valid credentials. **Fixed:** migration 0004 amends the RPC to set
  `import_status='idle'` on a successful link (a re-link is exactly the event that
  invalidates the error state); Open item 6 rewritten to match.

**MINOR — fixed:** the stall-guard prose said "three consecutive no-progress calls" where
the code trips on the fourth (prose aligned; behavior kept — and the audit confirmed
sustained rate-limiting cannot falsely trip it while progress continues); `enrich-release`'s
decrypt failure now sets `import_status='error'` like the import does; the two early
`last_import_at` writes are now error-checked like the third; the microsecond-truncation
asymmetry got its do-not-round-up comment; the frontend import loop gained a 250 ms
inter-page pace (~48 pages/min worst case) so very large collections stay under the token
budget — the one rework-adjacent gap round 2 flagged at scale.

**Confirmed correct by round 2, no change needed:** trigger semantics on both upsert arms
(BEFORE INSERT OR UPDATE fires on DO UPDATE's update arm; DO NOTHING seeding is untriggered
and irrelevant); `db_now()` return shape consumed correctly (verified live);
the watermark end-to-end (page-1 rows stamped strictly after the mint, one monotonic clock);
the paginated owned-ids read (`collection_items.id` exists; the exact-multiple edge case
handled); the 404 tombstone (exits pending, satisfies zero-null-tracklists, excluded by step
7's filter — query run live); `remaining` arithmetic under mixed failures;
`attempt()`'s status check semantics; all three boot.js find-strings still unique with the
error branch reachable exactly when intended; the full two-phase-gate state enumeration
(every path ends in a state the gate handles, now that R2-M1/M2 are fixed); `cleanName()`
regex-identical to production; and the Audit record's round-1 claims accurate as implemented.
