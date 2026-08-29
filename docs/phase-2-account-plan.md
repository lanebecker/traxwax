# Phase 2 — Account controls: disconnect, deletion, authenticated finalize

**Rev 2 — 2026-08-29 (rev 1 audited by an independent verifier; findings folded in — see
Audit record at the bottom). Closes GitHub issue #8** (cold audit #30; Stage B Open items 3 & 6;
Stage C Open item 4; Stage D Open item 6).

Three deliverables, one plan, because they share a migration and a UI surface:

1. **Disconnect Discogs** — a user-facing way to unlink, deleting the credential and the
   imported collection (Restricted Data tied to the connection, same rule migration 0006
   applies to re-linking a different account).
2. **Account deletion** — purge everything TraxWax stores about the user. **TraxWax data
   only** (locked decision, Lane 2026-08-29): the Clerk identity is shared infrastructure
   for future apps and is never deleted by TraxWax. Per-app membership is indicated by each
   app's own DB row — a TraxWax `profiles` row *is* "signed up for TraxWax".
3. **Authenticated finalize** — closes the accepted link-CSRF (Stage B round-2 M-2): the
   OAuth callback stores the completed link as *pending* and only a signed-in browser
   possessing a one-time code can complete it.

## Locked decisions (Lane, 2026-08-29)

- UI: an **ACCOUNT** button next to RE-SYNC in the header (DB mode only) opening a modal —
  connected-as line, DISCONNECT DISCOGS, danger-zone DELETE MY TRAXWAX DATA with typed
  `DELETE` confirmation.
- Disconnect confirm copy states plainly that the imported collection is removed and
  reconnecting re-imports it; full revocation additionally happens in Discogs settings.
- Deletion never touches the Clerk user. Copy says the sign-in identity survives.

## Why `sub == state.user_id` alone does NOT close the CSRF — the actual design

The Stage B sketch said "verified `sub` must equal the state row's `user_id`". **That check
alone is insufficient**: in the attack, the state row's `user_id` IS the attacker's (they
started the flow legitimately), so the attacker's own `sub` matches and they can finalize
the victim's token from their own browser. The fix needs proof of *both*:

- **Possession**: a one-time `twcode` delivered ONLY in the URL fragment of the callback
  redirect — i.e., only to the browser where the Discogs approval happened. Fragments are
  never sent to any server and never appear in Pages/function logs.
- **Identity**: the finalize endpoint verifies the Clerk JWT and requires the pending row's
  `user_id` to equal the verified `sub`.

Lookup is **by code hash**, then the sub check — never lookup-by-sub (that is the broken
sketch). Attack replay: attacker starts flow → victim approves → callback stores pending
under *attacker's* user_id, code lands in *victim's* fragment. Victim's finalize: code
matches, sub ≠ row.user_id → row consumed, `link_not_yours`, nothing links. Attacker's
finalize: right sub, no code → cannot even address the row. Closed. (Rev1-F4: a victim
who ALREADY has Discogs connected never reaches the verify handler — the pending row is
then simply never consumed and expires in 15 minutes; the stale sessionStorage code is
overwritten by the next capture. Safe in that branch too.)

Only the SHA-256 hash of the code is stored, so a DB read cannot finalize either.

## Confirmed facts (measured before writing)

- `connect-discogs-callback/index.ts` today calls `link_discogs_account` directly and
  302-redirects to `/app?connect=<status>`; `back()` is the only response helper.
- `boot.js` `render()` reads `?connect=` from `location.search` into `CONNECT_ERRORS`
  only when `profile.discogs_username` is null; `_pipeCall(path, payload)` does
  JWT-authenticated POSTs to Edge Functions and throws `Error(d.error)` on non-ok.
- Clerk components use hash routing (documented in boot.js header comment) — so a code
  left in `location.hash` across a sign-in can be destroyed. The code is therefore
  captured into `sessionStorage` at `boot()` before `Clerk.load()`.
- `discogs_oauth_state`: `oauth_token` PK, `oauth_token_secret not null`, expiry sweep in
  connect-discogs leg 1. `link_discogs_account` (0006) raises `23505` on handle collision
  and `P0002` (= `no_data_found`) on missing profile.
- `import_status='error'` dead-end notice in boot.js says "a reconnect flow is coming" —
  this plan delivers it (Task 7 wires a disconnect button into that notice).
- **To verify in Task 1 before writing deletes** (expected: only the 0005 releases FK):
  `select conname, confrelid::regclass from pg_constraint where conrelid = 'public.collection_items'::regclass and contype = 'f';`
- Edge deploys use file layout `{<fn>/index.ts, _shared/discogs.ts}`, entrypoint
  `<fn>/index.ts`, `verify_jwt: false` with in-handler `jose.jwtVerify` (Stage B C-1).
- plpgsql: an UNCAUGHT exception aborts the whole statement's transaction (a prior
  consume-DELETE included); a CAUGHT one rolls back only the nested block's
  subtransaction. The finalize RPC therefore **returns status jsonb instead of raising**,
  with the `link_discogs_account` call wrapped in a nested block catching
  `unique_violation` (the 0002 unique index raises 23505 through 0006's RPC) and
  `no_data_found` (0006 raises `errcode='P0002'`, which IS `no_data_found`) — so the
  consume survives every terminal outcome.

---

## Task 1 — Migration `supabase/migrations/0009_account_controls.sql`

First run the FK probe above and confirm only the releases FK exists (if a profiles FK
exists, STOP and re-plan the delete order). Then apply exactly:

```sql
-- 0009_account_controls.sql — Phase 2: disconnect, account deletion, authenticated
-- finalize (GitHub #8; closes the Stage B link-CSRF acceptance).

-- ── Pending links: the callback parks a completed OAuth result here; only a browser
--    holding the one-time code AND signed in as the flow starter can finalize it.
--    RLS on, ZERO policies: service_role only, like discogs_credentials.
create table if not exists public.discogs_pending_links (
  user_id                 text primary key,
  discogs_username        text not null,
  oauth_token_enc         text not null,
  oauth_token_secret_enc  text not null,
  finalize_code_hash      text not null unique,
  created_at              timestamptz not null default now(),
  expires_at              timestamptz not null default (now() + interval '15 minutes')
);
alter table public.discogs_pending_links enable row level security;

-- ── Finalize. Lookup BY CODE HASH (possession), then sub equality (identity) — see the
--    plan's CSRF section for why lookup-by-sub is the broken design. Returns status
--    jsonb, never raises: a raise would roll back the consume-delete.
create or replace function public.finalize_discogs_link(p_sub text, p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.discogs_pending_links%rowtype;
begin
  delete from public.discogs_pending_links where expires_at < now();

  -- ATOMIC consume, keyed on the code hash (audit rev1-F2: a select-then-delete lets two
  -- concurrent finalize calls both pass the existence check — the exact race the
  -- callback's own state-consume comment warns about — and deleting by user_id could
  -- destroy a NEWER pending row while finalizing a stale one). The sweep above makes an
  -- expired row a lookup miss, so expired uniformly reports no_pending.
  -- (The UNIQUE constraint on finalize_code_hash keeps this in the ≤1-row regime;
  -- a multi-row RETURNING INTO would raise, uncaught — a safe, unreachable failure.)
  delete from public.discogs_pending_links
   where finalize_code_hash = p_code_hash
  returning * into v;
  if not found then
    return jsonb_build_object('status', 'no_pending');
  end if;

  if v.user_id is distinct from p_sub then
    return jsonb_build_object('status', 'link_not_yours');
  end if;

  begin
    perform public.link_discogs_account(
      v.user_id, v.discogs_username, v.oauth_token_enc, v.oauth_token_secret_enc);
  exception
    when unique_violation then return jsonb_build_object('status', 'handle_taken');
    when no_data_found    then return jsonb_build_object('status', 'no_profile');
  end;

  return jsonb_build_object('status', 'ok', 'username', v.discogs_username);
end;
$$;

-- ── Disconnect: credential + imported items + any in-flight handshake/pending link go;
--    the profile survives, reset to the never-connected shape (0006's re-link rule,
--    generalized: ownership rows are Restricted Data tied to the connection).
create or replace function public.unlink_discogs_account(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where user_id = p_user_id) then
    return jsonb_build_object('status', 'no_profile');
  end if;
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  update public.profiles
     set discogs_username     = null,
         discogs_connected_at = null,
         last_import_at       = null,
         import_status        = 'idle'
   where user_id = p_user_id;
  return jsonb_build_object('status', 'ok');
end;
$$;

-- ── Account deletion: everything TraxWax stores, profile row included. The Clerk user
--    is deliberately untouched (shared identity across future apps — Lane 2026-08-29).
--    The shared releases catalog is CC0 and unaffected.
create or replace function public.delete_account(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existed boolean;
begin
  v_existed := exists (select 1 from public.profiles where user_id = p_user_id);
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  delete from public.profiles              where user_id = p_user_id;
  return jsonb_build_object('status', 'ok', 'existed', v_existed);
end;
$$;

revoke execute on function public.finalize_discogs_link(text, text)
  from public, anon, authenticated;
revoke execute on function public.unlink_discogs_account(text)
  from public, anon, authenticated;
revoke execute on function public.delete_account(text)
  from public, anon, authenticated;
grant execute on function public.finalize_discogs_link(text, text) to service_role;
grant execute on function public.unlink_discogs_account(text)      to service_role;
grant execute on function public.delete_account(text)              to service_role;
```

**Verify after apply** (expected values in comments):

```sql
select
  (select relrowsecurity from pg_class where oid='public.discogs_pending_links'::regclass) as rls_on,          -- true
  (select count(*) from pg_policies where tablename='discogs_pending_links') as policies,                      -- 0
  (select array_agg(distinct grantee order by grantee) from information_schema.routine_privileges
    where routine_schema='public'
      and routine_name in ('finalize_discogs_link','unlink_discogs_account','delete_account')) as grantees;    -- {postgres,service_role}
```

## Task 2 — `sha256hex` in `supabase/functions/_shared/discogs.ts`

Append at end of file:

```ts
/** SHA-256 as lowercase hex. The finalize code is stored only as this hash, so a DB read
    cannot complete a pending link. */
export async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

## Task 3 — `connect-discogs-callback/index.ts`: park as pending, deliver the code

Edit 3a — extend the import line:

```ts
import { DISCOGS_UA, oauthHeader, nonce, timestamp, parseForm, fieldNames, encrypt, selfTest, sha256hex }
  from '../_shared/discogs.ts';
```

Edit 3b — replace the whole block from `// One transaction: profile link + encrypted
credentials, or neither.` down to the final `return back('ok');` with:

```ts
  // Phase 2 (#8): the link is no longer completed here. The callback cannot know WHICH
  // signed-in TraxWax user is standing at this browser (no Authorization header on a
  // redirect), and completing the link on state.user_id alone is the accepted link-CSRF.
  // Park the result as PENDING and hand the browser a one-time code in the URL FRAGMENT —
  // fragments never reach a server or a log. finalize-connect completes the link only for
  // a verified Clerk sub that both matches the pending row AND presents this code.
  const codeBytes = crypto.getRandomValues(new Uint8Array(32));
  const code = [...codeBytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  const { error: pendErr } = await admin.from('discogs_pending_links').upsert({
    user_id: state.user_id,
    discogs_username: identity.username,
    oauth_token_enc: await encrypt(access.oauth_token, encKey),
    oauth_token_secret_enc: await encrypt(access.oauth_token_secret, encKey),
    finalize_code_hash: await sha256hex(code),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  }, { onConflict: 'user_id' });

  if (pendErr) {
    console.error('pending store failed:', pendErr.message);
    return back('store_failed');
  }

  // NOT back(): the code rides the fragment, which back() has no slot for.
  return new Response(null, {
    status: 302,
    headers: { Location: `${APP_ORIGIN}/app?connect=verify#twcode=${code}` },
  });
```

(The upsert sets `created_at`/`expires_at` explicitly rather than relying on defaults:
an upsert over a stale row would otherwise keep the OLD timestamps.)

`handle_taken` / `no_profile` mapping moves to finalize; the callback no longer produces
`ok`, `handle_taken`, or `no_profile`. All earlier failure paths are unchanged.

## Task 4 — NEW `supabase/functions/finalize-connect/index.ts`

Complete file. Deploy with files `{finalize-connect/index.ts, _shared/discogs.ts}`,
entrypoint `finalize-connect/index.ts`, `verify_jwt: false`.

```ts
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
```

## Task 5 — NEW `supabase/functions/disconnect-discogs/index.ts`

Complete file. Same deploy shape as Task 4 (files `{disconnect-discogs/index.ts,
_shared/discogs.ts}` — the shared file is unused here but keeps the deploy layout uniform;
drop it if the deploy tool complains about unused files).

```ts
/* Phase 2 (#8): unlink Discogs. Deletes the encrypted credential, the imported collection
 * (Restricted Data tied to the connection — 0006's re-link rule, applied to disconnect),
 * any in-flight handshake state and pending links; resets the profile to never-connected.
 * The RPC is one transaction. Discogs offers no token-revocation API: full revocation is
 * the user removing TraxWax under Discogs Settings → Applications (the UI says so). */

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
```

## Task 6 — NEW `supabase/functions/delete-account/index.ts`

Complete file. Same deploy shape.

```ts
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
```

## Task 7 — `public/boot.js` edits

**7a — capture the finalize code before Clerk can touch the hash.** In `boot()`,
immediately after `initThemeEarly();` insert:

```js
  // Phase 2 (#8): the OAuth callback delivers a one-time finalize code in the URL
  // FRAGMENT (never sent to a server, never logged). Clerk's components use hash routing
  // and can rewrite location.hash during sign-in, so capture the code into sessionStorage
  // and strip it from the URL BEFORE Clerk loads. sessionStorage (not a variable):
  // a signed-out user completes sign-in on this same tab and the code must survive it.
  try {
    const m = (window.location.hash || '').match(/twcode=([0-9a-f]{64})/);
    if (m) {
      sessionStorage.setItem('tw_finalize_code', m[1]);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  } catch (e) { /* sessionStorage unavailable → the verify handler reports no_pending */ }
```

**7b — the verify handler.** In `render()`, inside the `if (!profile.discogs_username) {`
branch, insert at the very top (before `const CONNECT_ERRORS = {`):

```js
    // Phase 2 (#8): finish a parked link. Possession (the code) + identity (this JWT)
    // are both proven by finalize-connect; see docs/phase-2-account-plan.md.
    if (new URLSearchParams(window.location.search).get('connect') === 'verify') {
      let code = null;
      try { code = sessionStorage.getItem('tw_finalize_code'); } catch (e) {}
      if (code) {
        notice('Finishing the link', 'Confirming this connection belongs to you…', false);
        let failStatus = null;
        try {
          await _pipeCall('finalize-connect', { code });
        } catch (e) {
          failStatus = (e && e.message) || 'store_failed';
        }
        try { sessionStorage.removeItem('tw_finalize_code'); } catch (e) {}
        if (!failStatus) {
          // Clean URL + full reload: profile refetch shows the username, routing sends
          // the user to their crate, and the import gate takes over exactly as before.
          window.location.replace('/app');
          return;
        }
        window.location.replace('/app?connect=' + encodeURIComponent(failStatus));
        return;
      }
      // Arrived on ?connect=verify with no stored code (history revisit, cleared
      // storage): treat as a used/expired link.
      window.location.replace('/app?connect=no_pending');
      return;
    }
```

**7c — new error strings.** In `CONNECT_ERRORS`, add two entries after `unknown_or_used`:

```js
      no_pending: 'That connection link was already used or has expired. Try again.',
      link_not_yours: 'That connection was started from a different account, so it was ' +
        'discarded for safety. Click Connect below to link your own Discogs.',
```

**7d — the ACCOUNT modal.** Add at module level (after the `runImport` function ends):

```js
/* Phase 2 (#8): the ACCOUNT modal. Rendered as its own overlay OUTSIDE #app so app.js
   re-renders cannot destroy it. Opened via window.TraxWaxAccount (installed below);
   app.js's header ACCOUNT button calls it. */
function openAccountModal() {
  if (document.getElementById('tw-account-ov')) return;
  const owner = window.TraxWaxOwner || {};
  // Rev1-F7: derive the username only when ownerLine carries one; the null-username form
  // ("Your shelf · filed by whim") is unreachable here (the crate loads only after
  // discogs_username is set) but must not display as a fake handle if that ever changes.
  const unameMatch = (owner.ownerLine || '').match(/^(.*)'s shelf/);
  const uname = unameMatch ? unameMatch[1] : 'your Discogs account';
  const mono = "font-family:'IBM Plex Mono',monospace;";
  const ov = document.createElement('div');
  ov.id = 'tw-account-ov';
  ov.style.cssText = 'position:fixed; inset:0; background:rgba(10,10,12,.62); ' +
    'display:flex; align-items:flex-start; justify-content:center; padding:80px 20px; ' +
    'overflow:auto; z-index:60';
  ov.innerHTML =
    '<div id="tw-account-box" style="position:relative; width:520px; max-width:100%; ' +
    'background:var(--panel); border:1.5px solid var(--line); ' +
    'box-shadow:8px 8px 0 rgba(0,0,0,.4); padding:24px; color:var(--ink)">' +
    '<button id="tw-acct-close" title="Close" style="position:absolute; top:12px; right:12px; ' +
    'width:28px; height:28px; border:1.5px solid var(--line); background:var(--panel); ' +
    mono + ' font-size:12px; cursor:pointer">✕</button>' +
    '<div style="font-family:Anton,sans-serif; font-size:26px; color:var(--accent); ' +
    'margin-bottom:6px">YOUR ACCOUNT</div>' +
    '<div style="' + mono + ' font-size:11px; color:var(--muted); margin-bottom:20px">' +
    'Connected to Discogs as <b>' + esc(uname) + '</b></div>' +
    '<div id="tw-acct-msg" style="' + mono + ' font-size:11.5px; color:var(--accent); ' +
    'line-height:1.6; margin-bottom:14px"></div>' +
    '<div style="border:1.5px solid var(--line); padding:16px; margin-bottom:18px">' +
    '<div style="' + mono + ' font-size:11px; line-height:1.7; color:var(--muted); ' +
    'margin-bottom:12px">Disconnecting removes your imported collection from TraxWax. ' +
    'Your Discogs account is untouched, and reconnecting re-imports everything in about ' +
    'a minute. To fully revoke TraxWax’s access, also remove it under ' +
    'Discogs → Settings → Applications.</div>' +
    '<button id="tw-acct-disc" style="' + mono + ' font-size:11px; font-weight:700; ' +
    'letter-spacing:.08em; padding:9px 14px; border:1.5px solid var(--line); ' +
    'background:var(--panel); color:var(--ink); cursor:pointer">DISCONNECT DISCOGS</button>' +
    '</div>' +
    '<div style="border:1.5px solid var(--accent); padding:16px">' +
    '<div style="' + mono + ' font-size:11px; line-height:1.7; color:var(--muted); ' +
    'margin-bottom:12px">Deleting removes everything TraxWax stores about you — profile, ' +
    'imported collection, Discogs connection. Your sign-in identity is <b>not</b> deleted ' +
    'and keeps working for other apps. Type <b>DELETE</b> to confirm.</div>' +
    '<div style="display:flex; gap:8px">' +
    '<input id="tw-acct-confirm" placeholder="DELETE" autocomplete="off" style="' + mono +
    ' font-size:11px; padding:8px 10px; width:110px; background:var(--panel); ' +
    'color:var(--ink); border:1.5px solid var(--line); border-radius:0" />' +
    '<button id="tw-acct-del" disabled style="' + mono + ' font-size:11px; font-weight:700; ' +
    'letter-spacing:.08em; padding:9px 14px; border:1.5px solid var(--line); ' +
    'background:var(--accent); color:var(--on-accent); cursor:pointer; opacity:.45">' +
    'DELETE MY TRAXWAX DATA</button>' +
    '</div></div></div>';
  document.body.appendChild(ov);

  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.getElementById('tw-acct-close').addEventListener('click', close);

  const msg = (t) => { const el = document.getElementById('tw-acct-msg'); if (el) el.textContent = t; };

  const disc = document.getElementById('tw-acct-disc');
  let discArmed = false;
  disc.addEventListener('click', async () => {
    if (!discArmed) {
      discArmed = true;
      disc.textContent = 'REALLY DISCONNECT — REMOVES IMPORTED COLLECTION';
      return;
    }
    disc.disabled = true;
    disc.textContent = 'DISCONNECTING…';
    try {
      await _pipeCall('disconnect-discogs', {});
      // Full reload: routing sees discogs_username null → the connect card.
      window.location.href = '/app';
    } catch (e) {
      disc.disabled = false;
      disc.textContent = 'DISCONNECT DISCOGS';
      discArmed = false;
      msg('Disconnect failed (' + ((e && e.message) || e) + '). Try again.');
    }
  });

  const confirmInput = document.getElementById('tw-acct-confirm');
  const delBtn = document.getElementById('tw-acct-del');
  confirmInput.addEventListener('input', () => {
    const ok = confirmInput.value === 'DELETE';
    delBtn.disabled = !ok;
    delBtn.style.opacity = ok ? '1' : '.45';
  });
  delBtn.addEventListener('click', async () => {
    if (confirmInput.value !== 'DELETE') return;
    delBtn.disabled = true;
    delBtn.textContent = 'DELETING…';
    try {
      await _pipeCall('delete-account', { confirm: 'DELETE' });
      msg('Deleted. Signing you out…');
      await window.Clerk.signOut();   // afterSignOutUrl '/' lands on the landing page
    } catch (e) {
      delBtn.disabled = false;
      delBtn.textContent = 'DELETE MY TRAXWAX DATA';
      msg('Deletion failed (' + ((e && e.message) || e) + '). Try again.');
    }
  });
}
```

**7e — install the provider.** In `installCrateProviders(profile)`, after
`window.TraxWaxOwner = ownerInfo(profile);` add:

```js
  window.TraxWaxAccount = openAccountModal;
```

**7f — the `import_status === 'error'` dead end gets its promised exit.** Replace the
existing notice block:

```js
  if (profile.import_status === 'error') {
    notice('Import needs attention',
      'Your stored Discogs connection could not be read, so importing is paused.<br><br>' +
      'This is on us — a reconnect flow is coming. Nothing of yours is lost.', true);
    return;
  }
```

with:

```js
  if (profile.import_status === 'error') {
    notice('Import needs attention',
      'Your stored Discogs connection could not be read, so importing is paused.<br><br>' +
      'Disconnect and reconnect to fix it — your Discogs account itself is fine.<br><br>' +
      '<button id="tw-err-disc" style="padding:10px 16px; border:1.5px solid var(--line); ' +
      'cursor:pointer; background:var(--accent); color:var(--on-accent); ' +
      "font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:700; " +
      'letter-spacing:.1em">DISCONNECT DISCOGS</button>', true);
    const b = document.getElementById('tw-err-disc');
    if (b) b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'DISCONNECTING…';
      try { await _pipeCall('disconnect-discogs', {}); window.location.href = '/app'; }
      catch (e) { b.disabled = false; b.textContent = 'DISCONNECT DISCOGS'; console.error(e); }
    });
    return;
  }
```

## Task 8 — `public/app.js` edits

**8a — header button.** In `render()`'s header, the RE-SYNC line currently reads:

```js
        ${DB_MODE()?`<button data-act="resync" title="${esc(_lastSyncedLabel())}" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:7px 11px; background:#fff; color:#16171a; border:1.5px solid #16171a">${state._resyncing?'SYNCING…':'RE-SYNC'}</button>`:''}
```

Insert directly after it:

```js
        ${DB_MODE()?`<button data-act="account" title="Manage your account" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:7px 11px; background:#fff; color:#16171a; border:1.5px solid #16171a">ACCOUNT</button>`:''}
```

**8b — click case.** In `onClick`'s `switch`, after `case 'resync': _resync(); break;` add:

```js
    case 'account': if(window.TraxWaxAccount) window.TraxWaxAccount(); break;
```

## Task 9 — Verification battery

1. `node --check public/app.js` (no imports there); boot.js is a module, so
   `npx esbuild --loader:.js=js public/boot.js --outfile=/dev/null` instead of
   `node --check`; `npx esbuild --loader:.ts=ts <each function> --outfile=/dev/null`.
2. **Forged token → 401** on all three new functions. The probe, spelled out (rev1-F1:
   nothing in the repo contains it): from a browser tab at https://traxwax.com run
   `fetch('https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/<fn>', {method:'POST',
   headers:{Authorization:'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX2ZvcmdlZCJ9.Zm9yZ2Vk'}})`
   — expect status 401, body `{"error":"invalid_token"}` (proves the bundle booted AND
   JWKS verification runs).
3. **SQL simulation of the CSRF replay** (service-role SQL; synthetic ids, cleaned up):
   - Seed: profiles rows `csrf_attacker`, `csrf_victim`; pending row user_id=`csrf_attacker`,
     code hash H = sha256 of a known test code.
   - `finalize_discogs_link('csrf_victim', H)` → `{"status":"link_not_yours"}` AND the
     pending row is GONE (consumed).
   - Re-seed; `finalize_discogs_link('csrf_attacker', 'wrong-hash')` → `{"status":"no_pending"}`
     and the row REMAINS (lookup miss ≠ consume).
   - `finalize_discogs_link('csrf_attacker', H)` → `{"status":"ok" ...}` and profiles +
     discogs_credentials updated; then full cleanup, counts restored.
   - Expired row: seed with `expires_at = now() - interval '1 minute'` →
     `finalize_discogs_link` returns `no_pending` and the sweep removed the row.
4. **unlink/delete RPC round-trip** on a synthetic user (profile + credential + 2 items +
   1 pending + 1 state row): `unlink_discogs_account` leaves the profile reset and all
   four child tables empty for that user; `delete_account` removes the profile too;
   `releases` count unchanged throughout.
5. **jsdom pass**: NOTE (rev1-F1) — no test harness exists in the repo; the "13-test
   harness" from the v1.0.1 batch was session-scratch (`/tmp/twtest/test.js` in the
   sandbox) and may be gone. Rebuild if absent: npm-install jsdom in a scratch dir, load
   app.js into a JSDOM window whose body contains `<div id="app"></div>` (bootCrate
   writes to `getElementById('app')` before its try block — no mount, instant null
   deref), stub `fetch('/collection.json')` with a 3-record fixture shaped like the real
   file's records (fields used by app.js: id, artist, title, label, year, added, styles,
   genres, vinyl, price, thumb/cover_image optional), stub `matchMedia`, call
   `window.TraxWaxBootCrate()`, then assert:
   the app renders (header text present), search still filters, and — the new check —
   `data-act="account"` is ABSENT from the rendered HTML (baked mode: `DB_MODE()` false,
   so no ACCOUNT button), and baked boot does not throw with `window.TraxWaxAccount`
   undefined.
6. **Live E2E (Lane, on production, ~3 minutes):** open ACCOUNT → disconnect (two-step
   confirm) → lands on connect card → Connect Discogs → approve → **the new
   verify/finalize hop runs** → crate re-imports. This one flow exercises finalize,
   disconnect, and re-import together. DB checks after: exactly one profile, one
   credential row, item count matches, zero pending rows.
7. **Live delete is optional** (recovery is just sign-in + reconnect, ~2 min): if Lane
   runs it, verify all five tables have zero rows for the user, then sign in again →
   empty profile recreated → reconnect.

## Task 10 — Docs, version, handoff

- `CHANGELOG.md`: new `[1.1.0]` — Added: account controls (disconnect, deletion,
  authenticated finalize closing the link-CSRF). `VERSION` → `1.1.0` (feature ⇒ minor).
- `docs/roadmap.md`: move disconnect/deletion from open items to shipped.
- Historical plan docs are NOT edited (Stage B/C/D Open items stand as period records; the
  cold-audit table stays); this plan is the closure record.
- Handoff: single Mac chain, commit message carries `Closes #8`.

## Rollback

- Frontend/functions: redeploy previous function versions (Supabase keeps them);
  `git revert` the commit for the static files.
- Migration 0009 rollback SQL (operator tool, run only if abandoning the feature):
  `drop function public.finalize_discogs_link(text,text); drop function
  public.unlink_discogs_account(text); drop function public.delete_account(text);
  drop table public.discogs_pending_links;` — data-destructive only for pending links,
  which expire in 15 minutes anyway.

## Open items / accepted edges

1. **Approving in a browser where the user isn't signed in to TraxWax**: the code is
   captured to sessionStorage and survives an in-tab sign-in, but the flow only
   COMPLETES automatically when `?connect=verify` also survives — true for Clerk's
   in-place hash-routed completions, not for redirect-style ones, which drop the query
   and land the user on the connect card to click Connect again (rev1-F3: the code
   surviving does not by itself finish the link). A *different* browser or cleared
   session likewise ends in `no_pending` after 15 min + reconnect. Accepted: connect
   flows start from a signed-in crate, so all of these are rare, and every one recovers
   with a single click.
2. **Discogs-side revocation** has no API; the UI copy points at Discogs settings.
3. **The pending-link upsert replaces an earlier unfinalized connect** by the same user
   (PK user_id) — correct: latest attempt wins, same one-row-per-user posture as the
   state table.
4. **Clerk instance sharing across future apps** is an architecture decision for the next
   app's phase 0, not this plan; nothing here forecloses it (deletion never touches Clerk).

---

## Audit record — rev 1 → rev 2 (2026-08-29)

Rev 1 was verified by an independent no-context agent against the live codebase (every
edit anchor byte-checked; verdict REVISE-FIRST). Findings, all folded into rev 2:

- **F2 (MAJOR):** the finalize consume was select-then-delete — the exact concurrent-pass
  race the callback's own state-consume comment warns against — and deleted by `user_id`,
  which could destroy a newer pending row while finalizing a stale one. Fixed: atomic
  `DELETE … WHERE finalize_code_hash = … RETURNING * INTO v`. No security impact either
  way (all racers must hold code + matching sub), but the "one-time semantics" claim was
  false under concurrency as written.
- **F1 (MAJOR):** Task 9 cited "the existing 13-test harness" — which lives only in a
  session sandbox, not the repo. Fixed: the harness is specified for rebuilding, and the
  401 probe is spelled out inline.
- **F3/F4 (MINOR):** overstated what the sessionStorage capture buys across a sign-in
  (query param survival is the real gate); the CSRF walk-through omitted the
  already-connected-victim branch (safe: row expires unconsumed). Both now stated.
- **F5 (MINOR):** the plpgsql RAISE fact was imprecise (uncaught aborts the transaction;
  caught rolls back the nested subtransaction). Corrected; design unchanged.
- **F6 (MINOR):** Task 9.1 listed `node --check` for boot.js, which fails on `import`.
  Removed in favor of the esbuild form.
- **F7 (MINOR):** the modal's username derivation would display the whole null-username
  ownerLine as a fake handle in an (unreachable) branch. Now pattern-guarded.
- **F8 (MINOR):** the grants verify query lacked a schema qualifier. Added.

Verified correct by the same pass: all edit anchors unique and byte-exact (including the
7f block character-for-character), `_pipeCall`/`notice`/`esc` signatures and ordering,
0007 trigger bypass by SECURITY DEFINER RPCs, FK topology (only the 0005 releases FK),
the redirect-loop enumeration (no loops), the upsert conflict target, Task 9.3/9.4
expectations against the rev-2 SQL, scope vs issue #8 + locked decisions.

A narrow second pass over the rev-2 rework (house rule: reviewer-caused rework gets its
own audit) returned CONVERGED — no majors; two verification-instruction polish items
(the ≤1-row RETURNING reliance now stated inline; the harness's `#app` mount + fixture
shape now specified), both folded into this rev.
