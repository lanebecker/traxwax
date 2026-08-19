# TraxWax Phase 0 — Foundations (implementation plan)

The groundwork the multi-user build stands on, before any app code (Phase 1). Written to be
followed step-by-step. Parent plan: `docs/multi-user-spec.md`.

**Definition of done:** a TraxWax Supabase project exists with the schema + RLS applied and
the CC0 catalog seeded (~1,851 releases); Clerk is live and trusted by that project as a
third-party auth provider; a TraxWax Discogs app exists with its OAuth consumer key/secret in
hand. No user-facing code yet — that's Phase 1.

## Ownership legend

- 🧑 **Lane-side** — needs your account / browser (account signups, dashboards). I can't do these.
- 🤖 **Claude can run it** — via the Supabase MCP or a local script, on your go.

## Prerequisites

- The `traxwax-clone` repo (this folder), pushed to `github.com/lanebecker/traxwax`.
- Your Discogs account (for the OAuth app) and the ability to create a Clerk account.
- Decisions already locked: identity = **Clerk**; Discogs connect = **OAuth (v1)**; catalog =
  **CC0-only**.

---

## Step 1 — 🧑 Create the Clerk application

1. Sign up at **clerk.com** → **Create application** → name it `TraxWax`.
2. Enable the sign-in methods for v1: **Email + password**, and (optional) **Google**.
3. From **API keys**, copy the **Publishable key** (`pk_…`) and **Secret key** (`sk_…`) —
   you'll need them in Phase 1 (frontend + server). Keep the secret key secret.
4. **Add the `role` claim Supabase requires.** In Clerk → **Sessions** → **Customize session
   token**, set the claims to include:
   ```json
   { "role": "authenticated" }
   ```
   Supabase's PostgREST only accepts a JWT whose `role` claim is `authenticated`; without this
   every query is rejected. (Clerk's `sub` claim — the user id — is already present; our RLS
   reads it as `auth.jwt()->>'sub'`.)
5. In Clerk → **Integrations**, **activate the Supabase integration**. It reveals your
   **Clerk domain** (looks like `https://your-app-slug.clerk.accounts.dev`). Copy it — Step 3
   needs it.

> Why native integration (not the old JWT template): as of April 2025 Clerk's JWT-template
> approach is deprecated. The native integration means no sharing of Supabase's JWT secret and
> no extra token fetch per request.

---

## Step 2 — 🤖/🧑 Create the TraxWax Supabase project

A **separate** Supabase project from Spinbound — TraxWax's data must not share a database with
the near-App-Store Spinbound production project.

- 🤖 I can create it via the Supabase MCP once you tell me the **org** and **region** (suggest
  region **us-east-1** to sit near Cloudflare; free tier is fine to start), **or**
- 🧑 you create it at **supabase.com/dashboard** → **New project**, name `traxwax`, pick the
  region, and save the **project ref** and **anon/publishable key** (the anon key ships in the
  app; RLS protects the data).

Either way, note: **project ref**, **project URL** (`https://<ref>.supabase.co`), **anon key**,
and keep the **service_role key** server-side only (never in the app, never committed).

---

## Step 3 — 🧑 Connect Clerk as a third-party auth provider in Supabase

1. Supabase dashboard → **Authentication → Sign In / Providers**.
2. **Add provider → Clerk.**
3. Paste the **Clerk domain** from Step 1.5. Save.

That's the whole trust link: the TraxWax project will now accept Clerk-issued JWTs, and
`auth.jwt()` / `auth.uid()` inside RLS resolve from the Clerk session token. (When Spinbound
later adopts the same login, its project repeats exactly this step against the same Clerk domain.)

---

## Step 4 — 🤖 Apply the schema + RLS migration

File: **`supabase/migrations/0001_init.sql`** (in this repo — already written). It creates
`profiles`, `collection_items`, the CC0 `releases` catalog, and the locked-down
`discogs_credentials` table, with RLS keyed on `auth.jwt()->>'sub'`.

Apply it either way:

- 🤖 **Supabase MCP** — `apply_migration(name="0001_init", query=<file contents>)`. I'll run
  this on your go.
- 🧑 **SQL editor** — paste the file contents and run.

**Expected:** four tables created; RLS enabled on all four; policies on `profiles`,
`collection_items`, `releases`; **no** policy on `discogs_credentials` (intentional — it locks
the table to the service_role, so the encrypted Discogs tokens are unreadable by any client).

---

## Step 5 — 🧑 Register the TraxWax Discogs app (OAuth)

1. **discogs.com/settings/developers** → **Create an Application**.
2. Name `TraxWax`, description, homepage `https://traxwax.com`.
3. **Callback URL:** set to the Phase-1 OAuth-callback Edge Function, e.g.
   `https://<ref>.supabase.co/functions/v1/connect-discogs/callback`. (Discogs lets you edit
   this later, so a placeholder is fine now — the handshake is server-side in Phase 1.)
4. Save the **Consumer Key** and **Consumer Secret**. These authorize TraxWax to run the
   OAuth 1.0a flow; each *user* still authorizes their own account on top (their token is what
   reads their collection under their own 60/min budget).

> OAuth 1.0a endpoints Phase 1 will use (server-side, HTTPS): request token
> `https://api.discogs.com/oauth/request_token` → authorize
> `https://www.discogs.com/oauth/authorize` → access token
> `https://api.discogs.com/oauth/access_token`.

> Note: this is a **new** app registration, distinct from Spinbound's existing
> `DISCOGS_KEY`/`DISCOGS_SECRET` (which authenticate the covers resolver, not user OAuth).
> Don't reuse or regenerate those — it would break Spinbound's Discogs connector.

---

## Step 6 — 🤖 Seed the CC0 catalog

Script: **`build/seed_catalog.py`** (already written). It reads the baked `collection.json` +
`releases/*.json` and emits **CC0 fields only** (no prices, no community stats, no per-user
fields) into `seed_releases.sql`.

```bash
python3 build/seed_catalog.py
# Wrote …/seed_releases.sql
#   releases: 1853
#   with baked tracklists: 1853
#   without tracklists …: 0
```

Then load `seed_releases.sql` into the project (🤖 via MCP `execute_sql`, or 🧑 SQL editor / `psql`).

**Expected result: 1,851 rows in `releases`.** The script emits 1,853 rows but two release IDs
are owned twice in the collection (a Los Campesinos! and a Hana Vu pressing), and the
`ON CONFLICT (release_id) DO NOTHING` collapses each duplicate — which is the design working:
one catalog row per pressing, while both physical copies will live in `collection_items` (keyed
on `instance_id`) after a Phase-1 import.

`seed_releases.sql` is a generated ~2.9 MB artifact — it's git-ignored; regenerate it from the
script rather than committing it.

---

## Step 7 — Verify Phase 0

Run these in the Supabase SQL editor after Steps 4 + 6.

**Catalog loaded, CC0-only:**
```sql
select count(*) from public.releases;                 -- expect 1851
select release_id, artist, title, styles, country
  from public.releases order by release_id limit 3;   -- sane CC0 rows, arrays populated
-- confirm no restricted columns exist:
select column_name from information_schema.columns
  where table_name='releases'
    and column_name in ('price','crating','have','want');   -- expect 0 rows
```

**RLS actually isolates users** (simulate a Clerk token):
```sql
set role authenticated;
select set_config('request.jwt.claims','{"sub":"user_A","role":"authenticated"}', true);

insert into public.profiles(user_id) values ('user_A');   -- OK (sub matches)
insert into public.profiles(user_id) values ('user_B');   -- must FAIL (WITH CHECK violation)
select count(*) from public.releases;                     -- OK: public read (1851)
select * from public.discogs_credentials;                 -- 0 rows / denied (no policy → locked)

reset role;
```
If the `user_B` insert succeeds or `discogs_credentials` returns data under the `authenticated`
role, RLS is misconfigured — stop and fix before Phase 1.

> Verification honesty: the migration + seed were written and the seed's JSON payload was
> parse-validated (1,853 objects, CC0 keys only, no price/stat fields), but I could **not**
> execute them against a live Postgres in the sandbox (no root to install one). The checks
> above are how we confirm on the real project. `jsonb_to_recordset` → `text[]` (used by the
> seed for `styles`/`genres`) is standard PG behavior supported on Supabase's PG17.

---

## Secrets — where each one lives (never in the repo)

| Secret | Home | Used by |
|---|---|---|
| Clerk **secret key** (`sk_…`) | server env (Phase 1 Edge Functions / Pages) | verifying/creating sessions server-side |
| Clerk **publishable key** (`pk_…`) | app config (ships in frontend) | the login widget |
| Supabase **service_role key** | server env only | Edge Functions (bypass RLS; always scope to `user_id`) |
| Supabase **anon key** | app config (ships in frontend) | RLS-protected client reads |
| Discogs **consumer key/secret** | server env only | the OAuth 1.0a handshake |
| Per-user Discogs **OAuth token** | `discogs_credentials` (encrypted, server-only) | reading that user's collection/prices |

## Not in Phase 0 (that's Phase 1)

The Clerk login UI, the Discogs OAuth Edge Functions (`connect-discogs`, `import-collection`,
`enrich-release`, `live-stats`), the app's data-source swap, and the attribution UI. Phase 0 only
stands up the accounts, the trust link, the schema, and the seeded catalog.

## Handoff

Do the 🧑 steps (1, 3, 5) and tell me the org/region for the project — I'll run the 🤖 steps
(create project, apply `0001_init.sql`, generate + load the seed) via the Supabase MCP, then we
run Step 7 together.
