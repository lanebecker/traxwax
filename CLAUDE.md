# TraxWax

> **Shared facts are NOT synced into this file.** `scripts/sync-shared-facts.py` globs
> `Projects/*/CLAUDE.md` — one level, non-recursive — and this file sits a level deeper at
> `Projects/Lane's Record Collection/traxwax-clone/CLAUDE.md`. It has therefore never been
> synced and will not be until that glob changes. **The shared facts (paths, Gmail, memory
> conventions, engineering rules incl. the destructive-git ban) live in the parent project
> file: `../CLAUDE.md`. Read that too.** A previous version of this file carried empty
> SHARED-FACTS markers claiming they would "populate on the next run"; they never did.

**[traxwax.com](https://traxwax.com)** — anyone's Discogs collection as a browsable,
filterable crate. **Multi-user since v1.0.0 (2026-08-29)**: Clerk auth, per-user Discogs
OAuth, Supabase backend (9 Edge Functions, migrations 0001–0040), self-healing shared CC0
catalog (v1.2.0). Front-end is the Claude Design redesign ported to a dependency-free
vanilla renderer on Cloudflare Pages.

## Repository structure

| Path | Purpose |
|------|---------|
| `public/index.html` | Landing page, served at `/` |
| `public/app/index.html` | App shell, served at `/app` and `/app/<username>` |
| `public/boot.js` | Auth + routing entry point. Resolves theme, then Clerk, then ownership; only then dynamically imports `app.js`. |
| `public/app.js` | The crate renderer. Does **not** self-start — it exposes `window.TraxWaxBootCrate`, which `boot.js` calls. |
| `public/_redirects` | Rewrites `/app` and `/app/*` to the app shell. **No executable asset may live under `/app/`** — Pages follows redirects even when a real file matches, so a script there would be served as HTML and rejected by the module MIME check. |
| `public/styles.css`, `collection.json`, `releases/<id>.json` | Tokens/base/responsive; the baked DEV FIXTURE (Restricted fields removed at v1.0.0); baked CC0 release files (modal fallback tier) |
| `public/_headers` · `_routes.json` | Security headers + cache policy (v1.0.1: no-cache entry points, 7d releases); Functions pinned to `/api/*` |
| `functions/api/` | Legacy Pages proxy — **only** `release/[id].js` remains (CC0 modal fallback). `/api/value` + `/api/price` deleted in the 1.0.0 cold audit. |
| `supabase/functions/` | **The real backend** — 9 Edge Functions (connect-discogs, callback, finalize-connect, disconnect-discogs, delete-account, import-collection, enrich-release, live-stats, wantlist-write) + `_shared/discogs.ts`. Deployed directly, not via git — see `DEPLOY.md`. |
| `supabase/migrations/` | `0001_init` … `0040_ledger_master_year` (0002 username unique · 0003 OAuth state + link RPC · 0004 import watermark · 0005 collection→releases FK · 0006 audit hardening · 0007 profiles guard trigger · 0008 pending_enrichment RPC + display_name drop · 0009 pending links + finalize/unlink/delete RPCs · 0010 gone_at + refresh + seed_releases merge · 0011 profile fields · 0012 friendships + friend_invites + crate_visibility + friend-read RLS · 0013 can_view_crate→private schema · 0014 crate_view_decision · 0015 soft-consume invites · 0016 friends hardening · 0017–0019 wantlist + match · 0020 wave-3 integrity · 0021 get_friend_crate · 0022 import watermark persist · 0023 crate-owner visibility flags · 0024 any-pressing (master_id + match_mode) · 0025 close-audit hardening · 0026 sharing defaults→friends · 0027 inventory_items (selling) · 0028 forsale_visibility + get_friend_forsale · 0029 forsale default→friends · 0030 wantlist_items.vinyl · 0031 list_friends · 0032 master_year · 0033 social feed (`get_social_feed`) · 0034 audit Wave A — re-link cleanup + guard pins + invite retention · 0035 audit Wave B — unique oauth-state + `get_invite_preview` + private ACLs · 0036 audit Wave D — set-based feed rewrite + `get_friend_wantlist` + indexes + `master_id` CHECK · 0037 public tier — `'public'` on the three visibility CHECKs + `public_slug` + `og_palette` + `get_public_crate` (anon) + `can_view_*` widened · 0038 relation-first in `get_public_crate` (owner `open` flag) · 0039 friend-redirect gate (all-private → 404) · 0040 ledger master_year — `master_year` through `get_friend_crate`/`get_public_crate` so friend/public BY DECADE bins on original-release year (#116)) |
| `build/` | Legacy single-user data builders (`refresh_collection.py` now manual-dispatch only; `seed_catalog.py` was the one-shot Phase 0 seed) |
| `docs/roadmap.md` | Shipped versions (defers to `CHANGELOG.md`/`VERSION` for the current one) and what's next |
| `docs/multi-user-spec.md` | The multi-user DESIGN (period doc — see its as-built note; the shipped system diverges where the plans say so) |
| `docs/phase-*.md`, `phase-1-cold-audit.md` | Period records of the build: phase 0/1 plans, stage A–D plans, cold audit, phase-2 account + catalog-refresh plans. Never edited retroactively. |
| `DEPLOY.md` | Operations reference: all three deploy surfaces, secrets, cache policy, verification, rollback |
| `CHANGELOG.md` · `VERSION` | What changed, and the one source of truth for the version |

## Design source

The design is Lane's Claude Design kit at `../traxwax-design-kit/new design kit/`.
`TraxWax App.dc.html` is authoritative and `TRAXWAX-DESIGN-SPEC.md` documents the tokens,
filter model, views, and data seams. `public/app.js` copies the kit's inline styling
**verbatim** so the design stays authoritative; only the Claude Design runtime (`support.js`,
`<x-dc>`, `{{ }}`, `<sc-for>`, `<sc-if>`) was replaced by the vanilla renderer.

**Design and UX changes need Lane's approval before they are built on** (project rule L5).

## The two seams (v1.0.0+)

**Seam 1 — data.** DB mode (production): `boot.js` installs providers and the crate reads
`collection_items ⋈ releases` from Supabase under the signed-in user's RLS. Baked mode
(local dev, providers absent): `public/collection.json` — same flat record shape, Restricted
fields (`price/crating/crcount/have/want`) nulled since v1.0.0. Covers render from the
Discogs CDN via `cover_image` (~600px q90) → `thumb` → generated vinyl placeholder.

**Seam 2 — live per user.** Header EST. and modal price/community stats come from the
`live-stats` Edge Function under the caller's own token (≤6h cache) — never persisted.
Modal tracklists are DB-first, then the baked static `releases/<id>.json`, then
`/api/release/:id` as last resort. The catalog keeps itself current (v1.2.0): metadata
merges on every import, tombstones retry after 7d, deep fields refresh after 180d.

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

## Multi-user — SHIPPED (v1.0.0 launched 2026-08-29; current v1.25.0). Social waves shipped through friend-crate visibility (#43), any-pressing matching (#28), the selling wave (for-sale via Discogs, v1.16–1.19), Wave 5a "share the shelf" (Collection DNA card + shareable filter URLs, v1.20.0) + the header status feed (`get_social_feed` + client seen-state engine, #59, v1.25.0). Recent UI: FILED UNDER style tray (v1.21.0), FOR SALE promoted to a 5th tab (v1.22.0) then renamed THE GOODS (v1.24.1), header icon trio (v1.23.x). Cold audits: end-of-phase at v1.14.0; full-codebase at v1.25.0 (`docs/cold-audit-v1.25.md` — 44 findings filed as #62–#105)

Supabase project `traxwax` (ref `sfipqknrbvamwwahwxnl`) holds **ten tables**: `profiles`
(Wave 1 `crate_visibility`; later `wantlist_visibility`, `match_mode`, `forsale_visibility`), `collection_items`,
`releases` (has `master_id` since 0024, `master_year` since 0032), `wantlist_items` (carries `vinyl` since 0030),
`inventory_items` (for-sale listings, 0027), `discogs_credentials`, `discogs_oauth_state`
(handshake state + the v1.0.1 cooldown placeholder rows), `discogs_pending_links` (v1.1.0 parked links),
and Wave 1's `friendships` (two-row symmetric) + `friend_invites` (hash-only, soft-consumed since
v1.4.2) — RLS on all, keyed on `auth.jwt()->>'sub'` (Clerk user ids, so every `user_id` is TEXT, not
uuid). **No FKs from any `user_id` column to `profiles` — deliberate, RE-RATIFIED at the
v1.25 audit (E7/#105, Lane, 2026-09-07) at its true current scope: all 8 user-data tables.**
Integrity is procedural (the `no_profile` guards + delete/unlink/link cleanup paths); the
cost showed once (A1/#62 — `link_discogs_account` missed two tables added after it) and the
audit cadence is the compensating control. Revisit at real multi-user scale or the next
cleanup-omission bug, whichever first. Migrations run **0001–0040**; highlights: 0012–0015 friendship graph + friend-read RLS +
`can_view_crate`, 0017–0019 wantlist + match, 0021 `get_friend_crate`, 0023 crate-owner visibility,
0024 any-pressing, 0025 close-audit hardening, 0026 sharing defaults→friends, 0027 `inventory_items`
(selling), 0028 `forsale_visibility` + `get_friend_forsale`, 0031 `list_friends`, 0032 `master_year`, 0033 social feed,
0037–0039 the Wave 5b public tier (`get_public_crate`, the ONLY anon-granted function — its advisor WARN is by design), 0034–0036 the v1.25 audit waves (A: data lifecycle; B: atomic cooldown + invite preview + private ACLs;
D: set-based feed + friend-wantlist projection + indexes). Auth is
the **production** Clerk instance (session token carries `"role": "authenticated"`). NOTE: `public/app/index.html`
hardcodes the prod `pk_live_…` key with no swap, so the pages.dev preview runs prod Clerk too (the dev instance
is no longer wired anywhere — v1.14.1/#52 removed the Edge functions' in-code `CLERK_ISSUER` fallback; they
fail closed if `CLERK_ISSUER`/`APP_ORIGIN` are unset).

Things that look like bugs and are not:

- **`discogs_credentials`, `discogs_oauth_state`, `discogs_pending_links` have RLS enabled
  and ZERO policies.** Deliberate — no policy means no client can read them; locked to the
  `service_role`.
- **`releases` has no insert/update policy.** Also deliberate — world-readable CC0 data
  written only by service-role RPCs (`seed_releases` merge + enrichment).
- **The OAuth callback does not complete the link.** It parks it as pending; only
  `finalize-connect` (one-time fragment code + verified Clerk sub) completes it — that IS
  the link-CSRF fix (v1.1.0), not an unfinished flow.

The backbone constraint: the Discogs terms split data in two. CC0 catalog data may be stored
forever; Restricted data (prices, marketplace, community stats, and *which releases a user
owns*) is fetched live under each user's own OAuth token and never permanently mirrored —
and disconnect/deletion (v1.1.0) delete the imported ownership rows for the same reason.
Read `docs/multi-user-spec.md` §8 before touching anything in this area.
