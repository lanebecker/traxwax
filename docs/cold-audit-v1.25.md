# Cold Audit — v1.25.0 (2026-09-06)

**Scope:** entire codebase at HEAD `02ddd6e` (v1.25.0) — frontend (`public/`), Edge Functions
(`supabase/functions/`), all 33 migrations, Pages Function, workflows, headers/redirects, docs.
**Method:** four independent cold subagents (frontend / Edge functions / database / infra +
cross-layer contracts), zero inherited context, followed by an argue-down triage in which every
surviving finding below was re-verified against the actual code (file:line quotes spot-checked;
both HIGHs confirmed by direct inspection). Duplicate findings across agents were merged.
**Result:** no critical auth bypass or cross-user data leak found. The material issues cluster
around Restricted-data lifecycle gaps, abuse surface on unauthenticated/cheap endpoints, and a
batch of frontend correctness bugs. 44 findings survived triage (41 actionable + 3 NOTEs: B9,
D9, E7), organized below into five issue-bearing waves intended to become GitHub milestones
(Waves A–E) plus one fix-in-flow docs pass (Wave F). A verification pass was run on this
document itself (2026-09-06); its catches are corrected inline, with the one false claim
struck through in place rather than deleted.

**Proposed milestone order:** A (data hygiene) → B (abuse/auth hardening) → C (UX bugs) →
D (performance/scale) → E (architecture/ops debt). A and B carry the risk; C is the cheapest
user-visible win; D matters before the user count grows; E is consolidation.

---

## Wave A — Restricted-data lifecycle (milestone: "Data that should die, dies")

The backbone constraint says Restricted data (ownership, prices, community stats) never
outlives the connection that justified it. Five places where it currently does, plus two
retention-hygiene gaps.

### A1. HIGH — `link_discogs_account` doesn't delete wantlist/inventory on a handle change
`supabase/migrations/0006_audit_hardening.sql` (final effective body; 0003→0004→0006 chain).
The changed-handle branch deletes only `collection_items`. When `wantlist_items` (0017) and
`inventory_items` (0027) were added, `unlink_discogs_account` and `delete_account` were amended
each time — `link_discogs_account` never was. Re-linking a *different* Discogs account keeps the
old account's wantlist and for-sale rows, attributed to the new handle, visible to friends via
`wantlist_select_friends`, `get_friend_forsale`, `crate_match`, and `get_social_feed`, until the
next full import of that kind sweeps them. Also unreset: the three `import_started_*` watermarks.
0006's own comment states the rule this violates ("must not persist past the re-link at all").
**Fix:** in the changed-handle branch, also `delete from wantlist_items / inventory_items where
user_id = p_user_id` and null the three `import_started_*` columns. New migration; service-role
posture unchanged.

### A2. HIGH — the retired refresh workflow will republish priced data with one click
`.github/workflows/refresh-collection.yml` + `build/refresh_collection.py:101-103,176-184`.
The workflow header says "if run, strip price/have/want/crating/crcount before committing" — but
no step does, and the script still unconditionally fetches and writes those five fields into
`public/collection.json`, which the workflow auto-commits and Pages auto-deploys. One click of
"Run workflow" re-creates the exact Discogs-terms violation the v1.0.0 cleanup removed, live on
traxwax.com ~35 minutes later. The guard is a comment, not code.
**Fix:** make the script strip the five fields by default (or drop the price/community fetch
entirely — the dev fixture never needs it), and/or add a strip step between generate and commit.

### A3. HIGH (decision) — 1,778 priced rows live in public git history forever
Commit `d99a922` ("chore: weekly data refresh (2026-08-24)") contains `collection.json` with
`price/crating/crcount/have/want` populated on 1,778 of 1,861 rows — verified by direct
`git show`. The v1.0.0 cleanup stripped the working tree only; the priced dataset is one
`git show` away on the public repo, permanently mirrored — which is precisely what the Discogs
terms (and the project's own backbone constraint) forbid. (Precisely: 1,778 rows carry `price`;
1,765 carry all five Restricted fields.) Scrubbing requires `git filter-repo`
+ force push, which collides with the repo's force-push ban, plus a GitHub support request to GC
cached commits — so this is a deliberate Lane decision either way. The wrong move is deciding by
default. **Fix:** decide: (a) history rewrite with explicit `GIT_GUARDRAIL_ALLOW` ceremony, or
(b) documented acceptance of the residual exposure. (Related decision: `public/collection.json`
today is still Lane's full ownership list with per-record `added` dates, world-readable at
traxwax.com/collection.json, bypassing the entire visibility system. It's self-published
knowingly, but the "Restricted fields removed" framing overstates the cleanup — consider a
synthetic fixture.)

### A4. MED — `profiles_guard` doesn't pin the `import_started_*` watermark columns
`0007_profiles_guard_trigger.sql` (guard) vs `0022_import_watermark.sql`/`0027` (columns).
The guard pins `discogs_username/discogs_connected_at/last_import_at/import_status` but the
three watermarks 0022 moved server-side *specifically to stop client steering of the sweep* are
freely writable via plain PostgREST `PATCH /profiles`. A user can resurrect the exact self-wipe
0022 fixed (future watermark → sweep deletes the just-imported rows) or pin the watermark in the
past so rows deleted on Discogs are retained indefinitely — a Restricted-retention violation the
user can deliberately induce and friends then see. **Fix:** pin the three columns in the guard.

### A5. MED — `live-stats` cache survives disconnect/re-link: stale cross-account values
`supabase/functions/live-stats/index.ts:134,174-175`. `value:${userId}` is keyed on the Clerk
sub only and never invalidated on disconnect. Disconnect account A → connect account B → the
ledger shows A's collection value for up to 6h. Restricted data outliving its severed
connection, on the user's own screen. **Fix:** key the cache on
`value:${userId}:${discogs_username}` (profile is already fetched on that path).

### A6. LOW — leg-1 OAuth request-token secrets stored plaintext
`connect-discogs/index.ts:159-163`, `0003_discogs_connect.sql`. Access tokens are AES-GCM
encrypted; request-token secrets in `discogs_oauth_state` are plaintext — a backup snapshot
contains live-looking handshake secrets. Service-role-only table, so low — but it's an
asymmetry that looks like oversight, and 0003's comment calls the value "a credential."
~~and no SQL path ever deletes expired rows (only per-user deletes on unlink/delete)~~
*(struck by verification pass: a global expired-row sweep DOES exist at
`connect-discogs/index.ts:110` — it runs on every connect invocation by anyone. Residual truth:
on a quiet site with no connects, expired rows sit until the next connect.)* **Fix:** encrypt
with the existing `DISCOGS_TOKEN_ENC_KEY`.

### A7. LOW — social-graph residue: consumed invites kept forever; `accepted_by` survives un-friending
`0015_invite_soft_consume.sql`, `0016`. Sweeps delete only expired-AND-unused rows; used invites
are a permanent "X invited Y at T" record, and `remove_friend` leaves `accepted_by` (the
ex-friend's Clerk sub) readable by the inviter forever (`delete_account` nulls it; removal does
not). **Fix:** retention window on used rows; clear `accepted_by` in `remove_friend`.

---

## Wave B — Abuse surface & auth hardening (milestone: "Close the cheap attacks")

### B1. HIGH — `connect-discogs-callback` has a silent `APP_ORIGIN` dev fallback; every other function fails closed
`connect-discogs-callback/index.ts:14`:
`const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? 'https://multi-user.traxwax.pages.dev';`
All eight other functions throw at load citing "#52: fail CLOSED — no dev fallback." This is
the one function that *redirects a browser carrying the one-time finalize code*; if `APP_ORIGIN`
is ever unset here, the 302 sends `#twcode=<code>` (a live 15-minute credential-completion
capability) to a stale pages.dev preview running old code. A #52 remediation that missed one
file. **Fix:** one line — same `if (!APP_ORIGIN) throw` as the rest. (See E1 for why this class
of miss happened.)

### B2. HIGH — `/api/release/:id` is an unauthenticated, unthrottled burner for the shared site token
`functions/api/release/[id].js:17-49`. No auth, no rate limit; only *successful* responses are
cached, so a loop over nonexistent ids hits Discogs on every request forever; once the ~60/min
budget is gone, the built-in 429 retry makes each incoming request cost **two** upstream calls
plus a 900ms sleep — amplifying the exhaustion it papers over. One `while true; curl` kills the
modal-fallback tier site-wide and keeps it dead, burning `DISCOGS_TOKEN` (Lane's PAT) the whole
time. **Fix:** cache negative results (404 → `{gone:true}` for hours; 429 → short negative
cache), drop or gate the retry, and add a Cloudflare rate-limiting rule on `/api/release/*` —
or delete the tier (the Supabase `releases` table is tier 0).

### B3. MED — connect cooldown is check-then-act; parallel requests bypass it entirely
`connect-discogs/index.ts:88-121`. N parallel requests all pass the `< 10s` check before any
placeholder insert commits; each burns a `request_token` call against the *site-wide* consumer
budget. One authenticated user with `Promise.all(Array(60)...)` empties the connect budget every
10s. **Fix:** make the arm atomic — partial unique index on `discogs_oauth_state(user_id)` so
concurrent inserts conflict, or a single SECURITY DEFINER RPC doing `INSERT ... ON CONFLICT`
with the time predicate. (Also: the sweep and callback expiry checks use the edge clock, not
`db_now` — inconsistent with the one-clock doctrine.)

### B4. MED (product call) — an invite link is a GET-driven state change with zero confirmation
`public/boot.js:986,1013` — merely *opening* `/i/<code>` while signed in executes
`accept_friend_invite`: a bidirectional friendship + (under default `friends` visibility)
immediate read access to the victim's crate, wantlist, and for-sale data. No "Accept invite
from @X?" interstitial; the first thing the user sees is the result. An attacker puts their
invite URL behind any link/QR; a signed-in click silently friends them. **Fix (needs Lane's
design approval per L5):** confirmation card before the RPC — inviter's name via a read-only
preflight, then accept on an explicit click.

### B5. MED — `private`-schema function ACL drift
Three related, verified facts:
(a) `private.can_view_forsale` (0028) is the **only** gate function with no revoke/grant ritual
— default PUBLIC EXECUTE stands. (b) `private._feed_overlap` / `_feed_overlap_unlisted` (0033:
lines 124-125) are **granted to `authenticated`** — SECURITY DEFINER helpers that trust their
caller-supplied user-id params completely, with the consent gating living only in
`get_social_feed`'s CASE arms; nothing role-level calls them, so the grant serves nothing and is
a ready-made any-two-users overlap oracle if `private` is ever exposed. (c)
`private.can_view_crate` keeps an `authenticated, anon` grant (0013:31) that 0021 made dead
when it dropped the table-wide crate policy. **Fix:** one migration normalizing all five `private.*` functions to
minimum grants (`authenticated` only where an RLS policy actually evaluates the function; else
`service_role`/nothing).

### B6. MED — 0026/0029 backfills flip every user's privacy to 'friends' on any replay
`0026_sharing_default_friends.sql:13`, `0029_forsale_default_friends.sql:15` — unconditional
`update public.profiles set ..._visibility='friends'` with no WHERE, no marker. Any replay
against a live DB (history repair, re-baseline, incident re-apply) silently overrides every
user who has since chosen 'private'. Visibility flags are the consent mechanism; a migration
that can re-open them as an ops side effect is a fail-open landmine. **Fix:** neuter in-tree —
keep the `SET DEFAULT`, guard or remove the spent UPDATEs.

### B7. LOW — migration idempotence claim has rotted
0028's `add constraint` has no drop-first (unlike 0011/0012/0018/0024); bare `create policy` in
0001/0012/0017/0027 aborts on re-run. 0005 explicitly claims "every other migration in this set
survives a re-run." Matters doubly because a partial replay can fail *after* B6's consent-
flipping UPDATEs ran. **Fix:** sweep for drop-first/`if not exists` guards.

### B8. LOW — no client-side origin check on `authorize_url` before redirect
`boot.js:1181` navigates to whatever `connect-discogs` returned. One compromised/buggy
function response = open redirect from a page where the user is primed to enter Discogs
credentials. **Fix:** reject unless the URL's host is discogs.com.

### B9. NOTE (documented, trigger condition) — `azp` "tolerate absence"
All functions pass tokens with no `azp` claim. Fine today (one app on the instance; documented
as deliberate). The trigger: `delete-account/index.ts:2-4` explicitly anticipates shared
identity across future apps — the day a second app joins the Clerk instance, require `azp` (or
a dedicated `aud`) first.

---

## Wave C — Frontend correctness (milestone: "The UI tells the truth")

### C1. HIGH-impact bug, trivial fix — THE GOODS grid is unreachable by keyboard
`app.js:1469`: `_syncGridRoving()` guards on `crate`/`wantlist` only; `onKeydown` (1561) was
updated for `forsale` but the roving-tabindex sync was not. Every cell stays `tabindex=-1`; a
keyboard user can see the grid but cannot focus or open a single record. **Fix:** add
`'forsale'` to the guard.

### C2. MED — failed wantlist load leaves "LOADING…" on screen forever
Three identical copies (`app.js:1934,1969,2124`): the `.catch` mutates state but never calls
`render()`. Flaky network on the wantlist tab = dead tab until unrelated interaction. **Fix:**
render in the catch, with a distinct "couldn't load — retry" state (a `null` result currently
re-renders as the misleading "isn't hunting anything" empty state).

### C3. MED — per-user state in unscoped localStorage keys bleeds across accounts
`tw_feed_v1` (`app.js:919`), `tw_profile_skip` (`boot.js:1022,1063`), `tw_dna_variant`
(`app.js:22`). User B on A's browser: never sees the onboarding card (A's skip flag), inherits
A's feed seen-state so B's first feed load fires as "fresh" (violating the status-feed plan's
silent-first-load decision) with A's dismissal history. **Fix:** suffix keys with the Clerk user id.

### C4. MED — sign-out mid-boot lets the crate paint over the auth card
`boot.js:1215,1302` call `TraxWaxBootCrate()` fire-and-forget; `bootCrate` (`app.js:2042-2165`)
has no generation/cancellation check, so its awaited fetches can resolve after `route()` has
mounted the sign-in card and paint the previous user's crate over it — a signed-out screen
showing a signed-out user's data on a shared machine. **Fix:** boot-generation counter (or
Clerk-user identity check) that abandons stale renders.

### C5. MED — removing the MATCH chip on `#selling` resurrects it on reload
`app.js:1959-1962,1985-1992,2072-2082`: `removeFacet` clears state but `_syncFilterUrl`
rewrites only `location.search`, never the hash, and `bootCrate` re-applies
`matchFilter='youWant'` whenever `#selling` is present. The user's explicit removal doesn't
survive its own URL. **Fix:** clearing a MATCH facet (and `clearAll`) also `replaceState`s the
hash.

### C6. LOW/MED — `renderAccount` re-entry stacks focus traps and yanks focus
`boot.js:876-878` + `boot.ui.js:213-235`: every visibility toggle re-traps without releasing
(the `popstate` release never fires in-document), leaking a document-level keydown listener per
toggle and jumping focus to the top of the page mid-form. **Fix:** hold the current release in a
module var; release before re-trapping (or don't re-trap on re-entry).

### C7. LOW — friends-list failure renders as "YOUR FRIENDS · 0"
`boot.ui.js:629,705`: RPC failure is indistinguishable from having no friends; remove-friend
failure silently resets. **Fix:** render an error line into `#tw-friends-msg`.

### C8. LOW — in-crate RE-SYNC refreshes RECORDS but not inventory/wantlist siblings
`app.js:2012-2033`: `__twInventory` and `WANTLIST_RECORDS` stay stale after a sync that made
the DB fresher — the UI can disagree with the data it just synced. **Fix:** null
`WANTLIST_RECORDS` and re-await `TraxWaxInventory()` in `_resync`.

### C9. LOW — header EST. value fetch has no `.catch`
`app.js:2161`: `TraxWaxStats()` rejection (expired session, network drop) surfaces as an
unhandled promise rejection. **Fix:** catch; longer-term split the dual-arity value/stats
function (see E2).

### C10. LOW — DNA dialog doesn't trap Tab; detail modal does
`app.js:1532-1546`: `aria-modal="true"` dialog lets Tab walk out. **Fix:** mirror the detail
modal's Tab cycling.

### C11. LOW — `_pipeAttempt` retries non-retryable statuses
`boot.js:539`: only 400/401/403/409 short-circuit; a 404/410/422 eats the full 2s/5s/10s ladder
(~17s dead wait) for an error that cannot succeed. **Fix:** widen the short-circuit list.

### C12. LOW — prototype-key lookups on URL-controlled input
`boot.js:1135-1138,1151-1154`: `?connect=constructor` makes `UI.COPY.connectErrors[status]`
truthy via `Object.prototype`, rendering a stringified native function into the slab. Not XSS;
unhygienic. **Fix:** `Object.hasOwn`.

---

## Wave D — Performance & scale (milestone: "Cheap at 100×")

### D1. MED — `get_social_feed` is O(friends × 6 heavy aggregates), recomputing the caller's rows every time
`0033_social_feed.sql`: per friend, 9 `private.can_view_*` probes (lines 101-119; several
booleans computed more than once) plus up to 6 `_feed_overlap*` calls, each of which
re-materializes *both* sides — the caller's ~1,861 rows re-scanned and re-joined to `releases`
up to 6× per friend. 30 friends ≈ ~180 aggregate materializations + ~270 consent probes per
header load. Also drops the 0025 `(select auth.jwt())` initplan convention (16 un-wrapped
calls). **Fix:** compute the caller's
three sides once; one consent probe per friend per flag, reused; wrap `auth.jwt()`; consider a
friend cap.

### D2. MED — wantlist friend-read is still a table-wide RLS policy (perf + projection leak)
`0018→0020→0025` `wantlist_select_friends`: `private.can_view_wantlist` is SECURITY DEFINER so
never inlined — one definer invocation *per candidate row* (500-row wantlist = 500 EXISTS
probes), and the policy exposes `id`, raw `user_id` (Clerk sub), `created_at`, `updated_at` —
exactly the columns 0021 deliberately stripped from the crate for the same read. **Fix:**
mirror 0021 — `get_friend_wantlist(p_username)` projection RPC; drop the policy.

### D3. MED — `inventory_items` lacks the `(user_id, release_id)` index its probes assume
`0027` (indexes) vs `0031`/`0033` (probes): `selling_you_want` runs an EXISTS per friend-
collection row that index-scans the friend's *whole* inventory and filters release_id in the
heap — a 200-listing shop ≈ ~370k row visits per friend per `list_friends` call. **Fix:**
`(user_id, release_id) where status='for_sale'` partial index. Same family: `pending_enrichment`
classes seq-scan `releases`; add partial indexes before the catalog grows.

### D4. MED — enrichment work-discovery costs 7 aggregate scans per 5 units of work
`enrich-release/index.ts:28,103-104` + `0032` `pending_enrichment`: a fresh 1,861-item import ≈
~373 polled invocations × 7 exact-count subqueries ≈ 2,600 aggregate scans for discovery alone.
**Fix:** return counts every Nth call or make the gate existence-style; raise BUDGET (5→20
quarters the overhead and still fits function limits).

### D5. LOW/MED — friend-crate boot serializes three independent fetch series
`app.js:2102-2117`: `TraxWaxMatchCtx` → `TraxWaxOwnerWantIds` → `TraxWaxFriendForSale` strictly
sequential before first paint; own crate similarly serializes data→inventory. **Fix:**
`Promise.all` — cuts friend-crate time-to-first-paint by ~two round-trip series.

### D6. LOW — concurrent same-kind imports can transiently delete each other's rows
`import-collection/index.ts:244-247,369-393`: run B's page 1 overwrites the watermark run A's
final-page sweep then reads — A sweeps rows B hasn't re-upserted yet; if B is abandoned they
stay gone until the next full import. Self-inflicted only. **Fix:** sweep only if the persisted
watermark equals the one this run minted (import-generation check), or refuse page 1 while
running.

### D7. LOW — collections >50,000 items wedge in `import_status='running'` forever
`import-collection/index.ts:118-122,369`: page cap 500 means `done` never fires. The client
does surface the 400 (`bad_request` short-circuits `_pipeAttempt`), but the DB is left wedged
at `import_status='running'` with no server-side escape hatch besides unlink.
**Fix:** `if (pages > 500) → import_status='error', return collection_too_large`.

### D8. LOW — three seed/contract nits
(a) `seed_releases` raises `cannot affect row a second time` on an intra-batch duplicate — the
sole caller dedupes, but the RPC contract doesn't say so; add `distinct on` (0010 merge fn).
(b) `wantlist-write` add path never sets `vinyl` (`wantlist-write/index.ts:172-175`) — mirror
diverges from import shape until the next full import silently corrects it. (c)
`create_friend_invite` returns `'ok'` on `unique_violation` (0016) — the comment says "client
retries," the return value guarantees it can't; return `'retry'`.

### D9. NOTE — `master_id = 0` guard asymmetry
`0031` guards `master_id <> 0`; `0033`'s `_feed_overlap` doesn't. Both writers normalize 0→NULL
today, so no live path — but one future writer storing raw 0 makes every no-master release
any-match every other. **Fix:** `check (master_id is null or master_id > 0)` on `releases`.

---

## Wave E — Architecture & ops debt (milestone: "Consolidate")

### E1. MED — the ~35-line verify/CORS/json preamble is copy-pasted into all 8 authenticated functions
B1 is the realized cost: policy change #52 was hand-applied to N copies and missed one. Also
quadruplicated with drift: Discogs release response-shaping (`enrich-release`, `[id].js`,
`wantlist-write` seed, `live-stats`). **Fix:** `_shared/auth.ts` (`verifyClerk(req)` +
`corsJson()`) and a shared `shapeRelease()` — makes the next policy change atomic.

### E2. MED — three near-identical Edge-call helpers with divergent error contracts
`boot.js:179` (`fnCall` → null on failure), `boot.js:336` (second identical `fnCall`),
`boot.js:509` (`_pipeCall` → throws). The friend installer's own comment admits the swallow
already bit once. **Fix:** one helper with `{throwOnError}`; split the dual-arity
`TraxWaxStats` (header value vs per-release stats keyed on argument nullness) while there.

### E3. LOW — dead computation & payload
`dna.js:33-47`: 12-month histogram + top genres/artists/labels/addedThisYear computed every
render, used by none of the three draw functions (~4 full passes over 1,861 records each).
`videos` fetched and cached by every release-detail tier (`app.js:150,160`, `boot.js:272-283`),
rendered nowhere — localStorage weight for a feature that doesn't exist. **Fix:** delete or
build the feature.

### E4. LOW — escaping-discipline hardening (pre-emptive, no current exploit)
(a) `esc()` doesn't escape `'` — holds only while every attribute sink stays double-quoted.
(b) `data-arg="${r.id}"` / discogs href interpolate ids raw while `app.js:1430` encodes the same
id — escape uniformly. (c) `_sL(t,…)` takes raw HTML by implicit contract. (d) CSP keeps
`'unsafe-inline' `— documented, but it makes `esc()` the *only* line of defense; the "tighten to
hashes later" note is load-bearing. One hardening pass covers all four.

### E5. LOW — repo hygiene
(a) `supabase/.temp/linked-project.json` is tracked (CLI machine-local state, incl. org id);
`git rm --cached` + gitignore `supabase/.temp/`. (b) `.impeccable/hook.cache.json` is
*already tracked/committed* (the `.git/info/exclude` entries name three files, don't cover the
directory, and are a no-op for the tracked file); `git rm --cached` + a proper `.gitignore`
entry. (c) `wrangler.toml` documents a `DISCOGS_USER` secret nothing reads. (d) refresh
workflow's final push has no rebase (will fail if the badge bot landed mid-run). (e) one git
tag (`v1.0.0`) across 79 released CHANGELOG versions — tag releases or accept the archaeology.

### E6. MED — no monitoring on a deliberately fail-closed system, and no recorded backup posture
Since #52 all eight authenticated functions throw at boot on missing
`CLERK_ISSUER`/`APP_ORIGIN` (the callback is B1's exception) — correct,
but a bad secrets change 500s the whole authenticated product until a human notices; there is
no uptime check, no error tracking, and DEPLOY.md says nothing about Supabase backup/PITR while
migrations have no down-migrations and one project holds every user's crate. **Fix:** external
uptime monitor on `traxwax.com/boot.js` + one POST probe expecting 401 `invalid_token`; record
the actual PITR/backup setting in DEPLOY.md.

### E7. NOTE (decision to re-ratify) — no FKs from any `user_id` to `profiles`
Deliberate deferral (0016, Lane, 2026-08-31) when it covered 2 tables; it now silently covers 8,
and one cleanup omission in that class has actually shipped (A1). Re-ratify or add FKs.

---

## Wave F — Documentation (fix in-flow, no issues)

Per the cold-audit protocol these get fixed directly, not filed:

1. `traxwax-clone/CLAUDE.md` — says "migrations 0001–0032," "current v1.23.2"; missing 0033,
   v1.24.x (THE GOODS rename), v1.25.0 (status feed / `get_social_feed`), and the migration-map
   entry for 0033.
2. `README.md` — "0001–0032" (line 33), "Shipped through v1.23.1" (line 109), tab naming.
3. `DEPLOY.md` — "Migrations 0001–0032 applied"; **and the dead test path**: "test on the
   multi-user.traxwax.pages.dev preview (dev Clerk)" is doubly wrong — dev Clerk is unwired
   since v1.14.1/#52, and previews can't reach the backend at all (CORS pinned to
   traxwax.com + azp check), so the runbook sends a future session to debug a non-bug.
   Rewrite to "previews exercise static surfaces only; authenticated testing happens in prod."
4. `public/_headers` — add `/i` + `/i/*` no-cache blocks (the invite route serves the app shell
   with no Cache-Control at all — the one route a brand-new user hits first; exact #9 stale-
   shell class). *Code fix, but one line and cache-policy-shaped; bundle with the docs commit
   or fold into Wave C.*
5. Parent project `CLAUDE.md` + Cowork memory (`reference_lanes_record_collection.md`) — same
   v1.23.2/0032 staleness.
6. `import-collection/index.ts:145-147` — stale "formats[0].text" comment vs find-first-with-
   text implementation.

---

## Finding-ID → GitHub issue map (filed 2026-09-06)

A1=#62 A2=#63 A3=#64 A4=#65 A5=#66 A6=#67 A7=#68 ·
B1=#69 B2=#70 B3=#71 B4=#72 B5=#73 B6=#74 B7=#75 B8=#76 B9=#77 ·
C1=#78 C2=#79 C3=#80 C4=#81 C5=#82 C6=#83 C7=#84 C8=#85 C9=#86 C10=#87 C11=#88 C12=#89 ·
D1=#90 D2=#91 D3=#92 D4=#93 D5=#94 D6=#95 D7=#96 D8=#97 D9=#98 ·
E1=#99 E2=#100 E3=#101 E4=#102 E5=#103 E6=#104 E7=#105.
Wave F has no issues (fixed in-flow, commit referenced in CHANGELOG).

## Argue-down notes (what didn't survive, what got downgraded)

- **Merged duplicates:** `/i/*` cache (frontend+infra) → F4; `_feed_overlap` grants (db+infra)
  → B5; release-proxy abuse (backend+infra) → B2; collection.json exposure (frontend+infra) →
  folded into A3's decision.
- **Downgraded to documented-with-trigger:** `azp` tolerance (B9) — matches Clerk guidance,
  single-app instance today; >50k import cap (D7) — known, kept only for the fail-loudly guard.
- **Held despite "deliberate" markers:** A3 (the git-history half was *not* a decision anyone
  made), B4 (capability-URL accept may have been a design choice, but the zero-consent grant
  of default-friends visibility deserves an explicit Lane verdict), E7 (deferral pre-dates 6 of
  the 8 tables it now covers).
- **Verification pass (independent no-context agent, targeted at this document):** SPEC pass;
  QUALITY failed as first written and the following were corrected in place: headline count
  38→44; A6's "no sweep" claim struck (sweep exists at `connect-discogs/index.ts:110` — A6 now
  covers only the plaintext-encryption half); E6's "all nine"→"all eight" (contradiction with
  B1); D1's probe/unwrapped counts 7/13→9/16; "~60"→79 CHANGELOG versions; A7's inverted sweep
  sentence; C3's ambiguous "D1" cross-reference; E5(b)'s mis-described `.impeccable` state
  (hook.cache.json is already tracked); D7's "silent" softened (client does get a 400). All six
  HIGHs and ~30 sampled MED/LOWs were CONFIRMED against the code by the verifier.
- **Verified directly during triage** (not just trusted from agents): A1, A2, A3, A4 (guard
  body), B1, B5 (0033 grant lines), B6 (both UPDATEs), C1 (line 1469), F1–F3 staleness, the
  d99a922 priced-row count (1,778/1,861), and version state (VERSION=CHANGELOG=HEAD=1.25.0).

## Consolidated "verified solid" (why absence of findings means something)

All four agents attacked and failed to break: JWT verification (signature+issuer+exp via JWKS,
identity only from verified `sub`, `verify_jwt=false` correctly compensated in-handler);
the OAuth link-CSRF design (atomic `DELETE...RETURNING` state consume, hash-only one-time codes
in the URL fragment, possession+identity required at finalize — attacker-replayed callback →
`link_not_yours`); RLS row isolation on every user table including the zero-policy secret
tables; every service-role RPC's revoke/grant posture across all 33 migrations (REPLACE
preserves ACLs — checked each); existence-oracle uniformity (`no_crate`/nulls/`[]` for all deny
cases); consent-gate direction (each disclosed set gated on the *disclosed* user's flags,
failing closed); friendship two-row symmetry through every path; `delete_account` completeness
against the current table set; XSS sink discipline across all five JS files (every interpolation
traced to `esc()`/`textContent`; the `coverBg` style-attribute encode map correctly defeats
`url()` breakout); no committed secrets anywhere in the tree; client↔Edge↔SQL contracts (every
fetch/RPC call-site pair checked — field names, statuses, error vocab all match, including
`get_social_feed`'s key set vs `_feedCandidates`); PostgREST 1,000-row-cap discipline (jsonb
RPCs + `.range()` pagination everywhere); the #39 import watermark's forged-echo resistance;
and the version-badge workflow's injection hardening.
