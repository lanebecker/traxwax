# TraxWax Phase 1 Stage B — Connect Discogs (implementation plan)

Parent: `docs/phase-1-plan.md` (Stage A **complete and verified**, 2026-08-28).
Design: `docs/multi-user-spec.md` §4, §5, §6, §8.

**Revision 3** (2026-08-28). Rev 1 was audited before execution and found to contain **four
CRITICAL defects**, one of which was a security hole. Rev 2 fixed those; because reworked
material is where fresh defects hide, rev 2 then received its **own** independent audit, which
found no CRITICALs but **2 MAJORs and 9 minors** — all folded into this revision. Both audits
are documented in the **Audit record** at the end so a later round does not re-derive them.
Several facts that rev 1 guessed at have since been **measured against the live Discogs API**
— see Confirmed facts.

**Definition of done:** signed in on the preview, clicking **Connect Discogs** sends you to
Discogs' authorize page; approving returns you to `/app`; `discogs_credentials` holds one
encrypted row for your Clerk id; `profiles.discogs_username` is your real Discogs handle; and
`/app/<your-handle>` renders the crate while `/app/someone-else` does not.

---

## Confirmed facts (measured, not assumed)

Verified 2026-08-28 by calling the real API with the real TraxWax consumer credentials:

```
GET https://api.discogs.com/oauth/request_token   (PLAINTEXT, raw "&")   → 200
    oauth_token=…&oauth_token_secret=…&oauth_callback_confirmed=true
GET  same, but signature percent-encoded ("%26")                          → 200
```

- **Leg 1 works.** The consumer key/secret are valid and PLAINTEXT is accepted.
- **Both `&` and `%26` are accepted** in `oauth_signature`. Rev 1 flagged this as an open
  risk; it is closed. `encodeURIComponent` in the header builder is therefore safe.
- **`oauth_callback_confirmed=true`** — Discogs accepts a callback passed at runtime, so the
  handshake does not depend on the app's registered callback matching. Task B1 still sets it,
  because Discogs falls back to the registered value if none is supplied.

From Discogs' documentation, quoted rather than paraphrased:

| Fact | Consequence |
|---|---|
| Request token is **GET** `https://api.discogs.com/oauth/request_token` | Not POST |
| Access token is **POST** `https://api.discogs.com/oauth/access_token` | |
| Authorize is `https://www.discogs.com/oauth/authorize?oauth_token=…` | A browser redirect, not an API call |
| *"we suggest… the **PLAINTEXT** signature method over HMAC-SHA1"* | **No cryptographic signing to implement** |
| *"If the OAuth access token is not created within 15 minutes… your request token and verifier will expire"* | The state row needs a TTL |
| Access tokens *"do not expire (unless the user revokes access from your app)"* | Store once; no refresh flow |
| *"Why am I getting an **empty response**… you forget to add a User-Agent"*, and *"the alternative is that we just **silently block** it"* | A missing UA gives an **empty response or silent block — NOT a 403.** Debug accordingly. |
| Identity is `GET https://api.discogs.com/oauth/identity` | Source of `discogs_username` |

### The one remaining unknown, and why it is not a fallback loop

OAuth 1.0a §3.4.4 says a PLAINTEXT signature is `consumer_secret&token_secret`. Discogs'
*documented example* for the access-token step shows `oauth_signature="your_consumer_secret&"`
— nothing after the ampersand.

**This plan uses the spec-correct form** (`consumer_secret&token_secret`) for both the
access-token and identity calls. Reasoning: Discogs' own documentation recommends *"using an
OAuth library instead of generating these requests manually"*, and every standard OAuth 1.0a
library sends the spec form — so Discogs must accept it, or no library would work against
them. Leg 1 already proved Discogs is lenient about encoding, which points the same way.

Rev 1 planned a **runtime fallback** that tried one form then the other. That was wrong and is
removed: OAuth verifiers are single-use, so a failed first attempt can consume the verifier
and guarantee the second fails — turning a diagnostic into a second failure. If the spec form
turns out to be wrong, Task B9 step 4 surfaces it immediately with a clear log line and we
change one string.

---

## Architecture decisions

**The flow runs in Supabase Edge Functions, not Cloudflare Pages Functions.** `discogs_credentials`
is readable only by the `service_role`. Putting the flow in Cloudflare would require storing
the Supabase **service key** there, spreading the most powerful secret in the system across a
second vendor for convenience. Edge Functions have service-role access natively. Matches §6.

**Both functions run `verify_jwt: false`, and `connect-discogs` verifies the Clerk token itself.**

This is the rev 1 security fix and it must land as one change. Supabase's platform `verify_jwt`
gate validates **Supabase-issued** JWTs — its own HS256 or asymmetric keys. It does **not**
know Clerk's JWKS. A Clerk RS256 token fails the gate outright, so rev 1's design would have
returned 401 for every legitimate user, and the obvious "fix" — flipping the flag off while
keeping rev 1's unverified `atob` payload decode — would have let anyone forge
`{"sub":"<victim>"}` and bind a Discogs account to someone else's profile.

So: the gate is off, and identity comes **only** from `jwtVerify` against Clerk's JWKS, which
enforces signature, issuer, and expiry. Nothing else in either function may derive a user id.

| Function | `verify_jwt` | Identity comes from |
|---|---|---|
| `connect-discogs` | `false` | `jose.jwtVerify` against Clerk's JWKS, in-handler |
| `connect-discogs-callback` | `false` | The state row keyed on the unguessable `oauth_token` |

**The unauthenticated callback is safe against identity forgery — but not against
link-CSRF, which is a documented, accepted residual risk (Lane, 2026-08-28).** Discogs
redirects the *browser* to the callback and a redirect cannot carry an Authorization header,
so identity comes from `oauth_token`: unguessable, minted by Discogs, stored against the
initiating user, and **atomically consumed** on first use (Task B6). The callback never reads
a user id from the request — nobody can forge *who they are*.

What this does **not** prevent: an attacker who starts a connect flow on *their own* account
possesses their own `authorize_url` legitimately. If they deliver it to a victim who is signed
into Discogs and who approves the (genuine, TraxWax-named) consent screen, the victim's
Discogs token gets linked to the **attacker's** profile. The vector needs a targeted victim,
does not scale, and is accepted for Stage B. The real fix — the callback stores the result as
*pending* and a signed-in, Clerk-verified finalize endpoint completes the link — lands in
Phase 2 alongside disconnect (Open item 3/6).

**Tokens are encrypted at rest** (AES-256-GCM) even though the table is service-role-only.
A future mistaken policy, a support dump, or a restored backup should not yield live Discogs
credentials.

**Linking is one atomic RPC**, not two writes. Writing `discogs_credentials` and then
`profiles` separately can orphan an encrypted credential when the profile write fails — and it
*will* fail: `profiles_discogs_username_key` (added in Stage A, Task A3) is unique on
`lower(discogs_username)`, so a second Clerk account connecting the same Discogs handle raises
`23505`. That is not hypothetical; it is what happens the second time you test sign-up.

---

## Task B1 — 🧑 Set the callback URL on the Discogs app

1. Go to **https://www.discogs.com/settings/developers**, open the **TraxWax** application.
2. Set **Callback URL** to exactly:

```
https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/connect-discogs-callback
```

3. Save.

**Expected:** the app page shows that URL. Discogs allows editing this at any time.

## Task B2 — 🧑 Set the three Edge Function secrets

Supabase Dashboard → **Edge Functions → Secrets** (project `traxwax`). **Claude never sees
these values and must not be told them.**

| Name | Value |
|---|---|
| `DISCOGS_CONSUMER_KEY` | Consumer Key from the TraxWax Discogs app |
| `DISCOGS_CONSUMER_SECRET` | Consumer Secret from the same app |
| `DISCOGS_TOKEN_ENC_KEY` | A fresh 32-byte random key, base64 |

Generate the encryption key on the Mac:

```
python3 -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
```

**Expected:** a 44-character string ending in `=`.

> **Losing `DISCOGS_TOKEN_ENC_KEY` makes every stored token permanently unreadable** and every
> user must reconnect. It is recoverable from nowhere else. Put it in 1Password now.

Paste carefully — a trailing newline breaks the key. The code calls `.trim()` defensively, but
do not rely on that.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — do **not** add them.

## Task B3 — Add the OAuth state table and the atomic link RPC

Create **`supabase/migrations/0003_discogs_connect.sql`**:

```sql
-- 0003_discogs_connect.sql — Phase 1 Stage B
--
-- PART 1: OAuth handshake state.
--
-- OAuth 1.0a is a two-leg handshake. Leg 1 gets a request token from Discogs and sends the
-- user away to authorize. Leg 2 is a browser redirect BACK from Discogs carrying the request
-- token and a verifier -- with no Authorization header, because a redirect cannot have one.
-- So leg 2 must answer "who is this?" from the request token alone. This table is that
-- answer: it binds the unguessable request token to the Clerk user id that started the flow.
--
-- RLS ON with ZERO POLICIES, exactly like discogs_credentials: service_role only. The
-- oauth_token_secret stored here is a credential.
--
-- Discogs expires request tokens after 15 minutes, so expires_at makes that explicit and
-- lets the callback reject a stale handshake instead of forwarding a doomed request.

create table if not exists public.discogs_oauth_state (
  oauth_token         text primary key,
  oauth_token_secret  text not null,
  user_id             text not null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null default (now() + interval '15 minutes')
);

create index if not exists discogs_oauth_state_expires_idx
  on public.discogs_oauth_state (expires_at);

alter table public.discogs_oauth_state enable row level security;
-- Intentionally NO policies. service_role only.

-- PART 2: atomic account linking.
--
-- Linking touches two tables. Doing it as two PostgREST calls can leave an encrypted
-- credential orphaned when the profile write fails -- and it WILL fail: profiles has a
-- unique index on lower(discogs_username) (migration 0002), so a second Clerk account
-- connecting the same Discogs handle raises 23505. One function, one transaction, so either
-- both writes land or neither does.
--
-- SECURITY DEFINER because it writes discogs_credentials, which has no policies. It is
-- callable only by the service_role (see the revoke/grant below), so no client can reach it.

create or replace function public.link_discogs_account(
  p_user_id      text,
  p_username     text,
  p_token_enc    text,
  p_secret_enc   text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set discogs_username     = p_username,
         discogs_connected_at = now()
   where user_id = p_user_id;

  if not found then
    raise exception 'no profile for user_id %', p_user_id
      using errcode = 'P0002';   -- no_data_found
  end if;

  insert into public.discogs_credentials (user_id, oauth_token, oauth_token_secret)
       values (p_user_id, p_token_enc, p_secret_enc)
  on conflict (user_id) do update
          set oauth_token        = excluded.oauth_token,
              oauth_token_secret = excluded.oauth_token_secret;
end;
$$;

revoke all on function public.link_discogs_account(text, text, text, text) from public, anon, authenticated;
grant execute on function public.link_discogs_account(text, text, text, text) to service_role;
```

Apply with the TraxWax MCP connector (`apply_migration`, name `0003_discogs_connect`).

**Verify the table is locked:**

```sql
select c.relname, c.relrowsecurity as rls_on, count(p.polname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname='public' and c.relname='discogs_oauth_state'
group by c.relname, c.relrowsecurity;
```
**Expected:** `discogs_oauth_state | true | 0`. Anything other than 0 policies means a client
can read request-token secrets — stop and remove them.

**Verify the RPC is not client-callable:**

```sql
select has_function_privilege('anon',          'public.link_discogs_account(text,text,text,text)', 'execute') as anon_can,
       has_function_privilege('authenticated', 'public.link_discogs_account(text,text,text,text)', 'execute') as auth_can,
       has_function_privilege('service_role',  'public.link_discogs_account(text,text,text,text)', 'execute') as svc_can;
```
**Expected:** `false | false | true`. If either of the first two is true, any signed-in user
could overwrite another user's Discogs link — stop and re-run the revoke.

**Verify the collision actually raises** (this is the case rev 1 missed):

```sql
insert into public.profiles (user_id, discogs_username) values ('t_x','CollideTest');
do $$
declare blocked boolean := false;
begin
  insert into public.profiles (user_id) values ('t_y');
  begin
    perform public.link_discogs_account('t_y','collidetest','enc','enc');
  exception when unique_violation then blocked := true;
  end;
  if not blocked then raise exception 'FAIL: duplicate handle was accepted'; end if;
end $$;
delete from public.profiles where user_id in ('t_x','t_y');
```
**Expected:** the DO block completes without raising (via the MCP connector that shows as an
empty result set with no error — the check is the *absence* of a `FAIL:` exception), and the
cleanup delete removes both test rows, leaving `profiles` at its prior count. If it raises
`FAIL:`, the unique index is not protecting the link path.

## Task B4 — Add the shared helper

Create **`supabase/functions/_shared/discogs.ts`**:

```ts
/* Shared helpers for the Discogs OAuth 1.0a handshake.
 *
 * Signature method is PLAINTEXT, per Discogs' own recommendation:
 *   "we suggest sending requests with HTTPS and the PLAINTEXT signature method over
 *    HMAC-SHA1 due to its simple yet secure nature."
 * There is no signing algorithm here -- the signature is a string.
 *
 * Measured 2026-08-28 against the live API: Discogs accepts the signature both raw ("&")
 * and percent-encoded ("%26"), so percent-encoding every value is safe. */

export const DISCOGS_UA = 'TraxWax/1.0 +https://traxwax.com';

/** RFC 3986 percent-encoding. encodeURIComponent leaves !'()* alone; OAuth wants them encoded. */
function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function oauthHeader(params: Record<string, string>): string {
  return 'OAuth ' + Object.entries(params)
    .map(([k, v]) => `${k}="${pct(v)}"`)
    .join(', ');
}

export function nonce(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function timestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

export function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

/** Names only, never values — for logging an unexpected OAuth response safely. */
export function fieldNames(body: string): string {
  return Object.keys(parseForm(body)).join(',') || '(none)';
}

/* ── AES-256-GCM at rest ─────────────────────────────────────────────────────
   Stored format: base64( iv(12) || ciphertext||tag ). Self-contained, so no separate IV
   column and no chance of pairing the wrong IV with the wrong row. */

function b64encode(bytes: Uint8Array): string {
  // A loop, not String.fromCharCode(...spread): the spread form blows the argument limit
  // on large inputs, and this module is explicitly built for reuse.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function keyFor(rawBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(rawBase64.trim()), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) {
    throw new Error('DISCOGS_TOKEN_ENC_KEY must decode to exactly 32 bytes');
  }
  return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false,
    ['encrypt', 'decrypt']);
}

export async function encrypt(plain: string, keyB64: string): Promise<string> {
  const key = await keyFor(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  const joined = new Uint8Array(iv.byteLength + ct.byteLength);
  joined.set(iv, 0);
  joined.set(ct, iv.byteLength);
  return b64encode(joined);
}

export async function decrypt(stored: string, keyB64: string): Promise<string> {
  const key = await keyFor(keyB64);
  const joined = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: joined.slice(0, 12) }, key, joined.slice(12));
  return new TextDecoder().decode(plain);
}

/** Encrypt→decrypt round trip. Stage B only encrypts; without this, a decrypt bug would
    stay hidden until Stage C discovers it on real stored tokens. */
export async function selfTest(keyB64: string): Promise<void> {
  const probe = 'traxwax-selftest-' + crypto.randomUUID();
  if (await decrypt(await encrypt(probe, keyB64), keyB64) !== probe) {
    throw new Error('crypto self-test failed');
  }
}
```

## Task B5 — Deploy `connect-discogs` (leg 1)

Create **`supabase/functions/connect-discogs/index.ts`**:

```ts
/* Leg 1 of the Discogs OAuth 1.0a handshake.
 *
 * verify_jwt is FALSE at the platform level because Supabase's gate only validates
 * Supabase-issued JWTs and does not know Clerk's JWKS -- a Clerk RS256 token fails it.
 * Identity therefore comes from jwtVerify below, which enforces signature, issuer and
 * expiry. NOTHING else in this function may derive a user id: decoding the payload without
 * verifying would let anyone forge {"sub": "<someone else>"}. */

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://deno.land/x/jose@v5.9.6/index.ts';
import { DISCOGS_UA, oauthHeader, nonce, timestamp, parseForm, fieldNames }
  from '../_shared/discogs.ts';

const CLERK_ISSUER = 'https://brave-buffalo-7127.clerk.accounts.dev';
const APP_ORIGIN   = 'https://multi-user.traxwax.pages.dev';
const CALLBACK     = 'https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/connect-discogs-callback';

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
    // A thrown fetch (network failure to Discogs, JWKS unreachable) must still return
    // CORS headers, or the browser reports an opaque "Failed to fetch" with no diagnostic
    // -- the exact symptom class the C3 fix exists to avoid.
    console.error('unexpected:', (e as Error).message);
    return json({ error: 'unexpected' }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  // ── Identity: verified, never decoded. Runs BEFORE the config check so the forged-token
  //    negative test (B10 step 2) is meaningful even while the B2 secrets are unset. ──────
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'missing_token' }, 401);

  let userId: string;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: CLERK_ISSUER });
    if (!payload.sub) throw new Error('no sub claim');
    // Clerk stamps azp with the origin the token was minted for. Reject tokens minted for
    // another site; tolerate absence, per Clerk's own guidance. Defense-in-depth only.
    if (payload.azp && payload.azp !== APP_ORIGIN) throw new Error('azp mismatch');
    userId = payload.sub;
  } catch (e) {
    console.error('clerk token rejected:', (e as Error).message);
    return json({ error: 'invalid_token' }, 401);
  }

  const consumerKey = Deno.env.get('DISCOGS_CONSUMER_KEY');
  const consumerSecret = Deno.env.get('DISCOGS_CONSUMER_SECRET');
  if (!consumerKey || !consumerSecret) return json({ error: 'not_configured' }, 500);

  // ── Leg 1: ask Discogs for a request token. NOTE: GET, not POST. ───────────
  const res = await fetch('https://api.discogs.com/oauth/request_token', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DISCOGS_UA,
      Authorization: oauthHeader({
        oauth_consumer_key: consumerKey,
        oauth_nonce: nonce(),
        oauth_signature: `${consumerSecret}&`,
        oauth_signature_method: 'PLAINTEXT',
        oauth_timestamp: timestamp(),
        oauth_callback: CALLBACK,
      }),
    },
  });

  const body = await res.text();
  if (!res.ok) {
    // Log status only. The body of a FAILED call is not secret, but the body of a
    // SUCCESSFUL one contains oauth_token_secret -- so never establish the habit.
    console.error('request_token failed, status', res.status);
    return json({ error: 'discogs_request_token_failed' }, 502);
  }

  const parsed = parseForm(body);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    // A 200 body is secret-bearing. Log field NAMES only, never the body.
    console.error('request_token 200 but unexpected fields:', fieldNames(body));
    return json({ error: 'discogs_unexpected_response' }, 502);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  await admin.from('discogs_oauth_state').delete().lt('expires_at', new Date().toISOString());
  await admin.from('discogs_oauth_state').delete().eq('user_id', userId);

  const { error } = await admin.from('discogs_oauth_state').insert({
    oauth_token: parsed.oauth_token,
    oauth_token_secret: parsed.oauth_token_secret,
    user_id: userId,
  });
  if (error) {
    console.error('state insert failed:', error.message);
    return json({ error: 'state_store_failed' }, 500);
  }

  return json({
    authorize_url: 'https://www.discogs.com/oauth/authorize?oauth_token=' +
      encodeURIComponent(parsed.oauth_token),
  });
}
```

**Deploy** with the TraxWax MCP connector, `deploy_edge_function`:

- `name`: `connect-discogs`
- `entrypoint_path`: `connect-discogs/index.ts`
- `verify_jwt`: **`false`**
- `files`: **two entries**, with these exact `name` values so the relative import resolves:
  - `connect-discogs/index.ts` → the code above
  - `_shared/discogs.ts` → the code from Task B4

> The tool takes inline `{name, content}` pairs, not paths. Naming the entrypoint
> `connect-discogs/index.ts` (not bare `index.ts`) is what makes `../_shared/discogs.ts`
> resolve inside the bundle. A bare `index.ts` points the import above the deployment root
> and the function returns 503 `BOOT_ERROR` on first invocation.

## Task B6 — Deploy `connect-discogs-callback` (leg 2)

Create **`supabase/functions/connect-discogs-callback/index.ts`**:

```ts
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
  // remaining unknown" above for why there is no fallback attempt here.
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
  // NOT idRes.json(): the facts table documents that a blocked/missing User-Agent yields an
  // EMPTY response body -- and .json() on an empty 200 throws. Parse defensively so this
  // documented failure mode lands on the graceful path, not the catch-all.
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
```

**Deploy** with `deploy_edge_function`:

- `name`: `connect-discogs-callback`
- `entrypoint_path`: `connect-discogs-callback/index.ts`
- `verify_jwt`: **`false`**
- `files`: `connect-discogs-callback/index.ts` and `_shared/discogs.ts`

> **`_shared/discogs.ts` is uploaded twice — once per function.** The single repo file
> prevents *authoring* drift, not *deployed* drift. **Redeploy both functions whenever that
> file changes**, or production ends up running two different versions of the crypto.

## Task B7 — Add a `config.toml` so CLI deploys don't silently re-enable the gate

Both functions must run `verify_jwt: false`. That is currently set only through the MCP call.
Anyone running `supabase functions deploy` from the CLI would get the default (`true`) and
break both — the callback would reject every Discogs redirect.

Create **`supabase/config.toml`**:

```toml
# Both Discogs OAuth functions must run with the platform JWT gate OFF.
#
# connect-discogs verifies the Clerk token itself, against Clerk's JWKS, because Supabase's
# verify_jwt only validates SUPABASE-issued JWTs and rejects Clerk's RS256 tokens outright.
# connect-discogs-callback is a browser redirect target from Discogs and cannot carry an
# Authorization header at all.
#
# Do not set either of these to true. See docs/phase-1-stage-b-plan.md.
#
# project_id is required for the CLI to parse this file at all -- a bare [functions.*] file
# would make `supabase functions deploy` error out, defeating the guard's purpose.

project_id = "traxwax"

[functions.connect-discogs]
verify_jwt = false

[functions.connect-discogs-callback]
verify_jwt = false
```

## Task B8 — Add the Connect affordance to the frontend

In **`public/boot.js`**, find this block inside `render()` (it is the only occurrence):

```js
  if (!profile.discogs_username) {
    notice('Connect your collection',
      'You are signed in, but TraxWax does not know your Discogs account yet.<br><br>' +
      'Connecting Discogs arrives in Stage B. Until then there is nothing to file.', true);
    return;
  }
```

Replace it with:

```js
  if (!profile.discogs_username) {
    const CONNECT_ERRORS = {
      missing_params: 'Discogs sent us back without the expected details. Try again.',
      not_configured: 'TraxWax is not fully configured yet. This one is on us.',
      state_error: 'We lost track of that connection attempt. Try again.',
      unknown_or_used: 'That connection link was already used or has expired. Try again.',
      expired: 'That took longer than 15 minutes, so Discogs expired the request. Try again.',
      access_denied: 'Discogs did not grant access. Try again, and approve on their screen.',
      identity_failed: 'Discogs would not tell us who you are. Try again.',
      handle_taken: 'That Discogs account is already linked to another TraxWax account.',
      no_profile: 'We could not find your TraxWax profile. Sign out and back in.',
      store_failed: 'We could not save the connection. Try again.',
      unexpected: 'Something went wrong on our side. Try again.',
    };
    const status = new URLSearchParams(window.location.search).get('connect');
    const problem = (status && status !== 'ok')
      ? `<div id="tw-connect-err" style="margin-bottom:18px; color:var(--accent)">${
          esc(CONNECT_ERRORS[status] || 'Connection failed. Try again.')}</div>`
      : '<div id="tw-connect-err"></div>';

    notice('Connect your collection',
      problem +
      'TraxWax needs permission to read your Discogs collection. You will be sent to ' +
      'Discogs to approve, then brought straight back.<br><br>' +
      '<button id="tw-connect" style="margin-top:6px; padding:12px 20px; border:0; ' +
      'cursor:pointer; background:var(--accent); color:var(--on-accent); ' +
      "font-family:'IBM Plex Mono',monospace; font-size:12px; font-weight:700; " +
      'letter-spacing:.12em; text-transform:uppercase">Connect Discogs</button>', true);

    const btn = document.getElementById('tw-connect');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Contacting Discogs…';
      try {
        const token = await window.Clerk.session.getToken();
        const r = await fetch(SUPABASE_URL + '/functions/v1/connect-discogs', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            apikey: SUPABASE_PUBLISHABLE_KEY,
            'Content-Type': 'application/json',
          },
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.authorize_url) throw new Error(d.error || ('HTTP ' + r.status));
        window.location.href = d.authorize_url;
      } catch (e) {
        // Render inline, NOT via showError() -- that replaces the whole page and would
        // destroy the button we just re-enabled, leaving no way to retry.
        btn.disabled = false;
        btn.textContent = 'Connect Discogs';
        const slot = document.getElementById('tw-connect-err');
        if (slot) {
          // The empty placeholder ships unstyled; style it at insertion time so this
          // message doesn't render in muted body color with no spacing.
          slot.style.cssText = 'margin-bottom:18px; color:var(--accent)';
          slot.innerHTML = esc('Could not start the connection: ' +
            ((e && e.message) || e));
        }
        console.error(e);
      }
    });
    return;
  }
```

`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `esc()` and `notice()` are already module-level in
`boot.js` — no new imports.

## Task B9 — Commit and deploy the frontend

Before committing, update the parent plan so a reader landing there first is not misdirected
(round-2 audit, minor 8). In **`docs/phase-1-plan.md`**: mark Stage A **complete and verified
(2026-08-28)** in the status block; note Stage B is planned in this document (replacing any
"Stages B–D are NOT yet planned" phrasing as it applies to B); and correct the Stage B hazard
sentence claiming OAuth 1.0a needs HMAC-SHA1 request signing — PLAINTEXT is Discogs'
recommended method and is measured working (see Confirmed facts).

```
cd "/Users/lanebecker-wmf/Documents/Claude.nosync/Projects/Lane's Record Collection/traxwax-clone" && git add -A && git commit -m "Stage B — Discogs OAuth connect flow" && git push
```

No `git pull --rebase` here, deliberately: the project standard chain includes it because
`main` receives bot commits, but this pushes to `multi-user`, which no bot touches. Rebasing
`main` into a stage mid-build would pull in unrelated data refreshes.

**Expected:** push succeeds to `origin/multi-user`; Cloudflare rebuilds the preview.
`traxwax.com` is untouched — it is on `main`.

## Task B10 — Verify Stage B

**1. Both functions boot.** `list_edge_functions` on the TraxWax connector.
**Expected:** `connect-discogs` and `connect-discogs-callback`, both `verify_jwt: false`,
status ACTIVE. Then `get_edge_function` on each and confirm **two files** are listed —
one entrypoint plus `_shared/discogs.ts`. A single-file function will 503 on first call.

**2. A forged token is rejected.** This is the security check; run it before anything else.

```
curl -s -o /dev/null -w 'status=%{http_code}\n' -X POST \
  https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/connect-discogs \
  -H 'Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyX2ZvcmdlZCJ9.'
```
**Expected: `401`.** A `200` means identity is not being verified and **anyone can bind a
Discogs account to any user id — stop immediately.** This test is valid even before the B2
secrets are set: the handler verifies identity *before* checking configuration, precisely so
this check cannot be confounded by a `not_configured` 500.

**3. The CORS preflight passes.**

```
curl -s -i -X OPTIONS https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/connect-discogs \
  -H 'Origin: https://multi-user.traxwax.pages.dev' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, apikey, content-type' | head -12
```
**Expected:** `200`, with `access-control-allow-headers` listing all three. If `apikey` is
missing the browser blocks the real request and `fetch` fails with an opaque "Failed to fetch".

**4. Run the flow.** Signed in at `https://multi-user.traxwax.pages.dev/app`, click
**Connect Discogs**. **Expected:** Discogs' authorize page naming **TraxWax**. Approve.
You return to `/app?connect=ok`, which immediately redirects to `/app/lanebecker` and renders
the crate. **The `?connect=ok` disappears from the address bar — that is correct**, not a
misfire; `boot.js` replaces the URL with your canonical crate path.

If the access-token signature form was wrong, you land on `/app?connect=access_denied` and the
function log shows `access_token failed` with a **4xx** status (the exact code is unverified —
do not treat a 401-vs-400 mismatch as a different bug). In that case change the signature
string **in the access-token fetch** of Task B6 — the one reading
`` `${consumerSecret}&${state.oauth_token_secret}` `` — to `` `${consumerSecret}&` `` and
redeploy. The identity call's signature stays as written; it matches Discogs' documented
authenticated-request example.

**5. The credential row exists and is encrypted.**

```sql
select user_id,
       length(oauth_token)        as enc_token_len,
       length(oauth_token_secret) as enc_secret_len,
       created_at
from public.discogs_credentials;
```
**Expected:** one row, your Clerk id, both lengths ≈ 92 (12-byte IV + ~40-byte token +
16-byte GCM tag, base64). A raw Discogs token is ~40 characters — **if either length is near
40, encryption did not run; stop before anyone else connects.**

**6. The profile is linked.**

```sql
select user_id, discogs_username, discogs_connected_at from public.profiles;
```
**Expected:** one row, `discogs_username` = `lanebecker`, `discogs_connected_at` recent.

**7. The state row was consumed.**

```sql
select count(*) as leftover_state from public.discogs_oauth_state;
```
**Expected:** `0`.

**8. Ownership routing holds.** `/app/lanebecker` → the crate. `/app/someoneelse` →
"No crate here".

**9. Production untouched.** `https://traxwax.com` → the existing single-user crate.

---

## Rollback

Single user (normal case during testing):

```sql
delete from public.discogs_credentials where user_id = '<clerk id>';
delete from public.discogs_oauth_state  where user_id = '<clerk id>';
update public.profiles set discogs_username = null, discogs_connected_at = null
 where user_id = '<clerk id>';
```

Everyone (emergency only — note the deliberate absence of a WHERE clause):

```sql
delete from public.discogs_credentials;
delete from public.discogs_oauth_state;
update public.profiles set discogs_username = null, discogs_connected_at = null;
```

Nothing else is lost: the CC0 catalog and `collection_items` are untouched by Stage B. Users
reconnect.

## Open items

1. **`APP_ORIGIN` is hardcoded to the preview URL** in both functions. At the Stage D flip it
   becomes `https://traxwax.com`. The Discogs app's registered callback does **not** change —
   it points at Supabase, not at the site.
2. **`CLERK_ISSUER` is the development instance.** Moving to a Clerk production instance
   changes the issuer *and* the JWKS URL; both constants in `connect-discogs` must change, and
   Supabase's third-party auth entry must be repointed. Tracked as Open item 2 in
   `docs/phase-1-plan.md`.
3. **No disconnect/revoke path.** `multi-user-spec.md` §8 notes Discogs access is revocable at
   any time, and storing third-party credentials without a way to un-store them is a real gap.
   The Rollback SQL is an operator tool, not a user-facing one. Phase 2.
4. **The `BAKED_CRATE_OWNER` guard in `boot.js` must stay until Stage D.** From the moment this
   stage populates `discogs_username`, it is the only thing preventing another connected user
   from being served Lane's baked collection and live prices.
5. **Import handoff is deliberately deferred.** `multi-user-spec.md` §4 describes connect as
   flowing straight into import; that is Stage C. Stage B ends at a linked account.
6. **Accepted residual risk: link-CSRF** (round-2 audit M-2, accepted by Lane 2026-08-28).
   An attacker can hand their own `authorize_url` to a victim; if the victim approves on
   Discogs, the victim's token links to the attacker's profile. Needs a targeted victim,
   doesn't scale, pre-launch population of one. **Phase 2 fix:** callback stores the result as
   *pending*; a Clerk-authenticated finalize endpoint (verified `sub` must equal the state
   row's `user_id`) completes the link. Build it alongside disconnect (Open item 3).

---

## Audit record

Rev 1 was audited by an independent no-context agent before execution. Findings recorded here
rather than silently deleted.

**CRITICAL — fixed**

- **C1 — `verify_jwt: true` does not validate Clerk tokens, and the obvious fix was an account
  takeover.** Rev 1 asserted Supabase had already validated the Clerk JWT, then read `sub`
  from an unverified base64 decode. Supabase's gate validates only *Supabase-issued* JWTs; a
  Clerk RS256 token fails it, so every legitimate request would have 401'd. The natural
  remedy — flipping the flag off — would have left the unverified decode as the sole identity
  source, letting anyone forge `{"sub":"<victim>"}` and bind a Discogs account to another
  user's profile. **Fixed as one change:** `verify_jwt: false` **plus** in-handler
  `jose.jwtVerify` against Clerk's JWKS, with issuer and expiry enforced, plus a negative test
  (Task B10 step 2).
- **C2 — `atob` on a base64url JWT segment throws.** JWT payloads use `-`/`_`, which `atob`
  rejects. Every real token would have failed, and the `try/catch` turned it into the same
  401 as C1 — two different bugs with one indistinguishable symptom. **Fixed:** no
  hand-decoding survives; `jwtVerify` returns the parsed payload.
- **C3 — the CORS preflight omitted `apikey`.** The frontend sends `authorization`, `apikey`
  and `content-type`; rev 1 allowed only two. The browser's preflight would have failed with
  an opaque "Failed to fetch". **Fixed**, plus `x-client-info` for a future
  `functions.invoke`, `Max-Age`, an origin restricted from `*` to the preview, and an explicit
  preflight test.
- **C4 — the deploy instruction could not be followed, and the import would not resolve.**
  `deploy_edge_function` takes inline `{name, content}` pairs, not paths, and with a bare
  `index.ts` entrypoint `../_shared/discogs.ts` points above the deployment root → 503
  `BOOT_ERROR`. **Fixed:** exact `name` values given, entrypoint namespaced to
  `connect-discogs/index.ts`, and the twice-uploaded-shared-file drift risk stated.

**MAJOR — fixed**

- **M1 — upstream Discogs bodies were returned to the browser and logged.** A *successful*
  `request_token` body contains `oauth_token_secret`, and rev 1's `lastBody` was assigned on
  every attempt including 200s — so a live access token could have been written to function
  logs. **Fixed:** opaque error codes to the client, status-only logging, and a `fieldNames()`
  helper that logs key names never values.
- **M2 — select-then-delete is not atomic.** Two concurrent callbacks could both pass the
  existence check; the delete's error was unchecked. **Fixed:** `DELETE … RETURNING`.
- **M3 — the two-attempt signature fallback could destroy the verifier it was retrying with.**
  OAuth verifiers are single-use. **Fixed:** one spec-correct form, with the reasoning stated
  and a named fallback string if step 4 disproves it.
- **M4 — `update` matching zero rows is not an error, and the unique index was never
  considered.** Rev 1 would have returned `connect=ok` while leaving `discogs_username` null
  (silent success inside a credential flow), and a duplicate handle would have orphaned an
  encrypted credential. Both stem from doing two writes where one transaction was needed —
  and the constraint in question is the one Stage A Task A3 deliberately built. **Fixed:**
  the `link_discogs_account` RPC, with `23505` and `P0002` mapped to distinct user-facing
  states.
- **M5 — signature encoding was an unhedged guess.** **Resolved by measurement:** both raw and
  percent-encoded return 200. `encodeURIComponent` is safe; RFC 3986's `!'()*` escapes added.
- **M6 — "Discogs 403s without a User-Agent" is not what the docs say.** They say *empty
  response* and *silently block*. Repeating a wrong expected-symptom is exactly the
  instrument-mismatch trap that cost two failed fixes in Stage A (`phase-1-plan.md` E2).
  **Fixed** in the facts table.
- **M7 — the criterion for deleting the stray `inbound` function was wrong.** "Spinbound has
  its own copy" proves nothing about where the email provider POSTs. **Resolved by
  measurement:** Spinbound's own project shows 1,164 `inbound_events`, 42 in 24 hours, most
  recent the same day — the provider points there. TraxWax's copy logged zero invocations, and
  the source remains on disk, redeployable. It was a stray duplicate; deleting it was safe.

**MINOR — fixed:** `looks_base64` could not discriminate (dropped, length check retained);
`showError` destroyed the retry button (now inline); `decrypt` shipped untested (now a
`selfTest` round trip at callback start); `String.fromCharCode(...spread)` is a landmine in a
shared module (now a loop); `atob` on an untrimmed key (now `.trim()`); step 4's expected URL
ignored the canonical redirect (now stated); rollback SQL had no single-user form (both given);
no `config.toml` (Task B7); `git pull --rebase` omission now explained; stray "(Task B7)"
cross-reference corrected.

**Confirmed correct by the audit, no change needed:** Task B8's find-string exists verbatim
exactly once in the real `boot.js`; all four identifiers it uses are in module scope; every
column written exists in `0001_init.sql` with no NOT NULL omissions and `onConflict: 'user_id'`
targets a real primary key; live RLS state matches the plan's premise; nothing the plan creates
already exists; the Discogs API facts verified against the live documentation (the table has
eight rows; rev 2 miscounted this as "six" — caught by the round-2 audit); the
AES-256-GCM implementation is correct (12-byte IV, correct slice offsets, binary-safe base64,
32-byte key assertion); `jsr:@supabase/supabase-js@2` and `Deno.serve` are current; `SUPABASE_URL`
and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected; the two-function split is architecturally
right; and the redirect is not an open redirect.

---

## Audit record — round 2 (rev 2 → rev 3, 2026-08-28)

Rev 2's rework had never itself been independently checked, so a second no-context agent
audited the document before execution. **No CRITICALs.** It re-executed the rev-1 failure
classes against live evidence (deploy tool schema, jose import resolvable, B8 find-string
unique, B3 SQL objects all exist, live project state matches the plan's premises) and
confirmed them fixed.

**MAJOR — fixed**

- **R2-M1 — the identity step crashed into a raw 500 on the plan's own documented failure
  mode.** The facts table warns a blocked User-Agent yields an *empty* response; `idRes.json()`
  on an empty 200 throws, and the callback had no top-level try/catch — stranding a
  browser-navigated user on a naked Supabase error page. **Fixed:** defensive
  `JSON.parse(await idRes.text())` falling to `identity_failed`, plus top-level try/catch in
  **both** functions (`unexpected` in leg 1 keeps its CORS headers; in leg 2 it redirects
  back to `/app`).
- **R2-M2 — "the unauthenticated callback is safe" concealed a link-CSRF.** An attacker's own
  legitimately-obtained `authorize_url`, delivered to a victim who approves on Discogs, links
  the victim's token to the attacker's profile. The unguessability argument defends only
  against identity forgery. **Decision (Lane, 2026-08-28): accept + document for Stage B**;
  the authenticated-finalize fix is Open item 6, Phase 2.

**MINOR — fixed:** "all six Discogs API facts" recounted to eight; `azp` origin check added to
`jwtVerify` handling (defense-in-depth, absence tolerated); B10 step 4's "status 400" was an
unverified guess of exactly the wrong-expected-symptom class M6 condemns (now "4xx");
"change the one string in Task B6" was ambiguous between two signature strings (now names the
access-token fetch); the runtime error slot rendered unstyled (styled at insertion);
`config.toml` lacked the `project_id` the CLI requires to parse the file; a parent-plan update
folded into Task B9 (phase-1-plan.md still said Stage B was unplanned and OAuth needed
HMAC-SHA1); B3's expected outputs rephrased away from psql command tags. Also reordered leg 1
so identity verification precedes the config check, making the forged-token test valid before
the B2 secrets exist.

**Confirmed correct by round 2, no change needed:** the B8 find-string (byte-for-byte, once,
all four identifiers module-level); the ?connect=ok redirect prediction; the 44-char and
≈92-char arithmetic; every schema premise the SQL and RPC touch; the revoke correctly
neutralizing PostgREST's default function grants; `DELETE … RETURNING` atomicity under
PostgREST; the deploy layout; the jose/supabase-js imports; the AES-GCM helper (independently
re-derived); the CORS set vs. what B8 actually sends; CONNECT_ERRORS covering every `back()`
status; routing premises against `_routes.json`/`_redirects`/`boot.js`; branch state
(`multi-user` checked out, so B9's plain push goes where claimed); and full definition-of-done
↔ task coverage in both directions.
