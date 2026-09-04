# Wave 4 — STAGE 1 — Foundation + own-crate selling — plan

Status: DRAFT for verification-pass + Lane review. **Needs break-glass** (migration `0027` + `import-collection`
redeploy). Design source of record: `Design/traxwax-wave4-design/wave-4/SPEC.md` (decisions A, B, C, F, G, I;
E and D are Stage 2). Lane's confirmed calls: **E = separate gated switch** (Stage 2), **F2 = the ledger gets
the bare "N LISTED FOR SALE" stat**. Target **v1.16.0**. Base: current committed tree.

## Scope of Stage 1 (own data only — NO consent surface, NO friend for-sale, NO compound)
- **Backend:** a new `inventory_items` table (hardened like `collection_items`), a per-kind `import-collection`
  extension that imports the caller's Discogs **inventory** (status = For Sale) alongside collection/wantlist,
  and the two purge RPCs amended to delete inventory on disconnect/account-deletion.
- **Frontend (own crate only):** the FOR SALE cover badge (decision B/C), the modal `LIST FOR SALE ↗` /
  `EDIT LISTING ↗` action (A), the `FOR SALE n` facet (F1), the ledger `N LISTED FOR SALE` stat (F2), the
  DISCOGS-tab inventory sync row (G), and the "link-not-price" affordances (I).

Stage 2 (deferred): `forsale_visibility` consent + `can_view_forsale` gate + friend-crate for-sale badges +
the compound "selling N you want" (D) + edge states involving friends (H3). Stage 1 ships standalone.

## The load-bearing constraint (unchanged)
No price is ever stored or shown. `inventory_items` has NO price column. Every for-sale surface links out to
the Discogs listing (`/sell/item/{listing_id}`), where the price lives.

---

## Task 1 — migration `supabase/migrations/0027_inventory.sql` (break-glass)

Create with EXACTLY this content:
```sql
-- 0027_inventory.sql — Wave 4 Stage 1. The caller's Discogs for-sale inventory, terms-clean (NO price).
-- Mirrors the HARDENED collection_items posture from the start (0006): RLS on, own-SELECT only, DML revoked,
-- service-role-write only (the import writes it). A friend-read policy + forsale_visibility consent arrive in
-- Stage 2 — this migration is own-data only.

create table if not exists public.inventory_items (
  id          bigint generated always as identity primary key,
  user_id     text   not null,
  release_id  bigint not null references public.releases(release_id),
  listing_id  bigint not null,
  status      text   not null default 'for_sale',
  updated_at  timestamptz not null default now(),
  unique (user_id, listing_id)
);
create index if not exists inventory_items_user_idx on public.inventory_items (user_id);

-- updated_at stamped on every write (same trigger fn collection_items/wantlist_items use), so the import's
-- final-page stale sweep (delete … where updated_at < watermark) works identically for inventory.
drop trigger if exists inventory_items_touch on public.inventory_items;
create trigger inventory_items_touch before insert or update on public.inventory_items
  for each row execute function public.touch_updated_at();

alter table public.inventory_items enable row level security;

-- SELECT: own rows only, initplan form (matches every other *_own policy since 0025).
create policy inventory_select_own on public.inventory_items
  for select using (((select auth.jwt()) ->> 'sub') = user_id);

-- Hardened writes: client cannot write; only the service-role import pipeline does (it bypasses RLS).
grant select on public.inventory_items to anon, authenticated;
revoke insert, update, delete on public.inventory_items from anon, authenticated;

-- Per-kind import watermark (like import_started_collection/_wantlist, 0022) so the inventory sweep is
-- steered by the persisted page-1 DB clock, never a client echo.
alter table public.profiles add column if not exists import_started_inventory timestamptz;

-- Purge inventory on disconnect + account deletion (right-to-erasure; ownership data dies with the link).
create or replace function public.unlink_discogs_account(p_user_id text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not exists (select 1 from public.profiles where user_id = p_user_id) then
    return jsonb_build_object('status', 'no_profile');
  end if;
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.wantlist_items        where user_id = p_user_id;   -- Wave 2 Stage A
  delete from public.inventory_items       where user_id = p_user_id;   -- Wave 4 Stage 1
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  update public.profiles
     set discogs_username     = null,
         discogs_connected_at = null,
         last_import_at       = null,
         import_status        = 'idle'
   where user_id = p_user_id;
  return jsonb_build_object('status', 'ok');
end;
$function$;

create or replace function public.delete_account(p_user_id text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_existed boolean;
begin
  v_existed := exists (select 1 from public.profiles where user_id = p_user_id);
  delete from public.friendships           where user_id = p_user_id or friend_id = p_user_id;
  delete from public.friend_invites        where inviter_id = p_user_id;
  update public.friend_invites set accepted_by = null where accepted_by = p_user_id;   -- #40
  delete from public.collection_items      where user_id = p_user_id;
  delete from public.wantlist_items        where user_id = p_user_id;
  delete from public.inventory_items       where user_id = p_user_id;   -- Wave 4 Stage 1
  delete from public.discogs_credentials   where user_id = p_user_id;
  delete from public.discogs_oauth_state   where user_id = p_user_id;
  delete from public.discogs_pending_links where user_id = p_user_id;
  delete from public.profiles              where user_id = p_user_id;
  return jsonb_build_object('status','ok','existed', v_existed);
end;
$function$;
```
Apply via break-glass (`apply_migration`, name `inventory`).

### Post-apply verification (read-only connector)
- `inventory_items` exists; `\d`: columns as above, `unique(user_id,listing_id)`, FK to releases, RLS enabled.
- `pg_policies`: exactly `inventory_select_own` (SELECT, own, initplan form). `aclexplode` on relacl: anon +
  authenticated hold **SELECT only** (no I/U/D). Trigger `inventory_items_touch` present.
- `profiles.import_started_inventory` exists (timestamptz, nullable).
- `pg_get_functiondef` of both RPCs contains `delete from public.inventory_items`.
- `get_advisors security`: no new lint (inventory_select_own is own-scoped, not a 0029 definer RPC).

---

## Task 2 — `import-collection` gains an `inventory` kind (break-glass deploy)

The function already branches per `kind` via a `KIND` object (collection | wantlist). FOUR edits: **widen the
`kind` gate to admit `'inventory'`** (without this the feature is inert — see 2a), **kind-gate the page URL**
(status filter + valid sort — see 2b), add the `inventory` KIND branch, and generalize the seed so each kind
supplies its own seed-row mapper (inventory's catalog data comes from `listing.release`).

### 2a — widen the `kind` gate (CRITICAL; without this every inventory request silently imports the collection)
`kind` is derived BEFORE the KIND object and today only admits two values. FIND (`index.ts:89`):
```js
  const kind = body.kind === 'wantlist' ? 'wantlist' : 'collection';
```
REPLACE:
```js
  const kind = body.kind === 'wantlist' ? 'wantlist' : body.kind === 'inventory' ? 'inventory' : 'collection';
```
Every `kind === 'inventory'` test below is dead until this lands.

### 2b — kind-gate the page URL (CRITICAL: status filter + a valid inventory sort)
The shared page-URL builder appends its own query string, so the KIND path must stay bare (a `?` in the path
collides with this `?` → Discogs parses `status` as `"For Sale?page=1"`, loses pagination). Also `sort=added` is
NOT a valid inventory sort (valid: listed/price/item/artist/label/catno/audio/status/location) — inventory sorts
by `listed`. FIND (`index.ts:200-201`):
```js
  const pageUrl = `${KIND.path(prof.discogs_username)}` +
    `?page=${page}&per_page=100&sort=added&sort_order=desc`;
```
REPLACE:
```js
  const sortParam   = kind === 'inventory' ? 'listed' : 'added';
  const statusParam = kind === 'inventory' ? '&status=For+Sale' : '';
  const pageUrl = `${KIND.path(prof.discogs_username)}` +
    `?page=${page}&per_page=100&sort=${sortParam}&sort_order=desc${statusParam}`;
```
(The "desc-by-added → page-1-stable" comment at 196-199 reasons about the collection sort; for inventory the
sort is `listed` desc, which is likewise append-stable within a sync — no code change, just don't be misled.)

### 2c — add `seedRow` to the two existing KIND branches (behavior-preserving refactor)
The seed loop currently builds the seed object inline from `bi` (basic_information). Move that exact object into
a `seedRow(r)` on each KIND so the loop can call `KIND.seedRow(r)` uniformly. FIND the collection KIND object
and the wantlist KIND object (the `? { … } : { … }` for `kind === 'wantlist'`) and add to EACH a `seedRow`:
```js
        // collection AND wantlist: seed from basic_information (identical to today's inline seed).
        seedRow: (r) => {
          const bi = (r.basic_information ?? {}) as Record<string, unknown>;
          return {
            release_id: Number(r.id ?? (bi as any).id),
            artist: (((bi as any).artists ?? []) as Array<{ name?: string }>).map((a) => cleanName(a.name ?? '')).filter(Boolean).join(', '),
            title: String((bi as any).title ?? '').trim(),
            year: (bi as any).year ?? 0,
            label: ((bi as any).labels?.[0]?.name) ?? '',
            styles: (bi as any).styles ?? [],
            genres: (bi as any).genres ?? [],
            thumb: (bi as any).thumb ?? '',
            cover_image: (bi as any).cover_image ?? '',
            master_id: (bi as any).master_id || null,   // #28
          };
        },
```
(This is the SAME object the current seed loop builds — just relocated. Add the identical `seedRow` to both the
wantlist branch and the collection branch, since today's seed is shared/identical for both.)

### 2d — add the `inventory` KIND branch
The `KIND` selector is currently `kind === 'wantlist' ? {…} : {…}` (collection default). Change it to a
three-way: `kind === 'wantlist' ? {…} : kind === 'inventory' ? {…INVENTORY…} : {…collection…}`. The inventory
branch (path is BARE — 2b appends the query + `&status=For+Sale`; verifier confirmed the live inventory
`release` object carries split `artist`/`title`, a 600px `images[]`, and `thumbnail`):
```js
    : kind === 'inventory'
    ? {
        // Only ACTIVE listings (2b appends &status=For+Sale) → every imported row is live; the final-page
        // sweep drops anything delisted since the last sync. Catalog data comes from listing.release;
        // seed_releases empty-guards, and enrich fills deep fields for owned/wanted rows.
        path: (u: string) => `https://api.discogs.com/users/${encodeURIComponent(u)}/inventory`,
        listKey: 'listings',
        table: 'inventory_items',
        conflict: 'user_id,listing_id',
        wmCol: 'import_started_inventory',
        needsInstanceId: false,
        mapItem: (r: Record<string, unknown>, releaseId: number): Record<string, unknown> => ({
          user_id: userId,
          release_id: releaseId,
          listing_id: Number(r.id),
          status: 'for_sale',
        }),
        seedRow: (r: Record<string, unknown>) => {
          const rel = (r.release ?? {}) as Record<string, unknown>;
          const imgs = (rel.images ?? []) as Array<{ uri?: string }>;
          return {
            release_id: Number(rel.id),
            artist: String((rel.artist as string) ?? ''),
            title: String((rel.title as string) ?? '').trim(),
            year: (rel.year as number) ?? 0,
            label: '',
            styles: [],
            genres: [],
            thumb: String((rel.thumbnail as string) ?? ''),
            cover_image: imgs[0]?.uri ?? '',   // inventory release DOES carry 600px images; keep the cover
            master_id: null,                    // (label/styles/genres left to enrich — empty-guarded)
          };
        },
      }
```
Note the inventory `releaseId` derivation differs: the release id is `r.release.id`, not `r.id` (which is the
LISTING id). So the row-loop's `releaseId` computation must use the right source per kind — see 2e.

### 2e — the row loop: derive releaseId per kind + call KIND.seedRow
FIND the loop that computes `releaseId` and builds the seed inline (the `for (const r of entries)` block).
REPLACE its releaseId line + seed line so:
- `releaseId` = for inventory, `Number((r.release as any)?.id)`; else `Number(r.id ?? bi.id)` (current).
- the hard-error guard also requires a valid `listing_id` for inventory (`Number.isInteger(Number(r.id))`).
- the seed is `seeds.set(releaseId, KIND.seedRow(r))` (replacing the inline `bi`-based object).
Concretely, REPLACE:
```js
    const bi = (r.basic_information ?? {}) as Bi;
    const releaseId = Number(r.id ?? bi.id);
    const instanceId = Number(r.instance_id);
    if (!Number.isInteger(releaseId) || (KIND.needsInstanceId && !Number.isInteger(instanceId))) {
```
WITH:
```js
    const bi = (r.basic_information ?? {}) as Bi;
    const releaseId = kind === 'inventory'
      ? Number((r.release as Record<string, unknown> | undefined)?.id)
      : Number(r.id ?? bi.id);
    const instanceId = Number(r.instance_id);
    const listingOk = kind !== 'inventory' || Number.isInteger(Number(r.id));   // inventory needs a listing id
    if (!Number.isInteger(releaseId) || !listingOk || (KIND.needsInstanceId && !Number.isInteger(instanceId))) {
```
And REPLACE the inline seed object:
```js
    if (!seeds.has(releaseId)) {
      seeds.set(releaseId, {
        release_id: releaseId,
        artist: (bi.artists ?? []).map((a) => cleanName(a.name ?? '')).filter(Boolean).join(', '),
        title: (bi.title ?? '').trim(),
        year: bi.year ?? 0,
        label: bi.labels?.[0]?.name ?? '',
        styles: bi.styles ?? [],
        genres: bi.genres ?? [],
        thumb: bi.thumb ?? '',
        cover_image: bi.cover_image ?? '',
        master_id: bi.master_id || null,   // #28: Discogs sends 0 for no-master → || null keeps it exact-only
        // tracks/country/released/videos deliberately absent: seeds have tracks = null,
        // which is exactly what enrich-release keys on.
      });
    }
```
WITH:
```js
    if (!seeds.has(releaseId)) {
      seeds.set(releaseId, KIND.seedRow(r));   // per-kind: basic_information (coll/want) or listing.release (inventory)
    }
```
Deploy `import-collection` via break-glass (bundle `functions/_shared/discogs.ts`; `verify_jwt` stays false).
`supabase/config.toml` needs NO change (verify_jwt already false for this function).

### Post-deploy verification
- 401 gate: forged-token POST → `{"error":"invalid_token"}` (booted + JWKS runs).
- After Lane re-syncs once (Task 4's driver), read-only: `select count(*) from inventory_items where
  user_id = '<Lane sub>';` returns his live For-Sale count; every row's `release_id` exists in `releases`.

---

## Task 3 — `public/boot.js`: drive the inventory import + expose own for-sale data

### 3a — add `inventory` to the import driver
FIND where `runImport` / the boot pipeline drives the collection then the background wantlist sync (the
`kind: 'wantlist'` background call + the `tw_wantlist_due` flag). Add a THIRD background pass for inventory,
mirroring the wantlist one exactly (same page loop, `kind: 'inventory'`, same adaptive pacing). It runs after
collection like wantlist does; a failure logs and does not strand `import_status` (only the collection pass
owns that gate — same rule as wantlist). [Executor: mirror the wantlist background-sync block verbatim,
substituting `kind:'inventory'`; if wantlist uses a `tw_wantlist_due` sessionStorage handoff, add a parallel
`tw_inventory_due` set at the same point and consumed in the same place.]

### 3b — own inventory provider
In `installCrateProviders(profile)` (the own-crate providers), add:
```js
  // Wave 4 Stage 1: the caller's OWN for-sale listings — release_id → listing_id (own-select RLS).
  window.TraxWaxInventory = async () => {
    const map = new Map();   // release_id → listing_id
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('inventory_items')
        .select('release_id, listing_id').eq('user_id', profile.user_id)
        .order('id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error('inventory query failed: ' + error.message);
      for (const it of data ?? []) map.set(it.release_id, it.listing_id);
      if (!data || data.length < 1000) break;
    }
    return map;   // Map<release_id, listing_id>
  };
```
(No friend inventory provider in Stage 1.)

### 3c — load inventory into the crate render context (own crate only) — **this edit is in `app.js`, NOT boot.js**
`bootCrate` lives in **`app.js`** (exported ~`app.js:1552`); the awaited-at-boot block for `__twMatchCtx`/
`__twOwnerWants` sits in the FRIEND branch (`if (!IS_OWN() && …)`, ~`app.js:1501-1508`) — the OPPOSITE branch
from where inventory loads. Do NOT copy it into that branch. Instead: near `app.js:1501`, unconditionally reset
`window.__twInventory = null;`, then add a NEW own-crate branch:
```js
  if (IS_OWN() && window.TraxWaxInventory) {
    try { window.__twInventory = await window.TraxWaxInventory(); }
    catch (e) { window.__twInventory = new Map(); }   // never strand the render on an inventory hiccup
  }
```
This Map drives the FOR SALE badge, the facet, the ledger count, and the modal's listed-state. Friend crate:
`__twInventory` stays `null` (Stage 2 adds the friend path).

### 3d — expose the inventory count for the DISCOGS sync row + ledger
Where `renderAccount` builds the `o` for `accountPageHtml` (the DISCOGS tab reads `recordCount`/`lastSyncedLabel`),
add an `inventoryCount`: `select count(*) head:true` on `inventory_items` for the user (mirror the existing
`collection_items` count query in `renderAccount`). Pass it into `accountPageHtml({ …, inventoryCount })`.

---

## Task 4 — `public/app.js`: badge, modal action, facet, ledger stat

### 4a — feed `ctx.forSale` for the OWN crate
`badgesFor(rec, ctx)` already emits `{ kind:'else', label:'FOR SALE' }` when `ctx.forSale?.has(rec.id)`, and
returns `[]` when `ctx` is falsy (`app.js:613,620`). On the own crate `window.__twMatchCtx` is null (match ctx
is friend-only), so pass a minimal ctx built from inventory. At the badge-computation site
(`_badges = badgesFor(rec, window.__twMatchCtx || null)`, ~`app.js:415`) use:
```js
  const _ctx = window.__twMatchCtx || (window.__twInventory ? { forSale: window.__twInventory } : null);
  const _badges = badgesFor(rec, _ctx);
```
(`window.__twInventory` is a `Map`, whose `.has(id)` is exactly what `badgesFor` calls — no Set needed. On a
friend crate `__twInventory` is null → `_ctx` falls back to the match ctx, unchanged from today.) The badge's
href needs the listing_id: `forSaleHref(id)` reads `window.__twInventory.get(id)` (see 4b). [Executor: verify
`badgesFor`'s `else` push is the ONLY use of `ctx.forSale`, so passing a Map as `forSale` is safe.]

### 4b — the FOR SALE badge becomes a link (decisions B/I)
Today `badgesHtml` renders every badge as a `<span>`. The FOR SALE (`else`/`you-outline`-adjacent) badge must
render as an `<a target="_blank" rel="noopener">` to `/sell/item/{listing_id}`, with `↗` in the label,
`e.stopPropagation()` so it doesn't open the modal, and the hover-invert. Change `badgesHtml` so the `else`
kind (only) renders an anchor (pass the record `title` for the aria-label — decision I):
```js
function badgesHtml(badges, title){
  if (!badges || !badges.length) return '';
  return badges.slice(0, 2).map((b, i) => {
    const cls = 'tw-badge ' + (BADGE_CLASS[b.kind] || BADGE_CLASS.you) + ' tw-badge-' + (i + 1);
    if (b.kind === 'else' && b.href) {   // FOR SALE — a real outbound link, not a state label
      return '<a href="' + esc(b.href) + '" target="_blank" rel="noopener" ' +
        'aria-label="' + esc((title || '') + ' — for sale on Discogs') + '" ' +
        'class="' + cls + '" style="text-decoration:none">' + esc(b.label) + '</a>';
    }
    return '<span class="' + cls + '">' + esc(b.label) + '</span>';
  }).join('');
}
```
Update the ONE caller (`app.js:416`, `${badgesHtml(_badges)}`) to pass the record title: `badgesHtml(_badges, rec.title)`.
- `badgesFor`'s forSale push becomes `{ kind:'else', label:'FOR SALE ↗', href: forSaleHref(rec.id) }` where
  `forSaleHref(id)` = `https://www.discogs.com/sell/item/{listing_id}` from `window.__twInventory` (own) /
  the friend for-sale map (Stage 2). (Current push is `{ kind:'else', label:'FOR SALE' }` at `app.js:620` —
  add `↗` + the `href`.)
- **No stopPropagation gymnastics needed** (verifier corrected the earlier plan): badges render as a SIBLING of
  the `<button data-act="open">`, and the delegated click handler does `const t = e.target.closest('[data-act]');
  if (!t) return;` (`app.js:1353`) — a click on the badge anchor has no `[data-act]` ancestor, so the handler
  already early-returns and the modal does NOT open. The anchor's own `target="_blank"` navigation just works.
  Do not add a `data-noopen` guard; it solves a non-problem.
- **hover:** add to `styles.css` `.tw-badge-else:hover{ background:var(--ink); color:var(--panel); }` (the one
  interactive badge; decision I).

### 4c — modal `LIST FOR SALE ↗` / `EDIT LISTING ↗` (decision A)
In `modalHtml`'s action row (currently `wantControlHtml` + VIEW ON DISCOGS + LISTEN), add — **own crate only**
(`IS_OWN()`), as the second action after VIEW ON DISCOGS — an ink-fill secondary anchor:
```js
${IS_OWN() ? (() => {
  const lid = window.__twInventory && window.__twInventory.get(rec.id);
  const href = lid ? ('https://www.discogs.com/sell/item/' + lid)
                   : ('https://www.discogs.com/sell/post/' + rec.id);
  const label = lid ? 'EDIT LISTING ↗' : 'LIST FOR SALE ↗';
  return '<a href="' + href + '" target="_blank" rel="noopener" style="font-family:\'IBM Plex Mono\',monospace; ' +
    'font-size:11px; font-weight:700; letter-spacing:.1em; padding:10px 15px; text-align:center; ' +
    'background:var(--ink); color:var(--panel); border:1.5px solid var(--line); box-shadow:2px 2px 0 var(--shadow)">' +
    label + '</a>';
})() : ''}
```
Placed between the VIEW ON DISCOGS anchor and LISTEN, inside the existing `margin-top:auto` action stack.

**Also (SPEC A3 — do not drop):** when the open record is one of the caller's own listings
(`IS_OWN() && window.__twInventory?.has(rec.id)`), the modal HEADER carries the FOR SALE badge too. In the
modal header render, append a `<span class="tw-badge tw-badge-else" ...>FOR SALE</span>` (a plain span here —
the header is already inside the modal, so no outbound link needed) next to the title/artist block, gated on the
same own-listing condition. [Executor: find the modal-header title block in `modalHtml`; add the span there.]

### 4d — the `FOR SALE n` facet (F1)
In the filter bar (`FILED UNDER … genreChips … COLORED WAX`), add a `FOR SALE {n}` chip set off by a hairline
divider, only when for-sale data exists (`window.__twInventory && __twInventory.size` on own; Stage 2 adds
friend). The chip mirrors the existing `COLORED WAX` facet EXACTLY — and `coloredOnly` is the reference for
every wiring point, so mirror all four:
1. **state:** add `forSaleOnly: false` to the `state` object (`app.js:217-221`, beside `coloredOnly`).
2. **predicate:** in `matches(r)`, `if (state.forSaleOnly && !(window.__twInventory && window.__twInventory.has(r.id))) return false;`
   — query the `Map` DIRECTLY (O(1) per record; do NOT build a Set inside `matches`, which runs ~1,861×/filter).
3. **the chip:** same styling as `COLORED WAX` (accent when on), `data-act="forSale"` toggles `state.forSaleOnly`
   + re-render; count `n` = `window.__twInventory.size`; precede it with a hairline divider
   (`<span style="width:1px; height:20px; background:var(--hair)">`).
4. **clear + removable chip (verifier caught the omission):** reset `state.forSaleOnly=false` in `clearAll`
   (beside the `coloredOnly` reset, `app.js:1391`); add a FOR SALE entry to the active-chip list `v.active`
   (mirroring `coloredOnly`, ~`app.js:649`); and clear it in the `'rm'` chip handler (~`app.js:1413`). Without
   these, CLEAR ALL leaves a stuck FOR SALE filter with no removable chip — inconsistent with COLORED WAX.
5. **the `data-act="forSale"` case:** add it to the click delegation switch beside `case 'colored'`.

Composes AND with genre/color/search.

### 4e — the ledger stat (F2)
This edit touches **TWO locations** (verifier): the `bigStats` OWN array in `computeVals` (`app.js:674-678`) AND
the literal grid template `repeat(4,1fr)` in the render (`app.js:757`). The OWN branch shows 4 stats; add a 5th
**only when `window.__twInventory && window.__twInventory.size > 0`** (hidden at 0, per F2):
`{ label:'Listed for sale', value: window.__twInventory.size.toLocaleString('en-US'), note:'Managed on Discogs.', color:'var(--ink)' }`.
When that 5th cell is present, change the grid template to `repeat(5,1fr)`; else keep `repeat(4,1fr)`. The
≤640px media query forces `repeat(2,1fr) !important` (`styles.css:96`), so mobile is unaffected — but verify at
≤640px anyway. Below the stat grid, add a `MANAGE ON DISCOGS ↗` link (→ `https://www.discogs.com/sell/manage`)
near the for-sale stat. Keep all four existing cells — do NOT drop one.

---

## Task 5 — `public/boot.ui.js`: DISCOGS-tab inventory sync row (G)
In `discogsSection`, the connection box shows `statCell('RECORDS', …)` + `statCell('LAST SYNCED', …)`. Add a
third stat cell after LAST SYNCED (only when connected): `statCell('LISTED', o.inventoryCount == null ? '—' :
Number(o.inventoryCount).toLocaleString())`. (Same one pipeline re-syncs all three; no separate re-sync
control — G1.) Copy label "LISTED".

---

## Post-build verification
- `node --check public/boot.js && node --check public/app.js && node --check public/boot.ui.js` → OK.
- Edge: 401 gate on import-collection; a re-sync populates `inventory_items` (SQL count matches Discogs).
- Live (own crate): a listed record shows the `FOR SALE ↗` badge (slot 2, panel+rule); clicking it opens the
  Discogs listing in a new tab and does NOT open the detail modal; the modal shows `EDIT LISTING ↗` for listed
  records and `LIST FOR SALE ↗` for un-listed; the `FOR SALE n` facet filters to your listings; the ledger
  shows `N LISTED FOR SALE` (hidden at 0) + MANAGE link; the DISCOGS tab shows the LISTED count; dark theme OK.
- A friend crate shows NO for-sale anything (Stage 2), and no console errors.

## Audit plan
remediation-audit Pass-1 (break this): inventory RLS is own-select-only + writes revoked (no client write);
the import seedRow refactor is byte-identical for collection/wantlist (diff the produced seed object); inventory
releaseId comes from `release.id` not the listing id (a swap would FK-violate or mislabel); the FOR SALE anchor
`stopPropagation`/`data-noopen` actually prevents the modal opening; badge cap still ≤2 with FOR SALE in slot 2;
the facet composes AND correctly; the ledger stat hides at 0 and the grid doesn't break; purge RPCs delete
inventory (probe unlink/delete in a rolled-back txn); no price anywhere; own-only (no friend leak — friend
crate has `__twInventory=null`). Narrow Pass-2 over rework. Converge.

---

## Verification-pass ledger (independent no-context agent, before Lane review)
Two CRITICALs would have shipped the feature completely inert; both fixed in-plan:
- **[FIXED — Task 2a] CRITICAL:** `kind` is coerced to collection/wantlist at `index.ts:89` before the KIND
  object, so `kind:'inventory'` requests silently re-imported the collection. Widened the gate.
- **[FIXED — Task 2b] CRITICAL:** the inventory `path` carried `?status=For+Sale`, colliding with the shared
  page-URL's own `?…` (double `?` → lost pagination + broken filter). Path is now bare; status + a valid
  `sort=listed` are appended kind-gated in the page-URL builder.
- **[FIXED — Task 2b] MAJOR:** `sort=added` is invalid for the inventory endpoint → `sort=listed`.
- **[FIXED — Task 3c] MAJOR:** `bootCrate` is in **app.js**, and the mirrored `__twOwnerWants` block is in the
  FRIEND branch — inventory must load in a NEW own-crate branch. Relabeled + branch corrected.
- **[FIXED — Task 4c] MAJOR:** SPEC A3 (modal-HEADER FOR SALE badge) was dropped. Added.
- **[FIXED — Task 4d] MAJOR:** `state.forSaleOnly` wasn't wired into `clearAll` / `v.active` / the `'rm'`
  handler → a stuck, unclearable filter. All four `coloredOnly` wiring points now mirrored.
- **[FIXED — Task 4b] MINOR:** the `data-noopen`/stopPropagation guard solved a non-problem (badge is a sibling
  of `[data-act="open"]`; the delegated handler already early-returns via `closest('[data-act]')`). Dropped;
  rationale corrected.
- **[FIXED — Task 2d] MINOR:** inventory `release` is NOT "lighter" — it carries 600px `images[]` + split
  artist/title. Now seeds `cover_image` from `rel.images[0].uri` and keeps artist/title.
- **[FIXED — Task 4a/4d] MINOR:** `_forSaleSet()` in the `matches()` hot path was O(n²) → query the `Map`
  directly, O(1)/record.
- **[FIXED — Task 4b] MINOR:** SPEC I `aria-label` was missing from the badge anchor. Added.
- **[FLAG FOR LANE — Task 5] MINOR:** SPEC G1's literal form is a status ROW ("Inventory · last synced … · N
  listed"). The shipped `discogsSection` has no per-kind "last synced" rows, only stat cells, so the plan adds a
  third `statCell('LISTED', …)` instead — a defensible adaptation to the real UI, but a deviation Lane should
  okay. (No per-inventory "last synced"; the single LAST SYNCED cell already covers the shared re-sync.)

**Verified CORRECT by the agent:** `touch_updated_at` exists (0004, hardened 0006) + is used by
collection/wantlist (so the sweep dependency holds); 0027 is the right next number; the RLS/grants + initplan
form + watermark column all mirror the real patterns; both purge-RPC bodies faithfully match the live
definitions (0017/0020) + `create or replace` keeps the service_role grants; **both Task 2e FIND blocks match
the current file char-for-char**; `badgesFor` already has the real `else`/`forSale` hook + `BADGE_CLASS.else`
exists; the Discogs inventory shape is confirmed against the live API (listings[], listing.id, listing.status,
release.id/year/thumbnail/**artist**/**title**/**images**); `installCrateProviders(profile)`, `renderAccount`'s
count query + `accountPageHtml(o)` thread, `statCell`/`discogsSection`, and the 4-cell bigStats + `repeat(4,1fr)`
+ mobile `repeat(2,1fr)` are all as the plan assumes; scope split (E, D → Stage 2; A/B/C-own/F/G/I → Stage 1)
is correct with nothing silently pulled forward.
```
