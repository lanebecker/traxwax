/* TraxWax — boot.ui.js
   The shell system and every non-crate surface, extracted from boot.js's notice() and
   openAccountModal(). Design source: "TraxWax Surfaces.dc.html" (S0–S20).

   WHY THIS IS ITS OWN MODULE
   --------------------------
   boot.js is a router with UI inlined into it. Every state was a hand-built HTML string,
   which is why nine of them drifted apart. These are pure functions that return HTML
   strings (or mount into a node) and take their side effects as injected callbacks — so
   boot.js keeps owning auth, routing, and network, and this file owns nothing but pixels.

   TOKEN DISCIPLINE
   ----------------
   Every colour here is a var(--*) from styles.css. There are no new tokens and no literal
   hex values except #16171a inside the wordmark block, which the design spec pins as black
   in BOTH themes (see Design Kit v1 §1). Dark theme therefore needs zero extra work.  */

/* ── Primitives ────────────────────────────────────────────────────────────── */

export const MONO = "font-family:'IBM Plex Mono',monospace";
export const COND = "font-family:'Barlow Condensed',sans-serif";
export const BODY = "font-family:Archivo,Helvetica,sans-serif";

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Buttons. Five variants, one function. See spec §4.1.
   'danger' is OUTLINED — it only earns an accent fill once armed ('dangerArmed'), which is
   what makes the two-step disconnect and the typed-DELETE gate read as escalating. */
const BTN_BASE = MONO + '; font-size:11.5px; font-weight:700; letter-spacing:.12em; ' +
  'text-transform:uppercase; padding:11px 18px; border-radius:0; cursor:pointer';
const BTN_VARIANTS = {
  primary: 'border:1.5px solid var(--line); background:var(--accent); color:var(--on-accent); box-shadow:3px 3px 0 var(--shadow)',
  secondary: 'border:1.5px solid var(--line); background:var(--panel); color:var(--ink); box-shadow:3px 3px 0 var(--shadow)',
  quiet: 'border:1.5px solid var(--hair); background:var(--panel); color:var(--muted)',
  danger: 'border:1.5px solid var(--accent); background:var(--panel); color:var(--accent)',
  dangerArmed: 'border:1.5px solid var(--line); background:var(--accent); color:var(--on-accent); box-shadow:3px 3px 0 var(--shadow)',
  disabled: 'border:1.5px solid var(--hair); background:var(--bg); color:var(--faint); cursor:not-allowed',
};
export function btnStyle(variant = 'primary') {
  return BTN_BASE + '; ' + (BTN_VARIANTS[variant] || BTN_VARIANTS.primary);
}
export function btn(label, opts = {}) {
  const v = opts.disabled ? 'disabled' : (opts.variant || 'primary');
  return '<button' + (opts.id ? ' id="' + opts.id + '"' : '') +
    (opts.disabled ? ' disabled' : '') +
    ' style="' + btnStyle(v) + (opts.style ? '; ' + opts.style : '') + '">' +
    esc(label) + '</button>';
}
/* Anchors that look like buttons (the landing CTAs, BACK TO THE CRATE). */
export function btnLink(label, href, opts = {}) {
  return '<a href="' + esc(href) + '"' + (opts.rel ? ' rel="' + opts.rel + '"' : '') +
    ' style="' + btnStyle(opts.variant || 'primary') + '; display:inline-block; ' +
    'text-decoration:none' + (opts.style ? '; ' + opts.style : '') + '">' + esc(label) + '</a>';
}

/* Fields. Labels are mono caps ABOVE the input — never placeholder-as-label, which is
   what the old account modal did and which becomes unreadable the moment it's filled. */
export function field(o) {
  const state = o.state || (o.value ? 'filled' : 'empty');
  const border = state === 'error' ? 'var(--accent)'
    : state === 'empty' ? 'var(--hair)' : 'var(--line)';
  return '' +
    '<div style="display:flex; flex-direction:column; gap:6px' +
      (o.span ? '; grid-column:1 / -1' : '') + (o.wrapStyle ? '; ' + o.wrapStyle : '') + '">' +
      '<label for="' + esc(o.id) + '" style="' + MONO + '; font-size:9.5px; font-weight:700; ' +
        'letter-spacing:.16em; color:' + (state === 'error' ? 'var(--accent)' : 'var(--muted)') + '">' +
        esc(o.label) + (o.hintLabel ? ' <span style="color:var(--faint)">· ' + esc(o.hintLabel) + '</span>' : '') +
      '</label>' +
      '<input id="' + esc(o.id) + '" type="' + (o.type || 'text') + '"' +
        (o.value ? ' value="' + esc(o.value) + '"' : '') +
        (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') +
        (o.maxlength ? ' maxlength="' + o.maxlength + '"' : '') +
        (o.inputmode ? ' inputmode="' + o.inputmode + '"' : '') +
        (o.autocomplete ? ' autocomplete="' + o.autocomplete + '"' : '') +
        ' style="' + MONO + '; font-size:12px; padding:10px 11px; width:100%; ' +
        'background:var(--panel); color:var(--ink); border:1.5px solid ' + border + '; ' +
        'border-radius:0; box-sizing:border-box' + (o.style ? '; ' + o.style : '') + '">' +
      (o.hint ? '<span id="' + esc(o.id) + '-hint" style="' + MONO + '; font-size:10px; ' +
        'letter-spacing:.04em; color:' + (state === 'error' ? 'var(--accent)' : 'var(--faint)') +
        '">' + esc(o.hint) + '</span>' : '') +
    '</div>';
}

/* Toggle. Square knob, no radius — the kit has no rounded anything. Wave 1 uses three. */
export function toggle(o) {
  const on = !!o.on;
  return '' +
    '<button id="' + esc(o.id) + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" ' +
      'aria-label="' + esc(o.label) + '" style="width:46px; height:24px; padding:2px; flex:none; ' +
      'border:1.5px solid var(--line); border-radius:0; cursor:pointer; display:inline-flex; ' +
      'align-items:center; background:' + (on ? 'var(--accent)' : 'var(--bar)') + '; ' +
      'justify-content:' + (on ? 'flex-end' : 'flex-start') + '">' +
      '<span style="width:17px; height:17px; display:block; background:' +
        (on ? 'var(--on-accent)' : 'var(--ink)') + '"></span>' +
    '</button>';
}

/* Progress. Hard-edged, accent fill, no animation. Grey fill = stopped (S8). */
export function progressBar(pct, stopped) {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  return '<div style="height:14px; background:var(--bar); border:1.5px solid var(--line); ' +
    'padding:2px"><div style="width:' + w + '%; height:100%; background:' +
    (stopped ? 'var(--muted)' : 'var(--accent)') + '"></div></div>';
}

/* The house no-photo user icon. Ported verbatim from boot.js — the glyph is a fixed ink
   shape, which is why its circle keeps a WHITE fill in both themes. */
export function userIcon(px) {
  return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="8.2" r="4.2" fill="#16171a"/>' +
    '<path d="M3.5 21c1.4-4.4 4.6-6.6 8.5-6.6s7.1 2.2 8.5 6.6z" fill="#16171a"/></svg>';
}
export function avatar(url, px, opts = {}) {
  const ring = opts.ring || 'var(--line)';
  // NEVER render <img src=""> — broken-image glyph, and some browsers re-request the page.
  if (url) {
    return '<img src="' + esc(url) + '" alt="" style="width:' + px + 'px; height:' + px + 'px; ' +
      'border-radius:50%; border:1.5px solid ' + ring + '; object-fit:cover; ' +
      'background:var(--skel); flex:none">';
  }
  return '<span style="width:' + px + 'px; height:' + px + 'px; border-radius:50%; ' +
    'border:1.5px solid ' + ring + '; background:#fff; display:inline-flex; ' +
    'align-items:center; justify-content:center; flex:none">' +
    userIcon(Math.round(px * 0.6)) + '</span>';
}

/* ── The state card (S2–S12) ───────────────────────────────────────────────────
   ONE card for every non-crate state. 540px, hard border, offset shadow, wordmark block
   hung over the top-left corner, tape at the top-right.

   o.kicker    mono caps status line — REQUIRED. It is the slot that says where you are.
   o.headline  Barlow Condensed 36px.
   o.body      HTML string (Archivo 13px) or ''.
   o.problem   HTML string rendered in an accent-ruled slab ABOVE the body (error variants).
   o.extra     HTML string (progress bars, panels, forms) below the body.
   o.actions   HTML string, usually btn() calls in a flex row.
   o.footer    HTML string above the hairline (sign-out link, <details>).
   o.rule      'accent' (default) | 'muted' — muted for the not-an-error states (S10).  */
export function stateCard(o) {
  const ruleColor = o.rule === 'muted' ? 'var(--muted)' : 'var(--accent)';
  return '' +
  '<div style="min-height:100vh; display:flex; align-items:flex-start; justify-content:center; ' +
    'padding:96px 20px 60px; background:var(--bg)">' +
    '<div class="tw-card" style="position:relative; width:540px; max-width:100%; ' +
      'background:var(--panel); border:1.5px solid var(--line); ' +
      'box-shadow:6px 6px 0 var(--shadow); margin-top:14px">' +
      '<div style="height:5px; background:' + ruleColor + '"></div>' +
      '<div style="position:absolute; top:-17px; left:24px; background:#16171a; color:#fff; ' +
        'font-family:Anton,sans-serif; font-size:22px; letter-spacing:.01em; ' +
        'padding:7px 10px 5px; transform:rotate(-1.2deg); border:1.5px solid var(--line)">TRAXWAX</div>' +
      '<span aria-hidden="true" style="position:absolute; top:-9px; right:40px; width:78px; ' +
        'height:18px; background:var(--tape); border-left:1px dashed rgba(0,0,0,.18); ' +
        'border-right:1px dashed rgba(0,0,0,.18); transform:rotate(2.5deg); pointer-events:none"></span>' +
      '<div class="tw-card-body" style="padding:38px 30px 26px; display:flex; ' +
        'flex-direction:column; gap:20px">' +
        '<div style="display:flex; flex-direction:column; gap:7px">' +
          '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; ' +
            'color:' + (o.rule === 'muted' ? 'var(--muted)' : 'var(--accent)') + '">' +
            esc(o.kicker) + '</span>' +
          '<h1 style="' + COND + '; font-size:36px; font-weight:700; line-height:1; margin:0; ' +
            'color:var(--ink)">' + esc(o.headline) + '</h1>' +
          (o.body ? '<div style="' + BODY + '; font-size:13px; line-height:1.65; ' +
            'color:var(--muted)">' + o.body + '</div>' : '') +
        '</div>' +
        (o.problem ? '<div role="alert" style="border-left:4px solid var(--accent); ' +
          'background:var(--bg); padding:13px 15px; ' + BODY + '; font-size:12.5px; ' +
          'line-height:1.6; color:var(--ink)">' + o.problem + '</div>' : '') +
        (o.extra || '') +
        (o.actions ? '<div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap">' +
          o.actions + '</div>' : '') +
        (o.footer ? '<div style="border-top:1px solid var(--hair); padding-top:14px; ' + MONO +
          '; font-size:10.5px; letter-spacing:.06em; color:var(--faint)">' + o.footer + '</div>' : '') +
      '</div>' +
    '</div>' +
  '</div>';
}

export const signOutLink = '<a href="#" id="tw-signout" style="color:var(--faint)">Sign out</a>';

/* ── The empty-state block (S17) ───────────────────────────────────────────────
   NOT a one-off. Wave 1's "no friends yet", Wave 2's "no matches", Wave 3's empty overlap
   all reuse this verbatim. Build against this signature, do not re-author the markup. */
export function emptyState(o) {
  return '' +
  '<div style="padding:70px 40px 76px; display:flex; flex-direction:column; ' +
    'align-items:center; gap:18px; text-align:center">' +
    (o.icon === false ? '' :
      '<div aria-hidden="true" style="width:112px; height:112px; border:1.5px solid var(--hair); ' +
        'background:var(--bg); display:flex; align-items:center; justify-content:center">' +
        '<div style="width:74px; height:74px; border-radius:50%; background:var(--bar); ' +
          'display:flex; align-items:center; justify-content:center">' +
          '<div style="width:22px; height:22px; border-radius:50%; background:var(--accent)"></div>' +
        '</div></div>') +
    '<div style="display:flex; flex-direction:column; gap:8px; align-items:center">' +
      '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; ' +
        'color:var(--accent)">' + esc(o.kicker) + '</span>' +
      '<span style="' + COND + '; font-size:38px; font-weight:700; line-height:1; ' +
        'color:var(--ink)">' + esc(o.headline) + '</span>' +
      '<span style="' + BODY + '; font-size:13.5px; line-height:1.7; color:var(--muted); ' +
        'max-width:48ch">' + o.body + '</span>' +
    '</div>' +
    (o.actions ? '<div style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center">' +
      o.actions + '</div>' : '') +
  '</div>';
}

/* ── Focus management ──────────────────────────────────────────────────────────
   Owed since v0.5.0 planning and load-bearing once people browse each other's crates.
   Call on any overlay/route render; returns a teardown. */
export function trapFocus(container, onEscape) {
  const prev = document.activeElement;
  const SEL = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, ' +
    'summary, [tabindex]:not([tabindex="-1"])';
  const nodes = () => Array.from(container.querySelectorAll(SEL))
    .filter((n) => n.offsetParent !== null || n.tagName === 'SUMMARY');
  const first = nodes()[0];
  if (first) first.focus();
  const onKey = (e) => {
    if (e.key === 'Escape' && onEscape) { onEscape(); return; }
    if (e.key !== 'Tab') return;
    const list = nodes();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); list[list.length - 1].focus(); }
    else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
  };
  document.addEventListener('keydown', onKey);
  return function release() {
    document.removeEventListener('keydown', onKey);
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
  };
}

/* ── S13–S16 · The account page ────────────────────────────────────────────────
   A ROUTE, not a modal. Rationale in the spec §6; the short version is that Wave 1's
   friend list is browsable content that needs a URL, and consent toggles need room for
   copy that carries legal weight.

   deps = {
     profile,                 // the profiles row
     clerkUser,               // window.Clerk.user
     recordCount,             // number | null
     lastSyncedLabel,         // string
     section,                 // 'profile' | 'friends' | 'discogs'
     onSaveProfile(values),   // async -> throws with a human message
     onUploadPhoto(file),     // async -> new imageUrl
     onResync(), onDisconnect(), onDelete(),
     // Wave 1 (friends section):
     onSetVisibility(v),      // async -> set crate_visibility 'private' | 'friends'
     onSetWantlistVisibility(v),  // async -> set wantlist_visibility 'private' | 'friends'
     onSetMatchMode(mode),    // #28: async -> set the viewer's own match_mode 'exact' | 'any'
     onListFriends(),         // async -> [{user_id, discogs_username, display_name, avatar_url, crate_visibility}]
     onCreateInvite(),        // async -> a shareable /i/<code> URL
     onRemoveFriend(userId),  // async -> remove the friendship both directions
   }  */
const NAV = [
  { id: 'profile', label: 'PROFILE' },
  { id: 'friends', label: 'FRIENDS' },   // ▸ Wave 1 — the invite + friends list (v1.15.0: settings moved to SHARING)
  { id: 'sharing', label: 'SHARING' },   // v1.15.0: crate/wantlist visibility + matching
  { id: 'discogs', label: 'DISCOGS' },
  { id: 'danger', label: 'DANGER ZONE', danger: true },   // v1.20.3: its own tab (was target:'discogs')
];

function accountNav(active, o) {
  const items = NAV.map((n) => {
    const isActive = n.id === active || (n.target && n.target === active);
    // DANGER ZONE keeps its accent-red LETTERS in every state (idle and selected) — the warning shouldn't
    // fade; only the selected box/border goes grey (below). Other tabs: muted when idle, ink when active.
    const color = n.danger ? 'var(--accent)' : (isActive ? 'var(--ink)' : 'var(--muted)');
    const inner = '<span style="' + MONO + '; font-size:11px; font-weight:700; ' +
      'letter-spacing:.12em; color:' + color + '">' + n.label + '</span>';
    // The DANGER hairline separator renders in BOTH states (idle link AND selected) so the nav layout
    // doesn't shift when DANGER ZONE becomes the active tab.
    const sep = n.danger ? '<div style="height:1px; background:var(--hair); margin:12px 0"></div>' : '';
    if (isActive && n.id === active) {
      return sep + '<div aria-current="page" style="display:flex; align-items:center; gap:10px; ' +
        'padding:11px 18px; background:var(--bg); border-left:4px solid ' + (n.danger ? 'var(--muted)' : 'var(--accent)') + '">' +
        inner + '</div>';
    }
    return sep +
      '<a href="' + esc(o.hrefFor(n.target || n.id)) + '" style="display:flex; align-items:center; ' +
      'gap:8px; padding:11px 18px 11px 22px; text-decoration:none">' + inner + '</a>';
  }).join('');

  const name = [o.clerkUser?.firstName, o.clerkUser?.lastName].filter(Boolean).join(' ')
    || o.profile.display_name || 'Your account';
  return '' +
  '<div class="tw-acct-nav" style="border-right:1.5px solid var(--line); ' +
    'background:var(--panel); padding:18px 0">' +
    '<div style="display:flex; align-items:center; gap:12px; padding:0 18px 18px; ' +
      'border-bottom:1px solid var(--hair); margin-bottom:12px">' +
      '<span id="tw-acct-nav-avatar">' + avatar(o.profile.avatar_url, 40) + '</span>' +
      '<div style="display:flex; flex-direction:column; gap:2px; min-width:0">' +
        '<span style="' + COND + '; font-size:18px; font-weight:700; line-height:1; ' +
          'color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis">' +
          esc(name) + '</span>' +
        '<span style="' + MONO + '; font-size:9.5px; letter-spacing:.08em; color:var(--faint); ' +
          'white-space:nowrap; overflow:hidden; text-overflow:ellipsis">' +
          esc(o.profile.discogs_username || '') + '</span>' +
      '</div>' +
    '</div>' + items +
    // v1.4.2: sign out lives at the bottom of the account nav.
    '<div style="height:1px; background:var(--hair); margin:12px 0"></div>' +
    '<button id="tw-acct-signout" style="' + MONO + '; font-size:11px; font-weight:700; ' +
      'letter-spacing:.12em; color:var(--muted); background:transparent; border:0; cursor:pointer; ' +
      'display:flex; align-items:center; gap:8px; padding:11px 18px 11px 22px; width:100%; ' +
      'text-align:left">SIGN OUT</button>' +
  '</div>';
}

function sectionHead(kicker, headline, body) {
  return '<div style="display:flex; flex-direction:column; gap:5px">' +
    '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; ' +
      'color:var(--accent)">' + esc(kicker) + '</span>' +
    '<h2 style="' + COND + '; font-size:32px; font-weight:700; line-height:1; margin:0; ' +
      'color:var(--ink)">' + esc(headline) + '</h2>' +
    (body ? '<span style="' + BODY + '; font-size:13px; line-height:1.65; color:var(--muted)">' +
      body + '</span>' : '') +
  '</div>';
}

/* Reusable account-section label: a mono caps word + a hairline rule filling the row.
   The label pattern for every account section (Design Kit v2, FRIENDS-SPEC §2). `html` may
   carry markup (e.g. the accent count in "YOUR FRIENDS · N") — callers pass only authored
   strings here, never user input. */
function sectionLabel(html) {
  return '<div style="display:flex; align-items:center; gap:12px">' +
    '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.16em; ' +
      'color:var(--muted); white-space:nowrap">' + html + '</span>' +
    '<span style="flex:1; height:1px; background:var(--hair)"></span>' +
  '</div>';
}

function profileSection(o) {
  const p = o.profile, u = o.clerkUser || {};
  return '' +
  '<div style="padding:28px 30px 34px; display:flex; flex-direction:column; gap:26px">' +
    sectionHead('PROFILE', 'How your shelf introduces itself',
      /* ▸ Wave 1: delete this sentence the day crate_visibility ships. */
      'Nobody sees any of this yet — your crate is private. It\u2019s here so it\u2019s ready when sharing arrives.') +
    '<div id="tw-acct-msg" role="status" aria-live="polite" style="' + MONO + '; font-size:11.5px; ' +
      'line-height:1.6; color:var(--accent); min-height:0"></div>' +
    '<div style="display:flex; gap:20px; align-items:center; border:1.5px solid var(--hair); padding:16px">' +
      '<span id="tw-prof-avatar-slot">' + avatar(p.avatar_url, 72) + '</span>' +
      '<div style="display:flex; flex-direction:column; gap:8px">' +
        '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.16em; ' +
          'color:var(--muted)">PROFILE PHOTO</span>' +
        '<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">' +
          '<label style="' + btnStyle('secondary') + '; display:inline-block">UPLOAD A PHOTO' +
            '<input id="tw-prof-photo" type="file" accept="image/jpeg,image/png,image/webp" ' +
            'style="display:none"></label>' +
          '<span style="' + MONO + '; font-size:9.5px; letter-spacing:.06em; color:var(--faint)">' +
            'JPG, PNG OR WEBP · UNDER 10 MB</span>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="tw-acct-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:16px 18px">' +
      field({ id: 'tw-prof-first', label: 'FIRST NAME', value: u.firstName || '', autocomplete: 'given-name' }) +
      field({ id: 'tw-prof-last', label: 'LAST NAME', value: u.lastName || '', autocomplete: 'family-name' }) +
      field({ id: 'tw-prof-bio', label: 'BIO', hintLabel: 'ONE LINE, 200 CHARACTERS',
        value: p.bio || '', maxlength: 200, span: true,
        placeholder: 'Mostly indie rock and whatever the clerk talked me into.' }) +
      field({ id: 'tw-prof-loc', label: 'LOCATION', value: p.location || '', maxlength: 100, placeholder: 'Optional' }) +
      field({ id: 'tw-prof-since', label: 'COLLECTING SINCE',
        value: p.collecting_since ? String(p.collecting_since) : '', maxlength: 4, inputmode: 'numeric' }) +
      field({ id: 'tw-prof-link1', label: 'LINK', value: p.link1 || '', maxlength: 200, placeholder: 'https://' }) +
      field({ id: 'tw-prof-link2', label: 'ANOTHER LINK', value: p.link2 || '', maxlength: 200, placeholder: 'https://' }) +
    '</div>' +
    '<div style="display:flex; align-items:center; gap:16px; border-top:1px solid var(--hair); ' +
      'padding-top:18px">' +
      btn('Save profile', { id: 'tw-prof-save' }) +
      '<span id="tw-prof-saved" style="' + MONO + '; font-size:10.5px; letter-spacing:.08em; ' +
        'color:var(--faint)"></span>' +
    '</div>' +
  '</div>';
}

function discogsSection(o) {
  const p = o.profile;
  return '' +
  '<div style="padding:28px 30px 34px; display:flex; flex-direction:column; gap:22px">' +
    sectionHead('DISCOGS', 'The connection',
      'Where TraxWax reads from your Discogs collection. Keep it synced, or cut the cord anytime.') +
    '<div id="tw-acct-msg" class="tw-acct-status" role="status" aria-live="polite" style="' + MONO + '; font-size:11.5px; ' +
      'line-height:1.6; color:var(--accent)"></div>' +
    sectionLabel('SYNC') +
    '<div style="border:1.5px solid var(--line); display:flex; flex-wrap:wrap; align-items:center; ' +
      'justify-content:space-between; gap:16px; padding:16px 18px">' +
      '<div style="display:flex; flex-direction:column; gap:5px">' +
        '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.16em; ' +
          'color:var(--muted)">CONNECTED AS</span>' +
        '<span style="' + COND + '; font-size:24px; font-weight:700; line-height:1; ' +
          'color:var(--ink)">' + esc(p.discogs_username || '—') + '</span>' +
      '</div>' +
      '<div style="display:flex; gap:26px; flex-wrap:wrap">' +
        statCell('RECORDS', o.recordCount == null ? '—' : Number(o.recordCount).toLocaleString()) +
        statCell('LISTED', o.inventoryCount == null ? '—' : Number(o.inventoryCount).toLocaleString()) +   // Wave 4 (G): for-sale count; same one Re-sync pulls it
        statCell('LAST SYNCED', o.lastSyncedLabel || '—') +
      '</div>' +
      btn('Re-sync now', { id: 'tw-acct-resync', variant: 'secondary' }) +
    '</div>' +
    sectionLabel('DISCONNECT') +
    '<div style="border:1.5px solid var(--line); padding:16px 18px; display:flex; ' +
      'flex-direction:column; gap:12px">' +
      '<span style="' + BODY + '; font-size:12.5px; line-height:1.65; color:var(--muted); ' +
        'max-width:66ch">Disconnecting removes your imported collection from TraxWax. Your ' +
        'Discogs account is untouched, and reconnecting re-imports everything in about a ' +
        'minute. To fully revoke access, also remove TraxWax under Discogs \u2192 Settings ' +
        '\u2192 Applications.</span>' +
      btn('Disconnect Discogs', { id: 'tw-acct-disc', variant: 'danger', style: 'align-self:flex-start' }) +
    '</div>' +
  '</div>';
}

/* v1.20.3: DANGER ZONE is now its own tab (was folded into DISCOGS). Just the delete-everything block. */
function dangerSection(o) {
  return '' +
  '<div style="padding:28px 30px 34px; display:flex; flex-direction:column; gap:22px">' +
    sectionHead('DANGER ZONE', 'Delete everything',
      'The point of no return. Deleting wipes your TraxWax data for good; your Discogs account is safe.') +
    '<div id="tw-acct-msg" class="tw-acct-status" role="status" aria-live="polite" style="' + MONO + '; font-size:11.5px; ' +
      'line-height:1.6; color:var(--accent)"></div>' +
    sectionLabel('DANGER, WILL ROBINSON') +
    '<div style="border:1.5px solid var(--accent); padding:16px 18px; display:flex; ' +
      'flex-direction:column; gap:14px">' +
      '<span style="' + BODY + '; font-size:12.5px; line-height:1.65; color:var(--muted); ' +
        'max-width:66ch">This removes everything TraxWax stores about you — profile, ' +
        'imported collection, Discogs connection. Your sign-in identity is ' +
        '<b style="color:var(--ink)">not</b> deleted and keeps working elsewhere.</span>' +
      '<div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap">' +
        field({ id: 'tw-acct-confirm', label: 'TYPE DELETE TO CONFIRM', placeholder: 'DELETE',
          state: 'error', wrapStyle: 'width:170px', style: 'width:140px' }) +
        btn('Delete my TraxWax data', { id: 'tw-acct-del', disabled: true }) +
      '</div>' +
    '</div>' +
  '</div>';
}

function statCell(label, value) {
  return '<div style="display:flex; flex-direction:column; gap:4px">' +
    '<span style="' + MONO + '; font-size:9px; font-weight:700; letter-spacing:.14em; ' +
      'color:var(--faint)">' + esc(label) + '</span>' +
    '<span style="' + COND + '; font-size:26px; font-weight:700; line-height:1; ' +
      'color:var(--ink)">' + esc(value) + '</span></div>';
}

/* ── Wave 1: FRIENDS (with SHARING merged in, v1.4.1) ── the crate-visibility consent copy +
   toggle sit at the TOP of this section, above the invite link + friend list. The separate SHARING
   tab was removed (one concept, one tab). Reads o.profile.crate_visibility. Bare helper names —
   this is inside boot.ui.js; `UI` is boot.js's import alias. */
function friendsSection(o) {
  return '' +
  '<div style="padding:28px 30px 34px; display:flex; flex-direction:column; gap:22px">' +
    // Intro: eyebrow + title + one description line. Settings moved to SHARING (v1.15.0).
    '<div style="display:flex; flex-direction:column; gap:5px">' +
      '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; ' +
        'color:var(--accent)">FRIENDS</span>' +
      '<h2 style="' + COND + '; font-size:32px; font-weight:700; line-height:1; margin:0; ' +
        'color:var(--ink)">The people you swap crates with</h2>' +
      '<span style="' + BODY + '; font-size:13px; line-height:1.65; color:var(--muted)">' +
        'Send a link to add someone. Manage who sees your shelves over in ' +
        '<a href="' + esc(o.hrefFor('sharing')) + '" style="color:var(--accent); text-decoration:underline">Sharing</a>.</span>' +
    '</div>' +

    // ── INVITE A FRIEND — the link tool, boxed with its caption. (Unchanged.)
    sectionLabel('INVITE A FRIEND') +
    '<div style="border:1.5px solid var(--line); padding:16px 18px; display:flex; ' +
      'flex-direction:column; gap:12px">' +
      '<span style="' + BODY + '; font-size:12.5px; line-height:1.6; color:var(--muted)">' +
        'Create a one-time link and send it to someone. When they open it, they’re added to your ' +
        'friends list below.</span>' +
      '<div id="tw-friends-msg" role="status" aria-live="polite" style="' + MONO + '; ' +
        'font-size:11.5px; line-height:1.6; color:var(--accent); min-height:0"></div>' +
      '<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">' +
        '<button id="tw-invite-btn" style="' + btnStyle('primary') + '">CREATE AN INVITE LINK</button>' +
        '<input id="tw-invite-link" readonly style="' + MONO + '; font-size:12px; padding:9px 11px; ' +
          'flex:1; min-width:280px; border:1.5px solid var(--hair); background:var(--bar); ' +
          'color:var(--ink); text-overflow:ellipsis; display:none">' +
        '<button id="tw-invite-copy" style="' + btnStyle('secondary') + '; display:none">COPY</button>' +
      '</div>' +
      '<span id="tw-invite-life" style="' + MONO + '; font-size:10px; letter-spacing:.06em; ' +
        'color:var(--faint); display:none">Works once · expires in 14 days</span>' +
    '</div>' +

    // ── YOUR FRIENDS · N — the list, one container, heading carries a live count.
    '<div id="tw-friends-head">' +
      sectionLabel('YOUR FRIENDS · <span id="tw-friends-count" style="color:var(--accent)">—</span>') +
    '</div>' +
    '<div id="tw-friends-list"></div>' +
  '</div>';
}

/* v1.15.0: one PRIVATE ▸ FRIENDS segment for the 1c visibility control. Same idiom as segBtn (the MATCHING
   control), keyed on data-vis (the value 'private'|'friends'). padding:8px 12px = pixel-identical to segBtn
   so the two segmented controls on the SHARING tab read as one language. The wire re-styles on click. */
function visSegBtn(v, label, cur) {
  const on = cur === v;
  return '<button data-vis="' + v + '" aria-pressed="' + on + '" style="' + MONO + '; font-size:10.5px; ' +
    'letter-spacing:.06em; padding:8px 12px; border:0; cursor:pointer; ' +
    (on ? 'background:var(--ink); color:var(--panel)' : 'background:var(--panel); color:var(--muted)') + '">' + label + '</button>';
}

/* v1.15.0 (the SPLIT): crate + wantlist visibility (1c segmented box) + the matching control, moved out of
   FRIENDS. Reads o.profile.{crate_visibility, wantlist_visibility, match_mode}. Bare helper names (this is
   inside boot.ui.js; `UI` is boot.js's import alias). */
function sharingSection(o) {
  const crateVis = ((o.profile && o.profile.crate_visibility) || 'private');   // 'friends' | 'private'
  const wlVis    = ((o.profile && o.profile.wantlist_visibility) || 'private');
  const fsVis    = ((o.profile && o.profile.forsale_visibility) || 'private'); // Wave 4 Stage 2: for-sale consent
  const crateFriends = crateVis === 'friends';                                 // E1 gate: for-sale row locked unless crate is friends-visible
  const mm       = (o.profile && o.profile.match_mode) || 'exact';             // #28: matching preference
  const rowTitle = (t) => '<span style="' + COND + '; font-size:21px; font-weight:700; line-height:1; color:var(--ink)">' + t + '</span>';
  const rowSub   = (t) => '<span style="' + MONO + '; font-size:10px; color:var(--muted)">' + t + '</span>';
  return '' +
  '<div style="padding:28px 30px 34px; display:flex; flex-direction:column; gap:22px">' +
    // Intro.
    '<div style="display:flex; flex-direction:column; gap:5px">' +
      '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; ' +
        'color:var(--accent)">SHARING</span>' +
      '<h2 style="' + COND + '; font-size:32px; font-weight:700; line-height:1; margin:0; ' +
        'color:var(--ink)">Who sees what, and how matches read</h2>' +
      '<span style="' + BODY + '; font-size:13px; line-height:1.65; color:var(--muted)">' +
        'Your shelves are private by default. Open them to the friends you’ve added — including what you’ve ' +
        'listed for sale. Prices always live on Discogs, never here.</span>' +
    '</div>' +
    // Shared status line (visibility changes announce here — moved from FRIENDS).
    '<div id="tw-share-msg" class="tw-acct-status" role="status" aria-live="polite" style="' + MONO + '; font-size:11.5px; ' +
      'line-height:1.6; color:var(--accent); min-height:0"></div>' +

    // ── VISIBILITY — the 1c box: one container, caption row, two hairline-separated shelf rows.
    sectionLabel('VISIBILITY') +
    '<div style="border:1.5px solid var(--line)">' +
      '<div style="padding:11px 18px; border-bottom:1px solid var(--hair)">' +
        '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.16em; ' +
          'color:var(--muted)">WHO CAN SEE YOUR SHELVES</span>' +
      '</div>' +
      // crate row
      '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 18px">' +
        '<div style="display:flex; flex-direction:column; gap:3px">' + rowTitle('My crate') + rowSub('The records you own') + '</div>' +
        '<div id="tw-vis-crate-seg" role="group" aria-label="Crate visibility" style="display:flex; ' +
          'border:1.5px solid var(--line); flex:none">' +
          visSegBtn('private', 'PRIVATE', crateVis) + visSegBtn('friends', 'FRIENDS', crateVis) +
        '</div>' +
      '</div>' +
      // wantlist row (hairline between)
      '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 18px; ' +
        'border-top:1px solid var(--hair)">' +
        '<div style="display:flex; flex-direction:column; gap:3px">' + rowTitle('My wantlist') + rowSub('The records you’re hunting') + '</div>' +
        '<div id="tw-vis-wl-seg" role="group" aria-label="Wantlist visibility" style="display:flex; ' +
          'border:1.5px solid var(--line); flex:none">' +
          visSegBtn('private', 'PRIVATE', wlVis) + visSegBtn('friends', 'FRIENDS', wlVis) +
        '</div>' +
      '</div>' +
      // Wave 4 Stage 2 (E): for-sale row, gated UNDER crate visibility. Live segmented control when the crate is
      // friends-visible; LOCKED (aria-disabled, greyed, inline reason) otherwise — a for-sale badge has nowhere
      // to render on a crate a friend can't see. wireVisSeg only fires when #tw-vis-forsale-seg exists (unlocked).
      '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 18px; ' +
        'border-top:1px solid var(--hair)">' +
        '<div style="display:flex; flex-direction:column; gap:3px">' + rowTitle('My records for sale') +
          rowSub('The records you’ve listed on Discogs') +
          ((crateFriends && o.inventoryCount === 0)
            ? '<span style="' + MONO + '; font-size:10px; color:var(--faint)">Nothing listed yet</span>' : '') +
        '</div>' +
        (crateFriends
          ? '<div id="tw-vis-forsale-seg" role="group" aria-label="For-sale visibility" style="display:flex; ' +
              'border:1.5px solid var(--line); flex:none">' +
              visSegBtn('private', 'PRIVATE', fsVis) + visSegBtn('friends', 'FRIENDS', fsVis) +
            '</div>'
          : '<div role="group" aria-label="For-sale visibility" aria-disabled="true" style="display:flex; ' +
              'flex-direction:column; align-items:flex-end; gap:5px; flex:none; max-width:236px">' +
              '<div style="display:flex; border:1.5px solid var(--hair); opacity:.55">' +
                '<span style="' + MONO + '; font-size:10.5px; letter-spacing:.06em; padding:8px 12px; ' +
                  'color:var(--faint)">🔒 PRIVATE</span>' +
                '<span style="' + MONO + '; font-size:10.5px; letter-spacing:.06em; padding:8px 12px; ' +
                  'color:var(--faint)">FRIENDS</span>' +
              '</div>' +
              '<span style="' + MONO + '; font-size:9.5px; color:var(--faint); text-align:right; ' +
                'line-height:1.4">Open your crate to friends first — that’s where for-sale shows.</span>' +
            '</div>') +
      '</div>' +
    '</div>' +

    // ── MATCHING — moved verbatim from friends (#28). Same segmented idiom → the tab reads as one language.
    sectionLabel('MATCHING') +
    '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; ' +
      'border:1.5px solid var(--line); padding:16px 18px">' +
      '<div style="display:flex; flex-direction:column; gap:3px">' +
        '<span style="' + COND + '; font-size:21px; font-weight:700; line-height:1; ' +
          'color:var(--ink)">How overlaps are counted</span>' +
        '<span style="' + MONO + '; font-size:10.5px; color:var(--muted)">' +
          'Changes how you read matches on everyone’s crate. Doesn’t change what you add.</span>' +
      '</div>' +
      '<div id="tw-match-seg" role="group" aria-label="Matching mode" style="display:flex; ' +
        'border:1.5px solid var(--line); flex:none">' +
        segBtn('exact', 'EXACT PRESSING', mm) + segBtn('any', 'ANY PRESSING', mm) +
      '</div>' +
    '</div>' +
    '<span style="' + MONO + '; font-size:10px; line-height:1.6; color:var(--faint); margin-top:-12px">' +
      'EXACT — the same pressing on both lists (the default). ANY — any pressing of the same album counts.</span>' +
  '</div>';
}

/* #28: one segment of the MATCHING control. Selected = ink fill; the wire re-styles on click. */
function segBtn(v, label, cur) {
  const on = cur === v;
  return '<button data-mm="' + v + '" aria-pressed="' + on + '" style="' + MONO + '; font-size:10.5px; ' +
    'letter-spacing:.06em; padding:8px 12px; border:0; cursor:pointer; ' +
    (on ? 'background:var(--ink); color:var(--panel)' : 'background:var(--panel); color:var(--muted)') + '">' + label + '</button>';
}

/* Populate #tw-friends-list from deps.onListFriends(). Reused on first render and after a
   removal. emptyState() for the no-friends case. */
// REMOVE button styling — smaller 2px offset shadow, per FRIENDS-SPEC §3.4. Armed state earns
// the accent fill, matching the two-step DISCONNECT idiom.
const RM_BASE = MONO + '; font-size:10.5px; font-weight:700; letter-spacing:.1em; ' +
  'text-transform:uppercase; padding:8px 13px; border-radius:0; cursor:pointer; flex:none; ' +
  'border:1.5px solid var(--line)';
const RM_REST = RM_BASE + '; background:var(--panel); color:var(--ink); box-shadow:2px 2px 0 var(--shadow)';
const RM_ARMED = RM_BASE + '; background:var(--accent); color:var(--on-accent); box-shadow:2px 2px 0 var(--shadow)';

async function renderFriendsList(root, deps) {
  const host = root.querySelector('#tw-friends-list');
  if (!host) return;
  const setCount = (n) => { const c = root.querySelector('#tw-friends-count'); if (c) c.textContent = String(n); };
  let friends = [];
  try { friends = await deps.onListFriends(); } catch (e) { host.innerHTML = ''; setCount(0); return; }
  setCount(friends.length);
  if (!friends.length) {
    // Empty state is a single hairline box (NOT an empty ink container) — FRIENDS-SPEC §3.4.
    host.innerHTML = '<div style="border:1px solid var(--hair); padding:22px; text-align:center; ' +
      MONO + '; font-size:11px; letter-spacing:.05em; color:var(--muted)">' +
      'No friends yet — send an invite to get started.</div>';
    return;
  }
  const last = friends.length - 1;
  host.innerHTML = '<div style="border:1.5px solid var(--line)">' + friends.map((f, i) =>
    (() => {
      const uname = f.discogs_username || '';
      const dname = f.display_name || uname || 'Friend';
      const name = esc(dname);                                 // plain text, for the REMOVE aria-label
      const sharing = f.crate_visibility === 'friends';
      const rule = i === last ? 'transparent' : 'var(--hair)';   // no trailing divider inside the box
      // Username beside the name so a friend is identifiable/findable — "Tommy Perkins (tommyp)".
      // Skip the parens when name and username are the same.
      const nameHtml = name +
        (uname && uname.toLowerCase() !== dname.toLowerCase()
          ? ' <span style="' + MONO + '; font-size:12px; font-weight:400; color:var(--faint)">(' +
            esc(uname) + ')</span>'
          : '');
      // Sharing: the whole name line links to their crate (a friend who isn't sharing would just
      // hit the "no crate here" page, so keep it plain). The VIEW CRATE → action is kept alongside.
      const nameLine = sharing
        ? '<a href="/app/' + encodeURIComponent(uname) + '" style="' + COND +
          '; font-size:19px; font-weight:700; line-height:1; color:var(--ink); text-decoration:none">' +
          nameHtml + '</a>'
        : '<span style="' + COND + '; font-size:19px; font-weight:700; line-height:1; ' +
          'color:var(--ink)">' + nameHtml + '</span>';
      // Wave 4 D2: a friend selling >=1 record you want gets the actionable "Selling N you want" line (accent,
      // in-app link, NO ↗) that opens their crate pre-filtered to for-sale ∩ your wants; else the base line.
      // (SPEC's middle "activity pulse" tier is skipped — Lane's scope call.) sellN is consent-gated server-side.
      const sellN = Number(f.selling_you_want || 0);
      const status = (sharing && sellN > 0)
        ? '<a href="/app/' + encodeURIComponent(uname) + '#selling" style="' + MONO + '; font-size:10.5px; ' +
          'font-weight:700; letter-spacing:.04em; color:var(--accent); text-decoration:none">Selling ' + sellN + ' you want</a>'
        : (sharing
          ? '<span style="' + MONO + '; font-size:10.5px; letter-spacing:.04em; color:var(--muted)">Sharing their crate</span>'
          : '<span style="' + MONO + '; font-size:10.5px; letter-spacing:.04em; color:var(--faint)">Not sharing right now</span>');
      const viewCrate = sharing
        ? '<a href="/app/' + encodeURIComponent(uname) + '" style="' + MONO + '; font-size:10.5px; ' +
          'font-weight:700; letter-spacing:.1em; color:var(--accent); text-decoration:none; flex:none">VIEW CRATE →</a>'
        : '';
      return '<div style="display:flex; align-items:center; gap:14px; padding:14px 18px; ' +
        'border-bottom:1px solid ' + rule + '">' +
        avatar(f.avatar_url, 44) +
        '<div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:3px">' +
          nameLine + status +
        '</div>' +
        viewCrate +
        '<button data-remove-friend="' + esc(f.user_id) + '" aria-label="Remove ' + name + '" ' +
          'style="' + RM_REST + '">REMOVE</button>' +
      '</div>';
    })()).join('') + '</div>';
  host.querySelectorAll('[data-remove-friend]').forEach((btn) => {
    // Two-step inline, matching the DISCONNECT DISCOGS idiom: first click ARMS, second removes.
    let armed = false;
    const rest = () => { armed = false; btn.textContent = 'REMOVE'; btn.setAttribute('style', RM_REST); };
    btn.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        btn.textContent = 'REALLY REMOVE?';
        btn.setAttribute('style', RM_ARMED);
        setTimeout(() => { if (armed) rest(); }, 4000);   // auto-disarm if they walk away
        return;
      }
      btn.disabled = true; btn.textContent = 'REMOVING…';
      try {
        await deps.onRemoveFriend(btn.getAttribute('data-remove-friend'));
        await renderFriendsList(root, deps);
        // Focus doesn't vanish to <body> after the list re-renders (a11y).
        const ib = root.querySelector('#tw-invite-btn');
        if (ib) ib.focus();
      } catch (e) { btn.disabled = false; rest(); }
    });
  });
}

export function accountPageHtml(o) {
  const section = ['discogs', 'friends', 'sharing', 'danger'].includes(o.section) ? o.section : 'profile';
  return '' +
  '<div style="max-width:1040px; margin:0 auto; background:var(--panel); ' +
    'border:1.5px solid var(--line); box-shadow:5px 5px 0 rgba(0,0,0,.16)">' +
    '<div class="tw-header" style="position:relative; display:flex; align-items:flex-end; ' +
      'justify-content:space-between; gap:20px; padding:20px 24px 16px; background:var(--accent); ' +
      'border-bottom:3px solid var(--line)">' +
      '<span aria-hidden="true" style="position:absolute; top:-9px; left:44px; width:88px; ' +
        'height:20px; background:var(--tape); border-left:1px dashed rgba(0,0,0,.18); ' +
        'border-right:1px dashed rgba(0,0,0,.18); transform:rotate(2deg); pointer-events:none"></span>' +
      '<div class="tw-headL" style="display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap">' +
        '<a href="https://traxwax.com/" title="TraxWax home" style="text-decoration:none; display:inline-block">' +
          '<div style="background:#16171a; color:#fff; font-family:Anton,sans-serif; font-size:30px; ' +
            'letter-spacing:.01em; padding:9px 11px 7px; transform:rotate(-1.2deg)">TRAXWAX</div></a>' +
        '<div style="display:flex; flex-direction:column; gap:3px; padding-bottom:3px">' +
          '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; ' +
            'color:rgba(255,255,255,.78)">SETTINGS</span>' +
          '<span style="' + COND + '; font-size:28px; font-weight:700; line-height:1; ' +
            'color:#fff">Your account</span>' +
        '</div>' +
      '</div>' +
      btnLink('← Back to the crate', o.crateHref, { variant: 'secondary', style: 'box-shadow:none' }) +
    '</div>' +
    '<div class="tw-acct-body" style="display:grid; grid-template-columns:236px minmax(0,1fr)">' +
      accountNav(section, o) +
      (section === 'discogs' ? discogsSection(o)
        : section === 'danger' ? dangerSection(o)
        : section === 'friends' ? friendsSection(o)
        : section === 'sharing' ? sharingSection(o)
        : profileSection(o)) +
    '</div>' +
  '</div>';
}

/* Wires the account page's behaviour. Call immediately after inserting accountPageHtml().
   Every network action is an injected dep so this file stays testable and Clerk-free. */
export function bindAccountPage(root, deps) {
  const $ = (id) => root.querySelector('#' + id);
  const msg = (t) => { const el = $('tw-acct-msg'); if (el) el.textContent = t || ''; };

  const signout = $('tw-acct-signout');   // v1.4.2
  if (signout) signout.addEventListener('click', () => { if (deps.onSignOut) deps.onSignOut(); });

  const photo = $('tw-prof-photo');
  if (photo) photo.addEventListener('change', async () => {
    const f = photo.files && photo.files[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { msg('That photo is over 10 MB — pick a smaller one.'); return; }
    msg('Uploading photo…');
    try {
      const url = await deps.onUploadPhoto(f);
      // Refresh BOTH avatars on the page — the form slot AND the nav header (the "top" one).
      // Before, only the slot updated, so the nav avatar showed the old photo until reload.
      const slot = $('tw-prof-avatar-slot');
      if (slot) slot.innerHTML = avatar(url, 72);
      const nav = $('tw-acct-nav-avatar');
      if (nav) nav.innerHTML = avatar(url, 40);
      msg('Photo updated.');
    } catch (e) { msg('Photo upload failed (' + ((e && e.message) || e) + ').'); }
  });

  const save = $('tw-prof-save');
  if (save) save.addEventListener('click', async () => {
    const val = (id) => ($(id)?.value ?? '').trim();
    // Clerk rejects an empty first name; validating here keeps that failure from taking
    // the unrelated bio/location edits down with it.
    if (!val('tw-prof-first')) { msg('First name can\u2019t be empty.'); return; }
    const sinceRaw = val('tw-prof-since');
    const since = sinceRaw ? Number(sinceRaw) : null;
    if (sinceRaw && (!Number.isInteger(since) || since < 1900 || since > 2100)) {
      msg('\u201cCollecting since\u201d wants a year, like 1998.'); return;
    }
    for (const id of ['tw-prof-link1', 'tw-prof-link2']) {
      if (val(id) && !val(id).startsWith('https://')) { msg('Links need to start with https://'); return; }
    }
    save.disabled = true; save.textContent = 'SAVING…'; msg('');
    try {
      await deps.onSaveProfile({
        firstName: val('tw-prof-first'), lastName: val('tw-prof-last'),
        bio: val('tw-prof-bio') || null, location: val('tw-prof-loc') || null,
        collecting_since: since, link1: val('tw-prof-link1') || null,
        link2: val('tw-prof-link2') || null,
      });
      const stamp = $('tw-prof-saved');
      if (stamp) stamp.textContent = 'Saved ' +
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { msg('Save failed (' + ((e && e.message) || e) + ').'); }
    save.disabled = false; save.textContent = 'SAVE PROFILE';
  });

  const resync = $('tw-acct-resync');
  if (resync) resync.addEventListener('click', async () => {
    resync.disabled = true; resync.textContent = 'SYNCING…';
    try { await deps.onResync(); resync.textContent = 'SYNCED'; }
    catch (e) { resync.disabled = false; resync.textContent = 'RE-SYNC NOW'; msg('Re-sync failed.'); }
  });

  /* Two-step disconnect: the button ARMS, and arming is what earns the accent fill. */
  const disc = $('tw-acct-disc');
  let armed = false;
  if (disc) disc.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      disc.textContent = 'Really disconnect — removes imported collection';
      disc.setAttribute('style', btnStyle('dangerArmed'));
      return;
    }
    disc.disabled = true; disc.textContent = 'DISCONNECTING…';
    try { await deps.onDisconnect(); }
    catch (e) {
      disc.disabled = false; armed = false;
      disc.textContent = 'DISCONNECT DISCOGS';
      disc.setAttribute('style', btnStyle('danger'));
      msg('Disconnect failed (' + ((e && e.message) || e) + '). Try again.');
    }
  });

  const confirm = $('tw-acct-confirm');
  const del = $('tw-acct-del');
  if (confirm && del) {
    confirm.addEventListener('input', () => {
      const ok = confirm.value === 'DELETE';
      del.disabled = !ok;
      // A genuinely disabled button, not 45% opacity and still clickable.
      del.setAttribute('style', btnStyle(ok ? 'dangerArmed' : 'disabled'));
    });
    del.addEventListener('click', async () => {
      if (confirm.value !== 'DELETE') return;
      del.disabled = true; del.textContent = 'DELETING…';
      try { await deps.onDelete(); msg('Deleted. Signing you out…'); }
      catch (e) {
        del.disabled = false; del.textContent = 'DELETE MY TRAXWAX DATA';
        msg('Deletion failed (' + ((e && e.message) || e) + '). Try again.');
      }
    });
  }

  // v1.15.0 (1c): the per-shelf PRIVATE ▸ FRIENDS segmented control — click-delegated on its container.
  // `setter` is the visibility dep for that shelf; `label` names it in the status line. Same restyle idiom
  // as wireMatchSeg. Writes 'private'|'friends' — the exact values the old toggles set.
  function wireVisSeg(segId, setter, label) {
    const seg = root.querySelector('#' + segId);
    if (!seg) return;
    seg.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-vis]');
      if (!b) return;
      const next = b.getAttribute('data-vis');   // 'private' | 'friends'
      const smsg = (t) => { const el = $('tw-share-msg'); if (el) el.textContent = t || ''; };
      try {
        await setter(next);
        seg.querySelectorAll('[data-vis]').forEach((x) => {
          const isOn = x.getAttribute('data-vis') === next;
          x.setAttribute('aria-pressed', isOn);
          x.style.background = isOn ? 'var(--ink)' : 'var(--panel)';
          x.style.color = isOn ? 'var(--panel)' : 'var(--muted)';
        });
        smsg(next === 'friends' ? ('Friends can now see your ' + label + '.') : ('Your ' + label + ' is private again.'));
      } catch (e) { smsg('Couldn’t change that: ' + ((e && e.message) || e)); }
    });
  }
  // #28: the MATCHING segmented control — click-delegated on #tw-match-seg. Writes the viewer's own
  // match_mode (not a consent switch); re-styles both segments on success.
  function wireMatchSeg() {
    const seg = root.querySelector('#tw-match-seg');
    if (!seg) return;
    seg.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-mm]');
      if (!b) return;
      const mode = b.getAttribute('data-mm');
      const smsg = (t) => { const el = $('tw-share-msg'); if (el) el.textContent = t || ''; };
      try {
        await deps.onSetMatchMode(mode);
        seg.querySelectorAll('[data-mm]').forEach((x) => {
          const isOn = x.getAttribute('data-mm') === mode;
          x.setAttribute('aria-pressed', isOn);
          x.style.background = isOn ? 'var(--ink)' : 'var(--panel)';
          x.style.color = isOn ? 'var(--panel)' : 'var(--muted)';
        });
        smsg(mode === 'any' ? 'Now matching any pressing of the same album.' : 'Now matching exact pressings only.');
      } catch (e) { smsg('Couldn’t change that: ' + ((e && e.message) || e)); }
    });
  }
  wireVisSeg('tw-vis-crate-seg', deps.onSetVisibility, 'crate');
  wireVisSeg('tw-vis-wl-seg', deps.onSetWantlistVisibility, 'wantlist');
  wireVisSeg('tw-vis-forsale-seg', deps.onSetForsaleVisibility, 'records for sale');   // Wave 4 Stage 2 (no-op when the row is locked)
  wireMatchSeg();

  // ── Wave 1: FRIENDS ── invite-link button + friend list.
  const inviteBtn = $('tw-invite-btn');
  if (inviteBtn) {
    const fmsg = (t) => { const el = $('tw-friends-msg'); if (el) el.textContent = t || ''; };
    const copyBtn = $('tw-invite-copy');
    inviteBtn.addEventListener('click', async () => {
      fmsg('Creating a link…');
      try {
        const link = await deps.onCreateInvite();
        const box = $('tw-invite-link');
        if (box) { box.style.display = ''; box.value = link; box.focus(); box.select(); }
        if (copyBtn) copyBtn.style.display = '';
        const life = $('tw-invite-life');
        if (life) life.style.display = '';
        fmsg('Send this link to your friend.');
      } catch (e) { fmsg('Couldn’t create a link: ' + ((e && e.message) || e)); }
    });
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const box = $('tw-invite-link');
      if (!box || !box.value) return;
      try { await navigator.clipboard.writeText(box.value); }
      catch (e) { box.focus(); box.select(); }   // clipboard blocked → fall back to select-for-manual-copy
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'COPIED';
      setTimeout(() => { copyBtn.textContent = prev; }, 1600);
    });
    renderFriendsList(root, deps);
  }
}

/* ── Copy tables ───────────────────────────────────────────────────────────────
   All user-facing strings for the state surfaces, in one place, so a voice pass never
   again means grepping nine template literals. */
export const COPY = {
  connect: {
    kicker: 'CREATE AN ACCOUNT · STEP 3 OF 3',
    headline: 'Connect your collection',
    body: 'TraxWax needs permission to read your Discogs collection. You\u2019ll approve it ' +
      'on Discogs and come straight back.',
    reassureLabel: 'WHAT WE READ',
    reassure: 'Your collection, and nothing else. We never write to your Discogs account, ' +
      'never touch the marketplace, and never see your password.',
    cta: 'Connect Discogs',
  },
  verify: { kicker: 'CONNECT · VERIFYING', headline: 'Finishing the link',
    body: 'Confirming this connection belongs to you. A couple of seconds.' },
  importRunning: { kicker: 'IMPORT · RUNNING', headline: 'Filing your records',
    body: 'Pulling your collection from Discogs. This runs once, and it\u2019s under a minute ' +
      'for most crates.',
    aside: 'Tracklists and sleeve detail keep loading in the background once your crate opens.' },
  importFailed: { headline: 'Import hit a wall',
    body: 'We couldn\u2019t finish pulling your collection from Discogs. Nothing is lost — ' +
      'reloading picks up exactly where it stopped.', cta: 'Reload and resume' },
  importPaused: { kicker: 'DISCOGS · CONNECTION UNREADABLE', headline: 'Importing is paused',
    body: 'Your stored Discogs connection can\u2019t be read, so we\u2019ve stopped rather than ' +
      'guess. Disconnect and reconnect fixes it — your Discogs account itself is fine.',
    cta: 'Disconnect and start over' },
  /* PRIVACY-CRITICAL. Not-found and not-friends MUST render identically or the page
     confirms to a stranger that a username exists. Never add a per-case detail here. */
  noCrate: { kicker: 'PRIVATE SHELF', headline: 'No crate here',
    body: 'This crate is private, or it doesn\u2019t exist. That\u2019s all we\u2019ll say about it.',
    cta: 'Go to your own crate', rule: 'muted' },
  unexpected: { kicker: 'ERROR · UNEXPECTED', headline: 'Something went sideways',
    body: 'Not your fault, and nothing was lost. Reloading usually settles it.', cta: 'Reload' },
  onboarding: { kicker: 'CREATE AN ACCOUNT · STEP 2 OF 3', headline: 'Whose crate is this?',
    body: 'A name for your shelf, and a photo if you like. Both are editable later from ' +
      'your account.', cta: 'Save and continue', skip: 'Skip for now',
    errNoFirst: 'A first name is the one thing we need here.' },
  emptyCrate: { kicker: 'AN EMPTY CRATE', headline: 'Nothing on the shelf yet',
    body: 'Your Discogs collection came back empty. Add a few records over there and ' +
      're-sync — they\u2019ll be filed here within the minute.' },
  /* The thirteen connect failures, unchanged in meaning, rendered in the problem slab. */
  connectErrors: {
    missing_params: 'Discogs sent us back without the expected details. Try again.',
    not_configured: 'TraxWax is not fully configured yet. This one is on us.',
    state_error: 'We lost track of that connection attempt. Try again.',
    unknown_or_used: 'That connection link was already used, or it has expired. Nothing is wrong with your account — start it again.',
    no_pending: 'That connection link was already used, or it has expired. Nothing is wrong with your account — start it again.',
    link_not_yours: 'That connection was started from a different account, so it was discarded for safety. Connect your own Discogs below.',
    expired: 'That took longer than 15 minutes, so Discogs expired the request. Try again.',
    access_denied: 'Discogs didn\u2019t grant access. Try again, and approve on their screen.',
    identity_failed: 'Discogs wouldn\u2019t tell us who you are. Try again.',
    handle_taken: 'That Discogs account is already linked to another TraxWax account.',
    no_profile: 'We couldn\u2019t find your TraxWax profile. Sign out and back in.',
    store_failed: 'We couldn\u2019t save the connection. Try again.',
    unexpected: 'Something went wrong on our side. Try again.',
  },
  /* Kicker per connect failure — the status goes in the kicker, the sentence in the slab. */
  connectErrorKickers: {
    unknown_or_used: 'CONNECT · THAT LINK EXPIRED',
    no_pending: 'CONNECT · THAT LINK EXPIRED',
    expired: 'CONNECT · THAT LINK EXPIRED',
    access_denied: 'CONNECT · NOT APPROVED',
    handle_taken: 'CONNECT · ALREADY LINKED',
    link_not_yours: 'CONNECT · WRONG ACCOUNT',
  },
};
