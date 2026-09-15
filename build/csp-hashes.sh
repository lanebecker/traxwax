#!/usr/bin/env bash
# build/csp-hashes.sh — regenerate the sha256- CSP hashes for the inline <script> blocks in
# public/index.html + public/app/index.html (#186 Phase 2). Paste the tokens into the script-src
# of BOTH public/_headers and functions/_shared/headers.js (keep the two in lockstep). Byte-exact:
# any edit to an inline script (even a comment) changes its hash. Dev tool; NOT run at deploy.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
python3 - <<'PY'
import re, hashlib, base64
# Skip <script> tags that carry a real src= attribute (whitespace-anchored, so data-src= etc. still hash).
pat = re.compile(r'<script(?![^>]*\ssrc\s*=)[^>]*>(.*?)</script>', re.DOTALL)
for f in ("public/index.html", "public/app/index.html"):
    html = open(f, encoding="utf-8").read()
    for m in pat.finditer(html):
        h = base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode()
        head = (m.group(1).strip().splitlines() or [""])[0][:58]
        print(f"'sha256-{h}'  # {f}: {head}")
PY
