/* functions/_shared/headers.js — T3.6b (#150): the ONE security-header set for EVERY Pages
   Function response. Pages `_headers` do NOT apply to Functions responses (the same inert-file
   mechanism `_redirects` documents), so /c, /og and /api/release must each carry these explicitly,
   on every return path incl. cached replays and early returns. MIRROR OF public/_headers' /* block
   — keep the two in lockstep when either changes. */
export const SEC_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' https://clerk.traxwax.com https://cloud.umami.is https://cdn.jsdelivr.net https://static.cloudflareinsights.com https://challenges.cloudflare.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://sfipqknrbvamwwahwxnl.supabase.co https://clerk.traxwax.com https://cloud.umami.is https://gateway.umami.is https://challenges.cloudflare.com https://clerk-telemetry.com; frame-src 'self' https://clerk.traxwax.com https://challenges.cloudflare.com; form-action 'self' https://clerk.traxwax.com",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};
