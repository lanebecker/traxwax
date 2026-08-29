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
import * as UI from '/boot.ui.js';          // the shell system + every non-crate surface
import { clerkAppearance } from '/boot.clerk.js';   // S2/S3 auth chrome

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

/* shell() — the bare 640px column every state used to wear — is retired. Its callers now
   render UI.stateCard() (public/boot.ui.js), which supplies the wordmark, kicker, and frame
   that make a system message read as the same artifact as the crate. (Surfaces spec §1.) */

/* esc() is now UI.esc (boot.ui.js) — every former caller here routes through the state
   card, which owns escaping. No local copy remains, to keep one source of truth. */

function clearAuthMount() {
  if (!mountedAuthNode) return;
  try { window.Clerk.unmountSignIn(mountedAuthNode); } catch (e) {}
  try { window.Clerk.unmountSignUp(mountedAuthNode); } catch (e) {}
  mountedAuthNode = null;
}

/* notice() is now a thin shim over UI.stateCard() (surfaces spec step 3). Every existing
   call keeps working, wearing the card; call sites that need a kicker / problem slab /
   custom actions pass them through opts. Copy lives in UI.COPY, not inline here. */
function notice(title, bodyHtml, withSignOut = false, opts = {}) {
  clearAuthMount();
  const el = app();
  // A state card owns its own full-screen layout; drop any lingering page class (the
  // account page's tw-acct-wrap) so a card rendered over it — e.g. RE-SYNC → runImport —
  // isn't double-wrapped. showError() does the same for the error path.
  el.className = '';
  el.innerHTML = UI.stateCard({
    kicker: opts.kicker || 'TRAXWAX',
    headline: title,
    body: bodyHtml,
    problem: opts.problem,
    extra: opts.extra,
    actions: opts.actions,
    rule: opts.rule,
    footer: withSignOut ? UI.signOutLink : opts.footer,
  });
  const so = document.getElementById('tw-signout');
  if (so) so.addEventListener('click', (e) => { e.preventDefault(); window.Clerk.signOut(); });
}

/* S11: the raw exception moves into a collapsed <details> labelled TECHNICAL DETAIL — still
   there when debugging with a user, no longer the first thing they read. */
function showError(err) {
  const el = app();
  if (!el) return;
  clearAuthMount();
  el.className = '';   // in case we're erroring out of the account page (tw-acct-wrap)
  el.innerHTML = UI.stateCard({
    kicker: UI.COPY.unexpected.kicker,
    headline: UI.COPY.unexpected.headline,
    body: UI.COPY.unexpected.body,
    extra: '<details style="' + UI.MONO + '; font-size:10.5px; color:var(--faint)">' +
      '<summary style="cursor:pointer; letter-spacing:.12em; text-transform:uppercase">' +
      'Technical detail</summary>' +
      '<pre style="white-space:pre-wrap; word-break:break-word; margin:10px 0 0; ' + UI.MONO +
      '; font-size:11px; color:var(--muted)">' + UI.esc(String((err && err.message) || err)) +
      '</pre></details>',
    actions: UI.btnLink(UI.COPY.unexpected.cta,
      window.location.pathname + window.location.search, { variant: 'secondary' }),
  });
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

/* Ensure a profiles row exists for this Clerk user, and SYNC the Clerk-owned display
   fields into it (Phase 2 profiles): display_name + avatar_url flow one way, Clerk → DB,
   every boot — so the DB copy future social features query can never drift far. The
   upsert deliberately NEVER carries the DB-owned fields (bio, location, collecting_since,
   link1, link2); they are edited directly and must not be touched here.
   upsert (not insert) because two tabs racing would otherwise hit a 23505 PK violation. */
async function ensureProfile(userId) {
  const u = window.Clerk.user;
  const name = [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
  const row = { user_id: userId };
  if (name) row.display_name = name.slice(0, 80);
  // imageUrl is always populated (initials avatar when no photo) and always on Clerk's
  // image host — which the DB check constraint enforces as defense-in-depth.
  if (u?.imageUrl && u.imageUrl.startsWith('https://img.clerk.com/')) {
    row.avatar_url = u.imageUrl;
  }
  const { data, error } = await supabase
    .from('profiles')
    .upsert(row, { onConflict: 'user_id', ignoreDuplicates: false })
    .select('user_id, discogs_username, import_status, last_import_at, ' +
      'display_name, avatar_url, bio, location, collecting_since, link1, link2')
    .single();
  if (error) throw new Error('profile upsert failed: ' + error.message);
  return data;
}

/* The house no-photo user icon (TW_USER_ICON) moved to UI.userIcon(px) / UI.avatar(url, px)
   in boot.ui.js — same fixed-ink SVG, plus the never-render-<img src=""> guard. */

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

  // The account surface is a ROUTE now (S13–S16), not a modal. app.js's header avatar
  // button still calls window.TraxWaxAccount() via its data-act="account" delegate —
  // nothing in app.js changes.
  window.TraxWaxAccount = () => { window.location.href = '/account'; };
}
function ownerInfo(profile) {
  return {
    ownerLine: profile.discogs_username
      ? profile.discogs_username + "'s shelf · filed by whim"
      : 'Your shelf · filed by whim',
    lastSyncedAt: profile.last_import_at || null,
    // Phase 2 profiles: the header avatar button + modal read these.
    displayName: profile.display_name || '',
    avatarUrl: profile.avatar_url || '',
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
/* onProgress(page, pages, items) drives the S7 progress bar; onHiccup(msg) is the retry
   line _pipeAttempt writes on a transient failure. Both optional (backgroundHeal passes
   neither). Previously one onLine string callback did double duty. */
async function importLoop(onProgress, onHiccup) {
  let page = 1, pages = 1, startedAt = null;
  do {
    const t0 = Date.now();
    const d = await _pipeAttempt(() => _pipeCall('import-collection',
      startedAt ? { page, started_at: startedAt } : { page }), onHiccup);
    pages = d.pages; startedAt = d.started_at;
    if (onProgress) onProgress(d.page, d.pages, d.items);
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
      let prevWork = Infinity, noProgress = 0;
      for (let i = 0; i < 500; i++) {
        let d;
        try { d = await _pipeAttempt(() => _pipeCall('enrich-release', {})); }
        catch (e) { console.warn('background enrich stopped:', e); break; }
        // Phase 2 (#3): the loop drains refresh work (tombstone retries, stale rows)
        // after new work. refresh_pending is absent from pre-v5 responses → 0 → the
        // loop behaves exactly as before during rollout.
        const work = d.remaining + (d.refresh_pending || 0);
        if (work === 0) break;
        if (d.rate_limited) {
          await new Promise((r) => setTimeout(r, 30000));
          continue;
        }
        noProgress = work >= prevWork ? noProgress + 1 : 0;
        prevWork = work;
        if (noProgress >= 3) {
          console.warn('enrichment stalled at', work, 'pending — resumes next visit');
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
    try { await importLoop(); }
    catch (e) { console.warn('background import heal stopped:', e); return; }
    backgroundEnrich();
  })();
}

/* Blocking import with progress UI; returns true when the caller may continue rendering.
   Enrichment is NOT awaited -- the crate renders and tracklists fill in behind it.
   S7/S8: the progress line is now a real bar (UI.progressBar); on failure the bar STAYS on
   screen and goes grey at the page it reached — seeing how far it got is what makes
   "nothing is lost" believable. _lastImport* remember that position for the failure card. */
let _lastImportPage = 0, _lastImportPages = 1, _lastImportPct = 0;
async function runImport() {
  const setProgress = (page, pages, items) => {
    _lastImportPage = page; _lastImportPages = pages;
    _lastImportPct = (page / Math.max(1, pages)) * 100;
    const el = document.getElementById('tw-import-progress');
    if (!el) return;
    el.innerHTML =
      '<div style="display:flex; align-items:baseline; justify-content:space-between; ' +
        "font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:700; " +
        'letter-spacing:.1em"><span style="color:var(--ink)">PAGE ' + page + ' OF ' + pages +
        '</span><span style="color:var(--accent)">' + items.toLocaleString() + ' RECORDS</span></div>' +
      UI.progressBar(_lastImportPct);
  };
  _lastImportPage = 0; _lastImportPages = 1; _lastImportPct = 0;
  notice(UI.COPY.importRunning.headline, UI.COPY.importRunning.body, true, {
    kicker: UI.COPY.importRunning.kicker,
    extra: '<div id="tw-import-progress">' +
        '<div style="display:flex; align-items:baseline; justify-content:space-between; ' +
        UI.MONO + '; font-size:11px; font-weight:700; letter-spacing:.1em">' +
        '<span style="color:var(--ink)">CONTACTING DISCOGS…</span></div>' +
        UI.progressBar(0) + '</div>' +
      '<div style="' + UI.MONO + '; font-size:10.5px; letter-spacing:.04em; color:var(--faint); ' +
        'line-height:1.5">' + UI.esc(UI.COPY.importRunning.aside) + '</div>',
  });
  // Surface transient-retry ("Hiccup … — retrying") beneath the bar; the next successful
  // page redraws #tw-import-progress and clears it, which is the behaviour we want.
  const onHiccup = (m) => {
    const el = document.getElementById('tw-import-progress');
    if (el) el.insertAdjacentHTML('beforeend',
      '<div style="' + UI.MONO + '; font-size:10px; letter-spacing:.04em; color:var(--accent); ' +
      'margin-top:6px">' + UI.esc(m) + '</div>');
  };
  try {
    await importLoop(setProgress, onHiccup);
  } catch (e) {
    console.error(e);
    notice(UI.COPY.importFailed.headline, UI.COPY.importFailed.body, true, {
      kicker: 'IMPORT · STOPPED AT PAGE ' + (_lastImportPage || 1),
      extra: '<div>' + UI.progressBar(_lastImportPct, true) + '</div>',
      actions: UI.btnLink(UI.COPY.importFailed.cta,
        window.location.pathname + window.location.search, { variant: 'primary' }),
    });
    return false;
  }
  backgroundEnrich();
  return true;
}

/* S13\u2013S16: the account surface is a ROUTE (/account, /account/discogs), not a modal.
   Rendered by UI.accountPageHtml + UI.bindAccountPage (public/boot.ui.js), which own the
   pixels; every network action is injected here so that module stays Clerk/Supabase-free.
   Why a page, not a modal: Wave 1's friend list is browsable content that needs a URL, and
   the consent toggles need room for copy that carries weight. (Surfaces spec \u00a76.) */
async function renderAccount(profile, section) {
  clearAuthMount();
  let count = null;
  try {
    const res = await supabase.from('collection_items')
      .select('*', { count: 'exact', head: true });
    count = res.count;
  } catch (e) { /* the connection panel shows an em-dash if the count is unavailable */ }
  const el = app();
  el.className = 'tw-acct-wrap';
  el.innerHTML = UI.accountPageHtml({
    profile,
    clerkUser: window.Clerk.user,
    recordCount: count == null ? null : count,
    lastSyncedLabel: profile.last_import_at
      ? new Date(profile.last_import_at).toLocaleString() : 'Never',
    section,
    crateHref: '/app/' + encodeURIComponent(profile.discogs_username || ''),
    hrefFor: (id) => (id === 'profile' ? '/account' : '/account/' + id),
  });
  UI.bindAccountPage(el, {
    onSaveProfile: async (v) => {
      await window.Clerk.user.update({ firstName: v.firstName, lastName: v.lastName });
      const { error } = await supabase.from('profiles').update({
        bio: v.bio, location: v.location, collecting_since: v.collecting_since,
        link1: v.link1, link2: v.link2,
      }).eq('user_id', window.Clerk.user.id);
      if (error) throw new Error(error.message);
      const p = await ensureProfile(window.Clerk.user.id);   // re-sync name -> display_name
      window.TraxWaxOwner = ownerInfo(p);
    },
    onUploadPhoto: async (file) => {
      await window.Clerk.user.setProfileImage({ file });
      await window.Clerk.user.reload();          // imageUrl is stale until reload
      const p = await ensureProfile(window.Clerk.user.id);
      window.TraxWaxOwner = ownerInfo(p);
      return window.Clerk.user.imageUrl;
    },
    // RE-SYNC runs the full import pipeline, which renders its own progress card over this
    // page (runImport -> notice). On success we reload so the fresh count/last-synced show;
    // on failure runImport's own "stopped" card stays and we must NOT paint over it.
    onResync: async () => { const ok = await runImport(); if (ok) window.location.reload(); },
    onDisconnect: async () => { await _pipeCall('disconnect-discogs', {}); window.location.href = '/app'; },
    onDelete: async () => { await _pipeCall('delete-account', { confirm: 'DELETE' }); await window.Clerk.signOut(); },
  });
  const release = UI.trapFocus(el, null);   // no Escape handler -- it's a page, not a modal
  window.addEventListener('popstate', release, { once: true });
}

/* S2 / S3: TraxWax chrome, stock card. Our state card supplies the wordmark + kicker +
   headline; Clerk's component mounts inside the `extra` slot. The step counter on sign-up
   names the three doors up front, which is why people don't abandon at "connect". */
function mountAuth() {
  clearAuthMount();
  const wantSignUp = new URLSearchParams(window.location.search).get('mode') === 'signup';

  app().innerHTML = UI.stateCard({
    kicker: wantSignUp ? 'CREATE AN ACCOUNT · STEP 1 OF 3' : 'SIGN IN',
    headline: wantSignUp ? 'Start a crate' : 'Back to the crate',
    body: wantSignUp
      ? 'Sign up, name your shelf, connect Discogs. Under two minutes, then it files itself.'
      : '',
    extra: '<div id="tw-auth"></div>',
    footer: wantSignUp
      ? 'Already have an account? <a href="/app" style="color:var(--accent)">Sign in</a>'
      : 'New here? <a href="/app?mode=signup" style="color:var(--accent)">Create an account</a>',
  });

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

  // S13–S16: the account surface lives at /account and /account/discogs, OUTSIDE the
  // /app/<username> grammar — no reserved-word carve-out, no collision (surfaces spec §6,
  // Lane's decision 2026-08-29). Reached only when signed in; the isSignedIn guard above
  // has already sent a signed-out visitor to the sign-in card. Branch here, before the
  // onboarding/connect gates, so /account is always a place you can land.
  if (segments[0] && segments[0].toLowerCase() === 'account') {
    const sub = segments[1] ? segments[1].toLowerCase() : 'profile';
    await renderAccount(profile, sub === 'discogs' ? 'discogs' : 'profile');
    return;
  }

  // Phase 2 profiles: ONE skippable completion card, only when the name is missing
  // (email/password signups before the Clerk name toggle, or with it off; Google users
  // arrive complete and never see this). Skipping is remembered per browser; completing
  // sets the Clerk name, so the condition never re-fires anywhere.
  let profileSkip = false;
  try { profileSkip = !!localStorage.getItem('tw_profile_skip'); } catch (e) {}
  // rev1-F9: never intercept an in-flight OAuth return — the parked link expires in
  // 15 minutes and the verify handler must run first.
  const inVerifyLeg = new URLSearchParams(window.location.search).get('connect') === 'verify';
  if (!window.Clerk.user.firstName && !profileSkip && !inVerifyLeg) {
    // S4: real avatar affordance + labelled fields, in the state card. Vertical stack
    // because Wave 1's first-run sharing question belongs here as a fourth row.
    app().innerHTML = UI.stateCard({
      kicker: UI.COPY.onboarding.kicker,
      headline: UI.COPY.onboarding.headline,
      body: UI.COPY.onboarding.body,
      extra:
        '<div id="tw-ob-err" role="alert" style="' + UI.MONO + '; font-size:11.5px; ' +
          'color:var(--accent); min-height:0"></div>' +
        '<div style="display:flex; gap:14px; align-items:center; border:1.5px solid var(--hair); ' +
          'padding:14px">' +
          '<span id="tw-ob-avatar">' + UI.avatar('', 56) + '</span>' +
          '<div style="display:flex; flex-direction:column; gap:7px">' +
            '<span style="' + UI.MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.16em; ' +
              'color:var(--muted)">PHOTO · OPTIONAL</span>' +
            '<label style="' + UI.btnStyle('secondary') + '; display:inline-block">UPLOAD A PHOTO' +
              '<input id="tw-ob-photo" type="file" accept="image/jpeg,image/png,image/webp" ' +
              'style="display:none"></label>' +
          '</div>' +
        '</div>' +
        '<div class="tw-acct-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:14px 16px">' +
          UI.field({ id: 'tw-ob-first', label: 'FIRST NAME', autocomplete: 'given-name' }) +
          UI.field({ id: 'tw-ob-last', label: 'LAST NAME', autocomplete: 'family-name' }) +
        '</div>',
      actions: UI.btn(UI.COPY.onboarding.cta, { id: 'tw-ob-save' }) +
        UI.btn(UI.COPY.onboarding.skip, { id: 'tw-ob-skip', variant: 'quiet' }),
    });
    // Preview a chosen photo in the avatar slot; it's still applied on SAVE, as before.
    const obPhoto = document.getElementById('tw-ob-photo');
    if (obPhoto) obPhoto.addEventListener('change', () => {
      const f = obPhoto.files && obPhoto.files[0];
      if (!f) return;
      const slot = document.getElementById('tw-ob-avatar');
      if (slot) { try { slot.innerHTML = UI.avatar(URL.createObjectURL(f), 56); } catch (e) {} }
    });
    document.getElementById('tw-ob-skip').addEventListener('click', () => {
      try { localStorage.setItem('tw_profile_skip', '1'); } catch (e) {}
      route();
    });
    document.getElementById('tw-ob-save').addEventListener('click', async () => {
      const first = document.getElementById('tw-ob-first').value.trim();
      const last = document.getElementById('tw-ob-last').value.trim();
      const err = document.getElementById('tw-ob-err');
      if (!first) { err.textContent = UI.COPY.onboarding.errNoFirst; return; }
      const btn = document.getElementById('tw-ob-save');
      btn.disabled = true; btn.textContent = 'SAVING…';
      try {
        await window.Clerk.user.update({ firstName: first, lastName: last });
        const photo = document.getElementById('tw-ob-photo').files[0];
        if (photo) {
          if (photo.size > 10 * 1024 * 1024) throw new Error('That photo is over 10 MB.');
          await window.Clerk.user.setProfileImage({ file: photo });
          await window.Clerk.user.reload();   // rev1-F2: imageUrl can be stale until reload
        }
        route();   // re-runs ensureProfile → syncs name/avatar to the DB → continues
      } catch (e) {
        btn.disabled = false; btn.textContent = UI.COPY.onboarding.cta;
        err.textContent = 'Could not save (' + ((e && e.message) || e) + '). Try again.';
      }
    });
    return;
  }

  if (!profile.discogs_username) {
    // Phase 2 (#8): finish a parked link. Possession (the code) + identity (this JWT)
    // are both proven by finalize-connect; see docs/phase-2-account-plan.md.
    if (new URLSearchParams(window.location.search).get('connect') === 'verify') {
      let code = null;
      try { code = sessionStorage.getItem('tw_finalize_code'); } catch (e) {}
      if (code) {
        notice(UI.COPY.verify.headline, UI.COPY.verify.body, false, { kicker: UI.COPY.verify.kicker });
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
    // S5 / S6: all thirteen connect failures render through ONE treatment — status → kicker,
    // human sentence → problem slab, retry stays a primary button. Copy is UI.COPY.connect* .
    // The reassurance panel ("WHAT WE READ") is not decoration: this is the screen where
    // someone hands over an OAuth token, and the panel is why they do. paintConnect() also
    // re-renders on an inline failure, rebuilding an enabled button (no dead-button path).
    const paintConnect = (problemOverride) => {
      const status = new URLSearchParams(window.location.search).get('connect');
      const failed = !!problemOverride || (status && status !== 'ok');
      notice(UI.COPY.connect.headline,
        '<div style="' + UI.BODY + '; font-size:13px; line-height:1.65">' +
          UI.COPY.connect.body + '</div>' +
        '<div style="border:1.5px solid var(--hair); padding:14px 16px; margin-top:16px; ' +
          'display:flex; flex-direction:column; gap:7px">' +
          '<span style="' + UI.MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.16em; ' +
            'color:var(--muted)">' + UI.COPY.connect.reassureLabel + '</span>' +
          '<span style="' + UI.BODY + '; font-size:12.5px; line-height:1.6">' +
            UI.COPY.connect.reassure + '</span></div>',
        true,
        {
          kicker: failed
            ? (UI.COPY.connectErrorKickers[status] || 'CONNECT · SOMETHING FAILED')
            : UI.COPY.connect.kicker,
          problem: problemOverride ||
            (failed ? (UI.COPY.connectErrors[status] || 'Connection failed. Try again.') : null),
          actions: UI.btn(failed ? 'Try again' : UI.COPY.connect.cta, { id: 'tw-connect' }),
        });
      const btn = document.getElementById('tw-connect');
      if (!btn) return;
      btn.addEventListener('click', async () => {
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
          // 'cooldown' is the leg-1 throttle (issue #2) — surface guidance, not the token.
          if (!r.ok || !d.authorize_url) {
            throw new Error(d.error === 'cooldown'
              ? 'One connect attempt at a time — try again in a few seconds.'
              : (d.error || ('HTTP ' + r.status)));
          }
          window.location.href = d.authorize_url;
        } catch (e) {
          console.error(e);
          paintConnect(UI.esc('Could not start the connection: ' + ((e && e.message) || e)));
        }
      });
    };
    paintConnect();
    return;
  }

  if (!routeUsername) {
    window.location.replace('/app/' + encodeURIComponent(profile.discogs_username));
    return;
  }

  if (routeUsername.toLowerCase() !== profile.discogs_username.toLowerCase()) {
    // S10 — PRIVACY-CRITICAL. Grey rule (not accent): this is not an error and must not
    // alarm someone who mistyped a URL. In Wave 1 this SAME render must serve both "no such
    // user" and "exists but hasn't shared with you" — UI.COPY.noCrate is written to be true
    // of both, so the page never confirms a username's existence to a stranger. Never add a
    // per-case detail, never vary the kicker or the rule color. (Surfaces spec §9.1.)
    notice(UI.COPY.noCrate.headline, UI.COPY.noCrate.body, true, {
      kicker: UI.COPY.noCrate.kicker,
      rule: 'muted',
      actions: UI.btnLink(UI.COPY.noCrate.cta, '/app', { variant: 'secondary' }),
    });
    return;
  }

  if (profile.import_status === 'error') {
    // S9: the only state whose sole action is destructive → danger (outlined) treatment,
    // no primary. Headline is a consequence ("Importing is paused"), not a category.
    notice(UI.COPY.importPaused.headline, UI.COPY.importPaused.body, true, {
      kicker: UI.COPY.importPaused.kicker,
      actions: UI.btn(UI.COPY.importPaused.cta, { id: 'tw-err-disc', variant: 'danger' }),
    });
    const b = document.getElementById('tw-err-disc');
    if (b) b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'DISCONNECTING…';
      try { await _pipeCall('disconnect-discogs', {}); window.location.href = '/app'; }
      catch (e) { b.disabled = false; b.textContent = UI.COPY.importPaused.cta; console.error(e); }
    });
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

  await clerkReady();
  await window.Clerk.load({
    ui: { ClerkUI: window.__internal_ClerkUICtor },
    // S2 / S3: TraxWax chrome around Clerk's stock card. initThemeEarly() has already run,
    // so dataset.theme is set; the dark card is the theme-following variant (boot.clerk.js).
    appearance: clerkAppearance(document.body.dataset.theme === 'dark'),
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
