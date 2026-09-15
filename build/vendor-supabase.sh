#!/usr/bin/env bash
# build/vendor-supabase.sh — regenerate the vendored browser copy of supabase-js (#186 Phase 1).
#
# The browser used to import supabase-js from cdn.jsdelivr.net at load time; this bundles a
# self-contained copy into the repo so it is served same-origin (and jsdelivr can leave the CSP).
# esbuild is byte-stable for a fixed version, so re-running this and `git diff`-ing against the
# committed file is the build-reproducibility check. This is a DEV tool — it is NOT run at deploy.
# Pinned: supabase-js 2.116.0, esbuild 0.28.2.
set -euo pipefail

# Run from the repo root no matter where invoked from (the script lives in build/).
cd "$(cd "$(dirname "$0")/.." && pwd)"

VER=2.116.0
ESBUILD=0.28.2
OUT="public/vendor/supabase-js-${VER}.js"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
(
  cd "$tmp"
  npm init -y >/dev/null            # metadata only; noise, not diagnostics
  # Install + build with output VISIBLE so a failure is diagnosable (set -e aborts on error).
  npm i "@supabase/supabase-js@${VER}" "esbuild@${ESBUILD}" --no-fund --no-audit
  printf "export * from '@supabase/supabase-js';\n" > entry.mjs
  npx esbuild entry.mjs --bundle --format=esm --platform=browser --target=es2020 \
    --minify --define:process.env.NODE_ENV='"production"' --legal-comments=none \
    --outfile=bundle.js
)
mkdir -p "$(dirname "$OUT")"
{
  printf '/* TraxWax vendored dependency — DO NOT EDIT BY HAND. #186 Phase 1.\n'
  printf '   @supabase/supabase-js@%s, bundled self-contained via esbuild@%s:\n' "$VER" "$ESBUILD"
  printf '     export * from "@supabase/supabase-js"\n'
  printf '     esbuild entry.mjs --bundle --format=esm --platform=browser --target=es2020 \\\n'
  printf '       --minify --define:process.env.NODE_ENV=\\"production\\" --legal-comments=none\n'
  printf '   Regenerate: build/vendor-supabase.sh · licences: THIRD-PARTY-NOTICES.md */\n'
  cat "$tmp/bundle.js"
} > "$OUT"
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
