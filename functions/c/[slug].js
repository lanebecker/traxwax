import { SEC_HEADERS } from '../_shared/headers.js';
import { fetchWithTimeout } from '../_shared/http.js';

/* GET /c/:slug — serves the SPA shell with per-crate og:* meta injected, so unfurl crawlers
   (which run no JS) see the crate card. Humans get the same HTML; boot.js reads the path and
   renders the public crate (Wave 5b T2). NULL from get_public_crate (unknown slug, all-private —
   indistinguishable by design, spec §6/§10) → the shell with generic meta and a 404 status;
   boot.js paints the 404 card client-side.

   Routing notes (Wave 5b plan T7-pre): this function owns /c/* via _routes.json "include";
   the /c rules in _redirects are a CONFIG-ROLLBACK fallback (Pages does NOT re-dispatch a throwing
   Function to the asset server), inert while this Function is routed and covering only bare /c.
   A bare /c (no slug) never reaches this file — it falls through to the static SPA fallback.

   env.ASSETS.fetch is the documented Pages-Functions static-asset binding. It has no precedent
   in this repo ([id].js only fetches upstream) — the branch preview is its first exercise; if it
   misbehaves there, the fallback is fetch(new URL('/app/', request.url)) against the deployment's
   own origin. */

const SUPABASE_URL = 'https://sfipqknrbvamwwahwxnl.supabase.co';
// Publishable anon key — same value public/boot.js ships; safe by design (definer RPC + RLS).
const SUPABASE_KEY = 'sb_publishable_RLxgLYBzZoh5YCkYJ3NJZw_8BLFMIWg';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* SEC_HEADERS moved to functions/_shared/headers.js (T3.6b #150) — the ONE copy that /c, /og
   and /api/release all import, so the security set can't drift between routes. It stays a
   MIRROR of public/_headers' /* block; keep the two in lockstep when either changes. */

export async function onRequestGet({ params, request, env }) {
  const slug = String(params.slug || '');
  const shellResp = await env.ASSETS.fetch(new URL('/app/', request.url));
  // Audit S2-F7: a broken/redirected asset response must never be dressed up as the page.
  if (!shellResp.ok) {
    // T3.6e (#153): attach SEC_HEADERS to even the broken-asset early return, while PRESERVING the
    // asset response's own headers (Content-Type/Location) + status — don't dress a redirected/errored
    // asset up as the page (audit S2-F7). Body passes through (null on 204/304, so no constructor throw).
    const h = new Headers(shellResp.headers);
    for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);
    h.set('Cache-Control', 'no-store');
    return new Response(shellResp.body,
      { status: shellResp.status, statusText: shellResp.statusText, headers: h });
  }
  let html = await shellResp.text();

  if (!/^[a-z0-9](?:[a-z0-9-]{0,16}[a-z0-9])?$/.test(slug)) {
    return new Response(html, { status: 404,
      headers: { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  let d = null;
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/get_public_crate_summary`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_slug: slug }),
    });
    if (r.ok) d = await r.json();
  } catch (e) { /* meta degrades to generic; the page still boots client-side */ }

  if (!d || d.status !== 'ok') {
    // NULL (unknown/all-private) → honest 404 status; an RPC hiccup (d===null too) also lands
    // here — same body, no-store, so a transient failure never caches a 404.
    return new Response(html, { status: 404,
      headers: { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  const name = d.owner.display_name || 'A Collector';
  const crateIsPublic = d.sections.crate === true;
  const n = Number(d.count) || 0;                         // leading-section count, from Postgres
  const noun = crateIsPublic ? 'Crate' : 'Wantlist';
  // Top style derived server-side (get_public_crate_summary top_styles); /c uses [0].
  const topStyle = (Array.isArray(d.top_styles) && d.top_styles[0]) || null;

  const title = `${name}'s ${noun} on TraxWax`;
  const desc = `${n.toLocaleString('en-US')} records${topStyle ? ` · mostly ${topStyle}` : ''}. Filed properly.`;
  // Cache-buster: the card re-renders when count/style/palette move (T7b caches by URL, 300s TTL).
  const v = [n, topStyle || '', d.owner.og_palette || 'red'].join('|');
  let vh = 0; for (let i = 0; i < v.length; i++) vh = (vh * 31 + v.charCodeAt(i)) >>> 0;
  const img = `https://traxwax.com/og/${slug}?v=${vh.toString(36)}`;

  const meta = [
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="https://traxwax.com/c/${esc(slug)}">`,
    `<meta property="og:image" content="${esc(img)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join('\n');

  // The shell ships its own <title>TraxWax</title> + meta description (audit F7) — a SECOND
  // title appended before </head> would lose to the first in every parser. Replace both.
  // Audit T1.3: FUNCTION replacements — the returned string is inserted literally, so a
  // display_name containing $ (e.g. "$&", "$`") can never be reinterpreted as a replace pattern.
  html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(title)}</title>`);
  html = html.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(desc)}">`);
  html = html.replace('</head>', () => meta + '\n</head>');
  return new Response(html, {
    headers: { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
               'Cache-Control': 'public, max-age=300' },
  });
}
