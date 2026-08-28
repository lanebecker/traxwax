/* Leg 2 of the Discogs OAuth 1.0a handshake.
 *
 * Discogs redirects the BROWSER here, so there is no Authorization header and there cannot
 * be one -- hence verify_jwt: false. Identity comes from the state row keyed on the
 * unguessable oauth_token, never from anything in the request. The row is consumed with an
 * atomic DELETE ... RETURNING, so exactly one caller can ever proceed. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { DISCOGS_UA, oauthHeader, nonce, timestamp, parseForm, fieldNames, encrypt, selfTest }
  from '../_shared/discogs.ts';

const APP_ORIGIN = 'https://multi-user.traxwax.pages.dev';

function back(status: string) {
  return new Response(null, {
    status: 302,
    headers: { Location: `${APP_ORIGIN}/app?connect=${encodeURIComponent(status)}` },
  });
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (e) {
    // This endpoint is browser-navigated: an uncaught throw would strand the user on a raw
    // Supabase 500 page mid-flow instead of returning them to the app with an explanation.
    console.error('unexpected:', (e as Error).message);
    return back('unexpected');
  }
});

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const oauthToken = url.searchParams.get('oauth_token');
  const verifier = url.searchParams.get('oauth_verifier');
  if (!oauthToken || !verifier) return back('missing_params');

  const consumerKey = Deno.env.get('DISCOGS_CONSUMER_KEY');
  const consumerSecret = Deno.env.get('DISCOGS_CONSUMER_SECRET');
  const encKey = Deno.env.get('DISCOGS_TOKEN_ENC_KEY');
  if (!consumerKey || !consumerSecret || !encKey) return back('not_configured');

  try { await selfTest(encKey); }
  catch { console.error('crypto self-test failed'); return back('not_configured'); }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Atomic consume. A select-then-delete would let two concurrent callbacks (a double load,
  // a prefetching browser, a link scanner) both pass the existence check.
  const { data: rows, error: stateErr } = await admin
    .from('discogs_oauth_state')
    .delete()
    .eq('oauth_token', oauthToken)
    .select('oauth_token_secret, user_id, expires_at');

  if (stateErr) { console.error('state consume failed:', stateErr.message); return back('state_error'); }
  const state = rows?.[0];
  if (!state) return back('unknown_or_used');
  if (new Date(state.expires_at) < new Date()) return back('expired');

  // Spec-correct PLAINTEXT signature: consumer_secret & token_secret. See "The one
  // remaining unknown" in docs/phase-1-stage-b-plan.md for why there is no fallback here.
  const accessRes = await fetch('https://api.discogs.com/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DISCOGS_UA,
      Authorization: oauthHeader({
        oauth_consumer_key: consumerKey,
        oauth_nonce: nonce(),
        oauth_token: oauthToken,
        oauth_signature: `${consumerSecret}&${state.oauth_token_secret}`,
        oauth_signature_method: 'PLAINTEXT',
        oauth_timestamp: timestamp(),
        oauth_verifier: verifier,
      }),
    },
  });

  const accessBody = await accessRes.text();
  if (!accessRes.ok) {
    console.error('access_token failed, status', accessRes.status);
    return back('access_denied');
  }
  const access = parseForm(accessBody);
  if (!access.oauth_token || !access.oauth_token_secret) {
    console.error('access_token 200 but unexpected fields:', fieldNames(accessBody));
    return back('access_denied');
  }
  console.log('access_token OK (spec signature form)');

  const idRes = await fetch('https://api.discogs.com/oauth/identity', {
    headers: {
      'User-Agent': DISCOGS_UA,
      Authorization: oauthHeader({
        oauth_consumer_key: consumerKey,
        oauth_nonce: nonce(),
        oauth_token: access.oauth_token,
        oauth_signature: `${consumerSecret}&${access.oauth_token_secret}`,
        oauth_signature_method: 'PLAINTEXT',
        oauth_timestamp: timestamp(),
      }),
    },
  });
  if (!idRes.ok) {
    console.error('identity failed, status', idRes.status);
    return back('identity_failed');
  }
  // NOT idRes.json(): the plan's facts table documents that a blocked/missing User-Agent
  // yields an EMPTY response body -- and .json() on an empty 200 throws. Parse defensively
  // so this documented failure mode lands on the graceful path, not the catch-all.
  let identity: { username?: string };
  try { identity = JSON.parse(await idRes.text()); }
  catch { console.error('identity 200 but non-JSON body'); return back('identity_failed'); }
  if (!identity?.username) {
    console.error('identity 200 but no username field');
    return back('identity_failed');
  }

  // One transaction: profile link + encrypted credentials, or neither.
  const { error: linkErr } = await admin.rpc('link_discogs_account', {
    p_user_id: state.user_id,
    p_username: identity.username,
    p_token_enc: await encrypt(access.oauth_token, encKey),
    p_secret_enc: await encrypt(access.oauth_token_secret, encKey),
  });

  if (linkErr) {
    console.error('link failed:', linkErr.code, linkErr.message);
    if (linkErr.code === '23505') return back('handle_taken');
    if (linkErr.code === 'P0002') return back('no_profile');
    return back('store_failed');
  }

  return back('ok');
}
