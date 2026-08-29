# Phase 1 cold audit — findings & argue-down triage (2026-08-29)

Independent no-context audit of the full `multi-user` branch before the merge to `main`.
35 findings; every one debated below. **Verdict key:** FIX-NOW (pre-merge), ISSUE (file on
GitHub, fix post-launch), ACCEPTED (documented risk, no action), DOWN (argued down — the
finding's premise or impact didn't survive).

## Survived — FIX-NOW (pre-merge batch)

| # | Finding (evidence) | Argue-down notes |
|---|---|---|
| 1 | **Username squatting**: `profiles_update_own` (0001:83-85) is an unrestricted UPDATE policy — any signed-in user can set `discogs_username` to any handle, permanently blocking that handle's real owner from connecting (unique index → `handle_taken`). | Survives at full strength: cross-user denial reachable today with the publishable key. Fix: column-level grants (migration 0006) — `authenticated` may update only `display_name` (+ `user_id` self-assignment for the upsert path); OAuth-owned columns become service-role-only. |
| 2 | **`collection_items` client-writable** (0001:90-92) with no legitimate client writer. | Self-scoped only, but free to close and closes #27's NULL path too. Drop the write policy (0006). |
| 4 | **live-stats serves cached Restricted data before the connected check** (live-stats:97-100). | One extra DB read per request is nothing at our scale; tightens the compliance story. Reorder + redeploy. |
| 8 | **Re-linking a different Discogs account renders the old account's collection** under the new name — `link_discogs_account` clears `import_status` but not `last_import_at`. | Real state-machine hole. Fix in the RPC (0006): on username change, null `last_import_at` **and delete the user's `collection_items`** in the same transaction — the old account's ownership data is Restricted and should not persist past the re-link anyway, and the deletion is what makes fix 9's "items exist" gate safe. |
| 9+11 | **First import blocks the UI for the whole enrichment** (~12–43 min for an unseen collection), and **an interrupted RE-SYNC never resumes enrichment** (un-enriched rows silently fall to the legacy proxy). | The strongest UX findings — "the first thing a real second user hits." **Gate design amended after the report's own verification pass caught the first version deadlocking stuck-`running` users and re-opening #8** (see Report-verification round below). Final design: **if `last_import_at` is set → render immediately** (and if `import_status==='running'`, self-heal with a background full pipeline; else a background enrich check). **If null:** `running` → blocking resume; `idle` + own items exist → render + background enrich; `idle` + no items → blocking first import. `runImport` returns after the import phase and starts enrichment unawaited. Safe **only in combination with the amended fix 8** (the re-link RPC deletes the old account's items), which is what makes "items exist" mean "current account's items." |
| 10 | **Stall guard counts rate-limited rounds as no-progress** (boot.js:298-313) — 3 rate-limited rounds abort a recoverable drain. | One line: don't increment on `rate_limited`. |
| 13 | **Import-phase 429s get generic 17s backoff** inside Discogs' 60s window. | The 429 arrives as a **body field on an HTTP 502** (`{error:'discogs_failed', status:429}`) and the driver currently discards the body's status (report-verification M2 — the naive `e.status===429` check would be dead code). Fix: `call()` attaches the body's `status` as `err.upstream`; `attempt()` waits 30s when `upstream === 429`. |
| 14 | **250ms inter-page pace only holds 60/min if round-trips ≥1s.** | Elapsed-aware pacing: `max(0, 1100 − elapsed)` per page. |
| 17 | **`coverBg` is the one unescaped interpolation** (app.js:196 → four style attributes) — attribute-injection XSS if a shared-catalog image URL ever contains `"`. Cross-user via `releases`. | Trust boundary is "Discogs never emits a quote in a URL" — not a boundary. Sanitize in `deco()`: https-only + encode quotes/parens/backslashes. |
| 19 | **Baked-mode price sort is lexicographic** — `String(price).padStart(9,'0')` ranks $12.50 below $9.99. | Pre-existing; one-line numeric comparator. |
| 21 | **`clerkReady()` hangs forever** if `boot()` runs after `load` already fired and Clerk is absent (boot.js:113-122). | One line: `if (document.readyState==='complete') return check();` |
| 22 | **Auth-state change during routing is dropped** (route() early-return + listener already flipped `lastSignedIn`) — sign-out mid-render leaves the crate up. | Queue one pending re-route. |
| 24 | **The legacy `/api` proxy is an anonymous window onto Lane's personal token**: `/api/value` publishes his collection value (1-day cache), `/api/price` + `/api/release` serve Restricted data (up to 7-day cache) to anyone, and enumeration can exhaust/flag his token. Contradicts the branch's own compliance backbone at the moment it goes public. | Fix on the branch so it rides the merge: **delete** `value.js` and `price/[id].js`; **slim** `release/[id].js` to CC0 fields only (tracks/country/released/videos — all `_fetchReleaseLive` consumes anyway); CC0 justifies the long cache. Baked mode loses the header EST in local dev only. |
| 25 | **Baked `collection.json` ships per-record prices AND community stats publicly** (1,778 records with `price`; all with `have/want/crating/crcount` — report-verification M1 caught the fix under-scoping to prices only) and the weekly workflow refreshes them. | Strip **price, have, want, crating, crcount** from the baked file on the branch; disable the weekly workflow at merge (the merged site reads the DB; baked mode remains a dev fixture). |
| 27 | **`instance_id` nullable under the unique constraint** (NULLs are distinct → constraint doesn't bind). | Live data has zero NULLs; encode the invariant: `SET NOT NULL` (0006). |
| 29 | **`db_now()`/`touch_updated_at()` mutable search_path** (live advisor WARN). | One-line `set search_path = ''` hardening (0006). |
| 34 | **Stage-B diagnostic probes still in `_redirects`** — the file says "remove after Stage D". | Stage D is done. Remove. |
| 35 | **No security headers.** | Add `_headers`: `frame-ancestors 'none'`-equivalent (X-Frame-Options DENY), nosniff, referrer-policy. Full CSP deferred (inline-style architecture). |
| 31 | **`APP_ORIGIN`/`CLERK_ISSUER` hardcoded in five functions** — dead-on-arrival at traxwax.com (CORS, azp, and the OAuth return URL all break). | Part of launch prep regardless; adopt the auditor's improvement: read both from env (function secrets) with the current constants as fallback, so the production flip is a secret change + no code edits. One redeploy of all five now. |
| 28 | 0005 not idempotent. | Already applied; fix the file for future replays (guard block). |

## Survived — ISSUE (file on GitHub, post-launch)

| # | Finding | Why deferred |
|---|---|---|
| 7 | No rate limit on `connect-discogs` leg 1 (hostile user can burn the consumer key's budget). | Needs a signed-in attacker; population ≈ friends at launch. Cooldown lands with Phase 2 hardening. |
| 15 | 404 tombstones permanent; catalog metadata never refreshes (`enriched_at` stamped but unused). | Architecture TODO before the catalog gets big; no launch impact. |
| 16 | `enrich-release` does ~12 DB round trips per 5 releases (~4,500 queries for a fresh large user). | Background enrichment (fix 9) removes the UX cost; the DB chatter is cheap. Replace with one join RPC later. |
| 18 | Search: full re-render per keystroke + caret jumps to end. | Pre-existing since v0.1; polish. |
| 20 | Dead code/drift: `api.price()` uncalled, `numForSale` unused, `folder`/`rating` imported-not-rendered, `display_name` unused. | Cleanup sweep; decide wire-up vs delete per item. |
| 23 | `THIS_MONTH` is UTC — badges flip a day off for non-UTC users. | Cosmetic. |
| 30 | No disconnect/account-deletion path (credentials permanent once written). | Already Phase 2 Open item (Stage B #3/#6); elevate priority — table stakes before strangers sign up. |

## ACCEPTED (documented, no action)

| # | Finding | Rationale |
|---|---|---|
| 3 | OAuth link fixation (attacker hands victim their authorize_url). | The already-accepted link-CSRF — Stage B Open item 6, Lane 2026-08-28, with the authenticated-finalize fix specified for Phase 2. Auditor independently rediscovered it; acceptance stands. |
| 5 | Shared `release:` cache serves data fetched under one user's token to another. | The data is byte-identical regardless of token; spec §7 itself specifies a shared short cache ("edge/KV"). Interpretation now recorded here. |
| 6 | Request-token secrets stored plaintext in `discogs_oauth_state`. | 15-min TTL, service-role-locked, and useless without the consumer secret (env-only) — a DB-only leak cannot complete a handshake. Asymmetry accepted and now documented. |
| 12 | Concurrent imports not mutually excluded. | Fully idempotent; the only cost is the user's own rate budget. Rejecting on `running` adds stuck-state failure modes worse than the disease. |
| 26 | DB-mode release fallback still reaches the legacy proxy. | With #24's slim-to-CC0, the tier is harmless and rarely reached (DB tier is first and complete). |
| 33 | The preview deployment survives the merge as a twin. | After #31's env flip, the functions accept only the production origin — the preview disarms itself. Note kept in the launch checklist. |

## DOWN (did not survive)

| # | Finding | Why |
|---|---|---|
| 32 | "Merging a dev Clerk instance in front of public traffic." | Not news — the production-instance cutover *is* the launch checklist's first item and is in progress in parallel. The merge does not precede it. |

## Sound (auditor-verified, recorded for the docs pass)

RLS ground truth on all five tables; JWKS verification posture; field-names-only log
discipline; AES-GCM implementation; atomic state consumption; the DB-clock watermark; the
1,000-row-cap handling; FK write ordering; `esc()` coverage (minus #17); Discogs
attribution notices; CI badge-sync input handling; the `_routes.json`/`_redirects` plumbing.

## Report-verification round (2026-08-29)

Per protocol this report was itself verified by an independent no-context agent before
becoming issues. It caught: **C1** — the original fix-9 gate ("items exist + idle") would
have deadlocked stuck-`running` users whose import completed (`idle` write is log-only on
failure) and re-opened finding #8's cross-account render through the new gate; fixed by the
amended design above, which is safe only jointly with the amended fix 8. **M1** — fix 25 was
under-scoped to prices; the baked file also ships have/want/crating/crcount. **M2** — fix
13's premise ("the server already returns status 429") was true of the body but not the
driver, which discards it; the plumbing is now specified. Minors: the 250ms pace holds at
RTT ≥ 750ms (not 1s); `CLERK_ISSUER` is in four functions, `APP_ORIGIN` in five; the stall
guard trips on the fourth zero-progress call and both the increment and break precede the
30s wait; the enrich round-trip count is ≈6,700 for a fresh 1,861-item user (not ~4,500).
Everything else — all citations, counts (21+7+6+1 = 35, each number once), and the
ACCEPTED/DOWN premises — verified correct.

## Remediation audit (2026-08-29)

The 21-fix FIX-NOW batch was itself adversarially audited before commit ("break this",
executed reproductions required). Attack surfaces 1 (the boot-gate rewrite) and 2 (the
destructive re-link RPC) — where silent data loss or wrong-user data would live — came back
**clean**, each enumerated exhaustively: the gate has no path that renders wrong-user data,
deadlocks, or double-runs; the RPC's first-connect and same-account-refresh paths were
reproduced safe; the profiles column grants still admit `ensureProfile`'s upsert (verified
live). **One INTRODUCED defect:** my #17 XSS fix used `encodeURIComponent`, which by spec
never encodes `'` `(` `)` — leaving the single quote, the actual `url('...')` breakout char,
untouched (it downgraded the risk to CSS-injection but didn't close it). Fixed with an
explicit 7-char map and reproduced both directions (real Discogs URLs byte-unchanged; a
hostile quote/paren URL fully encoded; non-https rejected). One-line correction, mechanically
verified — convergence reached, no third pass. Everything else in the batch held.
