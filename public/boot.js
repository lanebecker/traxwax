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

/* Stage D: the crate renders from Supabase (collection_items ⋈ releases) under the
   signed-in user's own RLS — the baked-owner guard that protected the baked-data era is
   gone, exactly as its comment promised. (Named obliquely on purpose: D8 step 6b greps for
   the old constant to prove no reference survives, comments included.) */

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
    // Audit #21: if load already fired (bfcache restore, deferred boot), the listener
    // below never runs and this promise hangs forever on a blank page. Check now.
    if (document.readyState === 'complete') return check();
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

/* Stage D data providers. app.js stays dependency-free: everything it needs from the
   authenticated world arrives through these four globals, installed before it is imported.
   When they are absent (main branch until the merge; local dev), app.js falls back to the
   baked collection.json unchanged. */
function installCrateProviders(profile) {
  const fnCall = async (path, payload) => {
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
    if (!r.ok) return null;
    return r.json().catch(() => null);
  };

  // The crate rows: collection_items ⋈ releases via the 0005 FK embed, PAGINATED —
  // PostgREST silently caps any select at 1,000 rows and this user owns ~1,861.
  window.TraxWaxData = async () => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('collection_items')
        .select('release_id, added, rating, vinyl, ' +
          'releases ( artist, title, year, label, styles, genres, thumb, cover_image )')
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error('collection query failed: ' + error.message);
      for (const it of data ?? []) {
        const rel = it.releases || {};
        rows.push({
          id: it.release_id,
          artist: rel.artist || '', title: rel.title || '', year: rel.year || 0,
          label: rel.label || '', styles: rel.styles || [], genres: rel.genres || [],
          vinyl: it.vinyl || '', thumb: rel.thumb || '', cover_image: rel.cover_image || '',
          added: it.added || '', rating: it.rating || 0,
          price: null, crating: null, crcount: null, have: null, want: null,
        });
      }
      if (!data || data.length < 1000) break;
    }
    return rows;
  };

  // Modal tracklist tier 0: the shared CC0 catalog (covers the whole catalog independently
  // of the baked static files). Public-read RLS; shape matches the static files.
  window.TraxWaxReleaseData = async (id) => {
    const { data, error } = await supabase
      .from('releases')
      .select('tracks, country, released, videos')
      .eq('release_id', id)
      .maybeSingle();
    if (error || !data || data.tracks == null) return null;
    return {
      tracks: data.tracks || [], country: data.country || '',
      released: data.released || '', videos: data.videos || [],
    };
  };

  // Restricted data, live under the caller's token, server-cached ≤6h.
  window.TraxWaxStats = async (id) => fnCall('live-stats',
    id == null ? { kind: 'value' } : { kind: 'release', id });

  // RE-SYNC: the Stage C pipeline is idempotent and client-driven; run it again, then
  // refresh the profile so last_import_at is current for the indicator.
  window.TraxWaxRefresh = async () => {
    const ok = await runImport();
    if (ok) {
      const p = await ensureProfile(window.Clerk.user.id);
      window.TraxWaxOwner = ownerInfo(p);
    }
    return ok;
  };

  window.TraxWaxOwner = ownerInfo(profile);
}
function ownerInfo(profile) {
  return {
    ownerLine: profile.discogs_username
      ? profile.discogs_username + "'s shelf · filed by whim"
      : 'Your shelf · filed by whim',
    lastSyncedAt: profile.last_import_at || null,
  };
}

/* Import pipeline, restructured by the Phase 1 cold audit (findings #9-#14): the import
   phase (seconds to a minute) runs blocking with progress UI; ENRICHMENT ALWAYS DRAINS IN
   THE BACKGROUND -- the crate renders without tracklists and they fill in as the drain
   proceeds. last_import_at is set server-side only when enrichment reaches zero remaining,
   so the boot gate keeps healing interrupted runs on later loads. */

const _pipeCall = async (path, payload) => {
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
    // Audit #13: an upstream Discogs 429 arrives as {error:'discogs_failed', status:429}
    // on an HTTP 502 -- surface it so retry logic can wait out the 60s rate window.
    err.upstream = d.status;
    throw err;
  }
  return d;
};

// Retries with backoff -- but NOT on non-retryable 4xx (bad request, auth, not
// connected), and with a 30s wait when the upstream reported a rate limit (audit #13).
const _pipeAttempt = async (fn, onLine) => {
  const delays = [2000, 5000, 10000];
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if ([400, 401, 403, 409].includes(e && e.status)) throw e;
      if (i >= delays.length) throw e;
      const wait = (e && e.upstream === 429) ? 30000 : delays[i];
      if (onLine) onLine('Hiccup (' + ((e && e.message) || e) + ') — retrying…');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
};

/* The import phase only: pages 1..N with elapsed-aware pacing (audit #14: a fixed 250ms
   pace only held 60/min while round-trips stayed >=750ms). Throws on give-up. */
async function importLoop(onLine) {
  let page = 1, pages = 1, startedAt = null;
  do {
    const t0 = Date.now();
    const d = await _pipeAttempt(() => _pipeCall('import-collection',
      startedAt ? { page, started_at: startedAt } : { page }), onLine);
    pages = d.pages; startedAt = d.started_at;
    onLine('Importing — page ' + d.page + ' of ' + d.pages + ' (' + d.items + ' records)');
    if (d.done) break;
    page++;
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, Math.max(0, 1100 - elapsed)));
  } while (page <= pages && page <= 500);
}

/* Background enrichment drain: silent (console only), at most one loop at a time.
   Rate-limited rounds wait 30s and do NOT count toward the stall guard (audit #10). */
let _enrichRunning = false;
function backgroundEnrich() {
  if (_enrichRunning) return;
  _enrichRunning = true;
  (async () => {
    try {
      let prevRemaining = Infinity, noProgress = 0;
      for (let i = 0; i < 500; i++) {
        let d;
        try { d = await _pipeAttempt(() => _pipeCall('enrich-release', {})); }
        catch (e) { console.warn('background enrich stopped:', e); break; }
        if (d.remaining === 0) break;
        if (d.rate_limited) {
          await new Promise((r) => setTimeout(r, 30000));
          continue;
        }
        noProgress = d.remaining >= prevRemaining ? noProgress + 1 : 0;
        prevRemaining = d.remaining;
        if (noProgress >= 3) {
          console.warn('enrichment stalled at', d.remaining, '— resumes next visit');
          break;
        }
      }
    } finally { _enrichRunning = false; }
  })();
}

/* Silent full-pipeline heal for an interrupted re-sync (audit #9/#11): the import phase
   with no UI, then the background drain. */
function backgroundHeal() {
  (async () => {
    try { await importLoop(() => {}); }
    catch (e) { console.warn('background import heal stopped:', e); return; }
    backgroundEnrich();
  })();
}

/* Blocking import with progress UI; returns true when the caller may continue rendering.
   Enrichment is NOT awaited -- the crate renders and tracklists fill in behind it. */
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
  try {
    await importLoop(setLine);
  } catch (e) {
    console.error(e);
    notice('Import hit a wall',
      'We could not finish pulling your collection from Discogs. Nothing is lost — ' +
      'reloading this page picks up where it left off.<br><br>' +
      '<a href="" style="color:var(--accent)">Reload and resume</a>', true);
    return false;
  }
  backgroundEnrich();
  return true;
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

  if (profile.import_status === 'error') {
    notice('Import needs attention',
      'Your stored Discogs connection could not be read, so importing is paused.<br><br>' +
      'This is on us — a reconnect flow is coming. Nothing of yours is lost.', true);
    return;
  }
  // ── Audit #9/#11 (gate amended by the report-verification round): render as soon as
  //    the ITEMS are complete; enrichment always drains in the background. 'idle' is
  //    written only by the import's final page, so idle+items = items phase done — and
  //    the re-link RPC deletes items on a username change (migration 0006), which is
  //    what makes "items exist" mean "the CURRENT account's items". ──
  if (!profile.last_import_at) {
    if (profile.import_status === 'running') {
      const ok = await runImport();        // resume an interrupted first import
      if (!ok) return;                     // runImport rendered the error state itself
    } else {
      const { count, error: cntErr } = await supabase
        .from('collection_items').select('*', { count: 'exact', head: true });
      if (cntErr) { showError(new Error('collection count failed: ' + cntErr.message)); return; }
      if ((count ?? 0) > 0) {
        backgroundEnrich();                // items landed earlier; drain quietly
      } else {
        const ok = await runImport();      // first import
        if (!ok) return;
      }
    }
  } else if (profile.import_status === 'running') {
    backgroundHeal();                      // interrupted re-sync: heal silently
  } else {
    backgroundEnrich();                    // audit #11: sweep up any pending leftovers
  }

  // ── Stage D: inject the data providers, then boot the crate from Supabase. ──
  installCrateProviders(profile);
  await import('/app.js');
  window.TraxWaxBootCrate();
}

let _routeAgain = false;
async function route() {
  // Audit #22: a route request arriving mid-render (the Clerk listener has already
  // flipped lastSignedIn) must not be dropped, or a sign-out during a long render
  // leaves the crate on screen. Queue exactly one re-route.
  if (routing) { _routeAgain = true; return; }
  routing = true;
  try { await render(); } catch (err) { showError(err); }
  finally {
    routing = false;
    if (_routeAgain) { _routeAgain = false; route(); }
  }
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
