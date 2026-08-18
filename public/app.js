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
  ownerLine: "Lane's shelf · filed by whim",
};

/* ── SEAM 2 — LIVE DISCOGS CALLS ───────────────────────────────────────────
   These hit the Cloudflare Pages Function proxy (functions/api/*), which holds
   the Discogs token server-side. Each call degrades gracefully to baked/mock data
   so the site still works locally (no proxy) and if Discogs is unreachable. */
const api = {
  async value(){
    try { const r = await fetch('/api/value'); if (!r.ok) throw 0; const d = await r.json(); return d.median || d.minimum || null; }
    catch(e) { return null; }
  },
  async price(rec){
    try { const r = await fetch('/api/price/' + rec.id); if (!r.ok) throw 0; const d = await r.json(); return d.price; }
    catch(e) { return rec.price; }
  },
};

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
const COLOR_WORDS = Object.keys(COLORS).filter(k=>k!=='black')
  .concat(['flamingo','splatter','swirl','starburst','nova','cornetto','tri-color','marble','wave','smoke','coke bottle','beer','milky','opaque']);
function isColored(text){
  const t=(text||'').toLowerCase();
  if(!t) return false;
  if(/^black( vinyl)?$/.test(t.trim())) return false;
  return COLOR_WORDS.some(w=>t.includes(w));
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
const THIS_MONTH = new Date().toISOString().slice(0,7);

/* ── State ─────────────────────────────────────────────────────────────────── */
let RECORDS = [];
const state = {
  theme:'light', view:'crate', query:'', genres:[], coloredOnly:false,
  artist:null, color:null, sort:'added', dir:-1, detailId:null, headerValue:null,
};
let _refocusSearch = false;

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
  if(s.coloredOnly && !isColored(r.vinyl)) return false;
  if(s.artist && r.artist!==s.artist) return false;
  if(s.color && shortVinyl(r.vinyl)!==s.color) return false;
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
    price:r=>String(r.price==null?0:r.price).padStart(9,'0') }[s.sort];
  return list.slice().sort((a,b)=>(key(a)<key(b)?-1:key(a)>key(b)?1:0)*s.dir);
}
function deco(r){
  const coverUrl = r.cover_image || r.thumb || '';   // prefer the 600px cover_image; fall back to the 150px thumb
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

/* ── Card ──────────────────────────────────────────────────────────────────── */
function card(r){
  const showP = SETTINGS.showPrices;
  return `<div style="min-width:0; background:var(--panel); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow); display:flex; flex-direction:column">
    <div style="position:relative; padding:6px 6px 0">
      <button data-act="open" data-arg="${r.id}" title="Open detail" style="display:block; width:100%; padding:0; border:0; background:transparent">
        <div role="img" aria-label="${esc(r.coverAlt)}" style="width:100%; aspect-ratio:1; background:var(--skel); background-image:${r.coverBg}; background-size:cover; background-position:center">${r.coverPlaceholder}</div>
      </button>
      ${r.isNew?`<span style="position:absolute; top:12px; left:0; background:var(--accent); color:var(--on-accent); font-family:'Archivo',sans-serif; font-size:9px; font-weight:800; letter-spacing:.14em; padding:3px 7px; transform:rotate(-2.5deg)">JUST IN</span>`:''}
    </div>
    <div style="min-width:0; padding:8px 9px 10px; display:flex; flex-direction:column; gap:5px">
      <button class="tw-artist" data-act="artist" data-arg="${esc(r.artist)}" style="text-align:left; padding:0; border:0; background:transparent; font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.08em; color:var(--faint); text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(r.artist)}</button>
      <button class="tw-title" data-act="open" data-arg="${r.id}" style="text-align:left; padding:0; border:0; background:transparent; font-family:'Barlow Condensed',sans-serif; font-size:20px; font-weight:700; line-height:1.02; color:var(--ink); text-wrap:pretty">${esc(r.title)}</button>
      <button data-act="color" data-arg="${esc(r.vinylShort)}" style="display:flex; align-items:center; gap:6px; margin-top:1px; padding:0; border:0; background:transparent; text-align:left">
        <span style="width:9px; height:9px; flex:none; border:1.5px solid var(--line); background:${r.swatch}"></span>
        <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(r.vinylShort)}</span>
      </button>
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:6px; border-top:1.5px solid var(--line); padding-top:6px; margin-top:2px">
        <span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; line-height:1.35; color:var(--faint); text-transform:uppercase">${esc(r.year)} · ${esc(r.style1)}</span>
        ${showP?`<span style="font-family:'IBM Plex Mono',monospace; font-size:10px; font-weight:700; flex:none; line-height:1.35">${r.priceLabel}</span>`:''}
      </div>
    </div>
  </div>`;
}

/* ── computeVals: the single source that render() draws from ─────────────────── */
function computeVals(){
  const s=state;
  if(SETTINGS.accent) document.documentElement.style.setProperty('--accent', SETTINGS.accent);
  const all=RECORDS;
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
  if(s.coloredOnly) active.push({kind:'WAX',value:'Colored only'});
  if(s.artist) active.push({kind:'ARTIST',value:s.artist});
  if(s.color) active.push({kind:'COLOR',value:s.color});
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
      {label:'Estimated value', value:valueLabel(total), note:priced.length?'Median of Discogs lows.':'Wired to the Discogs proxy next.', color:'var(--accent)'},
      {label:'On colored wax', value:coloredCount+'', note:Math.round((coloredCount/all.length)*100)+'% of the shelf.', color:'var(--ink)'},
      {label:'Added this month', value:newCount+'', note:'A restrained month, relatively.', color:'var(--ink)'},
    ],
  };
}

/* ── render ────────────────────────────────────────────────────────────────── */
function render(){
  const v=computeVals(); const s=state;
  const hasFilters=v.active.length>0;
  const showGrid=s.view==='crate' && v.filtered.length>0;
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
            : `<span style="font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--faint); line-height:1.6">Prices arrive once the Discogs proxy is wired.</span>`
          }</div>
        </div>
      </div>
    </div>`;
  } else if(showEmpty){
    content=`<div style="display:flex; flex-direction:column; align-items:center; gap:12px; padding:90px 24px 96px; text-align:center">
      <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.18em; color:var(--muted)">0 RESULTS</span>
      <span style="font-family:'Barlow Condensed',sans-serif; font-size:34px; font-weight:700; line-height:1.05">Nothing filed under that.</span>
      <span style="font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:var(--muted); max-width:440px; line-height:1.6">Either the taste is very specific, or that record simply isn't owned. Both are fixable.</span>
      <button data-act="clearAll" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:8px 14px; margin-top:6px; background:var(--accent); color:var(--on-accent); border:1.5px solid var(--line); box-shadow:3px 3px 0 var(--shadow)">CLEAR THE FILTERS</button>
    </div>`;
  }

  const html=`
  <div style="position:relative; max-width:1480px; margin:0 auto; background:var(--panel); border:1px solid var(--line); box-shadow:5px 5px 0 rgba(0,0,0,.16)">

    <header class="tw-header" style="position:relative; display:flex; align-items:flex-end; justify-content:space-between; gap:20px; padding:22px 24px 18px; background:var(--accent); border-bottom:3px solid var(--line)">
      <div class="tw-headL" style="display:flex; align-items:flex-end; gap:14px">
        <span style="background:#16171a; color:#fff; font-family:'Anton',sans-serif; font-size:44px; line-height:1; text-transform:uppercase; letter-spacing:.01em; padding:12px 14px 10px; transform:rotate(-1.2deg)">TraxWax</span>
        <span style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:rgba(255,255,255,.92); padding-bottom:6px">${esc(SETTINGS.ownerLine)}</span>
      </div>
      <div class="tw-headR" style="display:flex; align-items:center; gap:10px">
        <div style="display:flex; font-family:'IBM Plex Mono',monospace; font-size:11px; border:1.5px solid #16171a; background:#fff; color:#16171a">
          <span style="padding:6px 10px; border-right:1.5px solid #16171a">${v.all.length.toLocaleString('en-US')} IN CRATE</span>
          <span class="tw-hide-mobile" style="padding:6px 10px; border-right:1.5px solid #16171a">${v.coloredCount} COLORED</span>
          <span style="padding:6px 10px; border-right:1.5px solid #16171a">${esc(s.headerValue || valueLabel(v.total))} EST.</span>
          <span class="tw-hide-mobile" style="padding:6px 10px; background:#16171a; color:#fff; font-weight:700">+${v.newCount} THIS MONTH</span>
        </div>
        <button data-act="theme" title="Toggle theme" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:7px 11px; background:#fff; color:#16171a; border:1.5px solid #16171a">${s.theme==='dark'?'LIGHTS ON':'LIGHTS OUT'}</button>
      </div>
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
      ${tab('crate','THE CRATE')}${tab('timeline','THE TIMELINE')}${tab('ledger','THE LEDGER')}
      <div class="tw-sortwrap" style="margin-left:auto; display:flex; align-items:center; gap:14px; padding:0 20px">
        <span style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--muted)">${v.filtered.length} of ${v.all.length} shown</span>
        <div style="display:flex; align-items:center; border:1.5px solid var(--line)">
          ${sortBtn('added','ADDED')}${sortBtn('artist','ARTIST')}${sortBtn('year','YEAR')}${sortBtn('price','PRICE')}
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
  ${modalHtml()}`;

  const app=document.getElementById('app');
  app.innerHTML=html;

  if(_refocusSearch){
    const si=document.getElementById('tw-search');
    if(si){ si.focus(); const val=si.value; si.value=''; si.value=val; }
    _refocusSearch=false;
  }
}

/* ── Detail modal ──────────────────────────────────────────────────────────── */
function modalHtml(){
  const rec=RECORDS.find(r=>r.id===state.detailId);
  if(!rec) return '';
  const d=deco(rec);
  const rel=rec._rel;  // tracklist/country/videos from the baked release file (or live fallback), via _loadRelease
  const country=(rel && rel.country)?rel.country:'US';
  const subLine=(rec.year||'—')+' · '+(rec.label||'Unknown label')+' · '+country;
  const priceLabel = rec.price!=null ? money(rec.price) : '—';   // lowest sale — baked in collection.json
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
  const rating = rec.crating!=null ? (Number(rec.crating).toFixed(1)+' ('+(rec.crcount||0)+')') : '—';   // community rating (baked)
  const haveWant = (rec.have!=null && rec.want!=null) ? (rec.have.toLocaleString()+' / '+rec.want.toLocaleString()) : '—';

  return `<div data-act="closeDetail" class="tw-modal-ov" style="position:fixed; inset:0; background:rgba(10,10,12,.62); display:flex; align-items:flex-start; justify-content:center; padding:60px 20px; overflow:auto; z-index:50">
    <div data-act="stop" style="position:relative; width:840px; max-width:100%; background:var(--panel); border:1.5px solid var(--line); box-shadow:8px 8px 0 rgba(0,0,0,.4)">
      <div class="tw-modal-head" style="display:flex; gap:22px; padding:22px 24px 20px; border-bottom:2px solid var(--line)">
        <div role="img" aria-label="${esc(d.coverAlt)}" class="tw-modal-cover" style="width:190px; height:190px; flex:none; border:1.5px solid var(--line); background:var(--skel); background-image:${d.coverBg}; background-size:cover; background-position:center">${d.coverPlaceholder}</div>
        <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:8px">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--faint)">${esc(rec.artist)}</span>
          <span style="font-family:'Barlow Condensed',sans-serif; font-size:38px; font-weight:700; line-height:1; text-wrap:pretty">${esc(rec.title)}</span>
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
              <span style="font-family:'IBM Plex Mono',monospace; font-size:13px; font-weight:700">${priceLabel}</span>
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
            <a href="https://www.discogs.com/release/${rec.id}" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.06em; padding:7px 10px; border:1.5px solid var(--line); color:var(--ink); text-align:center">VIEW ON DISCOGS ↗</a>
            <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(rec.artist+' '+rec.title)}" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.06em; padding:7px 10px; border:1.5px solid var(--line); background:var(--accent); color:var(--on-accent); text-align:center">▶ LISTEN</a>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

async function openDetail(id){
  state.detailId=id;
  const rec=RECORDS.find(r=>r.id===id);
  if(rec){
    const c=_relCache[id];
    if(c && (Date.now()-(c.ts||0))<REL_TTL_MS){ rec._rel=c.d; rec._relErr=false; }   // instant from cache
    else { rec._rel=null; rec._relErr=false; }                                        // show loading, then fetch
  }
  render();
  if(rec && !rec._rel) await _loadRelease(rec);
}
async function _loadRelease(rec){
  let d = await _fetchReleaseFile(rec.id);   // baked static file (immutable, instant, no rate limit)
  if(!d) d = await _fetchReleaseLive(rec);   // fallback: live proxy for a not-yet-baked new record
  if(d){ rec._rel=d; rec._relErr=false; _relCache[rec.id]={ts:Date.now(), d}; _saveRelCache(); }
  else { rec._relErr=true; }
  if(state.detailId===rec.id) render();
}

/* ── Events (delegation) ───────────────────────────────────────────────────── */
function onClick(e){
  const t=e.target.closest('[data-act]'); if(!t) return;
  const act=t.dataset.act, arg=t.dataset.arg;
  switch(act){
    case 'theme': setTheme(state.theme==='dark'?'light':'dark'); render(); break;
    case 'view': state.view=arg; render(); break;
    case 'sort': state.sort=arg; render(); break;
    case 'dir': state.dir*=-1; render(); break;
    case 'genre': toggleGenre(arg); render(); break;
    case 'clearGenres': state.genres=[]; render(); break;
    case 'colored': state.coloredOnly=!state.coloredOnly; render(); break;
    case 'artist': state.artist=arg; state.detailId=null; render(); break;
    case 'color': state.color=arg; state.detailId=null; render(); break;
    case 'open': openDetail(Number(arg)); break;
    case 'retryDetail': { const r=RECORDS.find(x=>x.id===state.detailId); if(r){ r._relErr=false; render(); _loadRelease(r); } break; }
    case 'detailGenre': state.detailId=null; state.genres=[arg]; render(); break;
    case 'rm': removeFacet(t.dataset.kind, arg); render(); break;
    case 'clearAll': state.genres=[]; state.coloredOnly=false; state.artist=null; state.color=null; state.query=''; render(); break;
    case 'closeDetail': state.detailId=null; render(); break;
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
  if(e.target.id==='tw-search'){ state.query=e.target.value; _refocusSearch=true; render(); }
}

/* ── Boot ──────────────────────────────────────────────────────────────────── */
async function boot(){
  initTheme();
  document.getElementById('app').innerHTML=`<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--muted)">Loading the crate…</div>`;
  try{
    const res=await fetch('./collection.json'); RECORDS=await res.json();
  }catch(e){
    document.getElementById('app').innerHTML=`<div style="padding:120px 24px; text-align:center; font-family:'IBM Plex Mono',monospace; color:var(--accent)">Couldn't load collection.json</div>`;
    return;
  }
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  window.addEventListener('keydown', e=>{ if(e.key==='Escape' && state.detailId){ state.detailId=null; render(); } });
  render();
  api.value().then(v=>{ if(v){ state.headerValue=v; render(); } });   // live whole-collection EST. (one proxy call)
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot); else boot();
