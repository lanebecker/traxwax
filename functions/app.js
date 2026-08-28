/* Bare /app (no trailing slash, no username).
 *
 * functions/app/[[path]].js covers /app/<anything>; whether a catch-all also matches the
 * bare parent segment is not worth relying on, so this handler makes /app explicit. Both
 * serve the same shell — boot.js reads window.location.pathname to decide what to render,
 * and treats a missing username as "send the owner to their canonical URL".
 *
 * The target is the PRETTY path '/app/', not '/app/index.html' — env.ASSETS.fetch() returns
 * an empty body for a direct asset path. See functions/app/[[path]].js for the full
 * measurement trail and the reason this routing is a Function rather than a _redirects rule.
 */

export async function onRequest(context) {
  const url = new URL(context.request.url);
  url.pathname = '/app/';
  return context.env.ASSETS.fetch(new Request(url.toString(), context.request));
}
