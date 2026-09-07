/* Phase 2 (#8): completes a pending Discogs link. Closes the Stage B link-CSRF: requires
 * BOTH possession of the one-time code (delivered only to the browser that received the
 * Discogs redirect, via URL fragment) AND a verified Clerk sub equal to the pending row's
 * user_id. Lookup is by code hash — lookup-by-sub is the broken design (the attacker's
 * own sub matches their own state row; see docs/phase-2-account-plan.md).
 *
 * verify_jwt false + the shared verifyClerk (_shared/auth.ts), per Stage B C-1. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { CORS, json, verifyClerk } from '../_shared/auth.ts';   // E1 (#99): the ONE auth/CORS preamble
import { sha256hex } from '../_shared/discogs.ts';



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
