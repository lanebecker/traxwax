/* Routing for the TraxWax app shell: /app/<username> → public/app/index.html
 *
 * WHY THIS IS A FUNCTION AND NOT A _redirects RULE
 * ------------------------------------------------
 * The obvious approach is `/app/*  /app/index.html  200` in public/_redirects. It does not
 * work here, and the failure is silent — the rule is parsed and simply never applies.
 *
 * From Cloudflare's Pages redirects documentation:
 *
 *   "Redirects defined in the _redirects file are not applied to requests served by Pages
 *    Functions, even if the Function route matches the URL pattern. If your Pages
 *    application uses Functions, you must migrate any behaviors from the _redirects file to
 *    the code in the appropriate /functions route, or exclude the route from Functions."
 *
 * TraxWax has a functions/ directory (the Discogs proxy), so _redirects is inert for these
 * requests. Measured on the multi-user preview before writing this file:
 *   /boot.js               → 200 application/javascript   (correct)
 *   /app                   → app shell                    (native directory indexing, NOT the rule)
 *   /app/lanebecker        → LANDING page                 (SPA fallback — the rule never fired)
 *   /zzz-nonexistent-probe → LANDING page                 (same fallback, proving the above)
 *   /_redirects            → not served as an asset       (so Pages DID parse it)
 *   /api/value             → handled by a Function        (so Functions are live here)
 *
 * env.ASSETS.fetch() reads the static asset store directly and does not re-enter Functions,
 * so there is no loop when this handler asks for /app/index.html.
 */

export async function onRequest(context) {
  const url = new URL(context.request.url);
  url.pathname = '/app/index.html';
  return context.env.ASSETS.fetch(new Request(url.toString(), context.request));
}
