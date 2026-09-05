/* Stage C: budgeted CC0 enrichment. Fills tracks/country/released/videos for releases the
 * CALLER owns that are still un-enriched (tracks is null), at most BUDGET per invocation,
 * paced 1.1s before EVERY request after the first (success or failure) -- the caller's own
 * token pays, and must stay under 60/min even on all-failure batches.
 *
 * Phase 2 (#3): leftover budget drains REFRESH work — dated 404 tombstones retried after
 * 7 days, and rows whose enriched_at is older than 180 days — supplied by the same
 * pending_enrichment RPC (0010). New work alone drives `remaining` and the boot gate.
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

// Audit #31: env-first so the production flip is a secret change, not five redeploys.
// #52: fail CLOSED — no dev fallback. Prod always sets these; an unset value (misconfigured deploy / a new
// preview env) must refuse, never silently accept dev-issued tokens against production data.
const CLERK_ISSUER = Deno.env.get('CLERK_ISSUER');
const APP_ORIGIN   = Deno.env.get('APP_ORIGIN');
if (!CLERK_ISSUER || !APP_ORIGIN) throw new Error('CLERK_ISSUER and APP_ORIGIN env vars are required');
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

  // ── Work discovery: ONE join RPC (issue #4, cold audit #16). Replaces the paginated
  //    owned-ids scan + chunked IN-list probes (~18 round trips per invocation, ~6,700
  //    queries over a fresh 1,861-item collection). pending_enrichment is SECURITY
  //    DEFINER and service-role-only (migration 0008); p_user_id is the VERIFIED Clerk
  //    sub from jwtVerify above, never a client-supplied value. The RPC does its own
  //    LIMIT, so PostgREST's silent 1,000-row cap (Stage C rev 1's C-1) cannot bite. ──
  const { data: work, error: wErr } = await admin.rpc('pending_enrichment', {
    p_user_id: userId, p_limit: BUDGET });
  if (wErr) { console.error('pending_enrichment failed:', wErr.message); return json({ error: 'store_failed' }, 500); }
  const ownedCount = Number(work?.owned ?? 0);
  const wantedCount = Number(work?.wanted ?? 0);   // Wave 2 Stage A: wantlist-only users have owned=0
  const totalPending = Number(work?.total ?? 0);
  const newIds: number[] = Array.isArray(work?.pending) ? work.pending.map(Number) : [];
  const refreshTotal = Number(work?.refresh_total ?? 0);
  const refreshIds: number[] = Array.isArray(work?.refresh) ? work.refresh.map(Number) : [];
  // Wave 5a: master-year backfill work (owned, enriched, real master, no master_year). {release_id, master_id}.
  const masterTotal = Number(work?.master_total ?? 0);
  const masterRows: Array<{ release_id: number; master_id: number }> =
    Array.isArray(work?.master) ? work.master.map((m: Record<string, unknown>) =>
      ({ release_id: Number(m.release_id), master_id: Number(m.master_id) })) : [];

  if (ownedCount === 0 && wantedCount === 0) {
    // Neither collection nor wantlist: a legitimately empty import. Close the gate. (Wave 2 Stage A)
    const { error: emptyErr } = await admin.from('profiles')
      .update({ last_import_at: new Date().toISOString() }).eq('user_id', userId);
    if (emptyErr) console.error('last_import_at (empty) failed:', emptyErr.message);
    return json({ enriched: 0, remaining: 0, refreshed: 0, refresh_pending: 0 });
  }

  // Phase 2 (#3): NEW work first (it alone drives `remaining` and the boot gate),
  // leftover budget goes to refresh work — tombstone retries (7d), then stale rows
  // (180d), as ordered by the RPC. The gate closes on new work exactly as before;
  // refresh can never hold a first render hostage.
  const batch: Array<{ rid: number; isNew: boolean }> = [
    ...newIds.map((rid) => ({ rid, isNew: true })),
    ...refreshIds.map((rid) => ({ rid, isNew: false })),
  ].slice(0, BUDGET);

  if (totalPending === 0) {
    const { error: noneErr } = await admin.from('profiles')
      .update({ last_import_at: new Date().toISOString() }).eq('user_id', userId);
    if (noneErr) console.error('last_import_at (none-pending) failed:', noneErr.message);
    if (batch.length === 0 && masterRows.length === 0) {
      return json({ enriched: 0, remaining: 0, refreshed: 0, refresh_pending: refreshTotal, master_pending: masterTotal });
    }
    // No new work, but refresh and/or master-backfill work exists: fall through and process it.
  }

  let enriched = 0;    // NEW-work completions only: drives `remaining` and the gate
  let refreshed = 0;   // refresh completions (tombstone retries + stale re-fetches)
  let rateLimited = false;
  for (let i = 0; i < batch.length; i++) {
    const { rid, isNew } = batch[i];
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
        // Phase 2 (#3): the tombstone is now DATED, so it retries after 7 days instead
        // of being permanent. A re-tombstone (still 404 on retry) re-dates it.
        gone_at: new Date().toISOString(),
      }).eq('release_id', rid);
      if (goneErr) console.error('404 tombstone failed:', rid, goneErr.message);
      else if (isNew) enriched++;
      else refreshed++;
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
      master_id: (rel.master_id as number) || null,   // #28: || null normalizes Discogs' no-master 0 to NULL
      enriched_at: new Date().toISOString(),
      gone_at: null,   // Phase 2 (#3): a success clears any tombstone.
    }).eq('release_id', rid);
    if (upErr) { console.error('enrich update failed:', rid, upErr.message); continue; }
    if (isNew) enriched++;
    else refreshed++;
  }

  // ── Master-year backfill (Wave 5a). Lowest priority: only leftover budget, and it never holds the boot
  //    gate (master rows are already enriched — absent from totalPending/remaining). ONE GET per DISTINCT
  //    master; the UPDATE fills every sibling pressing at once, so the pending count collapses far faster
  //    than one row per call. Sentinel master_year=0 on a gone/yearless master exits the pending set.
  let masterFilled = 0;   // catalog-wide sibling ROWS filled this run (console figure; NOT used for master_pending)
  if (!rateLimited && masterRows.length > 0) {
    const leftover = BUDGET - batch.length;   // budget not spent on new/refresh (0 during a fresh import)
    const seen = new Set<number>();
    const distinct: number[] = [];
    for (const m of masterRows) { if (m.master_id && !seen.has(m.master_id)) { seen.add(m.master_id); distinct.push(m.master_id); } }
    for (let j = 0; j < distinct.length && j < leftover; j++) {
      const mid = distinct[j];
      await sleep(GAP_MS);   // pace EVERY master GET — they count toward the 60/min budget
      const mres = await fetch(`https://api.discogs.com/masters/${mid}`, {
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
      if (mres.status === 429) { console.error('rate limited at master', mid); rateLimited = true; break; }
      let my = 0;   // 0 = resolved, no usable year (sentinel → client falls back to pressing year)
      if (mres.status === 404) {
        my = 0;   // master gone → sentinel, so this master's rows exit the pending set (no wedge)
      } else if (!mres.ok) {
        console.error('get_master failed:', mid, mres.status);
        continue;   // transient → leave master_year null, retried next visit
      } else {
        try {
          const mj = JSON.parse(await mres.text());
          const y = Number(mj.year);
          my = (Number.isFinite(y) && y > 1900) ? y : 0;
        } catch { console.error('get_master non-JSON:', mid); continue; }
      }
      // Fill every sibling pressing sharing this master, catalog-wide (CC0 shared). .is('master_year', null)
      // keeps it idempotent — a sibling filled by an earlier run is never rewritten.
      const { data: upd, error: mErr } = await admin.from('releases')
        .update({ master_year: my }).eq('master_id', mid).is('master_year', null).select('release_id');
      if (mErr) { console.error('master_year update failed:', mid, mErr.message); continue; }
      masterFilled += Array.isArray(upd) ? upd.length : 0;
    }
  }

  const remaining = totalPending - enriched;
  if (remaining === 0) {
    const { error: doneErr } = await admin.from('profiles')
      .update({ last_import_at: new Date().toISOString() }).eq('user_id', userId);
    if (doneErr) console.error('last_import_at update failed:', doneErr.message);
  }
  return json({ enriched, remaining, refreshed,
    refresh_pending: Math.max(0, refreshTotal - refreshed),
    // Wave 5a: the RPC recomputes owned-null master rows each call, so report it straight — NOT
    // masterTotal - masterFilled (masterFilled counts catalog-wide siblings and could false-zero the
    // signal, stranding the drain). masterFilled=${masterFilled} is a per-run console figure only.
    master_pending: masterTotal,
    rate_limited: rateLimited });
}
