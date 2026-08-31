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

Pages auto-detects `functions/` (the legacy proxy — now only `/api/release/:id`).
`public/_routes.json` pins Functions to `/api/*` so `_redirects` and `_headers` govern
everything else.

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
Supabase involvement, nothing in the CSP path (there is no CSP). The `data-website-id` is **not
a secret** (it's public in the HTML) — it lives in the repo, one value in both files; to rotate
or set it, replace `REPLACE_WITH_UMAMI_WEBSITE_ID` in both and push. Config choices, all
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

Project `sfipqknrbvamwwahwxnl` (`https://sfipqknrbvamwwahwxnl.supabase.co`). **Eight
functions**, all `verify_jwt: false` with in-handler `jose.jwtVerify` against Clerk's JWKS
(the platform gate cannot validate Clerk RS256 — Stage B finding C1):

| Function | Role |
|---|---|
| `connect-discogs` | OAuth 1.0a leg 1 + 10s per-user cooldown (v1.0.1) |
| `connect-discogs-callback` | OAuth leg 2 — parks the completed link as *pending* + one-time fragment code (v1.1.0) |
| `finalize-connect` | Completes a pending link: code hash + verified Clerk sub (closes the link-CSRF) |
| `disconnect-discogs` | Unlink: credential + imported items deleted, profile reset |
| `delete-account` | Purge all TraxWax data (never the Clerk identity); server re-checks the typed `DELETE` |
| `import-collection` | One collection page per invocation; seeds the catalog via the `seed_releases` merge RPC (v1.2.0) |
| `enrich-release` | Budgeted CC0 enrichment + refresh drain (7d tombstone retry, 180d TTL) |
| `live-stats` | Restricted data, live under the caller's token, ≤6h in-instance cache |

**Secrets** (Supabase → Edge Functions → Secrets): `DISCOGS_CONSUMER_KEY`,
`DISCOGS_CONSUMER_SECRET` (the `TraxWax` Discogs app), `DISCOGS_TOKEN_ENC_KEY` (32-byte
base64; AES-256-GCM at rest — rotating it orphans stored tokens, forcing reconnects),
`APP_ORIGIN` (`https://traxwax.com`), `CLERK_ISSUER` (the **production** Clerk instance).
The in-code fallbacks for the last two point at the dev/preview values — env always wins.

**Deploying:** via the Supabase MCP connector (`deploy_edge_function`, file layout
`{<fn>/index.ts, _shared/discogs.ts}`, entrypoint `<fn>/index.ts`, `verify_jwt: false`) or
`supabase functions deploy <fn>` with the CLI. Supabase keeps every version — rollback is
redeploying the previous one. **After any deploy, verify the 401 gate:** POST with a forged
Bearer token must return `{"error":"invalid_token"}` (proves the bundle booted AND JWKS
verification runs).

## Surface 3 — Database

Postgres with RLS keyed on `auth.jwt()->>'sub'` (Clerk TEXT ids). Migrations `0001`–`0010`
applied; the migration map lives in `CLAUDE.md`. Apply via the MCP `apply_migration` (or
`supabase db push`), verify with the checks each migration's plan documents, then commit the
file. Writer RPCs (`link_discogs_account`, `finalize_discogs_link`,
`unlink_discogs_account`, `delete_account`, `pending_enrichment`, `seed_releases`, `db_now`)
are SECURITY DEFINER and granted to `service_role` only.

## Auth (Clerk)

Production Clerk instance, registered under Supabase Third-Party Auth (native integration —
never the deprecated JWT-template method). The session token **must** carry
`"role": "authenticated"` — its absence files every request as `anon` and breaks profile
writes (launch-day incident 2, 2026-08-29). The dev instance
(`brave-buffalo-7127.clerk.accounts.dev`) still backs the pages.dev preview.

## Local testing

```bash
cd public && python3 -m http.server 8000     # baked fixture mode, no auth/import
```

The full authenticated app needs the deployed Edge Functions; test on the
`multi-user.traxwax.pages.dev` preview (dev Clerk) rather than running functions locally.

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

---

## Retired

- **The weekly refresh cron** (`refresh-collection.yml`) — retired from schedule at v1.0.0;
  `workflow_dispatch` only, regenerating the dev fixture. The production data path is
  per-user import + the v1.2.0 self-healing catalog.
- **`/api/value` and `/api/price`** — deleted in the 1.0.0 cold audit; Restricted data flows
  only through `live-stats`.
- **The Cowork `rebuild-record-collection` task** — disabled 2026-08-28.
- **The `traxwax-site/` staging directory** — replaced 2026-08-17 by `traxwax-clone`.
