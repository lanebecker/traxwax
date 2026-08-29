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
// without limit (drop-oldest at the cap). A connected user could iterate ids and churn
// this FIFO -- wasteful, not poisoning: the server always fetches Discogs itself and
// value: keys are per-user; blast radius is a few redundant upstream calls.
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
