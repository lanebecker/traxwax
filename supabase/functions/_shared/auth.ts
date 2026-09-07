/* _shared/auth.ts — E1 (#99, audit v1.25): THE one copy of the Clerk-verification + CORS
 * preamble that used to be pasted verbatim into all eight authenticated functions. The
 * realized cost of the copies was B1 (#69): policy change #52 was applied by hand to N
 * files and missed one — the connect callback kept a dev APP_ORIGIN fallback for months.
 * From here on, a policy change to auth/CORS/fail-closed behavior is ONE edit + redeploys.
 *
 * verify_jwt is FALSE at the platform gate for every function that imports this (Supabase's
 * gate can't validate Clerk RS256); verifyClerk() below is the ONLY source of identity —
 * signature + issuer + expiry via Clerk's JWKS, identity only from the verified `sub`.
 * NOTHING may derive a user id any other way: decoding without verifying would let anyone
 * forge {"sub": "<someone else>"}.
 *
 * #52: fail CLOSED at module load — no dev fallback, ever. Prod always sets these; an unset
 * value (misconfigured deploy / a new preview env) must refuse, never silently accept
 * dev-issued tokens against production data. This module-level throw 503s the function.
 *
 * azp: Clerk stamps it with the origin the token was minted for. Reject tokens minted for
 * another site; tolerate absence, per Clerk's guidance — defense-in-depth only (#77 records
 * the trigger to REQUIRE it: the day a second app joins this Clerk instance). */

import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';

export const CLERK_ISSUER = Deno.env.get('CLERK_ISSUER');
export const APP_ORIGIN   = Deno.env.get('APP_ORIGIN');
if (!CLERK_ISSUER || !APP_ORIGIN) throw new Error('CLERK_ISSUER and APP_ORIGIN env vars are required');

const JWKS = createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`));

export const CORS = {
  'Access-Control-Allow-Origin': APP_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/** Verify the request's Clerk bearer token. Returns { userId } on success, or { response }
 *  carrying the ready 401 (same bodies/statuses the eight inline copies produced:
 *  missing_token / invalid_token). Usage:
 *    const auth = await verifyClerk(req);
 *    if ('response' in auth) return auth.response;
 *    const userId = auth.userId;                                                    */
export async function verifyClerk(req: Request): Promise<{ userId: string } | { response: Response }> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return { response: json({ error: 'missing_token' }, 401) };
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: CLERK_ISSUER });
    if (!payload.sub) throw new Error('no sub claim');
    if (payload.azp && payload.azp !== APP_ORIGIN) throw new Error('azp mismatch');
    return { userId: payload.sub };
  } catch (e) {
    console.error('clerk token rejected:', (e as Error).message);
    return { response: json({ error: 'invalid_token' }, 401) };
  }
}
