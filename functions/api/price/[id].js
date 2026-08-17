/* GET /api/price/:id — live marketplace stats for a single release.
   Used for on-demand single-price refresh; the grid's baked prices come from the
   weekly bake step, not from calling this 1,850 times. Cached 1 day. */

function json(o, status = 200, extra = {}) {
  return new Response(JSON.stringify(o), {
    status, headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export async function onRequestGet({ params, env }) {
  const id = String(params.id || '');
  if (!/^\d+$/.test(id)) return json({ error: 'bad id' }, 400);

  const cache = caches.default;
  const key = new Request('https://traxwax.internal/api/price/' + id);
  const cached = await cache.match(key);
  if (cached) return cached;

  const upstream = await fetch('https://api.discogs.com/marketplace/stats/' + id + '?curr_abbr=USD', {
    headers: {
      'Authorization': 'Discogs token=' + env.DISCOGS_TOKEN,
      'User-Agent': 'TraxWax/1.0 +https://traxwax.com',
    },
  });
  if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, upstream.status === 429 ? 429 : 502);

  const d = await upstream.json();
  const slim = { price: d.lowest_price?.value ?? null, numForSale: d.num_for_sale ?? null };
  const resp = json(slim, 200, { 'Cache-Control': 'public, max-age=86400' });
  await cache.put(key, resp.clone());
  return resp;
}
