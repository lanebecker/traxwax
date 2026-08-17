/* GET /api/value — whole-collection estimated value (one Discogs call).
   Returns { minimum, median, maximum } as formatted strings. Cached 1 day. */

function json(o, status = 200, extra = {}) {
  return new Response(JSON.stringify(o), {
    status, headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export async function onRequestGet({ env }) {
  const user = env.DISCOGS_USER || 'lanebecker';
  const cache = caches.default;
  const key = new Request('https://traxwax.internal/api/value');
  const cached = await cache.match(key);
  if (cached) return cached;

  const upstream = await fetch('https://api.discogs.com/users/' + user + '/collection/value', {
    headers: {
      'Authorization': 'Discogs token=' + env.DISCOGS_TOKEN,
      'User-Agent': 'TraxWax/1.0 +https://traxwax.com',
    },
  });
  if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, 502);

  const d = await upstream.json();   // { minimum, median, maximum }
  const resp = json(d, 200, { 'Cache-Control': 'public, max-age=86400' }); // 1d
  await cache.put(key, resp.clone());
  return resp;
}
