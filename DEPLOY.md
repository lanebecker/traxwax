# TraxWax — deployment & operations

The site is **live at [traxwax.com](https://traxwax.com)**, multi-user since v1.0.0
(2026-08-29). This is the operations reference, not a setup checklist — one-time setup
(Cloudflare 2026-08-17/18, Supabase/Clerk Phase 0–1 2026-08-28/29) lives in git history and
the `docs/` phase plans.

The system has **three deployment surfaces** that move independently:

1. **Static front-end + legacy proxy** — Cloudflare Pages, auto-deploys on push to `main`.
2. **Supabase Edge Functions** — deployed directly (MCP/CLI), NOT tied to git pushes.
3. **Database migrations** — applied directly to the Supabase project; the files in
   `supabase/migrations/` are the record of what is live, committed after application.

Keeping git in sync with 2 and 3 is a discipline, not an automatism: deploy/apply, verify,
then commit the matching files.

---

## Surface 1 — Cloudflare Pages

| | |
|---|---|
| **Host** | Cloudflare Pages, project `traxwax` |
| **Source** | `github.com/lanebecker/traxwax`, branch `main` |
| **Build command / preset** | *(none)* — output directory `public` |
| **Deploy trigger** | Every push to `main`. Branches get previews at `https://<branch>.traxwax.pages.dev`. |

Pages auto-detects `functions/` — `/api/release/:id` (the CC0 proxy) plus, since v1.30.0,
`/c/:slug` (crawler meta) and `/og/:slug` (the unfurl card). `public/_routes.json` includes
exactly `/api/*`, `/c/*`, `/og/*`; `_redirects` and `_headers` govern everything else — and do
NOT apply to those three routes (the functions carry their own headers; `_redirects`' `/c`
rules are the Functions-outage fallback).

**Cache policy** (`public/_headers`, v1.0.1): `no-cache` on HTML, `/app.js`, `/boot.js`,
`/styles.css`, `/collection.json` — browsers revalidate every load (cheap 304s) and pick up
each deploy immediately; `public, max-age=604800` on the immutable `/releases/*.json`.

> ⚠️ **Zone setting that can silently defeat this:** the traxwax.com zone's **Caching →
> Configuration → Browser Cache TTL** must stay **"Respect Existing Headers"**. It was set
> to the 4-hour default until 2026-08-29, which stamped `max-age=14400` over the `_headers`
> rules on every edge-cached asset (`cf-cache-status: HIT/REVALIDATED`) while DYNAMIC
> responses kept the right headers — a maddening half-broken state. If stale-asset symptoms
> ever return, probe `curl -sI https://traxwax.com/boot.js | grep -i cache` and check this
> setting first.

**Environment variables** (Workers & Pages → traxwax → Settings, Production + Preview):

| Name | Notes |
|---|---|
| `DISCOGS_TOKEN` | Lane's personal access token (Secret). Read only by `functions/api/release/[id].js`, the CC0 modal-fallback proxy. |

GitHub Actions holds an independent copy of `DISCOGS_TOKEN` for the retired-from-cron
`refresh-collection.yml` (manual `workflow_dispatch` only; regenerates the dev fixture).
Rotation touches both plus the other consumers — see `../DISCOGS-CREDENTIALS.md`.

**Analytics (Umami Cloud, since v1.4.7).** Cookieless, no-PII, no consent banner — a `<script>`
tag in both entry-point heads (`public/index.html`, `public/app/index.html`). No server, no
Supabase involvement. **The CSP is ENFORCED (since v1.13.0, #38)** — `public/_headers` allowlists
Umami's script origin (`cloud.umami.is`) AND its event endpoint (`gateway.umami.is`), so adding ANY
new analytics/third-party origin now requires a `_headers` CSP edit or it is silently blocked; the
report-only→enforced flip + the rollback lever (rename the header back to
`Content-Security-Policy-Report-Only`) are documented in `_headers` itself. The `data-website-id` is
**not a secret** (it's public in the HTML, currently a real id) — one value in both files; to rotate
it, replace it in both and push. Config choices, all
one-liners: `data-domains="traxwax.com"` (preview/localhost don't report), `data-do-not-track`
(honors the browser DNT signal — drop it for fuller numbers), and a `data-before-send` guard
(`twUmamiBeforeSend`) that masks the `/app/<username>` path segment so no Discogs handle leaves
the app. **Rule: event props are actions/counts only — never a username, price, or any Restricted
Discogs field** — failure `reason`s are fixed enum buckets, never a raw error message. Custom
events (v1.4.8): activation funnel `connect_started`/`connect_completed`/`connect_failed{reason}`
+ `import_started`/`import_completed{items}`/`import_failed{reason,page}`; churn + social
`discogs_disconnected`, `account_deleted`, `invite_created`, `invite_accepted`; engagement
`view_change{view}`, `filter_used{kind}`, `record_opened{source}`.

## Surface 2 — Supabase Edge Functions

Project `sfipqknrbvamwwahwxnl` (`https://sfipqknrbvamwwahwxnl.supabase.co`). **Nine
functions**, all `verify_jwt: false` with in-handler verification against Clerk's JWKS via
the shared `_shared/auth.ts` (`verifyClerk` — E1/#99; the platform gate cannot validate
Clerk RS256, Stage B finding C1):

| Function | Role |
|---|---|
| `connect-discogs` | OAuth 1.0a leg 1 + 10s per-user cooldown (v1.0.1) |
| `connect-discogs-callback` | OAuth leg 2 — parks the completed link as *pending* + one-time fragment code (v1.1.0) |
| `finalize-connect` | Completes a pending link: code hash + verified Clerk sub (closes the link-CSRF) |
| `disconnect-discogs` | Unlink: credential + imported items deleted, profile reset |
| `delete-account` | Purge all TraxWax data (never the Clerk identity); server re-checks the typed `DELETE` |
| `import-collection` | One page (collection, wantlist, OR inventory/for-sale) per invocation; seeds the catalog via `seed_releases` (v1.2.0); captures `master_id` (0024) |
| `enrich-release` | Budgeted CC0 enrichment + refresh drain (7d tombstone retry, 180d TTL); captures `master_id` (0024) + backfills `master_year` (0032, v9) |
| `live-stats` | Restricted data, live under the caller's token, ≤6h in-instance cache; price suppressed on friend crates |
| `wantlist-write` | Add/remove on the caller's OWN wantlist under their Discogs token, then mirror the row (the only client wantlist writer — direct table DML is locked down, 0025) |

**Secrets** (Supabase → Edge Functions → Secrets): `DISCOGS_CONSUMER_KEY`,
`DISCOGS_CONSUMER_SECRET` (the `TraxWax` Discogs app), `DISCOGS_TOKEN_ENC_KEY` (32-byte
base64; AES-256-GCM at rest — rotating it orphans stored tokens, forcing reconnects),
`APP_ORIGIN` (`https://traxwax.com`), `CLERK_ISSUER` (the **production** Clerk instance).
`APP_ORIGIN` and `CLERK_ISSUER` are **required**: since v1.14.1 (#52) every jwtVerify function **fails
closed** (throws at boot) if either is unset — there are no dev/preview fallbacks any more.

**Deploying:** via the **break-glass** Supabase MCP connector — the standing `Supabase — TraxWax` connector
is read-only; Lane arms `Supabase — TraxWax — Break-Glass` for a deploy, then disarms it (see `CLAUDE.md`).
Then `deploy_edge_function` (file layout
`{<fn>/index.ts, _shared/discogs.ts, _shared/auth.ts}` since E1/#99, entrypoint
`<fn>/index.ts`, `verify_jwt: false`) or
`supabase functions deploy <fn>` with the CLI. Supabase keeps every version — rollback is
redeploying the previous one. **After any deploy, verify the 401 gate:** POST with a forged
Bearer token must return `{"error":"invalid_token"}` (proves the bundle booted AND JWKS
verification runs).

## Surface 3 — Database

Postgres with RLS keyed on `auth.jwt()->>'sub'` (Clerk TEXT ids; RLS policies use the
`(select auth.jwt())` initplan form since 0025). Migrations `0001`–`0039` applied; the migration
map lives in `CLAUDE.md`. Apply via the **break-glass** MCP `apply_migration` (or
`supabase db push`), verify with the checks each migration's plan documents, then commit the
file. Writer RPCs (`link_discogs_account`, `finalize_discogs_link`,
`unlink_discogs_account`, `delete_account`, `pending_enrichment`, `seed_releases`, `db_now`)
are SECURITY DEFINER and `service_role`-only; the friend-read RPCs (`get_friend_crate` 0021,
`get_crate_owner` 0023, `get_friend_forsale` 0028, `list_friends` 0031, and the `private.can_view_*`
gates) are SECURITY DEFINER granted to `authenticated`.

### Wave 5b — the public tier (v1.29.0, migrations 0037–0039)

- **The anonymous surface is exactly one function**: `public.get_public_crate(text)`, SECURITY
  DEFINER, `grant execute … to anon, authenticated`. The security advisor flags it
  (`anon_security_definer_function_executable`, WARN) — **that WARN is by design**; do not "fix"
  it. It returns catalog data only (no username/price/rating; owner reduced to "First L.");
  unknown ≡ all-private ≡ NULL. No anon table policies exist and none should be added.
- `private.can_view_*` accept `('friends','public')` since 0037 — if a future migration recreates
  them from an older template, friends of public-crate owners lose access (the 0037 F1 lesson).
- **Routing:** `/c` + `/c/*` rewrite to the shell in `public/_redirects` (S1). S2's Pages
  Function will claim `/c/*` + `/og/*` via `_routes.json` `include`, at which point those
  `_redirects` rules go inert for those paths (they stay as a Functions-outage fallback).
- Applied 2026-09-10 via break-glass: 0037_public_tier, 0038_public_relation_first,
  0039_friend_redirect_gate (all three amend/replace `get_public_crate`; 0039 is the live body).
- **S2 (v1.30.0): the Pages project has a BUILD STEP now** — build command `npm install`, build
  output directory `public` (set in the Pages dashboard, rehearsed on a branch preview before
  main). `package.json` pins `workers-og` for `functions/og/[slug].js`; the compressed function
  bundle is ~690KB (fits every Workers plan). Card fonts are static assets under
  `public/fonts-og/` (see its README for regeneration). The OG PNG cache TTL (300s,
  `caches.default`, canonical pathname key — never the query string) is the revocation window —
  do not raise it without re-arguing revocation. **Branch rehearsal checklist (before main):**
  (1) build succeeds + `/api/release/<id>` still answers; (2) `curl -s -D - -o /dev/null <preview>/c/lanes-crate` (a real GET — a HEAD can bypass the
  Function and show the static path's headers) → 200, the FULL security-header set, and a
  per-crate `og:title` in the body; keep `SEC_HEADERS` in `functions/c/[slug].js` in lockstep with
  `public/_headers`); (3) `curl <preview>/og/lanes-crate` → 1200×630 PNG, cold render — and check
  the Pages Functions log for CPU-time errors (satori costs real CPU; if the plan's budget trips,
  the fallback is the plan's client-side pre-render, docs/wave-5b-plan.md T7-pre 4); (4) the
  preview's og:image points at traxwax.com (hardcoded), where /og/ 404s until this deploy reaches
  prod — hit the preview's own /og/ path directly instead.

## Auth (Clerk)

Production Clerk instance, registered under Supabase Third-Party Auth (native integration —
never the deprecated JWT-template method). The session token **must** carry
`"role": "authenticated"` — its absence files every request as `anon` and breaks profile
writes (launch-day incident 2, 2026-08-29). NOTE: `public/app/index.html` hardcodes the **production**
`pk_live_…` publishable key + `clerk.traxwax.com` with no dev/preview swap, so the pages.dev preview
runs the **production** Clerk instance too. The dev instance (`brave-buffalo-7127.clerk.accounts.dev`) is
**no longer** an in-code fallback — v1.14.1 (#52) removed the dev defaults, so every jwtVerify function
throws at boot if `CLERK_ISSUER`/`APP_ORIGIN` are unset (fail-closed).

## Local testing

```bash
cd public && python3 -m http.server 8000     # baked fixture mode, no auth/import
```

The full authenticated app needs the deployed Edge Functions, and **only production can
exercise them**: previews run prod Clerk (see Auth above) but every Edge function pins CORS
and `azp` to `https://traxwax.com`, so authenticated calls from `*.pages.dev` fail preflight
or 401 — that is fail-closed behavior, not a bug to debug. Previews are for static/
unauthenticated surfaces only; authenticated testing happens in prod (rollback is cheap).

## Verifying a deploy

- `https://traxwax.com/` → landing; `/app` → sign-in card (signed out)
- `curl -sI https://traxwax.com/boot.js` → `cache-control: no-cache` + security headers
- Signed in: crate renders from Supabase; header **EST.** fills (live-stats); modal shows
  tracklist + live stats; RE-SYNC and ACCOUNT buttons present
- Forged-token probe against any Edge Function → 401 `invalid_token`
- Footer shows both required Discogs notices

## Rollback

- **Static/front-end:** Pages keeps every deployment — Deployments → Rollback (instant, no
  git); then fix forward in the repo.
- **Edge Functions:** redeploy the previous version (Supabase retains them).
- **Migrations:** no automatic down-migrations; each plan documents its rollback SQL as an
  operator tool. Prefer fixing forward.

## Monitoring & backup (E6, audit #104)

The backend fails CLOSED by design: since #52, every authenticated Edge Function throws at
boot if `CLERK_ISSUER`/`APP_ORIGIN` are unset (via `_shared/auth.ts` since E1/#99) — a bad
secrets change 500s the entire authenticated product until someone notices. That someone
should be a robot:

- **Uptime probe 1 (static):** GET `https://traxwax.com/boot.js` — expect HTTP 200 with
  `cache-control: no-cache`. Covers Pages + DNS + certs.
- **Uptime probe 2 (backend boots + JWKS gate live):** POST
  `https://sfipqknrbvamwwahwxnl.supabase.co/functions/v1/live-stats` with header
  `Authorization: Bearer probe` — expect **HTTP 401** body `{"error":"invalid_token"}`.
  A 5xx means a function failed its fail-closed boot (secrets, or a broken bundle — see
  #106); a 200 would mean the auth gate is broken — page yourself for either.

**Implementation: `.github/workflows/uptime-probe.yml`** — both probes run on GitHub
Actions every 15 minutes (free on this public repo; GitHub emails the owner on a failed
scheduled run). Chosen over external free tiers because probe 2's success condition is an
EXPECTED 401 — a paid feature (or a permanent false alarm) on most uptime services.
Verified live at setup (2026-09-07): probe 2 returns `401 {"error":"invalid_token"}`.
Platform caveats: scheduled runs can lag minutes at busy times, and GitHub pauses schedules
after ~60 days without repo activity (any push resumes them). Any monitor that can assert on status + body
  substring works (UptimeRobot free tier does; 5-minute interval is plenty).
- **Logs:** Supabase Dashboard → Edge Functions → Logs; every function logs errors by
  status/name only (never token or secret values).

**Database backup posture** *(checked by Lane, 2026-09-07, Dashboard → Database → Backups)*:
automatic **daily physical backups** (observed ~08:35–08:40 UTC), a rolling window of at
least the last 8 daily snapshots, restorable from the dashboard. **PITR is NOT enabled**
(it's a paid add-on) — so the restore story is: roll back to the most recent nightly
snapshot, accepting **up to ~24h of data loss** (imports/wantlist changes since the
snapshot; users re-sync from Discogs, so most of it self-heals on the next import — the
truly unrecoverable slice is friendships/invites/visibility changes made that day).
Storage-API objects aren't covered, which is moot: TraxWax stores none. This is an
**accepted, written risk at current scale (4 users)**; the revisit trigger is real
multi-user growth or the first restore that hurts — at which point PITR is the upgrade.

---

## Retired

- **The weekly refresh cron** (`refresh-collection.yml`) — retired from schedule at v1.0.0;
  `workflow_dispatch` only, regenerating the dev fixture. The production data path is
  per-user import + the v1.2.0 self-healing catalog.
- **`/api/value` and `/api/price`** — deleted in the 1.0.0 cold audit; Restricted data flows
  only through `live-stats`.
- **The Cowork `rebuild-record-collection` task** — disabled 2026-08-28.
- **The `traxwax-site/` staging directory** — replaced 2026-08-17 by `traxwax-clone`.
