/* GET /api/release/:id — live Discogs release detail for the modal.
   Holds the token server-side (no CORS, token never reaches the browser),
   slims the payload, and edge-caches it for 7 days. */

function json(o, status = 200, extra = {}) {
  return new Response(JSON.stringify(o), {
    status, headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export async function onRequestGet({ params, env }) {
  const id = String(params.id || '');
  if (!/^\d+$/.test(id)) return json({ error: 'bad id' }, 400);   // no SSRF / path abuse

  const cache = caches.default;
  const key = new Request('https://traxwax.internal/api/release/' + id);
  const cached = await cache.match(key);
  if (cached) return cached;

  const upstream = await fetch('https://api.discogs.com/releases/' + id + '?curr_abbr=USD', {
    headers: {
      'Authorization': 'Discogs token=' + env.DISCOGS_TOKEN,
      'User-Agent': 'TraxWax/1.0 +https://traxwax.com',   // Discogs 403s without a UA
    },
  });
  if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, upstream.status === 429 ? 429 : 502);

  const d = await upstream.json();
  const slim = {
    tracks: (d.tracklist || []).filter(t => t.type_ !== 'heading')
      .map(t => ({ pos: t.position || '', title: t.title || '', dur: t.duration || '' })),
    have: d.community?.have ?? null,
    want: d.community?.want ?? null,
    ratingAvg: d.community?.rating?.average ?? null,
    ratingCount: d.community?.rating?.count ?? null,
    price: d.lowest_price ?? null,
    numForSale: d.num_for_sale ?? null,
    country: d.country || '',
    released: d.released_formatted || d.released || '',
    videos: (d.videos || []).slice(0, 3).map(v => ({ title: v.title, uri: v.uri })),
  };
  const resp = json(slim, 200, { 'Cache-Control': 'public, max-age=604800' }); // 7d
  await cache.put(key, resp.clone());
  return resp;
}
