# Wave 5b — implementation plan (public crate tier) — PLAN REV 2

Status: replaces the design kit's draft `wave-5b-write-plan.md` (which was written 2026-09-06 against
v1.24-era code and has gone stale in places — see §2). Companion to `TRAXWAX-WAVE-5B-DESIGN-SPEC.md`
(LOCKED 2026-09-06) and `TRAXWAX-HEADER-DESIGN-SPEC.md` (LOCKED 2026-09-05), both in
`Design/traxwax-wave5b-design/`. Junior-engineer bar. `verification-pass` runs on this document before
any issue is filed or line of code executes from it.

Repo: `traxwax-clone` (v1.28.1 at plan time). Touches: `public/app.js`, `public/boot.js`,
`public/boot.ui.js`, `public/index.html`, `public/styles.css`, `public/_routes.json`,
`functions/c/[slug].js` (new), `functions/og/[slug].js` (new), `package.json` (new),
`supabase/migrations/0037_public_tier.sql` (new), `DEPLOY.md`, `CHANGELOG.md`.

---

## 1. Decisions register (all Lane, dated — the frame this plan is built in)

| # | Decision | When |
|---|---|---|
| D-GO | **Wave 5b is GO.** The Discogs letter (sent 2026-09-04) got no reply in a week; §A3 resolved: build AND ship on the reasoned position. Lane relays any reply either way. | 2026-09-09 |
| D-B1 | Slug scheme: **user-chosen vanity slug**, `/c/<slug>`, ≤18 chars lowercase `a–z 0–9 -` (the OG footer one-line cap, header spec §7 O3). | 2026-09-09 |
| D-SEL | The expanded per-tab three-way selector (PRIVATE → FRIENDS → PUBLIC ×3) **rides in this wave** (T9). | 2026-09-09 |
| D-PAL | OG palette: **owner picks, all three ship** (white / red / black). Stored per-profile; default `red` (it's what the landing slab advertises). | 2026-09-10 |
| D-OGINFRA | OG infra: **Cloudflare Pages Functions** for both the `/c/` crawler HTML and the `/og/<slug>` PNG. Same git-push deploy as the frontend; `_routes.json` include grows. Fallback posture if the PNG toolchain exceeds Workers size limits is documented in T7. | 2026-09-10 |
| D-GOODSFOOT | Public GOODS card footer: **`{year}` left · `BUY ON DISCOGS ↗` right** (option C of the rendered comparison — the year anchors the left cell, nothing can crowd the link). Options A/B remain as one-line swaps in T4 if the live build changes his mind. | 2026-09-10 |
| D-PERTAB | Per-tab public, all three shelves independently (`crate_visibility` / `wantlist_visibility` / `forsale_visibility` each gain `'public'`), for-sale riding under crate (E1). | 2026-09-05 (kit) |
| D-NAME | Public display name is **First + Last-initial** ("Lane B."), server-derived, never a surname, never the Discogs username. | 2026-09-06 (kit, locked) |

**Design check-ins owed to Lane during the build** (his standing instruction: unspec'd elements get
designed together before implementation):

1. **CHECK-IN 1 (before T9 code):** the OG **palette picker row** on the SHARING tab — not in the locked
   §9 spec (palette was still a product call when it locked). T9 carries a proposed treatment; mock it in
   the account-page idiom and get a yes before wiring.
2. **CHECK-IN 2 (during T5):** the **friend-view ledger** after the §6b gate-lift. §6b is unambiguous for
   public modes (both panels, both strips, no overlap, no DNA) but under-determined for the friend view
   (it keeps `overlapPanelHtml()` — where does the decade panel go?). This plan scopes the §6b lift to the
   public modes and leaves the friend ledger as-built; if Lane wants friends upgraded too, that's a
   layout question (three panels? tabs?) to design together, as its own small issue.
3. **CHECK-IN 3 (before T6 ships):** the 404 / CLOSED page render — frame 1e exists, but the copy block
   is short; eyeball the built page against the frame before cut.

## 2. As-built reconciliation — where the kit draft has gone stale

Verified against the working copy (v1.28.1) and the live schema on 2026-09-10:

1. **The three visibility columns already exist as `text` + CHECK** (0012 / 0018 / 0028; the crate
   and wantlist CHECKs carry the comment "Wave 5: add 'public' here" — the forsale one doesn't, F13).
   The draft's "migrate existing booleans: true → 'friends'" describes a schema that never existed.
   T1 amends three CHECKs; no data migration. **And the CHECKs are not the whole story: the
   `private.can_view_*` gates test `= 'friends'` strictly — see T1 §4 (verification F1).**
2. **Migrations run through `0036_audit_wave_d.sql`.** This wave's migration is **0037**, not 0034.
3. **The draft's "Follow `spinbound-preview-gate` for the migration" is wrong for this repo** — that
   skill is vinyl-tracker-only by its own description. TraxWax migrations apply via the **break-glass
   connector** per `DEPLOY.md` (arm → apply → advisors → disarm).
4. **Header modes A/B shipped in v1.24.0** (strip, identity slot, icon trio; status feed #59 in v1.25.0).
   The header-write-plan is DONE except one piece: **spec §3.3 "THE GOODS locks, never hides" (open item
   O0) never shipped** — `_showForSaleTab` still hides the tab, `_viewLocked()` covers only
   crate/wantlist, and no `CAN_VIEW_FORSALE()` exists. That behavior change lands here as T4.
   **File a GitHub issue for it before building** (house rule: every gap gets an issue; this one has
   none — #60 covers only the viewer-shape defects).
5. **#60 (public-out unreachable / owner-header leak) is folded into T2**, per its acceptance criteria
   (fix + four-mode truth table + `remediation-audit` on the wiring before merge).
6. **THE GOODS rename and the FILED UNDER tray are already live** — the draft's "rename check" in T4 is
   a no-op; skip it.
7. **Status feed shipped** (#59, v1.25.0) — the header plan's D3 "minimal provider" follow-up is
   overtaken; nothing to do.
8. **Crawlers don't run JS and the site is a static shell**, so per-crate `og:*` meta cannot come from
   `boot.js` — the draft's T7 asserts meta on "`/c/` HTML head" without a mechanism. The mechanism is a
   Pages Function serving the shell with meta injected (T7a), and `public/_routes.json`'s `include`
   must grow — `public/_redirects`' own comments document exactly this trap (functions outside
   `/api/*` silently disable `_redirects`; `_routes.json` is bare JSON, no comments — F17).
9. **`inventory_items` stores no condition** (deliberately — inventory is Restricted Marketplace Data;
   we store only the fact of a listing). The spec's `{year} · {condition}` GOODS footer is replaced by
   D-GOODSFOOT above.
10. **`profiles_guard()` (current body: 0034) pins only OAuth columns + import watermarks** — the two
    new user-owned columns (`public_slug`, `og_palette`) need **no guard change**; the existing
    `profiles_update_own` RLS covers client writes to them.

## 3. Stage cuts and ship order

| Stage | Tasks | Cut | What a user sees |
|---|---|---|---|
| **5b-S1** | T1 → T2 → T3 → T4 → T5 → T6 → T9 | **v1.29.0** | The whole public tier: PUBLIC on the SHARING ladder, slug editor, `/c/<slug>` renders for strangers. Ships dark — nothing is public until an owner flips a shelf. Links pasted into chat unfurl with the site-generic card only. |
| **5b-S2** | T7 (a: crawler HTML+meta, b: OG PNG) | **v1.30.0** | `/c/` links unfurl with the per-crate OG card in the owner's palette. |
| **5b-S3** | T8 (landing four-up + slab) | rides v1.30.0 | The landing page advertises public crates with the red OG card as the unfurl example. Ships in the same cut as S2 because the slab shows an OG card. |

Sequencing inside S1 is strict: T1 (data) before T2 (route reads it); T2 before T3–T6 (they render what
T2 installs); T9 last (it's what turns the tier on, and its slug editor needs T1's columns live).
Each stage gets `remediation-audit` before its release commit; the wave gets `cold-audit` after S3 per
house ritual.

**Version rule:** semver, next free minor at actual ship (roadmap §10). v1.29.0 / v1.30.0 assumed below;
if an interstitial ships first, slide the numbers, not the content.

---

## 4. T1 — Data: `'public'` on three ladders, the slug, the palette, and the anonymous read RPC

**File (new):** `supabase/migrations/0037_public_tier.sql`
**Applies via:** break-glass (DEPLOY.md ritual). Backward-compatible: the new enum value is inert until
T9's UI can select it; the new RPC has no callers until T2 ships.

Pre-flight (run via the read-only connector, expect the three current CHECKs to list exactly
`('private','friends')`):

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.profiles'::regclass and conname like '%visibility%';
```

Also confirm the `friendships` shape the RPC's relation check joins against (expect the two-row
symmetric form from 0012 — columns `user_id`, `friend_id`):

```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='friendships' order by ordinal_position;
```

If the columns differ from `user_id`/`friend_id`, fix the one `exists(...)` subquery in the function
below to match before applying — nothing else in the migration touches friendships.

The complete migration:

```sql
-- 0037_public_tier.sql — Wave 5b T1 (plan: docs/wave-5b-plan.md).
-- 1) 'public' joins the three visibility ladders (the CHECKs 0012/0018/0028 reserved for this).
-- 2) public_slug — the /c/<slug> identity (Discogs usernames are Restricted; the slug replaces them).
-- 3) og_palette — the owner's OG-card palette (D-PAL: white|red|black, default red).
-- 4) get_public_crate(p_slug) — THE ENTIRE anonymous read surface: one SECURITY DEFINER function,
--    no table policies for anon (mirrors the #42 projection-RPC posture). Unknown slug and
--    all-private slug both return NULL — indistinguishable by design (spec §6/§10).

-- ── 1. Visibility CHECKs ──────────────────────────────────────────────────────────────
alter table public.profiles drop constraint if exists profiles_crate_visibility_chk;
alter table public.profiles add constraint profiles_crate_visibility_chk
  check (crate_visibility in ('private','friends','public'));

alter table public.profiles drop constraint if exists profiles_wantlist_visibility_chk;
alter table public.profiles add constraint profiles_wantlist_visibility_chk
  check (wantlist_visibility in ('private','friends','public'));

alter table public.profiles drop constraint if exists profiles_forsale_visibility_chk;
alter table public.profiles add constraint profiles_forsale_visibility_chk
  check (forsale_visibility in ('private','friends','public'));

-- ── 2. Slug + palette (user-owned columns) ────────────────────────────────────────────
-- profiles_guard (0034 body) pins only OAuth columns + import watermarks, so the client updates
-- these under profiles_update_own RLS with no guard amendment. ≤18 chars, lowercase a-z 0-9 hyphen,
-- no leading/trailing hyphen (vanity URLs; the 18 cap is the OG footer one-line rule, header spec §7 O3).
alter table public.profiles add column if not exists public_slug text;
alter table public.profiles drop constraint if exists profiles_public_slug_chk;
alter table public.profiles add constraint profiles_public_slug_chk
  check (public_slug is null
         or public_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,16}[a-z0-9])?$');
create unique index if not exists profiles_public_slug_uq on public.profiles (public_slug);

alter table public.profiles add column if not exists og_palette text not null default 'red';
alter table public.profiles drop constraint if exists profiles_og_palette_chk;
alter table public.profiles add constraint profiles_og_palette_chk
  check (og_palette in ('white','red','black'));

-- ── 3. The anonymous read RPC ─────────────────────────────────────────────────────────
-- Shape notes:
--  · Projection matches get_friend_crate (0024) MINUS rating (owner ratings are not catalog data and
--    have no place in front of strangers), PLUS added + vinyl (TIMELINE, JUST IN, +N THIS MONTH,
--    colored-wax facets all need them). NEVER price fields (none exist in these tables), NEVER
--    discogs_username (Restricted) — except `handle`, returned ONLY to an authenticated FRIEND so the
--    client can redirect them to the richer /app/{handle} view (spec §1).
--  · forsale is E1-gated: public for-sale requires a public crate (for-sale renders ON crate cards).
--  · display_name is reduced server-side to "First L." (D-NAME) — the client never sees the full name.
--  · relation: 'stranger' | 'friend' | 'owner' — computed only when a JWT is present; anonymous
--    callers always read 'stranger'.
create or replace function public.get_public_crate(p_slug text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_sub  text := auth.jwt()->>'sub';
  v      record;
  pub_crate boolean; pub_want boolean; pub_fs boolean;
  v_rel  text := 'stranger';
  v_handle text := null;
  v_name text;
  j_crate jsonb := '[]'::jsonb; j_want jsonb := '[]'::jsonb; j_fs jsonb := '[]'::jsonb;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,16}[a-z0-9])?$' then
    return null;
  end if;

  select user_id, discogs_username, display_name, avatar_url, collecting_since,
         crate_visibility, wantlist_visibility, forsale_visibility, og_palette
    into v
    from public.profiles
   where public_slug = p_slug;
  if not found then return null; end if;

  pub_crate := v.crate_visibility    = 'public';
  pub_want  := v.wantlist_visibility = 'public';
  pub_fs    := v.forsale_visibility  = 'public' and pub_crate;   -- E1: for-sale rides under crate

  -- All-private ≡ unknown slug: byte-identical NULL (spec §6/§10 — a revoked slug must be
  -- indistinguishable from a wrong one).
  if not (pub_crate or pub_want) then return null; end if;

  -- Relation, for the client's redirect decisions (spec §1: owner → /app, friend → /app/{handle}).
  if v_sub is not null then
    if v_sub = v.user_id then
      v_rel := 'owner';
    elsif exists (select 1 from public.friendships f
                   where f.user_id = v_sub and f.friend_id = v.user_id) then
      v_rel := 'friend';
      v_handle := v.discogs_username;   -- the ONLY path a username leaves this function, friends only
    end if;
  end if;
  -- Owner/friend get the short answer — the client redirects; no records cross the wire.
  if v_rel <> 'stranger' then
    return jsonb_build_object('status','redirect','relation',v_rel,'handle',v_handle);
  end if;

  -- "First L." (D-NAME). Single-word names pass through; empty names get a neutral label.
  v_name := case
    when v.display_name is null or btrim(v.display_name) = '' then 'A Collector'
    when position(' ' in btrim(v.display_name)) = 0 then btrim(v.display_name)
    else split_part(btrim(v.display_name), ' ', 1) || ' ' ||
         upper(left(regexp_replace(btrim(v.display_name), '^.*\s', ''), 1)) || '.'
  end;

  if pub_crate then
    select coalesce(jsonb_agg(to_jsonb(t) - 'ord' order by t.ord), '[]'::jsonb) into j_crate
    from (
      select ci.id as ord, ci.release_id, ci.added, ci.vinyl,
             r.artist, r.title, r.year, r.label, r.styles, r.genres,
             r.thumb, r.cover_image, r.master_id
        from public.collection_items ci
        left join public.releases r on r.release_id = ci.release_id
       where ci.user_id = v.user_id
    ) t;
  end if;

  if pub_want then
    select coalesce(jsonb_agg(to_jsonb(t) - 'ord' order by t.ord), '[]'::jsonb) into j_want
    from (
      select wi.id as ord, wi.release_id, wi.added, wi.vinyl,
             r.artist, r.title, r.year, r.label, r.styles, r.genres,
             r.thumb, r.cover_image, r.master_id
        from public.wantlist_items wi
        left join public.releases r on r.release_id = wi.release_id
       where wi.user_id = v.user_id
    ) t;
  end if;

  if pub_fs then
    select coalesce(jsonb_agg(jsonb_build_object('release_id', ii.release_id,
                                                 'listing_id', ii.listing_id)
                              order by ii.id), '[]'::jsonb) into j_fs
    from public.inventory_items ii
    where ii.user_id = v.user_id and ii.status = 'for_sale';
  end if;

  return jsonb_build_object(
    'status','ok',
    'relation','stranger',
    'owner', jsonb_build_object(
      'display_name', v_name,
      'avatar_url', v.avatar_url,
      'collecting_since', v.collecting_since,
      'og_palette', v.og_palette),
    'sections', jsonb_build_object('crate', pub_crate, 'wantlist', pub_want, 'forsale', pub_fs),
    'crate', j_crate,
    'wantlist', j_want,
    'forsale', j_fs);
end;
$function$;

-- ── 4. The FRIEND tier must survive an owner going public (verification F1 — this was the
--       plan's worst near-miss). private.can_view_crate / can_view_wantlist / can_view_forsale
--       gate on `= 'friends'` STRICTLY, and every friend RPC (get_crate_owner, get_friend_crate,
--       get_friend_wantlist, get_friend_forsale) routes through them — so without this section,
--       the moment an owner sets a shelf to 'public' their FRIENDS lose /app/{handle} entirely
--       (status:'no_crate'), and the /c/ friend-redirect lands on a dead page. Public is a
--       SUPERSET of friends (C2): amend the predicates, change nothing else.
--
--       Implementation: dump each current body first —
--         select pg_get_functiondef(p.oid) from pg_proc p
--           join pg_namespace n on n.oid = p.pronamespace
--          where n.nspname = 'private' and p.proname like 'can_view%';
--       — then re-create each with ONLY these predicate changes (keep signature, language,
--       security, search_path, and every other clause byte-identical):
--         can_view_crate:    pr.crate_visibility    = 'friends'  →  pr.crate_visibility    in ('friends','public')
--         can_view_wantlist: pr.wantlist_visibility = 'friends'  →  pr.wantlist_visibility in ('friends','public')
--         can_view_forsale:  pr.crate_visibility    = 'friends'  →  pr.crate_visibility    in ('friends','public')
--                            pr.forsale_visibility  = 'friends'  →  pr.forsale_visibility  in ('friends','public')
--       (The friendship-row condition in each body is untouched: these functions still answer
--       for FRIEND viewers only; anonymous/stranger access remains get_public_crate's alone.)

-- ── 5. Grants — the whole new anon surface is this one function ──────────────────────
revoke all on function public.get_public_crate(text) from public;
grant execute on function public.get_public_crate(text) to anon, authenticated;
```

**Post-apply verification (read-only connector):**

```sql
-- CHECKs now carry 'public':
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.profiles'::regclass
   and conname in ('profiles_crate_visibility_chk','profiles_wantlist_visibility_chk',
                   'profiles_forsale_visibility_chk','profiles_public_slug_chk','profiles_og_palette_chk');
-- NULL for a nonsense slug:
select public.get_public_crate('no-such-slug');            -- → NULL
-- Set Lane's row public + slugged in the SAME break-glass window, then:
--   update public.profiles set public_slug='lanes-crate', crate_visibility='public'
--    where discogs_username='lanebecker';
select jsonb_typeof(public.get_public_crate('lanes-crate')->'crate');   -- → 'array'
select public.get_public_crate('lanes-crate')::text like '%lanebecker%';  -- → false (no username leaks)
select public.get_public_crate('lanes-crate')::text ~* 'price|rating';    -- → false
-- Then run the advisors (security + performance) and clear anything the migration introduced.
```

And the F1 regression probes — run as (or impersonating) a FRIEND of the now-public test account:

```sql
-- After crate_visibility='public': a friend still gets the friend tier, not 'no_crate'.
select public.get_crate_owner('lanebecker')->>'status';          -- → 'ok' (run under a friend JWT)
select jsonb_array_length(public.get_friend_crate('lanebecker')); -- → the crate count, not 0/error
```

(If no friend JWT is convenient in the SQL console, the same two checks run in the browser as Tommy
during S1 verification §13.3 — but do not skip them there.)

The `rating`-absence probe doubles as the projection check. Leave Lane's row public after verifying —
it is the S1 live test crate (he is user #1 and has said the tier is GO; revert to 'friends' instead
if S1 ships before he wants the link circulating).

---

## 5. T2 — The `/c/<slug>` route, the no-auth boot path, and the #60 viewer-shape fix

**Files:** `public/boot.js`, `public/app.js`, `public/_redirects` (NOT touched — see T7a: once
`/c/*` is Functions-routed, a `_redirects` rule for it would be inert; do not add one).

### T2a — app.js: fix #60 (do this first; everything below depends on the corrected shapes)

Anchor: the `IS_SIGNED_IN` / `VIEWER_MODE` definitions near the top of `public/app.js` (search for
`const IS_SIGNED_IN`), including the ⚠️ comment block above them (lines ~69–79 at plan time).
Replace the constant and DELETE the ⚠️ landmine comment (its warning becomes true history):

```js
// #60: signedIn is an EXPLICIT flag — a viewer object's mere presence stopped meaning "signed in"
// the day the anonymous /c/ viewer became a viewer object too. Installed by boot.js:
//   own crate            { isOwn:true,  signedIn:true }
//   friend crate         { isOwn:false, signedIn:true,  canView* }
//   /c/ signed-out       { isOwn:false, signedIn:false, isPublic:true, canView* }
//   /c/ signed-in        { isOwn:false, signedIn:true,  isPublic:true, canView* }
const IS_SIGNED_IN = () => !!(window.TraxWaxViewer && window.TraxWaxViewer.signedIn === true);
// Header spec §1: which of the four header modes we're in.
const VIEWER_MODE = () => IS_OWN() ? 'own'
  : (window.TraxWaxViewer && window.TraxWaxViewer.isPublic)
    ? (IS_SIGNED_IN() ? 'public-in' : 'public-out')
    : 'friend';
```

Then give the two EXISTING installers their explicit flag, in `public/boot.js`:

1. Friend installer — anchor `window.TraxWaxViewer = { isOwn: false, ownerUserId: owner.user_id`
   (~L332): add `signedIn: true,` immediately after `isOwn: false,`.
2. Own-crate installer — anchor `window.TraxWaxViewer = { isOwn: true, ownerUserId: null` (~L1402):
   add `signedIn: true,` immediately after `isOwn: true,`.
3. `ensureProfile`'s select list (boot.js ~L164, the fixed column string ending
   `…match_mode, forsale_visibility`): append `, public_slug, og_palette` (verification F4 — the T6
   owner-probe and T9's slug/palette editors read these off the profile object and would otherwise
   always see `undefined`).

**Truth-table re-verification (the #60 acceptance criterion) — run in the browser console on each
surface after T2c exists, and record the results in the PR:**

| Surface | Expected `VIEWER_MODE()` | Expected `IS_OWN()` / `IS_SIGNED_IN()` |
|---|---|---|
| `/app` signed in (owner) | `'own'` | `true` / `true` |
| `/app/<friend>` signed in | `'friend'` | `false` / `true` |
| `/c/<slug>` signed out | `'public-out'` | `false` / `false` |
| `/c/<slug>` signed in, non-friend | `'public-in'` | `false` / `true` |

Also confirm on `/c/` signed-out: no gear circle, no EST. cell, no "FILED BY", wordmark href `/`
(view-source + eyeball). `remediation-audit` runs on the whole T2 diff before merge — reviewer-driven
rework rule applies.

### T2b — boot.js: the public route, before Clerk

The public page must paint with **zero Clerk involvement** (spec B3) — Clerk loads afterward, only to
detect owner/friend/signed-in-stranger and upgrade or redirect.

Anchor: in `boot()` (bottom of `public/boot.js`), immediately after `initThemeEarly();` and BEFORE the
`twcode=` fragment-capture block, insert:

```js
  // Wave 5b: /c/<slug> — the public tier. A public crate renders for a signed-out visitor with no
  // Clerk load (B3); bootPublicCrate does its own deferred Clerk pass to upgrade/redirect. Everything
  // else (finalize codes, invite stash, full Clerk boot) is the signed-in app's business — return.
  const _pubm = window.location.pathname.replace(/\/+$/, '').match(/^\/c\/([a-z0-9-]{1,18})$/);
  if (_pubm) { await bootPublicCrate(_pubm[1]); return; }
```

New function, placed directly above `boot()`:

```js
/* Wave 5b: the public-crate boot path. One RPC (get_public_crate, anon-callable) returns owner
   identity ("First L." — derived server-side, D-NAME), per-section public flags, and the records for
   every public section. Unknown and all-private slugs are both NULL (spec §6/§10) → the 404 page.
   Providers mirror installFriendCrateProviders' shapes so app.js renders unchanged. */
async function bootPublicCrate(slug) {
  let payload = null;
  try {
    const { data, error } = await supabase.rpc('get_public_crate', { p_slug: slug });
    if (error) throw new Error('public crate query failed: ' + error.message);
    payload = data;
  } catch (err) { showError(err); return; }

  if (!payload) { renderPublicNotFound(false); _publicClerkPass(slug, null); return; }

  // A signed-in owner/friend never sees /c/ (spec §1) — but at this point Clerk hasn't loaded, so
  // relation can only be 'stranger' (anon JWT). The authenticated re-check happens in
  // _publicClerkPass; a 'redirect' status here is impossible on the first anon call.
  _installPublicCrate(slug, payload, false);
  await import('/app.js');
  window.TraxWaxBootCrate();
  _publicClerkPass(slug, payload);
}

function _installPublicCrate(slug, d, signedIn) {
  const rows = (arr) => (Array.isArray(arr) ? arr : []).map((it) => ({
    id: it.release_id,
    artist: it.artist || '', title: it.title || '', year: it.year || 0,
    label: it.label || '', styles: it.styles || [], genres: it.genres || [],
    vinyl: it.vinyl || '', thumb: it.thumb || '', cover_image: it.cover_image || '',
    added: it.added || '', rating: 0, master_id: it.master_id || null,
    price: null, crating: null, crcount: null, have: null, want: null,
  }));
  window.TraxWaxViewer = {
    isOwn: false, signedIn: signedIn === true, isPublic: true,
    canViewCrate: d.sections.crate === true,
    canViewWantlist: d.sections.wantlist === true,
    canViewForSale: d.sections.forsale === true,
  };
  window.TraxWaxOwner = {
    ownerLine: (d.owner.display_name || 'A Collector') + '’s shelf',
    lastSyncedAt: null,
    displayName: d.owner.display_name || '',
    avatarUrl: d.owner.avatar_url || '',
    ownerUsername: '',                       // NEVER a handle on a public surface (D-NAME / spec §10)
    collectingSince: d.owner.collecting_since || null,
    isOwn: false,
  };
  window.TraxWaxData         = async () => rows(d.crate);
  window.TraxWaxWantlistData = async () => rows(d.wantlist);
  window.TraxWaxFriendForSale = async () => {
    const m = new Map();
    for (const it of (Array.isArray(d.forsale) ? d.forsale : [])) m.set(it.release_id, it.listing_id);
    return m;
  };
  // The owner's public wantlist entries, for the "they want / you have" count in mode D — same
  // shape TraxWaxOwnerWantIds returns on the friend path ({id, master}), derived from the payload
  // (no second query). Wantlist not public → [] (unknown, not zero — matches the friend semantics).
  window.TraxWaxOwnerWantIds = async () =>
    (d.sections.wantlist === true ? (Array.isArray(d.wantlist) ? d.wantlist : []) : [])
      .map((it) => ({ id: it.release_id, master: it.master_id || null }));
  // No token → no live stats, ever, on a public surface (spec C4). Header EST. is IS_OWN-gated
  // anyway; this keeps any per-release path a silent no-op.
  window.TraxWaxStats = async () => ({});
}

/* The deferred Clerk pass: load Clerk quietly; if the visitor is signed in, re-run the RPC under
   their JWT — the server answers 'redirect' for the owner (→ /app) or a friend (→ /app/{handle},
   mode B), and full data for a signed-in stranger (mode D: signedIn flips true, the viewer's own
   match context installs, and the crate re-boots so the friend-shaped provider loads run). */
async function _publicClerkPass(slug, firstPayload) {
  try {
    await clerkReady();
    await window.Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      appearance: clerkAppearance(document.body.dataset.theme === 'dark'),
      signInUrl: '/app', signUpUrl: '/app?mode=signup',
      signInFallbackRedirectUrl: '/app', signUpFallbackRedirectUrl: '/app',
      afterSignOutUrl: '/',
    });
  } catch (e) { return; }   // Clerk down → the anonymous page stands; nothing to upgrade
  // House idiom (F3): signed-in state is `!!window.Clerk.user`, exactly as route()/boot() read it —
  // Clerk.isSignedIn is not used anywhere in this codebase; do not introduce it here.
  if (!window.Clerk.user) return;

  let d = null;
  try {
    const { data } = await supabase.rpc('get_public_crate', { p_slug: slug });
    d = data;
  } catch (e) { return; }
  if (!d) {
    // Signed in, slug resolves to nothing they may see. One special case (T6): the OWNER of a
    // now-dead slug gets the CLOSED variant — detect by probing their own profile.
    if (firstPayload === null) {
      try {
        const p = await ensureProfile(window.Clerk.user.id);
        if (p && p.public_slug === slug) { renderPublicNotFound('closed'); return; }
      } catch (e) { /* fall through to the standing 404 */ }
    }
    return;   // the 404 card is already up; strangers get nothing new
  }
  if (d.status === 'redirect') {
    if (d.relation === 'owner') { window.location.replace('/app'); return; }
    if (d.relation === 'friend') {
      if (d.handle) { window.location.replace('/app/' + encodeURIComponent(d.handle)); return; }
      // Friend of an owner with no discogs_username (no /app/{handle} exists — an unlinked account
      // can't have records anyway): fall through deliberately and render mode D, the only view
      // there is. Spec §1's friend→mode-B rule presumes a handle; this is its only exception.
    }
  }
  if (firstPayload === null) return;   // 404 page is up and they are a stranger; leave it

  // Mode D upgrade (F2): flip the flag, install the VIEWER's own match context + wantlist writes,
  // then RE-BOOT the crate — TraxWaxBootCrate's non-owner branch is what consumes
  // TraxWaxOwnerWantIds/TraxWaxFriendForSale and populates __twMatchCtx/__twInventory; a bare
  // re-render would leave every match count at zero. (T2e makes that branch tolerate the public
  // providers; verify bootCrate is re-entrant on this path — it re-reads providers and re-renders.)
  window.TraxWaxViewer.signedIn = true;
  installPublicViewerMatchCtx();
  window.TraxWaxBootCrate();
}
```

`renderPublicNotFound(variant)` is specified in T6; `installPublicViewerMatchCtx()` in T2c;
the bootCrate branch amendment in T2e.

### T2e — app.js: the non-owner boot branch must serve the public modes (verification F2)

As-built, `TraxWaxBootCrate`'s non-owner provider loads are gated
`if (!IS_OWN() && window.TraxWaxMatchCtx)` (~L2186), and only inside that branch do
`TraxWaxOwnerWantIds()` (~L2192) and `TraxWaxFriendForSale()` (~L2196) run. An anonymous public
viewer installs NO `TraxWaxMatchCtx`, so the boot falls to the else branch: `__twInventory` stays
null and **the public GOODS tab renders empty even when listings are public**. Amend the branch:

1. Gate on the viewer, not one provider: `if (!IS_OWN())`.
2. Inside, guard each provider for absence so all four viewer shapes pass through it:
   - `window.__twMatchCtx = window.TraxWaxMatchCtx ? await window.TraxWaxMatchCtx() : null;`
     (downstream badge/count code already handles a null ctx on the own-crate path — verify the
     non-own consumers of `__twMatchCtx` null-check, and add the checks where they don't);
   - `const _ow = window.TraxWaxOwnerWantIds ? await window.TraxWaxOwnerWantIds() : [];` feeding
     whatever local the branch feeds today;
   - the `TraxWaxFriendForSale()` call stays unconditional in this branch — every non-own installer
     (friend AND public) defines it.
3. Keep the else branch for the own-crate/baked path byte-identical.
4. Re-entrancy: `_publicClerkPass` calls `TraxWaxBootCrate()` a second time for the mode D upgrade.
   Read the function top-to-bottom before assuming: providers re-run, `RECORDS` reassigns, render()
   repaints — if any one-shot side effect exists (listeners, observers), guard it with a module
   flag rather than forbidding the re-boot.

### T2c — the viewer's own match context on `/c/` (mode D)

The friend installer builds `TraxWaxMatchCtx` (the VIEWER's own collection + wantlist id/master sets)
inline. Mode D needs the identical thing. **Extract, don't duplicate:** lift the existing
`window.TraxWaxMatchCtx = async () => { ... }` body out of `installFriendCrateProviders` into a
module-level function `function installViewerMatchCtx() { window.TraxWaxMatchCtx = async () => { ...
(the existing body, unchanged) ... }; }`, call `installViewerMatchCtx()` where the inline assignment
was, and add:

```js
/* Wave 5b mode D: a signed-in stranger on /c/ gets the same viewer-side match context a friend
   viewer gets — the owner-side data is already public. Also the viewer's own wantlist writes
   (+WANT works on a public crate exactly as on a friend's). */
function installPublicViewerMatchCtx() {
  installViewerMatchCtx();
  window.TraxWaxSetWant = async (releaseId, action) =>
    _pipeCall('wantlist-write', { release_id: releaseId, action });
}
```

The match RPCs question (header spec §7 O2) resolves to: **no new RPCs** — match counts are computed
client-side from the viewer's own sets (installViewerMatchCtx) against the owner's public arrays,
same as the friend path — **but the DB-side half of O2 is real and is T1 §4** (the `can_view_*`
predicate amendments; without them a friend's redirect target is dead). Mechanism, precisely
(verification F11 corrected the first draft's attribution): clause 2 ("N OF THEM ARE FOR SALE")
derives from `__twInventory`'s contents, which T2e populates from the public forsale array — a
non-public GOODS section yields an empty map, so the clause drops by count, not by flag; clause 3's
privacy text routes through `_matchCounts()` → `CAN_VIEW_WANTLIST()`, which reads
`viewer.canViewWantlist` — set by T2b from the public flags. Verify both in T2's truth-table pass
rather than assuming: set wantlist to friends-only on the test crate and confirm THEIR WANTLIST IS
PRIVATE renders; set forsale private and confirm clause 2 vanishes.

### T2d — deep-linked filters

5a's shareable filter URLs must pre-select on `/c/` (spec §2.3: `?g=…&wax=1` paints a pre-filtered
first load). `app.js` parses `FILTER_PARAM_KEYS` from `location.search` at boot independent of the
path — confirm by loading `/c/<slug>?g=Rock&wax=1` during T2 verification and seeing the chips set. If
the parse turns out to be gated on a route branch, move the parse call so it runs on the public path
too (one-line change at the `TraxWaxBootCrate` entry).

---

## 6. T3 — Public identity + stat tape + strip button fix

**File:** `public/app.js`.

1. **Identity** — no code: `identityHtml()`'s public branch (top-3 styles, 44-char shrink) is already
   built and mode-gated; `o.displayName` arrives server-reduced ("First L."). Verify against frame 1a
   that the meta line reads `{STYLE1}, {STYLE2}, {STYLE3} · SINCE {year}`.
2. **Stat tape** — anchor: the `.tw-headR` block (~L1326–1330). The public modes show
   `N IN CRATE · N COLORED · +N THIS MONTH` (spec §3.2; EST. never leaves the owner's view — its cell
   is already `IS_OWN()`-gated). Insert a COLORED cell between the count cell and the THIS MONTH cell:

```js
${(VIEWER_MODE()==='public-out'||VIEWER_MODE()==='public-in')?`<span style="padding:6px 10px; border-right:1.5px solid #16171a">${v.coloredCount.toLocaleString('en-US')} COLORED</span>`:''}
```

   (Splice it on the line after the EST. cell's ternary, before the `tw-hide-mobile` THIS MONTH span.)
3. **Mode C strip button** — anchor: the `else if(mode==='public-out')` branch of `stripHtml()`. The
   dormant code sends START YOUR OWN CRATE to `/`; a prospect who clicks it should land in the
   **sign-up** flow, not back on the landing brochure. Change that button's `href="/"` to
   `href="/app?mode=signup"`. SIGN IN stays `/app`. (Frame 1a's caption and header spec §2.2 name the
   button; neither pins its destination — this is the sensible one, flag in the PR description.)

---

## 7. T4 — Five tabs always, THE GOODS locks, the public GOODS card

**File:** `public/app.js`. This task closes the **new §3.3/O0 issue** (see §2 item 4 — file it first)
and is a behavior change for FRIEND viewers too, not just public ones: a friend who isn't shown
listings now sees a LOCKED GOODS tab instead of no tab.

1. **`CAN_VIEW_FORSALE`** — anchor: the `CAN_VIEW_WANTLIST` const (~L84). Add below it:

```js
const CAN_VIEW_FORSALE = () => IS_OWN() || !window.TraxWaxViewer || window.TraxWaxViewer.canViewForSale === true;
```

2. **`_viewLocked` covers forsale** — anchor ~L86, replace:

```js
const _viewLocked = (view) => (view === 'wantlist') ? !CAN_VIEW_WANTLIST()
  : (view === 'forsale') ? !CAN_VIEW_FORSALE()
  : !CAN_VIEW_CRATE();
```

3. **The tab row** — anchor: the `tw-tabsrow` template line (~L1347). Replace the two conditional tabs:

```js
${DB_MODE()?tab('wantlist','THE WANTLIST'):''}${DB_MODE()?tab('forsale','THE GOODS'):''}
```

   and delete the now-unused `const _showForSaleTab = …` line (~L1160). (`DB_MODE()` keeps the baked
   dev fixture at three tabs; every live crate shows five.) The own-crate GOODS tab with nothing
   listed already renders its empty state; a friend/public GOODS tab that is visible but empty does
   too (both existed before this change — re-verify both).
4. **`lockedSection` maps forsale** — anchor ~L1161, replace the ternary:

```js
const lockedSection = !IS_OWN() && _viewLocked(s.view)
  ? (s.view==='wantlist' ? 'wantlist' : s.view==='forsale' ? 'forsale' : 'crate') : null;  // #43 + §3.3
```

5. **`lockedPanelHtml('forsale')`** — anchor: `function lockedPanelHtml(section)` (~L606). Read the
   existing crate/wantlist branches and add the forsale branch in the same shape: eyebrow
   `THE GOODS · PRIVATE`, headline `{Name} isn't sharing what's for sale.` (header spec §3.3 exact
   copy), body/CTA mirroring the wantlist branch's structure. `aria-label` on the tab comes free from
   `tab()`.
6. **The public GOODS card** — anchor: `card()`'s footer block (the
   `<div style="display:flex; align-items:flex-start; justify-content:space-between; …border-top…">`
   near L497) and the JUST IN ribbon span above it.
   - **Ribbon:** on the forsale view for non-owner viewers, cards wear the black FOR SALE ribbon in
     the JUST IN geometry (spec §3: top-left, −2.5°). Add after the JUST IN span (same container):

```js
${(state.view==='forsale' && !IS_OWN())?`<span style="position:absolute; top:12px; left:0; background:#16171a; color:#fff; font-family:'Archivo',sans-serif; font-size:9px; font-weight:800; letter-spacing:.14em; padding:3px 7px; transform:rotate(-2.5deg)">FOR SALE</span>`:''}
```

     and suppress JUST IN on that view (`state.view!=='wantlist'` becomes
     `state.view!=='wantlist' && !(state.view==='forsale' && !IS_OWN())` — two ribbons would collide).
   - **Footer (D-GOODSFOOT, option C):** for non-owner forsale cards, the left cell keeps the year
     (standard footer type, style dropped) and the meta cell becomes the buy link:

```js
${(state.view==='forsale' && !IS_OWN())
  ? `<span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; line-height:1.35; color:var(--faint); text-transform:uppercase; white-space:nowrap; min-width:0">${esc(r.year)}</span><a href="${esc(forSaleHref(r.id)||'#')}" target="_blank" rel="noopener" style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; font-weight:700; letter-spacing:.04em; color:var(--accent); text-decoration:none; white-space:nowrap">BUY ON DISCOGS ↗</a>`
  : `<span style="font-family:'IBM Plex Mono',monospace; font-size:9.5px; line-height:1.35; color:var(--faint); text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0">${esc(r.year)}<span class="tw-card-style"> · ${esc(r.style1)}</span></span>${metaCellHtml(r)}`}
```

     Options A (link alone, `margin-left:auto`) and B (left cell `${esc(r.year)} · ${esc(r.style1)}`)
     from the rendered comparison remain one-line swaps of the left cell — nothing else moves.
   - The FOR SALE ↗ **badge** (`badgesFor`) stays for friend-crate non-forsale views; on the forsale
     view the ribbon + footer link make it redundant — suppress the badge there
     (`state.view!=='forsale'` guard on the `ctx.forSale` badge push, ~L718).
7. **Rail copy** (spec §3): on the forsale view for public viewers, the SHOWING rail's left cell gains
   the sentence `{First}'s listings, as filed here. Prices and condition notes live on Discogs — each
   card opens the listing.` — anchor the `tw-sortwrap` row; add the sentence as a `tw-hide-mobile`
   mono span before the `N of M shown` status span, gated `VIEWER_MODE().startsWith('public') &&
   state.view==='forsale'`. `{First}` = `window.TraxWaxOwner.displayName.split(' ')[0]`.
8. **`N OF 3 SHELVES SHARED`** (spec §2.4 — dropped by the first draft, verification F9a): on public
   modes the tab-row right rail (`tw-sortwrap`) gains a leading mono cell before `N of M shown`:
   `${n} OF 3 SHELVES SHARED`, where `n` counts the true flags among
   `viewer.canViewCrate/canViewWantlist/canViewForSale`. Same type as the shown-count span;
   `tw-hide-mobile` (the 390 rail is already tight). Public modes only — friends see today's rail.
9. **SHARE THIS VIEW un-gates for public viewers** (spec §2.4: "it's a link, not owner chrome" —
   verification F9a): the SHOWING rail's copyLink button is `IS_OWN()`-gated today (~L1362); change
   the gate to `(IS_OWN() || VIEWER_MODE().startsWith('public'))`. The copied URL is
   `location.origin + location.pathname + '?' + params` territory — verify `copyLink`'s handler
   builds from `location` (it does for the own crate) so a public viewer copies a `/c/<slug>?…`
   link, not an `/app` one. Friend crates keep today's owner-only gate (spec is scoped to public
   chrome; friends have the whole-crate share affordance question parked with CHECK-IN 2's batch).
10. **Empty public shelf copy** (spec §6, verification F9d): `emptyCrateHtml()`'s non-own wantlist
    branch speaks in the friend voice; public modes get the spec's third-person line — in the copy
    selection, when `VIEWER_MODE().startsWith('public')` and the view is wantlist, headline
    `Nothing on the wantlist. Yet.` (keep the friend branch as-is for mode B). Give the empty crate
    and empty GOODS the same third-person pass while in there: crate `Nothing filed. Yet.` / goods
    `Nothing for sale right now.` — copy check at CHECK-IN 3 alongside the 404 page.

---

## 8. T5 — The public ledger

**File:** `public/app.js`, `computeVals()` bigStats (~L804) and the `showStats` template (~L1216–1266).

1. **bigStats** — the non-owner branch is friend-shaped ('In common' from `_matchCounts()`). Public
   modes get the spec §4 set. Replace the non-owner IIFE with a mode branch:

```js
    bigStats: IS_OWN() ? (()=>{ /* existing own-crate array, unchanged */ })()
    : (VIEWER_MODE()==='friend') ? (()=>{ /* existing friend array, unchanged */ })()
    : (()=>{ const _styleCount=allStyles.length; const _pk=decadeStats&&decadeStats.peak; return [
      {label:'Records', value:all.length.toLocaleString('en-US'), note:'In their crate.', color:'var(--ink)'},
      {label:'On colored wax', value:coloredCount+'', note:Math.round((coloredCount/Math.max(1,all.length))*100)+'% of the shelf.', color:'var(--accent)'},
      {label:'Styles filed', value:_styleCount.toLocaleString('en-US'), note:'Across '+all.length.toLocaleString('en-US')+' records.', color:'var(--ink)'},
      {label:'Peak decade', value:_pk?_pk.decade+'s':'—', note:'By original release.', color:'var(--ink)'},
    ]; })(),
```

   (Copy the two existing arrays verbatim into their branches — do not re-derive them.)
2. **Panels + strips (§6b, scoped to public modes — CHECK-IN 2 covers the friend view):** in the
   `showStats` template, the three `IS_OWN()` gates change to include the public modes:
   - the TOP ARTIST · LABEL strip gate: `IS_OWN()` → `(IS_OWN() || VIEWER_MODE().startsWith('public'))`
   - the `min-height:170px` styles-list conditional follows the same predicate (it exists to align
     with the strip);
   - the right-panel ternary `IS_OWN() ? (()=>{ …decade panel… })() : overlapPanelHtml()` →
     `(IS_OWN() || VIEWER_MODE().startsWith('public')) ? (()=>{ …decade panel… })() : overlapPanelHtml()`
     (the decade panel body — with PEAK · SPAN strip — renders for public viewers; friends keep the
     overlap panel exactly as today).
   - The DNA band's `IS_OWN()` gate does NOT change (owner-only, §6b).
   All lifted content is catalog-aggregate and price-free — the EST./EXPENSIVE END figures live only
   in the own-crate bigStats array, which the mode branch above never returns to non-owners.

---

## 9. T6 — 404 / CLOSED page + mobile

**Files:** `public/boot.ui.js` (the page), `public/boot.js` (the caller), `public/styles.css` (mobile).

1. **`publicNotFoundHtml(variant)`** in `boot.ui.js` (export it; `variant` is `'notfound'` or
   `'closed'`). Structure per spec §6 / frame 1e — strip (empty left; SIGN IN + START YOUR OWN CRATE +
   nothing else on the right), red band (wordmark only, no identity, no tape), state-card-idiom body,
   footer attribution. Copy:
   - notfound: kicker `/C/ · NOT FOUND`, headline `No crate here.`, body `The link may be mistyped, or
     whoever shared it has closed the shelf. Crates open and close at their owner's whim — that's the
     point.`, buttons `START YOUR OWN CRATE` (→ `/app?mode=signup`, primary) and `SIGN IN` (→ `/app`).
   - closed (owner only): kicker `/C/ · CLOSED`, headline `This crate is private now.`, body `Only you
     can see this page. Your link stopped working the moment you went private — flip a shelf back to
     PUBLIC to reopen it.`, button `SHARING SETTINGS` (→ `/account/sharing`).
   Strangers NEVER see the closed variant (spec §6: 404 and private-now byte-identical for
   non-owners) — and the server already guarantees it: `get_public_crate` returns NULL for both, so
   the client can't tell either. Wiring (unified with T2b's code, verification F12):
   `renderPublicNotFound(variant)` in boot.js renders `publicNotFoundHtml(variant || 'notfound')`;
   `bootPublicCrate` calls it with no argument (the anonymous 404); `_publicClerkPass` calls
   `renderPublicNotFound('closed')` in exactly one case — the RPC returned NULL AND
   `ensureProfile(window.Clerk.user.id).public_slug === slug` (the owner looking at their own dead
   link; the probe works because T2a.3 added `public_slug` to ensureProfile's select). Signed-in
   state changes nothing else about the page — the 404's SIGN IN / START YOUR OWN chrome is
   harmless to a signed-in viewer and not worth a third variant.
2. **Mobile CSS** — `public/styles.css`, in/beside the existing `@media (max-width:640px)` block:

```css
/* Wave 5b: five tabs fit 390px — tighter pads (must beat tab()'s inline padding, hence !important,
   the same convention every rule in this block already uses — verification F5), and the THE-
   prefix drops (spec §5). */
@media (max-width:640px){
  .tw-tabsrow button{ padding:12px 12px !important; }
  .tw-tab-the{ display:none; }
}
```

   and in `tab()` (app.js): call sites are NOT changed (verification F9e — `aria-label` is built
   from the label argument, and `"GOODS (private)"` is a worse screen-reader name than
   `"THE GOODS (private)"`). Instead `tab()` splits the prefix internally: keep receiving
   `'THE CRATE'` etc.; build `aria-label`/`title` from the full label as today; render the visible
   text as `label.replace(/^THE /, '<span class="tw-tab-the">THE&nbsp;</span>')` (labels are static
   strings from our own call sites — safe to inline). Desktop keeps THE; ≤640 hides it; aria keeps
   the full name everywhere.

   Two more §5 items the header build never carried (verification F9b/F9c — they existed only in
   the spec, not in code):
   - **Mode C button label shortens to `START YOUR OWN` on mobile:** in `stripHtml()`'s public-out
     branch, render the button label as `START YOUR OWN<span class="tw-strip-crate">&nbsp;CRATE</span>`
     and add `.tw-strip-crate{ display:none; }` inside the ≤640 block (no `!important` needed — the
     span carries no inline display).
   - **Identity meta drops to top-2 styles on mobile:** in `identityHtml()`'s public branch, before
     the 44-char shrink loop, cap the list at 2 when `window.matchMedia('(max-width:640px)').matches`.
     Computed at render time; the crate re-renders on the interactions that matter, and a rotated
     phone showing three styles until the next repaint is accepted (note it in the code comment).

   The strip/band mobile stacking (spec §5) shipped with the header — verify at 390px, fix only if
   the utility row misses the 44px minimum.


---

## 10. T7 — The unfurl: crawler HTML (`/c/*`) + the OG card PNG (`/og/<slug>`)

**Files:** `functions/c/[slug].js` (new), `functions/og/[slug].js` (new), `public/_routes.json`,
`package.json` (new), `public/fonts-og/` (new static assets), `DEPLOY.md`.

### T7-pre — the routing + build-config ground rules (read before writing either function)

1. `public/_routes.json` becomes:

```json
{
  "version": 1,
  "include": ["/api/*", "/c/*", "/og/*"],
  "exclude": []
}
```

   Consequences the file's own comments warn about: `_redirects` does not apply to Functions-routed
   paths — so there is **no** `/c/` rule in `_redirects` (the function itself serves the shell), and
   any future function outside these three prefixes must repeat this dance.
2. **Do not add `/c` (bare, no slug) to anything** — a bare `/c` falls through Functions (no `[slug]`
   match) to static-land, misses every `_redirects` rule, and lands on the SPA fallback (the landing
   page). Acceptable; note it in the function header comment.
3. `package.json` (repo root, new) exists ONLY to carry the OG renderer's dependencies for Pages'
   function bundling:

```json
{
  "name": "traxwax",
  "private": true,
  "dependencies": {
    "workers-og": "0.0.25"
  }
}
```

   Pin exactly; run `npm install` locally once to produce `package-lock.json` and commit both.
   **Pages build config change (Lane action, dashboard):** Build command `npm install`, build output
   directory `public`. Test on a BRANCH first — push the branch, confirm the preview deployment
   builds, `/api/release/249504` still answers, and `/c/lanes-crate` serves HTML — before merging to
   main (build config applies project-wide, so the branch preview is the only safe rehearsal).
   Record the setting in DEPLOY.md next to the Browser Cache TTL note.
4. **Size pre-flight + fallback (D-OGINFRA, verification F10):** the Workers compressed-bundle cap
   is PLAN-DEPENDENT — 1MB on the free plan, larger on paid — and `workers-og` (satori +
   resvg-wasm) compresses to roughly 1.3MB, which does NOT fit free. **Before writing T7b, Lane
   checks the Cloudflare dashboard for this Pages project's plan** and we size accordingly; the
   branch-preview build (item 3) is the empirical test either way. If the bundle doesn't fit, STOP
   and fall back to plan B without renegotiating the wave: the OG card renders client-side in the
   OWNER's browser at share time (canvas, like the DNA card), uploads via a small storage-write
   Edge Function, and `/og/[slug].js` becomes a thin proxy to the stored PNG. That is a separate
   mini-plan; do not improvise it inline.

### T7a — `functions/c/[slug].js` — the shell with per-crate meta

Complete file:

```js
/* GET /c/:slug — serves the SPA shell with per-crate og:* meta injected, so unfurl crawlers
   (which run no JS) see the crate card. Humans get the same HTML; boot.js reads the path and
   renders the public crate (Wave 5b T2). NULL from get_public_crate (unknown slug, private crate —
   indistinguishable by design) → the shell with generic meta and a 404 status; boot.js paints the
   404 card. A bare /c (no slug) never reaches this file — it falls through to the SPA fallback. */

const SUPABASE_URL = 'https://sfipqknrbvamwwahwxnl.supabase.co';
// Publishable anon key — same value public/boot.js ships; safe by design (RLS + definer RPCs).
const SUPABASE_KEY = 'sb_publishable_RLxgLYBzZoh5YCkYJ3NJZw_8BLFMIWg';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function onRequestGet({ params, request, env }) {
  const slug = String(params.slug || '');
  // env.ASSETS.fetch is the documented Pages-Functions static-asset binding. NOTE (F17): it has no
  // precedent in this repo ([id].js only fetches upstream) — the branch preview is its first
  // exercise; if it misbehaves there, the fallback is fetch(new URL('/app/', request.url)) against
  // the deployment's own origin.
  const shellResp = await env.ASSETS.fetch(new URL('/app/', request.url));
  let html = await shellResp.text();

  if (!/^[a-z0-9](?:[a-z0-9-]{0,16}[a-z0-9])?$/.test(slug)) {
    return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  let d = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_crate`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_slug: slug }),
    });
    if (r.ok) d = await r.json();
  } catch (e) { /* meta degrades to generic; the page still boots client-side */ }

  if (!d || d.status !== 'ok') {
    return new Response(html, { status: d ? 200 : 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  const name = d.owner.display_name || 'A Collector';
  const crate = Array.isArray(d.crate) ? d.crate : [];
  const wantlist = Array.isArray(d.wantlist) ? d.wantlist : [];
  const crateIsPublic = d.sections.crate === true;
  const n = crateIsPublic ? crate.length : wantlist.length;
  const noun = crateIsPublic ? 'Crate' : 'Wantlist';
  // Top style by record count, crate first (matches identityHtml's meta line source).
  const styleCounts = {};
  for (const rec of (crateIsPublic ? crate : wantlist)) {
    for (const st of (rec.styles || [])) styleCounts[st] = (styleCounts[st] || 0) + 1;
  }
  const topStyle = Object.keys(styleCounts).sort((a, b) => styleCounts[b] - styleCounts[a])[0] || null;

  const title = `${name}'s ${noun} on TraxWax`;
  const desc = `${n.toLocaleString('en-US')} records${topStyle ? ` · mostly ${topStyle}` : ''}. Filed properly.`;
  // Cache-buster: the card re-renders when count/style/palette/slug move (T7b caches by URL).
  const v = [n, topStyle || '', d.owner.og_palette || 'red'].join('|');
  let vh = 0; for (let i = 0; i < v.length; i++) vh = (vh * 31 + v.charCodeAt(i)) >>> 0;
  const img = `https://traxwax.com/og/${slug}?v=${vh.toString(36)}`;

  const meta = [
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="https://traxwax.com/c/${esc(slug)}">`,
    `<meta property="og:image" content="${esc(img)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join('\n');

  // The shell ships its own <title>TraxWax</title> and meta description (verification F7) — a
  // SECOND title appended before </head> would lose to the first in every parser. Replace both
  // in place, then inject the og block.
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  html = html.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(desc)}">`);
  html = html.replace('</head>', meta + '\n</head>');
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8',
               'Cache-Control': 'public, max-age=300' },
  });
}
```

Build-time check: view-source of the served `/app/` shell — it carries `<title>TraxWax</title>` +
a meta description and NO og:* tags (verified at plan time); confirm both replacements landed in the
served `/c/` output (grep the curl body for the crate title and for exactly one `<title>`), and that
no og:* tag appears twice.

### T7b — `functions/og/[slug].js` — the card

Renders spec §7's geometry with `workers-og` (satori under the hood: JSX-less object trees or HTML
strings → SVG → PNG). Inputs per card: display name, noun, count, top-3 styles, six most-recent cover
thumbs, slug, palette. The complete data flow and the non-negotiables:

```js
/* GET /og/:slug — the 1200×630 unfurl card (spec §7). Server-rendered per crate, cached 1h at the
   edge; the ?v= buster from T7a rolls it when count/styles/palette change. NULL crate → 404 PNG-less
   response (crawlers fall back to no image; never render a card for a private crate). */
import { ImageResponse } from 'workers-og';

const SUPABASE_URL = 'https://sfipqknrbvamwwahwxnl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_RLxgLYBzZoh5YCkYJ3NJZw_8BLFMIWg';

const PALETTES = {
  white: { ground:'#ffffff', type:'#16171a', dim:'#54585f', noun:'#e8194b', count:'#e8194b',
           rule:'#16171a', mark:'#16171a', markBorder:null, well:'#e4e6e9' },
  red:   { ground:'#e8194b', type:'#ffffff', dim:'rgba(255,255,255,.82)', noun:'#16171a', count:'#ffffff',
           rule:'#16171a', mark:'#16171a', markBorder:null, well:'#c4143f' },
  black: { ground:'#0e0f11', type:'#f0efed', dim:'#b4b7bd', noun:'#e8194b', count:'#e8194b',
           rule:'#f0efed', mark:'#16171a', markBorder:'#3a3d44', well:'#212329' },
};
```

Implementation requirements (each is a spec §7 line — the geometry is LOCKED, copy it, don't taste it):

1. **Canvas** 1200×630, padding 56/64/48; column layout: row (text column + 340px covers column),
   then full-width footer.
2. **Wordmark** Anton 48 white on `mark`, padding 13/16/11, `rotate(-1.2deg)` about left-center
   (black palette adds the 2px `markBorder`).
3. **Kicker** `A CRATE ON TRAXWAX` / `A WANTLIST ON TRAXWAX` — Plex Mono 22, tracking .16em, `dim`,
   margin-top 22.
4. **Headline** Anton 92/.92 uppercase `{NAME}'S` + noun in the palette's `noun` color; wraps at most
   once (name line / noun line); never shrinks, never a surname.
5. **Stats block** exactly per spec §7: 2-col grid `auto minmax(0,1fr)`, col-gap 40, row-gap 4,
   align-items end, margin-top auto, margin-bottom 26. Labels `RECORDS` / `TOP STYLES` (or `WANTED`)
   Plex Mono 20 .14em `dim`. Big variant: count Barlow Condensed 700 at 190px/.86/−.015em `count`
   color, margin-left −5; three style lines Barlow Condensed 700 50px/1.12 `type`. Compact variant
   (count 120px/.88/−.01em, ml −3, mb −13; styles 34px/1.12 with relative top 12px) **whenever the
   headline wraps to two lines OR any style name exceeds 15 chars**. Ellipsis is never acceptable.
6. **Covers**: 340px column, 2×3 grid, gap 16 (24 when exactly 2 covers), padding 6,
   `translate(6px,-8px) rotate(1.5deg) scale(.89)`, square tiles, 5px `rule`-colored frame,
   `0 1px 3px rgba(0,0,0,.35)` shadow, on the `well`. Six most-recent by `added` desc from the public
   crate (or wantlist when crate isn't public). Fetch each thumb with a 3s timeout; a failed fetch
   drops that tile (spec's few-covers degradation covers it). Convert to data URIs for satori.
7. **Footer**: full width, border-top 3px `rule`, margin-top 14, padding-top 12; left
   `traxwax.com/c/{slug}` Plex Mono 20 bold `type`; right `Data provided by Discogs · not affiliated
   with Discogs` Plex Mono 20 `dim`. The slug CHECK (≤18) is what keeps this one line — assert
   nothing, the constraint upstream owns it.
8. **Fonts**: commit TTF subsets to `public/fonts-og/` — `Anton-Regular.ttf`,
   `BarlowCondensed-Bold.ttf`, `IBMPlexMono-Regular.ttf`, `IBMPlexMono-Bold.ttf` (Google Fonts
   downloads, `pyftsubset` to Latin basic; record each file's source URL + subset command in
   `public/fonts-og/README.md`). The function loads them via `env.ASSETS.fetch(new URL('/fonts-og/…',
   request.url))` and passes ArrayBuffers to workers-og — nothing font-shaped in the JS bundle.
9. **Caching — explicit, not header-wished (verification F6):** a `Cache-Control` header alone does
   NOT edge-cache a Pages Function response — the repo's own `functions/api/release/[id].js` uses
   `caches.default` match/put for exactly this reason. Mirror that idiom: on entry
   `caches.default.match(request)` → return the hit; on render `ctx.waitUntil(caches.default.put(request,
   resp.clone()))`. Headers: `Content-Type: image/png`, `Cache-Control: public, max-age=300`.
   NULL/invalid slug → `404`, empty body, `Cache-Control: public, max-age=300`, NOT written to
   `caches.default`. **The 300s TTL is a privacy decision, not a perf one** (verification F16, kit
   draft's "bust on visibility change" carried forward): after an owner flips public→private, the
   last PNG remains servable from caches for at most ~5 minutes — accepted and documented here; the
   `?v=` buster (T7a) handles content drift, the short TTL handles revocation. Do not raise the TTL
   without re-arguing the revocation window.
10. **Palette** comes from the RPC payload (`owner.og_palette`), never from a query param — a shared
    link must not be able to force someone else's card off-palette.

**T7 verification (all against the branch preview URL before main):**

```
curl -sI https://<preview>.pages.dev/c/lanes-crate | head -3        # 200, text/html
curl -s  https://<preview>.pages.dev/c/lanes-crate | grep -c 'og:'  # ≥6
curl -s  https://<preview>.pages.dev/c/zzz-no-slug | head -1        # (shell HTML; -I shows 404)
curl -so /tmp/og.png https://<preview>.pages.dev/og/lanes-crate && file /tmp/og.png
#   → PNG image data, 1200 x 630
curl -s https://<preview>.pages.dev/c/lanes-crate | grep -ci 'price\|lanebecker'   # 0
```

Then the compact-variant fixture: temporarily point the renderer at a fixture payload with styles
`['Experimental Electronic','Post-Punk','Nu Gaze']` + a wrapping name and eyeball /og output against
`assets/og-card-degradations-2x.png`. Validate one card per palette against
`assets/og-card-{white,red,black}-1200x630.png` (geometry identical, colors per table).

---

## 11. T8 — Landing: the four-up + the slab (rides S2's cut)

**Files:** `public/index.html`, `public/styles.css`, plus one asset copy.

1. **Asset:** copy `Design/traxwax-wave5b-design/assets/og-card-red-1200x630.png` into
   `public/screenshots/og-card-red-1200x630.png` (it's the slab's example unfurl — sample-data card:
   Indie Rock / Nu Gaze / Math Rock; `public/screenshots/` is the web-served home, repo-root
   `screenshots/` is dev-only).
2. **Four-up** — `public/index.html` ~L106: the `.tw-land-three` strip gains a fourth cell after FILE
   BY REGRET, same markup shape as its siblings:

```html
      <div>
        <span class="tw-land-kick">FILE BY FRIEND</span>
        <p class="tw-land-lede">Show your work</p>
        <p class="tw-land-note">Share a link to make your crate public.</p>
      </div>
```

   `public/styles.css` ~L273: `.tw-land-three { grid-template-columns: repeat(4, 1fr); }`.
   **A ≤900px block for `.tw-land-three` ALREADY EXISTS at ~L347–353** (verification F8): it
   collapses to one column with `border-right:0; border-bottom:1.5px solid var(--faint)` per cell.
   Do not add a competing block — EDIT that one in place: at ≤900 go `repeat(2, 1fr)` with
   `border-right` kept on odd cells (`.tw-land-three > div:nth-child(odd)` keeps it, `nth-child(even)`
   zeroes it) and the existing border-bottom only on the first row's cells
   (`:nth-child(-n+2)`); add `@media (max-width:640px)` inside the same region taking it to the
   shipped single-column treatment (the current L347–353 body, verbatim). Eyeball all three widths
   at S3's pass — the 2×2 divider logic is exactly the kind of thing that looks right in CSS and
   wrong on screen.
3. **Slab** — `public/index.html` ~L145: replace the "No marketplace." slab content per spec §8:
   kicker `PUBLIC CRATES`; headline Barlow 700 44/1.08 `Your records, for all the world to see
   <span class="tw-slab-paren">(but only if you want them to.)</span>`; subline (Archivo 14/1.6,
   max-width 44ch) `You control who can see your collection — just you, just you and your friends, or
   anyone who has the link. Decide when you sign up, change your mind anytime.`; button
   `OPEN YOUR CRATE` → `/app?mode=signup`. Right column: the chat-bubble group — bubble copy
   `you have got to check out this amazing record shelf 👇` above the red OG card at 560px wide,
   whole group `rotate(1.2deg)`, no caption box. New CSS classes (`.tw-slab-paren` muted/600, the
   bubble, the card shadow) go in `styles.css` beside the existing `.tw-land-slab-*` rules; reuse the
   existing slab tokens — the slab stays hard-ink in both themes like the strip.
4. **Verify:** landing at 1280 + 390 (four-up→2×2, slab stacks); the "No marketplace" position
   statement it replaces is preserved in git history — Lane signs off on the swap at S3's eyeball
   pass (the copy is spec-locked, the sign-off is for the render).

---

## 12. T9 — SHARING: the three-way ladders, the slug editor, the palette row

**Files:** `public/boot.ui.js` (the section markup), `public/boot.js` (the wiring). Anchors:
`function visSegBtn` (~L501) and `function sharingSection(o)` (~L513) in boot.ui.js; the account
handlers around `renderAccount` in boot.js (search `tw-vis-crate-seg` / `onSetVis` /
`from('profiles').update` — the visibility save path that exists today).

1. **`visSegBtn` learns PUBLIC** — public is the weighty segment: accent-filled when on, accent-inked
   when off (spec §9). Replace the style ternary:

```js
function visSegBtn(group, v, label, cur) {
  const on = cur === v;
  const sty = (v === 'public')
    ? (on ? 'background:var(--accent); color:#fff' : 'background:var(--panel); color:var(--accent)')
    : (on ? 'background:var(--ink); color:var(--panel)' : 'background:var(--panel); color:var(--muted)');
  return '<button id="tw-vis-' + group + '-' + v + '" data-vis="' + v + '" aria-pressed="' + on +
    '" style="' + MONO + '; font-size:10.5px; letter-spacing:.06em; padding:8px 12px; border:0; ' +
    'cursor:pointer; ' + sty + '">' + label + '</button>';
}
```

2. **Three segments per row** — in `sharingSection`, each of the three rows appends
   `+ visSegBtn(group, 'public', 'PUBLIC', vis)` after its FRIENDS segment.
3. **The E1 ladder for for-sale** — today the for-sale row unlocks when `crateVis === 'friends'`.
   Public changes the gate to a ladder: the row unlocks when `crateVis !== 'private'`, and its PUBLIC
   segment renders only when `crateVis === 'public'` (for-sale can never out-expose the crate it
   renders on). Locked-row helper copy gains the second rung: when crate is `friends` and the user
   taps the (absent) for-sale PUBLIC, nothing exists to tap — add a sub-note under the segment when
   `crateVis==='friends'`: `Make your crate public to offer THE GOODS publicly.` (mono 9.5 faint,
   same slot as the existing locked reason).
4. **Server already enforces E1** (T1's `pub_fs := … and pub_crate`) — the UI rule is a mirror, not
   the boundary.
5. **PUBLIC LINK box** — renders once ANY of the three is `'public'`, directly under the VISIBILITY
   box, in the section-label idiom:
   - `sectionLabel('PUBLIC LINK')`, then a 1.5px-line box: mono prefix `traxwax.com/c/` + slug
     `<input id="tw-slug-input" maxlength="18" pattern="[a-z0-9-]{1,18}" spellcheck="false">`
     (disabled until EDIT) + `EDIT` + `COPY LINK` buttons in the account button idiom; helper line
     `Lowercase letters, numbers, hyphens. 18 characters max.`; the same `tw-share-msg` status line
     announces saves/errors.
   - **First flip to public with no slug** generates the default: `slugify(display_name)` —
     lowercase, spaces→`-`, strip non `[a-z0-9-]`, collapse+trim hyphens, cap 18, trim a trailing
     hyphen. Empty result (all-symbol name) → `crate-` + 6 random base36 chars. Write it with the
     visibility update so the link box never renders empty.
   - **Save path:** `supabase.from('profiles').update({ public_slug: value }).eq('user_id', uid)` —
     RLS-own covers it; the DB CHECK + unique index are the real validators. Postgres error `23505`
     (unique) → status line `That link is taken — try another.`; CHECK violation → the helper line
     text. On success re-render the section (the C6 #83 focus-restore pattern already in
     renderAccount handles re-entry).
   - **COPY LINK** copies `https://traxwax.com/c/<slug>` via the same clipboard call `copyCrateLink`
     uses in app.js (navigator.clipboard with the fallback) — lift that helper into boot.ui.js if
     it isn't importable; do not write a third clipboard path.
6. **OG palette row (CHECK-IN 1 — mock first, wire after Lane's yes).** Proposed: inside the PUBLIC
   LINK box, under the slug row, `sectionLabel`-less row `THE CARD` (mono caption) + three 44×23
   swatch buttons (mini three-color chips of each palette's ground/type/accent), `aria-pressed` on
   the active one, saving `og_palette` by the same update path. Copy under it:
   `The card your link shows when it unfurls.`
7. **Sharing-tab intro copy** — the section's description line predates public:
   `Your shelves are private by default. Open them to the friends you've added — including what
   you've listed for sale. Prices always live on Discogs, never here.` gains one sentence:
   `PUBLIC opens a shelf to anyone with your link — no account needed.`
8. **The first-run sharing question** (Wave 1's onboarding card) is NOT touched: new users still
   choose private/friends; public stays a deliberate account-page act (consent posture: public is
   never a default or a nudge).
9. **Wire-up** — `wireVisSeg` and the `tw-vis-*-seg` ids live in **boot.ui.js** (~L877 / ~L549), and
   the boot.js handler is `onSetVisibility` (verification F14 corrected the first draft's anchors).
   `wireVisSeg` does NOT extend transparently: its success path hardcodes a two-state restyle
   (`isOn ? 'var(--ink)' : 'var(--panel)'`) and a binary status message ("Friends can now see…" /
   "…private again."). Rework both for three states: restyle by re-calling the `visSegBtn` style
   logic (extract the style ternary from T9.1 into a helper both use, so PUBLIC keeps its accent
   treatment on the rows that don't re-render), and the status copy becomes per-value:
   private → `Your {shelf} is private again.`, friends → `Friends can now see your {shelf}.`,
   public → `Anyone with your link can now see your {shelf}.` New handlers: EDIT (toggle disabled +
   focus), slug save on Enter/blur-while-editing, COPY LINK, palette click. All go through the one
   `tw-share-msg` status line, `aria-live` already set.

---

## 13. Wave verification (S1 gate, before the v1.29.0 cut)

The kit's six checks, upgraded to the as-built plan — run every one against the pages.dev preview
AND production after deploy; paste outputs into the release PR:

1. Anonymous `/c/lanes-crate` → mode C chrome (strip sentence, SIGN IN + START YOUR OWN CRATE,
   lights; no gear, no share circle) — and view-source (post-JS DOM dump via devtools "Copy
   outerHTML") contains no `EST.`, no `FILED BY`, no `lanebecker`, no `price` value.
2. Same URL signed in as a non-friend → mode D strip (match sentence, numeric counts, links fire the
   match filters); ← BACK TO YOUR CRATE → `/app`.
3. Same URL signed in as a FRIEND of Lane → lands on `/app/lanebecker` (mode B). Signed in as Lane →
   lands on `/app`.
4. Visibility matrix: crate=public + wantlist=friends + forsale=private → anon sees CRATE/TIMELINE/
   LEDGER live, WANTLIST + THE GOODS locked (glyph, clickable → locked panels). Wantlist=public,
   crate=private → wantlist-only page; crate tabs locked; identity meta styles compute from the
   wantlist.
5. `curl -s https://traxwax.com/c/<bad-slug>` and a slug whose owner just went all-private return
   byte-identical bodies (diff the responses; both 404 after T7a, both the same shell before it).
6. 390px viewport: five tabs fit without horizontal scroll (THE dropped), strip utility row ≥44px
   tap-height, band stacks per header spec §5.
7. The #60 truth table (T2a) recorded in the PR.
8. Ledger: public view shows Records / On colored wax / Styles filed / Peak decade + both panels +
   both strips; no ESTIMATED VALUE, no EXPENSIVE END, no DNA band, no overlap panel. Friend ledger
   unchanged from v1.28.1 (screenshot diff).
9. SHARING: ladder round-trip private→friends→public→private per shelf; slug collision path (set the
   same slug on a second test account → 'taken' message); slug regex rejections; COPY LINK contents;
   palette save.
10. `remediation-audit` on each stage's diff; `verification-pass` already run on this plan;
    `cold-audit` after S3.

Deploy runbook (S1): arm break-glass → apply 0037 → post-apply SQL checks (T1) → advisors (security +
performance, both clean or explained) → disarm → frontend PR (T2–T6, T9) → preview checks → merge →
tag v1.29.0 → CHANGELOG + DEPLOY.md. S2 adds the Pages build-config change (T7-pre 3, branch
rehearsal first) before its merge. Every git step per the `git-workflow` skill; issues: #60 closes
with S1, the new §3.3 issue closes with S1, S2/S3 get issues only if defects surface (features track
in the plan + CHANGELOG per house convention).

## 14. Out of scope (named so nobody helpfully adds them)

- TraxWax Wrapped (roadmap: its own December cut).
- Public-crate discovery/browse, "most-owned," comments — Wave 6.
- Any price/marketplace surface for anonymous viewers — terms-barred, forever-shaped.
- Slug redirects/history (an owner who changes slugs breaks old links; acceptable, documented in the
  SHARING helper copy if it ever confuses — not built now).
- Friend-ledger §6b upgrade (CHECK-IN 2's outcome decides if it becomes its own small issue).

---

## Audit record — verification-pass, 2026-09-10 (plan rev 2 → rev 3)

Independent no-context agent, target = this document, before any issue or code. **REVISE-FIRST: 17
findings, all folded above** (rev 3 is the folded state). The severe ones, for the record:

- **F1 (CRITICAL): the migration would have broken the FRIEND tier for any owner going public** —
  `private.can_view_*` test `= 'friends'` strictly and every friend RPC routes through them; rev 2
  never touched them. Now T1 §4 + the F1 regression probes. (Header spec §7 O2 had warned exactly
  this; rev 2 answered O2's client half and missed its DB half.)
- **F2 (MAJOR): the public providers didn't drive app.js** — bootCrate's non-owner branch is gated on
  `TraxWaxMatchCtx`, so mode C got an empty GOODS tab and the mode D upgrade was a no-op (rerender
  without provider loads). Now T2e + `TraxWaxOwnerWantIds` in the installer + re-boot on upgrade.
- **F3: `Clerk.isSignedIn` has no precedent in this codebase** and fails closed if absent → house
  idiom `!!window.Clerk.user`. **F4:** `ensureProfile` didn't select `public_slug`/`og_palette` —
  T6's probe and T9's editors read undefined. **F5:** mobile tab padding lost to inline styles
  (`!important` per house convention). **F6:** Pages Functions don't edge-cache by header —
  `caches.default` per the repo's own [id].js. **F7:** duplicate `<title>` (first one wins) —
  replace, don't append. **F8:** a competing ≤900px `.tw-land-three` block already exists — edit in
  place. **F9 (understatements):** four locked-spec items rev 2 silently dropped — `N OF 3 SHELVES
  SHARED`, mobile `START YOUR OWN`, mobile top-2 identity meta, third-person empty-shelf copy — plus
  the aria-label degradation in the THE-prefix trick. **F10:** the "3MB bundle cap" was an unverified
  premise (free tier is 1MB) → dashboard pre-flight. **F11–F17:** mechanism misattributions
  (match clauses, wireVisSeg anchors/behavior, ASSETS precedent, `_routes.json` "comments"), the
  friend-null-handle fallthrough, and the OG revocation window (now an explicit 300s TTL decision).

Verified correct by the same pass (do not re-verify): the slug regex live-tested in Postgres
(1–18, no edge hyphens, `(?:…)` accepted); every §2 reconciliation claim not amended above
(constraint names/definitions, migrations through 0036, profiles_guard 0034 body, `_showForSaleTab`,
presence-based `IS_SIGNED_IN`, no `CAN_VIEW_FORSALE`, shell meta state, `_routes.json` content,
`inventory_items` shape); the T1 RPC's schema dependencies (wantlist_items.vinyl/added,
collection_items.added/vinyl, releases' nine columns, friendships user_id/friend_id two-row
symmetric, one-direction `exists()` sufficient); E1 + all-private-before-relation ordering (friend
of an all-private slug leaks nothing); every code anchor cited in T2–T9 (±2 lines); the T7b palette
table cell-for-cell against spec §7; `workers-og@0.0.25` exists on npm; the kit-draft diff (nothing
else dropped).
