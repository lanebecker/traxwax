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

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm';
import * as UI from '/boot.ui.js';          // the shell system + every non-crate surface
import { clerkAppearance } from '/boot.clerk.js';   // S2/S3 auth chrome

const SUPABASE_URL = 'https://sfipqknrbvamwwahwxnl.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_RLxgLYBzZoh5YCkYJ3NJZw_8BLFMIWg';

/* Stage D: the crate renders from Supabase (collection_items ⋈ releases) under the
   signed-in user's own RLS — the baked-owner guard that protected the baked-data era is
   gone, exactly as its comment promised. (Named obliquely on purpose: D8 step 6b greps for
   the old constant to prove no reference survives, comments included.) */

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  // #124 (T2.2): return null ONLY when there is genuinely no session (signed out / public path) —
  // a correct anonymous request. Do NOT swallow a getToken() failure to null: an anonymous read
  // passes RLS and returns [] with no error, which the crate paints as "you own nothing" right after
  // a successful import. Letting getToken() fail makes supabase-js resolve the query {data:null, error}
  // (it does NOT throw — the request just aborts before fetch), and every provider's `if (error) throw`
  // turns that into the "Couldn't load … RETRY" card instead of a silently-empty crate.
  accessToken: async () => {
    if (!window.Clerk?.session) return null;
    return await window.Clerk.session.getToken();
  },
});

const app = () => document.getElementById('app');

/* T2.8 (#130): every full-screen STATE CARD (sign-in, notice, error, first-run onboarding, 404)
   replaces #app's children — but the detail modal / DNA sheet live in body-level roots
   (tw-modal-root / tw-dna-root) and #app may be inert + aria-hidden beneath an open modal
   (renderModal / renderDna in app.js). Replacing #app's innerHTML clears NEITHER, so a state card
   can render inside an inert, aria-hidden #app with a stale modal still painted above it — e.g. a
   cross-tab sign-out (Clerk's listener → route() → mountAuth()) while a record modal is open leaves
   the sign-in card unclickable beneath the previous session's modal, still showing that user's data.
   Reset both, on every state-card path. renderPublicNotFound already did this inline; the rest didn't. */
function resetShellChrome(el) {
  for (const id of ['tw-modal-root', 'tw-dna-root']) {
    const n = document.getElementById(id); if (n) n.innerHTML = '';
  }
  if (el) { try { el.inert = false; el.removeAttribute('aria-hidden'); } catch (e) {} }
}
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
  resetShellChrome(el);   // T2.8 (#130): drop any open modal + inert left by app.js before this card takes over #app
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
  if (so) so.addEventListener('click', (e) => { e.preventDefault(); window.Clerk.signOut({ redirectUrl: '/' }); });
}

/* S11: the raw exception moves into a collapsed <details> labelled TECHNICAL DETAIL — still
   there when debugging with a user, no longer the first thing they read. */
function showError(err) {
  const el = app();
  if (!el) return;
  clearAuthMount();
  resetShellChrome(el);   // T2.8 (#130): same reset as the other state cards
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
      'display_name, avatar_url, bio, location, collecting_since, link1, link2, crate_visibility, wantlist_visibility, match_mode, forsale_visibility, public_slug, og_palette')
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
  // E2 (#100): thin alias over the ONE edgeCall — swallow-to-null is this installer's
  // deliberate contract (optimistic UI shows "—", never an error card, on a stats miss).
  const fnCall = (path, payload) => edgeCall(path, payload, { throwOnError: false });

  // The crate rows: collection_items ⋈ releases via the 0005 FK embed, PAGINATED —
  // PostgREST silently caps any select at 1,000 rows and this user owns ~1,861.
  window.TraxWaxData = async () => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('collection_items')
        .select('release_id, added, rating, vinyl, ' +
          'releases ( artist, title, year, label, styles, genres, thumb, cover_image, master_year )')   // Wave 5a: master_year for the DNA card
        .eq('user_id', profile.user_id)   // v1.4.2 fix: scope to OWN rows. The Wave 1 friend-read
        .order('id', { ascending: true }) // RLS policy widened this SELECT, so relying on RLS alone
        .range(from, from + 999);         // leaked friends' shared records into the owner's crate.
      if (error) throw new Error('collection query failed: ' + error.message);
      for (const it of data ?? []) {
        const rel = it.releases || {};
        rows.push({
          id: it.release_id,
          artist: rel.artist || '', title: rel.title || '', year: rel.year || 0,
          // Wave 5a: master (original-release) year first, pressing year as the fallback — covers both
          // null (not yet backfilled) and the 0 sentinel (resolved, no usable master year). The DNA card's
          // decade histogram reads releaseYear so a reissue counts in its ORIGINAL decade, not its press year.
          releaseYear: (rel.master_year && rel.master_year > 0) ? rel.master_year : (rel.year || 0),
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

  // Wave 2 B1: THE WANTLIST tab data — own wantlist ⋈ releases, scoped to the owner (own-select RLS).
  window.TraxWaxWantlistData = async () => {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('wantlist_items')
        .select('release_id, added, vinyl, ' +
          'releases ( artist, title, year, label, styles, genres, thumb, cover_image )')
        .eq('user_id', profile.user_id)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error('wantlist query failed: ' + error.message);
      for (const it of data ?? []) {
        const rel = it.releases || {};
        rows.push({
          id: it.release_id,
          artist: rel.artist || '', title: rel.title || '', year: rel.year || 0,
          label: rel.label || '', styles: rel.styles || [], genres: rel.genres || [],
          vinyl: it.vinyl || '', thumb: rel.thumb || '', cover_image: rel.cover_image || '',   // 0030: real variant, was hardcoded ''
          added: it.added || '', rating: 0,
          price: null, crating: null, crcount: null, have: null, want: null,
        });
      }
      if (!data || data.length < 1000) break;
    }
    return rows;
  };

  // Wave 4 Stage 1: the caller's OWN for-sale listings — release_id → listing_id (own-select RLS).
  // Drives the FOR SALE badge, the FOR SALE facet, the ledger stat, and the modal's listed-state.
  window.TraxWaxInventory = async () => {
    const map = new Map();   // release_id → listing_id
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('inventory_items')
        .select('release_id, listing_id').eq('user_id', profile.user_id)
        .order('id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error('inventory query failed: ' + error.message);
      for (const it of data ?? []) map.set(it.release_id, it.listing_id);
      if (!data || data.length < 1000) break;
    }
    return map;
  };

  // Modal tracklist tier 0: the shared CC0 catalog (covers the whole catalog independently
  // of the baked static files). Public-read RLS; shape matches the static files.
  window.TraxWaxReleaseData = async (id) => {
    const { data, error } = await supabase
      .from('releases')
      .select('tracks, country, released')   // E3 #101: videos never rendered — stop fetching
      .eq('release_id', id)
      .maybeSingle();
    if (error || !data || data.tracks == null) return null;
    return {
      tracks: data.tracks || [], country: data.country || '',
      released: data.released || '',
    };
  };

  // Restricted data, live under the caller's token, server-cached ≤6h.
  // E2 (#100): the dual-arity accident is split — TraxWaxValue is the header EST. figure,
  // TraxWaxStats is per-release only (matching the friend installer's shape). A caller can
  // no longer get the whole-collection value by forgetting an argument.
  window.TraxWaxValue = async () => fnCall('live-stats', { kind: 'value' });
  window.TraxWaxStats = async (id) =>
    id == null ? {} : fnCall('live-stats', { kind: 'release', id });

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

  // Wave 2 B2: the first Discogs write — add/remove one release on the caller's own wantlist, then the
  // Edge fn mirrors it into wantlist_items (and seeds the release server-side if the catalog lacks it).
  // Single call, no page loop; errors throw with .status for the caller to surface.
  window.TraxWaxSetWant = async (releaseId, action) =>
    _pipeCall('wantlist-write', { release_id: releaseId, action });

  window.TraxWaxOwner = ownerInfo(profile);

  // The account surface is a ROUTE now (S13–S16), not a modal. app.js's header avatar
  // button still calls window.TraxWaxAccount() via its data-act="account" delegate —
  // nothing in app.js changes.
  window.TraxWaxAccount = () => { window.location.href = '/account'; };
}
function ownerInfo(profile) {
  return {
    // The " · filed by <word>" tagline is appended at the render site (app.js), owner-crate only —
    // don't bake it here, or the word wouldn't cycle.
    ownerLine: profile.discogs_username
      ? profile.discogs_username + "'s shelf"
      : 'Your shelf',
    lastSyncedAt: profile.last_import_at || null,
    // Phase 2 profiles: the header avatar button + modal read these.
    displayName: profile.display_name || '',
    avatarUrl: profile.avatar_url || '',
    ownerUsername: profile.discogs_username || '',   // header spec §3.1 — own meta line "@{handle}"
    collectingSince: profile.collecting_since || null,   // header spec §3.1 — own meta line "COLLECTING SINCE {year}"
    isOwn: true,   // Wave 1: app.js IS_OWN() branch — the owner's own crate
  };
}

/* Wave 5b T2c: the VIEWER's own match context (their wants/haves/sells, exact + any-pressing
   sets) — used by the friend path since Wave 2 B1 and by /c/ public-in since 5b. Scoped to
   the signed-in CALLER; owner-side data never enters here. Body unchanged in the extraction. */
function installViewerMatchCtx() {
// Wave 2 B1: the VIEWER's own wants + haves as id Sets — the badges match these against the friend's
// displayed records (own data, no consent gate). MUST scope to the viewer; owner.user_id is the FRIEND.
// #28: adds master_id sets (join releases) for any-pressing matching. ALSO fixes a pre-existing bug —
// the old body had no .range(), so PostgREST silently capped the viewer's own collection/wantlist at
// 1,000 rows (Lane owns ~1,861 → viewerHas was truncated, undercounting YOU-OWN badges + IN COMMON on
// every friend's crate). Paginate like the sibling providers. `if (m)` excludes Discogs' no-master 0.
window.TraxWaxMatchCtx = async () => {
  const me = window.Clerk.user.id;
  const pull = async (table) => {
    const ids = new Set(), masters = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(table)
        .select('release_id, releases(master_id)').eq('user_id', me)
        .order('id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error('match ctx failed (' + table + '): ' + error.message);
      for (const r of data ?? []) { ids.add(r.release_id); const m = r.releases && r.releases.master_id; if (m) masters.add(m); }
      if (!data || data.length < 1000) break;
    }
    return { ids, masters };
  };
  // #59 #3/#4 split: also pull the CALLER's OWN for-sale inventory (release_ids), so the friend-wantlist can split into
  // "they want that you're SELLING" vs "they want that you HAVE (unlisted)". This is the viewer's own data (no consent gate),
  // scoped to `me` — NOT window.__twInventory, which on a friend crate is the FRIEND's for-sale.
  const pullInv = async () => {
    const ids = new Set(), masters = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('inventory_items')
        .select('release_id, releases(master_id)').eq('user_id', me).eq('status', 'for_sale')
        .order('id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error('match ctx failed (inventory_items): ' + error.message);
      for (const r of data ?? []) { ids.add(r.release_id); const m = r.releases && r.releases.master_id; if (m) masters.add(m); }
      if (!data || data.length < 1000) break;
    }
    return { ids, masters };
  };
  const [w, c, iv] = await Promise.all([pull('wantlist_items'), pull('collection_items'), pullInv()]);
  return {
    viewerWants: w.ids, viewerWantsMasters: w.masters,
    viewerHas:   c.ids, viewerHasMasters:   c.masters,
    viewerSells: iv.ids, viewerSellsMasters: iv.masters,
  };
};
}

/* Wave 1: providers for a READ-ONLY friend crate. `owner` is the display projection from
   get_crate_owner. Reads the friend's collection via the get_friend_crate projection RPC (#42 — keeps
   rating, omits folder/instance_id; the old table-wide collection_select_friends policy is dropped).
   Deliberately installs NO TraxWaxRefresh / TraxWaxAccount (nothing to re-sync, no account of
   theirs), and the stats call carries `owner` so live-stats suppresses price server-side. */
function installFriendCrateProviders(owner) {
  // E2 (#100): same thin alias as the own-crate installer — the duplicated body is gone.
  const fnCall = (path, payload) => edgeCall(path, payload, { throwOnError: false });

  window.TraxWaxViewer = { isOwn: false, signedIn: true, ownerUserId: owner.user_id, ownerProfile: owner,   // #60: explicit flag
    canViewCrate: owner._canViewCrate === true, canViewWantlist: owner._canViewWantlist === true,
    canViewForSale: owner._canViewForSale === true };  // #43 (all fail-closed); D2 deep-link reads canViewForSale

  // #43 (Decision 5): the owner's wantlist IDs — for the set-derived "they want / you have" count (so the
  // count and the filter share one source and can't disagree). ID-only, under the same wantlist RLS gate.
  // #28: return the owner's wantlist ENTRIES ({id, master}) — the any-pressing "they want / you have"
  // count iterates these so a record matched both exactly and by master isn't double-counted. Still
  // wantlist-gated; `master` normalized to null (Discogs' no-master 0 never enters).
  window.TraxWaxOwnerWantIds = async () => {
    if (owner._canViewWantlist !== true) return [];   // wantlist private → unknown, not zero
    // D2 (#91): the get_friend_wantlist projection RPC replaces the table read — the
    // wantlist_select_friends policy is gone (it cost one SECURITY DEFINER probe PER ROW
    // and exposed the raw sub + timestamps). One call, no pagination (jsonb array).
    const { data, error } = await supabase.rpc('get_friend_wantlist', { p_username: owner.discogs_username });
    if (error) throw new Error('friend wantlist-ids query failed: ' + error.message);
    return (Array.isArray(data) ? data : []).map((it) => ({ id: it.release_id, master: it.master_id || null }));
  };

  // Wave 4 Stage 2: the friend's CONSENTED for-sale listings → Map<release_id, listing_id>. The RPC is
  // can_view_forsale-gated server-side (returns [] unless friends + crate friends-visible + forsale=friends),
  // and we also short-circuit on the flag, so a private/un-consented friend yields an empty Map (no exposure).
  window.TraxWaxFriendForSale = async () => {
    if (owner._canViewForSale !== true) return new Map();   // not shared → empty (never guess)
    const { data, error } = await supabase.rpc('get_friend_forsale', { p_username: owner.discogs_username });
    if (error) throw new Error('friend for-sale query failed: ' + error.message);
    const map = new Map();
    for (const it of (Array.isArray(data) ? data : [])) map.set(it.release_id, it.listing_id);
    return map;
  };

  // Wave 2 B2: add/remove on the VIEWER's own wantlist from a friend's crate (writes the viewer's
  // wantlist regardless of whose crate is shown). Uses module _pipeCall so errors throw (the friend
  // installer's fnCall above swallows them, which would strand the optimistic UI).
  window.TraxWaxSetWant = async (releaseId, action) =>
    _pipeCall('wantlist-write', { release_id: releaseId, action });
  window.TraxWaxOwner = {
    ownerLine: (owner.display_name || owner.discogs_username) + '’s shelf',
    lastSyncedAt: null,
    displayName: owner.display_name || '',
    avatarUrl: owner.avatar_url || '',
    isOwn: false,
    ownerUsername: owner.discogs_username,
    collectingSince: owner.collecting_since || null,   // #47 header sub-line ("COLLECTING SINCE {year}")
  };

  // #42: friend crate read goes through the get_friend_crate projection RPC (keeps rating, omits the
  // owner's folder + instance_id, which the table-wide RLS policy used to expose). SECURITY DEFINER +
  // gated on can_view_crate; returns the full ordered array in one call, so no pagination / no table read.
  window.TraxWaxData = async () => {
    const { data, error } = await supabase.rpc('get_friend_crate', { p_username: owner.discogs_username });
    if (error) throw new Error('friend collection query failed: ' + error.message);
    return (data ?? []).map((it) => ({
      id: it.release_id,
      artist: it.artist || '', title: it.title || '', year: it.year || 0,
      label: it.label || '', styles: it.styles || [], genres: it.genres || [],
      vinyl: it.vinyl || '', thumb: it.thumb || '', cover_image: it.cover_image || '',
      added: it.added || '', rating: it.rating || 0, master_id: it.master_id || null,   // #28
      releaseYear: (it.master_year && it.master_year > 0) ? it.master_year : (it.year || 0),   // 0040: decade panel bins on original-release year (CHECK-IN 2)
      price: null, crating: null, crcount: null, have: null, want: null,
    }));
  };

  // #47: THE WANTLIST tab on a friend's crate reads THEIR wantlist (read-only).
  // D2 (#91): via the get_friend_wantlist projection RPC — the table-wide
  // wantlist_select_friends policy is dropped (per-row definer probes, leaked columns).
  // '[]' if the owner hasn't shared it; one call, ordered server-side, no pagination.
  // NOTE: vinyl stays '' here on purpose — the friend wantlist card has never shown the
  // variant; the RPC carries it for whenever that design call is made.
  window.TraxWaxWantlistData = async () => {
    const { data, error } = await supabase.rpc('get_friend_wantlist', { p_username: owner.discogs_username });
    if (error) throw new Error('friend wantlist query failed: ' + error.message);
    return (Array.isArray(data) ? data : []).map((it) => ({
      id: it.release_id,
      artist: it.artist || '', title: it.title || '', year: it.year || 0,
      label: it.label || '', styles: it.styles || [], genres: it.genres || [],
      vinyl: '', thumb: it.thumb || '', cover_image: it.cover_image || '',
      added: it.added || '', rating: 0, master_id: it.master_id || null,   // #28
      price: null, crating: null, crcount: null, have: null, want: null,
    }));
  };

  // Wave 2 B1 / Wave 5b T2c: the viewer's own match context — shared with the /c/ public-in
  // path; body extracted verbatim to installViewerMatchCtx() (module level, above the installers).
  installViewerMatchCtx();

  window.TraxWaxReleaseData = async (id) => {
    const { data, error } = await supabase
      .from('releases').select('tracks, country, released')   // E3 #101: videos never rendered — stop fetching
      .eq('release_id', id).maybeSingle();
    if (error || !data || data.tracks == null) return null;
    return { tracks: data.tracks || [], country: data.country || '',
      released: data.released || '' };
  };

  // Per-release stats under the VIEWER's own token; price suppressed server-side via `owner`.
  window.TraxWaxStats = async (id) =>
    id == null ? {} : fnCall('live-stats', { kind: 'release', id, owner: owner.discogs_username });
  // No TraxWaxRefresh / TraxWaxAccount — read-only friend crate.
}

/* Import pipeline, restructured by the Phase 1 cold audit (findings #9-#14): the import
   phase (seconds to a minute) runs blocking with progress UI; ENRICHMENT ALWAYS DRAINS IN
   THE BACKGROUND -- the crate renders without tracklists and they fill in as the drain
   proceeds. last_import_at is set server-side only when enrichment reaches zero remaining,
   so the boot gate keeps healing interrupted runs on later loads. */

/* E2 (#100, audit v1.25): THE one Edge-call helper. Three near-identical copies used to
   coexist with DIVERGENT error contracts (two swallow-to-null fnCalls + this throwing
   _pipeCall) — the friend installer's own comment admitted the swallow had already
   stranded an optimistic UI once. One implementation, one knob:
     throwOnError: true  → throws Error carrying .status (HTTP) and .upstream (the edge
                           function's reported Discogs status — audit #13: an upstream 429
                           arrives as {error:'discogs_failed', status:429} on an HTTP 502,
                           surfaced so retry logic can wait out the 60s rate window).
     throwOnError: false → resolves null on any HTTP failure (the optimistic-UI contract).
   In BOTH modes a thrown getToken()/fetch (network drop, expired session) REJECTS — that
   is the contract C9 (#86) taught the header-value caller to catch. */
const edgeCall = async (path, payload, opts) => {
  const throwOnError = !!(opts && opts.throwOnError);
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
  if (throwOnError) {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(d.error || ('HTTP ' + r.status));
      err.status = r.status;
      err.upstream = d.status;
      throw err;
    }
    return d;
  }
  if (!r.ok) return null;
  return r.json().catch(() => null);
};
const _pipeCall = (path, payload) => edgeCall(path, payload, { throwOnError: true });

// Retries with backoff -- but NOT on non-retryable 4xx (bad request, auth, not
// connected), and with a 60s wait when the upstream reported a rate limit (audit #13; #36 widened 30s→60s to clear Discogs' ~60s window).
const _pipeAttempt = async (fn, onLine) => {
  const delays = [2000, 5000, 10000];
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      // C11 (#88): every 4xx except 408 (timeout) and 429 (rate limit) is non-retryable —
      // the old whitelist let a 404/410/422 eat the full ~17s ladder for an answer that
      // could never change.
      const s = e && e.status;
      if (typeof s === 'number' && s >= 400 && s < 500 && s !== 408 && s !== 429) throw e;
      if (i >= delays.length) throw e;
      const wait = (e && e.upstream === 429) ? 60000 : delays[i];   // #36: Discogs' rate window is ~60s; 30s retried into a still-closed window
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
    pages = Number.isFinite(d.pages) ? d.pages : pages;   // #35: don't let an omitted `pages` (undefined) end the loop early; d.done is the real terminator
    startedAt = d.started_at;
    if (onProgress) onProgress(d.page, d.pages, d.items);
    if (d.done) break;
    page++;
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, Math.max(0, 1100 - elapsed)));
  } while (page <= pages && page <= 500);
}

/* Wave 2 Stage A: silent wantlist import — the same page-loop as importLoop but kind='wantlist',
   no progress UI, client-driven adaptive pacing. Throws on give-up; the caller logs and moves on. */
async function wantlistImportLoop() {
  let page = 1, pages = 1, startedAt = null;
  do {
    const t0 = Date.now();
    const d = await _pipeAttempt(() => _pipeCall('import-collection',
      Object.assign({ page, kind: 'wantlist' }, startedAt ? { started_at: startedAt } : {})));
    pages = Number.isFinite(d.pages) ? d.pages : pages;   // #35: as importLoop — d.done terminates, not an absent `pages`
    startedAt = d.started_at;
    if (d.done) break;
    page++;
    const elapsed = Date.now() - t0;
    // Client-driven adaptive pacing: back off hard when Discogs' shared-IP budget runs low,
    // else the normal elapsed-aware 1.1s pace. The 429 retry in _pipeAttempt is the backstop.
    const rr = Number(d.rate_remaining ?? NaN);   // null/absent → NaN → normal pace, not budget-low (Number(null)===0)
    const gap = (Number.isFinite(rr) && rr < 15) ? 2500 : Math.max(0, 1100 - elapsed);
    await new Promise((r) => setTimeout(r, gap));
  } while (page <= pages && page <= 500);
}

/* Wave 4 Stage 1: silent inventory (for-sale) import — same page-loop as wantlistImportLoop but
   kind='inventory'. No progress UI, client-driven adaptive pacing. Throws on give-up; caller logs. */
async function inventoryImportLoop() {
  let page = 1, pages = 1, startedAt = null;
  do {
    const t0 = Date.now();
    const d = await _pipeAttempt(() => _pipeCall('import-collection',
      Object.assign({ page, kind: 'inventory' }, startedAt ? { started_at: startedAt } : {})));
    pages = Number.isFinite(d.pages) ? d.pages : pages;   // as importLoop — d.done terminates, not an absent `pages`
    startedAt = d.started_at;
    if (d.done) break;
    page++;
    const elapsed = Date.now() - t0;
    const rr = Number(d.rate_remaining ?? NaN);   // null/absent → NaN → normal pace, not budget-low
    const gap = (Number.isFinite(rr) && rr < 15) ? 2500 : Math.max(0, 1100 - elapsed);
    await new Promise((r) => setTimeout(r, gap));
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
        // Wave 5a: keep draining until master-year backfill is also done (absent from pre-v9 responses → 0).
        const work = d.remaining + (d.refresh_pending || 0) + (d.master_pending || 0);
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
let _lastImportPage = 0, _lastImportPages = 1, _lastImportPct = 0, _importedItems = 0;
/* Analytics: guarded no-op when Umami is absent. Actions/counts only — never a username,
   price, or any Restricted Discogs field (mirror of app.js's track()). */
function track(name, data){ try { if (window.umami) window.umami.track(name, data); } catch(e){} }
// #26: one guarded entry point for the background wantlist sync. Every collection import "owes" a
// wantlist sync (runImport sets the flag below); this consumes the flag at most once at a time,
// imports the user's OWN wantlist, THEN drains enrichment (sequential — the concurrent insert used to
// trip the enrich stall guard, #26/finding-3). The flag clears only on a clean import, so a failed or
// reload-interrupted import leaves it owed for the next trigger to retry. Owner-scoped: wantlistImportLoop
// runs under the signed-in user's own token, so it is safe to call on any signed-in load (see render()).
let _wlSyncing = false;
function _wlOwed() { try { return sessionStorage.getItem('tw_wantlist_due') === '1'; } catch (e) { return false; } }
function triggerWantlistSync() {
  if (!_wlOwed() || _wlSyncing) return;
  _wlSyncing = true;
  wantlistImportLoop()
    .then(() => { try { sessionStorage.removeItem('tw_wantlist_due'); } catch (e) {} })
    .catch((e) => console.warn('wantlist import stopped:', e))
    .finally(() => { _wlSyncing = false; backgroundEnrich(); });
}

// Wave 4 Stage 1: the inventory (for-sale) sync — exact mirror of triggerWantlistSync. Every collection
// import owes an inventory sync too (runImport sets the flag); consumed at most once at a time under the
// caller's own token. The flag clears only on a clean import, so a failed/interrupted run stays owed.
let _invSyncing = false;
function _invOwed() { try { return sessionStorage.getItem('tw_inventory_due') === '1'; } catch (e) { return false; } }
function triggerInventorySync() {
  if (!_invOwed() || _invSyncing) return;
  _invSyncing = true;
  inventoryImportLoop()
    .then(() => { try { sessionStorage.removeItem('tw_inventory_due'); } catch (e) {} })
    .catch((e) => console.warn('inventory import stopped:', e))
    .finally(() => { _invSyncing = false; backgroundEnrich(); });
}

async function runImport() {
  const setProgress = (page, pages, items) => {
    _lastImportPage = page; _lastImportPages = pages; _importedItems = items;
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
  _lastImportPage = 0; _lastImportPages = 1; _lastImportPct = 0; _importedItems = 0;
  track('import_started');
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
    const msg = (e && e.message) || '';
    // D7 (#96, audit F1): the >500-page refusal is a NAMED terminal condition — say so
    // instead of the generic wall (which invites a retry that can never succeed).
    const tooLarge = /collection_too_large/i.test(msg);
    notice(UI.COPY.importFailed.headline,
      tooLarge
        ? 'This collection is past the 50,000-record ceiling TraxWax can import today. The '
          + 'import stopped cleanly — nothing partial was written. Retrying won’t change the '
          + 'answer; if this is a real crate, open a GitHub issue and the ceiling gets revisited.'
        : UI.COPY.importFailed.body, true, {
      kicker: tooLarge ? 'IMPORT · COLLECTION TOO LARGE'
        : 'IMPORT · STOPPED AT PAGE ' + (_lastImportPage || 1),
      extra: '<div>' + UI.progressBar(_lastImportPct, true) + '</div>',
      // Pass-2 catch: "Reload and resume" would invite exactly the retry the tooLarge copy
      // just called futile — that terminal state routes home instead.
      actions: tooLarge
        ? UI.btnLink('BACK TO THE CRATE', '/app', { variant: 'secondary' })
        : UI.btnLink(UI.COPY.importFailed.cta,
            window.location.pathname + window.location.search, { variant: 'primary' }),
    });
    // Reason as a FIXED bucket, never the raw message (it can carry a token or URL).
    const reason = tooLarge ? 'too_large'
      : /rate|429/i.test(msg) ? 'rate_limit'
      : /401|403|auth|token|unauthor/i.test(msg) ? 'auth'
      : /network|fetch|timeout|failed to fetch/i.test(msg) ? 'network'
      : 'other';
    track('import_failed', { reason, page: _lastImportPage });
    return false;
  }
  // #26: any successful collection import owes a wantlist sync (covers ALL runImport callers — in-crate
  // RE-SYNC via TraxWaxRefresh, account RE-SYNC via onResync, and the first-import paths in render()).
  // triggerWantlistSync imports the wantlist THEN drains enrichment (one sequential drain — replaces the
  // bare backgroundEnrich() that used to race the wantlist insert). A caller that reloads (account
  // onResync) kills the in-flight sync; the flag persists and render()'s early consumer re-fires it.
  try { sessionStorage.setItem('tw_wantlist_due', '1'); } catch (e) {}
  try { sessionStorage.setItem('tw_inventory_due', '1'); } catch (e) {}   // Wave 4: also owes a for-sale sync
  triggerWantlistSync();
  triggerInventorySync();
  track('import_completed', { items: _importedItems });   // a count, not which records
  return true;
}

/* S13\u2013S16: the account surface is a ROUTE (/account, /account/discogs), not a modal.
   Rendered by UI.accountPageHtml + UI.bindAccountPage (public/boot.ui.js), which own the
   pixels; every network action is injected here so that module stays Clerk/Supabase-free.
   Why a page, not a modal: Wave 1's friend list is browsable content that needs a URL, and
   the consent toggles need room for copy that carries weight. (Surfaces spec \u00a76.) */
/* C6 (#83): renderAccount re-enters in place (visibility toggles call it again), and each
   pass used to stack a fresh document-level trapFocus keydown listener — the popstate
   release never fires in-document (account-tab navigation is full page loads). Hold the
   current release; drop it (listener + its popstate hook) before re-trapping. */
let _acctTrapRelease = null;

async function renderAccount(profile, section) {
  clearAuthMount();
  // C6 (#83): remember what had focus (by id) so a re-entry can put it back — trapFocus
  // otherwise yanks focus to the top of the page mid-form.
  const _prevFocusId = (document.activeElement && document.activeElement.id) || null;
  let count = null;
  try {
    const res = await supabase.from('collection_items')
      .select('*', { count: 'exact', head: true }).eq('user_id', profile.user_id);   // own rows only (v1.4.2)
    count = res.count;
  } catch (e) { /* the connection panel shows an em-dash if the count is unavailable */ }
  let invCount = null;   // Wave 4: for-sale listing count for the DISCOGS-tab "LISTED" stat
  try {
    const res = await supabase.from('inventory_items')
      .select('*', { count: 'exact', head: true }).eq('user_id', profile.user_id);
    invCount = res.count;
  } catch (e) { /* em-dash if unavailable */ }
  const el = app();
  el.className = 'tw-acct-wrap';
  el.innerHTML = UI.accountPageHtml({
    profile,
    clerkUser: window.Clerk.user,
    recordCount: count == null ? null : count,
    inventoryCount: invCount == null ? null : invCount,
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
    onResync: async () => {
      const ok = await runImport();
      // Wave 2 Stage A: flag a wantlist re-sync for AFTER the reload (the reload would kill an
      // in-flight background import). Picked up in the own-crate render path below.
      if (ok) { try { sessionStorage.setItem('tw_wantlist_due', '1'); sessionStorage.setItem('tw_inventory_due', '1'); } catch (e) {} window.location.reload(); }
    },
    onDisconnect: async () => { await _pipeCall('disconnect-discogs', {}); track('discogs_disconnected'); window.location.href = '/app'; },
    onDelete: async () => { await _pipeCall('delete-account', { confirm: 'DELETE' }); track('account_deleted'); await window.Clerk.signOut({ redirectUrl: '/' }); },
    onSignOut: async () => { await window.Clerk.signOut({ redirectUrl: '/' }); },   // v1.4.2; → landing (v1.4.5)
    // ── Wave 1: SHARING + FRIENDS ──
    onSetVisibility: async (v) => {
      const { error } = await supabase.from('profiles')
        .update({ crate_visibility: v }).eq('user_id', window.Clerk.user.id);
      if (error) throw new Error(error.message);
      // Wave 4 Stage 2: crate visibility GATES the for-sale row (E1 — for-sale rides under crate). Re-render
      // the SHARING page so the for-sale control's locked/unlocked state tracks the new crate value without a
      // manual reload. (The DB gate protects either way; this keeps the consent UI honest.)
      profile.crate_visibility = v;
      if (v === 'public') await _ensurePublicSlug(profile);   // Wave 5b: first flip seeds the slug
      // Audit F5: for-sale's PUBLIC rung rides under a public crate (E1) — leaving 'public'
      // downgrades an orphaned forsale='public' to 'friends' so the control never renders stateless.
      if (v !== 'public' && profile.forsale_visibility === 'public') {
        let ok = false;
        for (let i = 0; i < 2 && !ok; i++) {   // pass-2 F3: one retry; a silent miss re-renders a stateless control
          const r2 = await supabase.from('profiles')
            .update({ forsale_visibility: 'friends' }).eq('user_id', window.Clerk.user.id);
          ok = !r2.error;
        }
        if (ok) profile.forsale_visibility = 'friends';
        else console.error('forsale downgrade failed; control renders its stored public value');
      }
      try { await renderAccount(profile, 'sharing'); }   // #110: awaited → status lands in the NEW dom
      catch (e2) { console.error(e2); }                    // pass-2 F2: the save SUCCEEDED — a render hiccup must not read as failure
    },
    onSetWantlistVisibility: async (v) => {   // Wave 2 B1: independent wantlist consent
      const { error } = await supabase.from('profiles')
        .update({ wantlist_visibility: v }).eq('user_id', window.Clerk.user.id);
      if (error) throw new Error(error.message);
      // Wave 5b: the PUBLIC LINK box tracks any-public — sync + re-render like the crate setter.
      profile.wantlist_visibility = v;
      if (v === 'public') await _ensurePublicSlug(profile);
      try { await renderAccount(profile, 'sharing'); } catch (e2) { console.error(e2); }   // #110 + pass-2 F2
    },
    onSetForsaleVisibility: async (v) => {   // Wave 4 Stage 2: for-sale consent (rides under crate visibility)
      const { error } = await supabase.from('profiles')
        .update({ forsale_visibility: v }).eq('user_id', window.Clerk.user.id);
      if (error) throw new Error(error.message);
      profile.forsale_visibility = v;   // Wave 5b: see above
      if (v === 'public') await _ensurePublicSlug(profile);
      try { await renderAccount(profile, 'sharing'); } catch (e2) { console.error(e2); }   // #110 + pass-2 F2
    },
    // Wave 5b: THE CARD palette (og_palette — the OG renderer reads it server-side; a shared
    // link can never force someone else's card off-palette).
    onSetPalette: async (v) => {
      const { error } = await supabase.from('profiles')
        .update({ og_palette: v }).eq('user_id', window.Clerk.user.id);
      if (error) throw new Error(error.message);
      profile.og_palette = v;
    },
    // Wave 5b T9: the vanity slug (PUBLIC LINK box). The DB CHECK + unique index validate;
    // a collision gets its own human message.
    onSetSlug: async (v) => {
      const { error } = await supabase.from('profiles')
        .update({ public_slug: v }).eq('user_id', window.Clerk.user.id);
      if (error) {
        throw new Error(/duplicate|unique/i.test(error.message || '')
          ? 'That link is taken — try another.' : error.message);
      }
      profile.public_slug = v;
    },
    onSetMatchMode: async (mode) => {   // #28: viewer's own reading preference; direct update under profiles_update_own RLS
      const { error } = await supabase.from('profiles')
        .update({ match_mode: mode }).eq('user_id', window.Clerk.user.id);
      if (error) throw new Error(error.message);
      window.__twMatchMode = mode;   // reflect immediately so a later crate view reads the new mode
    },
    onListFriends: async () => {
      const { data, error } = await supabase.rpc('list_friends');
      if (error) throw new Error(error.message);
      return data || [];
    },
    onCreateInvite: async () => {
      // Random URL-safe code; only its SHA-256 hash is stored. Return the shareable link.
      // D8c (#97c): the RPC now answers 'retry' on a hash collision (it used to claim 'ok'
      // while storing nothing — the handed-out link belonged to a STRANGER's invite). One
      // fresh-code retry, then the generic failure copy.
      let data = null;
      let code = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const bytes = crypto.getRandomValues(new Uint8Array(18));
        code = btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const res = await supabase.rpc('create_friend_invite',
          { p_code_hash: await sha256hex(code) });
        if (res.error) throw new Error(res.error.message);
        data = res.data;
        if (!(data && data.status === 'retry')) break;
      }
      if (!data || data.status !== 'ok') {
        // Map internal status tokens to human copy (don't surface 'no_profile'/'no_auth' raw).
        const m = { no_profile: 'Finish setting up your profile first, then create a link.',
          no_auth: 'Please sign in again, then try creating a link.',
          too_many_invites: 'You already have 25 open invite links — that’s the max. They expire after 14 days; let some lapse before making more.' }[data && data.status]
          || 'Couldn’t create a link — please try again.';
        throw new Error(m);
      }
      track('invite_created');
      return location.origin + '/i/' + code;
    },
    onRemoveFriend: async (friendId) => {
      const { error } = await supabase.rpc('remove_friend', { p_friend_id: friendId });
      if (error) throw new Error(error.message);
    },
  });
  // C6 (#83): release the previous trap AFTER the re-render (its `prev` node is gone from the
  // DOM by now, so release only removes the stale keydown listener — no focus jump), and take
  // its popstate hook down with it.
  if (_acctTrapRelease) {
    try { window.removeEventListener('popstate', _acctTrapRelease); _acctTrapRelease(); } catch (e) {}
  }
  const release = UI.trapFocus(el, null);   // no Escape handler -- it's a page, not a modal
  _acctTrapRelease = release;
  window.addEventListener('popstate', release, { once: true });
  // C6 (#83): on re-entry, hand focus back to the control the user was on (id-matched in the
  // fresh DOM); falls through silently to trapFocus's first-element default when absent.
  if (_prevFocusId) { const n = document.getElementById(_prevFocusId); if (n) n.focus(); }
}

/* C12 (#89): own-key membership for the connect-status copy maps. A URL-controlled status
   like ?connect=constructor is truthy through Object.prototype on a bare [status] lookup —
   not XSS (the coerced strings carry no markup), but a stringified native function reached
   the slab and analytics. Object.hasOwn confines lookups to authored keys. */
const _knownConnect = (map, key) => !!(map && typeof key === 'string' && Object.hasOwn(map, key));

/* Wave 1: SHA-256 hex of a string. Invite codes are hashed client-side — the plaintext code
   lives only in the /i/<code> link the inviter shares; only the hash is ever stored. */
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Wave 1: consume an invite code (atomic in accept_friend_invite), create the mutual
   friendship, then show a result card that routes the user onward. */
async function acceptInvite(code) {
  let res;
  try {
    const { data, error } = await supabase.rpc('accept_friend_invite',
      { p_code_hash: await sha256hex(code) });
    if (error) throw error;
    res = data || {};
  } catch (e) { res = { status: 'error', message: (e && e.message) || String(e) }; }

  if (res.status === 'ok' || res.status === 'already_accepted') {
    if (res.status === 'ok') track('invite_accepted');   // a genuine new accept, not a re-open
    const who = res.friend_username ? UI.esc('@' + res.friend_username) : 'your friend';
    // already_accepted: they re-opened a link they'd already used — reassure, don't alarm.
    const head = res.status === 'already_accepted' ? 'Already connected' : 'You’re connected';
    const body = res.status === 'already_accepted'
      ? 'You and ' + who + ' are already friends — you can see each other’s crates.'
      : 'You and ' + who + ' can now see each other’s crates.';
    notice(head, body, false, {
      kicker: 'FRIENDS',
      actions: UI.btnLink('GO TO YOUR CRATE', '/app', { variant: 'primary' }),
    });
  } else {
    const msg = {
      invalid_or_expired: 'That invite link is invalid or has expired. If you two are already connected you’re all set — otherwise ask your friend for a fresh one.',
      own_invite: 'That’s your own invite link — share it with a friend instead.',
      no_auth: 'Please sign in first, then open the link again.',
      no_profile: 'Finish setting up your crate first, then open the link again.',
    }[res.status] || 'Something went wrong accepting that invite.';
    notice('Invite couldn’t be used', msg, false, {
      kicker: 'FRIENDS',
      actions: UI.btnLink('GO TO YOUR CRATE', '/app', { variant: 'secondary' }),
    });
  }
}

/* B4 (#72, audit v1.25): opening /i/<code> used to EXECUTE the accept — a GET-driven
   consent grant (bidirectional friendship + default-friends visibility) with no question
   asked; any disguised link could silently friend an attacker. Now: a read-only preview
   (get_invite_preview, migration 0035) names the inviter, and the consuming accept fires
   only on an explicit button. NOT NOW routes home without consuming anything — declining
   is not burning; the link stays valid for its normal lifetime. */
async function confirmInvite(code) {
  let res;
  try {
    const { data, error } = await supabase.rpc('get_invite_preview',
      { p_code_hash: await sha256hex(code) });
    if (error) throw error;
    res = data || {};
  } catch (e) { res = { status: 'error' }; }

  if (res.status !== 'ok') {
    // Everything that isn't a live, someone-else's, unused code renders the same result
    // cards acceptInvite would have shown — without ever consuming anything.
    if (res.status === 'already_accepted') {
      const who = res.friend_username ? UI.esc('@' + res.friend_username) : 'your friend';
      notice('Already connected',
        'You and ' + who + ' are already friends — you can see each other’s crates.', false, {
          kicker: 'FRIENDS',
          actions: UI.btnLink('GO TO YOUR CRATE', '/app', { variant: 'primary' }),
        });
      return;
    }
    const msg = {
      invalid_or_expired: 'That invite link is invalid or has expired. If you two are already connected you’re all set — otherwise ask your friend for a fresh one.',
      own_invite: 'That’s your own invite link — share it with a friend instead.',
      no_auth: 'Please sign in first, then open the link again.',
      no_profile: 'Finish setting up your crate first, then open the link again.',
    }[res.status] || 'Something went wrong reading that invite.';
    notice('Invite couldn’t be used', msg, false, {
      kicker: 'FRIENDS',
      actions: UI.btnLink('GO TO YOUR CRATE', '/app', { variant: 'secondary' }),
    });
    return;
  }

  const who = res.inviter_username ? UI.esc('@' + res.inviter_username) : 'A collector';
  notice('Crate invite',
    who + ' wants to connect crates. Accepting makes you friends both ways — under your ' +
    'sharing settings, friends can see each other’s shelves.', false, {
      kicker: 'FRIENDS',
      rule: 'muted',
      actions: UI.btn('ACCEPT INVITE', { id: 'tw-inv-accept' }) +
               UI.btnLink('NOT NOW', '/app', { variant: 'secondary', style: 'margin-left:12px' }),
    });
  const btn = document.getElementById('tw-inv-accept');
  if (btn) btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    await acceptInvite(code);   // the existing consume path renders its own result card
  });
}

/* S2 / S3: TraxWax chrome, stock card. Our state card supplies the wordmark + kicker +
   headline; Clerk's component mounts inside the `extra` slot. The step counter on sign-up
   names the three doors up front, which is why people don't abandon at "connect". */
function mountAuth() {
  clearAuthMount();
  resetShellChrome(app());   // T2.8 (#130): the cross-tab sign-out path — clear any open modal + inert before the sign-in card
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

// #126 (T2.4): a malformed %-escape in a path segment must not throw out of render() into the
// error card (whose Reload links back to the same URL → a permanent loop). Fall back to the RAW
// segment, which matches no real username/invite code and lands on the calm "no crate"/"invalid
// invite" render rather than being mistaken for the /app own-crate case (null routeUsername).
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

async function render() {
  const segments = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const routeUsername = segments[1] ? safeDecode(segments[1]) : null;

  // #32 (cold audit): guard on the USER object too, not just isSignedIn. Clerk can briefly report
  // isSignedIn===true with a null user (mid-refresh / partial hydration); proceeding would dereference
  // window.Clerk.user.id below and throw into route()'s catch → a spurious error card mid-sign-in.
  if (!window.Clerk.isSignedIn || !window.Clerk.user) {
    mountAuth();
    return;
  }

  clearAuthMount();
  try { localStorage.setItem('tw_has_session', '1'); } catch (e) {}   // #113: the identify-first hint
  const profile = await ensureProfile(window.Clerk.user.id);

  // #28: the VIEWER's any-pressing reading preference, read once per load before routing — it applies
  // symmetrically to every crate the viewer opens (own OR friend), so it lives here, not per-route.
  window.__twMatchMode = (profile && profile.match_mode) || 'exact';

  // Wave 1: consume an invite code stashed at boot() (from an /i/<code> link, possibly opened
  // while signed out and carried across sign-in). Runs once the user is signed in.
  let _inviteCode = null;
  try { _inviteCode = sessionStorage.getItem('tw_invite_code'); } catch (e) {}
  if (_inviteCode) {
    try { sessionStorage.removeItem('tw_invite_code'); } catch (e) {}
    await confirmInvite(_inviteCode);   // B4 #72: preview + ask before the consuming accept
    return;
  }

  // #26: a prior collection import may have left a wantlist sync owed but unfinished — most often a
  // RE-SYNC from /account, which reloads onto /account (not the own-crate consumer far below). Consume
  // it here on ANY signed-in load, before routing, so the account-page RE-SYNC path no longer defers to
  // the next /app visit. Guarded + flag-gated: a no-op on a normal load where nothing is owed.
  triggerWantlistSync();
  triggerInventorySync();   // Wave 4: same pre-routing consumption for the for-sale sync

  // S13–S16: the account surface lives at /account and /account/discogs, OUTSIDE the
  // /app/<username> grammar — no reserved-word carve-out, no collision (surfaces spec §6,
  // Lane's decision 2026-08-29). Reached only when signed in; the isSignedIn guard above
  // has already sent a signed-out visitor to the sign-in card. Branch here, before the
  // onboarding/connect gates, so /account is always a place you can land.
  if (segments[0] && segments[0].toLowerCase() === 'account') {
    const valid = ['profile', 'friends', 'sharing', 'discogs', 'danger'];   // v1.15.0: SHARING split out; v1.20.3: DANGER its own tab
    const raw = segments[1] ? segments[1].toLowerCase() : 'profile';
    await renderAccount(profile, valid.includes(raw) ? raw : 'profile');
    return;
  }

  // Wave 1: the invite-accept route /i/<code>. Reached only when signed in (the guard above sent
  // a signed-out visitor to sign-in, preserving the URL so the code survives). acceptInvite
  // renders its own result card, then routes the user onward.
  if (segments[0] && segments[0].toLowerCase() === 'i' && segments[1]) {
    await confirmInvite(safeDecode(segments[1]));   // B4 #72: preview + ask first (#126: never throw on a bad %-escape)
    return;
  }

  // Phase 2 profiles: ONE skippable completion card, only when the name is missing
  // (email/password signups before the Clerk name toggle, or with it off; Google users
  // arrive complete and never see this). Skipping is remembered per browser; completing
  // sets the Clerk name, so the condition never re-fires anywhere.
  let profileSkip = false;
  // C3 (#80): per-user key — user B on A's browser must not inherit A's skip (they'd never
  // see the onboarding card at all). A clean cut: pre-fix skips re-show the card once.
  try { profileSkip = !!localStorage.getItem('tw_profile_skip:' + window.Clerk.user.id); } catch (e) {}
  // rev1-F9: never intercept an in-flight OAuth return — the parked link expires in
  // 15 minutes and the verify handler must run first.
  const inVerifyLeg = new URLSearchParams(window.location.search).get('connect') === 'verify';
  if (!window.Clerk.user.firstName && !profileSkip && !inVerifyLeg) {
    // S4: real avatar affordance + labelled fields, in the state card. Vertical stack
    // because Wave 1's first-run sharing question belongs here as a fourth row.
    resetShellChrome(app());   // T2.8 (#130): reset shell chrome before the first-run onboarding card
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
      try { localStorage.setItem('tw_profile_skip:' + window.Clerk.user.id, '1'); } catch (e) {}   // C3 (#80): per-user
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
          track('connect_completed');   // Discogs OAuth finalized (umami sendBeacon survives the nav)
          window.location.replace('/app');
          return;
        }
        // Close-audit fix: only a KNOWN connect-status key reaches the URL/history — an unmapped server
        // error (e.g. "Failed to fetch") is bucketed to store_failed, mirroring the analytics path, so no
        // raw error string is ever reflected into the address bar.
        // C12 (#89): own-key check — ?connect=constructor was truthy via Object.prototype.
        const urlStatus = _knownConnect(UI.COPY.connectErrors, failStatus) ? failStatus : 'store_failed';
        window.location.replace('/app?connect=' + encodeURIComponent(urlStatus));
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
      // Analytics: a real connect failure, once per render. Only a KNOWN connect-status key
      // leaves as-is; an inline start error or an unknown status collapses to a bucket, so no
      // raw error message (which finalize can put in the URL) ever reaches analytics.
      if (failed) track('connect_failed', {
        reason: problemOverride ? 'start_failed'
          : (_knownConnect(UI.COPY.connectErrors, status) ? status : 'other'),   // C12 (#89)
      });
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
            ? ((_knownConnect(UI.COPY.connectErrorKickers, status) && UI.COPY.connectErrorKickers[status]) || 'CONNECT · SOMETHING FAILED')   // C12 (#89)
            : UI.COPY.connect.kicker,
          problem: problemOverride ||
            (failed ? ((_knownConnect(UI.COPY.connectErrors, status) && UI.COPY.connectErrors[status]) || 'Connection failed. Try again.') : null),   // C12 (#89)
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
          // B8 (#76): trust-but-verify the server's URL — one compromised/buggy function
          // response must not become an open redirect from a page where the user is primed
          // to type Discogs credentials.
          const authU = new URL(d.authorize_url);
          if (authU.protocol !== 'https:' ||
              (authU.hostname !== 'www.discogs.com' && authU.hostname !== 'discogs.com')) {
            throw new Error('unexpected authorize URL');
          }
          track('connect_started');   // handing off to Discogs OAuth (umami sendBeacon survives the nav)
          window.location.href = authU.href;
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
    // Wave 1: is this a friend's shared crate? get_crate_owner returns 'no_crate' for BOTH
    // "no such user" AND "exists but not shared with you", so this branch never confirms a
    // username's existence. On authorization it mounts the crate READ-ONLY and returns.
    // NOTE (Lane, 2026-08-30): this branch sits AFTER the connect-Discogs gate by design, so a
    // viewer must have connected their own Discogs before browsing a friend's crate.
    let friendOwner = null, _ownerErr = null;
    try {
      const { data, error } = await supabase.rpc('get_crate_owner', { p_username: routeUsername });
      if (error) _ownerErr = error;                                     // #125 (T2.3): transport/RPC failure
      else if (data && data.status === 'ok') {
        friendOwner = data.owner;
        friendOwner._canViewCrate = data.can_view_crate === true;      // #43 visibility flags
        friendOwner._canViewWantlist = data.can_view_wantlist === true;
        friendOwner._canViewForSale = data.can_view_forsale === true;   // Wave 4 Stage 2 (fail-closed)
      }
      else if (data && data.status === 'no_auth') _ownerErr = new Error('auth check did not complete');
    } catch (e) { _ownerErr = e; }
    if (friendOwner) {
      installFriendCrateProviders(friendOwner);
      await import('/app.js');
      window.TraxWaxBootCrate();
      return;
    }
    // #125 (T2.3): a transport failure or an incomplete auth check is NOT a privacy denial — it is
    // transient, and Reload (showError's CTA) recovers it. Only a genuine miss (no_crate / no such
    // user) falls through to the deliberately-ambiguous S10 card below (never confirms existence).
    if (_ownerErr) { showError(_ownerErr); return; }
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
      try { await _pipeCall('disconnect-discogs', {}); track('discogs_disconnected'); window.location.href = '/app'; }
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
    try { sessionStorage.setItem('tw_wantlist_due', '1'); } catch (e) {}   // Wave 2 B1: first-connect wantlist import (read by the own-crate flag-check below)
    try { sessionStorage.setItem('tw_inventory_due', '1'); } catch (e) {}   // Wave 4: first-connect for-sale import
    if (profile.import_status === 'running') {
      const ok = await runImport();        // resume an interrupted first import
      if (!ok) return;                     // runImport rendered the error state itself
    } else {
      const { count, error: cntErr } = await supabase
        .from('collection_items').select('*', { count: 'exact', head: true })
        .eq('user_id', profile.user_id);   // own rows only (v1.4.2)
      if (cntErr) { showError(new Error('collection count failed: ' + cntErr.message)); return; }
      if ((count ?? 0) > 0) {
        if (!_wlOwed()) backgroundEnrich();  // #26: items landed earlier; drain quietly — but when a wantlist
                                             // sync is owed (it is, on this first-connect path), triggerWantlistSync
                                             // below owns the drain so it runs AFTER the wantlist insert (no stall-guard race)
      } else {
        const ok = await runImport();      // first import
        if (!ok) return;
      }
    }
  } else if (profile.import_status === 'running') {
    backgroundHeal();                      // interrupted re-sync: heal silently
  } else if (!_wlOwed()) {
    backgroundEnrich();                    // audit #11: sweep up any pending leftovers. #26: skip when a
                                           // wantlist sync is owed (e.g. an account RE-SYNC the user navigated
                                           // away from) — the early consumer's triggerWantlistSync owns that drain.
  }

  // Wave 2 Stage A/#26: catch the first-connect wantlist import on the own-crate path — specifically the
  // count>0 sub-path above (items already present, no runImport call, so nothing else fired the sync).
  // render()'s early consumer ran before the first-connect flag (set in the block above) existed, so this
  // is where that case lands. Guarded + idempotent: a no-op if a sync from runImport is already in flight.
  triggerWantlistSync();
  triggerInventorySync();   // Wave 4: the for-sale sync lands on the same first-connect count>0 sub-path

  // #59 — own-crate status feed. Two reads, both non-blocking (never gate first paint): list_friends for the count fallback,
  // get_social_feed for the rich event feed. On resolve, compute the feed choice ONCE (TraxWaxFeedCompute) then repaint. Per-
  // device seen-state (localStorage) lives in app.js; here we only stash the raw current state. Failure → null/[] (quiet strip).
  supabase.rpc('list_friends')
    .then(({ data }) => { window.__twFriendStatus = { count: (data || []).length }; })
    .catch(() => { window.__twFriendStatus = null; })
    .finally(() => { if (window.TraxWaxRerender) window.TraxWaxRerender(); });
  supabase.rpc('get_social_feed')
    .then(({ data }) => { window.__twFeed = Array.isArray(data) ? data : []; })
    .catch(() => { window.__twFeed = []; })
    .finally(() => { if (window.TraxWaxFeedCompute) window.TraxWaxFeedCompute(); if (window.TraxWaxRerender) window.TraxWaxRerender(); });

  // ── Stage D: inject the data providers, then boot the crate from Supabase. ──
  window.TraxWaxViewer = { isOwn: true, signedIn: true, ownerUserId: null, ownerProfile: null };   // #60: explicit flag
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

/* Wave 5b T9: the default vanity slug — slugified display name, capped 18, no edge hyphens;
   an all-symbol name falls back to a random handle. The DB CHECK is the real validator. */
function generateSlug(name) {
  let v = (name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18).replace(/-+$/, '');
  if (!v) v = 'crate-' + Math.random().toString(36).slice(2, 8);
  return v;
}

/* First flip to PUBLIC with no slug yet: write one alongside the visibility change so the
   PUBLIC LINK box never renders empty. Collisions retry with a short random suffix; any other
   failure leaves the box empty for the user to EDIT (never blocks the visibility change). */
async function _ensurePublicSlug(profile) {
  if (profile.public_slug) return;
  const base = generateSlug(profile.display_name || profile.discogs_username || '');
  for (let i = 0; i < 3; i++) {
    const cand = i === 0 ? base : (base.slice(0, 15).replace(/-+$/, '') + '-' + Math.random().toString(36).slice(2, 4));
    const { error } = await supabase.from('profiles')
      .update({ public_slug: cand }).eq('user_id', window.Clerk.user.id);
    if (!error) { profile.public_slug = cand; return; }
    if (!/duplicate|unique/i.test(error.message || '')) return;
  }
}

/* ── Wave 5b: the /c/<slug> public tier (plan docs/wave-5b-plan.md T2b) ─────────────────────
   One RPC (get_public_crate, anon-callable) returns owner identity ("First L.", server-derived),
   per-section public flags, and the records for every public section. Unknown and all-private
   slugs are both NULL (spec §6/§10) → the 404 page. The page paints with NO Clerk load (B3);
   Clerk loads afterward only to redirect the owner/a friend, or to upgrade a signed-in stranger
   to mode D. Providers mirror installFriendCrateProviders' shapes; bootCrate's non-owner branch
   tolerates the ones a public viewer lacks (T2e). */
async function bootPublicCrate(slug) {
  // #113: a returning user is identified BEFORE the anonymous paint (placeholder instead of
  // the flash); strangers — the unfurl-traffic majority — keep the fast no-Clerk paint.
  let _hint = false;
  try { _hint = localStorage.getItem('tw_has_session') === '1'; } catch (e) {}
  if (_hint) {
    const el = app();
    if (el) {
      el.className = '';
      el.innerHTML = `<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--muted)">Loading the crate…</div>`;
    }
    if (await _publicIdentifyFirst(slug)) return;
  }

  let payload = null;
  try {
    const { data, error } = await supabase.rpc('get_public_crate', { p_slug: slug });
    if (error) throw new Error('public crate query failed: ' + error.message);
    payload = data;
  } catch (err) { showError(err); return; }

  // #123 (T2.1): after _publicIdentifyFirst loaded Clerk, this "first" call can actually run
  // AUTHENTICATED and return a {status:'redirect'} (owner/friend) shape that _installPublicCrate
  // cannot consume (no .sections). Only an 'ok' payload installs; anything else (a redirect or a
  // miss) paints the 404 placeholder and hands off to _publicClerkPass, which re-checks authed and
  // redirects owner→/app, friend→/app/<handle>, or upgrades a signed-in stranger to mode D.
  if (!payload || payload.status !== 'ok') { renderPublicNotFound(); _publicClerkPass(slug, null); return; }

  _installPublicCrate(payload);
  await import('/app.js');
  window.TraxWaxBootCrate();
  _publicClerkPass(slug, payload);
}

function renderPublicNotFound(variant) {
  clearAuthMount();
  const el = app();
  if (!el) return;
  // Pass-2 F1: this can render OVER a booted crate (the owner's CLOSED page) — clear app.js's
  // body-level roots and the inert flag so no modal/toast haunts the page, and reset the title.
  resetShellChrome(el);   // T2.8 (#130): shared with the other state-card paths now
  try { document.title = 'TraxWax'; } catch (e) {}
  el.className = '';
  el.innerHTML = UI.publicNotFoundHtml(variant || 'notfound');
}

function _installPublicCrate(d) {
  const rows = (arr) => (Array.isArray(arr) ? arr : []).map((it) => ({
    id: it.release_id,
    artist: it.artist || '', title: it.title || '', year: it.year || 0,
    label: it.label || '', styles: it.styles || [], genres: it.genres || [],
    vinyl: it.vinyl || '', thumb: it.thumb || '', cover_image: it.cover_image || '',
    added: it.added || '', rating: 0, master_id: it.master_id || null,
    releaseYear: (it.master_year && it.master_year > 0) ? it.master_year : (it.year || 0),   // 0040: decade panel bins on original-release year
    price: null, crating: null, crcount: null, have: null, want: null,
  }));
  window.TraxWaxViewer = {
    isOwn: false, signedIn: false, isPublic: true,   // #60: the shape the truth table demands
    canViewCrate: d.sections.crate === true,
    canViewWantlist: d.sections.wantlist === true,
    canViewForSale: d.sections.forsale === true,
  };
  window.TraxWaxOwner = {
    ownerLine: (d.owner.display_name || 'A Collector') + '\u2019s shelf',
    lastSyncedAt: null,
    displayName: d.owner.display_name || '',
    avatarUrl: d.owner.avatar_url || '',
    ownerUsername: '',                       // NEVER a handle on a public surface (spec §10)
    collectingSince: d.owner.collecting_since || null,
    isOwn: false,
  };
  window.TraxWaxData         = async () => rows(d.crate);
  window.TraxWaxWantlistData = async () => rows(d.wantlist);
  window.TraxWaxFriendForSale = async () => {
    const m = new Map();
    for (const it of (Array.isArray(d.forsale) ? d.forsale : [])) m.set(it.release_id, it.listing_id);
    return m;
  };
  // The owner's public wantlist entries for the "they want / you have" count (mode D) — same
  // {id, master} shape the friend path returns, derived from the payload. Not public → []
  // (unknown, not zero — matches the friend semantics).
  window.TraxWaxOwnerWantIds = async () =>
    (d.sections.wantlist === true ? (Array.isArray(d.wantlist) ? d.wantlist : []) : [])
      .map((it) => ({ id: it.release_id, master: it.master_id || null }));
  // No token → no live stats, ever, on a public surface (spec C4). Header EST. is IS_OWN-gated
  // anyway; this keeps any per-release path a silent no-op.
  window.TraxWaxStats = async () => ({});
}

/* Mode D bits: a signed-in stranger on /c/ gets the same viewer-side match context a friend
   viewer gets — the owner-side data is already public — plus their own wantlist writes. */
function installPublicViewerMatchCtx() {
  installViewerMatchCtx();
  window.TraxWaxSetWant = async (releaseId, action) =>
    _pipeCall('wantlist-write', { release_id: releaseId, action });
  try { localStorage.setItem('tw_has_session', '1'); } catch (e) {}   // #113: the identify-first hint
}

/* #113: load Clerk exactly once, whoever asks first — identify-first and the deferred pass can
   both reach here; clerk-js throws on a second load(). */
async function _loadClerkQuiet() {
  await clerkReady();
  if (window.Clerk.loaded) return;
  await window.Clerk.load({
    ui: { ClerkUI: window.__internal_ClerkUICtor },
    appearance: clerkAppearance(document.body.dataset.theme === 'dark'),
    signInUrl: '/app', signUpUrl: '/app?mode=signup',
    signInFallbackRedirectUrl: '/app', signUpFallbackRedirectUrl: '/app',
    afterSignOutUrl: '/',
  });
}

/* #113: a RETURNING user (the tw_has_session hint) is identified BEFORE anything paints — the
   owner/friend paint→vanish→reload flash dies here. One authenticated RPC decides: owner →
   /app (or the CLOSED page for their own dead slug), friend → /app/{handle}, signed-in
   stranger → mode D booted directly from this payload. Returns true when fully handled;
   false falls back to the anonymous flow (Clerk down, signed out — hint cleared — or the
   rare friend-without-handle, which the deferred pass already handles). */
async function _publicIdentifyFirst(slug) {
  try { await _loadClerkQuiet(); } catch (e) { return false; }
  if (!window.Clerk.user) {
    try { localStorage.removeItem('tw_has_session'); } catch (e) {}   // stale hint self-heals
    return false;
  }
  let d = null;
  try {
    const { data, error } = await supabase.rpc('get_public_crate', { p_slug: slug });
    if (error) return false;
    d = data;
  } catch (e) { return false; }
  if (!d) {
    // Signed in and nothing visible: the owner of a dead slug can't land here (relation-first
    // returns their redirect), so this is a genuine unknown/private slug — the 404.
    renderPublicNotFound();
    return true;
  }
  if (d.status === 'redirect') {
    if (d.relation === 'owner') {
      if (d.open === false) { renderPublicNotFound('closed'); return true; }
      window.location.replace('/app'); return true;
    }
    if (d.relation === 'friend' && d.handle) {
      window.location.replace('/app/' + encodeURIComponent(d.handle)); return true;
    }
    return false;   // friend without a handle: rare — anon paint + the deferred pass's mode D
  }
  if (d.status !== 'ok') return false;   // parity with the deferred pass: only 'ok' installs
  // Signed-in stranger: boot mode D straight from the authenticated payload — no double fetch.
  _installPublicCrate(d);
  window.TraxWaxViewer.signedIn = true;
  installPublicViewerMatchCtx();
  await import('/app.js');
  window.TraxWaxBootCrate();
  return true;
}

/* The deferred Clerk pass: load Clerk quietly; if the visitor is signed in, re-run the RPC under
   their JWT — the server answers 'redirect' for the owner (→ /app) or a friend (→ /app/{handle},
   mode B), and full data for a signed-in stranger (mode D: signedIn flips true, the viewer's own
   match context installs, and the crate re-boots so the provider loads run). */
async function _publicClerkPass(slug, firstPayload) {
  try { await _loadClerkQuiet(); } catch (e) { return; }   // Clerk down → the anonymous page stands
  // House idiom (plan F3): signed-in state is !!window.Clerk.user, exactly as route()/boot() read it.
  if (!window.Clerk.user) return;

  // Audit F2: the moment Clerk resolves signed-in, _uid() flips and the still-in-flight
  // ANONYMOUS boot goes stale and silently aborts — so every signed-in path below MUST end in a
  // redirect, a re-boot, or an explicit page, or the visitor is stranded on "Loading the crate…".
  // Pass-3 F1: supabase-js v2 does NOT throw — failures come back as {data:null, error}. An
  // error must NEVER take the reload branch (a persistent auth-only failure would reload-loop);
  // it takes the keep-the-page recovery instead. Reload only on a genuine SQL NULL (revoked).
  let d = null, derr = null;
  try {
    const { data, error } = await supabase.rpc('get_public_crate', { p_slug: slug });
    d = data; derr = error;
  } catch (e) { derr = e; }
  if (derr) {
    if (firstPayload !== null) {
      // Recover the aborted anon boot AS the signed-in viewer we now know they are (pass-2 F4):
      // the data is public either way; the flag only shapes the chrome.
      window.TraxWaxViewer.signedIn = true;
      installPublicViewerMatchCtx();
      window.TraxWaxBootCrate();
    }
    return;
  }
  if (!d) {
    if (firstPayload !== null) {
      // Revoked mid-visit. A soft 404 render would leave app.js's module state haunting the
      // page (open modal, Escape repainting the dead crate — pass-2 F1); reload instead: the
      // fresh boot fetches NULL and renders the 404 with zero leftover state.
      window.location.reload();
      return;
    }
    return;   // the 404 card is already up
  }
  if (d.status === 'redirect') {
    if (d.relation === 'owner') {
      // 0038: 'open' distinguishes a live slug (→ the app) from the owner's own dead link
      // (→ the CLOSED courtesy page; no profile probe needed).
      if (d.open === false) { renderPublicNotFound('closed'); return; }
      window.location.replace('/app'); return;
    }
    if (d.relation === 'friend') {
      if (d.handle) { window.location.replace('/app/' + encodeURIComponent(d.handle)); return; }
      // Friend of an owner with no discogs_username: no /app/{handle} exists (an unlinked account
      // has no records anyway) — render mode D, the only view there is.
      if (firstPayload === null) { renderPublicNotFound(); return; }
      window.TraxWaxViewer.signedIn = true;
      installPublicViewerMatchCtx();
      window.TraxWaxBootCrate();
      return;
    }
  }
  // Mode D (plan F2 + pass-2 F7): install the FRESH authenticated payload (sections may have
  // moved between the two calls), flip the flag, install the viewer's own context, then boot —
  // bootCrate's non-owner branch is what consumes TraxWaxOwnerWantIds/TraxWaxFriendForSale and
  // populates __twMatchCtx/__twInventory; a bare re-render would leave every match count at zero.
  // This also covers a crate OPENED mid-visit while the 404 was up (firstPayload null, d ok).
  if (d.status === 'ok') {
    _installPublicCrate(d);
    window.TraxWaxViewer.signedIn = true;
    installPublicViewerMatchCtx();
    if (firstPayload === null) await import('/app.js');   // the 404 path never loaded the renderer
    window.TraxWaxBootCrate();
  }
}

async function boot() {
  initThemeEarly();

  // Wave 5b: /c/<slug> — the public tier. Renders for a signed-out visitor with no Clerk load
  // (plan T2b / spec B3); bootPublicCrate runs its own deferred Clerk pass to upgrade/redirect.
  // Everything below (finalize codes, invite stash, full Clerk boot) is the signed-in app's
  // business — return early.
  const _pubPath = window.location.pathname.replace(/\/+$/, '');
  if (_pubPath === '/c' || _pubPath.startsWith('/c/')) {
    const _slug = _pubPath.slice(3);
    if (/^[a-z0-9](?:[a-z0-9-]{0,16}[a-z0-9])?$/.test(_slug)) { await bootPublicCrate(_slug); }
    else { renderPublicNotFound(); }   // bare /c, oversize, uppercase, nested — all the 404 page
    return;
  }

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

  // Wave 1: an invite link /i/<code> is often opened by a signed-OUT visitor (a NEW friend).
  // Clerk's sign-in/up flow navigates to /app and would discard the path code, so — exactly like
  // the finalize code above — stash it and strip the URL to /app BEFORE Clerk loads. render()
  // consumes it once the user is signed in, so the invite survives the whole auth round-trip.
  try {
    // Normalize trailing slashes first, exactly like the route parser in render() (so /i/abc/
    // and /i/abc behave identically — the code must not carry a stray slash into the hash).
    const im = window.location.pathname.replace(/\/+$/, '').match(/^\/i\/(.+)$/);
    if (im) {
      sessionStorage.setItem('tw_invite_code', decodeURIComponent(im[1]));
      history.replaceState(null, '', '/app');
    }
  } catch (e) { /* sessionStorage unavailable → the in-URL /i branch in render() still handles it */ }

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
