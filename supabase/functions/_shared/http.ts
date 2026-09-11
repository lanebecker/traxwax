/* _shared/http.ts — T3.6d (#152): a fetch with a wall-clock budget. Every upstream call in these
 * functions goes through here so a hung Discogs/Supabase endpoint aborts instead of pinning the
 * isolate until the platform reaps it (the sibling /og cover fetch already used this AbortController
 * pattern inline). On timeout the AbortController fires and fetch() rejects with an AbortError, which
 * the caller's existing try/handle path turns into a controlled 5xx — never a hang. */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 10000,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
