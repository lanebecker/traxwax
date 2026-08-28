/* Bare /app (no trailing slash, no username).
 *
 * functions/app/[[path]].js covers /app/<anything>; whether a catch-all also matches the
 * bare parent segment is not worth relying on, so this handler makes /app explicit. Both
 * serve the same shell — boot.js reads window.location.pathname to decide what to render,
 * and treats a missing username as "send the owner to their canonical URL".
 *
 * See functions/app/[[path]].js for why this routing is a Function rather than a
 * _redirects rule.
 */

export async function onRequest(context) {
  const url = new URL(context.request.url);
  url.pathname = '/app/index.html';
  return context.env.ASSETS.fetch(new Request(url.toString(), context.request));
}
