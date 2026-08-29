/* GET /api/release/:id — CC0 release detail (tracklist/country/released/videos) for the
   modal's LAST-RESORT fallback tier. Holds the token server-side.

   Phase 1 cold audit #24: this endpoint previously also served have/want/community rating,
   lowest_price and num_for_sale — Restricted Data under the Discogs API terms — to
   anonymous callers with a 7-day cache. Restricted data now flows ONLY through the
   authenticated live-stats Edge Function (per-user token, ≤6h ephemeral cache). What
   remains here is CC0 catalog data, which the long edge cache is appropriate for.
   /api/value and /api/price were deleted outright in the same audit. */

function json(o, status = 200, extra = {}) {
  return new Response(JSON.stringify(o), {
    status, headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export async function onRequestGet({ params, env }) {
  const id = String(params.id || '');
  if (!/^\d+$/.test(id)) return json({ error: 'bad id' }, 400);   // no SSRF / path abuse

  const cache = caches.default;
  const key = new Request('https://traxwax.internal/api/release-cc0/' + id);
  const cached = await cache.match(key);
  if (cached) return cached;

  const headers = {
    'Authorization': 'Discogs token=' + env.DISCOGS_TOKEN,
    'User-Agent': 'TraxWax/1.0 +https://traxwax.com',   // Discogs 403s without a UA
  };
  // Retry once on a 429 — a brief backoff usually clears the rate-limit window, so the
  // client gets the tracklist on the first open instead of failing to the retry UI.
  let upstream;
  for (let attempt = 0; attempt < 2; attempt++) {
    upstream = await fetch('https://api.discogs.com/releases/' + id, { headers });
    if (upstream.status !== 429) break;
    if (attempt === 0) await new Promise(r => setTimeout(r, 900));
  }
  if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, upstream.status === 429 ? 429 : 502);

  const d = await upstream.json();
  const slim = {
    tracks: (d.tracklist || []).filter(t => t.type_ !== 'heading')
      .map(t => ({ pos: t.position || '', title: t.title || '', dur: t.duration || '' })),
    country: d.country || '',
    released: d.released_formatted || d.released || '',
    videos: (d.videos || []).slice(0, 3).map(v => ({ title: v.title, uri: v.uri })),
  };
  const resp = json(slim, 200, { 'Cache-Control': 'public, max-age=604800' }); // 7d, CC0
  await cache.put(key, resp.clone());
  return resp;
}
