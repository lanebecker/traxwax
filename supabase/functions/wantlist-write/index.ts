/* Wave 2 Stage B2: the first Discogs WRITE. Adds/removes one release on the CALLER's Discogs
 * wantlist, then mirrors the change into public.wantlist_items so badges/counts reflect it.
 *
 * Identity: same pattern as import-collection. verify_jwt is FALSE at the platform gate (it can't
 * validate Clerk RS256); jwtVerify below is the ONLY source of user id. Every row read/written is
 * scoped to that verified user. Discogs is the source of truth: we write there first and mirror only
 * on success. PLAINTEXT OAuth 1.0a does not sign the method or URL, so the same header signs PUT/DELETE. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';
import { DISCOGS_UA, oauthHeader, nonce, timestamp, decrypt }
  from '../_shared/discogs.ts';

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
  // ── Identity first ──
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

  const consumerKey = Deno.env.get('DISCOGS_CONSUMER_KEY');
  const consumerSecret = Deno.env.get('DISCOGS_CONSUMER_SECRET');
  const encKey = Deno.env.get('DISCOGS_TOKEN_ENC_KEY');
  if (!consumerKey || !consumerSecret || !encKey) return json({ error: 'not_configured' }, 500);

  // ── Input: { release_id, action: 'add'|'remove' }. No client-supplied catalog content — the add path
  //    seeds server-authoritatively (see below). ──
  let body: { release_id?: unknown; action?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const releaseId = Number(body.release_id);
  const action = body.action === 'add' ? 'add' : body.action === 'remove' ? 'remove' : null;
  if (!Number.isInteger(releaseId) || releaseId < 1 || !action) {
    return json({ error: 'bad_request' }, 400);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── The caller's own credentials + username ──
  const { data: prof } = await admin.from('profiles')
    .select('discogs_username').eq('user_id', userId).maybeSingle();
  const { data: cred } = await admin.from('discogs_credentials')
    .select('oauth_token, oauth_token_secret').eq('user_id', userId).maybeSingle();
  if (!prof?.discogs_username || !cred) return json({ error: 'not_connected' }, 409);

  let userToken: string, userSecret: string;
  try {
    userToken = await decrypt(cred.oauth_token, encKey);
    userSecret = await decrypt(cred.oauth_token_secret, encKey);
  } catch (e) {
    console.error('credential decrypt failed:', (e as Error).message);
    return json({ error: 'credentials_unreadable' }, 500);
  }

  const wantUrl = `https://api.discogs.com/users/${encodeURIComponent(prof.discogs_username)}` +
    `/wants/${releaseId}`;
  const authHeader = oauthHeader({
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce(),
    oauth_token: userToken,
    oauth_signature: `${consumerSecret}&${userSecret}`,
    oauth_signature_method: 'PLAINTEXT',
    oauth_timestamp: timestamp(),
  });

  if (action === 'add') {
    // FK guard, SERVER-AUTHORITATIVE. The release nearly always already exists in the shared catalog
    // (the card was rendered from it). If it exists, do nothing. If it is genuinely absent, fetch its
    // basics from Discogs (authoritative) and seed — NEVER trust client-supplied catalog content, which
    // seed_releases (0010) would MERGE over the shared row (cross-user catalog defacement).
    const { data: existing, error: exErr } = await admin.from('releases')
      .select('release_id').eq('release_id', releaseId).maybeSingle();
    if (exErr) {
      console.error('release lookup failed:', exErr.message);
      return json({ error: 'store_failed' }, 500);
    }
    if (!existing) {
      // Rare in B2 (every displayed card is already in the catalog); future-proofs add-from-search.
      // Fresh nonce for a distinct request; PLAINTEXT doesn't require it but it's tidy.
      const relRes = await fetch(`https://api.discogs.com/releases/${releaseId}`, {
        headers: {
          'User-Agent': DISCOGS_UA,
          Authorization: oauthHeader({
            oauth_consumer_key: consumerKey,
            oauth_nonce: nonce(),
            oauth_token: userToken,
            oauth_signature: `${consumerSecret}&${userSecret}`,
            oauth_signature_method: 'PLAINTEXT',
            oauth_timestamp: timestamp(),
          }),
        },
      });
      if (!relRes.ok) {
        console.error('discogs release fetch failed, status', relRes.status);
        return json({ error: 'discogs_failed', status: relRes.status }, 502);
      }
      let rel: Record<string, unknown>;
      try { rel = JSON.parse(await relRes.text()); }
      catch { console.error('discogs release non-JSON'); return json({ error: 'discogs_failed' }, 502); }
      const seed = {
        release_id: releaseId,
        artist: ((rel.artists as Array<{ name?: string }>) ?? [])
          .map((a) => (a.name ?? '').replace(/\s*\(\d+\)\s*$/, '').trim()).filter(Boolean).join(', '),
        title: String(rel.title ?? '').trim(),
        year: Number(rel.year ?? 0) || 0,
        label: ((rel.labels as Array<{ name?: string }>) ?? [])[0]?.name ?? '',
        styles: (rel.styles as string[]) ?? [],
        genres: (rel.genres as string[]) ?? [],
        thumb: String((rel.thumb as string) ?? ''),
        cover_image: String((rel.cover_image as string) ?? ''),
      };
      const { error: seedErr } = await admin.rpc('seed_releases', { p_rows: [seed] });
      if (seedErr) {
        console.error('release seed failed:', seedErr.message);
        return json({ error: 'store_failed' }, 500);
      }
    }

    const res = await fetch(wantUrl, {
      method: 'PUT',
      headers: { 'User-Agent': DISCOGS_UA, Authorization: authHeader },
    });
    // Discogs returns 201 (created) — or 200/201 if it was already on the wantlist (idempotent).
    if (!res.ok) {
      console.error('discogs wantlist add failed, status', res.status);
      return json({ error: 'discogs_failed', status: res.status }, 502);
    }

    const { error: upErr } = await admin.from('wantlist_items').upsert(
      { user_id: userId, release_id: releaseId, added: new Date().toISOString().slice(0, 10) },
      { onConflict: 'user_id,release_id' },
    );
    if (upErr) {
      console.error('wantlist_items upsert failed:', upErr.message);
      return json({ error: 'store_failed' }, 500);
    }
    return json({ ok: true, action, release_id: releaseId });
  }

  // action === 'remove'
  const res = await fetch(wantUrl, {
    method: 'DELETE',
    headers: { 'User-Agent': DISCOGS_UA, Authorization: authHeader },
  });
  // 204 = removed; 404 = it wasn't on the wantlist — treat as already-removed (idempotent).
  if (!res.ok && res.status !== 404) {
    console.error('discogs wantlist remove failed, status', res.status);
    return json({ error: 'discogs_failed', status: res.status }, 502);
  }

  const { error: delErr } = await admin.from('wantlist_items')
    .delete().eq('user_id', userId).eq('release_id', releaseId);
  if (delErr) {
    console.error('wantlist_items delete failed:', delErr.message);
    return json({ error: 'store_failed' }, 500);
  }
  return json({ ok: true, action, release_id: releaseId });
}
