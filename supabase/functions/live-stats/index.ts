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
 * Identity: the Stage B JWKS pattern. verify_jwt false; the shared verifyClerk is the only identity. */

import 'jsr:@supabase/functions-js@2.115.0/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2.116.0';
import { fetchWithTimeout } from '../_shared/http.ts';
import { CORS, json, verifyClerk } from '../_shared/auth.ts';   // E1 (#99): the ONE auth/CORS preamble
import { DISCOGS_UA, oauthHeader, nonce, timestamp, decrypt }
  from '../_shared/discogs.ts';

const TTL_MS = 6 * 3600 * 1000;


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
  // E1 (#99): shared verifier — sub or a ready 401. Named `vc`, NOT `auth`: this function
  // already has a `const auth` (the OAuth header builder below) in the same scope, and the
  // collision shipped as a boot-time SyntaxError the placebo `node --check` waved through
  // (post-deploy real-parse caught it; see the E1 lesson in log.md).
  const vc = await verifyClerk(req);
  if ('response' in vc) return vc.response;
  const userId = vc.userId;

  const consumerKey = Deno.env.get('DISCOGS_CONSUMER_KEY');
  const consumerSecret = Deno.env.get('DISCOGS_CONSUMER_SECRET');
  const encKey = Deno.env.get('DISCOGS_TOKEN_ENC_KEY');
  if (!consumerKey || !consumerSecret || !encKey) return json({ error: 'not_configured' }, 500);

  let body: { kind?: unknown; id?: unknown; owner?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const kind = body.kind;
  if (kind !== 'value' && kind !== 'release') return json({ error: 'bad_request' }, 400);
  // T2.14 (#136): body.id is `unknown`. Number() coerced true->1 / [7]->7 past Number.isInteger.
  // Accept a number OR a canonical numeric string; reject booleans/arrays/floats/1e21/junk.
  const rid = body.id;
  const releaseId =
    typeof rid === 'number' && Number.isSafeInteger(rid) && rid >= 1 ? rid
    : (typeof rid === 'string' && /^[1-9]\d{0,8}$/.test(rid)) ? Number(rid)
    : null;
  if (kind === 'release' && releaseId === null) {
    return json({ error: 'bad_request' }, 400);
  }
  // Wave 1: the Discogs username of the crate being viewed (empty => own crate). The SERVER
  // decides price suppression from this; a client cannot claim a crate is its own.
  const owner = typeof body.owner === 'string' ? body.owner.trim() : '';

  // Audit #4: the caller must be Discogs-CONNECTED before being served even cached
  // Restricted data -- a Clerk-only user has not accepted the Discogs data relationship.
  // The connected check therefore precedes the cache; decryption still waits for a miss.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data: cred } = await admin.from('discogs_credentials')
    .select('oauth_token, oauth_token_secret').eq('user_id', userId).maybeSingle();
  if (!cred) return json({ error: 'not_connected' }, 409);

  // Wave 1 price suppression + friend-view authorization — MUST run before the cache read below
  // (the release cache key is global and holds a priced payload). Delegated to ONE service_role-
  // only DB function (migration 0014) that resolves the owner username LITERALLY and reuses
  // private.can_view_crate, so this endpoint never duplicates or pattern-matches (audit #12-A).
  // NOTE: price/community stats here are GLOBAL per-release data, so this suppression is
  // best-effort UX for the friend-view context, NOT a confidentiality boundary — that boundary is
  // which release IDs are in whose crate, enforced by private.can_view_crate (0013) via the
  // get_friend_crate projection RPC (#42; the table-wide collection_items friend RLS policy was dropped).
  // A client omitting `owner` gets the (global) price, as it does
  // for its own crate today; the friend-crate UI never renders a number (priceCellHtml).
  let suppressPrice = false;
  if (kind === 'release' && owner) {
    const { data: decision, error: decErr } = await admin.rpc('crate_view_decision',
      { p_viewer: userId, p_owner_username: owner });
    if (decErr || decision == null) return json({ error: 'unexpected' }, 500);   // fail closed
    if (decision === 'allowed') suppressPrice = true;                            // consented friend
    else if (decision !== 'own') return json({ error: 'forbidden' }, 403);       // 'denied' | 'no_owner'
  }

  // A5 (#66): the value cache must not outlive the Discogs connection it came from — keyed
  // on the Clerk sub alone, a disconnect→re-link to a DIFFERENT account served the old
  // account's cached value for up to 6h. Key it on the CURRENTLY linked username instead
  // (fetched before the cache read; the value branch below reuses this row). A changed link
  // changes the key, so the stale entry is simply never hit again and FIFO-ages out.
  let valueUsername = '';
  if (kind === 'value') {
    const { data: prof } = await admin.from('profiles')
      .select('discogs_username').eq('user_id', userId).maybeSingle();
    if (!prof?.discogs_username) return json({ error: 'not_connected' }, 409);
    valueUsername = prof.discogs_username;
  }
  const cacheKey = kind === 'value' ? `value:${userId}:${valueUsername}` : `release:${userId}:${releaseId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return json(suppressPrice ? { ...(cached as Record<string, unknown>), price: null } : cached);

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
    // Username already resolved above (A5 #66) — it is part of the cache key.
    const res = await fetchWithTimeout(
      `https://api.discogs.com/users/${encodeURIComponent(valueUsername)}/collection/value`,
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
  const res = await fetchWithTimeout(`https://api.discogs.com/releases/${releaseId}?curr_abbr=USD`, {
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
  cachePut(cacheKey, out);   // cache the FULL priced payload (global key); suppress only on return
  return json(suppressPrice ? { ...out, price: null } : out);
}
