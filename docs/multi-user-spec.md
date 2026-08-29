# TraxWax — Multi‑User Plan

> **AS-BUILT NOTE (2026-08-29).** This is the DESIGN document, preserved as written
> (2026-08-18). The system SHIPPED — v1.0.0 through v1.2.0, all 2026-08-29 — and diverges
> from this text in ways the phase plans record. Where they conflict, **the plans and the
> code are authoritative**, not this spec. The load-bearing divergences:
>
> - **§4 OAuth flow:** the callback does NOT complete the link or store tokens "on the
>   profile." It parks the result in `discogs_pending_links` with a one-time fragment code;
>   `finalize-connect` (code hash + verified Clerk sub) completes it — the link-CSRF fix
>   (v1.1.0, `docs/phase-2-account-plan.md`). Tokens live encrypted in
>   `discogs_credentials`.
> - **§6 "skips releases already enriched (CC0 is immutable)":** falsified by v1.2.0 —
>   basic metadata merges last-import-wins on every import, 404 tombstones (`gone_at`)
>   retry after 7 days, deep fields re-fetch after 180 days
>   (`docs/phase-2-catalog-refresh-plan.md`).
> - **§6 function roster:** the shipped set is 8 — connect-discogs, connect-discogs-callback,
>   finalize-connect, disconnect-discogs, delete-account, import-collection, enrich-release,
>   live-stats. (`refresh-collection` never existed as a function.)
> - **§5 schema:** `profiles.display_name` was dropped (0008); `releases` gained `gone_at`
>   (0010); `discogs_oauth_state` and `discogs_pending_links` exist (0003, 0009).
> - **§11 "profile/settings, Phase 2 later":** disconnect + account data deletion shipped
>   in v1.1.0 (the ACCOUNT modal); deletion never touches the shared Clerk identity.

Turning TraxWax from "Lane's baked collection, static" into "anyone's collection, behind a
login." Review before building — open decisions are flagged in **§11**.

**Confirmed direction (2026‑08‑18):**
- **Auth = a standalone identity provider (Clerk)**, set up for TraxWax first; Spinbound
  ported onto the same login later (§3).
- **Discogs connection = OAuth, in v1.** Promoted from a later phase because the API terms
  make it the correct path (private collections + per‑user rate budgets + it resolves the
  Restricted‑data question — §4, §8).
- **Data is tiered per the Discogs terms:** the shared catalog stores **CC0 data only**;
  prices / marketplace / collection data are fetched **live (≤6h), never permanently
  mirrored** (§5, §8).
- **Non‑commercial**, with required Discogs attribution baked into the UI (§8, §9).

> Revision note: v2 of this plan. v1 assumed public‑username import with OAuth deferred; the
> Discogs terms review (§8) moved OAuth into v1 and dropped username import.

---

## 1. The core shift

Today TraxWax serves **one** dataset — Lane's — baked at build time (`collection.json` +
`releases/*.json`). Multi‑user means **per‑user** collections, fetched via each user's own
Discogs authorization and gated by a login. That's a real backend app. But most of the hard
work is reused.

**What carries over unchanged**
- The entire UI (crate / timeline / ledger, filters, themes, the mobile modal). It loads
  *the logged‑in user's* collection instead of a static file.
- Cloudflare Pages hosting; the Discogs proxy pattern (now per‑user‑authenticated).

**The key structural insight — the release catalog is universal, but only its CC0 half is
storable.** A pressing's tracklist, credits, and cover are the same for everyone and are
CC0 (public‑domain) — so the work already baked (`releases/*.json`) becomes a **shared
catalog** all users draw from. Prices, community stats, and *which releases a user owns* are
**Restricted** data under the terms — fetched fresh per view, not stored (§8). That split is
the backbone of the whole design.

---

## 2. Architecture at a glance

```
                 ┌──────────────────────────┐
   Browser ────▶ │  TraxWax UI (CF Pages)    │
   (login)       │  app.js, styles.css       │
                 └───┬───────────┬───────────┘
          (Clerk JWT)│           │
                      ▼           ▼
        ┌────────────────────┐   ┌──────────────────────────────────┐
        │  Clerk (identity)  │   │  TraxWax data (Supabase)          │
        │  shared login;     │   │  profiles · collection_items      │
        │  Spinbound later   │   │  releases  ← CC0 catalog (stored) │
        └────────────────────┘   │  Edge Functions                   │
                                 └───────┬──────────────────┬────────┘
                                         │ (CC0 enrich)     │ (Restricted: live ≤6h,
                                         ▼                  ▼  under the USER's OAuth token)
                                    Discogs API  ◀──────────┘
```

- **Clerk** — the shared login; TraxWax trusts it now, Spinbound later (§3).
- **Supabase (TraxWax data project)** — per‑user collections + the shared **CC0** catalog +
  Edge Functions. RLS on Clerk's user id.
- **Discogs** — reached server‑side under **each user's own OAuth token** for their
  Restricted data (prices/stats/collection); CC0 catalog data is enriched once and stored.

---

## 3. Identity & auth — Clerk, TraxWax first

Lane's call: a standalone identity provider that both apps can share, stood up for TraxWax
now, Spinbound ported in later ("not many users there yet, so manageable").

**Mechanism (verified against current Supabase docs):** Supabase natively supports
**third‑party auth**, trusting JWTs from **Clerk, Auth0, Firebase, Cognito, or WorkOS**, with
RLS through `auth.jwt()` / `auth.uid()` (provider must issue asymmetric OIDC JWTs). Note:
another *Supabase project* is **not** a supported issuer, so "a dedicated Supabase `accounts`
project other projects trust" is not a first‑class path — a managed provider is the clean way.

**Provider = Clerk.** Purpose‑built for one‑login‑across‑apps, prebuilt sign‑in UI, generous
free tier, and a *native* Supabase integration (the older JWT‑template method was deprecated
April 2025 in favor of it). TraxWax's Supabase trusts Clerk; RLS keys off the Clerk user id.
When Spinbound ports over, its Supabase trusts the *same* Clerk instance — one login, both
apps. **Locked: Clerk** (2026‑08‑18). *(Auth0 was the enterprise‑grade alternative on the
same pattern; not chosen.)*

**Spinbound retrofit is out of scope for v1.** Spinbound uses Sign in with Apple +
email/password on its own Supabase Auth today; porting it means pointing it at Clerk (which
supports Apple sign‑in) and migrating its users — real but bounded, and cheapest while its
user base is small. TraxWax v1 does not depend on it.

**TraxWax v1 login methods:** email + password and/or Google via Clerk; Apple etc. add later
without touching TraxWax.

---

## 4. Connecting Discogs — OAuth, in v1

After login, a user connects their Discogs account via **OAuth** (Discogs uses **OAuth 1.0a**,
requiring a registered TraxWax Discogs app — consumer key + secret).

**Flow:** Connect Discogs → Discogs authorize screen → callback returns a per‑user
**access token** → store it **encrypted, server‑side** on the user's profile → kick off the
import (§6). The token is a secret and is treated like one (§5 security).

**Why OAuth is v1 (not username import):**
- **Private collections work** — no "make your collection public first" friction.
- **Per‑user rate budgets** — each user spends their *own* 60 req/min, which is the real
  scaling answer *and* the only terms‑compliant one (creating extra app keys to raise the
  ceiling is prohibited — §8).
- **It resolves the Restricted‑data question** — the user reads *their own* collection,
  prices, and stats under *their own* grant, so TraxWax isn't redistributing its
  app‑licensed data to third parties (§8).

Public‑username import (the old v1 idea) is **dropped** — OAuth supersedes it on every axis.

---

## 5. Data model (TraxWax data project)

`user_id` = the Clerk user id (from the verified JWT). RLS everywhere.

**`profiles`** — one row per user.
`user_id (pk)`, `discogs_username`, `discogs_oauth_token` *(encrypted; secret)*,
`discogs_connected_at`, `last_import_at`, `import_status` (`idle|running|error`),
`display_name`, `created_at`.
*RLS: a user reads/writes only their own row. The OAuth token is never returned to the
client — server‑side Edge Functions only.*

**`collection_items`** — which releases a user owns (per‑user; sourced from their OAuth import).
`id (pk)`, `user_id`, `release_id`, `folder`, `rating` (personal 0–5), `added` (date),
`vinyl` (variant), `instance_id`, `created_at`. Unique `(user_id, instance_id)`.
*RLS: user reads/writes only `user_id = auth.uid()`. This is the user's own collection data,
held to render their app and refreshed on import — a working store, not a redistribution.*

**`releases`** — the **shared, global CC0 catalog** (public‑domain, storable forever).
`release_id (pk)`, `artist`, `title`, `year`, `label`, `styles[]`, `genres[]`, `thumb`,
`cover_image`, `tracks (jsonb)`, `country`, `released`, `videos (jsonb)`, `enriched_at`.
**No price / community‑stat columns** — those are Restricted and are fetched live (§6/§8).
*RLS: public read; writes only by the service role (Edge Functions).*

**Not stored anywhere:** marketplace **prices / sales history** and **community
rating / have‑want**. These are fetched live (≤6h cache) per view (§6, §8).

The UI's flat record shape is assembled by joining `collection_items` (mine) to `releases`
(shared CC0), with price/stats fetched separately and merged client‑side at render.

---

## 6. Backend (Supabase Edge Functions)

Same pattern Spinbound already uses. Server‑side, scoped to `auth.uid()`, holding secrets.

- **`connect-discogs`** — runs the OAuth 1.0a handshake; stores the encrypted per‑user token.
- **`import-collection`** — using the caller's Discogs token, page their collection
  (per_page 100), upsert `collection_items`, and for any `release_id` missing from the CC0
  `releases` catalog, enqueue enrichment. Sets `profiles.import_status`. Idempotent.
- **`enrich-release`** — worker: `get_release(id)` → upsert **CC0 fields only** into
  `releases` (tracks/credits/country/dates/cover). Runs under the importing user's token;
  skips releases already enriched (CC0 is immutable).
- **`live-stats`** — proxy for Restricted data: given a release id, fetch **price + community
  stats** live under the caller's token, **cache ≤6h** (short‑lived edge/KV cache, never the
  DB), return to the client. Backs the grid prices, header value, and modal stats.
- **`refresh-collection`** — re‑sync the caller's owned set (adds/removes) under their token.

Reads of the user's own collection + the CC0 catalog are direct PostgREST queries under RLS —
no custom endpoint. Only Restricted data and token‑holding actions go through Edge Functions.

---

## 7. Rate limits & freshness

Discogs = **60 req/min per token**; Restricted data must be **≤6h fresh** and un‑mirrored.

1. **Per‑user OAuth budgets** — each user's imports/refreshes spend their own 60/min. No
   single shared bottleneck, and no prohibited key‑multiplication.
2. **The shared CC0 catalog** absorbs most enrichment — a release's tracklist is fetched
   once for everybody; a new user who owns mostly‑known releases imports fast.
3. **Live‑stats caching ≤6h** — prices/stats are cached briefly (edge/KV) to avoid hammering,
   but never stored long‑term, satisfying the freshness rule.
4. **Import throttle** — cap concurrent imports per account; enrichment drains a queue under
   the token ceiling.

---

## 8. Discogs API terms — how the design complies

*Reasoning from `Discogs-API-Terms-Summary.md`; not legal advice — confirm load‑bearing
points with Discogs if this ever monetizes.* Non‑commercial keeps the **monetization** clauses
off the table (no selling price/collection data, no ads around prices). Three rule‑families
shape the design, and each is now satisfied by construction:

| Rule | Design response |
|---|---|
| **Two tiers.** CC0 (titles, artists, tracklists, credits, labels, formats, dates) is storable; Restricted (prices, sales history, collections, usernames, sale‑tied images) is personal, non‑transferable, ≤6h fresh, no permanent mirror. | Shared `releases` catalog stores **CC0 only**; prices/stats fetched **live ≤6h**, never stored (§5/§6). |
| **Restricted data is licensed to *you*, non‑transferable.** | Every user reads their *own* Restricted data under their *own* **OAuth** grant — not TraxWax redistributing app‑licensed data (§4). |
| **6‑hour freshness / no permanent mirror.** | Live‑stats cache is ≤6h and ephemeral (§6). CC0 is exempt (public‑domain). |
| **No extra API keys to beat the rate limit.** | Scaling is per‑user OAuth budgets, not key multiplication (§7). |
| **Attribution, even when free.** Two notices required. | Baked into the UI (§9): footer disclaimer + "Data provided by Discogs" do‑follow link. |
| **No driving traffic to non‑Discogs.** | The ▶ LISTEN → YouTube‑search link uses CC0 data, is a user convenience, unmonetized — low‑risk; kept modest. |
| **Access revocable anytime.** | App degrades gracefully if a token is revoked or the API is unavailable. |

---

## 9. Frontend changes (the existing app)

- **Auth gate** — Clerk's login/sign‑up; session persists.
- **Connect Discogs (OAuth)** — a "Connect your collection" step launching the OAuth flow,
  plus import‑progress and empty states.
- **Data source swap** — replace `fetch('./collection.json')` with a Supabase query for the
  logged‑in user's collection (join `collection_items` → `releases`); merge live prices/stats
  from `live-stats`. Render code otherwise untouched.
- **Attribution (required):**
  - Footer disclaimer, verbatim: *"This application uses Discogs' API but is not affiliated
    with, sponsored or endorsed by Discogs. 'Discogs' is a trademark of Zink Media, LLC."*
  - *"Data provided by Discogs"* next to Discogs data, **hyperlinked do‑follow (not
    `nofollow`)** to the relevant discogs.com page (the modal's "VIEW ON DISCOGS" covers the
    target).
- **Header value / Ledger** — computed from the user's own collection (same code, live stats).
- **"Refresh my crate"** button + last‑synced indicator.
- **Owner line** = the user's Discogs handle (the design already reserved this slot).

---

## 10. Reuse of existing work + seed

- **Seed the CC0 catalog** from what's already baked: `releases/*.json` (tracks/country/videos)
  and the CC0 fields of `collection.json` (artist/title/year/label/styles/genres/covers) load
  straight into `releases` — ~1,850 releases enriched for free. **Do not** seed prices or
  community stats (Restricted — fetched live).
- **`refresh_collection.py`**'s `get_release` → slim‑mapping logic moves into `enrich-release`
  (CC0 fields) and `live-stats` (Restricted fields), split along the tier line.
- The current single‑user static site keeps running untouched during the build; the
  multi‑user app ships alongside and flips over when ready. *(Per Lane: no changes to the
  personal site — it's being replaced.)*

---

## 11. Phasing

- **Phase 0 — foundations.** Stand up Clerk + wire Supabase third‑party auth. Register the
  TraxWax Discogs app (consumer key/secret) for OAuth. Create the TraxWax Supabase project.
  Seed the CC0 `releases` catalog from existing baked data.
- **Phase 1 — multi‑user MVP (ships a usable app).** Clerk login; Discogs **OAuth** connect;
  `import-collection` + `enrich-release`; per‑user collection on the existing UI; `live-stats`
  for prices/stats; attribution; refresh button.
- **Phase 2 — hardening & polish.** Import throttling/queue tuning, onboarding, profile/
  settings, error/empty‑state polish, monitoring, custom domain.
- **Phase 3 — reach.** Public shareable crates, Apple/Google sign‑in on Clerk, and
  (optionally) migrating Spinbound onto the shared Clerk identity.

---

## 12. Open decisions / risks

- **Discogs OAuth 1.0a plumbing** — 1.0a (not 2.0) needs request‑token/authorize/access‑token
  handling; token stored encrypted server‑side. Validate the flow early in Phase 0.
- **Token storage security** — the per‑user Discogs token is a secret; encrypt at rest,
  never return it to the client, Edge‑Function‑only (mirrors Spinbound's secret‑key rule).
- **Live‑stats latency** — prices now load live per view (was: instant from baked data).
  Mitigate with the ≤6h cache + skeleton states; acceptable, and terms‑mandated.
- **Scale / cost** — `collection_items` grows with users; the CC0 `releases` table stays
  bounded (union of owned releases). Watch Supabase row/storage/MAU and Clerk MAU tiers.
- **Abuse / cost control** — per‑account import rate‑limit; ephemeral live‑stats cache.

---

## 13. Non‑goals for v1

Writing back to Discogs, social/following, a native mobile app, migrating Spinbound's auth,
and any monetization (which would pull prices/collections/marketplace data back off the
table). All later‑phase or separate.
