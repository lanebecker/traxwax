import { SEC_HEADERS } from '../../_shared/headers.js';
import { fetchWithTimeout } from '../../_shared/http.js';

/* GET /api/release/:id — CC0 release detail (tracklist/country/released/videos) for the
   modal's LAST-RESORT fallback tier. Holds the token server-side.

   Phase 1 cold audit #24: this endpoint previously also served have/want/community rating,
   lowest_price and num_for_sale — Restricted Data under the Discogs API terms — to
   anonymous callers with a 7-day cache. Restricted data now flows ONLY through the
   authenticated live-stats Edge Function (per-user token, ≤6h ephemeral cache). What
   remains here is CC0 catalog data, which the long edge cache is appropriate for.
   /api/value and /api/price were deleted outright in the same audit.

   Audit v1.25 B2 (#70): this endpoint was an unauthenticated, unthrottled burner for the
   shared site token — only successes were cached (a loop over nonexistent ids hit Discogs
   every time, forever), and the built-in 429 retry DOUBLED the upstream cost exactly when
   the budget was exhausted. Hardened three ways:
   1. Same-origin gate: the modal fallback is only ever fetch()ed by traxwax.com pages, so
      cross-site and bare-curl callers get 403 before any upstream call. Sec-Fetch-Site is
      set by every current browser; the Referer check covers the stragglers. Neither is a
      security boundary (both are spoofable by a determined client) — they are a cost gate
      that turns the drive-by `while true; curl` into a 403 loop that never reaches Discogs.
   2. Negative caching WITH REAL STATUS CODES: 404s cache for 6h, other upstream failures
      (429 included) for 60s — an id-scanning loop now costs Discogs one call per unique id
      per window instead of one per request. The statuses stay honest because the client's
      _fetchReleaseLive contract depends on them: !r.ok → null (no modal data, no cache
      write), 429/5xx → its own bounded retry — a 200-masked failure would instead land
      `tracks: []` in the client's 90-day localStorage cache (draft-review catch).
   3. The 429 retry is gone; a rate-limited response is itself briefly cached. */

function json(o, status = 200, extra = {}) {
  // T3.6b (#150): every response — incl. the cached replay and the early bad-id/forbidden returns —
  // carries the shared security set (nosniff is the one that matters for a JSON endpoint). A
  // per-response Cache-Control in `extra` still wins.
  return new Response(JSON.stringify(o), {
    status, headers: { ...SEC_HEADERS, 'Content-Type': 'application/json', ...extra },
  });
}

export async function onRequestGet({ params, request, env }) {
  const _raw = String(params.id || '');
  // T3.6c (#151): length-cap + canonicalize — strip leading zeros so 0000249504 and 249504 map to
  // ONE cache key + ONE upstream call (a padded-id scan can't multiply the key space / burn the
  // shared token); <=9 significant digits (Discogs ids are well under that). See #70 cost-gate note.
  const _m = _raw.length <= 12 ? /^0*([1-9]\d{0,8})$/.exec(_raw) : null;
  if (!_m) return json({ error: 'bad id' }, 400);   // no SSRF / path abuse / unbounded key space
  const id = _m[1];

  // B2 (#70) same-origin cost gate. Browsers send Sec-Fetch-Site on every fetch; a
  // same-origin page fetch is 'same-origin'. If the header is absent (old client, curl),
  // fall back to requiring a traxwax.com Referer. Spoofable — that's fine; see header note.
  const sfs = request.headers.get('Sec-Fetch-Site');
  if (sfs) {
    if (sfs !== 'same-origin') return json({ error: 'forbidden' }, 403);
  } else {
    const ref = request.headers.get('Referer') || '';
    let ok = false;
    try { ok = new URL(ref).hostname === 'traxwax.com'; } catch (e) { /* no/invalid referer */ }
    if (!ok) return json({ error: 'forbidden' }, 403);
  }

  const cache = caches.default;
  const key = new Request('https://traxwax.internal/api/release-cc0/' + id);
  const cached = await cache.match(key);
  if (cached) return cached;

  const headers = {
    'Authorization': 'Discogs token=' + env.DISCOGS_TOKEN,
    'User-Agent': 'TraxWax/1.0 +https://traxwax.com',   // Discogs 403s without a UA
  };
  let upstream;
  try {
    upstream = await fetchWithTimeout('https://api.discogs.com/releases/' + id, { headers }, 10000);
  } catch (e) {
    // T3.6d (#152): a hung/aborted upstream is a controlled 502 (briefly cached like other upstream
    // failures), never a hung isolate.
    const resp = json({ error: 'upstream' }, 502, { 'Cache-Control': 'public, max-age=60' });
    try { await cache.put(key, resp.clone()); } catch (e2) { /* degrade to uncached */ }
    return resp;
  }

  // B2 (#70) negative caching, honest statuses (see header note 2). The Workers Cache API
  // stores non-2xx responses that carry an explicit Cache-Control; if an edge case refuses
  // the put, behavior degrades to exactly today's (uncached miss) — never worse.
  if (upstream.status === 404) {
    const resp = json({ error: 'gone' }, 404, { 'Cache-Control': 'public, max-age=21600' }); // 6h
    try { await cache.put(key, resp.clone()); } catch (e) { /* degrade to uncached */ }
    return resp;
  }
  if (!upstream.ok) {
    // Includes 429: cache the failure briefly so an exhausted budget is not re-burned
    // per-request. 60s keeps the tier responsive once the window clears.
    const resp = json({ error: 'upstream', status: upstream.status },
      upstream.status === 429 ? 429 : 502, { 'Cache-Control': 'public, max-age=60' });
    try { await cache.put(key, resp.clone()); } catch (e) { /* degrade to uncached */ }
    return resp;
  }

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
