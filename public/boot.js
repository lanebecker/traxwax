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
      reject(new Error('Clerk did not load — check for an ad blocker or network failure.'));
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
    // they never come back signed in. See the Audit record in docs/phase-1-plan.md, C2.
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
        String(err && err.message || err).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      }</div></div>`;
  }
  console.error(err);
});
