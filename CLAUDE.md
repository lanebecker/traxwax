# TraxWax

<!-- SHARED-FACTS:START -->
<!-- AUTO-GENERATED shared facts. Do NOT edit between the SHARED-FACTS markers, and do NOT delete the markers themselves. This block is synced into every Projects/*/CLAUDE.md by scripts/sync-shared-facts.py from the master ~/Documents/Claude.nosync/shared/SHARED-MEMORY.md, and are re-run by a scheduled task. To change these facts: edit shared/SHARED-MEMORY.md and rerun the script. Manual edits or deletions here are overwritten/restored on the next sync. -->
_Shared facts populate here on the next `scripts/sync-shared-facts.py` run (matching every other `Projects/*/CLAUDE.md`)._
<!-- SHARED-FACTS:END -->

Static site for **TraxWax.com** — a browsable, filterable display of Lane's Discogs
vinyl collection. The Claude Design redesign, ported off the design runtime into a
dependency-free vanilla renderer and served from Cloudflare Pages with a Discogs
proxy (Pages Functions).

## Repository Structure

| Path | Purpose |
|------|---------|
| `public/` | The static site (Cloudflare Pages build output dir): `index.html`, `styles.css`, `app.js`, `collection.json` |
| `functions/api/` | Cloudflare Pages Functions — the Discogs proxy (`release/[id].js`, `value.js`, `price/[id].js`); the token is held server-side |
| `build/build_collection.py` | Maps `discogs_records.json` → `public/collection.json` (the flat record shape) |
| `DEPLOY.md` | Deploy steps (Cloudflare Pages, token secret, custom domain, price bake) |
| `docs/roadmap.md` | Planned features and versioning |
| `CHANGELOG.md` | What changed in each version |
| `VERSION` | Single source of truth for the version number |

## Design source

The design is Lane's Claude Design kit (`traxwax-design-kit/new design kit/`):
`TraxWax App.dc.html` is authoritative and `TRAXWAX-DESIGN-SPEC.md` documents the
tokens, filter model, views, and the two data seams. `public/app.js` copies the
kit's inline styling **verbatim** so the design stays authoritative; only the Claude
Design runtime (`support.js` / `<x-dc>` / `{{ }}` / `<sc-for>` / `<sc-if>`) was
replaced by the vanilla renderer.

## The two seams

- **Seam 1 — data.** `public/collection.json`, shape `{id, artist, title, year,
  label, styles[], genres[], vinyl, thumb, added, rating, price}`. Covers load from
  the Discogs CDN (`thumb`).
- **Seam 2 — live calls.** The `api` object at the top of `public/app.js` calls the
  proxy (`/api/release/:id`, `/api/value`, `/api/price/:id`) with a mock fallback for
  local dev.

## Versioning

- `VERSION` (semver `MAJOR.MINOR.PATCH`) is the **single source of truth**.
- **To cut a release: edit `VERSION` and add a `[x.y.z]` section to `CHANGELOG.md`,
  commit, push.** `.github/workflows/sync-version-badge.yml` then rewrites the README
  shields.io badge to match `VERSION` and warns if `CHANGELOG.md` wasn't updated in
  the same push — so the badge can never drift from `VERSION` (the version-bug guard).
- Don't hardcode the version anywhere in code; there is exactly one source (`VERSION`).

## Running locally

`cd public && python3 -m http.server 8000`. To exercise the proxy locally with a
token: `npx wrangler pages dev public` (see `DEPLOY.md`).

## Working copy & pushing

**One persistent clone is the working copy: `Projects/Lane's Record Collection/traxwax-clone`.**
Claude edits files here directly — there is no separate staging dir and no rsync (the old
`traxwax-site` copy is retired). Because the `sync-version-badge` Action commits back to `main`, **commit first, then
`pull --rebase`, then push** — `git pull --rebase` refuses to run with a dirty tree, so
the pull comes after the commit, not before. One chain:

```bash
cd "…/Projects/Lane's Record Collection/traxwax-clone"
git add -A && git commit -m "…" && git pull --rebase origin main && git push
```
