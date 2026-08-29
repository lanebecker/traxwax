# TraxWax

> **Shared facts are NOT synced into this file.** `scripts/sync-shared-facts.py` globs
> `Projects/*/CLAUDE.md` — one level, non-recursive — and this file sits a level deeper at
> `Projects/Lane's Record Collection/traxwax-clone/CLAUDE.md`. It has therefore never been
> synced and will not be until that glob changes. **The shared facts (paths, Gmail, memory
> conventions, engineering rules incl. the destructive-git ban) live in the parent project
> file: `../CLAUDE.md`. Read that too.** A previous version of this file carried empty
> SHARED-FACTS markers claiming they would "populate on the next run"; they never did.

Static site for **[traxwax.com](https://traxwax.com)** — a browsable, filterable display of
Lane's Discogs vinyl collection. The Claude Design redesign ported off the design runtime into
a dependency-free vanilla renderer, served from Cloudflare Pages with a Discogs proxy.

## Repository structure

| Path | Purpose |
|------|---------|
| `public/index.html` | Landing page, served at `/` |
| `public/app/index.html` | App shell, served at `/app` and `/app/<username>` |
| `public/boot.js` | Auth + routing entry point. Resolves theme, then Clerk, then ownership; only then dynamically imports `app.js`. |
| `public/app.js` | The crate renderer. Does **not** self-start — it exposes `window.TraxWaxBootCrate`, which `boot.js` calls. |
| `public/_redirects` | Rewrites `/app` and `/app/*` to the app shell. **No executable asset may live under `/app/`** — Pages follows redirects even when a real file matches, so a script there would be served as HTML and rejected by the module MIME check. |
| `public/styles.css`, `collection.json`, `releases/<id>.json` | Tokens/base/responsive, the record data, and per-release immutable data |
| `functions/api/` | Pages Functions — the Discogs proxy (`release/[id].js`, `value.js`, `price/[id].js`). Holds `DISCOGS_TOKEN` server-side. |
| `build/refresh_collection.py` | **The** data builder: Discogs API → `collection.json` + `releases/*.json`. Run weekly by GitHub Actions. |
| `build/build_collection.py` | Legacy: `discogs_records.json` → `collection.json`. Superseded; kept for reference. |
| `build/seed_catalog.py` | One-shot Phase 0 helper: emits the CC0 catalog seed for Supabase. |
| `supabase/migrations/` | Multi-user schema + RLS: `0001_init` … `0006_audit_hardening` (0002 username unique, 0003 OAuth state + link RPC, 0004 import watermark, 0005 collection→releases FK, 0006 cold-audit hardening) |
| `docs/roadmap.md` | Shipped versions and what's next |
| `docs/multi-user-spec.md` | The multi-user design (v1.0.0) |
| `docs/phase-0-plan.md` | Multi-user foundations — complete |
| `docs/phase-1-plan.md` | Multi-user build plan — Stage A executable, B/C/D scoped |
| `DEPLOY.md` | How the site is deployed and operated |
| `CHANGELOG.md` · `VERSION` | What changed, and the one source of truth for the version |

## Design source

The design is Lane's Claude Design kit at `../traxwax-design-kit/new design kit/`.
`TraxWax App.dc.html` is authoritative and `TRAXWAX-DESIGN-SPEC.md` documents the tokens,
filter model, views, and data seams. `public/app.js` copies the kit's inline styling
**verbatim** so the design stays authoritative; only the Claude Design runtime (`support.js`,
`<x-dc>`, `{{ }}`, `<sc-for>`, `<sc-if>`) was replaced by the vanilla renderer.

**Design and UX changes need Lane's approval before they are built on** (project rule L5).

## The two seams

**Seam 1 — data.** `public/collection.json`, one flat object per record:

```
{ id, artist, title, year, label, styles[], genres[], vinyl, thumb, cover_image,
  added, rating, price, crating, crcount, have, want }
```

Covers render from the Discogs CDN via `cover_image` (~600px q90), falling back to `thumb`
and then to a generated vinyl placeholder. Immutable per-release data lives separately in
`public/releases/<id>.json` as `{ tracks[], country, released, videos[] }`.

**Seam 2 — mostly baked.** As of v0.3.0 the detail modal makes **no live call**: the
tracklist comes from the static `releases/<id>.json` and the stats/price from
`collection.json`. The proxy is now only used for `/api/value` (the header EST.) and
`/api/release/:id` as a fallback for a record too new to have been baked.

## Versioning

- `VERSION` (semver) is the **single source of truth**. Never hardcode a version in code.
- To cut a release: edit `VERSION`, add a `[x.y.z]` section to `CHANGELOG.md`, commit, push.
- `.github/workflows/sync-version-badge.yml` then rewrites the README badge to match and warns
  if `CHANGELOG.md` was not updated in the same push — the badge can never drift from
  `VERSION`.

## Running locally

`cd public && python3 -m http.server 8000`. To exercise the proxy with a real token:
`npx wrangler pages dev public` — see `DEPLOY.md`.

## Working copy & pushing

**One persistent clone is the working copy:** `Projects/Lane's Record Collection/traxwax-clone`.
Claude edits here directly — no staging dir, no rsync, no re-cloning.

**Mutating git runs on Lane's Mac, never against the FUSE mount.** Claude hands over one `&&`
chain. Because `sync-version-badge` and `refresh-collection` both commit back to `main`,
pushes are often non-fast-forward — so **commit first, then `pull --rebase`, then push**
(`pull --rebase` refuses a dirty tree, which is why the pull comes second):

```bash
cd "…/Projects/Lane's Record Collection/traxwax-clone"
git add -A && git commit -m "…" && git pull --rebase origin main && git push
```

## Multi-user (v1.0.0) — in progress

Supabase project `traxwax` (ref `sfipqknrbvamwwahwxnl`) holds `profiles`,
`collection_items`, `releases`, `discogs_credentials` — RLS on all four, keyed on
`auth.jwt()->>'sub'` (Clerk user ids, so every `user_id` is TEXT, not uuid).

Two things that look like bugs and are not:

- **`discogs_credentials` has RLS enabled and ZERO policies.** Deliberate — no policy means
  no client can read it, locking per-user Discogs OAuth tokens to the `service_role`.
- **`releases` has no insert/update policy.** Also deliberate — it is world-readable CC0 data
  written only by the service role.

The backbone constraint: the Discogs terms split data in two. CC0 catalog data may be stored
forever; Restricted data (prices, marketplace, community stats, and *which releases a user
owns*) is fetched live under each user's own OAuth token and never permanently mirrored.
Read `docs/multi-user-spec.md` §8 before touching anything in this area.
