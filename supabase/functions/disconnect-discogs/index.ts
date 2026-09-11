/* Phase 2 (#8): unlink Discogs. Deletes the encrypted credential, the imported collection
 * (Restricted Data tied to the connection — 0006's re-link rule, applied to disconnect),
 * any in-flight handshake state and pending links; resets the profile to never-connected.
 * The RPC is one transaction. Discogs offers no token-revocation API: full revocation is
 * the user removing TraxWax under Discogs Settings → Applications (the UI says so). */

import 'jsr:@supabase/functions-js@2.115.0/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2.116.0';
import { CORS, json, verifyClerk } from '../_shared/auth.ts';   // E1 (#99): the ONE auth/CORS preamble



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
  const auth = await verifyClerk(req);   // E1 (#99): shared verifier — sub or a ready 401
  if ('response' in auth) return auth.response;
  const userId = auth.userId;

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
