/* TraxWax — Phase 1 Stage A boot.
   Resolves theme, then auth, then routes:
     /app                → signed out: sign-IN card  · signed in, no Discogs: connect prompt
     /app?mode=signup    → signed out: sign-UP card
     /app/<username>     → signed in AND username matches the owner: the crate
                           otherwise: not-found card (crates are private in Phase 1)
   app.js is imported ONLY after ownership is established, so an unauthenticated visitor
   never downloads or runs the crate renderer.

   WHY SIGN-UP IS ITS OWN MODE
   ---------------------------
   The first version mounted only SignIn with `withSignUp: true`. That prop is NOT part of
   the documented SignInProps for clerk-js — it was silently ignored, so the card offered
   sign-in only and there was no way to create an account at all. Google SSO then failed with
   "The External Account was not found", which is exactly what a sign-IN attempt produces for
   an account that does not exist yet.

   The mode lives in a QUERY PARAM, not a path segment: /app/sign-up would be parsed as a
   username by the routing below and collide with the /app/<username> grammar.

   WHY THERE IS AN AUTH-STATE LISTENER
   -----------------------------------
   Clerk's components default to HASH routing in vanilla JS, so completing a sign-up can
   finish in place without a page load. Routing ran once at module load, saw a signed-out
   user, and never re-evaluated — leaving a signed-in user staring at a sign-in form. */

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
let mountedAuthNode = null;   // so we can unmount Clerk cleanly before re-rendering
let routing = false;
let lastSignedIn = null;

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

function clearAuthMount() {
  if (!mountedAuthNode) return;
  try { window.Clerk.unmountSignIn(mountedAuthNode); } catch (e) {}
  try { window.Clerk.unmountSignUp(mountedAuthNode); } catch (e) {}
  mountedAuthNode = null;
}

function notice(title, bodyHtml, withSignOut = false) {
  clearAuthMount();
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

function showError(err) {
  const el = app();
  if (!el) return;
  el.innerHTML = shell(`
    <div style="font-family:Anton,sans-serif; font-size:34px; color:var(--accent);
      margin-bottom:14px">Something went sideways</div>
    <div style="font-size:13px; line-height:1.7; color:var(--muted)">${
      esc(String((err && err.message) || err))
    }</div>`);
  console.error(err);
}

/* Clerk's script tags are `defer`, so the global exists only after window load.
   Re-check after load: if clerk.browser.js was blocked, fail loudly rather than
   throwing a TypeError into a blank page. */
function clerkReady() {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (window.Clerk) return resolve();
      reject(new Error('Clerk did not load — check for an ad blocker or network failure.'));
    };
    if (window.Clerk) return resolve();
    window.addEventListener('load', check, { once: true });
  });
}

/* Ensure a profiles row exists for this Clerk user. This is also Stage A's RLS proof: the
   write can only succeed if Supabase accepted a real Clerk token AND profiles_insert_own
   matched auth.jwt()->>'sub' against the row's user_id.
   upsert (not insert) because two tabs racing would otherwise hit a 23505 PK violation. */
async function ensureProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: false })
    .select('user_id, discogs_username, import_status, last_import_at')
    .single();
  if (error) throw new Error('profile upsert failed: ' + error.message);
  return data;
}

/* Stage C import driver. Renders its own progress UI via notice(), drives the chunked
   import-collection loop then the enrich-release loop, and returns true when the caller
   may continue rendering. On give-up it renders an error notice and returns false —
   and because last_import_at is only set server-side when enrichment finishes, any
   give-up or tab-close resumes automatically on the next load. */
async function runImport() {
  const setLine = (msg) => {
    const el = document.getElementById('tw-import-line');
    if (el) el.textContent = msg;
  };
  notice('Filing your records',
    'Pulling your collection from Discogs. This runs once and takes under a minute for ' +
    'most crates.<br><br><div id="tw-import-line" style="color:var(--accent); ' +
    "font-family:'IBM Plex Mono',monospace; font-size:12px; letter-spacing:.08em\">" +
    'Contacting Discogs…</div>', true);

  const call = async (path, payload) => {
    const token = await window.Clerk.session.getToken();
    const r = await fetch(SUPABASE_URL + '/functions/v1/' + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(d.error || ('HTTP ' + r.status));
      err.status = r.status;
      throw err;
    }
    return d;
  };

  // Retries with backoff — but NOT on non-retryable 4xx (bad request, auth, not
  // connected): those fail identically every time and retrying just delays the truth.
  const attempt = async (fn) => {
    const delays = [2000, 5000, 10000];
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if ([400, 401, 403, 409].includes(e && e.status)) throw e;
        if (i >= delays.length) throw e;
        setLine('Hiccup (' + ((e && e.message) || e) + ') — retrying…');
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  };

  try {
    let page = 1, pages = 1, startedAt = null;
    do {
      const d = await attempt(() => call('import-collection',
        startedAt ? { page, started_at: startedAt } : { page }));
      pages = d.pages; startedAt = d.started_at;
      setLine('Importing — page ' + d.page + ' of ' + d.pages +
        ' (' + d.items + ' records)');
      if (d.done) break;
      page++;
      // Modest inter-page pace: ~48 pages/min worst case keeps a very large collection
      // under the 60/min token budget without slowing a normal import noticeably.
      await new Promise((r) => setTimeout(r, 250));
    } while (page <= pages && page <= 500);

    // Enrichment: loop until the server reports zero remaining. A rate-limit report
    // waits 30s; repeated calls with no progress (the guard trips on the fourth
    // consecutive zero-progress call) mean something upstream is stuck — stop WITHOUT
    // failing the whole flow (tracklists fill in on a later visit, because
    // last_import_at is only set when remaining hits 0).
    let prevRemaining = Infinity, noProgress = 0;
    for (let i = 0; i < 500; i++) {
      const d = await attempt(() => call('enrich-release', {}));
      if (d.remaining === 0) break;
      setLine('Filling in tracklists — ' + d.remaining + ' to go');
      noProgress = d.remaining >= prevRemaining ? noProgress + 1 : 0;
      prevRemaining = d.remaining;
      if (noProgress >= 3) {
        console.warn('enrichment stalled at', d.remaining, '— continuing; will resume next visit');
        break;
      }
      if (d.rate_limited) {
        setLine('Discogs asked us to slow down — waiting 30s (' + d.remaining + ' to go)');
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
    return true;
  } catch (e) {
    console.error(e);
    notice('Import hit a wall',
      'We could not finish pulling your collection from Discogs. Nothing is lost — ' +
      'reloading this page picks up where it left off.<br><br>' +
      '<a href="" style="color:var(--accent)">Reload and resume</a>', true);
    return false;
  }
}

function mountAuth() {
  clearAuthMount();
  const wantSignUp = new URLSearchParams(window.location.search).get('mode') === 'signup';

  app().innerHTML = shell(`
    <div id="tw-auth"></div>
    <div style="margin-top:20px; text-align:center; font-size:11px; color:var(--muted)">${
      wantSignUp
        ? 'Already have an account? <a href="/app" style="color:var(--accent)">Sign in</a>'
        : 'New here? <a href="/app?mode=signup" style="color:var(--accent)">Create an account</a>'
    }</div>
  `);

  const node = document.getElementById('tw-auth');
  mountedAuthNode = node;

  if (wantSignUp) {
    window.Clerk.mountSignUp(node, {
      fallbackRedirectUrl: '/app',
      signInUrl: '/app',
      signInFallbackRedirectUrl: '/app',
    });
  } else {
    window.Clerk.mountSignIn(node, {
      fallbackRedirectUrl: '/app',
      signUpUrl: '/app?mode=signup',
      signUpFallbackRedirectUrl: '/app',
    });
  }
}

async function render() {
  const segments = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const routeUsername = segments[1] ? decodeURIComponent(segments[1]) : null;

  if (!window.Clerk.isSignedIn) {
    mountAuth();
    return;
  }

  clearAuthMount();
  const profile = await ensureProfile(window.Clerk.user.id);

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

  // ── Stage C: the import pipeline runs before anything renders, and re-runs until
  //    enrichment closes the gate by setting last_import_at (both phases are idempotent,
  //    so a resume from any interruption point just re-covers cheap ground). ──
  if (profile.import_status === 'error') {
    notice('Import needs attention',
      'Your stored Discogs connection could not be read, so importing is paused.<br><br>' +
      'This is on us — a reconnect flow is coming. Nothing of yours is lost.', true);
    return;
  }
  if (!profile.last_import_at) {
    const ok = await runImport();
    if (!ok) return;            // runImport rendered the error state itself
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

async function route() {
  if (routing) return;
  routing = true;
  try { await render(); } catch (err) { showError(err); } finally { routing = false; }
}

async function boot() {
  initThemeEarly();

  await clerkReady();
  await window.Clerk.load({
    ui: { ClerkUI: window.__internal_ClerkUICtor },
    // Without these the DEVELOPMENT instance sends users to its Account Portal on a
    // different origin after sign-in, and (cookieless_dev + url_based_session_syncing)
    // they never come back signed in. See the Audit record in docs/phase-1-plan.md, C2.
    signInUrl: '/app',
    signUpUrl: '/app?mode=signup',
    signInFallbackRedirectUrl: '/app',
    signUpFallbackRedirectUrl: '/app',
    afterSignOutUrl: '/',
  });

  lastSignedIn = !!window.Clerk.user;

  // Re-route when the signed-in state actually changes. Clerk emits on many updates, so
  // compare rather than routing on every event.
  window.Clerk.addListener(() => {
    const now = !!window.Clerk.user;
    if (now !== lastSignedIn) {
      lastSignedIn = now;
      route();
    }
  });

  await route();
}

boot().catch(showError);
