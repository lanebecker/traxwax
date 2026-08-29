/* Phase 2 (#8): delete everything TraxWax stores about the caller. TRAXWAX DATA ONLY —
 * the Clerk identity is shared across (future) apps and is never deleted here (Lane,
 * 2026-08-29). The browser signs the user out after this succeeds. The typed-confirmation
 * is re-checked server-side so a scripted or accidental call cannot destroy data with a
 * bare POST. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';

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

  let confirm = '';
  try {
    const body = JSON.parse(await req.text());
    confirm = String(body.confirm ?? '');
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (confirm !== 'DELETE') return json({ error: 'confirm_required' }, 400);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await admin.rpc('delete_account', { p_user_id: userId });
  if (error) {
    console.error('delete rpc failed:', error.message);
    return json({ error: 'store_failed' }, 500);
  }
  if ((data as { status?: string })?.status === 'ok') return json({ ok: true });
  console.error('delete rpc unexpected status:', (data as { status?: string })?.status);
  return json({ error: 'store_failed' }, 500);
}
