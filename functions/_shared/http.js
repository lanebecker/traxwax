/* functions/_shared/http.js — T3.6d (#152): fetch with a wall-clock budget for Pages Functions.
   A hung Supabase RPC / Discogs upstream aborts instead of hanging the request; the caller's
   existing try/catch (or !ok path) turns the AbortError into its normal degraded response. */
export async function fetchWithTimeout(input, init = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
