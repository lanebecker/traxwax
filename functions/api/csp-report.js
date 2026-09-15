// functions/api/csp-report.js — log-only CSP violation sink (#186 Phase 2).
// Public, unauthenticated (browsers post CSP reports without credentials). Watch with:
//   wrangler pages deployment tail   (filter "[csp-report]")
// Accepts report-uri (application/csp-report) and the Reporting API (application/reports+json).
// Only POST is exported, so Cloudflare Pages auto-returns 405 for other methods.
export async function onRequestPost(context) {
  try {
    const ct = context.request.headers.get('content-type') || '';
    const body = await context.request.text();
    console.log('[csp-report]', ct, (body && body.length <= 16384)
      ? body : ('skipped len=' + (body ? body.length : 0)));   // cap abusive bodies
  } catch (e) {
    console.log('[csp-report] error', String(e));
  }
  return new Response(null, { status: 204 });
}
