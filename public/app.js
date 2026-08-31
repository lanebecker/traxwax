/* ============================================================================
   TraxWax — production app
   Ported from the Claude Design kit (TraxWax App.dc.html). The Claude Design
   runtime (support.js: <x-dc>, {{ }}, <sc-for>, <sc-if>) is replaced by the
   vanilla renderer below. Component styling is copied inline, verbatim, from the
   kit so the design stays authoritative. Logic (matches/sorted/deco/computeVals)
   mirrors the kit's Component class.
   ============================================================================ */

'use strict';

/* ── SETTINGS (the kit's tweakable props → real product settings later) ────── */
const SETTINGS = {
  accent: null,                                  // null = theme default
  showPrices: true,
  ownerLine: "Lane's shelf",                     // tagline (" · filed by <word>") appended at render
};

/* The owner line ends in a wink, not a taxonomy: "<name>'s shelf · filed by <word>". The word is
   picked at random ONCE per page load and frozen for the session, so re-renders (filter/sort/view
   changes) keep it steady and it only reshuffles on a real reload. Owner's own crate only — a
   visitor's shelf keeps its plain "<name>'s shelf" (see the IS_OWN() guard at the render site).
   The list is the single source of truth; boot.js no longer carries the suffix. */
const FILED_BY = [
  'whim', 'mood', 'vibe', 'fancy', 'caprice', 'impulse', 'instinct', 'intuition', 'gut', 'hunch',
  'notion', 'serendipity', 'happenstance', 'kismet', 'chance', 'fate', 'providence', 'the stars',
  'moonlight', 'candlelight', 'dumb luck', 'horoscope', 'tarot', 'tea leaves', 'augury',
  'divination', 'coin toss', 'dice roll', 'guesswork', 'nostalgia', 'longing', 'heartache',
  'sentiment', 'memory', 'reverie', 'rapture', 'daydream', 'déjà vu', 'wanderlust', 'sheer nerve',
  'wishful thinking', 'muscle memory', 'free association', 'sweet abandon', 'pure spite',
  'stubbornness', 'mood swing', 'vibes alone', "the needle's whim", 'chaos',
];
const FILED_BY_WORD = FILED_BY[Math.floor(Math.random() * FILED_BY.length)];

/* Wave 1: the crate renders READ-ONLY when viewing a friend's shelf. boot.js installs
   window.TraxWaxViewer = { isOwn:false, ... } for a friend crate; absent or isOwn===true means
   the owner's own crate (also baked/local-dev mode). */
const IS_OWN = () => !window.TraxWaxViewer || window.TraxWaxViewer.isOwn !== false;

/* Issue #6 (dead code sweep): the client `api` helper (live value + per-record price) is
   gone. Its two endpoints (/api/value, /api/price) were deleted in cold-audit #24 —
   Restricted Data now flows only through the authenticated live-stats Edge Function — so
   both callers were guaranteed-null dead weight. The one surviving proxy call is
   /api/release (CC0), used by _fetchReleaseLive below as the modal's last-resort tier. */

/* Release-detail cache. Tracklists are immutable and community stats change slowly, so
   results persist in localStorage — a record you've opened before shows instantly and
   never re-fetches within the TTL. Long TTL + a modest LRU cap keeps us under quota. */
const REL_CACHE_KEY = 'tw_release_cache_v1';
const REL_TTL_MS = 90 * 24 * 60 * 60 * 1000;   // 90 days
const REL_CACHE_MAX = 800;
let _relCache = {};
try { _relCache = JSON.parse(localStorage.getItem(REL_CACHE_KEY) || '{}'); } catch(e) {}
function _saveRelCache(){
  try {
    const ids = Object.keys(_relCache);
    if (ids.length > REL_CACHE_MAX) {
      ids.sort((a,b)=>(_relCache[a].ts||0)-(_relCache[b].ts||0));
      ids.slice(0, ids.length - REL_CACHE_MAX).forEach(id=>delete _relCache[id]);
    }
    localStorage.setItem(REL_CACHE_KEY, JSON.stringify(_relCache));
  } catch(e) {
    try { localStorage.removeItem(REL_CACHE_KEY); } catch(e2) {}
    _relCache = {};
  }
}
// Tracklist (+ country/released/videos) for the modal. Prefer the immutable baked static
// file — no live call, no rate limit, CDN-cached forever. Fall back to the live proxy only
// for a brand-new record whose file hasn't been baked yet. Community stats + price come
// from collection.json, not from here.
async function _fetchReleaseFile(id){
  try {
    const r = await fetch('/releases/' + id + '.json');
    if (!r.ok) return null;
    const d = await r.json();
    return { tracks: d.tracks || [], country: d.country || '', released: d.released || '', videos: d.videos || [] };
  } catch(e) { return null; }
}
async function _fetchReleaseLive(rec){
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('/api/release/' + rec.id);
      if (r.status === 429 || r.status >= 500) throw new Error('transient');
      if (!r.ok) return null;
      const d = await r.json();
      return { tracks: d.tracks || [], country: d.country || '', released: d.released || '', videos: d.videos || [] };
    } catch(e) { if (attempt < 2) await new Promise(res => setTimeout(res, 1200 * (attempt + 1))); }
  }
  return null;
}

/* ── Helpers (verbatim from the kit) ───────────────────────────────────────── */
const COLORS = {
  black:'#1b1a18', white:'#f4f2ee', clear:'#dfe6e8', pink:'#f26fa1', blue:'#3f6fd8', red:'#d3283a',
  green:'#3f9b57', yellow:'#f2c832', orange:'#ef7c2a', purple:'#8552c9', gold:'#c9a227',
  silver:'#c3c6c8', grey:'#9a9a9a', cream:'#efe4c8', translucent:'#cfd8dc'
};
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function esc(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function swatchFor(text){
  const t=(text||'').toLowerCase(); const hits=[];
  for(const k of Object.keys(COLORS)) if(t.includes(k)) hits.push(COLORS[k]);
  if(t.includes('flamingo')) hits.push('#ff5c8a');
  if(t.includes('marble') && !hits.length) hits.push('#b8b2a6');
  if(!hits.length) return COLORS.black;
  if(hits.length===1) return hits[0];
  return 'linear-gradient(90deg,'+hits[0]+' 0 50%,'+hits[1]+' 50% 100%)';
}
function shortVinyl(text){
  const t=(text||'').replace(/\s*\[[^\]]*\]/g,'').trim();
  return t.length>22 ? t.slice(0,21).trim()+'…' : (t||'Black');
}
/* A vinyl descriptor names a color variant UNLESS every comma-segment is a known
   non-color production note. The old approach listed color words and drowned: Discogs
   variant names are unbounded marketing ("Mango Smoothie", "Speckled Dragon Egg"), and a
   measured 185 distinct descriptors in this collection slipped through — including plain
   "Maroon" and "Beige". Color names are infinite; the boring notes are a closed set. */
const NON_COLOR_SEGMENT = [
  /^\d+([.,]\d+)?\s*-?\s*(g|gm|gr|gram|grams)\.?$/,          // 180g, 120 gram, 180-Gram
  /^(double\s+)?gatefold$/,
  /^(boxset|box set|digipak|slipcase|tri-?fold|bookback)$/,
  /^autographed(\s+jacket)?$/,
  /anniversary(\s+edition)?$/,                                // 25th Anniversary (Edition)
  // Only KNOWN non-color edition qualifiers. A bare "<name> Edition" in the vinyl field
  // usually names a colored variant (Sub Pop "Loser Edition" is colored by definition;
  // "Orange Loser Edition" was wrongly excluded by a greedy /edition$/ in testing).
  /^(deluxe|definitive|listener|expanded|remastered|collector'?s?|standard|limited)\s+edition$/,
  /pressing$/,                                                // Fifth / GZ / Rainbo … Pressing
  /^half speed master$/, /^limited to \d+$/, /^po box address$/, /^coordinates$/,
  /^\d+\s*rpm$/, /^(mono|stereo)$/,
];
function isColored(text){
  const raw=(text||'').trim();
  if(!raw) return false;
  const segs = raw.split(',')
    .map(s=>s.replace(/\s*\[[^\]]*\]/g,'').trim().toLowerCase())
    .filter(Boolean);
  return segs.some(s => !/^black( vinyl)?$/.test(s) &&
    !NON_COLOR_SEGMENT.some(re=>re.test(s)));
}
function money(n){ return '$'+Math.round(n).toLocaleString('en-US'); }
function valueLabel(total){ return total>0 ? money(total) : '—'; }
function initialsOf(artist){
  return String(artist||'').trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase() || '♪';
}
// Designed no-cover placeholder — a flat vinyl in the TraxWax idiom (black / white / one
// red, no gradients); the disc is fixed-black in both themes, like the wordmark block.
function vinylPlaceholder(initials){
  return `<svg viewBox="0 0 100 100" style="width:100%; display:block" aria-hidden="true">`
    + `<rect width="100" height="100" fill="var(--skel)"/>`
    + `<circle cx="50" cy="50" r="40" fill="#16171a"/>`
    + `<circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="0.7"/>`
    + `<circle cx="50" cy="50" r="33" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="0.7"/>`
    + `<circle cx="50" cy="50" r="26" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="0.7"/>`
    + `<circle cx="50" cy="50" r="17.5" fill="var(--accent)"/>`
    + `<text x="50" y="49.75" text-anchor="middle" dominant-baseline="central" font-family="'Barlow Condensed',sans-serif" font-weight="700" font-size="16" fill="#fff">${esc(initials)}</text>`
    + `</svg>`;
}
// Audit #23 (issue #7): LOCAL date parts, not toISOString() — the UTC month flipped the
// JUST IN badge and the THIS MONTH counter a day early/late for non-UTC users.
const _tmNow = new Date();
const THIS_MONTH = _tmNow.getFullYear() + '-' + String(_tmNow.getMonth() + 1).padStart(2, '0');

/* ── State ─────────────────────────────────────────────────────────────────── */
let RECORDS = [];
let WANTLIST_RECORDS = null;   // Wave 2 B1: null = not loaded/failed; [] = loaded-empty. Lazy-loaded on THE WANTLIST tab.
// Wave 2 B1: resolve a record by id from whichever dataset the current view renders — the WANTLIST tab
// draws from WANTLIST_RECORDS, so the detail modal must look there too (else a wantlist card is a dead click).
function recordById(id){
  const src=(state.view==='wantlist' && Array.isArray(WANTLIST_RECORDS)) ? WANTLIST_RECORDS : RECORDS;
  return src.find(r=>r.id===id);
}
const state = {
  theme:'light', view:'crate', query:'', genres:[], coloredOnly:false,
  artist:null, color:null, sort:'added', dir:-1, detailId:null, headerValue:null,
};
let _searchDebounce = null;   // issue #5: pending debounced render, if any

/* ── A11y: modal focus management + roving grid focus (W0.4) ──────────────────
   app.js is deliberately dependency-free (boot.js dynamically imports it; it cannot
   import boot.ui.js), and render() rebuilds #app wholesale on every async stats/tracklist
   load — which is why the modal reuses trapFocus's *selector convention* via a re-render-safe
   controller here rather than calling boot.ui.js's trapFocus (whose one-shot capture of the
   invoker + focus-first cannot survive the rebuild). Keep FOCUSABLE_SEL in sync with the SEL
   in boot.ui.js trapFocus(). */
const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select, ' +
  'textarea, summary, [tabindex]:not([tabindex="-1"])';
const GRID_KEYS = new Set(['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Home','End']);
let _modalInvokerId = null;   // the record id whose card opened the modal; focus returns here on close
let _gridFocusId = null;      // the record id of the roving grid cell that holds tabindex=0
let _modalFocusKey = null;    // identity of the in-modal control focused just before a re-render (see render())

/* ── Theme (persisted; respects prefers-color-scheme on first visit) ────────── */
function initTheme(){
  let t; try { t = localStorage.getItem('tw_theme'); } catch(e){}
  if(!t) t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  setTheme(t, false);
}
function setTheme(t, persist=true){
  state.theme=t; document.body.dataset.theme=t;
  if(persist){ try{ localStorage.setItem('tw_theme',t); }catch(e){} }
}

/* ── Derivations (mirror the kit's matches/sorted/deco) ─────────────────────── */
function matches(r){
  const s=state;
  // Wave 2 B1: the wantlist has no vinyl variant (every row vinyl:''), so the colored/color facets are
  // meaningless there and would zero the whole tab — skip them on the wantlist view.
  if(s.coloredOnly && s.view!=='wantlist' && !isColored(r.vinyl)) return false;
  if(s.artist && r.artist!==s.artist) return false;
  if(s.color && s.view!=='wantlist' && shortVinyl(r.vinyl)!==s.color) return false;
  if(s.genres.length && !s.genres.some(g=>r.styles.includes(g)||r.genres.includes(g))) return false;
  if(s.query){
    const q=s.query.toLowerCase();
    const hay=(r.artist+' '+r.title+' '+r.label+' '+r.styles.join(' ')+' '+r.vinyl).toLowerCase();
    if(!hay.includes(q)) return false;
  }
  return true;
}
function sorted(list){
  const s=state;
  const key={ added:r=>r.added, artist:r=>r.artist.toLowerCase(), year:r=>String(r.year),
    // Audit #19: numeric, not padded-string -- the string form sorted $12.50 below $9.99.
    price:r=>r.price==null?-1:r.price }[s.sort];
  return list.slice().sort((a,b)=>(key(a)<key(b)?-1:key(a)>key(b)?1:0)*s.dir);
}
function deco(r){
  // Audit #17: this URL is the ONE string interpolated into style attributes without
  // esc() (a quote in a shared-catalog image URL would close the attribute -- cross-user
  // via the releases table). https-only, and encode every char that could break out of
  // url('...') inside a double-quoted attribute.
  const rawCover = r.cover_image || r.thumb || '';   // prefer the 600px cover_image; fall back to the 150px thumb
  // Fixed map, NOT encodeURIComponent: remediation audit caught that encodeURIComponent
  // never encodes ' ( ) -- and the single quote is the exact char that breaks out of
  // url('...'). A real Discogs CDN URL contains none of these seven, so covers are
  // unchanged; a hostile URL is inert.
  const COVER_ENC = {'"':'%22',"'":'%27','(':'%28',')':'%29','\\':'%5C','<':'%3C','>':'%3E'};
  const coverUrl = /^https:\/\//.test(rawCover)
    ? rawCover.replace(/["'()\\<>]/g, (c) => COVER_ENC[c])
    : '';
  return { ...r,
    swatch:swatchFor(r.vinyl), vinylShort:shortVinyl(r.vinyl),
    style1:r.styles[0]||r.genres[0]||'—',
    isNew:(r.added||'').slice(0,7)===THIS_MONTH,
    priceLabel:r.price==null?'—':money(r.price),
    coverBg: coverUrl ? "url('"+coverUrl+"')" : 'none',  // single quotes: the div's style="" is double-quoted
    coverAlt:r.artist+' — '+r.title+' cover',
    coverPlaceholder: coverUrl ? '' : vinylPlaceholder(initialsOf(r.artist)),  // designed no-cover state
  };
}
function toggleGenre(g){
  const has=state.genres.includes(g);
  state.genres = has ? state.genres.filter(x=>x!==g) : state.genres.concat([g]);
}

/* ── View helpers ──────────────────────────────────────────────────────────── */
const chipOn = 'background:var(--accent); color:var(--on-accent)';
const chipOff = 'background:var(--panel); color:var(--ink)';

function tab(id,label){
  const on = state.view===id;
  return `<button data-act="view" data-arg="${id}" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.12em; padding:11px 18px; background:transparent; border:0; border-right:1px solid var(--hair); border-bottom:3px solid ${on?'var(--accent)':'transparent'}; color:${on?'var(--ink)':'var(--muted)'}">${label}</button>`;
}
function sortBtn(id,label){
  const on=state.sort===id;
  return `<button data-act="sort" data-arg="${id}" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.06em; padding:5px 9px; border:0; border-right:1px solid var(--hair); background:${on?'var(--ink)':'var(--panel)'}; color:${on?'var(--panel)':'var(--muted)'}">${label}</button>`;
}

/* Wave 2 B2: the ADD/REMOVE want control. Rendered on: every WANTLIST-tab card/modal (remove); and, on
   a friend's crate, un-owned records (add/remove toggle). Same function feeds card() and modalHtml().
   card() runs only in the crate/wantlist grids, so a friend's timeline/ledger show no card-level control
   — but their DETAIL MODAL will show the toggle (still the viewer's own write; deliberate, and useful).
   Returns '' on the own collection crate/timeline/ledger and their modals (IS_OWN() && view!=='wantlist'). */
// appearance:none is load-bearing, not decoration: a native <button> on macOS renders with the system
// control appearance, which clamps font-size and height regardless of the CSS, so it sits smaller/shorter
// than the sibling <a> links with identical styles (#29 — the v1.6.1 fix matched the numbers but not this).
const WANT_BTN_STYLE = "width:100%; margin-top:6px; -webkit-appearance:none; appearance:none; " +
  "font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.06em; padding:6px 8px; " +
  "border:1.5px solid var(--line); background:var(--panel); color:var(--ink); text-align:center; cursor:pointer";
// In the modal, match the sibling action buttons (VIEW ON DISCOGS / LISTEN) exactly — 10.5px type and
// 7px 10px padding, with native appearance stripped — so the three line up in height and size. No
// width:100%: the action column is a stretch flexbox, so the button sizes to full width like the links.
const WANT_BTN_STYLE_MODAL = "-webkit-appearance:none; appearance:none; margin:0; " +
  "font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.06em; padding:7px 10px; " +
  "border:1.5px solid var(--line); background:var(--panel); color:var(--ink); text-align:center; cursor:pointer";
function wantControlHtml(r, inModal){
  const st = inModal ? WANT_BTN_STYLE_MODAL : WANT_BTN_STYLE;
  if (state.view==='wantlist'){
    return `<button data-act="wantRemove" data-arg="${r.id}" style="${st}">✕ REMOVE FROM WANTLIST</button>`;
  }
  const ctx = window.__twMatchCtx;
  if (!IS_OWN() && ctx){
    if (ctx.viewerHas && ctx.viewerHas.has(r.id)) return '';   // you own this release — no want action
    const wanted = ctx.viewerWants && ctx.viewerWants.has(r.id);
    return `<button data-act="want" data-want="${wanted?'remove':'add'}" data-arg="${r.id}" style="${st}">${wanted?'✕ REMOVE FROM WANTLIST':'＋ ADD TO WANTLIST'}</button>`;
  }
  return '';
}

/* ── Card ──────────────────────────────────────────────────────────────────── */
function card(r){
  const showP = SETTINGS.showPrices;
  // #27: compute badges once — the same list drives the visual badge AND the card's accessible name, so a
  // screen reader announces "ON YOUR WANTLIST" / "YOU OWN THIS" as part of the card rather than as a
  // detached span after it. Badge labels are static strings (no user data), safe to inline in the label.
  const _badges = badgesFor(r, window.__twMatchCtx || null);
  const _badgeAria = _badges.length ? ' (' + _badges.map(b => b.label).join(', ') + ')' : '';
  return `<div class="tw-card" style="min-width:0; background:var(--panel); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow); display:flex; flex-direction:column">
    <div style="position:relative; padding:6px 6px 0">
      <button data-act="open" data-arg="${r.id}" class="tw-cell" tabindex="-1" aria-haspopup="dialog" aria-label="Open ${esc(r.artist)} — ${esc(r.title)}${_badgeAria}" title="Open detail" style="display:block; width:100%; padding:0; border:0; background:transparent">
        <div role="img" aria-label="${esc(r.coverAlt)}" style="width:100%; aspect-ratio:1; background:var(--skel); background-image:${r.coverBg}; background-size:cover; background-position:center">${r.coverPlaceholder}</div>
      </button>
      ${r.isNew?`<span style="position:absolute; top:12px; left:0; background:var(--accent); color:var(--on-accent); font-family:'Archivo',sans-serif; font-size:9px; font-weight:800; letter-spacing:.14em; padding:3px 7px; transform:rotate(-2.5deg)">JUST IN</span>`:''}
      ${badgesHtml(_badges)}
    </div>
    <div style="min-width:0; padding:8px 9px 10px; display:flex; flex-direction:column; gap:5px">
      <button class="tw-artist" data-act="artist" data-arg="${esc(r.artist)}" tabindex="-1" style="text-align:left; padding:0; border:0; background:transparent; font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.08em; color:var(--faint); text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(r.artist)}</button>
      <button class="tw-title" data-act="open" data-arg="${r.id}" tabindex="-1" style="text-align:left; padding:0; border:0; background:transparent; font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:700; line-height:1.02; color:var(--ink); text-wrap:pretty">${esc(r.title)}</button>
      <button data-act="color" data-arg="${esc(r.vinylShort)}" tabindex="-1" style="display:flex; align-items:center; gap:6px; margin-top:1px; padding:0; border:0; background:transparent; text-align:left">
        <span style="width:9px; height:9px; flex:none; border:1.5px solid var(--line); background:${r.swatch}"></span>
        <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(r.vinylShort)}</span>
      </button>
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:6px; border-top:1.5px solid var(--line); padding-top:6px; margin-top:2px">
        <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; line-height:1.35; color:var(--faint); text-transform:uppercase">${esc(r.year)} · ${esc(r.style1)}</span>
        ${IS_OWN()?(showP?`<span style="font-family:'IBM Plex Mono',monospace; font-size:10px; font-weight:700; flex:none; line-height:1.35">${r.priceLabel}</span>`:''):priceCellHtml(r,false)}
      </div>
      ${wantControlHtml(r)}
    </div>
  </div>`;
}

/* ── Surfaces design pass (from the Design Kit v2 app.additions.js) ───────────
   Three pieces. #1 is a live bug fix; #2 and #3 are RESERVED geometry that nothing
   calls until the social waves — kept here so adding them later is a data change,
   not a card redesign. See docs/design-surfaces-spec.md §9.3 (badges) and §9.4 (price). */

/* #1 · THE EMPTY CRATE (S17). records.length === 0 → the crate is empty (this state);
   records.length > 0 && shown === 0 → the filters excluded everything (the existing
   zero-results state). Wired in render() below, before the zero-results branch. */
function emptyCrateHtml(){
  const MONO = "font-family:'IBM Plex Mono',monospace";
  const COND = "font-family:'Barlow Condensed',sans-serif";
  const BODY = 'font-family:Archivo,Helvetica,sans-serif';
  // Wave 1 (v1.4.1): a friend's empty crate must not speak in the owner's voice or offer
  // ADD/RE-SYNC (which are no-ops for a friend). Branch on IS_OWN().
  const own = IS_OWN();
  // #27: the wantlist tab is own-only — give the empty state its own voice instead of the crate's
  // ("ADD RECORDS / RE-SYNC" implied the collection). RE-SYNC now pulls the wantlist too (#26), so it
  // is the right action here. Discogs has no per-release "add to wantlist" landing, so we point at the
  // user's own wantlist page.
  const isWant = own && state.view === 'wantlist';
  const who = (window.TraxWaxOwner && window.TraxWaxOwner.displayName) || 'This collector';
  const eyebrow = isWant ? 'AN EMPTY WANTLIST' : 'AN EMPTY CRATE';
  const heading = isWant ? 'Nothing on the wantlist yet' : 'Nothing on the shelf yet';
  const body = isWant
    ? 'Your Discogs wantlist is empty. Star a few records over on Discogs and re-sync — they’ll show up ' +
      'here, cross-checked against every crate you can see.'
    : own
      ? 'Your Discogs collection came back empty. Add a few records over there and re-sync — ' +
        'they’ll be filed here within the minute.'
      : esc(who) + ' hasn’t filed any records here yet.';
  const actions = isWant
    ? '<div style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center">' +
        '<a href="https://www.discogs.com/wantlist" target="_blank" rel="noopener" class="tw-btn tw-btn-primary tw-btn-lg">' +
          'BUILD YOUR WANTLIST ON DISCOGS</a>' +
        '<button data-act="resync" class="tw-btn tw-btn-secondary tw-btn-lg">RE-SYNC</button>' +
      '</div>'
    : own
      ? '<div style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center">' +
          '<a href="https://www.discogs.com" target="_blank" rel="noopener" class="tw-btn tw-btn-primary tw-btn-lg">' +
            'ADD RECORDS ON DISCOGS</a>' +
          '<button data-act="resync" class="tw-btn tw-btn-secondary tw-btn-lg">RE-SYNC</button>' +
        '</div>'
      : '';
  return '' +
  '<div style="padding:70px 40px 76px; display:flex; flex-direction:column; align-items:center; ' +
    'gap:18px; text-align:center">' +
    '<div aria-hidden="true" style="width:112px; height:112px; border:1.5px solid var(--hair); ' +
      'background:var(--bg); display:flex; align-items:center; justify-content:center">' +
      '<div style="width:74px; height:74px; border-radius:50%; background:var(--bar); ' +
        'display:flex; align-items:center; justify-content:center">' +
        '<div style="width:22px; height:22px; border-radius:50%; background:var(--accent)"></div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex; flex-direction:column; gap:8px; align-items:center">' +
      '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; ' +
        'color:var(--accent)">' + eyebrow + '</span>' +
      '<span class="tw-empty-h" style="' + COND + '; font-size:38px; font-weight:700; ' +
        'line-height:1; color:var(--ink)">' + heading + '</span>' +
      '<span style="' + BODY + '; font-size:13.5px; line-height:1.7; color:var(--muted); ' +
        'max-width:48ch">' + body + '</span>' +
    '</div>' +
    actions +
  '</div>';
}

/* #2 · THE BADGE SLOT (S19) — ▸ RESERVED FOR WAVE 2. Nothing calls these yet.
   Grammar: 'you' accent (true about YOU) · 'both' ink (true about BOTH) · 'else' panel
   (action lives ELSEWHERE). Two badges max; wantlist/you-own are mutually exclusive so the
   cap is safe. Classes ship in styles.css (.tw-badge*). */
const BADGE_CLASS = { you: 'tw-badge-you', both: 'tw-badge-both', else: 'tw-badge-else' };
function badgesHtml(badges){
  if (!badges || !badges.length) return '';
  return badges.slice(0, 2).map((b, i) =>
    '<span class="tw-badge ' + (BADGE_CLASS[b.kind] || BADGE_CLASS.you) + ' tw-badge-' + (i + 1) + '">' +
      esc(b.label) + '</span>').join('');
}
function badgesFor(rec, ctx){
  if (!ctx) return [];
  const out = [];
  if (ctx.viewerWants && ctx.viewerWants.has(rec.id)) out.push({ kind: 'you',  label: 'ON YOUR WANTLIST' });
  else if (ctx.viewerHas && ctx.viewerHas.has(rec.id)) out.push({ kind: 'both', label: 'YOU OWN THIS' });
  if (ctx.forSale && ctx.forSale.has(rec.id))          out.push({ kind: 'else', label: 'FOR SALE' });
  return out;
}

/* #3 · THE PRICE CELL — ▸ RESERVED FOR WAVE 1 (friend crates). live-stats suppresses price
   server-side for records that aren't the viewer's own, so on a friend's crate every price
   is null and the cell would collapse. THE RULE: the cell always renders — own+known → $34,
   own+unknown → em-dash, friend's → SEE ON DISCOGS →. Never a number on a friend's record. */
function priceCellHtml(rec, isOwn){
  const MONO = "font-family:'IBM Plex Mono',monospace";
  if (!isOwn) {
    return '<a href="https://www.discogs.com/release/' + encodeURIComponent(rec.id) + '" ' +
      'target="_blank" rel="noopener" style="' + MONO + '; font-size:9.5px; font-weight:700; ' +
      'letter-spacing:.06em; color:var(--accent); white-space:nowrap">SEE ON DISCOGS →</a>';
  }
  if (rec.price == null) {
    return '<span style="' + MONO + '; font-size:9.5px; letter-spacing:.06em; ' +
      'color:var(--faint)">—</span>';
  }
  return '<span style="' + MONO + '; font-size:11px; font-weight:700; color:var(--accent)">$' +
    Math.round(rec.price) + '</span>';
}

/* ── computeVals: the single source that render() draws from ─────────────────── */
function computeVals(){
  const s=state;
  if(SETTINGS.accent) document.documentElement.style.setProperty('--accent', SETTINGS.accent);
  // Wave 2 B1: THE WANTLIST tab draws ONLY from the wantlist dataset — never fall back to RECORDS here
  // (a null/failed load shows an empty wantlist, not the collection; MAJOR-2). Every other view uses RECORDS.
  const all=(state.view==='wantlist') ? (Array.isArray(WANTLIST_RECORDS) ? WANTLIST_RECORDS : []) : RECORDS;
  const filtered=sorted(all.filter(matches));
  const visible=filtered.map(deco);

  const counts={};
  all.forEach(r=>(r.styles||[]).forEach(g=>{counts[g]=(counts[g]||0)+1;}));
  const topGenres=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]).slice(0,5);

  const priced=all.filter(r=>r.price!=null);
  const total=priced.reduce((n,r)=>n+r.price,0);
  const newCount=all.filter(r=>(r.added||'').slice(0,7)===THIS_MONTH).length;
  const coloredCount=all.filter(r=>isColored(r.vinyl)).length;

  const active=[];
  s.genres.forEach(g=>active.push({kind:'STYLE',value:g}));
  if(s.coloredOnly && s.view!=='wantlist') active.push({kind:'WAX',value:'Colored only'});   // #27: matches() ignores wax on wantlist — don't show an inert chip
  if(s.artist) active.push({kind:'ARTIST',value:s.artist});
  if(s.color && s.view!=='wantlist') active.push({kind:'COLOR',value:s.color});               // #27: ditto for the color facet
  if(s.query) active.push({kind:'SEARCH',value:s.query});

  const groups={};
  filtered.forEach(r=>{const k=(r.added||'').slice(0,7); (groups[k]=groups[k]||[]).push(r);});
  const timeline=Object.keys(groups).sort().reverse().map(k=>{
    const items=groups[k]; const val=items.reduce((n,r)=>n+(r.price||0),0);
    return { label:(MONTHS[Number(k.slice(5,7))-1]||'—')+' '+k.slice(0,4),
      countLabel:items.length+(items.length===1?' RECORD':' RECORDS'),
      valueLabel:valueLabel(val)+(val>0?' of regret':''),
      items:items.map(deco) };
  });

  const maxCount=counts[topGenres[0]]||1;
  const styleBars=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]).slice(0,7)
    .map(g=>({label:g,count:counts[g],width:Math.round((counts[g]/maxCount)*100)+'%'}));

  const priciest=all.slice().filter(r=>r.price!=null).sort((a,b)=>b.price-a.price).slice(0,5).map(deco);

  return { all, filtered, visible, counts, topGenres, total, newCount, coloredCount,
    active, timeline, styleBars, priciest,
    bigStats:[
      {label:'Records', value:all.length.toLocaleString('en-US'), note:'Counted honestly. Twice.', color:'var(--ink)'},
      {label:'Estimated value', value:state.headerValue||valueLabel(total), note:priced.length?'Median of Discogs lows.':'Live Discogs estimate.', color:'var(--accent)'},
      {label:'On colored wax', value:coloredCount+'', note:Math.round((coloredCount/all.length)*100)+'% of the shelf.', color:'var(--ink)'},
      {label:'Added this month', value:newCount+'', note:'A restrained month, relatively.', color:'var(--ink)'},
    ],
  };
}

/* ── render ────────────────────────────────────────────────────────────────── */
function render(){
  const v=computeVals(); const s=state;
  const hasFilters=v.active.length>0;
  const showGrid=(s.view==='crate' || s.view==='wantlist') && v.filtered.length>0;   // Wave 2 B1: the wantlist reuses the card grid
  const showTimeline=s.view==='timeline' && v.filtered.length>0;
  const showStats=s.view==='ledger' && v.filtered.length>0;
  const showEmpty=v.filtered.length===0;

  const genreChips=v.topGenres.map(g=>`<button data-act="genre" data-arg="${esc(g)}" style="font-family:'IBM Plex Mono',monospace; font-size:11px; padding:5px 10px; border:1.5px solid var(--line); ${s.genres.includes(g)?chipOn:chipOff}">${esc(g.toUpperCase())} ${v.counts[g]}</button>`).join('');

  const activeChips=v.active.map(c=>`<button data-act="rm" data-kind="${c.kind}" data-arg="${esc(c.value)}" style="display:flex; align-items:center; gap:7px; font-family:'IBM Plex Mono',monospace; font-size:10.5px; padding:4px 8px; background:var(--accent); color:var(--on-accent); border:0">
      <span style="opacity:.72; letter-spacing:.1em">${c.kind}</span>
      <span style="font-weight:600">${esc(c.value)}</span>
      <span style="opacity:.8">✕</span></button>`).join('');

  const noGenres=s.genres.length===0;

  let content='';
  if(showGrid){
    content=`<div class="tw-grid">${v.visible.map(card).join('')}</div>`;
  } else if(showTimeline){
    content=`<div style="display:flex; flex-direction:column; padding:6px 0 28px">${v.timeline.map(grp=>`
      <div style="display:flex; align-items:flex-start; gap:20px; padding:18px 24px; border-bottom:1px solid var(--hair)">
        <div style="width:150px; flex:none; display:flex; flex-direction:column; gap:3px; padding-top:2px">
          <span style="font-family:'Barlow Condensed',sans-serif; font-size:24px; font-weight:700; line-height:1">${esc(grp.label)}</span>
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.1em; color:var(--muted)">${grp.countLabel}</span>
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--faint)">${grp.valueLabel}</span>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:10px">${grp.items.map(r=>`
          <button data-act="open" data-arg="${r.id}" title="${esc(r.coverAlt)}" style="padding:0; border:1.5px solid var(--line); background:transparent; box-shadow:2px 2px 0 var(--shadow)">
            <div role="img" aria-label="${esc(r.coverAlt)}" style="width:84px; height:84px; background:var(--skel); background-image:${r.coverBg}; background-size:cover; background-position:center">${r.coverPlaceholder}</div>
          </button>`).join('')}</div>
      </div>`).join('')}</div>`;
  } else if(showStats){
    content=`<div style="display:flex; flex-direction:column; gap:0">
      <div class="tw-ledger-stats" style="display:grid; grid-template-columns:repeat(4,1fr); border-bottom:1px solid var(--hair)">
        ${v.bigStats.map(st=>`<div style="padding:20px 22px; border-right:1px solid var(--hair); display:flex; flex-direction:column; gap:6px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">${esc(st.label)}</span>
          <span style="font-family:'Barlow Condensed',sans-serif; font-size:40px; font-weight:700; line-height:1; color:${st.color}">${esc(st.value)}</span>
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--faint); line-height:1.5">${esc(st.note)}</span>
        </div>`).join('')}
      </div>
      <div class="tw-ledger-panels" style="display:grid; grid-template-columns:1fr 1fr; gap:0">
        <div style="padding:22px 24px; border-right:1px solid var(--hair)">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">Most-filed styles</span>
          <div style="display:flex; flex-direction:column; gap:9px; margin-top:14px">${v.styleBars.map(b=>`
            <div style="display:flex; align-items:center; gap:12px">
              <span style="width:150px; flex:none; font-family:'IBM Plex Mono',monospace; font-size:10.5px; text-transform:uppercase; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(b.label)}</span>
              <span style="flex:1; height:12px; background:var(--bar); position:relative"><span style="position:absolute; inset:0 auto 0 0; width:${b.width}; background:var(--accent)"></span></span>
              <span style="width:26px; text-align:right; font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--muted)">${b.count}</span>
            </div>`).join('')}</div>
        </div>
        <div style="padding:22px 24px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">The expensive end</span>
          <div style="display:flex; flex-direction:column; margin-top:14px">${
            v.priciest.length ? v.priciest.map(r=>`
            <button data-act="open" data-arg="${r.id}" style="display:flex; align-items:center; gap:12px; padding:8px 0; border:0; border-bottom:1px solid var(--hair); background:transparent; text-align:left">
              <div role="img" aria-label="${esc(r.coverAlt)}" style="width:38px; height:38px; flex:none; border:1px solid var(--line); background:var(--skel); background-image:${r.coverBg}; background-size:cover; background-position:center">${r.coverPlaceholder}</div>
              <span style="flex:1; min-width:0; display:flex; flex-direction:column; gap:2px">
                <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(r.artist)}</span>
                <span style="font-family:'Barlow Condensed',sans-serif; font-size:17px; font-weight:600; line-height:1.05">${esc(r.title)}</span>
              </span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:12px; font-weight:700">${r.priceLabel}</span>
            </button>`).join('')
            : `<span style="font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--faint); line-height:1.6">Per-record prices return in a future update. Open any record for its live lowest sale.</span>`
          }</div>
        </div>
      </div>
    </div>`;
  } else if(showEmpty){
    // S17: an EMPTY collection (records.length === 0) is a different state from filters
    // that excluded everything. The old code showed "0 RESULTS · CLEAR THE FILTERS" to a
    // brand-new user with no filters set — advice that couldn't help.
    if(v.all.length===0){
      content=emptyCrateHtml();
    } else {
      content=`<div style="display:flex; flex-direction:column; align-items:center; gap:12px; padding:90px 24px 96px; text-align:center">
      <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.18em; color:var(--muted)">0 RESULTS</span>
      <span style="font-family:'Barlow Condensed',sans-serif; font-size:34px; font-weight:700; line-height:1.05">Nothing filed under that.</span>
      <span style="font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:var(--muted); max-width:440px; line-height:1.6">Either the taste is very specific, or that record simply isn't owned. Both are fixable.</span>
      <button data-act="clearAll" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:8px 14px; margin-top:6px; background:var(--accent); color:var(--on-accent); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow)">CLEAR THE FILTERS</button>
    </div>`;
    }
  }

  const html=`
  <div style="position:relative; max-width:1480px; margin:0 auto; background:var(--panel); border:1px solid var(--line); box-shadow:5px 5px 0 rgba(0,0,0,.16)">

    ${!IS_OWN()?`<div class="tw-friend-strip" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 24px; background:#16171a; color:#fff; font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.08em; text-transform:uppercase">
      <span>Viewing ${esc((window.TraxWaxOwner&&(window.TraxWaxOwner.displayName||window.TraxWaxOwner.ownerUsername))||'a friend')}’s crate</span>
      <a href="/app" style="color:#fff; text-decoration:underline; white-space:nowrap">← Back to your crate</a>
    </div>`:''}

    <header class="tw-header" style="position:relative; display:flex; align-items:flex-end; justify-content:space-between; gap:20px; padding:22px 24px 18px; background:var(--accent); border-bottom:3px solid var(--line)">
      <div class="tw-headL" style="display:flex; align-items:flex-end; gap:14px">
        <span style="background:#16171a; color:#fff; font-family:'Anton',sans-serif; font-size:44px; line-height:1; text-transform:uppercase; letter-spacing:.01em; padding:12px 14px 10px; transform:rotate(-1.2deg)">TraxWax</span>
        <span style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:rgba(255,255,255,.92); padding-bottom:6px">${esc(SETTINGS.ownerLine + (IS_OWN() ? ' · filed by ' + FILED_BY_WORD : ''))}</span>
      </div>
      <div class="tw-headR" style="display:flex; align-items:center; gap:10px">
        <div style="display:flex; font-family:'IBM Plex Mono',monospace; font-size:11px; border:1.5px solid #16171a; background:#fff; color:#16171a">
          <span style="padding:6px 10px; border-right:1.5px solid #16171a">${v.all.length.toLocaleString('en-US')} ${s.view==='wantlist'?'ON WANTLIST':'IN CRATE'}</span>
          ${s.view!=='wantlist'?`<span class="tw-hide-mobile" style="padding:6px 10px; border-right:1.5px solid #16171a">${v.coloredCount} COLORED</span>`:''}
          ${(IS_OWN() && s.view!=='wantlist')?`<span style="padding:6px 10px; border-right:1.5px solid #16171a">${esc(s.headerValue || valueLabel(v.total))} EST.</span>`:''}
          ${(!IS_OWN() && window.__twMatchCounts && window.__twMatchCounts.you_want_they_have != null)?`<span class="tw-hide-mobile" style="padding:6px 10px; border-right:1.5px solid #16171a">YOU WANT ${window.__twMatchCounts.you_want_they_have} THEY HAVE</span>`:''}
          ${(!IS_OWN() && window.__twMatchCounts && window.__twMatchCounts.they_want_you_have != null)?`<span class="tw-hide-mobile" style="padding:6px 10px; border-right:1.5px solid #16171a">THEY WANT ${window.__twMatchCounts.they_want_you_have} YOU HAVE</span>`:''}
          <span class="tw-hide-mobile" style="padding:6px 10px; background:#16171a; color:#fff; font-weight:700">+${v.newCount} THIS MONTH</span>
        </div>
        <button data-act="theme" title="Toggle theme" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:7px 11px; background:#fff; color:#16171a; border:1.5px solid #16171a">${s.theme==='dark'?'LIGHTS ON':'LIGHTS OUT'}</button>
      </div>
      ${DB_MODE() && IS_OWN()?(()=>{const o=window.TraxWaxOwner||{};const av=o.avatarUrl||'';
        const icon='<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.2" r="4.2" fill="#16171a"/><path d="M3.5 21c1.4-4.4 4.6-6.6 8.5-6.6s7.1 2.2 8.5 6.6z" fill="#16171a"/></svg>';
        // Floats ABOVE the white controls bar in the true upper-right corner (Lane,
        // 2026-08-29) — absolutely positioned like the tape decorations, which are
        // pointer-events:none and cannot block clicks. The header is position:relative.
        return `<button data-act="account" class="tw-avatar" title="${esc(o.displayName||'Your account')}" style="position:absolute; top:14px; right:24px; width:36px; height:36px; padding:0; border:1.5px solid #16171a; border-radius:50%; overflow:hidden; background:#fff; cursor:pointer; display:inline-flex; align-items:center; justify-content:center">${av?`<img src="${esc(av)}" alt="Account" style="width:100%; height:100%; object-fit:cover; display:block">`:icon}</button>`;})():''}
      <span style="position:absolute; top:-8px; left:52px; width:92px; height:20px; background:rgba(255,255,255,.32); border-left:1px dashed rgba(0,0,0,.2); border-right:1px dashed rgba(0,0,0,.2); transform:rotate(-3deg); pointer-events:none"></span>
      <span style="position:absolute; top:-8px; right:58px; width:92px; height:20px; background:rgba(255,255,255,.32); border-left:1px dashed rgba(0,0,0,.2); border-right:1px dashed rgba(0,0,0,.2); transform:rotate(2.5deg); pointer-events:none"></span>
    </header>

    <div class="tw-filterbar" style="display:flex; align-items:center; gap:8px; padding:12px 24px; background:var(--bar); border-bottom:2px solid var(--line); flex-wrap:wrap">
      <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.14em; color:var(--muted); margin-right:4px">FILED UNDER</span>
      <button data-act="clearGenres" style="font-family:'IBM Plex Mono',monospace; font-size:11px; padding:5px 10px; border:1.5px solid var(--line); ${noGenres?chipOn.replace('var(--accent)','var(--ink)'):chipOff}">ALL ${v.all.length.toLocaleString('en-US')}</button>
      ${genreChips}
      <span style="margin-left:auto; display:flex; align-items:center; gap:8px">
        <input id="tw-search" value="${esc(s.query)}" placeholder="SEARCH THE CRATE ⌕" style="font-family:'IBM Plex Mono',monospace; font-size:11px; padding:6px 12px; width:210px; background:var(--panel); color:var(--ink); border:1.5px solid var(--line); border-radius:0" />
        <button data-act="colored" style="font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:700; padding:6px 10px; border:1.5px solid var(--line); ${s.coloredOnly?chipOn:chipOff}; box-shadow:2px 2px 0 var(--shadow)">COLORED WAX ●</button>
      </span>
    </div>

    <div class="tw-tabsrow" style="display:flex; align-items:stretch; border-bottom:1px solid var(--hair); background:var(--panel)">
      ${tab('crate','THE CRATE')}${tab('timeline','THE TIMELINE')}${tab('ledger','THE LEDGER')}${(IS_OWN() && DB_MODE())?tab('wantlist','THE WANTLIST'):''}
      <div class="tw-sortwrap" style="margin-left:auto; display:flex; align-items:center; gap:14px; padding:0 20px">
        <span role="status" aria-live="polite" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--muted)">${v.filtered.length} of ${v.all.length} shown</span>
        <div style="display:flex; align-items:center; border:1.5px solid var(--line)">
          ${sortBtn('added','ADDED')}${sortBtn('artist','ARTIST')}${sortBtn('year','YEAR')}${DB_MODE()?'':sortBtn('price','PRICE')}
          <button data-act="dir" title="Reverse order" style="font-family:'IBM Plex Mono',monospace; font-size:11px; padding:5px 9px; border:0; background:var(--panel); color:var(--ink)">${s.dir===-1?'↓':'↑'}</button>
        </div>
      </div>
    </div>

    ${hasFilters?`<div style="display:flex; align-items:center; gap:8px; padding:10px 24px; background:var(--panel); border-bottom:1px solid var(--hair); flex-wrap:wrap">
      <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.14em; color:var(--muted)">SHOWING</span>
      ${activeChips}
      <button data-act="clearAll" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.08em; padding:4px 8px; background:transparent; border:1px solid var(--line); color:var(--ink)">CLEAR ALL</button>
    </div>`:''}

    ${content}

    <span style="position:absolute; bottom:-9px; left:44px; width:88px; height:20px; background:var(--tape); border-left:1px dashed rgba(0,0,0,.18); border-right:1px dashed rgba(0,0,0,.18); transform:rotate(2deg); pointer-events:none"></span>
    <span style="position:absolute; bottom:-9px; right:44px; width:88px; height:20px; background:var(--tape); border-left:1px dashed rgba(0,0,0,.18); border-right:1px dashed rgba(0,0,0,.18); transform:rotate(-2.5deg); pointer-events:none"></span>
  </div>

  <footer class="tw-footer" style="max-width:1480px; margin:20px auto 0; padding:14px 24px; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px 24px; font-family:'IBM Plex Mono',monospace; font-size:10px; line-height:1.7; letter-spacing:.04em; color:var(--faint)">
    <a href="https://www.discogs.com/" target="_blank" rel="noopener" style="color:var(--accent); text-transform:uppercase; letter-spacing:.09em; white-space:nowrap">Data provided by Discogs ↗</a>
    <span class="tw-footer-note" style="flex:1; min-width:240px; text-align:right">This application uses Discogs' API but is not affiliated with, sponsored or endorsed by Discogs. "Discogs" is a trademark of Zink Media, LLC.</span>
  </footer>
  ${modalHtml()}`;

  const app=document.getElementById('app');
  // Issue #5 + remediation-audit F1/F3: activeElement is the truth, not a flag. If the
  // user is in the search box when ANY render fires — the debounce timer, an async stats
  // render, anything — put them back exactly where they were (the old value-reset trick
  // always jumped the caret to the end, breaking mid-query edits). If they've moved on
  // (clicked a card, opened the modal), no refocus: a stale timer must never steal focus,
  // least of all behind an open dialog.
  const _ae=document.activeElement;
  const _wasSearch=!!(_ae && _ae.id==='tw-search');
  const _caret=_wasSearch ? _ae.selectionStart : null;
  // W0.4: if focus is inside the open modal, remember WHICH control (by act+arg, or href for
  // links) so _syncModalFocus can put it back after the innerHTML swap wipes activeElement to
  // <body>. Without this, every async stats/tracklist re-render yanked focus back to ✕.
  _modalFocusKey = null;
  if (state.detailId && _ae && _ae.closest && _ae.closest('.tw-modal-ov')) {
    _modalFocusKey = { act:_ae.getAttribute('data-act'), arg:_ae.getAttribute('data-arg'), href:_ae.getAttribute('href') };
  }
  app.innerHTML=html;
  if(_wasSearch && !state.detailId){
    const si=document.getElementById('tw-search');
    if(si){
      si.focus();
      const p = _caret==null ? si.value.length : Math.min(_caret, si.value.length);
      si.setSelectionRange(p, p);
    }
  }
  // A11y (W0.4): re-establish roving tabindex, then modal focus. Roving first so the modal's
  // focus-restore target (the invoking cover cell) is tabbable when we hand focus back to it.
  _syncGridRoving();
  _syncModalFocus();
}

/* ── Detail modal ──────────────────────────────────────────────────────────── */
function modalHtml(){
  const rec=recordById(state.detailId);
  if(!rec) return '';
  const d=deco(rec);
  const rel=rec._rel;  // tracklist/country/videos from the baked release file (or live fallback), via _loadRelease
  const country=(rel && rel.country)?rel.country:'US';
  const subLine=(rec.year||'—')+' · '+(rec.label||'Unknown label')+' · '+country;
  // DB mode: live stats live under rec._stats (see _loadStats -- MAJOR-2); baked mode
  // keeps reading the collection.json fields. One selector, both worlds.
  const st = DB_MODE() ? (rec._stats || {}) : rec;
  const priceLabel = st.price!=null ? money(st.price) : '—';   // lowest sale
  const styleChips=(rec.styles||[]).map(g=>`<button data-act="detailGenre" data-arg="${esc(g)}" style="font-family:'IBM Plex Mono',monospace; font-size:10px; padding:4px 8px; border:1.5px solid var(--line); background:var(--panel); color:var(--ink)">${esc(g)}</button>`).join('');
  const err = rec._relErr;
  const trackRow = t => `<div style="display:flex; align-items:baseline; gap:12px; padding:5px 0; border-bottom:1px solid var(--hair)">
      <span style="width:26px; flex:none; font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--faint)">${esc(t.pos)}</span>
      <span style="flex:1; min-width:0; font-family:'Archivo',sans-serif; font-size:13px">${esc(t.title)}</span>
      <span style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--muted)">${esc(t.dur)}</span></div>`;
  const skelRow = w => `<div style="display:flex; align-items:center; gap:12px; padding:6px 0; border-bottom:1px solid var(--hair)">
      <span style="width:20px; height:9px; flex:none; background:var(--skel); animation:twshimmer 1.4s ease-in-out infinite"></span>
      <span style="flex:1; height:9px; max-width:${w}; background:var(--skel); animation:twshimmer 1.4s ease-in-out infinite"></span></div>`;
  const trNote = "font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--faint); line-height:1.7; padding:6px 0";
  let tracksHtml;
  if (rel && rel.tracks && rel.tracks.length) tracksHtml = rel.tracks.map(trackRow).join('');
  else if (rel)  tracksHtml = `<div style="${trNote}">No tracklist on Discogs for this pressing.</div>`;
  else if (err)  tracksHtml = `<div style="${trNote}">Couldn't reach Discogs. <button data-act="retryDetail" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; padding:3px 9px; margin-left:4px; border:1.5px solid var(--line); background:var(--panel); color:var(--ink)">RETRY</button></div>`;
  else           tracksHtml = ['86%','72%','90%','64%','80%','58%','88%','70%'].map(skelRow).join('');
  const rating = st.crating!=null ? (Number(st.crating).toFixed(1)+' ('+(st.crcount||0)+')') : '—';   // community rating
  const haveWant = (st.have!=null && st.want!=null) ? (st.have.toLocaleString()+' / '+st.want.toLocaleString()) : '—';

  return `<div data-act="closeDetail" class="tw-modal-ov" style="position:fixed; inset:0; background:rgba(10,10,12,.62); display:flex; align-items:flex-start; justify-content:center; padding:60px 20px; overflow:auto; z-index:50">
    <div data-act="stop" role="dialog" aria-modal="true" aria-labelledby="tw-modal-title" style="position:relative; width:840px; max-width:100%; background:var(--panel); border:1.5px solid var(--line); box-shadow:8px 8px 0 rgba(0,0,0,.4)">
      <div class="tw-modal-head" style="display:flex; gap:22px; padding:22px 24px 20px; border-bottom:2px solid var(--line)">
        <div role="img" aria-label="${esc(d.coverAlt)}" class="tw-modal-cover" style="width:190px; height:190px; flex:none; border:1.5px solid var(--line); background:var(--skel); background-image:${d.coverBg}; background-size:cover; background-position:center">${d.coverPlaceholder}</div>
        <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:8px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--faint)">${esc(rec.artist)}</span>
          <span id="tw-modal-title" style="font-family:'Barlow Condensed',sans-serif; font-size:38px; font-weight:700; line-height:1; text-wrap:pretty">${esc(rec.title)}</span>
          <span style="font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--muted)">${esc(subLine)}</span>
          <div style="display:flex; align-items:center; gap:8px; margin-top:2px">
            <span style="display:flex; align-items:center; gap:7px; border:1.5px solid var(--line); padding:4px 9px">
              <span style="width:10px; height:10px; border:1.5px solid var(--line); background:${d.swatch}"></span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:10.5px">${esc(rec.vinyl||'Black')}</span>
            </span>
            <span style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--faint)">ADDED ${esc(rec.added)}</span>
          </div>
          <div style="display:flex; gap:0; margin-top:auto; border:1.5px solid var(--line)">
            <span style="flex:1; padding:7px 10px; border-right:1.5px solid var(--line); display:flex; flex-direction:column; gap:1px">
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9px; letter-spacing:.12em; color:var(--faint)">RATING</span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:13px; font-weight:600">${esc(rating)}</span>
            </span>
            <span style="flex:1; padding:7px 10px; border-right:1.5px solid var(--line); display:flex; flex-direction:column; gap:1px">
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9px; letter-spacing:.12em; color:var(--faint)">HAVE / WANT</span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:13px; font-weight:600">${esc(haveWant)}</span>
            </span>
            <span style="flex:1; padding:7px 10px; display:flex; flex-direction:column; gap:1px; background:var(--accent); color:var(--on-accent)">
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9px; letter-spacing:.12em; opacity:.82">LOWEST SALE</span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:13px; font-weight:700">${IS_OWN()?priceLabel:`<a href="https://www.discogs.com/release/${encodeURIComponent(rec.id)}" target="_blank" rel="noopener" style="color:var(--on-accent); text-decoration:underline">SEE ON DISCOGS →</a>`}</span>
            </span>
          </div>
        </div>
        <button data-act="closeDetail" title="Close" style="position:absolute; top:12px; right:12px; width:28px; height:28px; border:1.5px solid var(--line); background:var(--panel); font-family:'IBM Plex Mono',monospace; font-size:12px; line-height:1">✕</button>
      </div>
      <div class="tw-modal-body" style="display:grid; grid-template-columns:1fr 240px; gap:0">
        <div style="padding:18px 24px 22px; border-right:1px solid var(--hair)">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">Tracklist</span>
          <div style="display:flex; flex-direction:column; margin-top:10px">${tracksHtml}</div>
        </div>
        <div style="padding:18px 22px 22px; display:flex; flex-direction:column; gap:14px">
          <div style="display:flex; flex-direction:column; gap:6px">
            <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">Filed under</span>
            <div style="display:flex; flex-wrap:wrap; gap:6px">${styleChips}</div>
          </div>
          <div style="display:flex; flex-direction:column; gap:6px">
            <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">Label</span>
            <span style="font-family:'Archivo',sans-serif; font-size:13px">${esc(rec.label||'—')}</span>
          </div>
          <div style="display:flex; flex-direction:column; gap:7px; margin-top:auto">
            ${wantControlHtml(rec, true)}
            <a href="https://www.discogs.com/release/${rec.id}" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.06em; padding:7px 10px; border:1.5px solid var(--line); color:var(--ink); text-align:center">VIEW ON DISCOGS ↗</a>
            <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(rec.artist+' '+rec.title)}" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.06em; padding:7px 10px; border:1.5px solid var(--line); background:var(--accent); color:var(--on-accent); text-align:center">▶ LISTEN</a>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ── A11y controllers (W0.4) ──────────────────────────────────────────────────
   All three run after every render() so they survive the wholesale #app rebuild. */

/* Roving grid: exactly one crate cover cell carries tabindex=0 (the grid is a single tab
   stop); the rest are -1. Never focuses anything — that would steal focus on the debounced
   search render. Focus only moves on an explicit arrow key, in onKeydown. */
function _syncGridRoving(){
  if (state.view!=='crate' && state.view!=='wantlist') return;   // Wave 2 B1: the wantlist grid is keyboard-navigable too
  const cells = Array.from(document.querySelectorAll('.tw-grid .tw-cell'));
  if (!cells.length) return;
  let idx = cells.findIndex(c=>Number(c.dataset.arg)===_gridFocusId);
  if (idx<0) idx=0;
  // The cover cells are the roving set (one tab stop, arrow-navigated). The ACTIVE card's
  // secondary controls (artist / title / color filter) become Tab-reachable so keyboard users
  // can dive into that card's actions (Tab-into-cell pattern); every other card keeps them out
  // of the tab order. Without this the artist/color filters would be keyboard-inaccessible.
  cells.forEach((c,i)=>{
    const active = (i===idx);
    c.tabIndex = active?0:-1;
    const cardEl = c.closest('.tw-card');
    if (cardEl) cardEl.querySelectorAll('.tw-artist, .tw-title, [data-act="color"]')
      .forEach(b=>{ b.tabIndex = active?0:-1; });
  });
  _gridFocusId = Number(cells[idx].dataset.arg);
}

/* Modal focus: on open, pull focus into the dialog (once — only when it isn't already
   inside, so async re-renders don't yank it back); on close, return focus to the invoking
   cover cell. Tab-cycling lives in onKeydown. */
function _syncModalFocus(){
  const ov = document.querySelector('.tw-modal-ov');
  if (state.detailId && ov){
    const panel = ov.querySelector('[data-act="stop"]');
    if (!panel || panel.contains(document.activeElement)) return;
    // Restore the control the user was on before the rebuild (MAJOR fix); on a fresh open
    // _modalFocusKey is null, so we fall to the first focusable (the ✕ close button).
    let target = null;
    const k = _modalFocusKey;
    if (k){
      const list = Array.from(panel.querySelectorAll(FOCUSABLE_SEL));
      target = list.find(n =>
        (k.act && n.getAttribute('data-act')===k.act && (n.getAttribute('data-arg')||null)===(k.arg||null)) ||
        (!k.act && k.href && n.getAttribute('href')===k.href)) || null;
    }
    if (!target) target = panel.querySelector(FOCUSABLE_SEL);
    (target||panel).focus();
  } else if (!state.detailId && _modalInvokerId!=null){
    // On close, return focus to the invoking card; if it was filtered out of the DOM while the
    // modal was open (e.g. an in-modal genre chip), fall back to the grid, then search (MINOR fix).
    let back = document.querySelector('[data-act="open"][data-arg="'+_modalInvokerId+'"]');
    if (!back) back = document.querySelector('.tw-grid .tw-cell') || document.getElementById('tw-search');
    if (back) back.focus();
    _modalInvokerId=null;
  }
}

/* Column count for up/down grid navigation: how many cells share the first row's offsetTop,
   with a computed-style fallback. (In a no-layout env like jsdom every offsetTop is 0, so
   this collapses to a single row; left/right stay correct regardless.) */
function _gridColumns(cells){
  if (cells.length<2) return 1;
  const top0 = cells[0].offsetTop;
  let n=0; for (const c of cells){ if (c.offsetTop===top0) n++; else break; }
  if (n>0 && n<cells.length) return n;
  const grid = cells[0].parentElement;
  const tpl = grid && getComputedStyle(grid).gridTemplateColumns;
  if (tpl && tpl!=='none'){ const cnt = tpl.trim().split(/\s+/).length; if (cnt>0) return cnt; }
  return n>0 ? n : 1;
}

function onKeydown(e){
  // Modal open: Escape closes; Tab cycles within the dialog.
  if (state.detailId){
    if (e.key==='Escape'){ state.detailId=null; render(); return; }
    if (e.key==='Tab'){
      const ov = document.querySelector('.tw-modal-ov'); if(!ov) return;
      const panel = ov.querySelector('[data-act="stop"]'); if(!panel) return;
      const list = Array.from(panel.querySelectorAll(FOCUSABLE_SEL));
      if(!list.length) return;
      const i = list.indexOf(document.activeElement);
      if (e.shiftKey && i<=0){ e.preventDefault(); list[list.length-1].focus(); }
      else if (!e.shiftKey && i===list.length-1){ e.preventDefault(); list[0].focus(); }
    }
    return;
  }
  // Roving grid (crate view only), when focus is on a grid cover cell.
  if ((state.view==='crate' || state.view==='wantlist') && GRID_KEYS.has(e.key)){
    const ae = document.activeElement;
    if (!ae || !ae.classList || !ae.classList.contains('tw-cell')) return;
    const cells = Array.from(document.querySelectorAll('.tw-grid .tw-cell'));
    const i = cells.indexOf(ae); if(i<0) return;
    const cols = _gridColumns(cells);
    let j=i;
    switch(e.key){
      case 'ArrowRight': j=Math.min(i+1, cells.length-1); break;
      case 'ArrowLeft':  j=Math.max(i-1, 0); break;
      case 'ArrowDown':  j=Math.min(i+cols, cells.length-1); break;
      case 'ArrowUp':    j=Math.max(i-cols, 0); break;
      case 'Home':       j=0; break;
      case 'End':        j=cells.length-1; break;
    }
    e.preventDefault();   // swallow arrows/Home/End so the page doesn't also scroll
    if (j!==i){ _gridFocusId=Number(cells[j].dataset.arg); _syncGridRoving(); cells[j].focus(); }  // _syncGridRoving moves the tabbable secondaries to the new card too
  }
}

async function openDetail(id){
  state.detailId=id;
  _modalInvokerId=id;   // focus returns to this card's cover cell when the modal closes (W0.4)
  _gridFocusId=id;      // keep the roving grid's active cell in step with what was opened
  const rec=recordById(id);
  if(rec){
    const c=_relCache[id];
    if(c && (Date.now()-(c.ts||0))<REL_TTL_MS){ rec._rel=c.d; rec._relErr=false; }   // instant from cache
    else { rec._rel=null; rec._relErr=false; }                                        // show loading, then fetch
  }
  render();
  if(rec) _loadStats(rec);
  if(rec && !rec._rel) await _loadRelease(rec);
}
async function _loadRelease(rec){
  let d = null;
  if (DB_MODE() && window.TraxWaxReleaseData) {
    try { d = await window.TraxWaxReleaseData(rec.id); } catch(e) { d = null; }
  }
  if(!d) d = await _fetchReleaseFile(rec.id);   // baked static file (immutable, CDN-cached)
  if(!d) d = await _fetchReleaseLive(rec);      // last resort: the live proxy
  if(d){ rec._rel=d; rec._relErr=false; _relCache[rec.id]={ts:Date.now(), d}; _saveRelCache(); }
  else { rec._relErr=true; }
  if(state.detailId===rec.id) render();
}
async function _loadStats(rec){
  if(!DB_MODE() || rec._stats) return;
  try {
    const s = await window.TraxWaxStats(rec.id);
    if(s && !s.error){
      // Stored under _stats, NEVER onto rec.price/crating/etc. Round-1 audit MAJOR-2:
      // mutating rec.price leaks live prices back into computeVals() -- after a few modal
      // opens the Ledger's "expensive end" would present whichever records the user
      // happened to open as the collection's priciest, and timeline months would show
      // partial sums. The degraded surfaces must stay degraded, not half-alive.
      rec._stats = { price: s.price, crating: s.crating, crcount: s.crcount,
                     have: s.have, want: s.want };
      if(state.detailId===rec.id) render();
    }
  } catch(e) { /* stats are decoration; the modal stands without them */ }
}

/* Analytics: fire-and-forget custom event to Umami if the tracker loaded. Guarded so it's a
   no-op when analytics is absent (blocked, DNT, or no website-id yet). Send ACTIONS and COUNTS
   only — never record identities, prices, or any Restricted Discogs data. */
function track(name, data){ try { if (window.umami) window.umami.track(name, data); } catch(e){} }

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
      // TraxWaxMatchCounts RETURNS null on a crate_match error (doesn't throw) — guard so a transient
      // RPC failure can't blank the MATCHES stat bar; keep the prior counts until a good refetch.
      try { const mc = await window.TraxWaxMatchCounts(); if (mc) window.__twMatchCounts = mc; } catch(e){}
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

/* ── Events (delegation) ───────────────────────────────────────────────────── */
function onClick(e){
  const t=e.target.closest('[data-act]'); if(!t) return;
  // Remediation-audit F2: a pending debounced search render is superseded by whatever
  // this click renders (state.query is already current); letting the stale timer fire
  // would rebuild the app a second time for nothing.
  clearTimeout(_searchDebounce);
  const act=t.dataset.act, arg=t.dataset.arg;
  switch(act){
    case 'theme': setTheme(state.theme==='dark'?'light':'dark'); render(); break;
    case 'resync': _resync(); break;
    case 'account': if(window.TraxWaxAccount) window.TraxWaxAccount(); break;
    case 'view':
      state.view=arg;
      // Wave 2: reflect the active tab in the URL hash so a reload lands back here (crate = no hash).
      // replaceState, not pushState — flipping tabs shouldn't pile up browser-history entries.
      try { history.replaceState(null, '', location.pathname + location.search + (arg==='crate' ? '' : '#'+arg)); } catch(e){}
      track('view_change', { view: arg });
      // Wave 2 B1: lazy-load THE WANTLIST dataset on first switch. WANTLIST_RECORDS: null=not loaded,
      // []=loaded (guards re-entry while the async load is in flight; [] shows an empty grid, not RECORDS).
      if (arg==='wantlist' && WANTLIST_RECORDS===null && window.TraxWaxWantlistData) {
        WANTLIST_RECORDS=[];
        window.TraxWaxWantlistData().then((rows)=>{ WANTLIST_RECORDS=rows; render(); })
          .catch((e)=>{ console.warn('wantlist load failed', e); WANTLIST_RECORDS=null; });
      }
      render();
      break;
    case 'sort': state.sort=arg; render(); break;
    case 'dir': state.dir*=-1; render(); break;
    case 'genre': track('filter_used', { kind: 'genre' }); toggleGenre(arg); render(); break;
    case 'clearGenres': state.genres=[]; render(); break;
    case 'colored': track('filter_used', { kind: 'colored' }); state.coloredOnly=!state.coloredOnly; render(); break;
    case 'artist': state.artist=arg; state.detailId=null; render(); break;
    case 'color': track('filter_used', { kind: 'color' }); state.color=arg; state.detailId=null; render(); break;
    case 'open': track('record_opened', { source: state.view }); openDetail(Number(arg)); break;
    case 'retryDetail': { const r=recordById(state.detailId); if(r){ r._relErr=false; render(); _loadRelease(r); } break; }
    case 'detailGenre': state.detailId=null; state.genres=[arg]; render(); break;
    case 'rm': removeFacet(t.dataset.kind, arg); render(); break;
    case 'clearAll': state.genres=[]; state.coloredOnly=false; state.artist=null; state.color=null; state.query=''; render(); break;
    case 'closeDetail': state.detailId=null; render(); break;
    case 'want': toggleWant(Number(arg), t.dataset.want==='remove'?'remove':'add'); break;
    case 'wantRemove': removeWant(Number(arg)); break;
    case 'stop': e.stopPropagation(); break;
  }
}
function removeFacet(kind, val){
  if(kind==='STYLE') toggleGenre(val);
  else if(kind==='WAX') state.coloredOnly=false;
  else if(kind==='ARTIST') state.artist=null;
  else if(kind==='COLOR') state.color=null;
  else if(kind==='SEARCH') state.query='';
}
function onInput(e){
  if(e.target.id==='tw-search'){
    // Issue #5 (audit #18): debounce — every keystroke rebuilt the entire app via
    // innerHTML (up to 1,861 cards). The input keeps its live DOM value while typing;
    // state.query tracks each keystroke so the render 150ms after the last one matches.
    // Focus + caret restoration live in render() itself, keyed off activeElement.
    state.query = e.target.value;
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(render, 150);
  }
}

/* ── Re-sync (DB mode) ─────────────────────────────────────────────────────── */
async function _resync(){
  if(state._resyncing || !DB_MODE() || !window.TraxWaxRefresh) return;
  state._resyncing = true; render();
  try {
    const ok = await window.TraxWaxRefresh();   // runs the import pipeline with its own UI
    if(!ok){
      // runImport rendered "Import hit a wall" with a resume link -- leave it on screen.
      // An unconditional render() here would paint the crate over the failure silently
      // (round-1 audit minor 4).
      state._resyncing = false;
      return;
    }
    RECORDS = await window.TraxWaxData();
  } catch(e) {
    // Rare seam: runImport succeeded but the row refetch threw -- the crate below renders
    // pre-sync data with a stale tooltip. Self-heals on reload or a second RE-SYNC
    // (round-2 audit m-2); not worth more machinery.
    console.error(e);
  }
  state._resyncing = false;
  render();
}

/* ── Boot ──────────────────────────────────────────────────────────────────── */
/* DB mode = boot.js installed the providers before importing this file. Without them
   (main until the merge; local dev) everything below falls back to the baked paths. */
const DB_MODE = () => !!window.TraxWaxData;

async function bootCrate(){
  WANTLIST_RECORDS=null;   // Wave 2 B1: fresh dataset per boot (defense-in-depth: own↔friend/user changes never bleed the wrong dataset)
  // Wave 2: restore the active tab from the URL hash (#wantlist etc.) so a reload lands on the tab you were
  // on, not always THE CRATE. Only tabs valid for THIS crate are honored (wantlist is own+DB only); anything
  // else falls back to 'crate'. Set before the render below so the right grid paints on the first frame.
  const _validTabs = new Set(['crate','timeline','ledger']);
  if (IS_OWN() && DB_MODE()) _validTabs.add('wantlist');
  let _bootView = 'crate';
  try { const h = (location.hash||'').replace(/^#/,''); if (_validTabs.has(h)) _bootView = h; } catch(e){}
  state.view = _bootView;
  // Normalize the URL to the actual tab — strips a stale/invalid hash (e.g. #wantlist carried onto a
  // friend crate, which falls back to 'crate') so what's in the address bar always matches what's shown.
  try { history.replaceState(null, '', location.pathname + location.search + (_bootView==='crate'?'':'#'+_bootView)); } catch(e){}
  initTheme();
  if (window.TraxWaxOwner && window.TraxWaxOwner.ownerLine) {
    SETTINGS.ownerLine = window.TraxWaxOwner.ownerLine;
  }
  if (DB_MODE()) SETTINGS.showPrices = false;   // per-record prices are Restricted; header+modal only
  document.getElementById('app').innerHTML=`<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--muted)">Loading the crate…</div>`;
  try{
    if (DB_MODE()) {
      RECORDS = await window.TraxWaxData();
      // Wave 2 B1: reset first (defensive) so a stale friend ctx never renders badges on the own crate;
      // then, on a FRIEND crate only, load the viewer's own wants/haves (badges) + the match counts (stat).
      window.__twMatchCtx = null; window.__twMatchCounts = null;
      if (!IS_OWN() && window.TraxWaxMatchCtx) {
        try { window.__twMatchCtx = await window.TraxWaxMatchCtx(); } catch (e) { window.__twMatchCtx = null; }
        try { window.__twMatchCounts = await window.TraxWaxMatchCounts(); } catch (e) { window.__twMatchCounts = null; }
      }
      // Wave 2: a hash-restored WANTLIST tab needs its dataset loaded on a direct reload (the case 'view'
      // lazy-load never ran). Mirror that load; render() below paints the briefly-empty grid, then this
      // fills it. Own+DB only — guaranteed by _validTabs above.
      if (state.view==='wantlist' && WANTLIST_RECORDS===null && window.TraxWaxWantlistData) {
        WANTLIST_RECORDS=[];
        window.TraxWaxWantlistData().then((rows)=>{ WANTLIST_RECORDS=rows; render(); })
          .catch((e)=>{ console.warn('wantlist load failed', e); WANTLIST_RECORDS=null; });
      }
    } else {
      // ABSOLUTE path, deliberately. A relative './collection.json' resolves against the
      // page URL, so on /app/<username> it became /app/collection.json -- served as the
      // app-shell HTML by the /app/* rewrite, and JSON.parse dies.
      const res=await fetch('/collection.json'); RECORDS=await res.json();
    }
  }catch(e){
    console.error(e);
    document.getElementById('app').innerHTML=`<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; color:var(--accent)">Couldn't load the collection. <button id="tw-reload" style="font-family:inherit; font-size:inherit; padding:4px 10px; margin-left:6px; border:1.5px solid var(--line); background:var(--panel); color:var(--ink); cursor:pointer">RETRY</button></div>`;
    // Attached DIRECTLY to the button. Round-1 audit MAJOR-3: a document-level listener
    // with {once:true} is consumed by the first click ANYWHERE, leaving RETRY dead.
    const rb = document.getElementById('tw-reload');
    if (rb) rb.addEventListener('click', () => location.reload());
    return;
  }
  // #18: bind the document/window listeners at most once per page life. onClick/onInput/onKeydown
  // are stable module-level refs, so the DOM already de-dupes a repeat addEventListener — a same-
  // page re-boot (only reachable if the Clerk auth-state listener ever re-enters render()) does NOT
  // actually double-fire today. This guard makes the once-only intent explicit and future-proofs
  // against a later switch to inline/arrow listeners, which would silently defeat that de-duping.
  if (!window.__twListenersBound) {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    window.addEventListener('keydown', onKeydown);   // W0.4: Escape + modal Tab-cycle + roving grid arrows
    window.__twListenersBound = true;
  }
  render();
  if (DB_MODE()) {
    window.TraxWaxStats().then(v=>{ if(v && v.value){ state.headerValue=v.value; render(); } });
  }
  // Baked/local-dev mode: the header EST. is the baked total (valueLabel(v.total)) —
  // the old live /api/value fetch died with its endpoint (issue #6, cold-audit #24).
}
/* The crate no longer self-starts. public/boot.js resolves auth and ownership first, then
   dynamically imports this file and calls bootCrate(). See docs/phase-1-plan.md Stage A. */
window.TraxWaxBootCrate = bootCrate;
