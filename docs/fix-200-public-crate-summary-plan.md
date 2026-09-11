# Fix #200 — the public-crate summary RPC (migration 0043)

**Closes:** #200 (live availability defect, CF 1102) and #158 (T3.8c, its cold-audit twin).
**Target version:** v1.31.1 (patch — a backend fix + two Pages Functions; no user-visible feature).
**Needs break-glass:** yes — one migration apply, no schema change to any table.
**Author bar:** written for a no-context executor/cold-auditor. Every path, every line of code, every
command, and its expected output is here. Do not improvise.

---

## 1. The defect (measured, from #200)

`public.get_public_crate('lanes-crate')` returns **1,465,392 bytes (1.40 MB)** — 1,876 crate rows.
`functions/c/[slug].js` and `functions/og/[slug].js` both call that RPC **on every anonymous
request, before their cache lookup**, then:

1. `await r.json()` — parse 1.4 MB, and
2. loop every row's `styles` to derive a top style,

…all to produce a card that needs a **count, three style names, six cover URLs, and a palette** —
about 2 KB of information. That fixed per-request CPU sits at Cloudflare's Workers ceiling, so
~1 request in 10 trips **HTTP 503 `error code: 1102`** ("Worker exceeded CPU time limit"). At a 10%
failure rate, ~1 in 10 shared links unfurls no card and ~1 in 10 public-crate visits gets a
Cloudflare error page — on the flagship Wave 5b sharing feature. Measured over 20 sequential
requests each: `/og/lanes-crate` 18/20, `/c/lanes-crate` 18/20, `/` (no RPC) 5/5.

## 2. The fix — a projection, not a second gate

Add `public.get_public_crate_summary(text)` that reproduces `get_public_crate`'s gating **byte for
byte** (slug validation → profile lookup → visibility booleans → relation-first redirect →
all-private gate → display-name derivation), but on the `'ok'` path returns only the hot path's
needs — `count`, `top_styles` (3), `covers` (≤6 URLs) — **computed in Postgres**. `/c/` and `/og/`
call the summary. `get_public_crate` is **unchanged**; `boot.js`'s three browser calls (the full
crate render, where 1.4 MB is fine and there is no CPU cap) keep using it.

### Why this is safe against the one real risk

The danger in this change is a *second, drifting access-control implementation*. Two defenses:

1. The summary's gating **logic** is copied from `get_public_crate` statement-for-statement (Task 1
   marks it "keep in lockstep"). The executable statements are identical; only the `declare` block
   (different local variables) and the `'ok'`-path payload differ.
2. Task 4 is a **differential test**: for every branch (malformed slug, unknown slug, all-private
   stranger, owner, friend, public stranger) the summary's `status`/`relation`/`owner`/`sections`
   must equal `get_public_crate`'s, and its `count`/`top_styles`/`covers` must equal what deriving
   from `get_public_crate`'s full result yields. It must pass before the Function edits ship.

### Non-goals (do NOT do these here)

- Do **not** alter `get_public_crate`. It stays as the browser render's source.
- Do **not** raise the `/og/` 300s TTL to paper over 1102s — that TTL is the revocation window
  (spec §7 / plan audit F16).
- Do **not** change any table, column, index, or RLS policy. This migration is one `create or
  replace function` plus grants.
- Do **not** touch `boot.js`, `app.js`, `_headers`, `_routes.json`, or `_redirects`.

### Facts this plan is built on (verified 2026-09-10)

- Live DB is at migration **0042**; next file is `0043`.
- `get_public_crate`'s live body (source of the copied gating): captured via `pg_get_functiondef`.
- Column types: `releases.styles` / `releases.genres` = `text[]`; `releases.thumb` /
  `cover_image` = `text`; `collection_items.added` / `wantlist_items.added` = `date`;
  `collection_items.id` / `wantlist_items.id` = `bigint`; `profiles.collecting_since` = `integer`.
- Callers of `get_public_crate`: `functions/c/[slug].js:50`, `functions/og/[slug].js:199`
  (repoint these two), and `public/boot.js:1554,1664,1711` (browser — leave). `public/app.js:80`
  is a comment, not a call.
- The two Functions call as **anon** (publishable key, no JWT) → `auth.jwt()->>'sub'` is null →
  the redirect branches never fire for them; they see only `null` (→404) or the `'ok'` payload.
  The summary still implements the redirect branches so it is a faithful drop-in for any caller
  and the differential test can prove parity.

---

## Task 1 — Create `traxwax-clone/supabase/migrations/0043_public_crate_summary.sql`

Create the file with EXACTLY this content. The gating logic (from the slug regex through the
`v_name` assignment) is copied from the live `get_public_crate` statement-for-statement; if you
diff it against `pg_get_functiondef('public.get_public_crate(text)')`, the executable statements
must be identical — the `declare` block (different local variables) and everything below the
`-- PROJECTION` banner are the only intended differences.

```sql
-- 0043_public_crate_summary.sql — cold audit v1.31 / #200 (absorbs #158, T3.8c).
--
-- get_public_crate returns the whole crate (1.40 MB for 1,876 rows). functions/c and functions/og
-- call it on EVERY anon request and parse it only to derive a count, a top style, and six cover
-- URLs — per-request Worker CPU that trips Cloudflare's 1102 limit on ~10% of requests, so ~1 in 10
-- shared links renders no card / no page. This adds get_public_crate_summary: a PROJECTION of
-- get_public_crate with byte-identical gating (slug / profile / visibility / relation-first /
-- all-private / display-name), but on the 'ok' path it returns only the hot path's needs — count,
-- top 3 styles, six cover URLs — computed in Postgres. get_public_crate is UNCHANGED; the browser
-- render (boot.js) still calls it. Keep the GATING block below in lockstep with get_public_crate.

create or replace function public.get_public_crate_summary(p_slug text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_sub  text := auth.jwt()->>'sub';
  v      record;
  pub_crate boolean; pub_want boolean; pub_fs boolean;
  v_name  text;
  v_count integer := 0;
  v_styles jsonb  := '[]'::jsonb;
  v_covers jsonb  := '[]'::jsonb;
begin
  -- ── GATING — VERBATIM from public.get_public_crate (keep in lockstep) ──────────────────────
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

  if v_sub is not null then
    if v_sub = v.user_id then
      return jsonb_build_object('status','redirect','relation','owner',
                                'open', (pub_crate or pub_want));
    elsif (v.crate_visibility <> 'private' or v.wantlist_visibility <> 'private')
          and exists (select 1 from public.friendships f
                       where f.user_id = v_sub and f.friend_id = v.user_id) then
      return jsonb_build_object('status','redirect','relation','friend',
                                'handle', v.discogs_username);
    end if;
  end if;

  if not (pub_crate or pub_want) then return null; end if;

  v_name := case
    when v.display_name is null or btrim(v.display_name) = '' then 'A Collector'
    when position(' ' in btrim(v.display_name)) = 0 then btrim(v.display_name)
    else split_part(btrim(v.display_name), ' ', 1) || ' ' ||
         upper(left(regexp_replace(btrim(v.display_name), '^.*\s', ''), 1)) || '.'
  end;

  -- ── PROJECTION — derive the hot path's scalars from the LEADING public section ─────────────
  -- Leading section = crate when crate is public, else wantlist — mirrors functions/c + functions/og:
  --   rows = d.sections.crate === true ? d.crate : d.wantlist.  On this path pub_crate OR pub_want,
  --   so when pub_crate is false, pub_want is true and wantlist is the public section.
  -- count      = the leading section's row count (rows.length; a LEFT JOIN in get_public_crate,
  --              so it counts items, not matched releases → count from the items table alone).
  -- top_styles = top 3 styles by record count, ties broken by TRUE first appearance = (item id,
  --              then style index within that item's styles array). `unnest … with ordinality` +
  --              a global row_number() reproduce JS's row-order-then-array-order iteration, so
  --              Object.keys(styleCounts) insertion order + the stable count-desc sort is matched
  --              exactly (min(item id) alone would tie styles that first co-occur in one release).
  -- covers     = the 6 most-recent rows' cover URLs (thumb || cover_image), recency = added desc
  --              then item id desc (later insert), nulls/'' dropped — the https filter + fetch +
  --              collapse stay in functions/og. Empty-string coalesces to the next field ('' is
  --              falsy in JS `thumb || cover_image`; nullif reproduces that).
  if pub_crate then
    select count(*)::int into v_count
      from public.collection_items ci where ci.user_id = v.user_id;

    select coalesce(jsonb_agg(style order by cnt desc, first_seq asc), '[]'::jsonb) into v_styles
      from (
        select st as style, count(*) as cnt, min(seq) as first_seq
          from (
            select u.st,
                   row_number() over (order by ci.id, u.ord) as seq
              from public.collection_items ci
              join public.releases r on r.release_id = ci.release_id
              cross join lateral unnest(r.styles) with ordinality as u(st, ord)
             where ci.user_id = v.user_id
          ) z
         group by st
         order by cnt desc, first_seq asc
         limit 3
      ) s;

    select coalesce(jsonb_agg(url order by rn), '[]'::jsonb) into v_covers
      from (
        select coalesce(nullif(r.thumb,''), nullif(r.cover_image,'')) as url,
               row_number() over (order by ci.added desc, ci.id desc) as rn
          from public.collection_items ci
          left join public.releases r on r.release_id = ci.release_id
         where ci.user_id = v.user_id
         order by ci.added desc, ci.id desc
         limit 6
      ) x
     where x.url is not null;
  else
    select count(*)::int into v_count
      from public.wantlist_items wi where wi.user_id = v.user_id;

    select coalesce(jsonb_agg(style order by cnt desc, first_seq asc), '[]'::jsonb) into v_styles
      from (
        select st as style, count(*) as cnt, min(seq) as first_seq
          from (
            select u.st,
                   row_number() over (order by wi.id, u.ord) as seq
              from public.wantlist_items wi
              join public.releases r on r.release_id = wi.release_id
              cross join lateral unnest(r.styles) with ordinality as u(st, ord)
             where wi.user_id = v.user_id
          ) z
         group by st
         order by cnt desc, first_seq asc
         limit 3
      ) s;

    select coalesce(jsonb_agg(url order by rn), '[]'::jsonb) into v_covers
      from (
        select coalesce(nullif(r.thumb,''), nullif(r.cover_image,'')) as url,
               row_number() over (order by wi.added desc, wi.id desc) as rn
          from public.wantlist_items wi
          left join public.releases r on r.release_id = wi.release_id
         where wi.user_id = v.user_id
         order by wi.added desc, wi.id desc
         limit 6
      ) x
     where x.url is not null;
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
    'count', v_count,
    'top_styles', v_styles,
    'covers', v_covers);
end;
$function$;

-- Grants: match get_public_crate's reach exactly — it carries anon, authenticated, AND service_role;
-- the summary must too (only anon is exercised, by /c + /og + boot.js's publishable key). public revoked.
revoke all on function public.get_public_crate_summary(text) from public;
grant execute on function public.get_public_crate_summary(text) to anon, authenticated, service_role;
```

**Apply (break-glass, armed connector):** `apply_migration` with name `0043_public_crate_summary`
and the file's contents. Do NOT `execute_sql` the body ad hoc — it must land in the migration
ledger (`list_migrations` must show `0043` after).

---

## Task 2 — Repoint `traxwax-clone/functions/c/[slug].js` to the summary

Two edits, nothing else in the file changes.

**Edit 2a — the RPC name (line ~50).** Replace:

```js
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_crate`, {
```

with:

```js
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_crate_summary`, {
```

**Edit 2b — read the derived scalars instead of the rows.** Replace this block (the ten lines from
`const name` through `const topStyle`):

```js
  const name = d.owner.display_name || 'A Collector';
  const crate = Array.isArray(d.crate) ? d.crate : [];
  const wantlist = Array.isArray(d.wantlist) ? d.wantlist : [];
  const crateIsPublic = d.sections.crate === true;
  const rows = crateIsPublic ? crate : wantlist;
  const n = rows.length;
  const noun = crateIsPublic ? 'Crate' : 'Wantlist';
  // Top style by record count from the leading public section (matches identityHtml's source).
  const styleCounts = {};
  for (const rec of rows) for (const st of (rec.styles || [])) styleCounts[st] = (styleCounts[st] || 0) + 1;
  const topStyle = Object.keys(styleCounts).sort((a, b) => styleCounts[b] - styleCounts[a])[0] || null;
```

with:

```js
  const name = d.owner.display_name || 'A Collector';
  const crateIsPublic = d.sections.crate === true;
  const n = Number(d.count) || 0;                         // leading-section count, from Postgres
  const noun = crateIsPublic ? 'Crate' : 'Wantlist';
  // Top style by record count, top-3 derived server-side (get_public_crate_summary); /c uses [0].
  const topStyle = (Array.isArray(d.top_styles) && d.top_styles[0]) || null;
```

Everything downstream is unchanged: `title`, `desc`, the `v = [n, topStyle || '', d.owner.og_palette || 'red']`
cache-buster hash, `img`, and the `meta` array all read `name`, `n`, `topStyle`, `d.owner.og_palette`
exactly as before, so the `?v=` hash is byte-identical to today's for the same crate.

---

## Task 3 — Repoint and slim `traxwax-clone/functions/og/[slug].js`

Four edits.

**Edit 3a — `coverUris` now takes the pre-ordered URL list, not rows.** Replace the entire
`coverUris` function (from its doc-comment through its closing brace) with:

```js
/* The six cover URLs come pre-selected and pre-ordered from get_public_crate_summary (recency:
   added desc, then insert id desc). This fetches each (3s timeout) → data URI; a failed or
   non-https entry drops out (spec's few-covers degradation), and the array collapses left. */
async function coverUris(urls) {
  const one = async (url) => {
    if (!url || !/^https:\/\//.test(url)) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 400000) return null;   // a thumb should be tens of KB; skip monsters
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
      return `data:${mime};base64,${btoa(bin)}`;
    } catch (e) { return null; }
  };
  return (await Promise.all((urls || []).map(one))).filter(Boolean);
}
```

**Edit 3b — `buildCardHtml` reads the derived scalars.** In `buildCardHtml(d, slug)`, replace:

```js
  const crateIsPublic = d.sections.crate === true;
  const rows = crateIsPublic ? d.crate : d.wantlist;
  const name = (d.owner.display_name || 'A Collector').toUpperCase();
  const noun = crateIsPublic ? 'CRATE' : 'WANTLIST';
  const kicker = crateIsPublic ? 'A CRATE ON TRAXWAX' : 'A WANTLIST ON TRAXWAX';
  const countLabel = crateIsPublic ? 'RECORDS' : 'WANTED';
  const count = rows.length.toLocaleString('en-US');

  const styleCounts = {};
  for (const rec of rows) for (const st of (rec.styles || [])) styleCounts[st] = (styleCounts[st] || 0) + 1;
  const styles = Object.keys(styleCounts).sort((a, b) => styleCounts[b] - styleCounts[a]).slice(0, 3);
```

with:

```js
  const crateIsPublic = d.sections.crate === true;
  const name = (d.owner.display_name || 'A Collector').toUpperCase();
  const noun = crateIsPublic ? 'CRATE' : 'WANTLIST';
  const kicker = crateIsPublic ? 'A CRATE ON TRAXWAX' : 'A WANTLIST ON TRAXWAX';
  const countLabel = crateIsPublic ? 'RECORDS' : 'WANTED';
  const count = (Number(d.count) || 0).toLocaleString('en-US');

  // Top-3 styles derived server-side (get_public_crate_summary), already count-ordered.
  const styles = Array.isArray(d.top_styles) ? d.top_styles.slice(0, 3) : [];
```

**Edit 3c — the RPC name + the content hash (the `onRequestGet` block after the 404 negative-cache).**
Replace:

```js
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_crate`, {
```

with:

```js
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_crate_summary`, {
```

Then replace this block (from `const rows = ` through the `cacheKey` line):

```js
  const rows = d.sections.crate === true ? d.crate : d.wantlist;
  const rowsArr = Array.isArray(rows) ? rows : [];

  // #114: the content hash — count|topStyle|palette, identical to /c/'s ?v formula.
  const _sc = {};
  for (const rec of rowsArr) for (const st of (rec.styles || [])) _sc[st] = (_sc[st] || 0) + 1;
  const _top = Object.keys(_sc).sort((a, b) => _sc[b] - _sc[a])[0] || '';
  const _v = [rowsArr.length, _top, d.owner.og_palette || 'red'].join('|');
  let _vh = 0; for (let i = 0; i < _v.length; i++) _vh = (_vh * 31 + _v.charCodeAt(i)) >>> 0;
  const cacheKey = new Request(_u.origin + _u.pathname + '?v=' + _vh.toString(36), { method: 'GET' });
```

with:

```js
  // #114: the content hash — count|topStyle|palette, identical to /c/'s ?v formula.
  // count/top style now come from get_public_crate_summary (same values → same hash → cache stable).
  const _top = (Array.isArray(d.top_styles) && d.top_styles[0]) || '';
  const _v = [Number(d.count) || 0, _top, d.owner.og_palette || 'red'].join('|');
  let _vh = 0; for (let i = 0; i < _v.length; i++) _vh = (_vh * 31 + _v.charCodeAt(i)) >>> 0;
  const cacheKey = new Request(_u.origin + _u.pathname + '?v=' + _vh.toString(36), { method: 'GET' });
```

**Edit 3d — feed `coverUris` the summary's URLs.** Replace:

```js
  d._covers = await coverUris(rowsArr);
```

with:

```js
  d._covers = await coverUris(d.covers);
```

After 3a–3d, `functions/og/[slug].js` no longer references `d.crate`, `d.wantlist`, `rows`, or
`rowsArr` anywhere. Grep to confirm (Task 4, step 5).

---

## Task 4 — Verify BEFORE the Functions ship (this is the RED-first gate)

Run all of the following. Do not deploy the Function edits until Step 4 shows `PASS` on every row
and Step 5 is clean.

**Step 1 — the migration landed.** Under the read-only connector: `list_migrations` includes
`0043_public_crate_summary`. Expected: present, newest.

**Step 2 — the function exists with the right grants.** Read-only connector:

```sql
select p.proname,
       array(select r.rolname from pg_proc pp
             join aclexplode(pp.proacl) a on true
             join pg_roles r on r.oid = a.grantee
             where pp.oid = p.oid and a.privilege_type = 'EXECUTE') as exec_roles
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_public_crate_summary';
```

Expected: one row; `exec_roles` contains `anon`, `authenticated`, and `service_role` (and not
`public`) — matching `get_public_crate`'s ACL.

**Step 3 — payload size sanity.** The summary must be < 10 KB for the 1,876-row crate. Run under
**break-glass** (the read-only role lacks EXECUTE on these definer functions):

```sql
select octet_length(convert_to(public.get_public_crate_summary('lanes-crate')::text, 'UTF8')) as summary_bytes,
       octet_length(convert_to(public.get_public_crate('lanes-crate')::text,        'UTF8')) as full_bytes;
```

Expected: `summary_bytes` < 10000; `full_bytes` ≈ 1,465,392. (This one call is fine — the problem
is per-request CPU at scale, not a single admin call.)

**Step 4 — the differential test (parity on every branch).** Run under **break-glass**. This sets a
JWT claim per scenario, calls both functions, and asserts the summary is a faithful projection.
Replace `:owner_sub` and `:friend_sub` first (Step 4a gets them).

*Step 4a — resolve the subs:*

```sql
select p.user_id as owner_sub,
       (select f.user_id from public.friendships f where f.friend_id = p.user_id limit 1) as friend_sub
from public.profiles p where p.public_slug = 'lanes-crate';
```

*Step 4b — the parity harness* (paste `owner_sub`/`friend_sub` from 4a where shown):

```sql
do $$
declare
  slug       text := 'lanes-crate';
  owner_sub  text := 'PASTE_owner_sub';
  friend_sub text := 'PASTE_friend_sub';   -- null if the owner has no friend; that branch is skipped
  full_j jsonb; sum_j jsonb; lead_len int;
begin
  -- null branches: whole-object parity (both must return NULL).
  perform set_config('request.jwt.claims', null, true);
  if public.get_public_crate_summary('Bad_Slug!') is distinct from public.get_public_crate('Bad_Slug!')
     then raise exception 'FAIL malformed slug'; end if;
  raise notice 'PASS malformed slug (both null)';

  if public.get_public_crate_summary('no-such-slug-xyz') is distinct from public.get_public_crate('no-such-slug-xyz')
     then raise exception 'FAIL unknown slug'; end if;
  raise notice 'PASS unknown slug (both null)';

  -- public stranger (anon): the SECURITY-CRITICAL fields must be byte-identical; count must match.
  perform set_config('request.jwt.claims', null, true);
  sum_j  := public.get_public_crate_summary(slug);
  full_j := public.get_public_crate(slug);
  if (sum_j->>'status')   is distinct from (full_j->>'status')   then raise exception 'FAIL stranger status';   end if;
  if (sum_j->>'relation') is distinct from (full_j->>'relation') then raise exception 'FAIL stranger relation'; end if;
  if (sum_j->'owner')     is distinct from (full_j->'owner')     then raise exception 'FAIL stranger owner';    end if;
  if (sum_j->'sections')  is distinct from (full_j->'sections')  then raise exception 'FAIL stranger sections'; end if;
  lead_len := jsonb_array_length(
    case when (full_j->'sections'->>'crate')::boolean then full_j->'crate' else full_j->'wantlist' end);
  if (sum_j->>'count')::int <> lead_len then
    raise exception 'FAIL stranger count: summary=% full=%', sum_j->>'count', lead_len; end if;
  raise notice 'PASS public stranger (status / relation / owner / sections / count)';

  -- owner redirect: whole-object parity.
  perform set_config('request.jwt.claims', json_build_object('sub', owner_sub, 'role','authenticated')::text, true);
  if public.get_public_crate_summary(slug) is distinct from public.get_public_crate(slug)
     then raise exception 'FAIL owner redirect: % vs %',
       public.get_public_crate_summary(slug), public.get_public_crate(slug); end if;
  raise notice 'PASS owner redirect';

  -- friend redirect: whole-object parity (skipped if the owner has no friend).
  if friend_sub is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', friend_sub, 'role','authenticated')::text, true);
    if public.get_public_crate_summary(slug) is distinct from public.get_public_crate(slug)
       then raise exception 'FAIL friend redirect'; end if;
    raise notice 'PASS friend redirect';
  else
    raise notice 'SKIP friend redirect (owner has no friend in friendships)';
  end if;

  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL DIFFERENTIAL CHECKS PASSED';
end $$;
```

Expected: the final notice `ALL DIFFERENTIAL CHECKS PASSED` and no `FAIL`. This proves the
**security-critical** parity — `status`, `relation`, `owner`, and `sections` are byte-identical to
`get_public_crate` on every branch (malformed / unknown / all-private / stranger / owner / friend),
and the leading-section `count` matches. **`top_styles` and `covers` parity is cosmetic and is
verified visually in Task 5** (the rendered card must match the pre-fix card): an independent SQL
oracle for the JS style-derivation is fragile and was dropped — the migration's SQL is argued to
match JS in the Task-1 comments, and the rendered card is the ground truth.

> RED-first check (Lane's convention): before trusting this gate, prove it can fail — temporarily
> add `+ 1` to the summary's `v_count` (or point `sum_j` at a different slug), confirm the block
> raises `FAIL stranger count`, then revert. A harness that passes with and without the fix proves
> nothing.

**Step 5 — the Functions no longer touch the full arrays.** On the device, in `traxwax-clone/`:

```
grep -nE "d\.crate|d\.wantlist|rowsArr|styleCounts|_sc\b" functions/c/[slug].js functions/og/[slug].js
```

Expected: **no output** (every full-array reference is gone). If anything prints, an edit is
incomplete.

---

## Task 5 — Ship the Function edits and verify live availability

The Function edits deploy with Cloudflare Pages on push to `main` (the migration is already live
from Task 1, so `/c` and `/og` calling the new RPC will resolve the moment the deploy finishes).
Rehearse on a branch preview first (Wave 5b convention), then merge.

After the deploy, re-run #200's measurement against production:

```
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code}\n" "https://traxwax.com/og/lanes-crate"; done | sort | uniq -c
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code}\n" "https://traxwax.com/c/lanes-crate";  done | sort | uniq -c
```

Expected: `20 200` for both (was 18/20). Then eyeball the card itself — open
`https://traxwax.com/og/lanes-crate` in a browser and confirm the count, the top-3 styles, and the
six covers match the pre-fix card (compare against `og-preview-lanes-crate.png` in the project
folder). Confirm `/c/lanes-crate`'s `<title>`/`og:*` meta are unchanged from before.

---

## Task 6 — Docs + issue bookkeeping (in the same commit as the Function edits)

- `traxwax-clone/CLAUDE.md` — extend the migration map to `0043_public_crate_summary` (one line,
  in the same two places the 0040→0042 edit touched) and note `get_public_crate_summary` as the
  anon hot-path RPC beside `get_public_crate`.
- `traxwax-clone/DEPLOY.md` — in the Wave 5b section, replace the `⚠ #200` availability note with a
  "fixed in 0043 (summary RPC)" line; add `0043` to the applied-migrations list; note the summary
  is the ONLY function `/c` and `/og` now call, `get_public_crate` stays the browser render.
- `traxwax-clone/CHANGELOG.md` — new `## [1.31.1]` entry under Fixed: the #200 summary-RPC fix.
- `traxwax-clone/VERSION` → `1.31.1`.
- Close **#200** and **#158** via the commit trailer: `Closes #200` and `Closes #158` (each keyword
  before each number — `Closes #200 #158` closes only #200).
- Append the fix to `memory/log.md` via `Projects/_infra/scripts/memory-log.py` (never edit in
  place, per L15).

---

## Rollback

`0043` only adds a function; it changes nothing existing. To revert: `drop function if exists
public.get_public_crate_summary(text);` and revert the two Function files to their pre-fix commit
(they call `get_public_crate` again — which is untouched and still live). No data to unwind, no
`get_public_crate` change to undo.

---

## Handoff command block (Mac-side — fill in after the branch preview passes)

One `&&` chain, patches already written to disk in the clone, `Closes` trailers in the commit
message. Break-glass is armed only for the Task 1 `apply_migration`, then turned back off.

```
cd <clone> && \
git checkout -b fix/200-public-crate-summary && \
git add supabase/migrations/0043_public_crate_summary.sql functions/c/[slug].js functions/og/[slug].js \
        CLAUDE.md DEPLOY.md CHANGELOG.md VERSION && \
git commit -m "fix: anon /c and /og call a summary RPC, not the 1.4MB full crate (#200)

Closes #200
Closes #158" && \
git pull --rebase origin main && \
git push -u origin fix/200-public-crate-summary
```

(The migration is applied via break-glass BEFORE this push so the deployed Functions find the RPC;
`list_migrations` must show `0043` first. Then open the PR, let the branch preview build, verify
Task 5 on the preview URL, and merge.)

---

## Verification pass — record (2026-09-10)

An independent no-context agent verified this document against the live DB and both Function files.
Its catches are folded in above and kept struck-through here so they are not silently re-found:

- ~~The Task-4 differential harness's `top_styles` recomputation threw at runtime (ambiguous `elem`
  column from a double alias; `function_top` declared `text` but assigned `text[]`), so the gate
  could never reach PASS and the owner/friend parity checks after it never ran.~~ → harness
  rewritten to whole-object parity on the null/redirect branches + `status`/`relation`/`owner`/
  `sections`/`count` on the stranger branch; the fragile SQL style-oracle is gone and `top_styles`/
  `covers` parity moved to the Task-5 visual check.
- ~~`top_styles` tie-break used `min(item id)` only, not JS's true (row, style-index) first
  appearance, so tied-count styles could reorder vs the card and churn the `?v` cache hash for
  crates other than `lanes-crate`.~~ → Task-1 SQL hardened with `unnest … with ordinality` + a
  global `row_number()`.
- ~~"gating block is a verbatim copy … only the name + projection differ" overstated (the copied
  block also drops two comments and changes the `declare` locals).~~ → reworded to "gating logic
  identical; declares differ."
- ~~Grants "same reach as `get_public_crate` — no others" omitted `service_role` (the live ACL is
  `{postgres, anon, authenticated, service_role}`).~~ → grant now includes `service_role`.

Verified **SOUND** by the pass (recorded so it is not re-litigated): all six Function edits' quoted
"old" blocks match the current files byte-for-byte; the Step-5 grep is clean after the edits; the
`count(*)`-from-items-table parity is correct (`releases.release_id` is unique, zero orphans, so the
LEFT JOIN doesn't inflate); the covers projection equals today's output (6 most-recent rows,
`nullif` empty-string = JS `||`, null-drop without pulling a 7th row); `0043` is the correct next
migration; the migration touches no table/column/index/RLS and leaves `get_public_crate` unchanged;
and for `lanes-crate` the top-3 styles (Indie Rock / Alternative Rock / Indie Pop; 793 / 404 / 226;
no ties) render identically. The 1.40 MB payload figure and the 18/20 failure rate are #200's own
measurements (not independently re-measured — the read-only role can't execute the RPC); Task 5
re-measures live after the fix.
