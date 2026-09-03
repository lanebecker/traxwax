/* Phase 2 (#8): unlink Discogs. Deletes the encrypted credential, the imported collection
 * (Restricted Data tied to the connection — 0006's re-link rule, applied to disconnect),
 * any in-flight handshake state and pending links; resets the profile to never-connected.
 * The RPC is one transaction. Discogs offers no token-revocation API: full revocation is
 * the user removing TraxWax under Discogs Settings → Applications (the UI says so). */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';

// #52: fail CLOSED — no dev fallback. Prod always sets these; an unset value (misconfigured deploy / a new
// preview env) must refuse, never silently accept dev-issued tokens against production data.
const CLERK_ISSUER = Deno.env.get('CLERK_ISSUER');
const APP_ORIGIN   = Deno.env.get('APP_ORIGIN');
if (!CLERK_ISSUER || !APP_ORIGIN) throw new Error('CLERK_ISSUER and APP_ORIGIN env vars are required');

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

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await admin.rpc('unlink_discogs_account', { p_user_id: userId });
  if (error) {
    console.error('unlink rpc failed:', error.message);
    return json({ error: 'store_failed' }, 500);
  }
  const status = (data as { status?: string })?.status;
  if (status === 'ok') return json({ ok: true });
  if (status === 'no_profile') return json({ error: 'no_profile' }, 409);
  console.error('unlink rpc unexpected status:', status);
  return json({ error: 'store_failed' }, 500);
}
