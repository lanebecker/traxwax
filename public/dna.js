/* TraxWax — Collection DNA card. Aggregates only (Discogs API Terms: no titles, no ownership list,
   no prices). Three fixed layouts, 1080×1080, rendered to <canvas>. Attribution is mandatory on all.
   Coordinates: docs/../traxwax-wave5-design/TRAXWAX-WAVE-5A-DESIGN-SPEC.md §5 (measured from the signed-off
   render). Card A reads the ORIGINAL-RELEASE (master) year via r.releaseYear (boot.js projects master_year
   with a pressing-year fallback). */
'use strict';

const NON_COLOR_SEGMENT = [
  /^\d+([.,]\d+)?\s*-?\s*(g|gm|gr|gram|grams)\.?$/, /^(double\s+)?gatefold$/,
  /^(boxset|box set|digipak|slipcase|tri-?fold|bookback)$/, /^autographed(\s+jacket)?$/,
  /anniversary(\s+edition)?$/, /^(deluxe|definitive|listener|expanded|remastered|collector'?s?|standard|limited)\s+edition$/,
  /pressing$/, /^half speed master$/, /^limited to \d+$/, /^po box address$/, /^coordinates$/, /^\d+\s*rpm$/, /^(mono|stereo)$/,
];
// DUPLICATED from app.js on purpose: app.js is a classic script with no exports. Keep the two in sync
// (a colored-count parity check guards this — verified identical to app.js:160-182 at build time).
function isColored(text){
  const raw=(text||'').trim(); if(!raw) return false;
  const segs=raw.split(',').map(s=>s.replace(/\s*\[[^\]]*\]/g,'').trim().toLowerCase()).filter(Boolean);
  return segs.some(s=>!/^black( vinyl)?$/.test(s) && !NON_COLOR_SEGMENT.some(re=>re.test(s)));
}
const rank=(arr,n)=>{ const c=new Map(); for(const x of arr) if(x) c.set(x,(c.get(x)||0)+1);
  return [...c.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n).map(([label,count])=>({label,count})); };

export function computeStats(records, owner){
  const R=Array.isArray(records)?records:[];
  const total=R.length;
  const yrs=R.map(r=>Number(r.releaseYear ?? r.year)).filter(y=>y>1900);   // D0: master year, pressing year as fallback
  const decades={}; yrs.forEach(y=>{ const d=Math.floor(y/10)*10; decades[d]=(decades[d]||0)+1; });
  const decadeList=Object.keys(decades).map(Number).sort((a,b)=>a-b).map(d=>({decade:d,label:String(d).slice(2)+'s',count:decades[d]}));
  const peak=decadeList.slice().sort((a,b)=>b.count-a.count)[0]||null;
  const colored=R.filter(r=>isColored(r.vinyl)).length;
  const now=new Date(); const thisYear=String(now.getFullYear());
  const months=[]; for(let i=11;i>=0;i--){ const d=new Date(now.getFullYear(),now.getMonth()-i,1); months.push({key:d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'),count:0,label:d.toLocaleString('en-US',{month:'short'}).toUpperCase()}); }
  const mIdx=new Map(months.map((m,i)=>[m.key,i]));
  R.forEach(r=>{ const k=(r.added||'').slice(0,7); if(mIdx.has(k)) months[mIdx.get(k)].count++; });
  const artistOf=r=>{ const a=(r.artist||'').trim(); return /^various( artists)?$/i.test(a)?null:a; };   // D5
  return {
    total, colored, coloredPct: total?Math.round(colored/total*100):0, black: total-colored,
    minYear: yrs.length?Math.min(...yrs):null, maxYear: yrs.length?Math.max(...yrs):null,
    decades: decadeList, peak, peakPct: (peak&&yrs.length)?Math.round(peak.count/yrs.length*100):0,
    topStyles: rank(R.flatMap(r=>r.styles||[]),5),
    topGenres: rank(R.flatMap(r=>r.genres||[]),5),
    topArtists: rank(R.map(artistOf),5),
    topLabels: rank(R.map(r=>r.label),5),
    nStyles: new Set(R.flatMap(r=>r.styles||[])).size,
    nArtists: new Set(R.map(artistOf).filter(Boolean)).size,
    addedThisYear: R.filter(r=>(r.added||'').slice(0,4)===thisYear).length,
    months,
    collectingSince: owner&&owner.collectingSince?String(owner.collectingSince):null,   // profile field — label as such (D6)
  };
}

/* ── drawing helpers ─────────────────────────────────────────────────────── */
const fmt=n=>Number(n).toLocaleString('en-US');
function text(ctx,s,x,y,{font,color,align='left',tracking=0,baseline='alphabetic'}){
  ctx.font=font; ctx.fillStyle=color; ctx.textAlign=align; ctx.textBaseline=baseline;
  if(!tracking){ ctx.fillText(s,x,y); return; }
  // canvas has no letter-spacing everywhere yet (Safari) — draw per glyph
  let w=0; const glyphs=[...s].map(g=>{ const gw=ctx.measureText(g).width; w+=gw+tracking; return {g,gw}; }); w-=tracking;
  let cx = align==='right'?x-w : align==='center'?x-w/2 : x; ctx.textAlign='left';
  for(const {g,gw} of glyphs){ ctx.fillText(g,cx,y); cx+=gw+tracking; }
}
function wordmark(ctx,x,y,size,border){
  // Anton block, rotated -1.2deg about its LEFT-CENTER, black in every theme (Design Kit v1 §1). Padding 17/21/15 at 64px, scaled.
  const s=size/64; const padX=21*s, padT=17*s, padB=15*s;
  ctx.save(); ctx.translate(x,y+(size+padT+padB)/2); ctx.rotate(-1.2*Math.PI/180); ctx.translate(0,-(size+padT+padB)/2);
  ctx.font=`400 ${size}px Anton`; const w=ctx.measureText('TRAXWAX').width+padX*2, h=size+padT+padB;
  ctx.fillStyle='#16171a'; ctx.fillRect(0,0,w,h);
  if(border){ ctx.strokeStyle=border; ctx.lineWidth=1.5; ctx.strokeRect(0,0,w,h); }
  ctx.fillStyle='#fff'; ctx.textAlign='left'; ctx.textBaseline='alphabetic'; ctx.fillText('TRAXWAX',padX,padT+size*0.86);
  ctx.restore();
}
function ellipsize(ctx,s,max){ if(ctx.measureText(s).width<=max) return s; while(s.length&&ctx.measureText(s+'…').width>max) s=s.slice(0,-1); return s+'…'; }

const MONO="'IBM Plex Mono', monospace", COND="'Barlow Condensed', sans-serif", ANTON="Anton, sans-serif";

/* Coordinates given as the TOP of a CSS line box; we draw with textBaseline='top' + a per-font ascent nudge. */
const NUDGE={mono:0.12,cond:0.06,anton:0.04};   // fraction of font-size from line-box top to glyph top, per family
function row(ctx,s,x,top,size,fam,weight,color,{align='left',tracking=0,alpha=1}={}){
  const family=fam==='mono'?MONO:fam==='cond'?COND:ANTON;
  ctx.save(); ctx.globalAlpha=alpha;
  text(ctx,s,x,top+size*NUDGE[fam],{font:`${weight} ${size}px ${family}`,color,align,tracking,baseline:'top'});
  ctx.restore();
}
function header(ctx,S,inkColor,blockBorder){
  wordmark(ctx,72,44,64,blockBorder);
  row(ctx,'COLLECTION DNA',1008,69,36,'mono',400,inkColor,{align:'right',tracking:5.04});
}

/* ── Card A · THE DECADES (light) ────────────────────────────────────────── */
function drawA(ctx,S){
  const ink='#16171a', muted='#54585f', accent='#e8194b';
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,1080,1080);
  header(ctx,S,ink,null);
  row(ctx,'PEAK DECADE',72,192,36,'mono',400,muted,{tracking:5.04});
  row(ctx,S.peak?String(S.peak.decade)+'s':'—',72,250,260,'anton',400,ink,{tracking:-2.6});
  ctx.font=`600 56px ${COND}`; ctx.fillStyle=ink; ctx.textAlign='left'; ctx.textBaseline='top';
  const lede=S.peak?`${S.peakPct}% of ${fmt(S.total)} records, released this decade.`:'No release years on file yet.';
  ctx.fillText(ellipsize(ctx,lede,934),72,500+56*NUDGE.cond);
  const bars=S.decades.length?S.decades:[{label:'—',count:0}];
  const n=bars.length, gap=14, bw=(934-gap*(n-1))/n, maxC=Math.max(1,...bars.map(b=>b.count));
  bars.forEach((b,i)=>{ const x=72+i*(bw+gap), h=Math.max(10,Math.round(b.count/maxC*190)), top=852-h;
    ctx.fillStyle=(S.peak&&b.decade===S.peak.decade)?accent:ink; ctx.fillRect(x,top,bw,h);   // accent the peak decade by identity, not count (tie-safe)
    row(ctx,fmt(b.count),x+bw/2,top-59,36,'mono',400,muted,{align:'center'});
    row(ctx,b.label,x+bw/2,864,38,'mono',400,ink,{align:'center',tracking:1.52}); });
  ctx.fillStyle=ink; ctx.fillRect(72,967,934,4);
  row(ctx,`${S.minYear??'—'} → ${S.maxYear??'—'}`,72,989,36,'mono',700,ink);
  row(ctx,'Data provided by Discogs',1008,989,36,'mono',400,ink,{align:'right'});
}

/* ── Card B · THE STAT WALL (dark) ───────────────────────────────────────── */
function drawB(ctx,S){
  const ink='#f0efed', muted='#b4b7bd', line='#3a3d44', hair='#2b2d33', accent='#e01046', light='#f0efed', dark='#17181b', black='#16171a', lmuted='#54585f';
  ctx.fillStyle='#0e0f11'; ctx.fillRect(0,0,1080,1080);
  header(ctx,S,ink,line);
  const cells=[
    {x:72, y:162,w:463,h:231,bg:light,label:'RECORDS',     val:fmt(S.total),      lc:lmuted, vc:black},
    {x:543,y:162,w:463,h:231,bg:accent,label:'COLORED WAX', val:S.coloredPct+'%',  lc:'rgba(255,255,255,.85)', vc:'#ffffff'},
    {x:72, y:401,w:463,h:235,bg:dark, label:'STYLES',      val:fmt(S.nStyles),    lc:muted,  vc:ink, border:line},
    {x:543,y:401,w:463,h:235,bg:light,label:'ARTISTS',     val:fmt(S.nArtists),   lc:lmuted, vc:black},
  ];
  for(const c of cells){ ctx.fillStyle=c.bg; ctx.fillRect(c.x,c.y,c.w,c.h);
    if(c.border){ ctx.strokeStyle=c.border; ctx.lineWidth=2; ctx.strokeRect(c.x+1,c.y+1,c.w-2,c.h-2); }
    row(ctx,c.label,c.x+30,c.y+24,34,'mono',400,c.lc,{tracking:4.08});
    row(ctx,c.val,c.x+30,c.y+77,128,'cond',700,c.vc); }
  row(ctx,'MOST-FILED STYLES',72,667,34,'mono',400,muted,{tracking:4.08});
  ctx.fillStyle=line; ctx.fillRect(72,726,934,2);
  S.topStyles.slice(0,3).forEach((r,i)=>{ const top=726+i*79;
    row(ctx,String(i+1),72,top+23,34,'mono',400,muted);
    ctx.font=`600 52px ${COND}`; ctx.fillStyle=ink; ctx.textAlign='left'; ctx.textBaseline='top'; ctx.fillText(ellipsize(ctx,r.label,760),148,top+6+52*NUDGE.cond);
    row(ctx,fmt(r.count),1008,top+17,40,'mono',400,muted,{align:'right'});
    ctx.fillStyle=hair; ctx.fillRect(72,top+78,934,1); });
  ctx.fillStyle=line; ctx.fillRect(72,961,934,2);
  row(ctx,S.collectingSince?`SINCE ${S.collectingSince}`:'FILED ON TRAXWAX',72,989,36,'mono',400,muted);
  row(ctx,'Data provided by Discogs',1008,989,36,'mono',400,ink,{align:'right'});
}

/* ── Card C · THE SPLIT (accent) ─────────────────────────────────────────── */
function drawC(ctx,S){
  const white='#ffffff', ink='#16171a';
  ctx.fillStyle='#e8194b'; ctx.fillRect(0,0,1080,1080);
  header(ctx,S,white,null);
  row(ctx,S.coloredPct+'%',64,184,300,'anton',400,white,{tracking:-6});
  ctx.font=`600 56px ${COND}`; ctx.fillStyle=white; ctx.textAlign='left'; ctx.textBaseline='top';
  ctx.fillText(ellipsize(ctx,`of ${fmt(S.total)} records are on colored wax.`,934),72,487+56*NUDGE.cond);
  row(ctx,`COLORED VINYL · ${fmt(S.colored)}`,72,602,36,'mono',700,white);
  row(ctx,`BLACK VINYL · ${fmt(S.black)}`,1008,602,36,'mono',700,white,{align:'right'});
  const cw=Math.round(926*(S.total?S.colored/S.total:0));
  ctx.fillStyle=white; ctx.fillRect(76,667,cw,88); ctx.fillStyle=ink; ctx.fillRect(76+cw,667,926-cw,88);
  ctx.strokeStyle=ink; ctx.lineWidth=4; ctx.strokeRect(74,665,930,92);
  const cells=[['MOST-FILED STYLE',S.topStyles[0]?S.topStyles[0].label:'—'],
    S.collectingSince?['COLLECTING SINCE',S.collectingSince]:['PRESSED SINCE',(S.minYear!=null?String(S.minYear):'—')]];
  cells.forEach(([l,v],i)=>{ const x=72+i*485; ctx.fillStyle=white; ctx.fillRect(x,815,449,4);
    row(ctx,l,x,835,34,'mono',400,white,{tracking:4.08,alpha:.85});
    ctx.font=`700 72px ${COND}`; ctx.fillStyle=white; ctx.textAlign='left'; ctx.textBaseline='top'; ctx.fillText(ellipsize(ctx,String(v),449),x,889+72*NUDGE.cond); });
  row(ctx,'traxwax.com',72,987,36,'mono',400,white,{alpha:.85});
  row(ctx,'Data provided by Discogs',1008,987,36,'mono',400,white,{align:'right'});
}

const DRAW={A:drawA,B:drawB,C:drawC};
export async function renderCard(canvas, variant, stats){
  // fonts are already linked by app/index.html; wait so the first paint isn't a fallback face
  try{ await Promise.all(['400 64px Anton',`700 128px ${COND}`,`600 56px ${COND}`,`400 36px ${MONO}`,`700 36px ${MONO}`].map(f=>document.fonts.load(f))); }catch(e){}
  canvas.width=1080; canvas.height=1080;
  const ctx=canvas.getContext('2d'); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,1080,1080);
  (DRAW[variant]||drawA)(ctx,stats);
}
