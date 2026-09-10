# Cold audit — v1.31.0 (full codebase)

**Date:** 2026-09-10 · **Tree:** `lanebecker/traxwax` @ `6ed3e6f` — the **main tip**, one commit past tag `v1.31.0` (`9303af3`);
the delta is the README badge line only. (That gap is itself finding T3.3.) · **Scope:** entire repo
**Method:** 7 independent no-context auditor agents (app.js · boot.js/routing · boot.ui.js/CSS ·
Cloudflare Functions · Supabase Edge Functions · migrations/RLS · CI-secrets-payload), then
argue-down triage: every finding pressure-tested against the code, 4 batched adversarial verifiers
tasked with *falsifying* claims, plus direct reproduction of the highest-stakes items.

**99 raw → 16 merged as duplicates across slices → 10 killed or deferred → 73 survive.** Of the 73,
17 were materially corrected during argue-down or by the verification pass before surviving. Every count
here was recounted from the document, not carried forward.

Findings by tier: **T1** 5 · **T2** 21 (16 prose + 5 in the T2.17 table) · **T3** 22 (11 prose + 6 in
T3.6 + 5 in T3.8) · **T4** 25.

> **Scope carve-outs, stated rather than implied.** `docs/` (41 files) is excluded here — it is covered
> by the companion documentation audit. Everything else tracked in the repo is either the subject of a
> finding or named in the Coverage section, including the files a first pass missed:
> `_shared/discogs.ts`, `boot.clerk.js`, `build/seed_catalog.py`, `supabase/config.toml`,
> `package-lock.json`'s contents, `public/fonts-og/`, and all ten committed images.
>
> **Audit hygiene note — coverage confirmed.** This audit ran against a fresh GitHub clone of `main`.
> The Mac working copy was initially unreachable (the folder was connected under the `Claude` symlink
> spelling, which both `device_bash` and `device_list_dir` refuse; re-granting the literal
> `Claude.nosync` path fixed it). It was then checked directly:
> `git status --porcelain` empty, no unpushed commits, no stashes, HEAD at `9303af3` = tag `v1.31.0`.
> The audited tree is that commit plus the README badge line — **nothing was missed.**

---

## What was killed or deferred (recorded so it is not re-raised)

| Claim | Why it died |
|---|---|
| connect-discogs deletes another tab's live handshake | `0035:41` makes one-row-per-user structural; `connect-discogs:73-76` names and accepts this exact outcome |
| Edge-clock table-wide sweep deletes other users' OAuth rows | Needs ~14 min of clock skew; Supabase isolates are NTP-synced. Unreachable |
| `connect-discogs` fails open on DB error | Documented intentional at `:71-72` ("a broken DB must not lock everyone out"), and it still arms the placeholder |
| `verifyClerk` tolerates a missing `azp` | **Deferred, not killed.** Tracked as **#77** with a trigger; sharpened below rather than re-filed |
| `get_social_feed` / `list_friends` join shapes are a scaling cliff | **Deferred, not killed.** `v_any` folds to a hashable equi-join in default mode; sub-ms at current scale. Parked with a trigger |
| `sorted()` comparator recomputes the key 4× | Measured: 1.32ms → 0.67ms. Sub-millisecond. Cleanup-only |
| Active account-nav item is not focusable | Non-focusable + `aria-current="page"` is the standard APG/GOV.UK/USWDS pattern |
| `trapFocus` is a WCAG 2.1.2 keyboard trap | `#app` is the *entire* body, so no content is unreachable. Real annoyance, not a Level-A failure |
| `workers-og` dependency tree is a supply-chain risk | No known advisory; `base64-js` decodes a bundled Unicode trie, never request data |
| Stranger tier leaks `avatar_url` while reducing the name | **Deferred, not killed.** A product decision — raised under "Not filed" below |

---

## Tier 1 — Public-surface exposure and injection (fix first)

### T1.1 — The landing hero and the site-wide `og:image` bake in a Discogs collection valuation
`public/screenshots/crate-hero.jpg` (817 KB, committed `f8fe587`), referenced at `public/index.html:12`
(`og:image`) and `:141` (hero `<img>`).

I rendered the image. Its header band reads:
`1,861 IN CRATE · 1516 COLORED · $54,428.67 EST. · +12 THIS MONTH · RE-SYNC · LIGHTS OUT`

`$…EST.` is the value `app.js:1363` renders from `TraxWaxValue()` → `live-stats` →
`api.discogs.com/users/<user>/collection/value` — Discogs **Restricted** marketplace data. The entire
architecture exists to keep it ephemeral: own-token only, `IS_OWN`-gated, cached ≤6h in-instance,
never persisted. Here one sample is persisted permanently as pixels and served from the CDN.

Because it is also the `og:image`, **every unfurl of any traxwax.com link** renders that figure into
other people's chat clients and their servers' image caches. The A2/#63 remediation purged Restricted
JSON from git history (verified clean) but never covered the image tier, and this asset predates that
purge by nine days (committed 2026-08-29; the purge landed 2026-09-07).

**Why this is different from T1.2, stated explicitly:** Lane deliberately published his own hero, so the
record titles, wax colours and `LANEBECKER'S SHELF` byline in it are consented publication, not leakage.
The EST. pill is not — it is Discogs Restricted *marketplace* data, which no consent makes redistributable.

*Fix:* retouch or re-capture the hero without the EST. pill (the other pills are CC0/derived counts and
are fine). Extend the #63 Restricted-data checklist to committed images — no grep can see inside a JPEG.

**The sweep the first pass prescribed but did not run.** All ten tracked images, opened and read:

| Image | Served? | Verdict |
|---|---|---|
| `public/screenshots/crate-hero.jpg` | **yes** (og:image) | **`$54,428.67 EST.`** — this finding |
| `screenshots/06-detail-modal.png` | no (outside `public/`) | **`RATING 4.3 (139)`, `HAVE / WANT 1366 / 2459`** — see T1.4 |
| `screenshots/01-crate-light.png`, `03-ledger.png` | no | `— EST.` with no value. Clean |
| `screenshots/02, 04, 05, 07` | no | Clean |
| `public/screenshots/hero-mosaic.jpg` | **yes** | Clean — covers only |
| `public/screenshots/og-card-red-1200x630.png` | **yes** | Clean — count, styles, slug, both Discogs attributions |
| `docs/design-source/screenshots/01-crate-light.png` | no | Byte-identical to `screenshots/01`. Clean |

### T1.2 — `public/collection.json` publishes an ownership list with ratings, and nothing reads it
`public/collection.json` — 1,150,556 bytes, 1,861 records, one line. Cache rule at `public/_headers:37-38`.
Only reader: `public/app.js:2268`, inside `if (!DB_MODE())`.

**It is dead.** `boot.js` imports `/app.js` at exactly five sites (`:1368 :1455 :1530 :1655 :1727`) and
every one is preceded by an installer that assigns `window.TraxWaxData` (`:185 :429 :1575`). So
`DB_MODE()` is unconditionally true in production and that `else` branch is unreachable.

**It is not harmless.** `CLAUDE.md` names "which releases a user owns" as Restricted. The file carries
`id, artist, title, year, label, styles, genres, vinyl, thumb, cover_image, added, rating` — a
day-resolution acquisition history (458 distinct days, 2021-11-11 → 2026-08-23) plus **personal
ratings, which no sharing tier exposes**. `_routes.json` pins Functions to `/api/* /c/* /og/*`, so
`/collection.json` is served straight from the static store with no gate. There is no `robots.txt`
and no `X-Robots-Tag`.

`curl https://traxwax.com/collection.json` returns all of it. It survives flipping the crate to
PRIVATE, disconnecting Discogs, and deleting the account, because it lives in git and on the CDN, not
in Postgres.

*Fix:* move the fixture out of `public/` (e.g. `build/fixtures/`), drop the unreachable `else` branch
in `app.js` and the `_headers` rule. Same class at much smaller scale:
`public/fonts-og/README.md` is an internal build note served at `/fonts-og/README.md`.

### T1.3 — `$` replacement patterns survive `esc()` and inject the page's own head into `<title>` / `og:title`
`functions/c/[slug].js:98-100`, with `esc()` at `:20-21`.

All three `String.replace` calls pass an **interpolated string** as the replacement, where JS
interprets `` $` ``, `$'`, `$&`, `$$`. `esc()` escapes `& < > " '` but neither `` ` `` nor `$` — and it
actively *creates* a pattern: the literal apostrophe in `` `${name}'s` `` becomes `&#39;`, so a name
ending in `$` yields `$&`.

**Reproduced locally.** `display_name = "Bob$"` (no space, so `get_public_crate:78` passes it verbatim)
produces `<title>Bob<title>TraxWax</title>#39;s Crate…` — the parser closes `<title>` early, the stray
text implies `</head><body>`, and every injected `og:*` tag lands in the body, so a head-only unfurl
parser sees no card at all. `"Bob$\`X"` expands `` $` `` to *everything before the match*, injecting the
whole doctype+head — including the `<script src="https://cloud.umami.is/script.js">` tag, whose `"` and
`>` break out of the `content="…"` attribute and re-execute it.

`display_name` is an 80-char field every authenticated user writes directly (`0006:12`, `0011:29-30`).
The injected markup is the page's own, not attacker-authored — so this is page corruption, broken
unfurls and duplicated script execution rather than arbitrary XSS. It is nonetheless a live injection
primitive whose blast radius is whatever happens to precede `</head>` on any future day.

*Fix:* use a function replacement (not `$`-interpreted), or escape `$` on the replacement side. This is
a separate concern from HTML-escaping the value, and `esc()` should not be assumed to cover it.

### T1.4 — A second committed image bakes in four Restricted Discogs fields
`screenshots/06-detail-modal.png` (139,791 bytes), directory pointed at by `README.md:42`

Rendered and read. The detail modal's stat row displays `RATING 4.3 (139)` and
`HAVE / WANT 1366 / 2459` — that is `crating`, `crcount`, `have` and `want`: four of the six field names
the #63/#64 purge was built around. (`LOWEST SALE` shows `—`, so `lowest_price` is not in this one.)

**Mitigating, and it matters:** `screenshots/` sits *outside* `pages_build_output_dir = "public"`
(`wrangler.toml:3`), so unlike T1.1 this is **not** served from traxwax.com. It is committed to a public
GitHub repo and linked from the README.

This finding exists because the first draft of T1.1 prescribed an image checklist and then did not
execute it — the verification pass caught that, and the sweep above is the result.

### T1.5 — `fieldNames()` can log an entire OAuth response body, including `oauth_token_secret`
`supabase/functions/_shared/discogs.ts:33-42`; callers `connect-discogs:152`, `connect-discogs-callback:113`

```ts
/** Names only, never values — for logging an unexpected OAuth response safely. */
export function fieldNames(body: string): string {
  return Object.keys(parseForm(body)).join(',') || '(none)';
}
```

`new URLSearchParams(s)` does not validate that `s` is form-encoded. For any string containing no `&`
and no `=`, it yields a single entry whose **key is the entire string**. So the docstring's guarantee
holds only for input that already has the expected shape — and both call sites invoke it precisely on
the branch where the body turned out **not** to have that shape. Reproduced:

```
fieldNames('{"oauth_token":"tok","oauth_token_secret":"SUPERSECRET"}')
  -> '{"oauth_token":"tok","oauth_token_secret":"SUPERSECRET"}'
```

*Scenario:* Discogs returns 200 from `/oauth/access_token` with a JSON body (an API change, a gateway
that re-serializes). `parsed.oauth_token` is `undefined`, the error branch runs
`console.error('… unexpected fields:', fieldNames(body))`, and a live OAuth token secret is written
verbatim into the Edge Function logs — the one habit `connect-discogs:144` explicitly warns against.

*Fix:* refuse to emit anything not provably a key — reject the body unless it matches a form-encoded
shape, otherwise return a shape summary (`(non-form body, 412 bytes)`); cap each key at ~40 chars.

---

## Tier 2 — Bugs users will hit

### T2.1 — `bootPublicCrate` installs the RPC result without checking `status`
`boot.js:1518-1532`, `:1645-1650`, `:1560-1567`

The comment at `:1527-1528` ("First call runs anonymous … so relation can only be 'stranger'") is false on
the identify-first path: when `tw_has_session === '1'`, `_publicIdentifyFirst` has already loaded Clerk,
so the re-run at `:1520` is authenticated. Four of that function's `return false` paths sit after `_loadClerkQuiet()`; **two of them matter** — they
require the user to be signed in *and* the RPC to have succeeded — the friend-without-handle branch (`:1648`) and `if (d.status !== 'ok') return false`
(`:1650`). The re-fetch then returns `{status:'redirect', relation:'friend', handle:null}`, which is
truthy, passes `if (!payload)`, and reaches `_installPublicCrate` → `d.sections.crate` on an undefined
`d.sections`. `_publicClerkPass` (`:1532`) never runs, so nothing recovers it.

*Scenario:* Alice has `crate_visibility='friends'`, a public slug, and no linked Discogs
(`discogs_username IS NULL`). Bob is her friend, signed in, has visited `/app`. He opens `/c/alice` and
gets the generic "something went wrong" card instead of his mode-D crate.

*Fix:* `bootPublicCrate` should status-check the way `_publicClerkPass` already does at `:1723`.

### T2.2 — A failed Clerk token becomes an anonymous read, which RLS answers as "you own nothing"
`boot.js:39-47`, provider at `:183-214`

`accessToken` returns `null` on any throw. That does not abort the request — supabase-js sends it with
only the publishable key, i.e. role `anon`. Every RLS policy keys on `auth.jwt()->>'sub'`, so an
anonymous read returns **HTTP 200 with `[]` and `error === null`**. The provider checks only `error`,
and `if (!data || data.length < 1000) break` terminates normally. There is no path by which "the
session could not be proven" is distinguishable from "this user owns zero records."

*Scenario:* a user presses RE-SYNC. During the multi-minute import Clerk rotates its ~60s token
several times; one refresh hits a FAPI 5xx. The next `TraxWaxData()` goes out unauthenticated,
resolves `[]`, and a 1,861-record crate repaints as the empty state immediately after a *successful*
import. Nothing logs, nothing retries.

*Fix:* a null token must be a distinguishable failure at the call site, not a silent downgrade.

### T2.3 — `get_crate_owner`'s error is discarded, so a blip renders as a privacy denial
`boot.js:1356-1371`

`const { data } = await supabase.rpc(...)` throws `error` away. supabase-js v2 does not throw — a fact
this file states at `:1672-1674` — so the `catch (e)` at `:1365` is dead code. An HTTP 500, a network
drop, and a `no_auth` RPC response (`0023:19`) all land in the same bucket as a genuine denial and fall
through to the deliberately-ambiguous "No crate here / This crate is private, or it doesn't exist" card
with no retry.

The privacy rule at `:1372-1376` requires ambiguity between "no such user" and "not shared with you".
A *transport* failure is a third category that leaks nothing, so branching on `error` is compatible
with the rule.

### T2.4 — Unguarded `decodeURIComponent` produces a self-perpetuating error card
`boot.js:1104-1105` (also `:1156`), with `boot.js:122-123`

`decodeURIComponent` throws `URIError` on `%zz`, a bare `%`, or a truncated escape. It is the **second
statement of `render()`, before the auth guard at `:1110`**, so it aborts into `route()`'s catch →
`showError`, whose only CTA links to `window.location.pathname + window.location.search` — the same
URL. Pressing it reproduces the identical card indefinitely, under copy reading "Reloading usually
settles it."

`/app/lane%C0%80` and `/app/lane%E0%A4` are syntactically valid percent-encoding that any edge passes
through. `/c/<slug>` is safe (validated at `:1742`); `/i/<code>` has the same hole.

*Fix:* a malformed segment is an unknown crate, not an internal fault. Wrap both decodes; `null`
already routes to the calm noCrate card. Separately, `showError`'s CTA should not link to the URL that
produced the error.

### T2.5 — A friend's LEDGER overlap row is a dead click that wedges `state.detailId`
`app.js:274-277`, `:668-671`, `:1663-1678`, `:1424-1430`

`overlapBandHtml` renders `data-act="open"` buttons for rows drawn from **both** `RECORDS` and
`WANTLIST_RECORDS` (the button is emitted at `:689`; the two-source loop is `:664-671`), but only while `state.view === 'ledger'`. `recordById` keys
its source on `state.view === 'wantlist'`, so on the ledger it searches `RECORDS` only. A
"YOU OWN THIS" row is by construction on the friend's *wantlist* — absent from their crate — so the
lookup returns `undefined`. `openDetail` sets `state.detailId = id` at `:1666` **before** the `if(rec)`
guard, and `modalHtml()` returns `''`, so nothing paints and `detailId` is never cleared.

**Corrected from the raw finding:** the shell is *not* bricked inert — `renderModal` gates on
`_modalOpen = !!(state.detailId && root.innerHTML)` (`:868`), and the comment there anticipates exactly
this case. Nor are keystrokes swallowed (`onKeydown` returns early without `preventDefault`). The real
harm is `:1425`: `if(!state.detailId){ …restore focus… }` is skipped, so the debounced re-render
replaces the search input and focus is never restored — the box goes dead after ~150ms and the
remaining keystrokes go nowhere, until the user happens to press Escape.

### T2.6 — Signed-out visitors get a `+ WANT` button on every card that does nothing
`app.js:466-474` (and the identical tail at `:460`)

The final `return` is unconditional whenever `!IS_OWN()`, including `VIEWER_MODE() === 'public-out'`,
where `_installPublicCrate` sets `signedIn:false` and installs neither `TraxWaxMatchCtx` nor
`TraxWaxSetWant`. `friendAdd` bails on its first guard (`:1729`) with no toast, no sign-in prompt, no
console line. `wantControlHtml` (`:436`) *does* gate on `ctx`, so the same record's detail modal
correctly shows no want control.

Affects THE CRATE and THE WANTLIST on every public crate — the one surface built for strangers.

### T2.7 — A pending FIND debounce un-inerts `#app` behind the open DNA sheet
`app.js:1991-1998`, `:2094-2098`, `:870-873`, `:1939-1945`

`onClick` clears `_searchDebounce` but not `_findDebounce`, so a click can be followed 100ms later by a
stray `render()`. That render ends in `renderModal()`, which owns `#app`'s inert state solely from
`state.detailId` and executes `app.inert = false` — clobbering the attribute `renderDna()` set at
`:1940` (same reflected IDL attribute). Focus then lands on `#tw-stylefind` behind the overlay via the
fallback at `:1428`.

Third consequence the raw finding missed: `app.innerHTML = html` detaches `_dnaInvoker`, so
`document.contains(_dnaInvoker)` fails on close (`:1899`) and focus never returns. The same hole is
reachable from every other async `render()` — `TraxWaxRerender`, `_loadWantlist`'s handlers, `_resync`.

*Fix:* `if (_modalOpen || state.dnaOpen) app.inert = true;` in `renderModal`, plus clearing
`_findDebounce` in `onClick`.

### T2.8 — Every state card leaves `#app` inert with the previous modal still painted
`boot.js:1069-1073`, `:84-92`, `:107-112` — contrast `renderPublicNotFound` at `:1540-1547`

`app.js:869-872` sets `app.inert = true` while a record modal is open and renders the modal into
`#tw-modal-root`, a **sibling of `#app`**. `mountAuth()`, `notice()` and `showError()` all write into
`#app` via `innerHTML` and reset only `el.className` — replacing children does not clear `inert` on the
node itself, and none of them touch the body-level roots. `renderPublicNotFound` was fixed for exactly
this; the other three were not.

*Scenario:* modal open in tab A; sign out in tab B. Clerk's cross-tab sync fires the listener at
`:1794` → `route()` → `mountAuth()`. Tab A shows the sign-in card inside an inert, `aria-hidden` `#app`
— every field unclickable — while the previous session's record modal is still painted above it,
still showing that user's collection data.

### T2.9 — `finalize_discogs_link` consumes the pending link before checking whose it is
`0009_account_controls.sql:40-49`

The `DELETE … RETURNING` *is* the identity lookup; `if v.user_id is distinct from p_sub` runs after the
row is gone, and the function is documented as never raising, so the delete commits. A caller who fails
authorization still destroys the victim's pending link — the victim's own finalize then gets
`no_pending`, their freshly-minted encrypted Discogs token is discarded unrecoverably, and they must
re-run the whole OAuth handshake.

Narrow to exploit (the code lives in a URL fragment, which never leaves the browser) but the fix is one
predicate: add `and user_id = p_sub` to the delete, and answer `no_pending` for both cases. The
comment at `:35-38` already reasons carefully about *not* deleting by user_id and simply omits the
ownership term.

### T2.10 — `/og/` negative-caches a transient Supabase failure as a 404 for 300s
`functions/og/[slug].js:203-213`

`d` is left null by three different conditions — unknown/private slug, non-ok PostgREST status, and a
thrown fetch — and all three write a 404 into `caches.default` for 300s. The inline comment asserts the
blip is "not cached long"; it is cached exactly as long as a genuine miss. The sibling
`functions/c/[slug].js:60-63` handles the identical case and deliberately chooses `no-store` "so a
transient failure never caches a 404."

*Scenario:* Supabase 503s for two seconds. Slack's unfurl service requests the card in that window; for
the next five minutes **every** request for that crate's card in that colo returns 404, including
after recovery. Every link shared in those five minutes unfurls blank.

### T2.11 — Cover fetch: the timeout doesn't cover the body, and the size guard runs after allocation
`functions/og/[slug].js:44-62`

Three compounding problems in six lines. `clearTimeout(t)` fires when *headers* arrive, so
`r.arrayBuffer()` — the part that transfers bytes — runs with no deadline. `byteLength > 400000` is
checked *after* the body is fully materialized, so the guard cannot prevent the allocation it exists to
prevent. And `fetch` has no `redirect: 'manual'`, so `^https://` validates only the first hop. Six of
these run concurrently via `Promise.all`.

*Fix:* `Content-Length` pre-check plus a streaming read that aborts at the cap; the abort signal should
cover the body, not just the handshake.

### T2.12 — `enrich-release` swallows a revoked Discogs grant forever
`supabase/functions/enrich-release/index.ts:163-166`

401/403 — the response Discogs returns when the OAuth grant is revoked — is handled identically to a
transient 500: log, `continue`, return HTTP 200. There is no counter, no terminal/retryable
distinction, and no `import_status='error'` write, which the analogous decrypt-failure path at `:69-74`
*does* perform. A 429-specific `break` sits ~17 lines above at `:143-147` (the 404 handler occupies `:148-162` between them),
so the pattern was available in the same loop.

Nothing else detects a dead credential: `_pipeAttempt` (`boot.js:536`) keys retryability off
`e.status` (502), not `e.upstream` (401). **Bounded per visit** (the no-progress guard at
`boot.js:629-635` caps it at ~4 invocations ≈ 80 paced calls) but **unbounded across visits** — it
repeats on every page load indefinitely, and the product never tells the user their connection is
broken.

*Fix:* trivial — a `res.status === 401 || res.status === 403` branch that sets `import_status='error'`
and breaks, mirroring the 429 break above it.

### T2.13 — `inventory_items` has no uniqueness on `(user_id, release_id)` and no `status` CHECK
`0027_inventory.sql:6-14`

Uniqueness is on the *listing*, but every consumer keys on the *release*. `get_friend_forsale`
(`0028:77-82`) and `get_public_crate`'s for-sale block (`0040:107-113`) emit one `{release_id,
listing_id}` object per row, so two active listings of one pressing produce two objects with the same
`release_id`. `boot.js:404-410` does `map.set(it.release_id, it.listing_id)`, so the second silently
overwrites the first — the FOR SALE badge deterministically links to one listing and the other is
unreachable. Meanwhile `list_friends.selling_you_want` counts *collection* rows via EXISTS, so it
reports 1 while the array has 2 — breaking the count/filter agreement that migration's header exists to
preserve. `status` has no CHECK despite every reader filtering `status = 'for_sale'`.

### T2.14 — `Number(body.release_id)` accepts `true` and `[7]`
`supabase/functions/wantlist-write/index.ts:40-46` (same pattern: `live-stats:70-73`,
`import-collection:87-97`)

`body.release_id` is typed `unknown` and passed straight to `Number()`. `Number(true) === 1` and
`Number([7]) === 7` both clear `Number.isInteger` and `>= 1`, then PUT to `…/wants/1` under the user's
real OAuth token — adding an unrelated record to their actual Discogs wantlist, with a `{ok:true}`
response.

**Corrected:** catalog defacement is *not* reachable — the seed at `:113-140` re-fetches from Discogs
rather than trusting client content, exactly as the header states at `:38-39`. And `1e21` fails earlier than claimed,
at the existence probe (`.eq('release_id', 1e21)` → `release_id=eq.1e+21` → invalid bigint → controlled
500), not at Discogs. Scope is the caller's own account; it needs a hand-crafted request.

*Fix:* one line — `typeof body.release_id !== 'number'` (or `Number.isSafeInteger`) in the guard at `:44`.

### T2.15 — `live-stats` caches Restricted data on a global key and serves it across users
`supabase/functions/live-stats/index.ts:120-122`, `:186`

The `value:` key was correctly bound to the caller (`value:${userId}:${valueUsername}`, the A5/#66
fix). The `release:` key was not — it is `release:${releaseId}` with no user component, and the payload
it holds is `lowest_price`, `community.have/want`, `community.rating`: exactly the Restricted Data the
architecture note says must be fetched live under each user's own OAuth token. On a cache hit the
function returns at `:122`, **before** the decrypt and before any fetch, so no request is ever made
under the second user's token.

No user sees another user's *private* data — the numbers are global. The defect is attribution and
consistency: Discogs logs one request (A's) where two users consumed the result, and the sibling key
was already fixed for precisely this reason.

### T2.16 — The inventory import overwrites the shared catalog's artist string with a lower-fidelity one
`supabase/functions/import-collection/index.ts:145-160` vs `:38-52`

`biSeedRow` (`:42`) runs `cleanName()` per artist over the structured `basic_information.artists[]` and
joins with `", "`. The inventory `seedRow` (`:150`) takes Discogs' single pre-joined display string and
applies `cleanName` once — and its regex `/\s*\(\d+\)\s*$/` anchors at the end, so an inner `"(2)"`
survives (`"Prince (2) & The Revolution"`). `seed_releases` merges last-writer-wins on non-empty
(`0036:246-247`), and `releases` is a **shared, all-users catalog**.

Not even a race: `runImport` sets `tw_inventory_due` at `boot.js:762`, so the inventory sync always
runs *after* the collection import — the degraded string is the last writer by construction, and
`enrich-release` never rewrites `artist`. One user listing a record for sale changes what every other
user sees, and `app.js:820-823` buckets Top artist by exact string. The identical defect class (a
dropped `cleanName`) was rated MAJOR-1 in `docs/phase-1-stage-c-plan.md:1083-1086`.

### T2.17 — Smaller correctness defects
| # | Where | Defect |
|---|---|---|
| a | `app.js:2033` | `detailGenre` is the only additive-filter case missing `_filterToCrate()` (all four siblings have it, per #57) — a style chip clicked from a friend's ledger sets a filter with no visible effect |
| b | `app.js:506-507` | All five providers normalize a missing year to the sentinel `0` (`boot.js:200 232 434 454 1553`); the card interpolates `esc(r.year)` raw, so it renders a literal **"0"**. The modal (`:1453`), ledger (`:801`) and dna.js all guard it |
| c | `dna.js:39,92` vs `app.js:808` | Two denominators for one number on one screen: dna.js divides by `yrs.length` (years > 1900) but prints `S.total` in the sentence; app.js divides by `all.length`. The exported PNG states a percentage that does not follow from the denominator it names |
| d | `app.js:1210-1215` | `_trayList` is prefixed with *all* selected genres regardless of the query, so `_matchN` subtracts the full selected count. Select "Techno", type "techno" → one highlighted matching chip beside the words **"NO MATCH"**. The formula is right; the label is wrong |
| e | `app.js:668-671`, `:699-701` | On a failed wantlist load the ledger's overlap band silently drops half and shows "No shared records yet". Narrow trigger (needs `youWant === 0 && theyWant > 0`) and it self-heals on a tab switch, but the ledger offers no retry and no indication the half is missing |

---

## Tier 3 — Operations, CI, and deploy integrity

### T3.1 — Two monitoring blind spots, one of which has already been hit
- **No version marker anywhere in `public/`.** Grepped for `TW_VERSION`, `version.json`,
  `<meta name="version">`, `data-version`, `__VERSION__` — nothing. The only version strings in the
  payload are prose in code comments — 28 of them, the most-recent-stale being four markers at `v1.20.x`
  (`boot.js:1146`, `boot.ui.js:320`, `boot.ui.js:474`, `styles.css:421`), nineteen release sections behind. So a Pages build failure
  (Cloudflare correctly keeps the previous deployment live) is undetectable from outside: `git log`,
  the README badge, `VERSION` and the uptime probe all say the release shipped. This only became a live
  risk at v1.30.0, when a build command was added.
- **No probe touches a Cloudflare Pages Function.** `uptime-probe.yml:33-39` targets `/boot.js`, which
  `_routes.json` deliberately leaves *outside* the Functions include list; `:41-55` POSTs directly to
  Supabase, bypassing Cloudflare entirely. So `/og/*`, `/c/*` and `/api/release/*` can all be down with
  both probes green. **#112 is the proof** — `functions/og/[slug].js:235` records "#112 REPRODUCED",
  a shipped `/og/*` defect returning empty 200 PNGs, which both probes would have passed.

*Fix (one step covers both):* write `VERSION` into `public/version.json` at build time; add a third
probe asserting it matches `main`'s tip **and** that `/og/<slug>` returns 200 + `image/png` + a
non-trivial `content-length`.

### T3.2 — The badge workflow can freeze green, or fail red with no recovery
`.github/workflows/sync-version-badge.yml:73-88` and `:33-36`

- **Silent no-op:** the `sed` is anchored on the literals `version-` and `-blueviolet`. If either
  drifts, nothing substitutes, `git diff --quiet README.md` therefore **succeeds**, the `||`
  short-circuits, and — since that expression is the last command in the block — the step exits 0
  green. Nothing asserts the badge now names `$VERSION`. The badge freezes forever with a green check
  on every release.
- **Unrebased push:** a bare `git push` with no `git pull --rebase origin main`. The sibling
  `refresh-collection.yml:67-70` was explicitly patched for this under E5/#103; the fix was applied to
  one workflow and not the other. On a race the job fails red, and since the trigger is scoped to
  `paths: [VERSION]`, nothing re-runs until the next version bump. (`fetch-depth: 2` would still permit
  the rebase — the merge base is the checked-out commit.) History shows the near-miss at v1.28.1.

*Fix:* `grep -q "version-${VERSION}-blueviolet" README.md || exit 1` after the sed, plus the sibling's
one-line rebase. Same PR.

### T3.3 — 82 of 90 releases are untagged, and seven of the eight tags misreport their own version
`git tag` returns 8; `CHANGELOG.md` has 90 numeric release sections. Everything from `0.1.0` through
`1.27.0` except `1.0.0` — including the `v1.14.0` and `v1.25.0` audit baselines — has no addressable tree, so
`git checkout v1.19.0`, `git diff v1.19.0..v1.20.0` and a Cloudflare rollback target are all
impossible. `v1.0.0` was backfilled ten days late (tagger `2026-09-07`, commit `2026-08-28`).

Separately and structurally: the badge job fires *on* the VERSION push, so its correction is
necessarily a **child** of the commit a human tags. Checked all 8 tags — seven show a badge one release
behind (`v1.31.0`→1.30.1, `v1.0.0`→0.4.0). The one exception (`v1.28.1`) only matches because a botched
push forced a redo.

*Fix:* one change closes both — have the badge workflow `git tag -a "v$VERSION"` **after** committing
the badge. Don't backfill the 82.

### T3.4 — `refresh_collection.py` silently truncates the fixture on a transient fault
`build/refresh_collection.py:58-70`, `:82-85`, `:130-132`; `.github/workflows/refresh-collection.yml:47-56`

`get_with_retry` returns `None` for **both** a genuine 404 and "four attempts all raised" — a non-404/429
`HTTPError` re-raises loudly, so `None` is precisely the quiet path. Inside the pagination loop that
`None` becomes a bare `break`, byte-identical to normal completion. `main()` guards only the
fully-empty case. The workflow's verify step checks *which keys* are present and prints `len(data)` but
asserts nothing about it, then commits and pushes. The listing sorts `added desc`, so a truncation
always drops the **oldest** records — the least likely slice for anyone to notice.

Mitigations: dispatch-only, and the fixture is dead in production (T1.2). Still worth ten minutes.

*Fix:* distinguish `None` from an empty page and `sys.exit(1)`; add a floor (`len(data) > 1500`) to the
verify step.

### T3.5 — The Pages build contract lives only in a dashboard, and `DEPLOY.md` contradicts itself
`wrangler.toml:1-7`, `package.json`, `.gitignore:3`; `DEPLOY.md:26` vs `:140-141`

`wrangler.toml` captures `pages_build_output_dir = "public"` and nothing else. The build command
`npm install` — the sole reason `workers-og` resolves at bundle time, given `node_modules/` is
gitignored — exists only as a Cloudflare dashboard setting. `DEPLOY.md:26` still says
*(none)* in the canonical settings table an operator reads first, while `:140` records the v1.30.0
change that added it. Rebuilding the project from the repo per that table ships without `/og/*`.

Related: `npm install` (not `npm ci`) makes the tracked lockfile advisory — a `package.json` bump
without a lock regen resolves and ships a version that was never tested.

*Fix:* add `[build] command` to `wrangler.toml` so the setting is diffable, correct `DEPLOY.md:26`, and
move the dashboard command to `npm ci`.

### T3.6 — Edge and header hygiene
| # | Where | Defect |
|---|---|---|
| a | `public/_headers:55-60` | `/c` and `/c/*` are missing from the no-cache block. `_routes.json` includes `/c/*` but **not** bare `/c`, which therefore falls to `_redirects` and is served by the asset store under default caching — the exact stale-shell class the `/i` entries were added for (audit v1.25 F4, issue #9) |
| b | `functions/og/*`, `functions/api/release/*` | `/c/*` carries the full `SEC_HEADERS`; `/og/*` carries only `X-Content-Type-Options` + `Cache-Control`, and `/api/release/*` carries **neither** on any of its **seven** return paths (`:36 :43 :48 :54 :68 :76 :89`) — the cached replay at `:54` included, which re-serves a stored response that also lacks `nosniff`. The nosniff omission on a JSON endpoint is the part that matters; `SEC_HEADERS` should be one shared constant, not a per-Function decision |
| c | `functions/api/release/[id].js:36` | `^\d+$` has no length cap and no canonicalization, so `249504` and `0000249504` are two cache keys and two upstream calls on the shared token; a padded-id scan makes the key space unbounded |
| d | `functions/api/release/[id].js:60` | No `AbortSignal` — the sibling `/og` function uses a 3s budget for the structurally identical call. Same for all 11 fetches across `supabase/functions/**`: a hung upstream pins an isolate until the platform reaps it |
| e | `functions/c/[slug].js:41` | The `!shellResp.ok` early return is the one path that skips `SEC_HEADERS`. Only reachable when the site is already broken; one-line hygiene, not a security finding |
| f | `public/_redirects:45-51` | The comment designates the `/c` rules "the fallback for a Functions outage." Pages does not re-dispatch a throwing Function to the asset server — these are a *config-rollback* fallback, and they cover only bare `/c`. (`functions/c/[slug].js:9` and `_redirects:50` do agree that bare `/c` serves the SPA shell — an earlier draft claimed otherwise; that half is withdrawn) |

### T3.7 — Dependency pinning asymmetry
`supabase/functions/**` (all nine) import `jsr:@supabase/supabase-js@2` — a **major range** — plus a
fully unversioned `jsr:@supabase/functions-js/edge-runtime.d.ts`, with no `deno.json`, `deno.jsonc`,
`deno.lock` or `import_map.json` anywhere in the repo, while `_shared/auth.ts:21` pins
`jose@v5.9.6` exactly. Two deploys of byte-identical source can ship different supabase-js minors —
in the isolate holding `SUPABASE_SERVICE_ROLE_KEY` and the AES-GCM-decrypted Discogs tokens — and a
rollback is not reproducible.

The same shape on the client: `boot.js:27` imports supabase-js from jsdelivr at the `@2` range with no
SRI, so a third party resolves the exact bytes at load time. That, rather than the CSP allowlist's
breadth, is the live supply-chain exposure.

### T3.8 — Database hygiene
| # | Where | Defect |
|---|---|---|
| a | `0012:11-13`, `0018:10-12`, `0028:10-11` | The three visibility CHECKs restrict to `('private','friends')` with an unhonored `-- Wave 5: add 'public' here` TODO; 0037 widens them in a *later* file. `ADD CONSTRAINT … CHECK` validates existing rows, so once any profile is `'public'` these three are unreplayable — and each DROPs the working constraint first. The tree is otherwise deliberately replay-safe (`-- B7 #75` on 0028's own drop line). A landmine for branch reprovision and migration repair |
| b | `0036:90-100` | The 0036 rewrite added `limit 100` to `friends`; 0033 had no cap, and 0036's header asserts the output contract is "byte-compatible", enumerating only the per-set 200 cap. Truncation orders by `f.friend_id` (an opaque Clerk sub), so *which* friends vanish is arbitrary and permanent, `list_friends` is uncapped and shows all of them, and nothing in the payload says truncation occurred |
| c | `0040:83-113` + `0037:194-196`; `functions/c/*`, `functions/og/*` | `get_public_crate` is granted to `anon`, returns the **entire** crate + wantlist + inventory with no LIMIT or cursor, and both public Functions call it on **every** request before their cache lookup (`/og` by design per #114; `/c` has no server-side cache at all) — to compute a record count and one style name. An unauthenticated caller turns ~80 bytes of request into ~1MB of Supabase egress, with no rate limit in the path. A cheap summary RPC would let the hot path skip the megabyte |
| d | `0032:51-87` | `pending_enrichment` runs **four** full scans of the shared `releases` catalog per call (count+list for the refresh class, count+list for the master class), driven by predicates no per-user index can help. Cost is O(total catalog) regardless of the caller's collection size, and `releases` grows with the *user base*. The `0036:26-30` "releases is small enough" note is honest today and self-dating. Free win: collapse each count+list pair into one materialized CTE |
| e | `0001:49`, `0017:17`, `0027:15` | Three bare `(user_id)` indexes shadowed by wider composites (`0001:47`, `0017:15`, and — for inventory — the `unique (user_id, listing_id)` at `0027:13`, **not** `0036:46-47`, which is partial on `status='for_sale'` and cannot shadow a full index). Pure write amplification. Also `0032:14-16` is now dead once the master-year drain completes |

### T3.9 — Crypto key rotation passes the health gate and orphans every stored credential
`supabase/functions/_shared/discogs.ts:44-46`, `:65-91`; gates at `connect-discogs:45`, `-callback:49`

`selfTest()` round-trips a **freshly generated** ciphertext under the key it was handed, so it succeeds
for any well-formed 32-byte key — including one that has nothing to do with the ciphertexts already in
`discogs_credentials`. It therefore cannot detect the single failure it is positioned to gate. The
stored framing (`iv(12) || ct||tag`) carries no version byte and no key id, so nothing can tell which
key produced a blob and no dual-key rollover is possible. `DEPLOY.md:97` acknowledges the consequence
("rotating it orphans stored tokens"); no code detects it.

*Scenario:* an operator rotates `DISCOGS_TOKEN_ENC_KEY`. Both connect functions still report healthy and
a *new* connect works end-to-end, while every already-connected user's `import-collection:189` throws at
`decrypt`, sets `import_status='error'`, and returns `credentials_unreadable`. Because the blobs carry no
key id, the old key cannot be used to decrypt-and-re-encrypt afterwards — every user must reconnect.

*Fix:* prefix the blob with a version byte plus a short key id (first 4 bytes of `SHA-256(key)`) so
`decrypt` can distinguish *wrong key* from *corrupt data* and a rollover can accept two keys; probe one
real stored row at startup, not a fresh one.

### T3.10 — `supabase/config.toml` is inert on the deploy path `DEPLOY.md` names first
`supabase/config.toml:1-11`, `:33-35` vs `DEPLOY.md:102-107`

The file is written and reasoned about as a guard, but it is read only by the Supabase **CLI**. On the
path `DEPLOY.md` lists first — `deploy_edge_function` through the break-glass MCP connector —
`verify_jwt` is a per-call argument and this file is never consulted.

Coverage is otherwise complete and correct: all nine function directories have a block, `_shared` is
correctly excluded, and the default for an uncovered function is `verify_jwt = true` — **fail-closed**.

*Scenario:* a `_shared/` change is redeployed via `deploy_edge_function` with `verify_jwt` omitted (it
defaults on). The platform gate rejects the Clerk RS256 token before `verifyClerk` runs, every Connect
click 401s — and anyone diagnosing it by reading `config.toml` sees `verify_jwt = false` and concludes
the setting is fine.

*Fix:* one line in the file recording that it binds only the CLI path, and the `verify_jwt: false`
requirement moved into the `DEPLOY.md` deploy checklist as a post-deploy assertion — the forged-Bearer
401 check at `DEPLOY.md:108-110` already exists and would catch it.

### T3.11 — `seed_catalog.py`: a failed run leaves the previous SQL on disk, and "idempotent" oversells it
`build/seed_catalog.py:18-21`, `:44-46`, `:81-85`, `:88-121`

Two defects in one script. **(a)** Both abort paths return before `OUT.write_text(sql)` and neither
removes `OUT` — a stale `seed_releases.sql` from an earlier successful run survives a failed
regeneration with an unchanged mtime and no marker, while the documented next step is "then load
`seed_releases.sql`". **(b)** The emitted statement is `on conflict (release_id) do nothing`, labelled
"Idempotent … Safe to re-run": true for the *set of ids*, false for row *contents* — all eight `CC0_META`
fields plus `tracks/country/released/videos` are dropped on conflict. The two summary lines count what
the file holds, not what the database accepted, so a run that changes nothing prints identically to one
that inserts 1,861 rows. The production path added later (`seed_releases(jsonb)`, `0010:65-87`) **merges**,
so the two seeding routes for one table now have opposite update semantics.

*Fix:* write to a temp path and `os.replace` on success; either mirror 0010's merge or state plainly in
the header and stdout that existing rows are never modified.

### T3.12 — Eight OFL-1.1 font binaries are redistributed publicly under a root MIT licence, with no OFL text
`public/fonts-og/*.ttf` (8 files), `LICENSE:1-3`, `wrangler.toml:3`

All eight faces declare SIL OFL in name ID 14 (Anton, Barlow Condensed, IBM Plex Mono) and none carries
name ID 13. There is **no** `OFL.txt`, `OFL-FAQ.txt`, or third-party notices file anywhere in the repo —
`find` for `LICEN*`/`OFL*`/`COPYING*` returns exactly one file, the root MIT `LICENSE`, and neither it
nor `README.md` mentions a font. These are genuinely redistributed, not merely present in source:
`public/` is the Pages build output and `_routes.json` routes only `/api/* /c/* /og/*` to Functions, so
`https://traxwax.com/fonts-og/Anton-400-latin.ttf` is a public download.

OFL 1.1 §2 requires the copyright notice **and the licence text** to accompany each copy; §5 forbids
releasing an OFL component under another licence — which is what a repo-wide MIT grant nominally does.

*Scenario:* someone takes the repo at its word — clones under the MIT grant, or downloads the TTF from
traxwax.com — and redistributes it as MIT-licensed, receiving no OFL text, on a licence claim the repo
made and OFL §5 does not permit it to make.

*Fix:* drop `OFL.txt` into `public/fonts-og/` (one copy covers all three families) and add a
"third-party assets" clause to `LICENSE` or `README.md` carving the fonts out of the MIT grant. Record
the MPL-2.0 components (`satori`, `@resvg/resvg-wasm`) in the same place.

### T3.13 — `workers-og` is the only lockfile entry with no declared licence
`package-lock.json:204-214`

All 24 dependency entries carry `license` except this one — npm writes that field from the package's own
manifest, so its absence means `workers-og@0.0.25` publishes none. It is the *direct* dependency and the
only one imported by application source (`functions/og/[slug].js:13`), and its two heaviest transitive
deps (`satori`, `@resvg/resvg-wasm`, both **MPL-2.0**) impose source-availability obligations no notices
file records. A licence/SBOM scan run before shipping resolves 24 of 25 and reports the top-level runtime
dependency as UNKNOWN.

*Fix:* confirm the licence upstream and record it plus the MPL-2.0 components in `THIRD-PARTY-NOTICES.md`
— pair with T3.12, same file.

---

## Tier 4 — UI, accessibility, and polish

| # | Where | Defect | Fix |
|---|---|---|---|
| 4.1 | `boot.ui.js:397-399` | The PROFILE tab states unconditionally "Nobody sees any of this yet — your crate is private", with a comment saying to delete it "the day crate_visibility ships." It shipped. Friends receive bio, location, both links, photo and display name (`0028:60-67`); anonymous visitors receive photo, reduced name and collecting-since (`0038:92-97`). A false privacy assurance on a consent-adjacent surface | Delete or derive from the three visibility fields |
| 4.2 | `boot.ui.js:408-410`, dup at `boot.js:1187-1188` | UPLOAD A PHOTO is a bare `<label>` (no tabindex, no role) wrapping a `display:none` file input — **zero focusable elements**, so the only photo-upload path in the app is keyboard-dead in two places. The label text *is* announced in browse mode, which is arguably worse: the user is told it exists and given no way to operate it. WCAG 2.1.1 | `tabindex="0"` + keydown, or clip-hide the input |
| 4.3 | `boot.ui.js:574-576`, `:1112-1113` | Palette swatches set `outline` **inline** (`none` inactive, `2.5px accent` active). Style-attribute declarations outrank any non-`!important` rule, so `styles.css:40`'s `*:focus-visible` ring can never paint — and the active swatch's permanent outline is visually identical to the ring. No other focus affordance exists on these three buttons | Express active state with `box-shadow` |
| 4.4 | `boot.ui.js:333`, `:362` + `styles.css:438` | The nav separators are bare `<div style="height:1px">` and are direct children of `.tw-acct-nav`, which the strip layout gives `> div { padding:8px 12px !important }`. With `box-sizing:border-box` that resolves to 16px tall × 24px wide, background painting the whole padding box: two solid grey blocks in the nav. **At every width ≤820px**, phones included — not 641–820 as first reported | Class hook, or make them `<hr>` |
| 4.5 | `boot.ui.js:626-654` (3 rows) + `:721-733` | The SHARING visibility rows have no `flex-wrap`, `flex:none` on the control, no `min-width:0` on the text, and **no class at all**, so no responsive rule can reach them. Min-content ≈337px against 278px available at 360px — the rows overflow and the **consent screen side-scrolls on every common phone**. The MATCHING row (≈354px) is worse | `flex-wrap:wrap` + `min-width:0` + a class hook |
| 4.6 | `boot.ui.js:535-537` | The invite-link input's `min-width:280px` inside a 118px inset chain (verified: 8+8+1.5+1.5+30+30+1.5+1.5+18+18) needs a ≥398px viewport. Overflows by ~23px on a 375px iPhone. Reached only after CREATE AN INVITE LINK succeeds | `min-width:0` + flex-basis |
| 4.7 | `styles.css:7`, `:14`; ~12 call sites | **Computed independently.** `--accent` as text: `#e01046` on `#17181b` = **3.66**, `#e8194b` on `#eceef0` = **3.86**, `#e01046` on `#0e0f11` = **3.96** — all fail AA-small at 9.5–13px; `#e8194b` on `#ffffff` = **4.495** — marginally *below* AA-small, though checkers that round to two decimals report it as a pass. This is the colour of every account status and error line. Separately `boot.ui.js:880-881`'s SETTINGS kicker uses `rgba(255,255,255,.78)` on accent = **3.14** / **3.33**, where plain `#fff` would be 4.495 / 4.85 — the alpha buys the failure for nothing, and it also breaks the file's own no-literal-hex rule | Dark-theme text accent via the `color-mix` trick already at `:290-293`; drop the alpha |
| 4.8 | `app.js:394-408`, `:1381`, `:1388` | View tabs and sort buttons convey selection only through border/text colour — no `aria-current`, `aria-selected`, `aria-pressed`, `role="tab"`, no `role="tablist"` on the row. The direction button's accessible name is the glyph, so it announces "downwards arrow button". A repo-wide grep finds exactly one `aria-current` **emitter**, in the account nav (`boot.ui.js:335`; the only other hit is the CSS selector at `styles.css:439`). The app's primary navigation is stateless to assistive tech, in a file that otherwise emits `aria-pressed`, `aria-expanded`, `aria-haspopup` and a live region | Three attributes |
| 4.9 | `styles.css:21-22` vs `boot.ui.js:183 196 230 521 802 812 818` + all `btnLink` | Every anchor sets `color` inline, so `a:hover` is inert for all of them — no link in the account or friends UI has any hover feedback. `styles.css:24-25` documents this exact trap verbatim and applies the lesson only to `.tw-wl-remove` / `.tw-want-add` | Move colours to classes (not a one-liner: 7+ sites) |
| 4.10 | `styles.css:423` + `boot.ui.js:400-401`, `:531-532` | `.tw-acct-status:empty { display:none }` removes `role="status"` live regions from the tree; injecting text un-hides and populates in one tick, which is a documented-unreliable pattern for NVDA/JAWS (not a deterministic failure — corrected). Separately, PROFILE and FRIENDS are **missing the class**, so they carry a phantom 26px / 12px flex gap. Note the tension: the two sections missing the class are the two whose live regions announce reliably | Fix the CSS first (`height:0; overflow:hidden`), *then* add the class |
| 4.11 | `boot.ui.js:663-673` | The locked for-sale row hardcodes "🔒 PRIVATE / FRIENDS" and never reads `fsVis` (computed at `:596`, used only in the unlocked branch). Mostly benign — `can_view_forsale` requires a non-private crate anyway — but a user who set for-sale to **public** then took the crate private sees "PRIVATE" with no hint that `'public'` is stored and will re-engage the moment the crate reopens | Render `visSegBtn`s with `pointer-events:none` |
| 4.12 | `boot.ui.js:469` vs `:969`, `:977` | Arming DISCONNECT replaces the whole style attribute, dropping `align-self:flex-start`; the column parent's default `align-items:stretch` then stretches it. Most of the jump is the longer armed label, but on the **failure** path `:977` restores the short label into a still-stretched box for the rest of the session | Append the property at both sites |
| 4.13 | `functions/og/[slug].js:72-76`, `:93` | `headlineFits()` only chooses one-line vs compact — nothing truncates, and the spec forbids ellipsis. An 80-char single-token `display_name` (which `get_public_crate:77-81` passes through whole, since the reduction needs a space) blows the headline past the 1200×630 frame. **Reframed** from the raw finding's bidi-security claim: the payload only ever appears on the attacker's own card, so this is a rendering bug, not a security one | Cap the reduced name (~20 chars) and strip `\p{Cf}` in one shared helper both Functions call |
| 4.14 | `functions/og/[slug].js:60-61`, `:102` | Upstream `Content-Type` is interpolated raw into `src="data:${mime};…"` inside the satori HTML — the only value in that builder not passed through `txt()`. Exploitability today is low **by provenance, not by enforcement**: `:46` validates the cover URL only as `^https://` — nothing pins it to a Discogs host, `releases` is a shared all-users catalog, and per T2.11 that check covers only the first hop | Allowlist the MIME, and pin the cover host — pair with T2.11's `redirect: 'manual'` gap |
| 4.15 | `app.js:1176` (from `:1358`) | `identityHtml()` re-runs the entire `computeVals()` pipeline to read one field, `allStyles`, when `render()` already computed `v` at `:1188`. Gated to public viewers only. **Measured** at 1,861 records: 2.86ms (`added`) / 3.88ms (`artist`) per duplicate — ~3-4ms desktop, plausibly 15-30ms mid-range phone, per render | Pass `v` in. The cheapest perf win here |
| 4.16 | `app.js:877`, `:1541-1558` | `renderModal()` calls `_syncGridRoving()` unconditionally, including from stats-load, tracklist-load, retry and close — none of which change the grid or move `_gridFocusId`. 7,444 element writes per walk × 3-4 walks per card click. Two early-outs exist, but none for "the grid did not change" | Guard on a grid-DOM generation counter |
| 4.17 | `boot.js:1532`, `:1525` | `_publicClerkPass` is called un-awaited with no `.catch`, after `boot().catch(showError)` has resolved. **Corrected:** the cited throw path (`installViewerMatchCtx`) can't actually reach it — that throw lives inside a provider `bootCrate` handles via `allSettled`. Real paths are thin (a rejecting `import('/app.js')`, a malformed `status:'ok'` payload), but the strand is permanent when it happens: "Loading the crate…" forever | One-line `.catch` at both sites |
| 4.18 | `boot.ui.js:242`, `:89`; `styles.css:137-143` | Three dead exports/rules with actively misleading comments: `emptyState()` has **zero** callers while insisting "do not re-author the markup" (and lacks the `tw-empty-h` class its hand-rolled rivals use for the ≤640px override); `toggle()` has zero callers and claims "Wave 1 uses three"; `.tw-wordmark*` has zero emitters while two surfaces hand-roll it inline (`boot.ui.js:155`, `:878`), a third uses a separate `.tw-land-wordmark` class, and a fourth is drawn server-side | Delete, or adopt and fix the comments |
| 4.19 | `boot.ui.js:325`, `:340`; `:347` | `n.target` is dead on every NAV entry since v1.20.3, so two branches are permanently unreachable. **The a11y half of this finding was killed** (non-focusable + `aria-current` is the standard pattern). The gap worth noting instead: `.tw-acct-nav` is a plain `<div>` — no `<nav>`, no `role="navigation"`, so the account nav is not a landmark | Delete the branches; add the landmark |
| 4.20 | `boot.ui.js:266-291`, `boot.js:951` | `trapFocus` wraps Tab unconditionally on an ordinary page with `onEscape = null`, so the Escape branch is dead and Tab cycles endlessly. **Not** a WCAG 2.1.2 failure (`#app` is the whole body). Real residue: a disorienting cycle, and a document-level listener that survives when `notice()` paints over the account page | Drop the wrap, keep `first.focus()` |
| 4.21 | `public/_headers:20` | CSP hardening path, stated honestly: `'unsafe-inline'` and `cdn.jsdelivr.net` are both **load-bearing today** (five static inline `<script>` blocks; the supabase-js import) — removing either breaks the site. `img-src`'s bare `https:` does permit exfiltration to any host, and there is no `report-to`, so an enforced policy fires silently | `report-to` first (10 min), then `sha256-` hashes for the five static blocks, then vendor supabase-js to delete the jsdelivr entry |
| 4.23 | `boot.clerk.js:54-59`; bound at `boot.js:1779`, re-mounted at `:1089-1099` | The appearance object is resolved **once at `Clerk.load()`**. The comment justifies this because "the auth screens carry no theme toggle" — but the *crate* screen shares the same page load and does have one (`app.js:311`), and `boot.js:1794-1800` re-routes in-page to `mountAuth()` on any signed-in-state change, passing no per-mount `appearance`. Load light → toggle dark → session ends in another tab (the same trigger as **T2.8**) and the sign-in card renders `colorText:'#16171a'` on the dark `--panel` showing through `.cl-card{background:transparent!important}`: **1.01:1 — the form is invisible** | Pass `appearance` at mount, not load |
| 4.24 | `boot.clerk.js:27-30` | The dark branch overrides exactly one element colour (`formFieldLabel`) and spreads the rest unchanged, so `dividerText` keeps the light-mode `#666a72` on the dark card: **3.27:1 at 9px** (5.43:1 in light). Meanwhile `styles.css:504` makes `.cl-dividerLine` follow the theme — the rule adapts and the word sitting on it does not. Same class as the already-fixed #108 | Add the `--faint` dark token (`#9ea2a9`, ≈6.0:1) |
| 4.25 | `boot.clerk.js:31-33` | `formFieldErrorText` hard-codes the **light** accent `#e8194b`, and an element rule beats the variable it derives from — so the dark branch's deliberate `colorDanger:'#e01046'` never reaches the one element whose job is danger text. A mistyped password in dark mode renders the inline error in one red and the field's danger ring in another. Both are sub-AA on `#17181b` (3.95:1 / 3.66:1) | Drop the `color` and let `colorDanger` drive it |
| 4.22 | `.github/workflows/refresh-collection.yml:21-22`, `:69-70` | `workflow_dispatch` allows any branch; `:69` hardcodes `origin main` while `:70` pushes to the checked-out branch's upstream. **Corrected:** this fails loudly (non-fast-forward rejection) rather than corrupting anything; the only quiet case is a branch strictly behind main | One-line ref guard |

---

## Not filed — raised for a decision

- **`get_public_crate` reduces the display name for strangers ("Lane B.") but returns `avatar_url`
  verbatim** (`0040:76-81` vs `:115-122`). The two fields in one projection implement opposite privacy
  postures, so the name reduction offers assurance the avatar defeats. This is a product call, not a
  bug — worth deciding deliberately rather than filing.
- **Sharpen #77 rather than re-file it.** `verifyClerk` (`_shared/auth.ts:49-56`) passes no `audience`
  to `jwtVerify` and enforces `azp` only `if (payload.azp)`. The tracked trigger is "the day a second
  app joins this Clerk instance" — but a **JWT Template** on the *existing* instance mints tokens with
  the same `iss` and no `azp` by default, which `verifyClerk` would accept. That widens the trigger
  without needing a second app. A comment on #77, not a new issue.
- **Parked with a trigger (do not file):** the `get_social_feed` OR-join shape (`0036:123-146`) and
  `list_friends`' correlated master probe (`0031:30-37`). Both are genuine shapes, both are sub-ms at
  current scale, and an index on `releases(master_id)` would *not* help the second one (the inner
  EXISTS reaches `releases` by primary key). Revisit trigger: a real user with 30+ friends **and**
  `match_mode = 'any'`.

---

## Coverage — probed and found sound

Recorded so a later audit knows what was actively attacked, not merely skimmed.

- **XSS across the frontend.** Every `innerHTML`/`insertAdjacentHTML`/url-bearing `setAttribute` sink in
  `app.js` and `boot.ui.js` traced to provenance. `esc()` (which correctly escapes `'`) is applied at
  every user- and API-controlled sink. The documented raw-HTML slots (`stateCard.body/problem/extra/
  actions/footer`, `sectionLabel`) are escaped at every call site. The cover-URL → `style` attribute
  path (`app.js:364-378`) genuinely closes the `url('…')` breakout.
- **Secret scan, tree and history.** 2,007 tracked files plus `git log -p --all` (214 commits) against
  pk_/sk_/rk_ prefixes, `eyJ`, service_role, consumer_secret, ghp_/github_pat_/xox*/AKIA/AIza, private
  keys, DB URLs with credentials, plus a generic ≥28-char entropy sweep. **No genuine credential is
  exposed.** Every hit is a key type designed for public distribution (Clerk publishable — its base64
  body decodes to the instance host; Supabase publishable; the Umami site id), a deliberately-invalid
  forged test token in the phase docs, or a non-credential identifier. No `.env`, `.dev.vars`, `*.pem`
  or `*.key` has ever existed in history; no `refs/original` survives the #63/#64 purge.
- **The #63/#64 Restricted-data history purge is complete for JSON** — no historical blob under
  `public/collection.json` or `public/releases/` carries `price`/`crating`/`crcount`/`have`/`want`/
  `lowest_price`/`num_for_sale`. Its blind spot was the image tier (T1.1).
- **RLS end state.** Every table's posture confirmed: `USING` without matching `WITH CHECK` appears
  nowhere; the one UPDATE policy carries both halves. Every SECURITY DEFINER function reachable by
  `authenticated` re-derives the caller from `auth.jwt()->>'sub'` and takes only a username, slug or
  code as argument; every function that *does* take a caller-supplied identity is service_role-only.
  No `private.*` function is executable by `anon` or `authenticated` in the end state (the 0013→0016,
  0028→0035, 0033→0035→0036 lockdown sequence is complete). `get_public_crate` is the only
  anon-granted function. All four generations of `get_friend_crate`, `get_public_crate`,
  `get_crate_owner`, `crate_match`, `get_social_feed` and `profiles_guard` diffed for lost checks —
  the friend cap (T3.8b) is the only contract change found.
- **Right-to-erasure chain** verified for atomicity and cleanup completeness (see T2.9 for the ownership
  predicate it does *not* cover) across `delete_account`, `unlink_discogs_account` and
  `link_discogs_account`, including the A1/#62 handle-change cleanup and the savepoint that keeps
  `finalize_discogs_link`'s three deletes from half-applying on `handle_taken`.
- **No SSRF in the Edge Functions.** Every upstream host is a hardcoded literal; the only interpolated
  path segments are numeric ids and `encodeURIComponent(discogs_username)` sourced from Discogs' own
  identity response. AES-256-GCM at rest asserts a 32-byte key and self-tests before any write.
- **State/pending consumption is atomic** in both `connect-discogs-callback` and
  `finalize_discogs_link` (single-statement `DELETE … RETURNING`), so a double-loaded redirect or a
  link prefetcher cannot both pass an existence check.
- **Open-redirect check on the Discogs handoff** (`boot.js:1328-1334`) re-parses the server-supplied
  `authorize_url` and hard-fails anything not `https:` on discogs.com — correct trust-but-verify on the
  one page where the user is primed to type Discogs credentials.
- **Slug validation is consistent across three layers** — the same regex byte-for-byte in
  `functions/c/[slug].js:43`, `functions/og/[slug].js:180`, `boot.js:1548` and the DB CHECK.
- **`SEC_HEADERS` and `public/_headers` are in genuine lockstep** — diffed directive by directive,
  byte-identical. The objection in T3.6b is about which *responses* carry the set, and T4.21 about what
  the policy says; neither is drift.
- **GitHub Actions:** no script injection (every `${{ }}` goes through `env:`), no trigger reachable by
  an outside contributor (no `pull_request_target`, no `issue_comment`, no `workflow_run`), the one
  third-party action pinned to a full commit SHA, `GITHUB_TOKEN` correctly scoped per workflow
  (`permissions: {}` on the probe), no secret echoed to a log, and no commit loop between the two
  writing workflows.
- **`public/releases/` is live, not dead weight** — 1,859 files fetched by `app.js:160`, union of keys
  exactly `{tracks, country, released, videos}` (CC0 only), zero orphans, zero gaps.
- **`boot()`'s auth ordering, `route()` re-entrancy, the `_bootGen`/`_stale()` generation guard, the
  deferred wantlist-removal state machine, the #59 feed seen-state engine, the URL filter round-trip,
  and the `_relCache` LRU + quota handling** were each walked for races and found correct.


---

## Documentation audit (fixed in flow, not filed as issues)

19 findings. The first one is the reason this pass exists.

**D1 — `CLAUDE.md:27` tells every future session that `_routes.json` pins Functions to `/api/*`.**
It has included `/c/*` and `/og/*` since v1.30.0 (`public/_routes.json:3`). The same wrong claim is at
`README.md:29`, `docs/design-screen-map.md:47`, and in `public/_redirects:15` — whose own comment at
`:16-18` instructs the reader to keep the two files in sync **on exactly this point**. A session that
trusts CLAUDE.md and "restores" `_routes.json` kills the entire public-crate tier and every OG unfurl.
`DEPLOY.md:31` is the only place that has it right.

**D2 — `DEPLOY.md:26` says build command *(none)*; `:140-141` says `npm install`.** Same file.
`README.md:7` also still says "no build step".

**D3 — `DEPLOY.md:144-146` documents the OG cache key that v1.30.1 deliberately replaced.** It describes
the canonical-pathname key; `functions/og/[slug].js:218-224` has been content-keyed since #114. An
operator following the current line would revert the key and reintroduce the bug.

**D4 — Four documents say Wave 5b is unshipped and pin "current version" two to eight releases back.**
`CLAUDE.md:90` and `README.md:109` say v1.25.0; `docs/roadmap.md:8` and `docs/social-roadmap.md:16` say
v1.23.2; `README.md:129-130` and `roadmap.md:192-194` list the public tier as "the main remaining item."
`VERSION` is 1.31.0 and it all shipped. `CLAUDE.md:32` claims roadmap.md "defers to VERSION" — it hardcodes.

**D5 — `CLAUDE.md:29` names only `_shared/discogs.ts`.** `_shared/auth.ts` — the single `verifyClerk`/CORS
preamble imported by all nine functions — is the more important of the two and is unnamed.

**D6 — `CLAUDE.md:40-42` points the design source outside the repo** at `TRAXWAX-DESIGN-SPEC.md`, which
exists nowhere. None of the five committed design docs is named in CLAUDE.md at all.

**D7 — Stale counts.** `README.md:33` says migrations 0001–**0033** (40 exist); `README.md:30-31` shows one
Pages Function (three exist); `README.md:38-40` lists two workflows (three exist — the missing one is the
monitoring implementation `DEPLOY.md:211` points at); both design specs say **thirteen** tokens (15 ship —
`--lock`/`--lockbg`); `CHANGELOG.md:170` says 79 versions precede v1.28.0 (83) and that tags "start at
v1.28.0" (`v1.0.0` is also tagged); `README.md:10` still calls the fifth tab FOR SALE, renamed THE GOODS
in v1.24.1.

**D8 — `CLAUDE.md:19-36` and `README.md`'s tree omit every file added since v1.3.2** — `boot.ui.js`,
`boot.clerk.js`, `dna.js`, `fonts-og/`, both new Pages Functions, `package.json`, all the design docs.

**D9 — `DEPLOY.md:120-122`'s friend-read RPC list omits `get_friend_wantlist`** — the *only* friend
wantlist read path since 0036 dropped `wantlist_select_friends`. Also missing `get_social_feed`, `crate_match`.

**D10 — `design-surfaces-spec.md:505-508` still instructs a maintainer to do three things already done**
(capture the hero — it exists as `.jpg`; load Barlow Condensed — `index.html:16` does; per-crate OG —
shipped). `design-screen-map.md:23` carries the same dead ASSET TODO.

**D11 — `design-surfaces-spec.md:191-197` records landing copy that no longer exists.** Hero is
`DIG YOUR / OWN CRATE.`, the twelve tiles are a mosaic image, the three-up is a four-up, and the §9.8
reserved slab is filled.

**D12 — `CHANGELOG.md:160-161` says `videos` "is no longer fetched anywhere."** The client stopped;
`enrich-release:180,190` still writes it and `api/release/[id].js:85` still returns it.

**D13 — `DEPLOY.md:35-37` lists half the no-cache entries** (missing `/dna.js`, `/boot.ui.js`,
`/boot.clerk.js`, `/account*`, `/i*`) — and it is the list an operator diffs when a stale-asset bug returns.

**D14 — `design-screen-map.md:16-17` says the crate spec is identical to `DESIGN-KIT-V1.md`.** It diverges
in three places where shipped-status was folded in.

**D15 — `DEPLOY.md:133-135` is written in the future tense about work that shipped**, and its section
header says "(v1.29.0, migrations 0037–0039)" while the body covers v1.30.0/v1.31.0 and 0040.

**Undocumented shipped behavior:**
- The **entire public-crate tier** is absent from README and CLAUDE.md except one line of the migration
  map. `README.md:74-88`'s Routing section still describes only `/`, `/app`, `/app/<username>` — not
  `/account`, not `/i/<code>` (v1.4.0), not `/c/<slug>` (v1.29.0).
- **Two normative design specs the shipped code cites by section number are not in the repo.** ~14
  comments reference "Header spec §0.4/§1/§2…" and "Wave 5b spec §4/§5/§6"; they live in an external
  `Design/traxwax-wave5b-design/`. **No future session can resolve any of those references.**
- v1.31.0's ledger geometry and v1.30.1's `tw_has_session` hint exist only in the CHANGELOG.
- `DEPLOY.md:179-186`'s deploy verification covers neither `/c/<slug>` nor `/og/<slug>` — the curl recipes
  exist only in a one-time branch-rehearsal checklist.
- **The v1.28.1 double-cut** (`370aa80` "restore real styles.css + VERSION — prior commit pushed
  placeholder strings") is recorded nowhere, which the project's own every-bug-gets-an-issue rule says
  it should be.

---

## What the verification pass caught in this document

The report was itself audited by an independent no-context agent before any issue was filed, because a
defect here multiplies by every issue filed from it. Recorded rather than silently fixed, so a later
round does not re-find a dead claim with no memory of why it died.

**Killed or corrected in this document:**

1. ~~"`functions/c/[slug].js:9` disagrees with `_redirects:50` about what bare `/c` serves"~~ —
   **withdrawn.** Both say the SPA shell. The rest of T3.6f stands.
2. ~~"82 of 90 releases untagged, and **every** tag misreports its version"~~ → **seven of eight**;
   `v1.28.1` matches because a botched push forced a redo.
3. ~~"`#e8194b` on `#ffffff` = 4.50, exactly on the line"~~ → **4.495, marginally *below* AA-small.**
   The verdict flips: it fails. Checkers that round to two decimals report a pass.
4. ~~"`aria-current` appears exactly once"~~ → twice; **one *emitter*.** The substantive claim survives.
5. ~~"`/api/release/*` … five return paths"~~ → **seven**, including the cached replay at `:54`.
6. ~~"A 429-specific `break` sits three lines above"~~ → **~17 lines above**; the 404 handler sits between.
7. ~~"two version markers, eleven releases stale"~~ → **four markers at `v1.20.x`**, nineteen sections back.
8. ~~"five surfaces hand-roll the wordmark inline"~~ → **two** inline, one via a separate class, one
   server-side.
9. ~~"1.0.1 through 1.27.0 has no addressable tree"~~ → the range silently dropped the eight `0.x`
   releases. The **total of 82 was right**; the enumeration was not.
10. ~~T2.4 cited `boot.ui.js:122-123`~~ → the CTA is in **`boot.js`**. Right lines, wrong file — the
    worst kind of wrong, because it looks plausible.
11. **Fifteen line references** were off (`:1548`→`:1742` twice, `:1520`→`:1527`, `:1652`→`:1650`,
    `:687`→`:689`, `:1730`→`:1729`, `:1939`→`:1940`, `:1428`→`:1429`, `:1370`→`:1372`,
    `:1671`→`:1672`, `:96-99`→`:38-39`, `:45`→`:44`, `:236-238`→`:235`, `:1389`→`:1388`). All corrected.
12. ~~"Tree @ `6ed3e6f` (tag `v1.31.0`)"~~ — `6ed3e6f` is the badge bot's **child** of the tagged commit.
    The audit's own header reproduced the defect T3.3 describes.
13. ~~The headline arithmetic~~ — `87 − 10 ≠ 63`, with 14 findings unexplained. Restated as an auditable
    chain and recounted.
14. **T1.1 prescribed an image checklist and did not run it.** The sweep found
    `screenshots/06-detail-modal.png` carrying four Restricted fields — now **T1.4**. This was the single
    most valuable catch: a Tier-1 finding that would otherwise have shipped as a to-do nobody executed.
15. **Eleven files were in no finding and no coverage bullet** despite a header claiming "entire repo":
    `_shared/discogs.ts`, `boot.clerk.js`, `build/seed_catalog.py`, `supabase/config.toml`,
    `package-lock.json`'s contents, `public/fonts-og/`, and four images. Auditing them produced
    **T1.5, T3.9–T3.13 and T4.23–T4.25** — including a path by which an OAuth token secret reaches the
    logs, and eight fonts redistributed under the wrong licence. `docs/` is now an explicit carve-out.
16. **T4.14's hedge leaned on provenance, not enforcement** — "the URL comes from Discogs' own CDN" is an
    assumption, not a check. Reframed, and the fix now includes pinning the host.

**What it confirmed:** every one of ~35 recomputable numeric assertions matched, several exactly
(7,444 = 1,861 × 4; 1,150,556 bytes; 458 distinct days; the 118px inset chain; zero orphans and zero
gaps across 1,859 files; six of seven contrast ratios to two decimals). Every "narrow / bounded /
self-heals / not reachable" qualifier was independently pressure-tested and all but one held. Of
twenty-one *claimed-absent* assertions, twenty were confirmed absent — the class of error most likely to
embarrass an audit produced exactly one miss (item 4).
