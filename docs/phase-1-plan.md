# TraxWax Phase 1 — Multi-user MVP (implementation plan)

Parent spec: `docs/multi-user-spec.md`. Foundations: `docs/phase-0-plan.md`.

**Revision 2** (2026-08-28) — rev 1 was audited by an independent no-context agent before
execution. It found 2 CRITICAL defects that would have made Stage A fail completely, plus 11
MAJOR issues. All are fixed below; the **Audit record** at the end documents what was wrong so
a future round does not re-litigate a dead finding.

**Status:** **Stage A is planned to executable detail.** Stages B, C and D are scoped but
**NOT yet planned** — do not execute them from this document.

---

## Decisions locked (2026-08-28, with Lane)

| Decision | Choice |
|---|---|
| Front door | Landing page at `/`; app at `/app/<username>` |
| Crate visibility | **Private**, public URL *shape*. `/app/<username>` resolves only for the signed-in owner. |
| Username source | The user's Discogs handle (`profiles.discogs_username`) |
| Build target | `multi-user` branch → Cloudflare Pages preview deploy; `traxwax.com` untouched until merge |
| Lane's own data | Re-imported through OAuth as user #1 — no direct migration of baked data |

### Why crate visibility is private

Under the Discogs API Terms, **which releases a user owns is Restricted Data** — licensed
"limited, personal, non-sublicensable, non-transferable" and not for transfer to third
parties. `multi-user-spec.md` §8 rests its compliance argument on each user reading *their
own* collection under *their own* OAuth grant. Serving one user's crate to a visitor is the
transfer that argument depends on not happening, which is why **§11 places public shareable
crates in Phase 3**.

Building the `/app/<username>` **shape** now costs nothing and means no URL changes if public
crates are later approved. Making them readable by others needs a new RLS policy, a visibility
flag, and ideally written confirmation from Discogs.

> **Noted, unresolved:** §8's Restricted tier includes **usernames**. Phase 1 puts a Discogs
> handle in a URL. This is defensible — it is the user's own handle, behind a private gate,
> shown only to them — but it is not nothing, and it is the first thing to re-examine if
> public crates are ever considered.

---

## Staging

| Stage | Delivers | Risk it retires |
|---|---|---|
| **A** | Branch, routing, landing page, Clerk sign-in, Supabase client under a real Clerk JWT, profile bootstrap | **Does the Clerk→Supabase trust link work end-to-end?** Phase 0 could only test a simulated JWT. |
| **B** | `connect-discogs` — OAuth 1.0a handshake, encrypted token storage, Connect UI | Is OAuth 1.0a signing correct against Discogs? |
| **C** | `import-collection` + `enrich-release`, import progress | Does a 1,861-item import survive the rate limit? |
| **D** | `live-stats`, data-source swap, refresh button, merge to `main` | Does the UI hold up on live per-user data? |

Stage A is the smallest slice that proves the foundation. If the trust link is misconfigured
we learn it with ~200 lines at stake, not with four Edge Functions built on top.

---

# STAGE A — Auth shell

**Definition of done:** on the preview URL you can sign in with Clerk, a `profiles` row exists
carrying your real Clerk `sub`, RLS provably rejects writing a row for a different `sub`, the
CC0 catalog reads back 1,851 rows, and `traxwax.com` is completely unchanged.

## Task A0 — Confirm the Clerk↔Supabase trust link EXISTS (hard precondition)

Every later task assumes this. `docs/phase-0-plan.md:26` lists it as outstanding while
`CLAUDE.md` says it is done — the documents contradict each other, and it is project
configuration that cannot be checked from SQL. Resolve it before writing code.

1. Open **Supabase Dashboard → TraxWax project → Authentication → Sign In / Providers**, and
   find the **Third Party Auth** section.
2. Confirm a **Clerk** provider is listed with domain exactly
   `https://brave-buffalo-7127.clerk.accounts.dev`.
3. Open **https://dashboard.clerk.com/setup/supabase** and confirm it reads as **activated**.

**Expected:** both present. **If either is missing, stop** — activate the Clerk-side Supabase
integration first (never a hand-written JWT template; that method was deprecated 2025-04-01 and
`role` is a reserved claim), then paste the revealed domain into Supabase.

## Task A1 — Retrieve the Clerk publishable key

1. Open **https://dashboard.clerk.com/~/api-keys**.
2. In **Quick Copy**, select **JavaScript** from the dropdown.
3. Copy the **Publishable key** — it begins `pk_test_` (development instance).

**Expected:** a string starting `pk_test_`, roughly 60 characters. It is client-safe and
belongs in committed HTML; it is not a secret. Task A5 gives the exact paste location.

## Task A2 — Create the branch and confirm the preview deploy

Run on the Mac (mutating git never runs against the FUSE mount):

```
cd "/Users/lanebecker-wmf/Documents/Claude.nosync/Projects/Lane's Record Collection/traxwax-clone" && git checkout -b multi-user && git push -u origin multi-user
```

Open **Cloudflare Dashboard → Workers & Pages → traxwax → Deployments**.

**Expected:** a deployment for branch `multi-user` with a preview URL of the form
`https://multi-user.traxwax.pages.dev`. Record it — every verification step uses it.
`https://traxwax.com` must still serve the current site unchanged.

**If no preview appears:** enable **Settings → Builds & deployments → Branch deployments →
All non-Production branches**, then re-push.

While in the dashboard, also confirm **Settings → Environment variables → Preview** contains
`DISCOGS_TOKEN`. `functions/api/*` all read it; without it the header value and modal degrade
to their fallbacks on preview.

## Task A3 — Add the migration for username routing

`/app/<username>` needs `discogs_username` unique **case-insensitively** — Discogs treats
handles case-insensitively, and a plain unique index would let `Lane` and `lane` coexist and
make the route ambiguous.

Create **`supabase/migrations/0002_profile_username.sql`**:

```sql
-- 0002_profile_username.sql — Phase 1 Stage A
--
-- /app/<username> routes on the user's Discogs handle, so a handle must map to at most one
-- TraxWax profile. Indexed on lower() because boot.js compares case-insensitively; a
-- case-SENSITIVE index would admit 'Lane' and 'lane' as separate profiles that both claim
-- ownership of /app/lane.
--
-- The partial predicate is belt-and-braces: Postgres already treats NULLs as distinct in a
-- unique index, so any number of not-yet-connected users can coexist with
-- discogs_username IS NULL. Keeping the predicate makes the intent explicit and keeps the
-- index smaller.

create unique index if not exists profiles_discogs_username_key
  on public.profiles (lower(discogs_username))
  where discogs_username is not null;
```

Apply with the TraxWax Supabase MCP connector (`apply_migration`, name
`0002_profile_username`) or the Supabase SQL editor.

**Verify the index exists:**

```sql
select indexname from pg_indexes
where schemaname='public' and tablename='profiles';
```
**Expected:** includes `profiles_discogs_username_key`.

**Verify it actually enforces** (an index that exists but does not constrain is worse than
none):

```sql
insert into public.profiles (user_id, discogs_username) values ('t_a','CaseTest');
insert into public.profiles (user_id, discogs_username) values ('t_b','casetest');
```
**Expected:** the first succeeds, the second fails with `23505 duplicate key value violates
unique constraint "profiles_discogs_username_key"`. Then clean up:

```sql
delete from public.profiles where user_id in ('t_a','t_b');
```
**Expected:** `DELETE 1` (only `t_a` was created).

## Task A4 — Restructure into landing + app

Only the app **shell HTML** moves under `/app/`. `app.js` deliberately stays at `public/app.js`
— see the C1 note in the Audit record: a `/app/*` rewrite would otherwise swallow it.

Run on the Mac, from the repo root, on the `multi-user` branch:

```
cd "/Users/lanebecker-wmf/Documents/Claude.nosync/Projects/Lane's Record Collection/traxwax-clone" && mkdir -p public/app && git mv public/index.html public/app/index.html && git status --short
```

**Expected:** exactly one rename, `R  public/index.html -> public/app/index.html`. Nothing
else changes. `public/app.js`, `public/styles.css`, `public/collection.json` and
`public/releases/` all stay put.

## Task A5 — Rewrite the app shell

Replace the entire contents of **`public/app/index.html`** with the following. **Before
saving, replace `PASTE_CLERK_PUBLISHABLE_KEY_HERE`** with the key from Task A1 — it appears
once.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TraxWax</title>
<meta name="description" content="TraxWax — your shelf, catalogued past the point of reason.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700;800&family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app" style="min-height:100vh; background:var(--bg); padding:26px 26px 60px"></div>

  <script defer crossorigin="anonymous"
    src="https://brave-buffalo-7127.clerk.accounts.dev/npm/@clerk/ui@1/dist/ui.browser.js"
    type="text/javascript"></script>
  <script defer crossorigin="anonymous"
    data-clerk-publishable-key="PASTE_CLERK_PUBLISHABLE_KEY_HERE"
    src="https://brave-buffalo-7127.clerk.accounts.dev/npm/@clerk/clerk-js@6/dist/clerk.browser.js"
    type="text/javascript"></script>

  <script type="module" src="/boot.js"></script>
</body>
</html>
```

`app.js` is no longer loaded by a `<script>` tag — `boot.js` decides whether to load it, so an
unauthenticated visitor never runs the crate renderer.

**Verify:**
```
cd "/Users/lanebecker-wmf/Documents/Claude.nosync/Projects/Lane's Record Collection/traxwax-clone" && ! grep -q PASTE_CLERK public/app/index.html && echo "key pasted OK"
```
**Expected:** prints `key pasted OK`. (Written as `! grep -q` because `grep -c` exits 1 on a
zero count and would read as failure inside an `&&` chain.)

## Task A6 — Adapt app.js so boot.js controls startup

`public/app.js` does **not** move, so its `fetch('./collection.json')` still resolves correctly
and needs no change. Only its startup behaviour changes.

In **`public/app.js`**, find this line (it is line 561):

```js
async function boot(){
```

Replace it with:

```js
async function bootCrate(){
```

Then find the last line of the file (line 576):

```js
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot); else boot();
```

Replace it with:

```js
window.TraxWaxBootCrate = bootCrate;
```

The crate no longer self-starts; `boot.js` calls it after auth and ownership are established.
`boot` appears on no other line in the file, so nothing is left dangling.

**Verify:**
```
cd "/Users/lanebecker-wmf/Documents/Claude.nosync/Projects/Lane's Record Collection/traxwax-clone" && grep -n "window.TraxWaxBootCrate" public/app.js && grep -c "async function bootCrate" public/app.js
```
**Expected:** one line for the first, `1` for the second.

## Task A7 — Create the auth + routing boot module

Create **`public/boot.js`** (repo path `public/boot.js`, served at `/boot.js`):

```js
/* TraxWax — Phase 1 Stage A boot.
   Resolves theme, then auth, then routes:
     /app                → signed out: sign-in card · signed in, no Discogs: connect prompt
     /app/<username>     → signed in AND username matches the owner: the crate
                           otherwise: not-found card (crates are private in Phase 1)
   app.js is imported ONLY after ownership is established, so an unauthenticated visitor
   never downloads or runs the crate renderer. */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://sfipqknrbvamwwahwxnl.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_RLxgLYBzZoh5YCkYJ3NJZw_8BLFMIWg';

/* Until Stage D swaps the data source, the ONLY collection this app can render is the baked
   public/collection.json — which is Lane's. Serving it to any other signed-in user would be
   exactly the Restricted-Data transfer this project's compliance argument forbids. So the
   crate renders for its actual owner and nobody else until the swap lands.
   Stage D deletes this constant and its guard. */
const BAKED_CRATE_OWNER = 'lanebecker';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  accessToken: async () => {
    try {
      return window.Clerk?.session ? await window.Clerk.session.getToken() : null;
    } catch (e) {
      return null;
    }
  },
});

const app = () => document.getElementById('app');

/* Mirrors initTheme() in app.js. Duplicated deliberately: app.js is not loaded on the
   landing/auth screens, and without this they render light-only and then snap to dark
   when the crate mounts. Keep in sync with app.js initTheme/setTheme. */
function initThemeEarly() {
  let t;
  try { t = localStorage.getItem('tw_theme'); } catch (e) {}
  if (!t) {
    t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  }
  document.body.dataset.theme = t;
}

function shell(inner) {
  return `<div style="max-width:640px; margin:0 auto; padding:96px 0;
    font-family:'IBM Plex Mono',monospace; color:var(--ink)">${inner}</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function notice(title, bodyHtml, withSignOut = false) {
  const signOut = withSignOut
    ? `<div style="margin-top:28px"><a href="#" id="tw-signout"
         style="color:var(--muted); font-size:11px">Sign out</a></div>`
    : '';
  app().innerHTML = shell(`
    <div style="font-family:Anton,sans-serif; font-size:34px; letter-spacing:.02em;
      color:var(--accent); margin-bottom:14px">${esc(title)}</div>
    <div style="font-size:13px; line-height:1.7; color:var(--muted)">${bodyHtml}</div>
    ${signOut}
  `);
  const so = document.getElementById('tw-signout');
  if (so) so.addEventListener('click', (e) => { e.preventDefault(); window.Clerk.signOut(); });
}

/* Clerk's script tags are `defer`, so the global exists only after window load.
   Re-check after load: if clerk.browser.js was blocked, fail loudly rather than
   throwing a TypeError into a blank page. */
function clerkReady() {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (window.Clerk) return resolve();
      reject(new Error('Clerk did not load — check for a blocker or network failure.'));
    };
    if (window.Clerk) return resolve();
    window.addEventListener('load', check, { once: true });
  });
}

/* Ensure a profiles row exists for this Clerk user. This is also Stage A's RLS proof: the
   insert can only succeed if Supabase accepted a real Clerk token AND profiles_insert_own
   matched auth.jwt()->>'sub' against the row's user_id.
   upsert (not insert) because two tabs racing would otherwise hit a 23505 PK violation. */
async function ensureProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: false })
    .select('user_id, discogs_username, import_status')
    .single();
  if (error) throw new Error('profile upsert failed: ' + error.message);
  return data;
}

async function main() {
  initThemeEarly();

  await clerkReady();
  await window.Clerk.load({
    ui: { ClerkUI: window.__internal_ClerkUICtor },
    // Without these the DEVELOPMENT instance sends users to its Account Portal on a
    // different origin after sign-in, and (cookieless_dev + url_based_session_syncing)
    // they never come back signed in. See Audit record C2.
    signInUrl: '/app',
    signUpUrl: '/app',
    signInFallbackRedirectUrl: '/app',
    signUpFallbackRedirectUrl: '/app',
    afterSignOutUrl: '/',
  });

  const segments = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const routeUsername = segments[1] ? decodeURIComponent(segments[1]) : null;

  if (!window.Clerk.isSignedIn) {
    app().innerHTML = shell('<div id="tw-signin"></div>');
    window.Clerk.mountSignIn(document.getElementById('tw-signin'), {
      fallbackRedirectUrl: '/app',
      signUpUrl: '/app',
      withSignUp: true,
    });
    return;
  }

  const userId = window.Clerk.user.id;
  const profile = await ensureProfile(userId);

  if (!profile.discogs_username) {
    notice('Connect your collection',
      'You are signed in, but TraxWax does not know your Discogs account yet.<br><br>' +
      'Connecting Discogs arrives in Stage B. Until then there is nothing to file.', true);
    return;
  }

  if (!routeUsername) {
    window.location.replace('/app/' + encodeURIComponent(profile.discogs_username));
    return;
  }

  if (routeUsername.toLowerCase() !== profile.discogs_username.toLowerCase()) {
    notice('No crate here',
      'This crate is private, or it does not exist.<br><br>' +
      '<a href="/app" style="color:var(--accent)">Go to your own crate</a>', true);
    return;
  }

  // Pre-Stage-D guard — see BAKED_CRATE_OWNER above.
  if (profile.discogs_username.toLowerCase() !== BAKED_CRATE_OWNER) {
    notice('Your crate is still being built',
      'Your Discogs account is connected, but per-user collections land in Stage D.<br><br>' +
      'Nothing of yours is lost — it just is not rendered yet.', true);
    return;
  }

  await import('/app.js');
  window.TraxWaxBootCrate();
}

main().catch((err) => {
  const el = document.getElementById('app');
  if (el) {
    el.innerHTML = `<div style="max-width:640px; margin:0 auto; padding:96px 0;
      font-family:'IBM Plex Mono',monospace">
      <div style="font-family:Anton,sans-serif; font-size:34px; color:var(--accent);
        margin-bottom:14px">Something went sideways</div>
      <div style="font-size:13px; line-height:1.7; color:var(--muted)">${
        String(err && err.message || err).replace(/&/g,'&amp;').replace(/</g,'&lt;')
      }</div></div>`;
  }
  console.error(err);
});
```

## Task A8 — Add the Pages routing rule

`/app/lanebecker` is not a file on disk; Pages must rewrite it to the app shell.

Create **`public/_redirects`**:

```
/app      /app/index.html   200
/app/*    /app/index.html   200
```

Status `200` is a rewrite, so the URL stays `/app/lanebecker` — which is what `boot.js` reads.

> **Why no executable assets live under `/app/`.** Cloudflare Pages redirects are *always*
> followed, "regardless of whether or not an asset matches the incoming request" — unlike
> Netlify, an existing file does **not** win over a splat. If `boot.js` or `app.js` sat under
> `/app/`, this rule would return `index.html` for them with `content-type: text/html`, the
> module MIME check would reject the script, and every page would render blank. This is why
> Task A4 moves only the HTML.

## Task A9 — Create the landing page

Create **`public/index.html`**:

> **Design note — needs Lane's approval before merging to `main`.** Per project rule L5,
> visual design is Lane's to approve. This is a deliberately minimal placeholder in the
> existing TraxWax idiom so Stage A has a working `/`. It is not a designed landing page.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TraxWax</title>
<meta name="description" content="TraxWax — your record collection, filed properly.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<script>
  /* Theme before first paint — mirrors initTheme() in app.js. Without this the landing
     page is light-only regardless of the visitor's preference. */
  (function(){
    var t; try { t = localStorage.getItem('tw_theme'); } catch(e){}
    if(!t) t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    document.addEventListener('DOMContentLoaded', function(){ document.body.dataset.theme = t; });
  })();
</script>
</head>
<body>
  <div style="min-height:100vh; background:var(--bg); color:var(--ink);
    display:flex; flex-direction:column; justify-content:center;
    padding:60px 26px; font-family:'IBM Plex Mono',monospace">

    <div style="max-width:680px; margin:0 auto; width:100%">
      <div style="font-family:Anton,sans-serif; font-size:clamp(48px,11vw,104px);
        line-height:.92; letter-spacing:.01em; color:var(--accent)">TRAXWAX</div>

      <p style="font-size:14px; line-height:1.8; color:var(--muted);
        margin:22px 0 0; max-width:44ch">
        Your record collection, filed properly. Connect Discogs and get a crate you can
        actually browse — by style, by colour, by the year you were obsessed.
      </p>

      <a href="/app" style="display:inline-block; margin-top:34px; padding:13px 22px;
        background:var(--accent); color:var(--on-accent); text-decoration:none;
        font-size:12px; font-weight:700; letter-spacing:.14em; text-transform:uppercase">
        Open your crate
      </a>

      <div style="margin-top:64px; font-size:10px; line-height:1.9; color:var(--muted)">
        <a href="https://www.discogs.com" rel="noopener"
           style="color:var(--muted)">Data provided by Discogs</a><br>
        This application uses Discogs' API but is not affiliated with, sponsored or endorsed
        by Discogs. "Discogs" is a trademark of Zink Media, LLC.
      </div>
    </div>
  </div>
</body>
</html>
```

The attribution block is verbatim from the Discogs API Terms and the link is deliberately
**not** `nofollow`. Do not alter either.

## Task A10 — Update the docs that describe the old layout

`README.md` and `CLAUDE.md` both document the pre-move structure and will mislead the next
reader.

In **`README.md`**, find the line describing `app.js` fetching `./collection.json` (around
line 41) and the repository-structure block (around lines 14–16). Update them to reflect:
`public/index.html` is the landing page, `public/app/index.html` is the app shell,
`public/boot.js` is the auth/routing entry point, and `public/app.js` is the crate renderer
invoked by `boot.js` rather than self-starting.

In **`CLAUDE.md`**, update the architecture tree (around line 17) with the same four facts.

**Verify:** `grep -n "index.html" README.md CLAUDE.md` — no line should imply that
`public/index.html` is the app.

## Task A11 — Commit and deploy

```
cd "/Users/lanebecker-wmf/Documents/Claude.nosync/Projects/Lane's Record Collection/traxwax-clone" && git add -A && git commit -m "Phase 1 Stage A — landing page, /app routing, Clerk auth, Supabase client" && git push
```

**Expected:** push succeeds to `origin/multi-user`; Cloudflare builds a preview. This also
sweeps `docs/phase-1-plan.md` onto the branch, which is intended. `traxwax.com` is untouched —
confirm by loading it.

## Task A12 — Verify Stage A

Against the **preview URL** from Task A2, not traxwax.com.

**1. Landing page renders, honouring theme.** Load `https://multi-user.traxwax.pages.dev/`.
**Expected:** TRAXWAX wordmark, paragraph, "Open your crate" button, Discogs attribution. In a
browser set to dark mode it renders dark, not light. Console shows no errors.

**2. Signed-out app shows sign-in.** Load `/app` in a private window.
**Expected:** Clerk's sign-in card. In DevTools → Network, filter for `app.js` — **it must not
appear.** (Note: `clerk.browser.js` ~307 KB and `ui.browser.js` ~140 KB *do* load; the gate is
free of the crate, not free of JavaScript.)

**3. Sign up as user #1.** Use the sign-up link on the Clerk card.
**Expected:** after sign-up you land back on **the preview URL's `/app`**, signed in, showing
"Connect your collection". **If you end up on `brave-buffalo-7127.accounts.dev` instead**, the
redirect options in `Clerk.load()` did not take — re-check Task A7.

**4. The trust link actually works.** This is the point of Stage A. In the Supabase SQL editor:

```sql
select user_id, discogs_username, import_status, created_at from public.profiles;
```

**Expected:** exactly one row. `user_id` starts with `user_` (a Clerk id, not a UUID),
`discogs_username` is null, `import_status` is `idle`. **This row existing confirms
Clerk→Supabase third-party auth works with a real token** — the gap Phase 0 could not close.

**If the row is missing:** the on-screen error card (not a blank page) carries the message.
`permission denied for table profiles` or a 401 means Supabase is not accepting the token —
return to Task A0.

**5. RLS rejects impersonation.** In the browser console on the signed-in `/app` page:

```js
var m = await import('/boot.js');
await m.supabase.from('profiles').insert({ user_id: 'user_someone_else' });
```
**Expected:** an error with code `42501` (`new row violates row-level security policy`).
A success means RLS is broken — **stop and fix before Stage B.**

**6. The CC0 catalog is readable.**
```js
var r = await m.supabase.from('releases').select('*', { count: 'exact', head: true });
console.log(r.count);
```
**Expected:** `1851`. (`var`, and `m` reused, because `const` redeclaration throws in some
consoles.)

**7. Production is untouched.** Load `https://traxwax.com`.
**Expected:** the existing single-user crate, no sign-in, no behaviour change.

---

# STAGE B — Connect Discogs *(scope only — not yet planned)*

`connect-discogs` Edge Function running the OAuth 1.0a handshake: request token → Discogs
authorize redirect → access token → encrypted write to `discogs_credentials` → populate
`profiles.discogs_username` and `discogs_connected_at`.

Hazards to plan against: OAuth 1.0a needs HMAC-SHA1 request signing (not OAuth 2.0 bearer
tokens); the registered callback URL must match exactly; the consumer secret must never reach
the browser; `discogs_credentials` is readable only by `service_role`, so the function needs
the service key.

**Carry forward:** the moment this stage populates `discogs_username`, the `BAKED_CRATE_OWNER`
guard in `boot.js` becomes the only thing preventing other users from being served Lane's
collection. Do not remove it before Stage D.

# STAGE C — Import & enrich *(scope only — not yet planned)*

`import-collection` (page at `per_page=100`, upsert `collection_items`, idempotent on
`(user_id, instance_id)`) and `enrich-release` (fill CC0 fields for any `release_id` absent
from `releases`). Progress via `profiles.import_status`.

**Corrected figures** (recomputed 2026-08-28, see Audit record M9): `collection.json` holds
**1,861 items** across **1,859 distinct release ids** (two records are owned twice).
`public.releases` holds **1,851** rows. So Lane's import writes 1,861 `collection_items` and
still needs `enrich-release` for **8 releases** — cheap, but not zero.

# STAGE D — Live stats & flip *(scope only — not yet planned)*

`live-stats` for Restricted data (prices, community stats) with a ≤6h cache that never touches
the database. Swap `app.js`'s `fetch('./collection.json')` for a Supabase query joining
`collection_items → releases`. Add "Refresh my crate". Delete `BAKED_CRATE_OWNER` and its
guard. Merge `multi-user` → `main`.

**Note:** `refresh-collection.yml` commits `collection.json` to `main` weekly, so the branch
will need a rebase before this merge.

---

## Open items requiring Lane

1. **Landing page design** (Task A9) — placeholder; needs approval before merge to `main`.
2. **Clerk production instance** — `brave-buffalo-7127.clerk.accounts.dev` is a *development*
   instance (confirmed via its `/v1/environment` endpoint: `instance_environment_type:
   development`, `cookieless_dev: true`). Production is a different issuer and requires
   repointing Supabase. Must happen before public launch; not a Stage A blocker.
3. **CDN pinning** — `@clerk/ui@1`, `@clerk/clerk-js@6` and `@supabase/supabase-js@2` are
   unpinned majors with no SRI, on the page that mints authenticated requests. Accepted for
   preview; pin to exact versions before launch.
4. **Public crates** — deferred by design. Revisit only with a written reading of the terms.

---

## Audit record

Revision 1 was audited by an independent no-context agent before execution. Findings recorded
here rather than silently deleted, so a later round does not re-derive them.

**CRITICAL — fixed**

- **C1 — `_redirects` would have swallowed the JavaScript.** Rev 1 put `boot.js` and `app.js`
  under `public/app/` while rewriting `/app/*` → `/app/index.html`. Cloudflare Pages follows
  redirects *"regardless of whether or not an asset matches the incoming request"*, so both
  scripts would have returned HTML, failed the module MIME check, and rendered every page
  blank. **Fixed:** only the shell HTML lives under `/app/`; `boot.js` is at `public/boot.js`
  and `app.js` never moves (which also removed rev 1's `./collection.json` path edit as
  unnecessary).
- **C2 — sign-in would have navigated users off the site.** The Clerk *development* instance's
  `after_sign_in_url` is `https://brave-buffalo-7127.accounts.dev/default-redirect`, and with
  `cookieless_dev: true` + `url_based_session_syncing: true` a user who navigated back
  manually would appear signed out. `ensureProfile()` would never have run, so Stage A's
  entire purpose — proving the trust link — would never have been exercised, while appearing
  merely broken. **Fixed:** explicit `signInUrl`/`signUpUrl`/fallback redirects in
  `Clerk.load()` and on `mountSignIn`, plus `withSignUp: true`.

**MAJOR — fixed**

- **M1 — every connected user would have been served Lane's collection** between Stage B and
  Stage D, which is precisely the Restricted-Data transfer this plan's compliance section
  forbids. Stage A is safe only because `discogs_username` is null for everyone; Stage B sets
  it. **Fixed:** `BAKED_CRATE_OWNER` guard, with carry-forward notes in Stages B and D.
- **M2 — "Phase 0 complete" was asserted while `phase-0-plan.md:26` lists the Clerk steps as
  outstanding.** **Fixed:** new Task A0 makes it a hard precondition instead of A12
  troubleshooting.
- **M3 — wrong citation.** Public crates are in §11 (Phase 3), not §13. **Fixed.** Also
  surfaced: §8 lists *usernames* as Restricted, which rev 1 never mentioned — now noted.
- **M4 — case-sensitivity mismatch.** A case-sensitive unique index with a case-insensitive
  route check leaves `/app/lane` ambiguous. **Fixed:** index on `lower(discogs_username)`,
  plus a test that the constraint actually fires.
- **M5 — encode/decode asymmetry.** `encodeURIComponent` on write, raw `segments[1]` on read.
  **Fixed:** `decodeURIComponent`.
- **M7 — silent blank pages.** `main()` had no `.catch()`, and `clerkReady()` resolved without
  re-checking `window.Clerk`. **Fixed:** both.
- **M8 — no sign-out control** on a `single_session_mode` instance, making A12's state
  transitions impossible without private windows. **Fixed:** sign-out on notice screens.
- **M9 — wrong count.** Rev 1 said "all 1,851 of his releases are already enriched, so only
  `collection_items` is written." Recomputed: 1,861 items / 1,859 distinct ids owned vs 1,851
  catalogued → **8 releases still need enrichment.** **Fixed** in Stage C.
- **M10 — theme regression.** `styles.css` scopes dark tokens to `body[data-theme="dark"]`,
  set only by `initTheme()` inside `app.js` — so landing and auth screens would render
  light-only, then snap to dark. **Fixed:** early theme init in `boot.js` and inline on the
  landing page.
- **M6 / M11 — accepted, not fixed.** Unpinned CDN majors (now Open item 3) and ~450 KB of
  third-party JS on the sign-in screen (now stated plainly in A12 step 2).

**MINOR — fixed:** `grep -c` exit-code trap (`! grep -q`); `const` redeclaration in the
console (`var`); missing `cd` in verify commands; README/CLAUDE drift (new Task A10);
read-then-insert race in `ensureProfile` (now `upsert`); unescaped `e.message` (now escaped);
`refresh-collection.yml` branch drift (noted in Stage D); Preview `DISCOGS_TOKEN` check (added
to A2).

**Confirmed correct by the audit, no change needed:** the Supabase URL and publishable key
both match the live project; `releases` really is 1,851 rows with all four columns populated;
the `profiles` insert satisfies the real schema (`user_id` is the only NOT NULL column without
a default); all three Task A6 find-strings exist verbatim at the stated lines and `boot` occurs
nowhere else; `app.js` is safe under module semantics (already `'use strict'`, no inline
handlers, no undeclared globals); `./collection.json` was genuinely its only relative
reference; `styles.css` defines every token the new markup uses, so nothing renders invisibly;
the route-segment logic is correct for `/app`, `/app/`, and `/app/<name>`; re-importing a
module from the console does not re-run it and `supabase` is reachable as `m.supabase`; the
`ClerkUI` load option is genuinely required by clerk-js 6.30.1, not cargo cult; script
execution order puts both Clerk scripts before `boot.js`; all three CDN URLs resolve 200; and
nothing the plan says to create already exists.
