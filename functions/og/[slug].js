/* GET /og/:slug — the 1200×630 unfurl card (Wave 5b spec §7; plan T7b). Server-rendered per
   crate with workers-og (satori → resvg), cached at the edge via caches.default. NULL crate
   (unknown/all-private) → 404, never a card for a private crate; the 300s TTL is the revocation
   window — a decision, not a perf setting (plan audit F16). Do not raise it without re-arguing
   revocation. The ?v= buster from /c/'s meta rolls the URL when count/styles/palette move.

   Geometry is LOCKED (spec §7) — copy it, don't taste it. The three palettes are identical in
   geometry; which renders comes from the owner's og_palette, never a query param (a shared link
   must not force someone else's card off-palette). Satori speaks flexbox only, so spec's stats
   "grid" is emulated with two end-aligned flex columns; text-transform is unsupported, so
   uppercasing happens in JS. */

import { ImageResponse } from 'workers-og';
import { SEC_HEADERS } from '../_shared/headers.js';
import { fetchWithTimeout } from '../_shared/http.js';

const SUPABASE_URL = 'https://sfipqknrbvamwwahwxnl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_RLxgLYBzZoh5YCkYJ3NJZw_8BLFMIWg';

const PALETTES = {
  white: { ground: '#ffffff', type: '#16171a', dim: '#54585f',
           noun: '#e8194b', count: '#e8194b', rule: '#16171a',
           mark: '#16171a', markBorder: null, well: '#e4e6e9' },
  red:   { ground: '#e8194b', type: '#ffffff', dim: 'rgba(255,255,255,.82)',
           noun: '#16171a', count: '#ffffff', rule: '#16171a',
           mark: '#16171a', markBorder: null, well: '#c4143f' },
  black: { ground: '#0e0f11', type: '#f0efed', dim: '#b4b7bd',
           noun: '#e8194b', count: '#e8194b', rule: '#f0efed',
           mark: '#16171a', markBorder: '#3a3d44', well: '#212329' },
};

/* Audit S2-F1: satori/workers-og never DECODE entities — HTML-escaping renders literally
   ("Drum &amp; Bass" on the card; live data has Rock & Roll ×114). For card TEXT, pass & and
   quotes through raw and neutralize only the angle brackets workers-og's regex parser could
   misread, with lookalike glyphs (never dropped — a style named "<Fake>" still reads). */
const txt = (s) => String(s ?? '').replace(/</g, '\u2039').replace(/>/g, '\u203a');

/* The six cover URLs come pre-selected and pre-ordered from get_public_crate_summary (recency:
   added desc, then insert id desc). Fetch each (3s timeout) → data URI; a failed or non-https
   entry drops out (spec's few-covers degradation), and the array collapses left. */
async function coverUris(urls) {
  const one = async (url) => {
    if (!url || !/^https:\/\//.test(url)) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 400000) return null;   // a thumb should be tens of KB; skip monsters
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
      return `data:${mime};base64,${btoa(bin)}`;
    } catch (e) { return null; }
  };
  return (await Promise.all((urls || []).map(one))).filter(Boolean);
}

/* Anton advance width ≈ 0.5em; the text column is ~692px (1200 − 64·2 − 340 − 40 col-gap +
   covers' own transform slack). Single line at 92px ⇒ big variant; wrapped ⇒ compact (spec §7
   rule), as does any style name over 15 chars. Deterministic estimate, eyeballed against the
   reference renders at rehearsal. */
const TEXT_COL = 692;
function headlineFits(nameWithS, noun) {
  // Anton caps average ≈ 0.42em advance (calibrated against the locked reference:
  // "LANE B.'S CRATE" = one line; "BARTHOLOMEW W.'S CRATE" = two → compact). +1 = the space.
  return (nameWithS.length + 1 + noun.length) * 92 * 0.42 <= TEXT_COL;
}

export function buildCardHtml(d, slug) {
  const P = PALETTES[d.owner.og_palette] || PALETTES.red;
  const crateIsPublic = d.sections.crate === true;
  const name = (d.owner.display_name || 'A Collector').toUpperCase();
  const noun = crateIsPublic ? 'CRATE' : 'WANTLIST';
  const kicker = crateIsPublic ? 'A CRATE ON TRAXWAX' : 'A WANTLIST ON TRAXWAX';
  const countLabel = crateIsPublic ? 'RECORDS' : 'WANTED';
  const count = (Number(d.count) || 0).toLocaleString('en-US');

  // Top-3 styles derived server-side (get_public_crate_summary), already count-ordered.
  const styles = Array.isArray(d.top_styles) ? d.top_styles.slice(0, 3) : [];

  const oneLine = headlineFits(name + '’S', noun);
  const compact = !oneLine || styles.some((s) => s.length > 15);   // spec §7: ellipsis is never acceptable

  const covers = d._covers || [];
  const gap = 16;   // audit S2-F9: the two-cover 24px rule predates the always-six-slots grid
  // Six slots always (the reference shows the empty grid on a cover-less crate): a slot with a
  // cover shows it; an empty slot shows the palette's tile well. Frames in the rule color.
  const slots = Array.from({ length: 6 }, (_, i) => covers[i] || null);
  const tiles = slots.map((uri) =>
    `<div style="display:flex; width:150px; height:150px; border:5px solid ${P.rule}; background:${P.well}; box-shadow:0 1px 3px rgba(0,0,0,.35)">` +
    (uri ? `<img src="${uri}" width="140" height="140" style="width:140px; height:140px; object-fit:cover" />` : '') +
    `</div>`
  ).join('');

  const headline = oneLine
    ? `<div style="display:flex; font-family:'Anton'; font-size:92px; line-height:0.92; color:${P.type}">` +
        `<span>${txt(name)}’S</span><span style="color:${P.noun}; margin-left:22px">${noun}</span></div>`
    : `<div style="display:flex; flex-direction:column; font-family:'Anton'; font-size:92px; line-height:0.92; color:${P.type}">` +
        `<span>${txt(name)}’S</span><span style="color:${P.noun}">${noun}</span></div>`;

  const countStyle = compact
    ? `font-size:120px; line-height:0.88; letter-spacing:-1.2px; margin-left:-3px; margin-bottom:-13px`
    : `font-size:190px; line-height:0.86; letter-spacing:-2.85px; margin-left:-5px`;
  const stylesStyle = compact
    ? `font-size:34px; line-height:1.12; margin-bottom:-12px`
    : `font-size:50px; line-height:1.12`;

  return `
  <div style="display:flex; flex-direction:column; width:1200px; height:630px; background:${P.ground}; padding:56px 64px 48px; font-family:'IBM Plex Mono'">
    <div style="display:flex; flex:1">
      <div style="display:flex; flex-direction:column; flex:1; min-width:0">
        <div style="display:flex; align-self:flex-start; background:${P.mark}; color:#ffffff; font-family:'Anton'; font-size:48px; padding:13px 16px 11px; transform:rotate(-1.2deg); transform-origin:left center${P.markBorder ? `; border:2px solid ${P.markBorder}` : ''}">TRAXWAX</div>
        <div style="display:flex; margin-top:22px; font-size:22px; letter-spacing:3.5px; color:${P.dim}">${kicker}</div>
        <div style="display:flex; margin-top:18px">${headline}</div>
        <div style="display:flex; margin-top:auto; margin-bottom:26px; align-items:flex-end">
          <div style="display:flex; flex-direction:column">
            <div style="display:flex; font-size:20px; letter-spacing:2.8px; color:${P.dim}">${countLabel}</div>
            <div style="display:flex; font-family:'Barlow Condensed'; font-weight:700; color:${P.count}; ${countStyle}">${count}</div>
          </div>
          ${styles.length ? `<div style="display:flex; flex-direction:column; margin-left:40px; min-width:0">
            <div style="display:flex; font-size:20px; letter-spacing:2.8px; color:${P.dim}">TOP STYLES</div>
            <div style="display:flex; flex-direction:column; font-family:'Barlow Condensed'; font-weight:700; color:${P.type}; margin-top:4px; ${stylesStyle}">
              ${styles.map((s) => `<span>${txt(s)}</span>`).join('')}
            </div>
          </div>` : ''}
        </div>
      </div>
      <div style="display:flex; width:340px; margin-left:40px; align-items:center; justify-content:center; transform:translate(6px,-8px) rotate(1.5deg) scale(0.89)">
        <div style="display:flex; flex-wrap:wrap; width:${150 * 2 + gap}px; gap:${gap}px; justify-content:center">${tiles}</div>
      </div>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; border-top:3px solid ${P.rule}; margin-top:14px; padding-top:12px">
      <div style="display:flex; font-size:20px; font-weight:700; color:${P.type}">traxwax.com/c/${txt(slug)}</div>
      <div style="display:flex; font-size:20px; color:${P.dim}">Data provided by Discogs · not affiliated with Discogs</div>
    </div>
  </div>`;
}

async function loadFonts(env, request) {
  const pull = async (path) => {
    const r = await env.ASSETS.fetch(new URL('/fonts-og/' + path, request.url));
    if (!r.ok) throw new Error('font missing: ' + path);
    return r.arrayBuffer();
  };
  // Two files per face: latin + latin-ext; satori falls back per-glyph across same-name entries.
  const [a1, a2, b1, b2, m1, m2, mb1, mb2] = await Promise.all([
    pull('Anton-400-latin.ttf'), pull('Anton-400-latin-ext.ttf'),
    pull('BarlowCondensed-700-latin.ttf'), pull('BarlowCondensed-700-latin-ext.ttf'),
    pull('IBMPlexMono-400-latin.ttf'), pull('IBMPlexMono-400-latin-ext.ttf'),
    pull('IBMPlexMono-700-latin.ttf'), pull('IBMPlexMono-700-latin-ext.ttf'),
  ]);
  return [
    { name: 'Anton', data: a1, weight: 400, style: 'normal' },
    { name: 'Anton', data: a2, weight: 400, style: 'normal' },
    { name: 'Barlow Condensed', data: b1, weight: 700, style: 'normal' },
    { name: 'Barlow Condensed', data: b2, weight: 700, style: 'normal' },
    { name: 'IBM Plex Mono', data: m1, weight: 400, style: 'normal' },
    { name: 'IBM Plex Mono', data: m2, weight: 400, style: 'normal' },
    { name: 'IBM Plex Mono', data: mb1, weight: 700, style: 'normal' },
    { name: 'IBM Plex Mono', data: mb2, weight: 700, style: 'normal' },
  ];
}

export async function onRequestGet(context) {
  const { params, request, env } = context;
  const slug = String(params.slug || '');
  const notFound = () => new Response(null, { status: 404,
    headers: { ...SEC_HEADERS, 'Cache-Control': 'public, max-age=300' } });
  if (!/^[a-z0-9](?:[a-z0-9-]{0,16}[a-z0-9])?$/.test(slug)) {
    return notFound();   // malformed: no cache entry needed (regex is cheaper than the cache)
  }

  // Edge cache — explicit, not header-wished (audit F6); mirror [id].js's caches.default idiom.
  // #114: the POSITIVE key is CONTENT-keyed (pathname + a hash of count|topStyle|palette — the
  // same formula /c/ uses for its ?v buster; keep in lockstep) so a palette/count/style change
  // renders fresh immediately, while client-supplied query strings stay ignored (the S2-F4
  // amplification defense holds — an attacker's ?v never varies the key). The lookup therefore
  // happens AFTER the RPC: every request pays the RPC round-trip; the expensive part (satori
  // render + cover fetches) stays cached. The 404 keeps the bare-pathname key (no content
  // states to hash); a slug going live inside a cached 404's 300s is the accepted window.
  const _u = new URL(request.url);
  const nfKey = new Request(_u.origin + _u.pathname, { method: 'GET' });
  const nfCached = await caches.default.match(nfKey);
  if (nfCached && nfCached.status === 404) return nfCached;   // status-gated: v1.30.0-era 200s under this key must not short-circuit

  let d = null;
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/get_public_crate_summary`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_slug: slug }),
    });
    if (r.ok) d = await r.json();
  } catch (e) { /* fall through to 404 (not cached long; a blip self-heals) */ }
  if (!d || d.status !== 'ok') {
    // Audit S2-F6: negative-cache the miss ([id].js B2 precedent) — a scrape/poll of an unknown
    // or revoked slug must not buy an RPC per request. 300s keeps revocation semantics.
    const nf = notFound();
    context.waitUntil(caches.default.put(nfKey, nf.clone()).catch(() => {}));   // degrade uncached, keep the log clean
    return nf;
  }

  // #114: the content hash — count|topStyle|palette, identical to /c/'s ?v formula.
  // count/top style now come from get_public_crate_summary (same values → same hash → cache stable).
  const _top = (Array.isArray(d.top_styles) && d.top_styles[0]) || '';
  const _v = [Number(d.count) || 0, _top, d.owner.og_palette || 'red'].join('|');
  let _vh = 0; for (let i = 0; i < _v.length; i++) _vh = (_vh * 31 + _v.charCodeAt(i)) >>> 0;
  const cacheKey = new Request(_u.origin + _u.pathname + '?v=' + _vh.toString(36), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  d._covers = await coverUris(d.covers);

  const resp = new ImageResponse(buildCardHtml(d, slug), {
    width: 1200,
    height: 630,
    fonts: await loadFonts(env, request),
  });
  // #112 (REPRODUCED): the streamed body produced empty 200s on cold isolates — buffer once;
  // client and cache are served from the same bytes and can never diverge.
  const png = await resp.arrayBuffer();
  const headers = { ...SEC_HEADERS, 'Content-Type': 'image/png',
                    'Cache-Control': 'public, max-age=300' };
  context.waitUntil(caches.default.put(cacheKey,
    new Response(png.slice(0), { headers })).catch(() => {}));
  return new Response(png, { headers });
}
