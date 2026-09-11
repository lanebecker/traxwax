/* Phase 2 (#8): delete everything TraxWax stores about the caller. TRAXWAX DATA ONLY —
 * the Clerk identity is shared across (future) apps and is never deleted here (Lane,
 * 2026-08-29). The browser signs the user out after this succeeds. The typed-confirmation
 * is re-checked server-side so a scripted or accidental call cannot destroy data with a
 * bare POST. */

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
