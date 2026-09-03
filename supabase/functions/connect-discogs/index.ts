/* Leg 1 of the Discogs OAuth 1.0a handshake.
 *
 * verify_jwt is FALSE at the platform level because Supabase's gate only validates
 * Supabase-issued JWTs and does not know Clerk's JWKS -- a Clerk RS256 token fails it.
 * Identity therefore comes from jwtVerify below, which enforces signature, issuer and
 * expiry. NOTHING else in this function may derive a user id: decoding the payload without
 * verifying would let anyone forge {"sub": "<someone else>"}. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';
import { DISCOGS_UA, oauthHeader, nonce, timestamp, parseForm, fieldNames }
  from '../_shared/discogs.ts';

// Audit #31: env-first so the production flip is a secret change, not five redeploys.
// #52: fail CLOSED — no dev fallback. Prod always sets these; an unset value (misconfigured deploy / a new
// preview env) must refuse, never silently accept dev-issued tokens against production data.
const CLERK_ISSUER = Deno.env.get('CLERK_ISSUER');
const APP_ORIGIN   = Deno.env.get('APP_ORIGIN');
if (!CLERK_ISSUER || !APP_ORIGIN) throw new Error('CLERK_ISSUER and APP_ORIGIN env vars are required');
const CALLBACK     = 'https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/connect-discogs-callback';

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    return await handle(req);
  } catch (e) {
    // A thrown fetch (network failure to Discogs, JWKS unreachable) must still return
    // CORS headers, or the browser reports an opaque "Failed to fetch" with no diagnostic
    // -- the exact symptom class the C3 fix exists to avoid.
    console.error('unexpected:', (e as Error).message);
    return json({ error: 'unexpected' }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  // ── Identity: verified, never decoded. Runs BEFORE the config check so the forged-token
  //    negative test (B10 step 2) is meaningful even while the B2 secrets are unset. ──────
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'missing_token' }, 401);

  let userId: string;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: CLERK_ISSUER });
    if (!payload.sub) throw new Error('no sub claim');
    // Clerk stamps azp with the origin the token was minted for. Reject tokens minted for
    // another site; tolerate absence, per Clerk's own guidance. Defense-in-depth only.
    if (payload.azp && payload.azp !== APP_ORIGIN) throw new Error('azp mismatch');
    userId = payload.sub;
  } catch (e) {
    console.error('clerk token rejected:', (e as Error).message);
    return json({ error: 'invalid_token' }, 401);
  }

  const consumerKey = Deno.env.get('DISCOGS_CONSUMER_KEY');
  const consumerSecret = Deno.env.get('DISCOGS_CONSUMER_SECRET');
  if (!consumerKey || !consumerSecret) return json({ error: 'not_configured' }, 500);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Cooldown (issue #2, cold audit #7). Every request past this point burns a
  //    request_token round-trip under the SHARED consumer key (60/min for the whole
  //    site), so a signed-in user in a loop could exhaust the budget and break connect
  //    for everyone. The user's newest state row — real handshake state or the armed
  //    placeholder below — is the cooldown record: created <10s ago → refuse BEFORE
  //    touching Discogs. Both timestamps are DB-clocked (db_now(), created_at default
  //    now()) — one clock, per the Stage C watermark lesson; the Edge instance's own
  //    clock never enters the comparison. A human clicking Connect never sees this. ──
  const { data: recentRows, error: recentErr } = await admin.from('discogs_oauth_state')
    .select('created_at').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(1);
  // Fail OPEN, but never silently (remediation-audit F5): a broken probe must not lock
  // legitimate users out of connect, but it must leave a trail in the logs.
  if (recentErr) console.error('cooldown probe failed (failing open):', recentErr.message);
  const recent = recentRows?.[0];
  if (recent) {
    const { data: dbNow, error: nowErr } = await admin.rpc('db_now');
    if (nowErr) console.error('db_now failed (cooldown failing open):', nowErr.message);
    if (!nowErr && dbNow &&
        new Date(dbNow as string).getTime() - new Date(recent.created_at as string).getTime() < 10_000) {
      return json({ error: 'cooldown', retry_after: 10 }, 429);
    }
  }

  // ── Arm the cooldown BEFORE touching Discogs (remediation-audit F4): the throttle
  //    must survive a FAILED leg 1, or a hostile loop runs unthrottled exactly when
  //    Discogs starts returning errors — the moment the shared budget most needs the
  //    protection. The placeholder row is the cooldown record: its random token can
  //    never match a callback lookup, the success path below replaces it with the real
  //    state row, and the expiry sweep clears abandoned ones within 15 minutes. ──────
  await admin.from('discogs_oauth_state').delete().lt('expires_at', new Date().toISOString());
  // Clear only stale PLACEHOLDERS here (pass-2 audit): deleting the user's real row
  // before a leg 1 that then FAILS would destroy a valid in-flight handshake from
  // another tab. Real rows are replaced only on the success path below.
  await admin.from('discogs_oauth_state').delete().eq('user_id', userId)
    .like('oauth_token', 'cooldown-%');
  const { error: armErr } = await admin.from('discogs_oauth_state').insert({
    oauth_token: 'cooldown-' + crypto.randomUUID(),
    oauth_token_secret: '',
    user_id: userId,
  });
  if (armErr) console.error('cooldown arm failed (failing open):', armErr.message);

  // ── Leg 1: ask Discogs for a request token. NOTE: GET, not POST. ───────────
  const res = await fetch('https://api.discogs.com/oauth/request_token', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DISCOGS_UA,
      Authorization: oauthHeader({
        oauth_consumer_key: consumerKey,
        oauth_nonce: nonce(),
        oauth_signature: `${consumerSecret}&`,
        oauth_signature_method: 'PLAINTEXT',
        oauth_timestamp: timestamp(),
        oauth_callback: CALLBACK,
      }),
    },
  });

  const body = await res.text();
  if (!res.ok) {
    // Log status only. The body of a FAILED call is not secret, but the body of a
    // SUCCESSFUL one contains oauth_token_secret -- so never establish the habit.
    console.error('request_token failed, status', res.status);
    return json({ error: 'discogs_request_token_failed' }, 502);
  }

  const parsed = parseForm(body);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    // A 200 body is secret-bearing. Log field NAMES only, never the body.
    console.error('request_token 200 but unexpected fields:', fieldNames(body));
    return json({ error: 'discogs_unexpected_response' }, 502);
  }

  // Replace the cooldown placeholder with the real handshake state (one row per user;
  // the expiry sweep already ran above, before leg 1).
  await admin.from('discogs_oauth_state').delete().eq('user_id', userId);

  const { error } = await admin.from('discogs_oauth_state').insert({
    oauth_token: parsed.oauth_token,
    oauth_token_secret: parsed.oauth_token_secret,
    user_id: userId,
  });
  if (error) {
    console.error('state insert failed:', error.message);
    return json({ error: 'state_store_failed' }, 500);
  }

  return json({
    authorize_url: 'https://www.discogs.com/oauth/authorize?oauth_token=' +
      encodeURIComponent(parsed.oauth_token),
  });
}
