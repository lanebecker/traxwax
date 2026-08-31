# Wave 2 — Stage B2 plan: ADD / REMOVE to wantlist (the first Discogs *write*)

Status: DRAFT for Lane's review. Needs break-glass (one new Edge Function deploy). No migration.

## What ships

The first mutation of a user's Discogs account from TraxWax:

1. **Add to wantlist** — on a friend's crate, a record you don't already own gets an **＋ ADD TO
   WANTLIST** control (card + detail modal). One click writes it to *your* Discogs wantlist and mirrors
   it into `wantlist_items` so the badge/MATCHES/wantlist-tab all reflect it live.
2. **Remove from wantlist**, two homes:
   - **Toggle on a friend's crate** — a record already on your wantlist shows **✕ REMOVE FROM WANTLIST**;
     it's the same control flipped (no confirm — a toggle is its own undo).
   - **Inline on THE WANTLIST tab** — every card gets **✕ REMOVE FROM WANTLIST**; removal is optimistic
     with an **UNDO toast** (the card is gone, so there's no toggle to click back — the toast is the undo).

Scope guardrails: wantlist writes **only** — no "add to collection" (heavier, later). The controls appear
**only** on friend crates (add/remove toggle) and THE WANTLIST tab (remove). The own collection crate,
timeline, and ledger are untouched.

## Design decisions needing Lane's sign-off (before I build)

- **Control placement**: a thin full-width labeled button as the card's last row (below the year/style
  footer), plus the same control in the detail modal's action column. Alternative was modal-only (less
  grid clutter, lower discoverability). Proposing card-level because "toggle on friend crates" reads as
  on-the-cards. **← confirm or redirect.**
- **Owned records**: on a friend's crate, a record you already own (`viewerHas`) shows **no** want control
  (you own this exact release; wanting it is a no-op at release granularity — see #28 master-matching).
- **Wantlist-tab remove guard**: optimistic remove + **UNDO toast** (immediate Discogs DELETE; UNDO
  re-adds). Chosen over a blocking confirm dialog because a want is low-stakes and re-addable, and the
  toast keeps the grid flowing. **← confirm you want the toast, not a confirm dialog.**

## Backbone constraints (do not violate)

- **Discogs is the source of truth.** Write to Discogs FIRST; mirror to `wantlist_items` only on Discogs
  success. Never mirror-then-write (that desyncs on a Discogs failure).
- **FK**: `wantlist_items.release_id → releases(release_id)` (migration 0017:11). An add for a release not
  yet in the shared catalog violates the FK. The add path is **server-authoritative**: it checks
  `releases` for the id and, only if the release is genuinely absent, fetches its basics from Discogs and
  seeds via `seed_releases`. It **never trusts client-supplied catalog content** — `seed_releases` MERGES
  non-empty fields (0010:91–99, last-writer-wins), so accepting a client `seed` would let any connected
  user overwrite the shared catalog rows every other user sees (verification-pass MAJOR, designed out).
- **Idempotent**: `wantlist_items` is unique on `(user_id, release_id)`. Add = `upsert` on that key;
  remove = `delete` on that key; a Discogs DELETE that returns 404 (already gone) is treated as success.
- **Restricted-data rule unchanged**: this writes only the user's own wantlist under the user's own token;
  it persists only CC0 catalog (`releases`) + the ownership row (`wantlist_items`), both already permitted.

---

## Task 1 — new Edge Function `supabase/functions/wantlist-write/index.ts`

Create the file with EXACTLY this content. It mirrors `import-collection/index.ts`'s identity/env/
credential blocks verbatim (lines 11–72, 122–143 there) and adds the PUT/DELETE + mirror.

```ts
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
    // seed_releases (0010:91-99) would MERGE over the shared row (cross-user catalog defacement).
    const { data: existing, error: exErr } = await admin.from('releases')
      .select('release_id').eq('release_id', releaseId).maybeSingle();
    if (exErr) {
      console.error('release lookup failed:', exErr.message);
      return json({ error: 'store_failed' }, 500);
    }
    if (!existing) {
      // Rare in B2 (every displayed card is already in the catalog); future-proofs add-from-search.
      // A fresh header (new nonce) for a distinct request; PLAINTEXT doesn't require it but it's tidy.
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
```

Notes for the executor: no schema change and no new RLS — the mirror runs as `service_role` (the
established pattern), and `wantlist_items` already has cascade cleanup on unlink/delete (0017:100, 128).
The existing `wantlist_write_own` self-RLS is left in place, unused by this path.

---

## Task 2 — register the function in `supabase/config.toml`

After the existing `[functions.live-stats]` block (config.toml lines 27–28), append:

```toml
[functions.wantlist-write]
verify_jwt = false
```

Without this block the platform defaults `verify_jwt = true` and rejects the Clerk token before our own
`jwtVerify` runs. Mirror the five existing functions exactly.

---

## Task 3 — frontend provider `window.TraxWaxSetWant` in `public/boot.js`

The provider wraps `_pipeCall` (boot.js:403). Install it in BOTH crate-provider installers so the control
works on your own WANTLIST tab (own installer) and on a friend's crate (friend installer). It always runs
under the viewer's own Clerk token and writes the viewer's own wantlist, whichever crate is on screen.

### 3a — own crate installer (`installCrateProviders`)

In `installCrateProviders`, immediately AFTER the `window.TraxWaxRefresh = …` block (boot.js:272–279),
insert:

```js
  // Wave 2 B2: the first Discogs write — add/remove one release on the caller's own wantlist, then the
  // Edge fn mirrors it into wantlist_items (and seeds the release server-side if the catalog lacks it).
  // Single call, no page loop; errors throw with .status for the caller to surface.
  window.TraxWaxSetWant = async (releaseId, action) =>
    _pipeCall('wantlist-write', { release_id: releaseId, action });
```

### 3b — friend crate installer (`installFriendCrateProviders`)

`installFriendCrateProviders` has its OWN `fnCall` (boot.js:309–322) that returns null on error instead of
throwing — do NOT use it here (we need the thrown error to revert optimistic UI). Use the module-level
`_pipeCall` (in scope). Immediately AFTER the `window.TraxWaxViewer = …` assignment (boot.js:324), insert:

```js
  // Wave 2 B2: add/remove on the VIEWER's own wantlist from a friend's crate (writes the viewer's
  // wantlist regardless of whose crate is shown). Uses module _pipeCall so errors throw (fnCall above
  // swallows them, which would strand the optimistic UI).
  window.TraxWaxSetWant = async (releaseId, action) =>
    _pipeCall('wantlist-write', { release_id: releaseId, action });
```

---

## Task 4 — frontend controls + handlers in `public/app.js`

### 4a — the want-control renderer

Add this function immediately BEFORE `function card(r){` (app.js:271):

```js
/* Wave 2 B2: the ADD/REMOVE want control. Rendered on: every WANTLIST-tab card/modal (remove); and, on
   a friend's crate, un-owned records (add/remove toggle). Same function feeds card() and modalHtml().
   card() runs only in the crate/wantlist grids, so a friend's timeline/ledger show no card-level control
   — but their DETAIL MODAL will show the toggle (still the viewer's own write; deliberate, and useful).
   Returns '' on the own collection crate/timeline/ledger and their modals (IS_OWN() && view!=='wantlist'). */
const WANT_BTN_STYLE = "width:100%; margin-top:6px; font-family:'IBM Plex Mono',monospace; font-size:10px; " +
  "letter-spacing:.06em; padding:6px 8px; border:1.5px solid var(--line); background:var(--panel); " +
  "color:var(--ink); text-align:center; cursor:pointer";
function wantControlHtml(r){
  if (state.view==='wantlist'){
    return `<button data-act="wantRemove" data-arg="${r.id}" style="${WANT_BTN_STYLE}">✕ REMOVE FROM WANTLIST</button>`;
  }
  const ctx = window.__twMatchCtx;
  if (!IS_OWN() && ctx){
    if (ctx.viewerHas && ctx.viewerHas.has(r.id)) return '';   // you own this release — no want action
    const wanted = ctx.viewerWants && ctx.viewerWants.has(r.id);
    return `<button data-act="want" data-want="${wanted?'remove':'add'}" data-arg="${r.id}" style="${WANT_BTN_STYLE}">${wanted?'✕ REMOVE FROM WANTLIST':'＋ ADD TO WANTLIST'}</button>`;
  }
  return '';
}
```

### 4b — put it on the card

In `card(r)`, the inner content `<div>` and the card close at app.js:296–298:

```js
      </div>
    </div>
  </div>`;
```

Change the FIRST `</div>` group so the control renders as the content div's last child. Replace:

```js
        ${IS_OWN()?(showP?`<span style="font-family:'IBM Plex Mono',monospace; font-size:10px; font-weight:700; flex:none; line-height:1.35">${r.priceLabel}</span>`:''):priceCellHtml(r,false)}
      </div>
    </div>
  </div>`;
```

with:

```js
        ${IS_OWN()?(showP?`<span style="font-family:'IBM Plex Mono',monospace; font-size:10px; font-weight:700; flex:none; line-height:1.35">${r.priceLabel}</span>`:''):priceCellHtml(r,false)}
      </div>
      ${wantControlHtml(r)}
    </div>
  </div>`;
```

### 4c — put it in the detail modal

In `modalHtml()`, the action column opens at app.js:725–726. The want control goes at the TOP of the
column (above VIEW ON DISCOGS / LISTEN — Lane's call, 2026-08-31). Replace:

```js
          <div style="display:flex; flex-direction:column; gap:7px; margin-top:auto">
            <a href="https://www.discogs.com/release/${rec.id}" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.06em; padding:7px 10px; border:1.5px solid var(--line); color:var(--ink); text-align:center">VIEW ON DISCOGS ↗</a>
```

with:

```js
          <div style="display:flex; flex-direction:column; gap:7px; margin-top:auto">
            ${wantControlHtml(rec)}
            <a href="https://www.discogs.com/release/${rec.id}" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.06em; padding:7px 10px; border:1.5px solid var(--line); color:var(--ink); text-align:center">VIEW ON DISCOGS ↗</a>
```

(The VIEW ON DISCOGS and LISTEN links keep their order and styling. The modal preserves focus across the
post-action re-render via `_modalFocusKey`, keyed on `data-act`+`data-arg` — the want button keeps focus.)

(The modal preserves focus across the post-action re-render via `_modalFocusKey`, keyed on
`data-act`+`data-arg` — the want button keeps focus automatically.)

### 4d — dispatch the clicks

In `onClick(e)`, add two cases immediately BEFORE `case 'stop':` (app.js:925):

```js
    case 'want': toggleWant(Number(arg), t.dataset.want==='remove'?'remove':'add'); break;
    case 'wantRemove': removeWant(Number(arg)); break;
```

### 4e — the handlers + toast

Add all of this immediately AFTER `function track(name, data){ … }` (app.js:886):

```js
/* Wave 2 B2 — wantlist write handlers. In-flight guard per release id so a double-tap or an
   overlapping card+modal click can't fire two writes for the same record. */
const _wantInflight = new Set();

/* Friend-crate toggle: optimistically flip the viewer's want membership (drives both the badge and the
   button label), then reconcile the MATCHES stat from the server. Revert everything on failure. The Edge
   fn seeds the release server-side if needed, so no seed is sent from here. */
async function toggleWant(id, action){
  if (!window.TraxWaxSetWant || _wantInflight.has(id)) return;
  const ctx = window.__twMatchCtx;
  const hasCtx = !IS_OWN() && ctx && ctx.viewerWants;
  _wantInflight.add(id);
  if (hasCtx){ if (action==='add') ctx.viewerWants.add(id); else ctx.viewerWants.delete(id); }
  render();
  try {
    await window.TraxWaxSetWant(id, action);
    track(action==='add'?'wantlist_add':'wantlist_remove', { source: state.view });
    if (hasCtx && window.TraxWaxMatchCounts){
      try { window.__twMatchCounts = await window.TraxWaxMatchCounts(); } catch(e){}
      render();
    }
  } catch(e){
    if (hasCtx){ if (action==='add') ctx.viewerWants.delete(id); else ctx.viewerWants.add(id); }
    render();
    showToast(e && e.status===409 ? 'Connect Discogs to change your wantlist'
                                  : 'Couldn’t update your wantlist — try again', null, null);
  } finally { _wantInflight.delete(id); }
}

/* WANTLIST-tab remove: optimistically drop the row (card vanishes), fire the Discogs DELETE, and offer
   an UNDO toast that re-adds. Revert the row on failure. */
async function removeWant(id){
  if (!window.TraxWaxSetWant || _wantInflight.has(id) || !Array.isArray(WANTLIST_RECORDS)) return;
  const idx = WANTLIST_RECORDS.findIndex(x=>x.id===id);
  if (idx<0) return;
  const row = WANTLIST_RECORDS[idx];
  const wasOpen = state.detailId===id;
  _wantInflight.add(id);
  WANTLIST_RECORDS.splice(idx,1);
  if (wasOpen) state.detailId=null;
  render();
  try {
    await window.TraxWaxSetWant(id, 'remove');
    track('wantlist_remove', { source: 'wantlist' });
    showToast('Removed from your wantlist', 'UNDO', ()=>_undoRemoveWant(id, row, idx));
  } catch(e){
    WANTLIST_RECORDS.splice(Math.min(idx, WANTLIST_RECORDS.length), 0, row);
    if (wasOpen) state.detailId=id;   // restore the modal we optimistically closed
    render();
    showToast('Couldn’t remove — try again', null, null);
  } finally { _wantInflight.delete(id); }
}

/* UNDO for a wantlist-tab remove: re-add on Discogs and restore the card at its old position. NOTE: the
   re-added row's `added` becomes today (Discogs stamps a fresh date_added on re-add and the mirror follows)
   — the original add-date is not preserved. Accepted: a re-added want is legitimately "added now". */
async function _undoRemoveWant(id, row, idx){
  if (_wantInflight.has(id) || !Array.isArray(WANTLIST_RECORDS)) return;
  _wantInflight.add(id);
  try {
    await window.TraxWaxSetWant(id, 'add');
    if (!WANTLIST_RECORDS.some(x=>x.id===id)) WANTLIST_RECORDS.splice(Math.min(idx, WANTLIST_RECORDS.length), 0, row);
    track('wantlist_add', { source: 'undo' });
    render();
  } catch(e){ showToast('Couldn’t undo — try again', null, null); }
  finally { _wantInflight.delete(id); }
}

/* Minimal toast: one at a time, auto-dismiss 6s, optional single action. No dependencies; theme-aware. */
let _toastTimer=null;
function showToast(msg, actionLabel, onAction){
  let el=document.getElementById('tw-toast');
  if(!el){
    el=document.createElement('div'); el.id='tw-toast';
    el.style.cssText="position:fixed; left:50%; bottom:24px; transform:translateX(-50%); z-index:9999; "+
      "display:flex; align-items:center; gap:14px; max-width:calc(100vw - 32px); padding:11px 16px; "+
      "background:#16171a; color:#fff; border:1.5px solid var(--accent); box-shadow:4px 4px 0 rgba(0,0,0,.28); "+
      "font-family:'IBM Plex Mono',monospace; font-size:11.5px; letter-spacing:.03em";
    document.body.appendChild(el);
  }
  clearTimeout(_toastTimer);
  el.innerHTML='';
  const span=document.createElement('span'); span.textContent=msg; el.appendChild(span);
  if(actionLabel && onAction){
    const b=document.createElement('button');
    b.textContent=actionLabel;
    b.style.cssText="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.06em; "+
      "font-weight:700; padding:4px 10px; border:1.5px solid var(--accent); background:var(--accent); "+
      "color:var(--on-accent); cursor:pointer";
    b.addEventListener('click', ()=>{ _dismissToast(); onAction(); });
    el.appendChild(b);
  }
  el.style.display='flex';
  _toastTimer=setTimeout(_dismissToast, 6000);
}
function _dismissToast(){ const el=document.getElementById('tw-toast'); if(el) el.style.display='none'; clearTimeout(_toastTimer); }
```

Everything referenced (`IS_OWN`, `state`, `render`, `WANTLIST_RECORDS`, `window.__twMatchCtx`,
`window.__twMatchCounts`, `window.TraxWaxMatchCounts`) already exists (app.js:38, module state, 167;
boot.js:363–380). No other call sites change.

---

## Task 5 — verify, deploy, probe

### 5a — syntax (Cowork sandbox)

```
cd "<repo>/public" && node --check app.js && node --check boot.js && node --check boot.ui.js
```
Expected: three lines, no output but the echoed "OK"s you add; any SyntaxError fails the task.

### 5b — deploy the Edge Function (break-glass, on Lane's Mac or via armed connector)

```
supabase functions deploy wantlist-write --project-ref sfipqknrbvamwwahwxnl
```
Expected: `Deployed Function wantlist-write`. Confirm `config.toml` was committed so verify_jwt=false sticks.

### 5c — live probes (after deploy, signed in as a test user)

1. **Add from a friend's crate**: open a friend's crate, find a record you don't own, click ＋ ADD TO
   WANTLIST → badge flips to ON YOUR WANTLIST, button flips to ✕ REMOVE, `YOU WANT n THEY HAVE` increments
   by 1 (only if the friend owns it). Reload → state persists (row is in `wantlist_items`).
2. **Remove via the toggle**: click ✕ REMOVE on that same friend card → badge clears, count decrements,
   button returns to ＋ ADD.
3. **THE WANTLIST tab remove + undo**: on your wantlist, click ✕ REMOVE on a card → it vanishes, toast
   appears → click UNDO → the card returns; reload → still present.
4. **Discogs side-check**: after an add, confirm the release appears on the real Discogs wantlist for the
   test account; after a remove, it's gone.
5. **Not-connected path**: (dev) a signed-in user with no Discogs connection → the write returns 409 and
   the toast reads "Connect Discogs…" (no optimistic state left stuck).

---

## Rollback

Frontend is additive (new function + new UI branches gated on view/IS_OWN) — reverting the app.js/boot.js
commit removes the controls with no data migration. The Edge Function can be left deployed (nothing calls
it once the frontend is reverted) or deleted with `supabase functions delete wantlist-write`. No schema
change to unwind.

## Audit plan (Lane's standing rule)

After build: independent pass-1 adversarial audit of the Edge Function (auth scoping, the Discogs-first/
mirror-second ordering, 404-idempotency, FK seed) + the frontend (optimistic revert correctness, the
in-flight guard, the undo re-add path, no leak of friend data through the write), then narrow passes to
convergence. `remediation-audit` after any reviewer-driven rework.
