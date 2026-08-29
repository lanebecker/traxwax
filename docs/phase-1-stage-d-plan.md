# TraxWax Phase 1 Stage D — Live stats & the flip (implementation plan)

Parent: `docs/phase-1-plan.md` (Stages A–C **complete and verified**, 2026-08-28).
Design: `docs/multi-user-spec.md` §6, §7, §8, §9. Predecessors: Stage B and Stage C plans.

**Revision 3** (2026-08-28). Rev 1 was audited (no CRITICALs; **3 MAJORs, 10 minors** — a
stale test premise, a live-price leak into the deliberately-degraded surfaces, a
self-destructing RETRY control). Rev 2 fixed those; the narrow second pass over the rework
then caught **1 fresh MAJOR** — the plan failing its own 6b verification, because a rework
comment named the very constant the rework's new grep hunts. All folded in; both rounds in
the **Audit record** at the end. Cleared for execution.

**Definition of done:** on the preview, a signed-in connected user's crate renders **from
Supabase** (`collection_items` ⋈ `releases`), not from the baked `collection.json`; the
header EST comes from Discogs' whole-collection value endpoint live under the caller's token
(≤6h cached); opening a record's modal shows live price + community stats (one call, ≤6h
cached) and the tracklist from the shared catalog; a "RE-SYNC" control re-imports on demand
with a last-synced indicator; the `BAKED_CRATE_OWNER` guard and constant are **deleted**;
`/app/<other-user>` still refuses; and `traxwax.com` production is untouched (the merge to
`main` is a separate launch checklist, not part of this stage).

---

## Decisions locked (2026-08-28, with Lane)

| Decision | Choice |
|---|---|
| Prices | **Header + modal only.** Header EST via Discogs `collection/value` (1 call, ≤6h cache). Modal shows live lowest-sale + community stats on open (1 `get_release` call, ≤6h cache). **Grid price chips, the PRICE sort, per-month timeline values, and the Ledger's per-record price panels degrade** — the Ledger's "expensive end" panel gets honest placeholder copy. Lazy per-card prices are a Phase 2 enhancement. |
| Stage end | **Flip verified on preview.** Merge `multi-user` → `main` is a separate launch checklist (Clerk production instance, CDN pinning, landing approval, rebase, merge) — Open item 1. |
| Colored-wax fix | Rides to production with the eventual merge (Lane, 2026-08-28) — no `main` hotfix. |

## Confirmed facts (measured, not assumed)

- **No foreign key exists** between `collection_items.release_id` and `releases`
  (grep of all four migrations: zero `references`). PostgREST **embedding requires a real
  FK**, so the browser-side join needs migration 0005 — and the FK is currently satisfiable:
  all 1,859 distinct owned release ids exist in `releases` (verified after Stage C).
- **Stage C's import writes items BEFORE seeding releases** (`import-collection/index.ts`:
  the `collection_items` upsert precedes the `releases` seed). Under the new FK that order
  **violates the constraint for any new release** — Task D2 swaps the order and redeploys.
  This is the one write path the FK falsifies. Every other write to either table (the
  import's stale sweep, enrich's update and 404-tombstone, the link RPC, and the concurrent-
  import seed race under `ON CONFLICT DO NOTHING`) was enumerated and is FK-safe.
- **PostgREST caps any select at 1,000 rows silently** (Stage C's C-1). The crate load reads
  ~1,861 rows and MUST paginate with `.range()`; so must anything else unbounded.
- `app.js` consumption map (read in full, 603 lines):
  - Flat record shape consumed by render: `id, artist, title, year, label, styles[],
    genres[], vinyl, thumb, cover_image, added, rating, price, crating, crcount, have, want`
    — plus runtime fields `_rel`, `_relErr` attached by the modal loader.
  - `bootCrate()` (line 581) fetches `/collection.json` and self-wires listeners; exposed as
    `window.TraxWaxBootCrate`. `SETTINGS.ownerLine` is hardcoded `"Lane's shelf · filed by
    whim"` (line 16); `SETTINGS.showPrices` gates the grid price chip (line 221).
  - Modal loader `_loadRelease` (line 538): static `/releases/<id>.json` → live `/api/release`
    fallback, localStorage-cached (`tw_release_cache_v1`, 90-day TTL, LRU 800). The DB rows
    use the **same `{tracks,country,released,videos}` shape**, so a DB-first source slots in
    ahead of both with no cache-shape change.
  - Community stats + price in the modal read `rec.crating/crcount/have/want/price`
    (lines 452, 468–469) — baked fields, `null` in DB mode until live-stats fills them.
  - Header EST (line 386): `s.headerValue || valueLabel(v.total)` — already prefers the live
    value and shows `—` at total 0. Timeline month value (line 274): `valueLabel(val)` +
    `' of regret'` only when `val>0` — **degrades to `—` with no edit**. Ledger bigStats
    "Estimated value" (line 288) uses computed `total` — needs one edit to prefer
    `state.headerValue`. "The expensive end" panel already has an empty-state string
    (line 360) — needs reworded copy. PRICE sort button (line 410) needs hiding in DB mode.
  - Footer attribution (lines 428–431) already carries both required Discogs notices —
    **no change, do not touch**.
  - Duplicate-owned releases: **two pairs** of rows share an `id` (release ids 31172104 and
    30678904, measured). `RECORDS.find(r=>r.id===id)` in the modal resolves to the first —
    same release, harmless; grid renders both copies (matches the baked behavior).
- `boot.js`: the supabase client exists at module scope with a Clerk `accessToken` hook
  (Stage A) — authenticated PostgREST from the browser is proven (`ensureProfile` writes
  under RLS). `releases` has a public-read policy, `collection_items` owner-only.
- **Discogs whole-collection value**: `GET /users/<username>/collection/value` returns
  `{minimum, median, maximum}` as currency strings under the owner's token — the existing
  `/api/value` proxy uses exactly this endpoint, and `app.js` consumes `median || minimum`.
- Rate limits: 60/min per token. Stage D's steady-state spend is 1 value call per ≤6h plus
  1 `get_release` per modal open (server-cached ≤6h per release) — negligible.

---

## Architecture decisions

**One data seam, provider-injected.** `app.js` stays dependency-free: `boot.js` (which owns
auth and the supabase client) injects four globals **before** importing `app.js`:

| Global | Contract |
|---|---|
| `window.TraxWaxData` | `async () => rows[]` in the flat record shape (price/stat fields null) |
| `window.TraxWaxReleaseData` | `async (id) => {tracks,country,released,videos} \| null` from the `releases` table |
| `window.TraxWaxStats` | `async (id?) => ({value} \| {price,crating,crcount,have,want} \| null)` via the `live-stats` function |
| `window.TraxWaxRefresh` | `async () => boolean` — re-runs the Stage C import pipeline |

`bootCrate()` uses `TraxWaxData` when present and falls back to `/collection.json` when
absent — so `app.js` on `main` (no boot providers until the merge) is **byte-identical in
behavior** to today, and local dev without auth still works. DB mode is simply "the
providers exist."

**The modal's release loader becomes DB-first**: `TraxWaxReleaseData` → static file → live
proxy. The DB tier covers the entire catalog **independently of** the static files — which,
measured 2026-08-28, currently lack nothing (the weekly refresh has baked all 1,859; the
"8 missing files" from earlier in the day was already stale by evening — the round-1 audit
caught the plan repeating it). The old tiers stay as fallbacks and the localStorage cache is
shape-compatible.

**live-stats is one Edge Function with two kinds** — `{kind:'value'}` (whole-collection
estimate, per-user cache key) and `{kind:'release', id}` (price + community stats, per-release
cache key, shared across users: the *data* is global even though each fetch runs under the
caller's token). Cache is an **in-instance `Map` with a 6-hour TTL** — ephemeral, never the
database, exactly the spec §7 posture. A cold instance re-fetches; that is the accepted cost
of never persisting Restricted data. Identity: the Stage B JWKS pattern verbatim. Accepted
nuisance: a connected user can iterate release ids and churn the bounded FIFO cache
(evicting fresh entries, forcing re-fetches) — wasteful, not poisoning, since the server
always fetches Discogs itself and `value:` keys are per-user; the cache is ephemeral and
capped, so the blast radius is a few redundant upstream calls.

**Re-sync needs no new backend.** The Stage C pipeline is idempotent and client-driven;
"RE-SYNC" simply runs it again (`TraxWaxRefresh` → `runImport()` → reload the crate data).
`profiles.last_import_at` (already returned by `ensureProfile`) is the last-synced indicator.

**The FK lands with the flip, not before.** Migration 0005 adds
`collection_items.release_id → releases(release_id)` so the browser join embeds; Task D2
reorders the import's writes (seed first) in the same stage so the constraint can never trip.

**What this stage deliberately does not do:** touch `main`, the weekly
`refresh-collection.yml`, the baked `collection.json`/`releases/*.json` (production still
needs them, and the static release files remain a useful CDN tier), or the landing page.

---

## Task D1 — Migration 0005: the join FK

Create **`supabase/migrations/0005_collection_fk.sql`**:

```sql
-- 0005_collection_fk.sql — Phase 1 Stage D
--
-- PostgREST embedding (collection_items -> releases in one query) requires a real foreign
-- key. Stage C guaranteed the data satisfies it: every imported item seeds its release.
-- ON DELETE is left at the default (NO ACTION -- round-1 audit corrected rev 1's claim
-- that the default is RESTRICT): a release row referenced by anyone's collection cannot be
-- deleted out from under them, and nothing in this system deletes from releases anyway.
--
-- NOTE: import-collection MUST seed releases before upserting items once this exists;
-- Task D2 ships that reorder in the same stage.

alter table public.collection_items
  add constraint collection_items_release_fk
  foreign key (release_id) references public.releases(release_id);
```

Apply with the TraxWax MCP connector (`apply_migration`, name `0005_collection_fk`).

**Verify:**

```sql
select conname, confdeltype
from pg_constraint
where conname = 'collection_items_release_fk';
```
**Expected:** one row, `confdeltype = 'a'` (NO ACTION). If `apply_migration` errors with a
violation, the data premise is stale — stop and find the orphan release ids before forcing
anything.

If Task D5's crate query later fails with *"could not find a relationship between
collection_items and releases"*, PostgREST's schema cache did not pick up the new FK —
hosted Supabase normally auto-reloads on DDL, but the fix is one statement:
`notify pgrst, 'reload schema';`

## Task D2 — Reorder `import-collection` writes and redeploy

In **`supabase/functions/import-collection/index.ts`**, find (occurs once):

```ts
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
```

Replace with:

```ts
  if (items.length > 0) {
    // SEED FIRST. Migration 0005 added collection_items.release_id -> releases(release_id);
    // inserting an item whose release row does not exist yet now violates the FK, so the
    // catalog seed must land before the items that reference it.
    // ignoreDuplicates: an already-enriched (or already-seeded) release row is NEVER
    // overwritten -- seeding must not regress tracks back to null.
    const { error: seedErr } = await admin.from('releases')
      .upsert([...seeds.values()], { onConflict: 'release_id', ignoreDuplicates: true });
    if (seedErr) {
      console.error('release seed failed:', seedErr.message);
      return json({ error: 'store_failed' }, 500);
    }
    const { error: itemErr } = await admin.from('collection_items')
      .upsert(items, { onConflict: 'user_id,instance_id' });
    if (itemErr) {
      console.error('collection upsert failed:', itemErr.message);
      return json({ error: 'store_failed' }, 500);
    }
  }
```

**Redeploy** `import-collection` with `deploy_edge_function` exactly as in the Stage C plan
(same name, entrypoint, `verify_jwt: false`, two files with `_shared/discogs.ts` unchanged).

**Verify:** rerun the Stage C forged-token probe (401) and then, after Task D8's re-sync
test, confirm imports still succeed end-to-end under the FK.

## Task D3 — Deploy `live-stats`

Create **`supabase/functions/live-stats/index.ts`**:

```ts
/* Stage D: the Restricted-data proxy. Two kinds:
 *   {kind:'value'}          -> whole-collection estimate for the CALLER (their username,
 *                              their token, per-user cache key)
 *   {kind:'release', id}    -> lowest price + community stats for one release (per-release
 *                              cache key -- the data is global; the token is the caller's)
 *
 * Cache: in-instance Map, 6h TTL. Ephemeral by design -- Restricted data is cached briefly
 * and NEVER stored in the database (spec sections 7 and 8). A cold instance re-fetches;
 * that is the accepted cost of never persisting.
 *
 * Identity: the Stage B JWKS pattern. verify_jwt false; jwtVerify is the only identity. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';
import { DISCOGS_UA, oauthHeader, nonce, timestamp, decrypt }
  from '../_shared/discogs.ts';

const CLERK_ISSUER = 'https://brave-buffalo-7127.clerk.accounts.dev';
const APP_ORIGIN   = 'https://multi-user.traxwax.pages.dev';
const TTL_MS = 6 * 3600 * 1000;

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

// In-instance cache. Key -> {ts, data}. Bounded so a long-lived instance cannot grow
// without limit (drop-oldest at the cap).
const cache = new Map<string, { ts: number; data: unknown }>();
const CACHE_MAX = 5000;
function cacheGet(key: string): unknown | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTL_MS) { cache.delete(key); return null; }
  return hit.data;
}
function cachePut(key: string, data: unknown): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), data });
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

  let body: { kind?: unknown; id?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const kind = body.kind;
  if (kind !== 'value' && kind !== 'release') return json({ error: 'bad_request' }, 400);
  const releaseId = Number(body.id);
  if (kind === 'release' && (!Number.isInteger(releaseId) || releaseId < 1)) {
    return json({ error: 'bad_request' }, 400);
  }

  // Cache check BEFORE decrypting or touching Discogs.
  const cacheKey = kind === 'value' ? `value:${userId}` : `release:${releaseId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return json(cached);

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
    console.error('credential decrypt failed:', (e as Error).message);
    await admin.from('profiles').update({ import_status: 'error' }).eq('user_id', userId);
    return json({ error: 'credentials_unreadable' }, 500);
  }

  const auth = () => oauthHeader({
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce(),
    oauth_token: userToken,
    oauth_signature: `${consumerSecret}&${userSecret}`,
    oauth_signature_method: 'PLAINTEXT',
    oauth_timestamp: timestamp(),
  });

  if (kind === 'value') {
    const { data: prof } = await admin.from('profiles')
      .select('discogs_username').eq('user_id', userId).maybeSingle();
    if (!prof?.discogs_username) return json({ error: 'not_connected' }, 409);
    const res = await fetch(
      `https://api.discogs.com/users/${encodeURIComponent(prof.discogs_username)}/collection/value`,
      { headers: { 'User-Agent': DISCOGS_UA, Authorization: auth() } });
    if (!res.ok) {
      console.error('collection value failed, status', res.status);
      return json({ error: 'discogs_failed', status: res.status }, 502);
    }
    let v: { minimum?: string; median?: string; maximum?: string };
    try { v = JSON.parse(await res.text()); }
    catch { console.error('collection value non-JSON'); return json({ error: 'discogs_failed' }, 502); }
    // Discogs returns currency STRINGS ("$1,234.56"). Pass through; app.js renders as-is
    // (its existing api.value() consumed the proxy's median||minimum the same way).
    const out = { value: v.median || v.minimum || null };
    cachePut(cacheKey, out);
    return json(out);
  }

  // kind === 'release'
  const res = await fetch(`https://api.discogs.com/releases/${releaseId}?curr_abbr=USD`, {
    headers: { 'User-Agent': DISCOGS_UA, Authorization: auth() } });
  if (res.status === 404) {
    const out = { price: null, crating: null, crcount: null, have: null, want: null };
    cachePut(cacheKey, out);
    return json(out);
  }
  if (!res.ok) {
    console.error('get_release failed, status', res.status);
    return json({ error: 'discogs_failed', status: res.status }, 502);
  }
  let rel: Record<string, unknown>;
  try { rel = JSON.parse(await res.text()); }
  catch { console.error('get_release non-JSON'); return json({ error: 'discogs_failed' }, 502); }
  const comm = (rel.community ?? {}) as Record<string, unknown>;
  const crat = (comm.rating ?? {}) as Record<string, unknown>;
  const out = {
    price: (rel.lowest_price as number | null) ?? null,
    crating: (crat.average as number | null) ?? null,
    crcount: (crat.count as number | null) ?? null,
    have: (comm.have as number | null) ?? null,
    want: (comm.want as number | null) ?? null,
  };
  cachePut(cacheKey, out);
  return json(out);
}
```

**Deploy** with `deploy_edge_function`: `name` `live-stats`, `entrypoint_path`
`live-stats/index.ts`, `verify_jwt` **`false`**, `files` = `live-stats/index.ts` +
`_shared/discogs.ts`.

## Task D4 — Extend `supabase/config.toml`

Append below the Stage C stanzas:

```toml
[functions.live-stats]
verify_jwt = false
```

## Task D5 — `boot.js`: providers in, guard out

**Edit 1 — delete the guard and its constant.** Find (occurs once):

```js
/* Until Stage D swaps the data source, the ONLY collection this app can render is the baked
   public/collection.json — which is Lane's. Serving it to any other signed-in user would be
   exactly the Restricted-Data transfer this project's compliance argument forbids. So the
   crate renders for its actual owner and nobody else until the swap lands.
   Stage D deletes this constant and its guard. */
const BAKED_CRATE_OWNER = 'lanebecker';
```

Replace with:

```js
/* Stage D: the crate renders from Supabase (collection_items ⋈ releases) under the
   signed-in user's own RLS — the baked-owner guard that protected the baked-data era is
   gone, exactly as its comment promised. (Named obliquely on purpose: D8 step 6b greps for
   the old constant to prove no reference survives, comments included.) */
```

**Edit 2 — delete the guard branch.** Find (occurs once):

```js
  // Pre-Stage-D guard — see BAKED_CRATE_OWNER above.
  if (profile.discogs_username.toLowerCase() !== BAKED_CRATE_OWNER) {
    notice('Your crate is still being built',
      'Your Discogs account is connected, but per-user collections land in Stage D.<br><br>' +
      'Nothing of yours is lost — it just is not rendered yet.', true);
    return;
  }

  await import('/app.js');
  window.TraxWaxBootCrate();
```

Replace with:

```js
  // ── Stage D: inject the data providers, then boot the crate from Supabase. ──
  installCrateProviders(profile);
  await import('/app.js');
  window.TraxWaxBootCrate();
```

**Edit 3 — add the providers.** Find (occurs once):

```js
/* Stage C import driver. Renders its own progress UI via notice(), drives the chunked
```

Replace with:

```js
/* Stage D data providers. app.js stays dependency-free: everything it needs from the
   authenticated world arrives through these four globals, installed before it is imported.
   When they are absent (main branch until the merge; local dev), app.js falls back to the
   baked collection.json unchanged. */
function installCrateProviders(profile) {
  const fnCall = async (path, payload) => {
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
    if (!r.ok) return null;
    return r.json().catch(() => null);
  };

  // The crate rows: collection_items ⋈ releases via the 0005 FK embed, PAGINATED —
  // PostgREST silently caps any select at 1,000 rows and this user owns ~1,861.
  window.TraxWaxData = async () => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('collection_items')
        .select('release_id, added, rating, vinyl, ' +
          'releases ( artist, title, year, label, styles, genres, thumb, cover_image )')
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error('collection query failed: ' + error.message);
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

  // Modal tracklist tier 0: the shared CC0 catalog (covers every release, including the
  // ones with no baked static file). Public-read RLS; shape matches the static files.
  window.TraxWaxReleaseData = async (id) => {
    const { data, error } = await supabase
      .from('releases')
      .select('tracks, country, released, videos')
      .eq('release_id', id)
      .maybeSingle();
    if (error || !data || data.tracks == null) return null;
    return {
      tracks: data.tracks || [], country: data.country || '',
      released: data.released || '', videos: data.videos || [],
    };
  };

  // Restricted data, live under the caller's token, server-cached ≤6h.
  window.TraxWaxStats = async (id) => fnCall('live-stats',
    id == null ? { kind: 'value' } : { kind: 'release', id });

  // RE-SYNC: the Stage C pipeline is idempotent and client-driven; run it again, then
  // refresh the profile so last_import_at is current for the indicator.
  window.TraxWaxRefresh = async () => {
    const ok = await runImport();
    if (ok) {
      const p = await ensureProfile(window.Clerk.user.id);
      window.TraxWaxOwner = ownerInfo(p);
    }
    return ok;
  };

  window.TraxWaxOwner = ownerInfo(profile);
}
function ownerInfo(profile) {
  return {
    ownerLine: profile.discogs_username
      ? profile.discogs_username + "'s shelf · filed by whim"
      : 'Your shelf · filed by whim',
    lastSyncedAt: profile.last_import_at || null,
  };
}

/* Stage C import driver. Renders its own progress UI via notice(), drives the chunked
```

## Task D6 — `app.js`: DB mode

**Edit 1 — boot from the provider.** Find (occurs once):

```js
async function bootCrate(){
  initTheme();
  document.getElementById('app').innerHTML=`<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--muted)">Loading the crate…</div>`;
  try{
    // ABSOLUTE path, deliberately. A relative './collection.json' resolves against the page
    // URL, so on /app/<username> it became /app/collection.json -- which the /app/* rewrite
    // serves as the app-shell HTML, and JSON.parse dies. Latent until Stage B: no user had a
    // discogs_username, so the crate never rendered at /app/* before 2026-08-28.
    const res=await fetch('/collection.json'); RECORDS=await res.json();
  }catch(e){
    document.getElementById('app').innerHTML=`<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; color:var(--accent)">Couldn't load collection.json</div>`;
    return;
  }
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  window.addEventListener('keydown', e=>{ if(e.key==='Escape' && state.detailId){ state.detailId=null; render(); } });
  render();
  api.value().then(v=>{ if(v){ state.headerValue=v; render(); } });   // live whole-collection EST. (one proxy call)
}
```

Replace with:

```js
/* DB mode = boot.js installed the providers before importing this file. Without them
   (main until the merge; local dev) everything below falls back to the baked paths. */
const DB_MODE = () => !!window.TraxWaxData;

async function bootCrate(){
  initTheme();
  if (window.TraxWaxOwner && window.TraxWaxOwner.ownerLine) {
    SETTINGS.ownerLine = window.TraxWaxOwner.ownerLine;
  }
  if (DB_MODE()) SETTINGS.showPrices = false;   // per-record prices are Restricted; header+modal only
  document.getElementById('app').innerHTML=`<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--muted)">Loading the crate…</div>`;
  try{
    if (DB_MODE()) {
      RECORDS = await window.TraxWaxData();
    } else {
      // ABSOLUTE path, deliberately. A relative './collection.json' resolves against the
      // page URL, so on /app/<username> it became /app/collection.json -- served as the
      // app-shell HTML by the /app/* rewrite, and JSON.parse dies.
      const res=await fetch('/collection.json'); RECORDS=await res.json();
    }
  }catch(e){
    console.error(e);
    document.getElementById('app').innerHTML=`<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; color:var(--accent)">Couldn't load the collection. <button id="tw-reload" style="font-family:inherit; font-size:inherit; padding:4px 10px; margin-left:6px; border:1.5px solid var(--line); background:var(--panel); color:var(--ink); cursor:pointer">RETRY</button></div>`;
    // Attached DIRECTLY to the button. Round-1 audit MAJOR-3: a document-level listener
    // with {once:true} is consumed by the first click ANYWHERE, leaving RETRY dead.
    const rb = document.getElementById('tw-reload');
    if (rb) rb.addEventListener('click', () => location.reload());
    return;
  }
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  window.addEventListener('keydown', e=>{ if(e.key==='Escape' && state.detailId){ state.detailId=null; render(); } });
  render();
  if (DB_MODE()) {
    window.TraxWaxStats().then(v=>{ if(v && v.value){ state.headerValue=v.value; render(); } });
  } else {
    api.value().then(v=>{ if(v){ state.headerValue=v; render(); } });   // live whole-collection EST. (one proxy call)
  }
}
```

**Edit 2 — the modal loads the DB catalog first and live stats alongside.** Find (occurs once):

```js
async function _loadRelease(rec){
  let d = await _fetchReleaseFile(rec.id);   // baked static file (immutable, instant, no rate limit)
  if(!d) d = await _fetchReleaseLive(rec);   // fallback: live proxy for a not-yet-baked new record
  if(d){ rec._rel=d; rec._relErr=false; _relCache[rec.id]={ts:Date.now(), d}; _saveRelCache(); }
  else { rec._relErr=true; }
  if(state.detailId===rec.id) render();
}
```

Replace with:

```js
async function _loadRelease(rec){
  let d = null;
  if (DB_MODE() && window.TraxWaxReleaseData) {
    try { d = await window.TraxWaxReleaseData(rec.id); } catch(e) { d = null; }
  }
  if(!d) d = await _fetchReleaseFile(rec.id);   // baked static file (immutable, CDN-cached)
  if(!d) d = await _fetchReleaseLive(rec);      // last resort: the live proxy
  if(d){ rec._rel=d; rec._relErr=false; _relCache[rec.id]={ts:Date.now(), d}; _saveRelCache(); }
  else { rec._relErr=true; }
  if(state.detailId===rec.id) render();
}
async function _loadStats(rec){
  if(!DB_MODE() || rec._stats) return;
  try {
    const s = await window.TraxWaxStats(rec.id);
    if(s && !s.error){
      // Stored under _stats, NEVER onto rec.price/crating/etc. Round-1 audit MAJOR-2:
      // mutating rec.price leaks live prices back into computeVals() -- after a few modal
      // opens the Ledger's "expensive end" would present whichever records the user
      // happened to open as the collection's priciest, and timeline months would show
      // partial sums. The degraded surfaces must stay degraded, not half-alive.
      rec._stats = { price: s.price, crating: s.crating, crcount: s.crcount,
                     have: s.have, want: s.want };
      if(state.detailId===rec.id) render();
    }
  } catch(e) { /* stats are decoration; the modal stands without them */ }
}
```

**Edit 2b — the modal reads stats from `_stats` in DB mode.** Find (occurs once):

```js
  const priceLabel = rec.price!=null ? money(rec.price) : '—';   // lowest sale — baked in collection.json
```

Replace with:

```js
  // DB mode: live stats live under rec._stats (see _loadStats -- MAJOR-2); baked mode
  // keeps reading the collection.json fields. One selector, both worlds.
  const st = DB_MODE() ? (rec._stats || {}) : rec;
  const priceLabel = st.price!=null ? money(st.price) : '—';   // lowest sale
```

Find (occurs once):

```js
  const rating = rec.crating!=null ? (Number(rec.crating).toFixed(1)+' ('+(rec.crcount||0)+')') : '—';   // community rating (baked)
  const haveWant = (rec.have!=null && rec.want!=null) ? (rec.have.toLocaleString()+' / '+rec.want.toLocaleString()) : '—';
```

Replace with:

```js
  const rating = st.crating!=null ? (Number(st.crating).toFixed(1)+' ('+(st.crcount||0)+')') : '—';   // community rating
  const haveWant = (st.have!=null && st.want!=null) ? (st.have.toLocaleString()+' / '+st.want.toLocaleString()) : '—';
```

**Edit 3 — trigger the stats load on modal open.** Find (occurs once):

```js
  render();
  if(rec && !rec._rel) await _loadRelease(rec);
}
```

Replace with:

```js
  render();
  if(rec) _loadStats(rec);
  if(rec && !rec._rel) await _loadRelease(rec);
}
```

**Edit 4 — hide the PRICE sort in DB mode.** Find (occurs once):

```js
          ${sortBtn('added','ADDED')}${sortBtn('artist','ARTIST')}${sortBtn('year','YEAR')}${sortBtn('price','PRICE')}
```

Replace with:

```js
          ${sortBtn('added','ADDED')}${sortBtn('artist','ARTIST')}${sortBtn('year','YEAR')}${DB_MODE()?'':sortBtn('price','PRICE')}
```

**Edit 5 — the Ledger's estimated value prefers the live figure, and the empty priciest
panel gets honest copy.** Find (occurs once):

```js
      {label:'Estimated value', value:valueLabel(total), note:priced.length?'Median of Discogs lows.':'Wired to the Discogs proxy next.', color:'var(--accent)'},
```

Replace with:

```js
      {label:'Estimated value', value:state.headerValue||valueLabel(total), note:priced.length?'Median of Discogs lows.':'Live Discogs estimate.', color:'var(--accent)'},
```

Find (occurs once):

```js
            : `<span style="font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--faint); line-height:1.6">Prices arrive once the Discogs proxy is wired.</span>`
```

Replace with:

```js
            : `<span style="font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--faint); line-height:1.6">Per-record prices return in a future update. Open any record for its live lowest sale.</span>`
```

**Edit 6 — RE-SYNC control + last-synced indicator in the header.** Find (occurs once):

```js
        <button data-act="theme" title="Toggle theme" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:7px 11px; background:#fff; color:#16171a; border:1.5px solid #16171a">${s.theme==='dark'?'LIGHTS ON':'LIGHTS OUT'}</button>
```

Replace with:

```js
        ${DB_MODE()?`<button data-act="resync" title="${esc(_lastSyncedLabel())}" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:7px 11px; background:#fff; color:#16171a; border:1.5px solid #16171a">${state._resyncing?'SYNCING…':'RE-SYNC'}</button>`:''}
        <button data-act="theme" title="Toggle theme" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:7px 11px; background:#fff; color:#16171a; border:1.5px solid #16171a">${s.theme==='dark'?'LIGHTS ON':'LIGHTS OUT'}</button>
```

**Edit 7 — the re-sync handler + label helper.** Find (occurs once):

```js
    case 'theme': setTheme(state.theme==='dark'?'light':'dark'); render(); break;
```

Replace with:

```js
    case 'theme': setTheme(state.theme==='dark'?'light':'dark'); render(); break;
    case 'resync': _resync(); break;
```

Find (occurs once):

```js
/* ── Boot ──────────────────────────────────────────────────────────────────── */
```

Replace with:

```js
/* ── Re-sync (DB mode) ─────────────────────────────────────────────────────── */
function _lastSyncedLabel(){
  const at = window.TraxWaxOwner && window.TraxWaxOwner.lastSyncedAt;
  return at ? ('Last synced ' + new Date(at).toLocaleString()) : 'Refresh from Discogs';
}
async function _resync(){
  if(state._resyncing || !DB_MODE() || !window.TraxWaxRefresh) return;
  state._resyncing = true; render();
  try {
    const ok = await window.TraxWaxRefresh();   // runs the import pipeline with its own UI
    if(!ok){
      // runImport rendered "Import hit a wall" with a resume link -- leave it on screen.
      // An unconditional render() here would paint the crate over the failure silently
      // (round-1 audit minor 4).
      state._resyncing = false;
      return;
    }
    RECORDS = await window.TraxWaxData();
  } catch(e) {
    // Rare seam: runImport succeeded but the row refetch threw -- the crate below renders
    // pre-sync data with a stale tooltip. Self-heals on reload or a second RE-SYNC
    // (round-2 audit m-2); not worth more machinery.
    console.error(e);
  }
  state._resyncing = false;
  render();
}

/* ── Boot ──────────────────────────────────────────────────────────────────── */
```

> **Note:** `window.TraxWaxRefresh` runs the Stage C `runImport()` which paints its own
> full-screen progress notice into `#app`, replacing the crate mid-resync; when it returns,
> `_resync` re-fetches the rows and `render()` repaints the crate. That page-takeover is the
> Stage C UI reused as-is — acceptable for Stage D, refine in the launch-polish pass if it
> grates.

## Task D7 — Commit and deploy the frontend

```
cd "/Users/lanebecker-wmf/Documents/Claude.nosync/Projects/Lane's Record Collection/traxwax-clone" && git add -A && git commit -m "Stage D — the flip: crate reads Supabase, live stats, re-sync; baked guard deleted" && git push
```

Plain push to `multi-user` (no bot commits there). `traxwax.com` untouched.

## Task D8 — Verify Stage D

**1. Five functions ACTIVE**, all `verify_jwt: false` (`list_edge_functions`).

**2. Forged token → 401 on `live-stats`:**

```
curl -s -o /dev/null -w 'live-stats: %{http_code}\n' -X POST \
  https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/live-stats \
  -H 'Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyX2ZvcmdlZCJ9.' \
  -H 'Content-Type: application/json' -d '{"kind":"value"}'
```
**Expected: `401`.**

**3. The flip renders.** Signed in, `/app/lanebecker`: the crate renders ~1,861 records
**with the browser's network tab showing NO request to `/collection.json`** — the load comes
from `rest/v1/collection_items` (two paginated requests). Grid cards show **no price chip**;
the sort row has **no PRICE button**; the header shows a **RE-SYNC** button and, shortly, a
live `$… EST.` figure.

**4. The modal is live.** Open a record: tracklist appears (from the catalog — network shows
`rest/v1/releases`, not `/releases/<id>.json`, on a cache-cold record); RATING, HAVE/WANT and
LOWEST SALE populate within a couple of seconds from `live-stats`. In DB mode the DB tier is
queried **first**, so any cache-cold record already exercises it (the round-1 "open one of
the 8 un-baked releases" test premise was stale — all 1,859 static files exist). Belt and
braces, prove the DB tier suffices *alone*: clear `localStorage.tw_release_cache_v1`, block
requests matching `/releases/*` in devtools (this cannot catch the Supabase call — its path
is `rest/v1/releases`), open a record, confirm the tracklist still arrives.

**4b. Restricted data stays out of persistent storage.** In the console after opening a few
records: `Object.values(JSON.parse(localStorage.tw_release_cache_v1)).every(e =>
!('price' in e.d) && !('crating' in e.d))` → **`true`**. The release cache may hold only
the CC0 `{tracks,country,released,videos}` shape.

**5. Ownership still holds.** `/app/someoneelse` → "No crate here". Signed out `/app` →
Clerk card.

**6. Re-sync round-trips.** Click RE-SYNC: the Stage C progress screen runs (fast — every
page is an idempotent upsert), then the crate re-renders. Verify in SQL that
`collection_items` count is unchanged and `profiles.last_import_at` advanced — and hover
RE-SYNC to confirm the tooltip shows a "Last synced …" timestamp (the last-synced
indicator from the definition of done).

**6b. The guard is really gone.**
`grep -c BAKED_CRATE_OWNER public/boot.js public/app.js` → 0 matches in both files.

**7. Import still works under the FK.** Step 6 *is* this test (Task D2's reorder ran a full
import against the constraint). Additionally check the function logs show no FK violations.

**8. The second-account probe.** (First real multi-user moment.) If Lane has a second Clerk
account without a Discogs connection: sign in with it → it gets the Connect screen, NOT
Lane's crate, and `/app/lanebecker` under that account → "No crate here". If no second
account exists, defer to the launch checklist.

**9. Production untouched.** `https://traxwax.com` → 200, baked single-user crate, prices
intact.

---

## Rollback

The flip is frontend + additive backend. Reverting the D7 commit restores the baked path in
full — including the `BAKED_CRATE_OWNER` guard, since the revert restores the pre-flip
`boot.js`/`app.js` wholesale. Migration 0005's FK and `live-stats` are harmless to leave in
place. `import-collection`'s write reorder is correct with or without the FK.

## Open items

1. **The launch checklist** (separate from this stage, run when Lane says go): Clerk
   production instance created + Supabase third-party auth repointed + both `CLERK_ISSUER`
   constants updated; `APP_ORIGIN` flipped to `https://traxwax.com` in all five functions;
   CDN scripts pinned to exact versions (Clerk ui/js, supabase-js) with SRI where possible;
   landing page design approved; `git pull --rebase` then merge `multi-user` → `main`
   (weekly bot commits make it non-fast-forward); post-merge smoke test; retire the weekly
   `refresh-collection.yml` + baked data or keep as archive (decide then).
2. **Restricted-data freshness of the header value**: cached ≤6h per user in-instance;
   a cold edge instance refetches. Compliant and cheap.
3. **The `/api/*` Cloudflare proxy** (Lane's personal token) remains deployed as the modal's
   last-resort fallback tier. At launch, decide whether to retire it — the DB tier covers
   everything the catalog knows.
4. **Per-record prices** (lazy viewport loading) — Phase 2 enhancement, per the locked
   decision.
5. **Re-sync UX**: the Stage C full-screen progress takeover is reused as-is; refine in
   launch polish if desired.
6. **Link-CSRF acceptance** (Stage B Open item 6, Stage C Open item 4) unchanged; Phase 2.

---

## Audit record — round 1 (rev 1 → rev 2, 2026-08-28)

Rev 1 was audited by an independent no-context agent that mechanically verified all ten
frontend find-strings byte-for-byte, applied every edit to scratch copies, and parsed the
results. **No CRITICALs.**

**MAJOR — fixed**

- **M-1 — a stale test premise.** The plan claimed 8 releases lacked baked static files and
  built D8.4's DB-tier test on opening one; measured, `public/releases/` holds all 1,859 —
  the weekly refresh had baked the 8 since the morning's count. Exactly the true-when-written
  trap class. **Fixed:** the architecture claim corrected; the test now forces the DB tier
  via devtools request-blocking + cache clear.
- **M-2 — live prices leaked back into the deliberately-degraded surfaces.** `_loadStats`
  mutated `rec.price`, so after a few modal opens `computeVals()` would present whichever
  records the user happened to open as the Ledger's "expensive end", plus partial timeline
  sums — a partial display posing as authoritative. **Fixed:** stats live under
  `rec._stats`, and the modal (Edit 2b) reads through a one-line selector; `rec.price`
  stays null in DB mode.
- **M-3 — the RETRY control self-destructed.** A document-level click listener with
  `{once:true}` is consumed by the first click *anywhere*. **Fixed:** listener attached
  directly to the button.

**MINOR — fixed:** the FK comment claimed RESTRICT is the default (it is NO ACTION; comment
corrected, verify already expected `'a'`); "two rows share id" undercounted (two pairs:
31172104, 30678904); the rollback wording described reverting as leaving the guard deleted
(a revert restores it); `_resync` painted the crate over `runImport`'s failure notice (early
return added); D1 gained the `notify pgrst, 'reload schema'` contingency; "nothing else
writes these tables" overstated (rephrased with the enumerated write paths); D8 gained the
localStorage Restricted-data spot-check (4b), the BAKED_CRATE_OWNER grep (6b), and the
last-synced tooltip check; the live-stats cache-churn nuisance is now owned in a sentence;
`ownerInfo`'s unreachable "your's shelf" grammar fixed. Not changed: the stale
`lastSyncedAt` tooltip right after a first-run import (cosmetic, self-heals on reload).

**Confirmed correct by round 1, no change needed:** all ten find-strings (and D2's) exist
exactly once byte-for-byte; both post-edit files parse (TDZ-safe `DB_MODE` references,
hoisted declarations, scope of every captured identifier in `installCrateProviders`); every
"Confirmed facts" line number; the flat-shape mapping covers every field `app.js` consumes
(`folder` unused); the FK premise (types, name, 1,859/1,859 satisfiability, every write
path FK-safe after D2, `releases` never deleted); pagination arithmetic (two `.range()`
requests); the embed syntax and non-null embed under FK + public-read RLS; live-stats'
imports, Map eviction order, 404 caching, per-user value keys, CORS-on-every-path, currency
string passthrough end-to-end; Restricted-data compliance including the localStorage cache
shape in all tiers; config.toml append target; branch state for D7; and bidirectional
DoD ↔ task coverage.

---

## Audit record — round 2 (rev 2 → rev 3, 2026-08-28)

The rev-1 rework got its own narrow audit (mechanical: every rework find-string matched,
all edits composed onto scratch copies, both composed files parsed). **No CRITICALs.**

**MAJOR — fixed**

- **R2-M1 — the plan failed its own verification.** D5 Edit 1's replacement comment named
  `BAKED_CRATE_OWNER` — the exact token D8 step 6b greps for to prove no reference
  survives. Both halves were rev-2 rework; an executor would have concluded Edit 1 failed
  or improvised. **Fixed:** the comment names the guard obliquely and says why.

**MINOR — fixed:** D8 step 4 carried rev-1's "force the fallback" mental model into a world
where the tier order is inverted (reworded: the DB tier is first; the blocking step proves
it suffices alone — and the block pattern cannot accidentally catch the `rest/v1/releases`
call); `_resync`'s catch can render pre-sync data after a successful import whose row
refetch threw (self-heals; now commented rather than machineried). Noted, no change:
`_loadStats` can double-fetch one release when a modal is closed and reopened before the
first fetch resolves (idempotent, server-cached).

**Confirmed correct by round 2, no change needed:** Edit 2b's find-strings byte-for-byte
and unique with `st` correctly scoped above both uses and unshadowed; `_loadStats`' guard
semantics (failed fetch retries on next open; a 404 stores a truthy `_stats` and stops
churn); `DB_MODE` TDZ-safe in the composed file; the full degradation trace (`priced=[]`,
timeline `—`, priciest placeholder, PRICE sort unreachable, `api.price` defined-but-never-
called); the RETRY shape (direct listener is the only correct one — the delegated handlers
are never wired on that path); `_resync`'s early return leaving the failure notice intact
with reload-fresh state; D8 4b's expression matching the real `{ts, d}` cache shape; the
6-tooltip flow; every smaller rework (NO ACTION vs `'a'` consistency, `notify pgrst`
syntax, the FK-safe write-path enumeration against actual code, cache-churn sentence,
`ownerInfo`, rollback wording, the measured duplicate pair ids); and the round-1 Audit
record's accuracy as implemented.
