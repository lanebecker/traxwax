/* Shared crate-name normaliser (#178 / T4.13). get_public_crate_summary passes a single-token
   display_name through whole (its "First L." reduction needs a space), so an 80-char token would
   blow the OG card past its 1200x630 frame and bloat the /c <title>. Strip Unicode format chars
   (\p{Cf} - zero-width joiners, bidi controls, etc.) and hard-cap the length. Used by BOTH /og and
   /c so the bound is identical. Returns '' for an empty/all-format-char name; callers keep their
   own 'A Collector' fallback. NOT security - the payload only appears on the crate's own card. */
export function cleanCrateName(raw, max = 20) {
  const s = String(raw ?? '').replace(/\p{Cf}/gu, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}
