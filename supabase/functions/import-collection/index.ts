/* Stage C: chunked collection import. One invocation = one Discogs page (<=100 items).
 * The frontend drives page 1..pages; the server keeps no page CURSOR, but DOES persist a per-kind page-1
 * watermark (profiles.import_started_<kind>, #39) so the final-page stale-sweep can't be steered by a
 * forged client echo of started_at.
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

// Audit #31: env-first so the production flip is a secret change, not five redeploys.
const CLERK_ISSUER = Deno.env.get('CLERK_ISSUER') ?? 'https://brave-buffalo-7127.clerk.accounts.dev';
const APP_ORIGIN   = Deno.env.get('APP_ORIGIN') ?? 'https://multi-user.traxwax.pages.dev';

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

  // ── Input: { page, started_at?, kind? } ──────────────────────────────────────
  let body: { page?: unknown; started_at?: unknown; kind?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const page = Number(body.page);
  // 500-page cap = 50,000 items. A collection beyond it cannot finish and would loop;
  // acceptable at launch scale, revisit if a real user ever approaches it.
  if (!Number.isInteger(page) || page < 1 || page > 500) {
    return json({ error: 'bad_request' }, 400);
  }
  // Wave 2 Stage A: one function, two kinds. Default preserves today's collection behavior.
  const kind = body.kind === 'wantlist' ? 'wantlist' : 'collection';

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Wave 2 Stage A: only endpoint / list-key / table / conflict / row-mapping differ by kind;
  // auth, decrypt, watermark, seed, and sweep are shared. userId is the verified Clerk sub.
  const KIND = kind === 'wantlist'
    ? {
        path: (u: string) => `https://api.discogs.com/users/${encodeURIComponent(u)}/wants`,
        listKey: 'wants',
        table: 'wantlist_items',
        conflict: 'user_id,release_id',
        wmCol: 'import_started_wantlist',
        needsInstanceId: false,
        mapItem: (r: Record<string, unknown>, releaseId: number): Record<string, unknown> => ({
          user_id: userId, release_id: releaseId,
          added: typeof r.date_added === 'string' ? r.date_added.slice(0, 10) : null,
        }),
      }
    : {
        path: (u: string) => `https://api.discogs.com/users/${encodeURIComponent(u)}/collection/folders/0/releases`,
        listKey: 'releases',
        table: 'collection_items',
        conflict: 'user_id,instance_id',
        wmCol: 'import_started_collection',
        needsInstanceId: true,
        mapItem: (r: Record<string, unknown>, releaseId: number): Record<string, unknown> => ({
          user_id: userId, release_id: releaseId,
          instance_id: Number(r.instance_id),
          folder: r.folder_id != null ? String(r.folder_id) : '',
          rating: Number(r.rating ?? 0) || 0,
          added: typeof r.date_added === 'string' ? r.date_added.slice(0, 10) : null,
          vinyl: ((r.basic_information as Record<string, unknown>)?.formats as Array<{ text?: string }>)?.[0]?.text ?? '',
        }),
      };

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
    // Wave 2 Stage A: import_status is the COLLECTION boot-gate signal; only the collection pass
    // owns it. A background wantlist decrypt failure fails silently (its .catch logs) rather than
    // stranding import_status='error' and showing the collection "paused" card.
    if (kind === 'collection') {
      await admin.from('profiles').update({ import_status: 'error' }).eq('user_id', userId);
    }
    return json({ error: 'credentials_unreadable' }, 500);
  }

  // ── Watermark: minted from the DATABASE clock on page 1 (same clock the trigger stamps rows with) and
  //    PERSISTED to profiles.import_started_<kind> (#39). The page->=2 client echo below is kept for
  //    response continuity + range-validated, but the final-page sweep uses the PERSISTED value, so a
  //    forged echo can no longer steer the delete. ──
  let startedAt: string;
  if (page === 1) {
    const { data: dbNow, error: nowErr } = await admin.rpc('db_now');
    if (nowErr || !dbNow) {
      console.error('db_now failed:', nowErr?.message);
      return json({ error: 'store_failed' }, 500);
    }
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
  const pageUrl = `${KIND.path(prof.discogs_username)}` +
    `?page=${page}&per_page=100&sort=added&sort_order=desc`;
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
    console.error(kind + ' page failed, status', res.status);
    return json({ error: 'discogs_failed', status: res.status }, 502);
  }
  // Wave 2 Stage A: adaptive pacing — the client widens its inter-page gap when this is low.
  // An ABSENT header is UNKNOWN budget (→ null → normal pacing), not 0 (which Number(null) yields
  // and would force max backoff every page). NaN → Number.isFinite false → rate_remaining: null.
  const _rrHeader = res.headers.get('X-Discogs-Ratelimit-Remaining');
  const rateRemaining = _rrHeader == null ? NaN : Number(_rrHeader);
  let d: {
    pagination?: { pages?: number; items?: number };
    releases?: Array<Record<string, unknown>>;
    wants?: Array<Record<string, unknown>>;
  };
  try { d = JSON.parse(await res.text()); }
  catch { console.error(kind + ' page non-JSON body'); return json({ error: 'discogs_failed' }, 502); }

  const pages = Number(d.pagination?.pages ?? 1);
  const totalItems = Number(d.pagination?.items ?? 0);
  const listRaw = (d as Record<string, unknown>)[KIND.listKey];
  const entries = Array.isArray(listRaw) ? listRaw as Array<Record<string, unknown>> : [];

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
    if (!Number.isInteger(releaseId) || (KIND.needsInstanceId && !Number.isInteger(instanceId))) {
      console.error('entry missing release/instance id; kind', kind, 'fields:',
        Object.keys(r as object).join(','));
      return json({ error: 'unexpected_shape' }, 502);
    }
    // Row mapping is per-kind (collection carries instance_id/folder/rating/vinyl — defaults
    // mirror build/refresh_collection.py; wantlist carries user_id/release_id/added). The seeds
    // below are IDENTICAL for both, built from basic_information. updated_at: the trigger stamps it.
    items.push(KIND.mapItem(r, releaseId));
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
    // SEED FIRST. Migration 0005 added collection_items.release_id -> releases(release_id);
    // inserting an item whose release row does not exist yet now violates the FK, so the
    // catalog seed must land before the items that reference it.
    // Phase 2 (#3): seeds now MERGE — last-import-wins on the basic fields, so Discogs
    // community corrections propagate on every import. The seed_releases RPC (0010)
    // empty-guards each field ('' / 0 / [] never stomp a real value), and seeds carry no
    // deep fields, so enrichment (tracks etc.) cannot regress.
    const { error: seedErr } = await admin.rpc('seed_releases',
      { p_rows: [...seeds.values()] });
    if (seedErr) {
      console.error('release seed failed:', seedErr.message);
      return json({ error: 'store_failed' }, 500);
    }
    const { error: itemErr } = await admin.from(KIND.table)
      .upsert(items, { onConflict: KIND.conflict });
    if (itemErr) {
      console.error(KIND.table + ' upsert failed:', itemErr.message);
      return json({ error: 'store_failed' }, 500);
    }
  }

  // ── Final page: sweep stale rows, then idle. last_import_at is NOT set here --
  //    enrich-release owns it, so an interrupted enrichment resumes on next load. ──
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
    // Both failures are log-only: last_import_at is still null, so the pipeline re-runs
    // idempotently on next load and gets another chance.
  }

  return json({ page, pages, items: totalItems, started_at: startedAt, done,
    rate_remaining: Number.isFinite(rateRemaining) ? rateRemaining : null, kind });
}
