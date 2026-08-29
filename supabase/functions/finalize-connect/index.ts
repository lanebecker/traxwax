/* Phase 2 (#8): completes a pending Discogs link. Closes the Stage B link-CSRF: requires
 * BOTH possession of the one-time code (delivered only to the browser that received the
 * Discogs redirect, via URL fragment) AND a verified Clerk sub equal to the pending row's
 * user_id. Lookup is by code hash — lookup-by-sub is the broken design (the attacker's
 * own sub matches their own state row; see docs/phase-2-account-plan.md).
 *
 * verify_jwt false + in-handler jose.jwtVerify, per Stage B C-1. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';
import { sha256hex } from '../_shared/discogs.ts';

// Audit #31: env-first so the production flip is a secret change, not a redeploy.
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

  let code: string;
  try {
    const body = JSON.parse(await req.text());
    code = String(body.code ?? '');
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  // 32 random bytes as hex. Reject other shapes before hashing; never log the value.
  if (!/^[0-9a-f]{64}$/.test(code)) return json({ error: 'bad_request' }, 400);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await admin.rpc('finalize_discogs_link', {
    p_sub: userId,
    p_code_hash: await sha256hex(code),
  });
  if (error) {
    console.error('finalize rpc failed:', error.message);
    return json({ error: 'store_failed' }, 500);
  }

  const status = (data as { status?: string; username?: string })?.status;
  if (status === 'ok') return json({ ok: true, username: (data as { username?: string }).username });
  if (status === 'no_pending')     return json({ error: 'no_pending' }, 409);
  if (status === 'link_not_yours') { console.error('finalize sub mismatch (possible CSRF attempt)'); return json({ error: 'link_not_yours' }, 403); }
  if (status === 'handle_taken')   return json({ error: 'handle_taken' }, 409);
  if (status === 'no_profile')     return json({ error: 'no_profile' }, 409);
  console.error('finalize rpc unexpected status:', status);
  return json({ error: 'store_failed' }, 500);
}
