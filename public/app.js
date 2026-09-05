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

/* Wave 5a: Collection DNA card variant. localStorage-only (Design D2) — does not follow the user across
   devices; a profiles column is the upgrade path. Unknown/missing → 'A'. */
const DNA_NAMES = { A:'A · THE DECADES', B:'B · THE STAT WALL', C:'C · THE SPLIT' };
function dnaVariant(){ try{ const v=localStorage.getItem('tw_dna_variant'); return (v==='B'||v==='C')?v:'A'; }catch(e){ return 'A'; } }
function setDnaVariant(v){ try{ localStorage.setItem('tw_dna_variant', v); }catch(e){} }

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

// #43: friend-crate section visibility. Own crate → both true. Friend → the get_crate_owner flags.
const CAN_VIEW_CRATE    = () => IS_OWN() || !window.TraxWaxViewer || window.TraxWaxViewer.canViewCrate === true;
const CAN_VIEW_WANTLIST = () => IS_OWN() || !window.TraxWaxViewer || window.TraxWaxViewer.canViewWantlist === true;
// Which section a view belongs to for locking: crate/timeline/ledger ride the crate; wantlist is its own.
const _viewLocked = (view) => (view === 'wantlist') ? !CAN_VIEW_WANTLIST() : !CAN_VIEW_CRATE();

// #28: the viewer's own reading preference (default 'exact'). In 'any' mode a match also counts when the
// records share a master_id (the album), not just the exact release_id.
const MATCH_ANY = () => window.__twMatchMode === 'any';

// #28: does the VIEWER own this record — exactly, or (any mode) a different pressing of the same master?
// Self-sources ctx so the two want-control call sites can share it. Used to suppress the inline + WANT.
function _viewerOwns(r){
  const ctx = window.__twMatchCtx; if (!ctx || !ctx.viewerHas) return false;
  return ctx.viewerHas.has(r.id) || (MATCH_ANY() && r.master_id && ctx.viewerHasMasters && ctx.viewerHasMasters.has(r.master_id));
}

// #43 (Decision 5): match counts derived from the SETS, so a count can never disagree with the filter it links
// to. A `null` count means the direction is PRIVATE — driven ONLY by the visibility flag, never by a not-yet-
// loaded set (the sets are awaited in bootCrate before first render), so a shared direction always yields a
// real count (0+). #28: each direction counts a record on exact OR (any-mode) master match — iterating records
// (not intersecting sets) so a record matched both ways counts exactly once.
function _matchCounts(){
  const ctx = window.__twMatchCtx;
  const any = MATCH_ANY();
  const out = { youWant: null, theyWant: null };   // null ⇔ the direction is PRIVATE
  if (CAN_VIEW_CRATE()){
    let n = 0;
    if (ctx && ctx.viewerWants) for (const r of (RECORDS||[]))
      if (ctx.viewerWants.has(r.id) || (any && r.master_id && ctx.viewerWantsMasters && ctx.viewerWantsMasters.has(r.master_id))) n++;
    out.youWant = n;
  }
  if (CAN_VIEW_WANTLIST()){
    let n = 0; const ow = window.__twOwnerWants;   // #28: array of {id, master} — owner's wantlist entries
    if (ctx && ctx.viewerHas && Array.isArray(ow)) for (const e of ow)
      if (ctx.viewerHas.has(e.id) || (any && e.master && ctx.viewerHasMasters && ctx.viewerHasMasters.has(e.master))) n++;
    out.theyWant = n;
  }
  return out;
}

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
let _wlLoading = false;   // #51: true while TraxWaxWantlistData() is in flight. The load paths flip WANTLIST_RECORDS to [] to arm the reload-guard BEFORE the rows return, so [] alone can't distinguish "loading" from "loaded-empty" — this does.
let _removedThisSession = false;   // wantlist-remove redesign: set the moment you remove anything this session (optimistically, not on Discogs commit), so an emptied wantlist shows the "cleared" empty state instead of the "genuinely empty" one. Resets on reload.
// Wave 2 B1: resolve a record by id from whichever dataset the current view renders — the WANTLIST tab
// draws from WANTLIST_RECORDS, so the detail modal must look there too (else a wantlist card is a dead click).
function recordById(id){
  const src=(state.view==='wantlist' && Array.isArray(WANTLIST_RECORDS)) ? WANTLIST_RECORDS : RECORDS;
  return src.find(r=>r.id===id);
}
const state = {
  theme:'light', view:'crate', query:'', genres:[], coloredOnly:false, forSaleOnly:false,   // Wave 4: FOR SALE facet
  stylesOpen:false, styleFind:'',   // Wave 5c: FILED UNDER tray — open state + find query, both session-only (not URL)
  artist:null, color:null, sort:'added', dir:-1, detailId:null, headerValue:null,
  matchFilter:null,   // #47: null | 'youWant' (crate ∩ viewerWants) | 'theyWant' (wantlist ∩ viewerHas)
  dnaOpen:false, dnaPick:null,   // Wave 5a: picker modal open state + in-modal selection (committed to localStorage only on export)
};
let _searchDebounce = null;   // issue #5: pending debounced render, if any
let _stylesOpenedByUser = false;   // Wave 5c: focus the tray's FIND box only after a click/keypress open (spec D3), never on load
let _stylesFocusTrigger = false;   // Wave 5c: after closing the tray, return focus to the trigger
let _findDebounce = 0;             // Wave 5c: debounce the FIND-a-style re-render

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
// #47: friend-crate match sentence pieces (spec §3). `n` is a match count from _matchCounts() (set-derived, #43).
function _matchAlbums(n){ return n === 1 ? 'ONE ALBUM' : (n === 0 ? 'NO ALBUMS' : n + ' ALBUMS'); }
// Wave 4 Stage 2 (D): prose number form — spell 1–9, numerals 10+. Callout-only (the #47 match sentence keeps
// its established numeral form; do not retrofit _matchAlbums).
function _num(n){ const w=['zero','one','two','three','four','five','six','seven','eight','nine']; return (n>=0 && n<10) ? w[n] : String(n); }
function _matchPart(n, tail, act){   // tail: 'YOU WANT' | 'THEY WANT'
  const label = _matchAlbums(n) + ' ' + tail;
  const link = "color:#fff; text-decoration:underline; text-underline-offset:3px; text-decoration-color:rgba(255,255,255,.5)";
  return n > 0
    ? `<a href="#" data-act="${act}" style="${link}">${label}</a>`
    : `<span style="color:#fff">${label}</span>`;   // zero side: white, no link
}
function matches(r){
  const s=state;
  // 0030: the wantlist now carries the real vinyl variant, so the colored/color facets apply on it too
  // (they were skipped on the wantlist while every row was vinyl:'').
  if(s.coloredOnly && !isColored(r.vinyl)) return false;
  // Wave 4: FOR SALE facet — query the __twInventory Map directly (O(1)); skip on wantlist (for-sale is about
  // the collection, not the wantlist rows), matching the coloredOnly guard.
  if(s.forSaleOnly && window.__twInventory && s.view!=='wantlist' && !window.__twInventory.has(r.id)) return false;   // __twInventory-first: a null inventory (friend crate) makes the clause inert, never zeroing the crate
  if(s.artist && r.artist!==s.artist) return false;
  if(s.color && shortVinyl(r.vinyl)!==s.color) return false;   // 0030: color-swatch filter now works on the wantlist too
  if(s.genres.length && !s.genres.some(g=>(r.styles||[]).includes(g))) return false;   // #33: chips are ranked/counted from styles, so filter on styles too — count and result now agree (and guard non-array styles)
  if(s.query){
    const q=s.query.toLowerCase();
    const hay=(r.artist+' '+r.title+' '+r.label+' '+(r.styles||[]).join(' ')+' '+r.vinyl).toLowerCase();
    if(!hay.includes(q)) return false;
  }
  // #47: match filter (friend crate only) — the two match-sentence links narrow to the overlap sets.
  // #28: the filter MUST mirror _matchCounts exactly (exact OR any-pressing master), or the grid the link
  // opens would show fewer records than the count/badges promised.
  if(s.matchFilter){
    const ctx=window.__twMatchCtx;
    if(!ctx) return false;   // sets not loaded yet → show nothing rather than the whole shelf under a match chip
    const any=MATCH_ANY();
    if(s.matchFilter==='youWant'){
      if(!((ctx.viewerWants && ctx.viewerWants.has(r.id)) || (any && r.master_id && ctx.viewerWantsMasters && ctx.viewerWantsMasters.has(r.master_id)))) return false;
    } else if(s.matchFilter==='theyWant'){
      if(!((ctx.viewerHas && ctx.viewerHas.has(r.id)) || (any && r.master_id && ctx.viewerHasMasters && ctx.viewerHasMasters.has(r.master_id)))) return false;
    }
  }
  return true;
}
function sorted(list){
  const s=state;
  const key=({ added:r=>r.added, artist:r=>r.artist.toLowerCase(), year:r=>String(r.year),
    // Audit #19: numeric, not padded-string -- the string form sorted $12.50 below $9.99.
    price:r=>r.price==null?-1:r.price }[s.sort]) || (r=>r.added);   // Wave 5a: defensive — an unknown sort key never throws (parse also whitelists)
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
    style1:(r.styles||[])[0]||(r.genres||[])[0]||'—',   // guard: a provider omitting styles must not throw + blank the whole grid
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

// #43: lock glyph for a private section's tab + panel badge (kit §Lock glyph).
const LOCK_SVG = '<svg width="10" height="12" viewBox="0 0 24 24" aria-hidden="true" style="margin-right:6px; vertical-align:-1px"><rect x="4" y="10" width="16" height="11" rx="1.5" fill="currentColor"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.6"></path></svg>';
function tab(id,label){
  const on = state.view===id;
  if (_viewLocked(id)){   // #43: greyed + lock glyph, still clickable → the locked panel (kit Decision 1, 1b)
    return `<button data-act="view" data-arg="${id}" aria-label="${esc(label)} (private)" title="Private" style="display:inline-flex; align-items:center; font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.12em; padding:11px 18px; background:var(--lockbg); border:0; border-right:1px solid var(--hair); border-bottom:3px solid ${on?'var(--lock)':'transparent'}; color:var(--lock); cursor:pointer">${LOCK_SVG}${label}</button>`;
  }
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
  if (IS_OWN() && state.view==='wantlist'){   // own wantlist: the destructive ✕REMOVE (delete FROM your own wantlist)
    return `<button data-act="wantRemove" data-arg="${r.id}" style="${st}">✕ REMOVE FROM WANTLIST</button>`;
  }
  // #47 follow-up: the !IS_OWN branch now serves the friend CRATE and the friend WANTLIST alike — the
  // VIEWER's OWN +WANT/✕REMOVE toggle (data-act="want" → friendAdd/friendRemove; never edits the friend's
  // list). Owned (a "they want, you have" match on the wantlist) → no control.
  const ctx = window.__twMatchCtx;
  if (!IS_OWN() && ctx){
    if (ctx.viewerHas && ctx.viewerHas.has(r.id)) return '';   // you own this release — no want action
    const wanted = ctx.viewerWants && ctx.viewerWants.has(r.id);
    return `<button data-act="want" data-want="${wanted?'remove':'add'}" data-arg="${r.id}" style="${st}">${wanted?'✕ REMOVE FROM WANTLIST':'＋ ADD TO WANTLIST'}</button>`;
  }
  return '';
}

/* The meta row's right-hand cell (friend-want redesign). Own crate: price (unchanged; hidden in DB mode,
   Restricted). Friend's crate: the +WANT ⇄ ✕REMOVE toggle keyed on viewerWants (the same Set that drives
   the ON YOUR WANTLIST cover strip via badgesFor). THE WANTLIST tab: the ✕REMOVE control. The Discogs link
   is retired from the card face — it lives on the detail modal now (VIEW ON DISCOGS ↗). */
function metaCellHtml(r){
  if (state.view==='wantlist'){
    if (IS_OWN())   // own wantlist: the destructive ✕REMOVE (delete FROM your own wantlist)
      return `<button data-act="wantRemove" data-arg="${r.id}" title="Remove from wantlist" class="tw-wl-remove">✕ REMOVE</button>`;
    // #47 follow-up: a friend's wantlist offers the VIEWER's OWN +WANT/✕REMOVE toggle (data-act="want" →
    // friendAdd/friendRemove; never touches the friend's list). Owned (a "they want, you have" match) → no
    // control. #28: _viewerOwns also covers any-pressing ("you own a pressing" → no inline want).
    // Close-audit fix: EXACT want first (✕ REMOVE, matches the badge), THEN own-suppression, else + WANT.
    const ctx = window.__twMatchCtx;
    if (ctx && ctx.viewerWants && ctx.viewerWants.has(r.id))
      return `<button data-act="want" data-want="remove" data-arg="${r.id}" title="Remove from wantlist" class="tw-wl-remove">✕ REMOVE</button>`;
    if (_viewerOwns(r)) return '';
    return `<button data-act="want" data-want="add" data-arg="${r.id}" title="Add to wantlist" class="tw-want-add">+ WANT</button>`;
  }
  if (IS_OWN())
    return SETTINGS.showPrices
      ? `<span style="font-family:'IBM Plex Mono',monospace; font-size:10px; font-weight:700; flex:none; line-height:1.35">${r.priceLabel}</span>`
      : '';
  const ctx = window.__twMatchCtx;
  const wanted = ctx && ctx.viewerWants && ctx.viewerWants.has(r.id);
  // #28 (close-audit fix): EXACT want wins first — a record you want-exactly shows ✕ REMOVE, matching its
  // "ON YOUR WANTLIST" badge (the prior order suppressed it via _viewerOwns when you also owned a pressing).
  // Then a record you own (exact OR, any-mode, a pressing) hides the inline + WANT (kit §1.4). Else + WANT.
  if (wanted)   // State B — wanted: the wantlist ✕ REMOVE control, verbatim (ink, underline, hover accent)
    return `<button data-act="want" data-want="remove" data-arg="${r.id}" title="Remove from wantlist" class="tw-wl-remove">✕ REMOVE</button>`;
  if (_viewerOwns(r)) return '';
  return `<button data-act="want" data-want="add" data-arg="${r.id}" title="Add to wantlist" class="tw-want-add">+ WANT</button>`;   // State A — not wanted/owned
}

/* ── Card ──────────────────────────────────────────────────────────────────── */
function card(r){
  // #27: compute badges once — the same list drives the visual badge AND the card's accessible name, so a
  // screen reader announces "ON YOUR WANTLIST" / "YOU OWN THIS" as part of the card rather than as a
  // detached span after it. Badge labels are static strings (no user data), safe to inline in the label.
  // Wave 4: own crate has no match ctx (that's friend-only), so synthesize a minimal ctx from __twInventory
  // (a Map<release_id,listing_id>) to drive the FOR SALE badge. On a friend crate __twInventory is null →
  // falls back to the match ctx, unchanged from before.
  const _ctx = window.__twMatchCtx || (window.__twInventory ? { forSale: window.__twInventory } : null);
  const _badges = badgesFor(r, _ctx);
  const _badgeAria = _badges.length ? ' (' + _badges.map(b => b.label).join(', ') + ')' : '';
  return `<div class="tw-card" style="min-width:0; background:var(--panel); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow); display:flex; flex-direction:column">
    <div style="position:relative; padding:6px 6px 0">
      <button data-act="open" data-arg="${r.id}" class="tw-cell" tabindex="-1" aria-haspopup="dialog" aria-label="Open ${esc(r.artist)} — ${esc(r.title)}${_badgeAria}" title="Open detail" style="display:block; width:100%; padding:0; border:0; background:transparent">
        <div role="img" aria-label="${esc(r.coverAlt)}" style="width:100%; aspect-ratio:1; background:var(--skel); background-image:${r.coverBg}; background-size:cover; background-position:center">${r.coverPlaceholder}</div>
      </button>
      ${(r.isNew && state.view!=='wantlist')?`<span style="position:absolute; top:12px; left:0; background:var(--accent); color:var(--on-accent); font-family:'Archivo',sans-serif; font-size:9px; font-weight:800; letter-spacing:.14em; padding:3px 7px; transform:rotate(-2.5deg)">JUST IN</span>`:''}
      ${badgesHtml(_badges, r.title)}
    </div>
    <div style="min-width:0; flex:1; padding:8px 9px 10px; display:flex; flex-direction:column; gap:5px">
      <button class="tw-artist" data-act="artist" data-arg="${esc(r.artist)}" tabindex="-1" style="text-align:left; padding:0; border:0; background:transparent; font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.08em; color:var(--faint); text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(r.artist)}</button>
      <button class="tw-title" data-act="open" data-arg="${r.id}" tabindex="-1" style="text-align:left; padding:0; border:0; background:transparent; font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:700; line-height:1.02; color:var(--ink); text-wrap:pretty">${esc(r.title)}</button>
      <button data-act="color" data-arg="${esc(r.vinylShort)}" tabindex="-1" style="display:flex; align-items:center; gap:6px; margin-top:1px; padding:0; border:0; background:transparent; text-align:left">
        <span style="width:9px; height:9px; flex:none; border:1.5px solid var(--line); background:${r.swatch}"></span>
        <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(r.vinylShort)}</span>
      </button>
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:6px; border-top:1.5px solid var(--line); padding-top:6px; margin-top:auto">
        <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; line-height:1.35; color:var(--faint); text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0">${esc(r.year)}<span class="tw-card-style"> · ${esc(r.style1)}</span></span>
        ${metaCellHtml(r)}
      </div>
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
  // #27 + wantlist-remove redesign: the wantlist tab is own-only and has TWO empty states — one for a
  // wantlist you just CLEARED this session (BACK TO THE CRATE), one for a GENUINELY empty wantlist (build
  // it on Discogs). _removedThisSession (set the moment you remove anything this session) picks between them; it resets on
  // reload, so after a reload an empty wantlist reads as genuinely empty. Crate/friend copy is unchanged.
  const isWant = own && state.view === 'wantlist';
  const friendWant = !own && state.view === 'wantlist';   // #43: a friend's SHARED wantlist, genuinely empty (private → lockedPanelHtml, not here)
  const wantCleared = isWant && _removedThisSession;
  const who = (window.TraxWaxOwner && window.TraxWaxOwner.displayName) || 'This collector';
  const eyebrow = friendWant ? 'THEIR WANTLIST · 0' : isWant ? 'WANTLIST · 0' : 'AN EMPTY CRATE';
  const heading = wantCleared ? 'The wantlist is clear.'
    : friendWant ? esc(who) + ' isn’t hunting anything.'
    : isWant ? 'Nothing on the wantlist yet'
    : 'Nothing on the shelf yet';
  const body = wantCleared
    ? 'That’s everything you were chasing, filed or let go. Your crate’s still right where you left it.'
    : friendWant
      ? 'Nothing on their wantlist right now. The crate’s where the records are.'
    : isWant
      ? 'Star the records you’re chasing over on Discogs and re-sync — they’ll show up here, cross-checked ' +
        'against every crate you can see.'
      : own
        ? 'Your Discogs collection came back empty. Add a few records over there and re-sync — ' +
          'they’ll be filed here within the minute.'
        : esc(who) + ' hasn’t filed any records here yet.';
  const actions = wantCleared
    ? '<div style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center">' +
        '<button data-act="view" data-arg="crate" class="tw-btn tw-btn-primary tw-btn-lg">BACK TO THE CRATE</button>' +
      '</div>'
    : friendWant
      ? '<div style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center">' +
          '<button data-act="view" data-arg="crate" class="tw-btn tw-btn-primary tw-btn-lg">BACK TO THE CRATE →</button>' +
        '</div>'
    : isWant
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

/* #43 (kit Decision 1/3-B): the inline "private" panel a locked tab lands on. `section` = 'crate' | 'wantlist'.
   Third-person, lock-badged, NO Add CTA. Reuses the empty-state layout shell + tokens. */
function lockedPanelHtml(section){
  const MONO = "font-family:'IBM Plex Mono',monospace";
  const COND = "font-family:'Barlow Condensed',sans-serif";
  const BODY = 'font-family:Archivo,Helvetica,sans-serif';
  const o = window.TraxWaxOwner || {};
  const who = esc(o.displayName || o.ownerUsername || 'This collector');
  const lockBadge = '<div aria-hidden="true" style="width:44px; height:44px; border:1.5px solid var(--hair); display:flex; align-items:center; justify-content:center; color:var(--lock)"><svg width="15" height="18" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="1.5" fill="currentColor"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.6"></path></svg></div>';
  let eyebrow, headline, bodyHtml, cta;
  if (section === 'crate'){
    eyebrow = 'THE CRATE · PRIVATE';
    headline = who + ' keeps their crate closed.';
    bodyHtml = 'Their wantlist is open, though — <a href="#" data-act="view" data-arg="wantlist" style="color:var(--accent); text-decoration:underline; text-underline-offset:3px">browse their wants here →</a>';
    cta = '';   // the CTA link is inline in the body
  } else {
    eyebrow = 'THE WANTLIST · PRIVATE';
    headline = who + '’s wantlist is private.';
    bodyHtml = 'They’re keeping their hunt to themselves. The crate’s still open.';
    cta = '<div style="display:flex; gap:12px; flex-wrap:wrap; justify-content:center"><button data-act="view" data-arg="crate" class="tw-btn tw-btn-secondary tw-btn-lg">BACK TO THE CRATE →</button></div>';
  }
  return '<div style="padding:70px 40px 76px; display:flex; flex-direction:column; align-items:center; gap:18px; text-align:center">' +
    lockBadge +
    '<div style="display:flex; flex-direction:column; gap:8px; align-items:center">' +
      '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; color:var(--lock)">' + eyebrow + '</span>' +
      '<span class="tw-empty-h" style="' + COND + '; font-size:38px; font-weight:700; line-height:1; color:var(--ink)">' + headline + '</span>' +
      '<span style="' + BODY + '; font-size:13.5px; line-height:1.7; color:var(--muted); max-width:48ch">' + bodyHtml + '</span>' +
    '</div>' + cta +
  '</div>';
}

// 2A: the shared-taste overlap records for a friend's LEDGER (exact mode; #28 adds any-pressing variants later).
//  (a) THEIR crate ∩ YOUR wants  → 'you'  → ON YOUR WANTLIST (accent)  [from RECORDS + viewerWants]
//  (b) THEIR wantlist ∩ YOUR haves → 'both' → YOU OWN THIS   (ink)     [from WANTLIST_RECORDS + viewerHas]
// (b) needs the friend's wantlist DISPLAY rows; the ledger triggers that load (case 'view'/bootCrate). Until
// they arrive (b) is empty — but IN COMMON's COUNT is complete regardless (it uses __twOwnerWants, awaited at
// boot, and is mode-aware via _matchCounts).
// #28: exact matches keep the solid 'you'/'both' kinds; any-pressing-only matches get the outlined variants.
function _overlapRecords(){
  const ctx = window.__twMatchCtx; if (!ctx) return [];
  const any = MATCH_ANY(); const out = [];
  for (const r of (RECORDS||[])){
    if (ctx.viewerWants && ctx.viewerWants.has(r.id)) out.push({ rec:r, kind:'you' });
    else if (any && r.master_id && ctx.viewerWantsMasters && ctx.viewerWantsMasters.has(r.master_id)) out.push({ rec:r, kind:'you-outline' });
  }
  if (Array.isArray(WANTLIST_RECORDS)) for (const r of WANTLIST_RECORDS){
    if (ctx.viewerHas && ctx.viewerHas.has(r.id)) out.push({ rec:r, kind:'both' });
    else if (any && r.master_id && ctx.viewerHasMasters && ctx.viewerHasMasters.has(r.master_id)) out.push({ rec:r, kind:'both-outline' });
  }
  return out;
}
/* 2A: the friend LEDGER's second panel — the records you both care about. #28: outlined variants for
   any-pressing-only overlaps (panel-fill + a colored rule, mirroring the card badge outline idiom). */
function overlapPanelHtml(){
  const rows = _overlapRecords();
  const _b = 'font-family:\'IBM Plex Mono\',monospace; font-size:9px; font-weight:800; letter-spacing:.1em; padding:3px 6px;';
  const badge = (kind) => ({
    both:          '<span style="' + _b + ' background:var(--ink); color:var(--bg)">YOU OWN THIS</span>',
    'both-outline':'<span style="' + _b + ' background:var(--panel); color:var(--ink); border:1.5px solid var(--ink)">YOU OWN A PRESSING</span>',
    you:           '<span style="' + _b + ' background:var(--accent); color:var(--on-accent)">ON YOUR WANTLIST</span>',
    'you-outline': '<span style="' + _b + ' background:var(--panel); color:var(--accent); border:1.5px solid var(--accent)">A PRESSING YOU WANT</span>',
  }[kind]);
  const list = rows.length ? rows.map(({rec,kind})=>{ const r=deco(rec); return `
            <button data-act="open" data-arg="${r.id}" style="display:flex; align-items:center; gap:12px; padding:8px 0; border:0; border-bottom:1px solid var(--hair); background:transparent; text-align:left; width:100%">
              <div role="img" aria-label="${esc(r.coverAlt)}" style="width:38px; height:38px; flex:none; border:1px solid var(--line); background:var(--skel); background-image:${r.coverBg}; background-size:cover; background-position:center">${r.coverPlaceholder}</div>
              <span style="flex:1; min-width:0; display:flex; flex-direction:column; gap:2px">
                <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(r.artist)}</span>
                <span style="font-family:'Barlow Condensed',sans-serif; font-size:17px; font-weight:600; line-height:1.05">${esc(r.title)}</span>
              </span>
              ${badge(kind)}
            </button>`; }).join('')
    : `<span style="font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--faint); line-height:1.6">No shared records yet.</span>`;
  return `<div style="padding:22px 24px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">Where you overlap</span>
          <div style="display:flex; flex-direction:column; margin-top:14px">${list}</div>
        </div>`;
}

/* #2 · THE BADGE SLOT (S19) — ▸ RESERVED FOR WAVE 2. Nothing calls these yet.
   Grammar: 'you' accent (true about YOU) · 'both' ink (true about BOTH) · 'else' panel
   (action lives ELSEWHERE). Two badges max; wantlist/you-own are mutually exclusive so the
   cap is safe. Classes ship in styles.css (.tw-badge*). */
const BADGE_CLASS = { you: 'tw-badge-you', both: 'tw-badge-both', else: 'tw-badge-else',
  'you-outline': 'tw-badge-you-outline', 'both-outline': 'tw-badge-both-outline' };   // #28: any-pressing variants
// Wave 4: the FOR SALE badge is a real outbound link to the listing (there is no price — the link IS the
// price). Own crate reads listing_id from __twInventory; a friend map arrives in Stage 2. null → no href.
function forSaleHref(id){
  const inv = window.__twInventory;
  const lid = inv && inv.get(id);
  return lid ? ('https://www.discogs.com/sell/item/' + lid) : null;
}
function badgesHtml(badges, title){
  if (!badges || !badges.length) return '';
  return badges.slice(0, 2).map((b, i) => {
    const cls = 'tw-badge ' + (BADGE_CLASS[b.kind] || BADGE_CLASS.you) + ' tw-badge-' + (i + 1);
    // FOR SALE (kind 'else' with an href) renders as a link — a click on it has no [data-act] ancestor, so the
    // card's delegated open-handler early-returns and the modal does NOT open; the link just navigates.
    if (b.kind === 'else' && b.href)
      return '<a href="' + esc(b.href) + '" target="_blank" rel="noopener" class="' + cls + '" ' +
        'style="text-decoration:none" aria-label="' + esc((title || '') + ' — for sale on Discogs') + '">' +
        esc(b.label) + '</a>';
    return '<span class="' + cls + '">' + esc(b.label) + '</span>';
  }).join('');
}
// #28: exact-first — an exact release match wins the solid badge; else (any mode) a master-only match gets
// the outlined variant. In exact mode the two `any &&` branches are dead, so this reduces to the prior logic.
function badgesFor(rec, ctx){
  if (!ctx) return [];
  const any = MATCH_ANY(); const m = rec.master_id;
  const out = [];
  if (ctx.viewerWants && ctx.viewerWants.has(rec.id))                           out.push({ kind: 'you',          label: 'ON YOUR WANTLIST' });
  else if (any && m && ctx.viewerWantsMasters && ctx.viewerWantsMasters.has(m)) out.push({ kind: 'you-outline',  label: 'A PRESSING YOU WANT' });
  else if (ctx.viewerHas && ctx.viewerHas.has(rec.id))                          out.push({ kind: 'both',         label: 'YOU OWN THIS' });
  else if (any && m && ctx.viewerHasMasters && ctx.viewerHasMasters.has(m))     out.push({ kind: 'both-outline', label: 'YOU OWN A PRESSING' });
  if (ctx.forSale && ctx.forSale.has(rec.id))                                   out.push({ kind: 'else',         label: 'FOR SALE ↗', href: forSaleHref(rec.id) });
  return out;
}

/* #3 · THE PRICE/META CELL — retired into metaCellHtml (friend-want redesign). The friend-crate
   SEE ON DISCOGS → link is gone from the card face (it lives on the detail modal now); the own-crate
   price rule moved into metaCellHtml above. */

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
  const allStyles=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);   // Wave 5c: every style, count desc — the FILED UNDER tray's full list

  const priced=all.filter(r=>r.price!=null);
  const total=priced.reduce((n,r)=>n+r.price,0);
  const newCount=all.filter(r=>(r.added||'').slice(0,7)===THIS_MONTH).length;
  const coloredCount=all.filter(r=>isColored(r.vinyl)).length;

  const active=[];
  s.genres.forEach(g=>active.push({kind:'STYLE',value:g}));
  if(s.coloredOnly) active.push({kind:'WAX',value:'Colored only'});   // 0030: colored facet now active on the wantlist too
  if(s.forSaleOnly && s.view!=='wantlist') active.push({kind:'FORSALE',label:'STATUS',value:'For sale'});   // Wave 4: 'STATUS' display label (align with WAX/STYLE); kind stays FORSALE for removeFacet
  if(s.artist) active.push({kind:'ARTIST',value:s.artist});
  if(s.color) active.push({kind:'COLOR',value:s.color});               // 0030: color facet now active on the wantlist too
  if(s.query) active.push({kind:'SEARCH',value:s.query});
  if(s.matchFilter==='youWant') active.push({kind:'MATCH',value:'YOU WANT · THEY HAVE'});
  else if(s.matchFilter==='theyWant') active.push({kind:'MATCH',value:'THEY WANT · YOU HAVE'});

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

  // Wave 5a: BY DECADE ledger panel — the same effective year the DNA card uses (master/original-release
  // year, pressing year as fallback), over the whole crate. >1900 guards junk/0 years.
  const _yrs=all.map(r=>Number(r.releaseYear ?? r.year)).filter(y=>y>1900);
  const _dec={}; _yrs.forEach(y=>{ const d=Math.floor(y/10)*10; _dec[d]=(_dec[d]||0)+1; });
  const decades=Object.keys(_dec).map(Number).sort((a,b)=>a-b).map(d=>({decade:d, label:String(d).slice(2)+'s', count:_dec[d]}));
  const peakDecade=decades.slice().sort((a,b)=>b.count-a.count)[0]||null;
  const _sortedYrs=_yrs.slice().sort((a,b)=>a-b);
  const decadeStats={
    peak: peakDecade,
    peakPct: (peakDecade && all.length) ? Math.round(peakDecade.count/all.length*100) : 0,
    minYear: _yrs.length?Math.min(..._yrs):null,
    maxYear: _yrs.length?Math.max(..._yrs):null,
    medianYear: _sortedYrs.length?_sortedYrs[Math.floor((_sortedYrs.length-1)/2)]:null,
    maxCount: decades.length?Math.max(...decades.map(d=>d.count)):0,
  };

  // Wave 5a: ledger left-panel strip — most-filed artist CREDIT + label over the whole crate. Discogs joins
  // a multi-artist release into one "A, B" credit string, which we count as-is: we deliberately do NOT split
  // on ", " because comma-bearing names ("Earth, Wind & Fire") would shatter — so this counts credits, not
  // strictly individual artists (a solo/collab split under-counts, acceptable for a personal crate where solo
  // credits dominate). 'Various' excluded from artist (compilation marker). Aggregate CC0, per collection row.
  const _artC={}, _labC={};
  all.forEach(r=>{ const a=(r.artist||'').trim(); if(a && a!=='Various') _artC[a]=(_artC[a]||0)+1;
                   const l=(r.label||'').trim(); if(l) _labC[l]=(_labC[l]||0)+1; });
  const _topA=Object.keys(_artC).sort((a,b)=>_artC[b]-_artC[a])[0]||null;
  const _topL=Object.keys(_labC).sort((a,b)=>_labC[b]-_labC[a])[0]||null;
  const topArtist=_topA?{name:_topA, count:_artC[_topA]}:null;
  const topLabel=_topL?{name:_topL, count:_labC[_topL]}:null;

  return { all, filtered, visible, counts, topGenres, allStyles, total, newCount, coloredCount,
    active, timeline, styleBars, topArtist, topLabel, decades, decadeStats,
    bigStats: IS_OWN() ? (()=>{ const _fs=window.__twInventory?all.filter(r=>window.__twInventory.has(r.id)).length:0; return [   // crate∩listed — agrees with the FOR SALE facet count
      {label:'Records', value:all.length.toLocaleString('en-US'), note:'Counted honestly. Twice.', color:'var(--ink)'},
      {label:'Estimated value', value:state.headerValue||valueLabel(total), note:priced.length?'Median of Discogs lows.':'Live Discogs estimate.', color:'var(--accent)'},
      {label:'On colored wax', value:coloredCount+'', note:Math.round((coloredCount/all.length)*100)+'% of the shelf.', color:'var(--ink)'},
      {label:'Added this month', value:newCount+'', note:'A restrained month, relatively.', color:'var(--ink)'},
      // Wave 4 (F2): only when you actually have listings — hidden at 0. Count + a manage link, never a value.
      ...(_fs>0 ? [{label:'Listed for sale', value:_fs.toLocaleString('en-US'), note:'Managed on Discogs.', color:'var(--ink)', manage:true}] : []),
    ]; })() : (()=>{ const _mc=_matchCounts(); const _ic=(_mc.youWant||0)+(_mc.theyWant||0); return [
      {label:'Records', value:all.length.toLocaleString('en-US'), note:'In their crate.', color:'var(--ink)'},
      {label:'In common', value:_ic.toLocaleString('en-US'), note:'Where your shelves meet.', color:'var(--accent)'},
      {label:'On colored wax', value:coloredCount+'', note:Math.round((coloredCount/all.length)*100)+'% of their shelf.', color:'var(--ink)'},
      {label:'Added this month', value:newCount+'', note:'Their latest finds.', color:'var(--ink)'},
    ]; })(),
  };
}

/* ── renderModal: the detail modal renders into its own body-level container (#tw-modal-root, a sibling of
   #app like the toast/snackbar), so opening or updating it never rebuilds the card grid (#44), and #app can
   be made inert beside it (#37). render() calls this at its end; the six modal-only actions call it directly. */
function renderModal(){
  let root = document.getElementById('tw-modal-root');
  if (!root){ root = document.createElement('div'); root.id = 'tw-modal-root'; document.body.appendChild(root); }
  // Capture focus inside the modal BEFORE replacing it, so _syncModalFocus can restore the same control.
  const ae = document.activeElement;
  _modalFocusKey = null;
  if (state.detailId && ae && ae.closest && ae.closest('.tw-modal-ov')) {
    _modalFocusKey = { act: ae.getAttribute('data-act'), arg: ae.getAttribute('data-arg'), href: ae.getAttribute('href') };
  }
  root.innerHTML = modalHtml();   // '' when state.detailId is null (or the record isn't in the active dataset)
  // #37: while a modal is ACTUALLY open, the shell is inert + hidden from assistive tech; the modal (beside
  // #app) and the body-level toast/snackbar stay interactive. Pass-1 fix: gate on the modal HAVING rendered,
  // not on state.detailId alone — a truthy detailId whose record is absent yields '' here, and inert-ing the
  // shell behind an empty modal-root would brick the app with nothing to close.
  const _modalOpen = !!(state.detailId && root.innerHTML);
  const app = document.getElementById('app');
  if (app){
    if (_modalOpen){ app.inert = true; app.setAttribute('aria-hidden', 'true'); }
    else { app.inert = false; app.removeAttribute('aria-hidden'); }
  }
  // Pass-1 fix: the standalone modal paths (open/close/Escape/loaders) must also re-point the grid's roving
  // tabindex — pre-refactor every close ran render()→_syncGridRoving(). Keep the proven roving-then-modal
  // focus order. (render() now delegates BOTH to this call, so a full render still ends the same way.)
  _syncGridRoving();
  _syncModalFocus();
}

/* ── render ────────────────────────────────────────────────────────────────── */
/* ── Wave 5a: shareable filtered-view URLs ───────────────────────────────────
   The filter/sort state (not just the tab) rides the query string, so a copied or
   bookmarked link reopens the same filtered view. The TAB keeps its established home
   in the #hash; this code ONLY ever rewrites location.search, never the hash. Only
   non-default values are emitted, so an unfiltered crate stays a clean …/app/<user>. */
const SORT_KEYS=['added','artist','year','price'];   // whitelist — an unknown sort key would throw in sorted()
const FILTER_PARAM_KEYS=['g','wax','color','artist','q','sort','dir','forsale','match'];
function _knownFilterParams(){   // the filter keys derived FROM state (used for the address bar + the clean share URL)
  const s=state, p=new URLSearchParams();
  s.genres.forEach(g=>p.append('g',g));   // repeat param (not comma-join) — a style name may itself contain a comma
  if(s.coloredOnly) p.set('wax','1');
  if(s.color) p.set('color',s.color);
  if(s.artist) p.set('artist',s.artist);
  if(s.query) p.set('q',s.query);
  if(s.sort!=='added') p.set('sort',s.sort);      // 'added' is the default
  if(s.dir===1) p.set('dir','asc');               // default dir is -1 (global, not per-sort); emit only the non-default
  if(s.forSaleOnly) p.set('forsale','1');
  if(s.matchFilter) p.set('match',s.matchFilter);
  return p;
}
function _filterQuery(){   // ADDRESS-BAR query: re-derive the filter keys from state, but PRESERVE any unknown param
  // (utm_*, or an in-flight auth handshake token) so the first render never strips one mid-flow.
  const p=new URLSearchParams(location.search);
  FILTER_PARAM_KEYS.forEach(k=>p.delete(k));      // drop the old filter keys…
  for(const [k,v] of _knownFilterParams()) p.append(k,v);   // …and splice the state-derived ones back in
  return p.toString();
}
function _syncFilterUrl(){   // called at the END of render(); replaceState only, and only when the URL actually changes
  try{
    const qs=_filterQuery();
    const next=location.pathname+(qs?'?'+qs:'')+location.hash;   // compose with the LIVE hash so the tab is never clobbered
    if(next!==location.pathname+location.search+location.hash) history.replaceState(null,'',next);
  }catch(e){}
}
function _shareUrl(){   // CLEAN shareable URL — ONLY the filter keys, so a copied link never carries an unknown/sensitive param
  const qs=_knownFilterParams().toString();
  return location.origin+location.pathname+(qs?'?'+qs:'')+location.hash;
}
function _applyUrlFilters(sellingApplied){   // bootCrate: seed state from ?params AFTER the resets + data awaits, before first render
  try{
    const p=new URLSearchParams(location.search);
    if(![...p.keys()].length) return;
    // pure data facets — safe on any crate (own/friend/public); harmless where they match nothing
    const g=p.getAll('g').filter(x=>typeof x==='string'&&x.length);
    if(g.length) state.genres=g;
    if(p.get('wax')==='1') state.coloredOnly=true;
    const color=p.get('color'); if(color) state.color=color;      // string-compared in matches(), esc()'d in the chip — injection-safe
    const artist=p.get('artist'); if(artist) state.artist=artist; // same string-compare/esc() safety as color
    const q=p.get('q'); if(q) state.query=q;                       // only ever set into state.query (rendered via esc()); never DOM-raw
    const sort=p.get('sort'); if(sort&&SORT_KEYS.includes(sort)) state.sort=sort;   // whitelist: a junk key would throw in sorted()
    if(p.get('dir')==='asc') state.dir=1;
    // context-gated facets — a stray one would BLANK the grid, so gate exactly as the live UI does.
    if(!sellingApplied){   // the #selling deep-link already set youWant+forsale; don't let a stray ?match override it
      // forsale: only when __twInventory has entries — an empty-but-non-null Map is truthy and matches() then excludes every record
      if(p.get('forsale')==='1' && window.__twInventory && window.__twInventory.size>0) state.forSaleOnly=true;
      // match: friend-crate only AND only once __twMatchCtx has loaded — on an own crate, or a friend crate whose
      // ctx fetch failed (stays null), matches() returns false for EVERY record. Mirror the UI: the match link is
      // only offered when ctx exists, so the URL path must gate on it too.
      const m=p.get('match'); if((m==='youWant'||m==='theyWant') && !IS_OWN() && window.__twMatchCtx) state.matchFilter=m;
    }
  }catch(e){}
}
/* Copy a URL to the clipboard + confirm. The button(s) that call these are a Claude Design
   deliverable; the mechanism ships now, wired via data-act="copyLink"/"copyCrateLink". */
function _copyShareLink(){ _copyUrl(_shareUrl()); }                          // this filtered view (tab + filters), cleaned of any unknown param
function _copyCrateLink(){ _copyUrl(location.origin+location.pathname); }    // the bare crate (no tab, no filters)
function _copyUrl(url){
  const done=()=>showToast('Link copied');
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(()=>_copyFallback(url,done));
    else _copyFallback(url,done);
  }catch(e){ _copyFallback(url,done); }
}
function _copyFallback(text,done){
  let ta;
  try{
    ta=document.createElement('textarea');
    ta.value=text; ta.setAttribute('readonly',''); ta.style.cssText='position:fixed; top:-1000px; opacity:0';
    document.body.appendChild(ta); ta.select();
    if(document.execCommand('copy')) done();
  }catch(e){}
  finally{ if(ta && ta.parentNode) ta.parentNode.removeChild(ta); }   // cleanup even if execCommand throws (D2)
}

function render(){
  const v=computeVals(); const s=state;
  const hasFilters=v.active.length>0;
  const lockedSection = !IS_OWN() && _viewLocked(s.view) ? (s.view==='wantlist' ? 'wantlist' : 'crate') : null;  // #43
  const showGrid=!lockedSection && (s.view==='crate' || s.view==='wantlist') && v.filtered.length>0;   // Wave 2 B1: the wantlist reuses the card grid
  const showTimeline=!lockedSection && s.view==='timeline' && v.filtered.length>0;
  const showStats=!lockedSection && s.view==='ledger' && v.filtered.length>0;
  const showEmpty=!lockedSection && v.filtered.length===0;

  // Wave 5c: FILED UNDER tray — the bar shows a count trigger + the selected styles; the tray holds every style.
  const nSel=s.genres.length;
  const trigLabel = nSel===0 ? 'ALL STYLES' : nSel===1 ? '1 STYLE' : nSel+' STYLES';
  const stylesTrigger=`<button data-act="stylesToggle" aria-expanded="${s.stylesOpen}" aria-controls="tw-styletray" style="display:inline-flex; align-items:center; gap:10px; font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:700; padding:5px 10px; border:1.5px solid var(--line); background:var(--ink); color:var(--on-accent)"><span>${trigLabel}</span><span>${s.stylesOpen?'▴':'▾'}</span></button>`;
  const _shownSel=s.genres.slice(0,2), _restSel=s.genres.slice(2);
  const selectedChips=_shownSel.map(g=>`<button data-act="genre" data-arg="${esc(g)}" aria-label="Remove ${esc(g)}" style="font-family:'IBM Plex Mono',monospace; font-size:11px; padding:5px 10px; border:1.5px solid var(--line); ${chipOn}">${esc(g.toUpperCase())} ×</button>`).join('')
    + (_restSel.length?`<button data-act="stylesToggle" title="${esc(_restSel.join(', '))} — open to edit" style="font-family:'IBM Plex Mono',monospace; font-size:11px; padding:5px 10px; border:1.5px dashed var(--line); background:transparent; color:var(--ink)">+${_restSel.length}</button>`:'');
  const emptyNote = nSel===0 ? `<span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.1em; color:var(--faint); margin-left:4px">${v.allStyles.length} STYLES · ${v.all.length.toLocaleString('en-US')} RECORDS</span>` : '';
  // The tray: full style list as a wrapping chip grid (top 20 when the find box is empty; full filtered list while typing; selected always shown first).
  const TRAY_CAP=20;
  const _sq=s.styleFind.trim().toLowerCase();
  let _trayList = _sq ? v.allStyles.filter(g=>g.toLowerCase().includes(_sq)) : v.allStyles.slice(0,TRAY_CAP);
  _trayList = s.genres.concat(_trayList.filter(g=>!s.genres.includes(g)));
  const _hidden = _sq ? 0 : Math.max(0, v.allStyles.length - _trayList.length);
  const _matchN = _trayList.length - s.genres.length;   // matching UNSELECTED styles
  const trayNote = _sq ? (_matchN>0 ? _matchN+' MATCH' : 'NO MATCH') : '+'+_hidden+' MORE · TYPE TO NARROW';
  const trayChips=_trayList.map(g=>`<button data-act="genre" data-arg="${esc(g)}" aria-pressed="${s.genres.includes(g)}" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; padding:4px 8px; border:1px solid var(--line); ${s.genres.includes(g)?chipOn:chipOff}">${esc(g.toUpperCase())} ${v.counts[g]||0}</button>`).join('');
  const styleTray = s.stylesOpen ? `<div id="tw-styletray" role="group" aria-label="Filter by style" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:10px 24px 12px; background:var(--bar); border-top:1px dashed var(--line); border-bottom:2px solid var(--line)">
      <input id="tw-stylefind" class="tw-field" value="${esc(s.styleFind)}" placeholder="FIND A STYLE…" aria-label="Find a style" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; padding:4px 8px; width:150px; background:var(--panel); color:var(--ink); border:1.5px solid var(--line); border-radius:0; margin-right:6px" />
      ${trayChips}
      <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.1em; color:var(--faint); margin-left:6px">${trayNote} · <button data-act="clearGenres" style="font:inherit; letter-spacing:inherit; padding:0; border:0; background:transparent; color:var(--ink); text-decoration:underline; text-underline-offset:3px">CLEAR ALL</button></span>
      <button data-act="stylesToggle" aria-label="Close styles" style="margin-left:auto; font-family:'IBM Plex Mono',monospace; font-size:10px; font-weight:700; letter-spacing:.1em; padding:5px 10px; border:1.5px solid var(--line); background:var(--ink); color:var(--on-accent)">CLOSE ▴</button>
    </div>` : '';

  const activeChips=v.active.map(c=>`<button data-act="rm" data-kind="${c.kind}" data-arg="${esc(c.value)}" style="display:flex; align-items:center; gap:7px; font-family:'IBM Plex Mono',monospace; font-size:10.5px; padding:4px 8px; background:var(--accent); color:var(--on-accent); border:0">
      <span style="opacity:.72; letter-spacing:.1em">${c.label||c.kind}</span>
      <span style="font-weight:600">${esc(c.value)}</span>
      <span style="opacity:.8">✕</span></button>`).join('');

  let content='';
  if(lockedSection){   // #43: a private section → the inline locked panel (kit Decision 1/3-B)
    content=lockedPanelHtml(lockedSection);
  } else if(showGrid){
    content=`<div class="tw-grid">${v.visible.map(card).join('')}</div>`;
  } else if(showTimeline){
    content=`<div style="display:flex; flex-direction:column; padding:6px 0 28px">${v.timeline.map(grp=>`
      <div style="display:flex; align-items:flex-start; gap:20px; padding:18px 24px; border-bottom:1px solid var(--hair)">
        <div style="width:150px; flex:none; display:flex; flex-direction:column; gap:3px; padding-top:2px">
          <span style="font-family:'Barlow Condensed',sans-serif; font-size:24px; font-weight:700; line-height:1">${esc(grp.label)}</span>
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.1em; color:var(--muted)">${grp.countLabel}</span>
          ${IS_OWN() ? `<span style="font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--faint)">${grp.valueLabel}</span>` : ''}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:10px">${grp.items.map(r=>`
          <button data-act="open" data-arg="${r.id}" title="${esc(r.coverAlt)}" style="padding:0; border:1.5px solid var(--line); background:transparent; box-shadow:2px 2px 0 var(--shadow)">
            <div role="img" aria-label="${esc(r.coverAlt)}" style="width:84px; height:84px; background:var(--skel); background-image:${r.coverBg}; background-size:cover; background-position:center">${r.coverPlaceholder}</div>
          </button>`).join('')}</div>
      </div>`).join('')}</div>`;
  } else if(showStats){
    content=`<div style="display:flex; flex-direction:column; gap:0">
      <div class="tw-ledger-stats" style="display:grid; grid-template-columns:repeat(${v.bigStats.length},1fr); border-bottom:1px solid var(--hair)">
        ${v.bigStats.map(st=>`<div style="padding:20px 22px; border-right:1px solid var(--hair); display:flex; flex-direction:column; gap:6px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">${esc(st.label)}</span>
          <span style="font-family:'Barlow Condensed',sans-serif; font-size:40px; font-weight:700; line-height:1; color:${st.color}">${esc(st.value)}</span>
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--faint); line-height:1.5">${esc(st.note)}</span>
          ${st.manage?`<a href="https://www.discogs.com/sell/manage" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace; font-size:10px; font-weight:700; letter-spacing:.06em; color:var(--ink); text-decoration:none; border-bottom:1.5px solid var(--accent); align-self:flex-start; margin-top:2px">MANAGE ON DISCOGS ↗</a>`:''}
        </div>`).join('')}
      </div>
      <div class="tw-ledger-panels" style="display:grid; grid-template-columns:1fr 1fr; gap:0">
        <div style="padding:22px 24px; border-right:1px solid var(--hair); display:flex; flex-direction:column">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">Most-filed styles</span>
          <div style="display:flex; flex-direction:column; gap:9px; margin-top:16px;${IS_OWN()?' min-height:170px':''}">${v.styleBars.map(b=>`
            <div style="display:flex; align-items:center; gap:12px">
              <span style="width:150px; flex:none; font-family:'IBM Plex Mono',monospace; font-size:10.5px; text-transform:uppercase; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(b.label)}</span>
              <span style="flex:1; height:12px; background:var(--bar); position:relative"><span style="position:absolute; inset:0 auto 0 0; width:${b.width}; background:var(--accent)"></span></span>
              <span style="width:26px; text-align:right; font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--muted)">${b.count}</span>
            </div>`).join('')}</div>
          ${IS_OWN() ? `<div class="tw-ledger-strip" style="display:flex; margin-top:18px; border-top:1px solid var(--hair); padding-top:14px">
            <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; padding-right:14px">
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint)">Top artist</span>
              <span title="${v.topArtist?esc(v.topArtist.name):''}" style="font-family:'Barlow Condensed',sans-serif; font-size:22px; font-weight:700; line-height:1.05; color:var(--ink); overflow-wrap:anywhere">${v.topArtist?esc(v.topArtist.name):'—'}</span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; color:var(--muted)">${v.topArtist?v.topArtist.count.toLocaleString('en-US')+(v.topArtist.count===1?' record':' records'):''}</span>
            </div>
            <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:3px">
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint)">Label</span>
              <span title="${v.topLabel?esc(v.topLabel.name):''}" style="font-family:'Barlow Condensed',sans-serif; font-size:22px; font-weight:700; line-height:1.05; color:var(--ink); overflow-wrap:anywhere">${v.topLabel?esc(v.topLabel.name):'—'}</span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; color:var(--muted)">${v.topLabel?v.topLabel.count.toLocaleString('en-US')+(v.topLabel.count===1?' record':' records'):''}</span>
            </div>
          </div>` : ''}
        </div>
        ${IS_OWN() ? (()=>{ const ds=v.decadeStats; const mx=ds.maxCount||1; return `<div style="padding:22px 24px; display:flex; flex-direction:column">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">By decade</span>
          <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:6px; height:170px; margin-top:16px">${v.decades.map(d=>{ const pk=ds.peak && d.decade===ds.peak.decade; const h=Math.max(3,Math.round(d.count/mx*120)); return `
            <div style="flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%">
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9px; white-space:nowrap; ${pk?'font-weight:700; color:var(--accent)':'color:var(--faint)'}; margin-bottom:4px">${d.count.toLocaleString('en-US')}</span>
              <span style="width:100%; height:${h}px; background:${pk?'var(--accent)':'var(--ink)'}"></span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; ${pk?'font-weight:700; color:var(--accent)':'color:var(--ink)'}; margin-top:7px">${esc(d.label)}</span>
            </div>`; }).join('') || '<span style="font-family:\'IBM Plex Mono\',monospace; font-size:11px; color:var(--faint); line-height:1.6">No release years on file yet.</span>'}</div>
          <div class="tw-ledger-strip" style="display:flex; margin-top:18px; border-top:1px solid var(--hair); padding-top:14px">
            <div style="flex:1; display:flex; flex-direction:column; gap:3px">
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint)">Peak</span>
              <span style="font-family:'Barlow Condensed',sans-serif; font-size:22px; font-weight:700; line-height:1; color:var(--ink)">${ds.peak?ds.peak.decade+'s':'—'}</span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; color:var(--muted)">${ds.peakPct}% of the shelf</span>
            </div>
            <div style="flex:1; display:flex; flex-direction:column; gap:3px">
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint)">Span</span>
              <span style="font-family:'Barlow Condensed',sans-serif; font-size:22px; font-weight:700; line-height:1; color:var(--ink)">${ds.minYear!=null?ds.minYear+'–'+String(ds.maxYear).slice(2):'—'}</span>
              <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; color:var(--muted)">${ds.medianYear!=null?'median '+ds.medianYear:''}</span>
            </div>
          </div>
        </div>`; })() : overlapPanelHtml()}
      </div>
      ${IS_OWN() ? `<div class="tw-dna-band" style="display:flex; align-items:center; justify-content:space-between; gap:32px; padding:22px 24px 26px; border-top:1px solid var(--hair); background:var(--bar)">
        <div style="display:flex; flex-direction:column; gap:8px; max-width:520px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">Collection DNA</span>
          <span style="font-family:'Barlow Condensed',sans-serif; font-size:30px; font-weight:700; line-height:1.05; color:var(--ink)">Your shelf, as a card.</span>
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--muted); line-height:1.6">One square image of the aggregates — decades, styles, colored wax. Never a title, never a price. 1080×1080, made in your browser, yours to post.</span>
          <div style="display:flex; align-items:center; gap:14px; margin-top:8px">
            <button data-act="dnaOpen" style="font-family:'IBM Plex Mono',monospace; font-size:11.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; padding:11px 18px; background:var(--accent); color:var(--on-accent); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow)">Share your DNA</button>
            <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.08em; color:var(--faint)">THREE CARDS · PICK ONE · PNG</span>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:22px; padding-right:12px">
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.14em; color:var(--muted); text-align:right">
            <span>YOUR PICK</span>
            <span style="font-family:'Barlow Condensed',sans-serif; font-size:18px; font-weight:700; letter-spacing:0; color:var(--ink)">${esc(DNA_NAMES[dnaVariant()])}</span>
            <span>CHANGE IN THE PICKER</span>
          </div>
          <canvas id="tw-dna-thumb" width="1080" height="1080" aria-label="Preview of your Collection DNA card" style="width:170px; height:170px; border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow); transform:rotate(1.2deg); background:#fff"></canvas>
        </div>
      </div>` : ''}
    </div>`;
  } else if(showEmpty){
    // S17: an EMPTY collection (records.length === 0) is a different state from filters
    // that excluded everything. The old code showed "0 RESULTS · CLEAR THE FILTERS" to a
    // brand-new user with no filters set — advice that couldn't help.
    if(v.all.length===0){
      // #51: while the wantlist dataset is still loading (WANTLIST_RECORDS flipped to [] to arm the reload-guard,
      // rows not back yet), show a neutral LOADING line — NOT emptyCrateHtml's "isn't hunting anything" flash.
      content = (_wlLoading && state.view==='wantlist')
        ? `<div style="display:flex; justify-content:center; padding:90px 24px 96px"><span style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.14em; color:var(--muted)">LOADING…</span></div>`
        : emptyCrateHtml();
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

    ${!IS_OWN()?(()=>{
      const o=window.TraxWaxOwner||{};
      const owner=(o.displayName||o.ownerUsername||'A friend');
      const mc=_matchCounts();
      const nameSpan = `<span style="color:#fff">${esc(owner.toUpperCase())}</span>`;
      const bothShared = (mc.youWant !== null && mc.theyWant !== null);
      // Two standalone clauses (each reads alone → each can be its own mobile row). Private → plain, no link (#43).
      const c1 = (mc.youWant !== null)
        ? `${nameSpan} HAS ` + _matchPart(mc.youWant,'YOU WANT','matchYouWant')
        : `${nameSpan}’S CRATE IS PRIVATE`;
      const c2 = (mc.theyWant !== null)
        ? 'YOU HAVE ' + _matchPart(mc.theyWant,'THEY WANT','matchTheyWant')
        : 'THEIR WANTLIST IS PRIVATE';
      // Wave 4 Stage 2 (D1): the for-sale subset of "albums you want". Counted with the SAME predicate the
      // matchSellingYouWant filter applies (forSale ∩ youWant, master-aware) over RECORDS, so the callout
      // count EQUALS the filtered set (#43 link-integrity). In-app link, NO ↗ (SPEC I). Renders only ≥1 (D3).
      const _fsWant = (window.__twInventory && window.__twMatchCtx && window.__twMatchCtx.viewerWants)
        ? (RECORDS||[]).filter(r => window.__twInventory.has(r.id) && (
            window.__twMatchCtx.viewerWants.has(r.id) ||
            (MATCH_ANY() && r.master_id && window.__twMatchCtx.viewerWantsMasters && window.__twMatchCtx.viewerWantsMasters.has(r.master_id))
          )).length : 0;
      const sellCallout = (_fsWant >= 1 && mc.youWant !== null)
        ? `<a href="#" data-act="matchSellingYouWant" title="Show the ones they're selling that you want" style="background:#fff; color:#16171a; font-weight:700; padding:2px 7px; text-decoration:underline; text-underline-offset:2px">${_num(_fsWant)} FOR SALE</a>`
        : '';
      // Desktop: one flowing sentence — ", AND " joins two shared clauses; ". " otherwise. The for-sale callout,
      // when present, folds in em-dash-set between the two clauses. (No-callout path is byte-identical to #43.)
      const desktop = sellCallout
        ? `${c1} — ${sellCallout} — ${bothShared ? 'AND ' : ''}${c2}.`
        : `${c1}${bothShared ? ', AND ' : '. '}${c2}.`;
      // Mobile: two rows; the callout rides row 1 (the clause it modifies); the "AND" connective rides row 2.
      const c1m = sellCallout ? `${c1} — ${sellCallout}` : c1;
      const row2 = `${bothShared ? 'AND ' : ''}${c2}`;
      return `<div class="tw-friend-strip" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 24px; background:#16171a; color:rgba(255,255,255,.62); font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.16em; text-transform:uppercase">
      <span class="tw-fs-desktop">${desktop}</span>
      <div class="tw-fs-mobile">
        <div class="tw-fs-row">${c1m}</div>
        <div class="tw-fs-row">${row2}</div>
      </div>
      <a class="tw-fs-back" href="/app" style="color:#fff; text-decoration:underline; white-space:nowrap">← Back to your crate</a>
    </div>`;})():''}

    <header class="tw-header" style="position:relative; display:flex; align-items:flex-end; justify-content:space-between; gap:20px; padding:22px 24px 18px; background:var(--accent); border-bottom:3px solid var(--line)">
      <div class="tw-headL" style="display:flex; align-items:flex-end; gap:14px">
        <a href="https://traxwax.com/" title="TraxWax home" style="text-decoration:none; display:inline-block; background:#16171a; color:#fff; font-family:'Anton',sans-serif; font-size:44px; line-height:1; text-transform:uppercase; letter-spacing:.01em; padding:12px 14px 10px; transform:rotate(-1.2deg)">TraxWax</a>
        ${IS_OWN()
          ? `<span style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:rgba(255,255,255,.92); padding-bottom:6px">${esc(SETTINGS.ownerLine + ' · filed by ' + FILED_BY_WORD)}</span>`
          : (()=>{ const o=window.TraxWaxOwner||{}; const av=o.avatarUrl||'';
              const glyph='<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.2" r="4.2" fill="#16171a"/><path d="M3.5 21c1.4-4.4 4.6-6.6 8.5-6.6s7.1 2.2 8.5 6.6z" fill="#16171a"/></svg>';
              const name=(o.displayName||o.ownerUsername||'A friend');
              const since=o.collectingSince ? (' · COLLECTING SINCE ' + esc(String(o.collectingSince))) : '';
              return `<div style="display:flex; align-items:center; gap:12px; padding-bottom:2px">
                <span class="tw-friend-avatar" style="width:46px; height:46px; flex:none; border:1.5px solid #16171a; border-radius:50%; overflow:hidden; background:#fff; display:inline-flex; align-items:center; justify-content:center">${av?`<img src="${esc(av)}" alt="" style="width:100%; height:100%; object-fit:cover; display:block">`:glyph}</span>
                <span style="display:flex; flex-direction:column; gap:3px">
                  <span class="tw-friend-name" style="font-family:'Barlow Condensed',sans-serif; font-size:26px; font-weight:700; line-height:1; color:#fff">${esc(name)}’s Crate</span>
                  <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:rgba(255,255,255,.85)">@${esc(o.ownerUsername||'')}${since}</span>
                </span>
              </div>`;})()}
      </div>
      <div class="tw-headR" style="display:flex; align-items:center; gap:10px">
        <div style="display:flex; font-family:'IBM Plex Mono',monospace; font-size:11px; border:1.5px solid #16171a; background:#fff; color:#16171a">
          <span style="padding:6px 10px; border-right:1.5px solid #16171a">${v.all.length.toLocaleString('en-US')} ${s.view==='wantlist'?'ON WANTLIST':'IN CRATE'}</span>
          ${s.view!=='wantlist'?`<span class="tw-hide-mobile" style="padding:6px 10px; border-right:1.5px solid #16171a">${v.coloredCount} COLORED</span>`:''}
          ${(IS_OWN() && s.view!=='wantlist')?`<span style="padding:6px 10px; border-right:1.5px solid #16171a">${esc(s.headerValue || valueLabel(v.total))} EST.</span>`:''}
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

    <div class="tw-filterbar" style="display:flex; align-items:center; gap:8px; padding:12px 24px; background:var(--bar); border-bottom:${s.stylesOpen?'1px':'2px'} solid var(--line)">
      <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.14em; color:var(--muted); margin-right:4px">FILED UNDER</span>
      ${stylesTrigger}${selectedChips}${emptyNote}
      <span style="margin-left:auto; display:flex; align-items:center; gap:8px">
        <input id="tw-search" class="tw-field" value="${esc(s.query)}" placeholder="SEARCH THE CRATE ⌕" aria-label="Search the crate" style="font-family:'IBM Plex Mono',monospace; font-size:11px; padding:6px 12px; width:210px; background:var(--panel); color:var(--ink); border:1.5px solid var(--line); border-radius:0" />
        <button data-act="colored" style="font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:700; padding:6px 10px; border:1.5px solid var(--line); ${s.coloredOnly?chipOn:chipOff}; box-shadow:2px 2px 0 var(--shadow)">COLORED WAX ●</button>
        ${(()=>{ const _n=window.__twInventory?v.all.filter(r=>window.__twInventory.has(r.id)).length:0; return _n>0?`<span style="width:1px; height:20px; background:var(--hair)"></span><button data-act="forSale" style="font-family:'IBM Plex Mono',monospace; font-size:11px; font-weight:700; padding:6px 10px; border:1.5px solid var(--line); ${s.forSaleOnly?chipOn:chipOff}; box-shadow:2px 2px 0 var(--shadow)">FOR SALE ${_n}</button>`:''; })()}
      </span>
    </div>
    ${styleTray}
    <div class="tw-tabsrow" style="display:flex; align-items:stretch; border-bottom:1px solid var(--hair); background:var(--panel)">
      ${tab('crate','THE CRATE')}${tab('timeline','THE TIMELINE')}${tab('ledger','THE LEDGER')}${DB_MODE()?tab('wantlist','THE WANTLIST'):''}
      <div class="tw-sortwrap" style="margin-left:auto; display:flex; align-items:center; gap:14px; padding:0 20px">
        ${IS_OWN() ? `<button data-act="copyCrateLink" title="Copy a link to your crate" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.08em; padding:5px 10px; border:1.5px solid var(--line); background:var(--panel); color:var(--ink); box-shadow:2px 2px 0 var(--shadow)">SHARE MY CRATE</button><span aria-hidden="true" style="width:1px; height:20px; background:var(--hair)"></span>` : ''}
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
      ${IS_OWN() ? `<button data-act="copyLink" title="Copy a link to this filtered view" style="margin-left:auto; display:flex; align-items:center; gap:7px; font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.08em; padding:4px 8px; background:transparent; border:1px solid var(--accent); color:var(--accent)"><span style="font-weight:700">SHARE THIS VIEW</span><span style="opacity:.75">${v.active.length} ${v.active.length===1?'FILTER':'FILTERS'}</span></button>` : ''}
    </div>`:''}

    ${content}

    <span style="position:absolute; bottom:-9px; left:44px; width:88px; height:20px; background:var(--tape); border-left:1px dashed rgba(0,0,0,.18); border-right:1px dashed rgba(0,0,0,.18); transform:rotate(2deg); pointer-events:none"></span>
    <span style="position:absolute; bottom:-9px; right:44px; width:88px; height:20px; background:var(--tape); border-left:1px dashed rgba(0,0,0,.18); border-right:1px dashed rgba(0,0,0,.18); transform:rotate(-2.5deg); pointer-events:none"></span>
  </div>

  <footer class="tw-footer" style="max-width:1480px; margin:20px auto 0; padding:14px 24px; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px 24px; font-family:'IBM Plex Mono',monospace; font-size:10px; line-height:1.7; letter-spacing:.04em; color:var(--faint)">
    <a href="https://www.discogs.com/" target="_blank" rel="noopener" style="color:var(--accent); text-transform:uppercase; letter-spacing:.09em; white-space:nowrap">Data provided by Discogs ↗</a>
    <span class="tw-footer-note" style="flex:1; min-width:240px; text-align:right">This application uses Discogs' API but is not affiliated with, sponsored or endorsed by Discogs. "Discogs" is a trademark of Zink Media, LLC.</span>
  </footer>`;

  const app=document.getElementById('app');
  // Issue #5 + remediation-audit F1/F3: activeElement is the truth, not a flag. If the
  // user is in the search box when ANY render fires — the debounce timer, an async stats
  // render, anything — put them back exactly where they were (the old value-reset trick
  // always jumped the caret to the end, breaking mid-query edits). If they've moved on
  // (clicked a card, opened the modal), no refocus: a stale timer must never steal focus,
  // least of all behind an open dialog.
  const _ae=document.activeElement;
  const _wasSearch=!!(_ae && _ae.id==='tw-search');
  const _wasFind=!!(_ae && _ae.id==='tw-stylefind');   // Wave 5c: the tray's FIND box
  const _caret=(_wasSearch||_wasFind) ? _ae.selectionStart : null;
  app.innerHTML=html;   // shell only — the modal lives in #tw-modal-root now (renderModal owns its focus capture)
  const _restore=(id)=>{ const el=document.getElementById(id); if(!el) return; el.focus(); const p=_caret==null?el.value.length:Math.min(_caret,el.value.length); el.setSelectionRange(p,p); };
  if(!state.detailId){
    if(_wasSearch) _restore('tw-search');
    else if(_wasFind && state.stylesOpen) _restore('tw-stylefind');                                                    // keep caret while typing in FIND
    else if(_stylesOpenedByUser && state.stylesOpen){ const f=document.getElementById('tw-stylefind'); if(f) f.focus(); }   // Wave 5c D3: focus FIND only on a user-initiated open, never on load
    else if(_stylesFocusTrigger){ const t=document.querySelector('[data-act="stylesToggle"]'); if(t) t.focus(); }           // return focus to the trigger on close
    else if(state.stylesOpen){ const f=document.getElementById('tw-stylefind'); if(f) f.focus(); }   // Wave 5c: a tray chip toggle destroys the clicked button → keep the user in the tray (focus FIND) instead of dropping to <body>
  }
  _stylesOpenedByUser=false; _stylesFocusTrigger=false;
  // Wave 5a: reflect the live filter/sort state in the URL (query string only; the tab keeps its #hash).
  // Guarded to replaceState only on an actual change, so the many non-filter re-renders (stats load, modal
  // open/close, tracklist fill, roving focus) don't churn history. No listener reacts to replaceState, so
  // this can't re-enter render().
  _syncFilterUrl();
  // Wave 5a: paint the Ledger's DNA thumbnail (own crate only; the canvas exists only when the band rendered).
  // Dynamic import so the dna.js module never loads until the Ledger is on screen.
  const _thumb=document.getElementById('tw-dna-thumb');
  if(_thumb) import('/dna.js').then(m=>m.renderCard(_thumb, dnaVariant(), m.computeStats(RECORDS, window.TraxWaxOwner||{}))).catch(()=>{});
  // A11y (W0.4): renderModal() re-establishes the grid's roving tabindex AND the modal DOM/focus/shell-inert
  // in the proven roving-then-modal-focus order, so a full render still ends exactly as it did pre-refactor.
  renderModal();
}

/* ── Detail modal ──────────────────────────────────────────────────────────── */
function modalHtml(){
  const rec=recordById(state.detailId);
  if(!rec) return '';
  const d=deco(rec);
  const rel=rec._rel;  // tracklist/country/videos from the baked release file (or live fallback), via _loadRelease
  const country=(rel && rel.country)?rel.country:'—';   // #34: don't fabricate "US" before the release loads / for unknown-country pressings
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
          ${(window.__twInventory && window.__twInventory.has(rec.id))?`<span style="align-self:flex-start; margin-top:5px; font-family:'IBM Plex Mono',monospace; font-size:9px; font-weight:700; letter-spacing:.12em; padding:3px 7px; border:1.5px solid var(--ink); background:var(--panel); color:var(--ink)">FOR SALE ●</span>`:''}
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
            ${(IS_OWN() && state.view!=='wantlist')?(()=>{ const lid=window.__twInventory&&window.__twInventory.get(rec.id); const href=lid?('https://www.discogs.com/sell/item/'+lid):('https://www.discogs.com/sell/post/'+rec.id); const label=lid?'EDIT LISTING ↗':'LIST FOR SALE ↗'; return `<a href="${href}" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; font-weight:700; letter-spacing:.06em; padding:7px 10px; border:1.5px solid var(--line); background:var(--ink); color:var(--panel); text-align:center">${label}</a>`; })():''}
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
  // Wave 5a: the DNA picker is a separate top-layer modal; Escape closes it first.
  if (state.dnaOpen){ if (e.key==='Escape'){ state.dnaOpen=false; renderDna(); return; } return; }
  // Modal open: Escape closes; Tab cycles within the dialog.
  if (state.detailId){
    if (e.key==='Escape'){ state.detailId=null; renderModal(); return; }
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
  // Wave 5c: FILED UNDER tray — Escape closes it (checked after the DNA/modal branches, which take priority); Enter in FIND toggles a lone match on.
  if (state.stylesOpen){
    if (e.key==='Escape'){ state.stylesOpen=false; state.styleFind=''; _stylesFocusTrigger=true; render(); return; }
    if (e.key==='Enter' && document.activeElement && document.activeElement.id==='tw-stylefind'){
      const q=state.styleFind.trim().toLowerCase(); if(!q) return;
      const vv=computeVals();
      const m=vv.allStyles.filter(g=>g.toLowerCase().includes(q) && !state.genres.includes(g));
      if(m.length===1){ e.preventDefault(); toggleGenre(m[0]); _filterToCrate(); render(); }
      return;
    }
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
  renderModal();
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
  if(state.detailId===rec.id) renderModal();
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
      if(state.detailId===rec.id) renderModal();
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
/* Friend-crate ADD (+ WANT): optimistically add to the viewer's wantlist Set — the ON YOUR WANTLIST cover
   strip appears and the meta flips to ✕ REMOVE on re-render — then PUT under the viewer's own token. The
   strip IS the confirmation, so there is NO snackbar on add. Revert + toast on failure; MATCHES refreshes
   on the committed add. */
async function friendAdd(id){
  // Re-add during a pending removal's grace window (the card stays put on a friend crate, so + WANT is
  // live): just cancel the pending DELETE — it never committed, so no network is needed and nothing
  // desyncs. Without this the deferred DELETE would fire ~6s later and silently revert this re-add.
  if (_pendingRemove && _pendingRemove.id === id) { _undoRemove(); return; }
  const ctx = window.__twMatchCtx;
  if (!ctx || !ctx.viewerWants || !window.TraxWaxSetWant || _wantInflight.has(id) || ctx.viewerWants.has(id)) return;
  _wantInflight.add(id);
  ctx.viewerWants.add(id);
  render();
  try {
    await window.TraxWaxSetWant(id, 'add');
    track('wantlist_add', { source: 'friend' });
    // #43: the match sentence recomputes from the flipped viewerWants on the next render (set-derived) — no server recount.
  } catch(e){
    ctx.viewerWants.delete(id);
    render();
    showToast(e && e.status===409 ? 'Connect Discogs to change your wantlist'
                                  : 'Couldn’t update your wantlist — try again', null, null);
  } finally { _wantInflight.delete(id); }
}

/* Friend-crate REMOVE (✕ REMOVE): reuses the wantlist undo snackbar + deferred commit VERBATIM, with one
   difference — the card STAYS in the grid (it's the friend's record); only the strip + meta revert. Undo
   re-adds to the viewer's wantlist Set; the Discogs DELETE commits on snackbar dismiss/timeout; MATCHES
   refreshes when the remove commits. */
function friendRemove(id){
  const ctx = window.__twMatchCtx;
  if (!ctx || !ctx.viewerWants || !ctx.viewerWants.has(id)) return;
  const rec = recordById(id) || { id };
  ctx.viewerWants.delete(id);   // strip disappears + meta flips to + WANT on the re-render inside _beginDeferredRemove
  const revert = () => { const c = window.__twMatchCtx; if (c && c.viewerWants) c.viewerWants.add(id); render(); };
  _beginDeferredRemove(id, rec, revert, 'friend', null);   // #43: no onCommit recount — the sentence is set-derived
}


/* WANTLIST-tab remove (wantlist-remove redesign). Optimistic + reversible with a DEFERRED commit: the card
   leaves the grid immediately and an undo snackbar appears, but the Discogs DELETE is NOT sent until the
   snackbar dismisses or times out (~6s) — the grace window. UNDO cancels with NO network at all; a new
   removal commits the previous pending one. One snackbar at a time, naming the most recently removed record.
   Trade-off (accepted per the design's grace-window model): a reload during the window loses the un-committed
   delete, so that record reloads still-wanted — safe (no data loss), just not-yet-removed. */
let _pendingRemove = null;   // { id, revert, timer, source, onCommit } — at most one un-committed removal
function _commitPendingRemove(){
  const p = _pendingRemove; if (!p) return;
  _pendingRemove = null;
  clearTimeout(p.timer);
  _hideRemoveSnackbar();
  if (!window.TraxWaxSetWant) return;
  window.TraxWaxSetWant(p.id, 'remove')
    .then(()=>{ track('wantlist_remove', { source: p.source }); if (p.onCommit) p.onCommit(); })
    .catch(()=>{
      // Grace window closed, optimistic UI already applied, but the DELETE failed — the record is still on
      // Discogs. Undo the optimistic change and say so, rather than leaving the UI and Discogs out of sync.
      p.revert();
      showToast('Couldn’t remove — it’s still on your wantlist', null, null);
    });
}
function _undoRemove(){
  const p = _pendingRemove; if (!p) return;   // cancel the pending delete — no Discogs call
  _pendingRemove = null;
  clearTimeout(p.timer);
  _hideRemoveSnackbar();
  p.revert();
}
/* Shared deferred-remove: the caller has already applied the optimistic UI change. This shows the undo
   snackbar, arms the ~6s commit timer, and supersedes any prior pending removal (committing it first).
   `revert` undoes the caller's optimistic change AND re-renders; `onCommit` runs after a successful Discogs
   DELETE (or null). The wantlist tab and a friend's crate share this — they differ only in what `revert`
   restores (a spliced list row vs. a viewerWants Set membership). */
function _beginDeferredRemove(id, snackRec, revert, source, onCommit){
  _commitPendingRemove();   // a still-pending prior removal commits now (superseded by this one)
  const timer = setTimeout(_commitPendingRemove, 6000);
  _pendingRemove = { id, revert, timer, source, onCommit: onCommit || null };
  render();
  showRemoveSnackbar(snackRec);
}
/* WANTLIST-tab remove: the card LEAVES the grid (splice) — that's the difference from a friend crate. */
function removeWant(id){
  if (!Array.isArray(WANTLIST_RECORDS)) return;
  const idx = WANTLIST_RECORDS.findIndex(x=>x.id===id);
  if (idx<0) return;   // already gone from the grid (e.g. a double-click) — natural dedup
  _removedThisSession = true;   // an emptied wantlist now reads as "cleared", not "genuinely empty"
  const row = WANTLIST_RECORDS[idx];
  WANTLIST_RECORDS.splice(idx,1);
  if (state.detailId===id) state.detailId=null;   // close the modal if it was open on this record
  const revert = () => {
    if (Array.isArray(WANTLIST_RECORDS) && !WANTLIST_RECORDS.some(x=>x.id===id))
      WANTLIST_RECORDS.splice(Math.min(idx, WANTLIST_RECORDS.length), 0, row);   // computeVals re-sorts → sorted position
    render();
  };
  _beginDeferredRemove(id, row, revert, 'wantlist', null);
}

/* The undo snackbar (design spec §4a): ink panel, names the record, UNDO (accent) + dismiss ✕. Dismiss AND
   the 6s timeout both COMMIT the delete; UNDO cancels it. One at a time; textContent only (no injection). */
function showRemoveSnackbar(rec){
  _hideRemoveSnackbar();
  const bar=document.createElement('div'); bar.id='tw-remove-snack';
  bar.setAttribute('role','status'); bar.setAttribute('aria-live','polite');
  bar.style.cssText="position:fixed; left:50%; bottom:22px; transform:translateX(-50%); z-index:60; "+
    "display:flex; align-items:center; gap:14px; max-width:calc(100vw - 32px); background:var(--ink); "+
    "color:var(--panel); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow); padding:10px 12px 10px 15px";
  const eyebrow=document.createElement('span');
  eyebrow.style.cssText="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.08em; opacity:.7";
  eyebrow.textContent='REMOVED FROM WANTLIST';
  const title=document.createElement('span');
  title.style.cssText="font-family:'Barlow Condensed',sans-serif; font-size:16px; font-weight:600; "+
    "max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap";
  title.textContent=rec.title||'';
  const undo=document.createElement('button');
  undo.style.cssText="-webkit-appearance:none; appearance:none; font-family:'IBM Plex Mono',monospace; "+
    "font-size:10.5px; font-weight:700; letter-spacing:.1em; padding:6px 12px; background:var(--accent); "+
    "color:var(--on-accent); border:0; cursor:pointer";
  undo.textContent='UNDO'; undo.addEventListener('click', _undoRemove);
  const dismiss=document.createElement('button');
  dismiss.setAttribute('title','Dismiss');
  dismiss.style.cssText="-webkit-appearance:none; appearance:none; padding:2px 4px; border:0; background:transparent; "+
    "color:var(--panel); opacity:.55; font-size:14px; line-height:1; cursor:pointer";
  dismiss.textContent='✕'; dismiss.addEventListener('click', _commitPendingRemove);
  bar.append(eyebrow, title, undo, dismiss);
  document.body.appendChild(bar);
  // #31: after a grid remove, render() rebuilt the grid and focus fell to <body> — move it to UNDO so a
  // keyboard/SR user can reverse the removal within the grace window. #50: but NOT when the detail modal is
  // open (a friend-crate remove keeps it open) — _beginDeferredRemove's render()→renderModal already placed
  // focus inside the dialog, and stealing it to the body-level snackbar would break the modal's focus trap.
  const _mr = document.getElementById('tw-modal-root');
  const _modalOpen = !!(state.detailId && _mr && _mr.innerHTML);
  if (!_modalOpen) { try { undo.focus(); } catch (e) {} }
}
function _hideRemoveSnackbar(){ const el=document.getElementById('tw-remove-snack'); if(el) el.remove(); }

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

/* ── Wave 5a: Collection DNA picker modal + export (own crate only) ──────────────────────────
   Renders into a body-level #tw-dna-root (like #tw-modal-root). Three preview canvases from dna.js;
   the pick is visual-only until an export commits it to localStorage. Overlay data-act="dnaClose"
   closes; the dialog carries data-act="stop" so an inside click doesn't bubble to it (same pattern
   as the detail modal). */
let _dnaInvoker=null;   // the control that opened the picker; focus returns here on close (WCAG 2.4.3)
function renderDna(){
  let root=document.getElementById('tw-dna-root');
  if(!root){ root=document.createElement('div'); root.id='tw-dna-root'; document.body.appendChild(root); }
  if(!state.dnaOpen){
    root.innerHTML=''; const a=document.getElementById('app'); if(a) a.removeAttribute('inert');
    // Return focus to the "Share your DNA" trigger (WCAG 2.4.3). On the dnaClose/Esc paths #app isn't
    // re-rendered, so the trigger is live and gets focus. On the export path the caller runs render()
    // right after this, synchronously detaching the trigger, so focus harmlessly ends on <body> after
    // the confirmation toast. document.contains guards against focusing a stale node.
    if(_dnaInvoker && document.contains(_dnaInvoker)){ try{ _dnaInvoker.focus(); }catch(e){} }
    _dnaInvoker=null;
    return;
  }
  const pick=state.dnaPick||'A';
  const opt=(k,eyebrow,name,desc,bg)=>`<button data-act="dnaPick" data-arg="${k}" aria-pressed="${pick===k}" style="padding:0; border:0; background:transparent; text-align:left; display:flex; flex-direction:column; gap:10px; min-width:0">
      <div style="position:relative; width:100%; border:3px solid ${pick===k?(k==='C'?'var(--ink)':'var(--accent)'):'var(--hair)'}; background:${bg}">
        ${pick===k?`<span style="position:absolute; top:10px; left:-4px; z-index:2; background:${k==='C'?'var(--ink)':'var(--accent)'}; color:${k==='C'?'var(--panel)':'var(--on-accent)'}; font-family:'Archivo',sans-serif; font-size:9px; font-weight:800; letter-spacing:.14em; padding:3px 7px; transform:rotate(-2.5deg)">YOUR PICK</span>`:''}
        <canvas data-dna="${k}" width="1080" height="1080" style="display:block; width:100%; height:auto"></canvas>
      </div>
      <div style="display:flex; flex-direction:column; gap:3px; padding:0 2px">
        <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; color:var(--muted)">${eyebrow}</span>
        <span style="font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:700; line-height:1">${name}</span>
        <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--faint); line-height:1.55">${desc}</span>
      </div></button>`;
  const shareBtn=(navigator.share&&navigator.canShare)
    ? `<button data-act="dnaShare" style="font-family:'IBM Plex Mono',monospace; font-size:11.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; padding:11px 18px; background:var(--panel); color:var(--ink); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow)">Share…</button>`
    : `<button data-act="dnaCopy" style="font-family:'IBM Plex Mono',monospace; font-size:11.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; padding:11px 18px; background:var(--panel); color:var(--ink); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow)">Copy image</button>`;
  root.innerHTML=`<div class="tw-modal-ov" data-act="dnaClose" style="position:fixed; inset:0; z-index:50; background:rgba(10,10,12,.62); display:flex; align-items:flex-start; justify-content:center; padding:56px 24px; overflow:auto">
    <div data-act="stop" role="dialog" aria-modal="true" aria-label="Collection DNA" style="width:1000px; max-width:100%; background:var(--panel); color:var(--ink); border:1.5px solid var(--line); box-shadow:8px 8px 0 var(--shadow); display:flex; flex-direction:column">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding:20px 22px 18px; border-bottom:1.5px solid var(--line)">
        <div style="display:flex; flex-direction:column; gap:6px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)">Collection DNA</span>
          <span style="font-family:'Barlow Condensed',sans-serif; font-size:34px; font-weight:700; line-height:1">Pick your card.</span>
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--muted); line-height:1.6">Three reads of the same shelf. Aggregates only — no titles, no prices. Your pick is remembered.</span>
        </div>
        <button data-act="dnaClose" title="Close" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:6px 10px; background:var(--panel); color:var(--ink); border:1.5px solid var(--line); white-space:nowrap">✕ CLOSE</button>
      </div>
      <div class="tw-dna-grid" style="display:grid; grid-template-columns:repeat(3,1fr); gap:18px; padding:22px">
        ${opt('A','A · CHART-FORWARD · LIGHT','The Decades','Peak decade as the hero, the per-decade release histogram, span in the footer.','#fff')}
        ${opt('B','B · STAT WALL · DARK','The Stat Wall','Four anchors and your top three styles. The ledger read.','#0e0f11')}
        ${opt('C','C · SINGLE HERO · RED','The Split','One number you can read from across the room, the colored-vs-black bar, two supporting facts.','#e8194b')}
      </div>
      <div style="display:flex; align-items:center; justify-content:space-between; gap:20px; padding:16px 22px 18px; border-top:1px solid var(--hair); flex-wrap:wrap">
        <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--faint); line-height:1.6">1080 × 1080 PNG · made in your browser from your own crate · every card carries “Data provided by Discogs”</span>
        <div style="display:flex; align-items:center; gap:12px">
          ${shareBtn}
          <button data-act="dnaDownload" style="font-family:'IBM Plex Mono',monospace; font-size:11.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; padding:11px 18px; background:var(--accent); color:var(--on-accent); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow)">Download PNG</button>
        </div>
      </div>
    </div></div>`;
  const a=document.getElementById('app'); if(a) a.setAttribute('inert','');
  import('/dna.js').then(m=>{
    const stats=m.computeStats(RECORDS, window.TraxWaxOwner||{});
    root.querySelectorAll('canvas[data-dna]').forEach(c=>m.renderCard(c, c.dataset.dna, stats));
  }).catch(()=>{});
  const first=root.querySelector('button[data-act="dnaPick"][aria-pressed="true"]'); if(first) first.focus();
}
async function _dnaExport(mode){
  const pick=state.dnaPick||'A';
  track('dna_export', { variant: pick, mode });
  // Remediation-audit: route an unsupported "copy" to download UP FRONT (Firefox/older engines lack
  // ClipboardItem) so the "Copy image" button never silently dead-ends.
  if(mode==='copy' && !(window.ClipboardItem && navigator.clipboard && navigator.clipboard.write)) mode='download';
  try{
    const m=await import('/dna.js');
    const stats=m.computeStats(RECORDS, window.TraxWaxOwner||{});
    const c=document.createElement('canvas'); c.width=1080; c.height=1080;
    await m.renderCard(c, pick, stats);                 // awaits document.fonts.ready internally
    const blob=await new Promise(res=>c.toBlob(res,'image/png'));
    if(!blob) throw new Error('toBlob returned null');  // never a silent 4-byte "null" file
    setDnaVariant(pick);                                // commit the pick only once a card was ACTUALLY built (not on a render throw)
    const file=new File([blob],'traxwax-dna-'+pick.toLowerCase()+'.png',{type:'image/png'});
    const NAMES={A:'The Decades',B:'The Stat Wall',C:'The Split'};
    if(mode==='copy'){   // ClipboardItem support already confirmed by the up-front reroute
      try{ await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]); showToast('Image copied · Paste it anywhere.'); }
      catch(e){ mode='download'; }
    }
    if(mode==='share' && navigator.share && navigator.canShare && navigator.canShare({files:[file]})){
      try{ await navigator.share({files:[file], title:'My Collection DNA', text:'Data provided by Discogs · traxwax.com'}); }
      catch(e){ if(e && e.name!=='AbortError'){ mode='download'; showToast("Couldn't share — saved the PNG instead"); } else { mode='aborted'; } }
    }
    if(mode==='download' || (mode==='share' && !(navigator.canShare && navigator.canShare({files:[file]})))){
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=file.name; document.body.appendChild(a); a.click();
      setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      showToast('Card saved · '+file.name+' · '+NAMES[pick]);
    }
  }catch(e){ console.warn('DNA export failed', e); showToast("Couldn't build the card — try again"); }
  state.dnaOpen=false; renderDna(); render();            // render() refreshes the ledger band's YOUR PICK + thumbnail
}

/* #57: THE LEDGER is a whole-crate stats view with no filtered grid, so a search or facet applied there
   would be invisible. Any ADDITIVE filter action on the ledger switches to THE CRATE so results show —
   mirrors the match-link pattern (crate + clear the tab hash). THE TIMELINE filters its own list, so it is
   deliberately left alone; clearing/removing filters never switches (staying put is fine). */
function _filterToCrate(){
  if(state.view!=='ledger') return;
  state.view='crate';
  try { history.replaceState(null, '', location.pathname + location.search); } catch(e){}
}

/* ── Events (delegation) ───────────────────────────────────────────────────── */
function onClick(e){
  const t=e.target.closest('[data-act]'); if(!t) return;
  if(t.tagName==='A') e.preventDefault();   // #47: in-app <a data-act> links (match sentence) never navigate
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
      state.matchFilter=null;   // #47: a manual tab switch is a fresh context; the match filter is set only by the match links
      // Wave 2: reflect the active tab in the URL hash so a reload lands back here (crate = no hash).
      // replaceState, not pushState — flipping tabs shouldn't pile up browser-history entries.
      try { history.replaceState(null, '', location.pathname + location.search + (arg==='crate' ? '' : '#'+arg)); } catch(e){}
      track('view_change', { view: arg });
      // Wave 2 B1: lazy-load THE WANTLIST dataset on first switch. WANTLIST_RECORDS: null=not loaded,
      // []=loaded (guards re-entry while the async load is in flight; [] shows an empty grid, not RECORDS).
      if ((arg==='wantlist' || (arg==='ledger' && !IS_OWN())) && WANTLIST_RECORDS===null && window.TraxWaxWantlistData) {
        WANTLIST_RECORDS=[]; _wlLoading=true;
        window.TraxWaxWantlistData().then((rows)=>{ WANTLIST_RECORDS=rows; _wlLoading=false; render(); })
          .catch((e)=>{ console.warn('wantlist load failed', e); WANTLIST_RECORDS=null; _wlLoading=false; });
      }
      render();
      break;
    case 'sort': state.sort=arg; render(); break;
    case 'dir': state.dir*=-1; render(); break;
    case 'genre': track('filter_used', { kind: 'genre' }); toggleGenre(arg); if(state.genres.includes(arg)) _filterToCrate(); render(); break;   // #57: switch only when ADDING a genre, not deselecting
    case 'clearGenres': state.genres=[]; render(); break;   // Wave 5c: CLEAR ALL in the tray — styles only; tray stays open (stylesOpen untouched)
    case 'stylesToggle':   // Wave 5c: open/close the FILED UNDER tray
      state.stylesOpen=!state.stylesOpen;
      if(state.stylesOpen){ _stylesOpenedByUser=true; } else { state.styleFind=''; _stylesFocusTrigger=true; }
      render(); break;
    case 'colored': track('filter_used', { kind: 'colored' }); state.coloredOnly=!state.coloredOnly; if(state.coloredOnly) _filterToCrate(); render(); break;   // #57: switch only when turning the toggle ON
    case 'forSale': track('filter_used', { kind: 'forsale' }); state.forSaleOnly=!state.forSaleOnly; if(state.forSaleOnly) _filterToCrate(); render(); break;   // Wave 4 (F1); #57: switch only when turning ON
    case 'artist': state.artist=arg; state.detailId=null; _filterToCrate(); render(); break;
    case 'color': track('filter_used', { kind: 'color' }); state.color=arg; state.detailId=null; _filterToCrate(); render(); break;
    case 'open': track('record_opened', { source: state.view }); openDetail(Number(arg)); break;
    case 'retryDetail': { const r=recordById(state.detailId); if(r){ r._relErr=false; renderModal(); _loadRelease(r); } break; }
    case 'detailGenre': state.detailId=null; state.genres=[arg]; render(); break;
    case 'rm': removeFacet(t.dataset.kind, arg); render(); break;
    case 'clearAll': state.genres=[]; state.coloredOnly=false; state.forSaleOnly=false; state.artist=null; state.color=null; state.query=''; state.matchFilter=null; render(); break;
    case 'closeDetail': state.detailId=null; renderModal(); break;
    case 'matchYouWant':   // #47: their crate, narrowed to records you want that they have
      state.view='crate'; state.matchFilter='youWant'; track('match_filter', { dir: 'youWant' });
      try { history.replaceState(null, '', location.pathname + location.search); } catch(e){}
      render(); break;
    case 'matchSellingYouWant':   // Wave 4 Stage 2 (D): the compound shortcut — YOU WANT + FOR SALE at once (two existing composable filters)
      state.view='crate'; state.matchFilter='youWant'; state.forSaleOnly=true; track('match_filter', { dir: 'sellingYouWant' });
      try { history.replaceState(null, '', location.pathname + location.search); } catch(e){}
      render(); break;
    case 'matchTheyWant':  // #47: their wantlist, narrowed to records they want that you have
      state.view='wantlist'; state.matchFilter='theyWant'; track('match_filter', { dir: 'theyWant' });
      try { history.replaceState(null, '', location.pathname + location.search + '#wantlist'); } catch(e){}
      if (WANTLIST_RECORDS===null && window.TraxWaxWantlistData) {   // lazy-load the friend wantlist, as case 'view' does
        WANTLIST_RECORDS=[]; _wlLoading=true;
        window.TraxWaxWantlistData().then((rows)=>{ WANTLIST_RECORDS=rows; _wlLoading=false; render(); })
          .catch((e)=>{ console.warn('wantlist load failed', e); WANTLIST_RECORDS=null; _wlLoading=false; });
      }
      render(); break;
    case 'want': (t.dataset.want==='remove' ? friendRemove : friendAdd)(Number(arg)); break;
    case 'wantRemove': removeWant(Number(arg)); break;
    case 'copyLink': track('share_copy', { scope: 'view' }); _copyShareLink(); break;    // Wave 5a: "share this filtered view" — the current URL (tab + filters)
    case 'copyCrateLink': track('share_copy', { scope: 'crate' }); _copyCrateLink(); break;   // Wave 5a: "share my crate" — the bare crate URL
    case 'dnaOpen':   _dnaInvoker=t; state.dnaOpen=true; state.dnaPick=dnaVariant(); track('dna_open'); renderDna(); break;   // Wave 5a
    case 'dnaClose':  state.dnaOpen=false; renderDna(); break;
    case 'dnaPick':   state.dnaPick=arg; renderDna(); break;        // arg ∈ 'A'|'B'|'C' (visual only; committed on export)
    case 'dnaDownload': _dnaExport('download'); break;
    case 'dnaShare':    _dnaExport('share'); break;
    case 'dnaCopy':     _dnaExport('copy'); break;                  // desktop fallback: PNG → clipboard (ClipboardItem)
    case 'stop': e.stopPropagation(); break;
  }
}
function removeFacet(kind, val){
  if(kind==='STYLE') toggleGenre(val);
  else if(kind==='WAX') state.coloredOnly=false;
  else if(kind==='FORSALE') state.forSaleOnly=false;   // Wave 4 (F1): removable FOR SALE chip
  else if(kind==='ARTIST') state.artist=null;
  else if(kind==='COLOR') state.color=null;
  else if(kind==='SEARCH') state.query='';
  else if(kind==='MATCH') state.matchFilter=null;   // #47
}
function onInput(e){
  if(e.target.id==='tw-search'){
    // Issue #5 (audit #18): debounce — every keystroke rebuilt the entire app via
    // innerHTML (up to 1,861 cards). The input keeps its live DOM value while typing;
    // state.query tracks each keystroke so the render 150ms after the last one matches.
    // Focus + caret restoration live in render() itself, keyed off activeElement.
    state.query = e.target.value;
    _filterToCrate();   // #57: searching on the ledger (no filtered grid there) surfaces results in the crate
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(render, 150);
  }
  if(e.target.id==='tw-stylefind'){   // Wave 5c: FIND a style — re-renders the tray only (debounced), caret restored in render()
    state.styleFind = e.target.value;
    clearTimeout(_findDebounce);
    _findDebounce = setTimeout(render, 100);
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
  state.matchFilter=null;  // #47: match filter is per-crate context — never inherit it across a (re)boot
  state.detailId = null;   // #44/#37: never inherit a stale open modal across a (re)boot
  state.dnaOpen = false; state.dnaPick = null;   // Wave 5a: never inherit a stale-open DNA picker across a (re)boot
  state.stylesOpen = false; state.styleFind = '';   // Wave 5c: same — never inherit a stale-open FILED UNDER tray/find across a (re)boot
  { const _d = document.getElementById('tw-dna-root'); if (_d) _d.innerHTML = ''; }
  { const _a = document.getElementById('app'); if (_a){ _a.inert = false; _a.removeAttribute('aria-hidden'); } }
  { const _m = document.getElementById('tw-modal-root'); if (_m) _m.innerHTML = ''; }
  // #48: abandon any un-committed deferred removal on (re)boot WITHOUT firing its Discogs DELETE. A re-boot
  // (Clerk auth-state change) inside the ~6s grace window would otherwise let the armed timer fire later
  // against a possibly-different provider/context. clearTimeout + null cancels it silently; the fresh
  // WANTLIST_RECORDS reload below reflects Discogs truth, so the un-sent delete simply never happens.
  if (_pendingRemove) { clearTimeout(_pendingRemove.timer); _pendingRemove = null; }
  // Wave 2: restore the active tab from the URL hash (#wantlist etc.) so a reload lands on the tab you were
  // on, not always THE CRATE. Only tabs valid for THIS crate are honored (wantlist is own+DB only); anything
  // else falls back to 'crate'. Set before the render below so the right grid paints on the first frame.
  const _validTabs = new Set(['crate','timeline','ledger']);
  if (DB_MODE()) _validTabs.add('wantlist');   // #47: friend crates get THE WANTLIST too
  // #43: default to the first SHARED section (crate open → crate; crate private + wantlist open → wantlist).
  // both-private never reaches here — boot.js served the S16 no-crate card.
  let _bootView = CAN_VIEW_CRATE() ? 'crate' : 'wantlist';
  try { const h=(location.hash||'').replace(/^#/,''); if (_validTabs.has(h) && !(!IS_OWN() && _viewLocked(h))) _bootView = h; } catch(e){}
  // Wave 4 D2: the FRIENDS-list "Selling N you want" link deep-links to /app/{u}#selling. Open the crate
  // pre-filtered to for-sale ∩ your wants (the same matchSellingYouWant filter D1's header applies). Only on a
  // viewable FRIEND crate (for-sale renders on the crate); #selling isn't a valid tab so the line above ignores
  // it. __twInventory + __twMatchCtx load below (awaited) before the first render, so the filter applies to real
  // data at first paint.
  let _bootSelling = false;
  try {
    const _vf = window.TraxWaxViewer && window.TraxWaxViewer.canViewForSale === true;   // for-sale consent, not just crate
    if ((location.hash||'') === '#selling' && !IS_OWN() && CAN_VIEW_CRATE() && _vf) { _bootView = 'crate'; _bootSelling = true; }
  } catch(e){}
  state.view = _bootView;
  if (_bootSelling) { state.matchFilter = 'youWant'; state.forSaleOnly = true; }
  // Normalize the URL to the actual tab — strips a stale/invalid hash (e.g. #wantlist carried onto a
  // friend crate, which falls back to 'crate') so what's in the address bar always matches what's shown.
  // #selling is preserved so a reload re-applies the deep-linked filter.
  try { history.replaceState(null, '', location.pathname + location.search + (_bootSelling ? '#selling' : (_bootView==='crate'?'':'#'+_bootView))); } catch(e){}
  initTheme();
  if (window.TraxWaxOwner && window.TraxWaxOwner.ownerLine) {
    SETTINGS.ownerLine = window.TraxWaxOwner.ownerLine;
  }
  // #45: page title reflects whose crate this is — own → "My Crate"; friend → "{display name}'s Crate".
  try {
    const _o = window.TraxWaxOwner || {};
    const _who = _o.displayName || _o.ownerUsername || 'a friend';
    document.title = IS_OWN() ? 'TraxWax — My Crate' : ('TraxWax — ' + _who + '’s Crate');
  } catch (e) {}
  if (DB_MODE()) SETTINGS.showPrices = false;   // per-record prices are Restricted; header+modal only
  document.getElementById('app').innerHTML=`<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--muted)">Loading the crate…</div>`;
  try{
    if (DB_MODE()) {
      RECORDS = await window.TraxWaxData();
      // Wave 2 B1: reset first (defensive) so a stale friend ctx never renders badges on the own crate;
      // then, on a FRIEND crate only, load the viewer's own wants/haves (badges) + the match counts (stat).
      window.__twMatchCtx = null; window.__twOwnerWants = null;   // #28: __twOwnerWants is an array of {id, master}
      window.__twInventory = null;   // Wave 4: own-crate for-sale map (release_id → listing_id); null on friend crate
      if (!IS_OWN() && window.TraxWaxMatchCtx) {
        try { window.__twMatchCtx = await window.TraxWaxMatchCtx(); } catch (e) { window.__twMatchCtx = null; }
        // #43: AWAIT the owner-wantlist entries so the "they want" count is ready at first paint — never a
        // transient null that _matchCounts would misread as PRIVATE. Fetch failure → empty array (best-effort
        // real 0 on a shared list; self-heals on reload), never "PRIVATE" (that's flag-driven).
        try { window.__twOwnerWants = await window.TraxWaxOwnerWantIds(); } catch (e) { window.__twOwnerWants = []; }
        // Wave 4 Stage 2: the FRIEND's consented for-sale (empty Map unless friends + crate-friends + forsale=friends).
        // Wire it as ctx.forSale so badgesFor lights the FOR SALE badge; __twInventory also drives forSaleHref
        // (→ the friend's /sell/item/{listing}) + the FOR SALE facet — the Stage 1 own-crate surfaces, reused.
        try { window.__twInventory = window.TraxWaxFriendForSale ? await window.TraxWaxFriendForSale() : new Map(); }
        catch (e) { window.__twInventory = new Map(); }
        if (window.__twMatchCtx) window.__twMatchCtx.forSale = window.__twInventory;
      }
      if (IS_OWN() && window.TraxWaxInventory) {   // Wave 4: load the caller's for-sale listings for badges/facet/ledger/modal
        try { window.__twInventory = await window.TraxWaxInventory(); } catch (e) { window.__twInventory = new Map(); }   // never strand the render
      }
      // Wave 2: a hash-restored WANTLIST tab needs its dataset loaded on a direct reload (the case 'view'
      // lazy-load never ran). Mirror that load; render() below paints the briefly-empty grid, then this
      // fills it. Own+DB only — guaranteed by _validTabs above.
      if ((state.view==='wantlist' || (state.view==='ledger' && !IS_OWN())) && WANTLIST_RECORDS===null && window.TraxWaxWantlistData) {
        WANTLIST_RECORDS=[]; _wlLoading=true;
        window.TraxWaxWantlistData().then((rows)=>{ WANTLIST_RECORDS=rows; _wlLoading=false; render(); })
          .catch((e)=>{ console.warn('wantlist load failed', e); WANTLIST_RECORDS=null; _wlLoading=false; });
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
  // Wave 5a: seed the filter/sort state from ?params — AFTER the resets (top of bootCrate) and the data awaits
  // above (so __twInventory/__twMatchCtx exist for the context-gated forsale/match), and BEFORE the first
  // render so the opening paint is already filtered. Passes _bootSelling so the #selling deep-link's youWant+
  // forsale isn't second-guessed by a stray ?match param.
  _applyUrlFilters(_bootSelling);
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
