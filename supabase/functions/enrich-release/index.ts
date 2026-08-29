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

// Audit #31: env-first so the production flip is a secret change, not five redeploys.
const CLERK_ISSUER = Deno.env.get('CLERK_ISSUER') ?? 'https://brave-buffalo-7127.clerk.accounts.dev';
const APP_ORIGIN   = Deno.env.get('APP_ORIGIN') ?? 'https://multi-user.traxwax.pages.dev';
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
  //    select at 1,000 rows (measured fact; rev 1's C-1) -- an unbounded select here
  //    would silently ignore ~half of a 1,861-item collection. ─────────────────────
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
