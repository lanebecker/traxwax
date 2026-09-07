/* Leg 1 of the Discogs OAuth 1.0a handshake.
 *
 * verify_jwt is FALSE at the platform level because Supabase's gate only validates
 * Supabase-issued JWTs and does not know Clerk's JWKS -- a Clerk RS256 token fails it.
 * Identity therefore comes from the shared verifyClerk (_shared/auth.ts), which enforces signature, issuer and
 * expiry. NOTHING else in this function may derive a user id: decoding the payload without
 * verifying would let anyone forge {"sub": "<someone else>"}. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { CORS, json, verifyClerk } from '../_shared/auth.ts';   // E1 (#99): the ONE auth/CORS preamble
import { DISCOGS_UA, oauthHeader, nonce, timestamp, parseForm, fieldNames, encrypt, selfTest }
  from '../_shared/discogs.ts';

const CALLBACK     = 'https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/connect-discogs-callback';


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
  const auth = await verifyClerk(req);   // E1 (#99): shared verifier — sub or a ready 401
  if ('response' in auth) return auth.response;
  const userId = auth.userId;

  const consumerKey = Deno.env.get('DISCOGS_CONSUMER_KEY');
  const consumerSecret = Deno.env.get('DISCOGS_CONSUMER_SECRET');
  // A6 (#67): leg-1 request-token secrets now rest AES-GCM-encrypted like every other
  // token, so this function needs the enc key too. Same self-test discipline as the
  // callback: a bad key must fail HERE, not corrupt a stored secret silently.
  const encKey = Deno.env.get('DISCOGS_TOKEN_ENC_KEY');
  if (!consumerKey || !consumerSecret || !encKey) return json({ error: 'not_configured' }, 500);
  try { await selfTest(encKey); }
  catch { console.error('crypto self-test failed'); return json({ error: 'not_configured' }, 500); }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Cooldown (issue #2 → B3 #71): ATOMIC since 0035's unique(user_id) index. Every
  //    request past this point burns a request_token round-trip under the SHARED consumer
  //    key (60/min site-wide), so the throttle must hold under CONCURRENCY — the old
  //    SELECT-then-INSERT let N parallel requests all pass the check before any placeholder
  //    committed. Now at most ONE state row per user exists, and arming is two atomic
  //    steps against the DB clock:
  //      1. UPDATE ... set created_at = db_now where user_id = me AND created_at < db_now-10s
  //         → a row came back: an old row (real handshake OR placeholder) existed and we
  //           touched it — we hold the cooldown. Touch, not delete: a real in-flight
  //           handshake from another tab keeps its token/secret (its callback still works;
  //           only created_at moves — expires_at is untouched). (Pass-2 property kept.)
  //      2. else INSERT the placeholder → a 23505 conflict means a concurrent request armed
  //         between our two steps (or a <10s row exists) → 429. Under READ COMMITTED a
  //         concurrent UPDATE re-evaluates its predicate after the winner's row lock
  //         releases, sees created_at = now, matches nothing, falls to INSERT, conflicts,
  //         and 429s — the Promise.all drain now costs ONE request_token call per 10s.
  //    A failed leg 1 leaves the touched/inserted row in place, so the throttle survives
  //    exactly when Discogs starts erroring (the original F4 property). One clock: the
  //    cutoff derives from db_now(), never the edge clock. Fail OPEN on infrastructure
  //    errors (never on conflicts), loudly — a broken DB must not lock everyone out.
  //    Caveat (pass-2 F-1): under DEGRADED infra the fail-open branches skip the 10s
  //    refusal, so a success there can replace another tab's <10s in-flight handshake via
  //    the delete on the success path below — accepted as inherent to failing open;
  //    self-healing (the other tab's callback lands on 'unknown_or_used', user reconnects). ──
  // ⚠ DEPLOY ORDER (audit F1): 0035's unique(user_id) index must exist BEFORE this deploys —
  //    the only refusal path below is its 23505 conflict; without the index the throttle is gone.
  await admin.from('discogs_oauth_state').delete().lt('expires_at', new Date().toISOString());
  const { data: dbNow, error: nowErr } = await admin.rpc('db_now');
  if (nowErr || !dbNow) {
    // F2: even failing open, ARM — the old code always left a cooldown record behind, so the
    // NEXT request was throttled while infrastructure was degraded. Preserve that: best-effort
    // placeholder insert, result deliberately ignored (a 23505 here means someone is armed).
    console.error('db_now failed (cooldown failing open):', nowErr?.message ?? 'no value');
    await admin.from('discogs_oauth_state').insert({
      oauth_token: 'cooldown-' + crypto.randomUUID(),
      oauth_token_secret: '',
      user_id: userId,
    }).then(({ error }) => {
      if (error && error.code !== '23505') console.error('fail-open arm failed:', error.message);
    });
  } else {
    const cutoffIso = new Date(new Date(dbNow as string).getTime() - 10_000).toISOString();
    const touched = await admin.from('discogs_oauth_state')
      .update({ created_at: dbNow as string })
      .eq('user_id', userId).lt('created_at', cutoffIso)
      .select('oauth_token');
    if (touched.error) {
      // F2: same fail-open-but-armed rule as the db_now branch above.
      console.error('cooldown touch failed (failing open):', touched.error.message);
      await admin.from('discogs_oauth_state').insert({
        oauth_token: 'cooldown-' + crypto.randomUUID(),
        oauth_token_secret: '',
        user_id: userId,
      }).then(({ error }) => {
        if (error && error.code !== '23505') console.error('fail-open arm failed:', error.message);
      });
    } else if (!touched.data || touched.data.length === 0) {
      const armed = await admin.from('discogs_oauth_state').insert({
        oauth_token: 'cooldown-' + crypto.randomUUID(),
        oauth_token_secret: '',
        user_id: userId,
      });
      if (armed.error) {
        if (armed.error.code === '23505') {
          return json({ error: 'cooldown', retry_after: 10 }, 429);
        }
        console.error('cooldown arm failed (failing open):', armed.error.message);
      }
    }
  }

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
    // A6 (#67): encrypted at rest (0003's comment already called this value "a credential");
    // the callback decrypts before signing leg 3. Cooldown placeholders keep '' — they are
    // never looked up by token and carry no secret.
    oauth_token_secret: await encrypt(parsed.oauth_token_secret, encKey),
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
