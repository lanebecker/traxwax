# Header status feed (#59) — implementation plan

Status: DRAFT for Lane (revised after verification-pass — see the findings log at the end). Companion to the header design spec
(`Design/traxwax-headers-redesign/TRAXWAX-HEADER-DESIGN-SPEC.md` §4) and the #59 catalog sheet
(`TraxWax-status-feed-catalog.xlsx`, Lane-edited).

Repo: `traxwax-clone`. Files touched: `supabase/migrations/0033_social_feed.sql` (NEW), `public/boot.js`, `public/app.js`.
Line numbers are from the copy read 2026-09-06 (app.js 2049 lines, boot.js 1350 lines) — **search for the quoted anchors, do not
trust the numbers.** Requires a Supabase migration (0033) → **break-glass**; the rest is git-only frontend.

---

## 0. Architecture (why it's cheap)

The mode-A strip's third cell becomes a rich, rotating status feed of the newest friend activity that touches *you*.

**The key move: the server returns only CURRENT state; the client computes "new to this viewer" by diffing against a
localStorage baseline.** Recon confirmed the schema has no visibility-change timestamps, no stable for-sale `listed_at`, and
`created_at` is scrambled by the sweep-and-reinsert importer — so server-side "what changed" is unreliable. The client baseline
sidesteps all of it: it remembers the exact overlap ids it last showed you; "new" = current − seen. Immune to import churn, zero
new timestamp columns.

Three parts:
1. **One read-only aggregate RPC** (`get_social_feed`, migration 0033) — per friend, the *current* overlap id-sets between you and
   them, each gated by the existing `private.can_view_*` consent helpers, plus current visibility booleans. No history, no writes.
2. **A client seen-state engine** (localStorage, `app.js`) — computed **once per load** (never per render): baseline diff,
   per-event `first_seen` timers (dual TTL 7d/30d), event identity + re-notify rule, hybrid rotation (unseen jumps the queue;
   seen-but-live rotates on reload), pool cap 5, ✕ dismiss.
3. **Strip render + the #3/#4 "smarter friend wantlist" split filters.**

Seen-state is **per-device** for v1. A server-side seen table is deferred (trigger: a user reports a dismissed message reappearing
on another device).

---

## 1. The event catalog (final — **10 types**)

`{FIRST}` = friend's display-name first word, uppercased. Counts numeric with the link on the count phrase; **the noun "ALBUM(S)"
is retained per Lane's approved copy** (`_pl(n,'ALBUM')` → "1 ALBUM"/"14 ALBUMS", helper at app.js ~903); no trailing period. Exact
strings live in §5 `_feedSentence` and MUST match this table.

| # | key (type) | Copy (approved) | Link → | Overlap field | TTL | Priority |
|---|---|---|---|---|---|---|
| 1 | `forsaleYouWant` | `{FIRST} ADDED {n} ALBUMS FOR SALE THAT YOU WANT` | their GOODS, sellingYouWant | `forsale_you_want` | 7d | 1 |
| 3 | `theyWantYouSell` | `{FIRST} WANTS {n} ALBUMS YOU'RE SELLING` | their wantlist, theyWantSell | `they_want_you_sell` | 7d | 2 |
| 4 | `theyWantYouHave` | `{FIRST} WANTS {n} ALBUMS YOU HAVE` | their wantlist, theyWantHave | `they_want_you_have` | 7d | 3 |
| 2 | `crateYouWant` | `{FIRST} ADDED {n} ALBUMS YOU WANT` | their crate, youWant | `crate_you_want` | 7d | 4 |
| 5 | `newFriend` | `{FIRST} IS NOW YOUR FRIEND` | their crate | sentinel `['friend']` | 30d | 5 |
| 6 | `openedCrate` | `{FIRST} SHARED THEIR CRATE` | their crate | sentinel `['crate']` | 30d | 6 |
| 7 | `openedForsale` | `{FIRST} IS SELLING THEIR RECORDS NOW` | their GOODS | sentinel `['forsale']` | 30d | 7 |
| 11 | `openedWantlist` | `{FIRST} SHARED THEIR WANTLIST` | their wantlist | sentinel `['wantlist']` | 30d | 8 |
| 8 | `crateYouOwn` | `{FIRST} ADDED {n} ALBUMS YOU OWN` | their crate | `crate_you_own` | 7d | 9 |
| 9 | `mutualWant` | `YOU AND {FIRST} BOTH WANT {n} OF THE SAME ALBUMS` | their wantlist | `mutual_want` | 7d | 10 |

- Event **10** (records you wanted are GONE) is **deferred** → issue #61. Standing aggregates (#12/#13) **dropped**. That's why
  this is 10, not 11 (the labels skip 10).
- `mutualWant` singular (n=1): `YOU AND {FIRST} BOTH WANT THE SAME ALBUM` (drop the count word; §5 handles it).
- `forsaleYouWant`/`theyWant*`/`crateYou*` singular (n=1): `_pl` yields "1 ALBUM" → "…ADDED 1 ALBUM FOR SALE THAT YOU WANT". Good.

---

## 2. Migration 0033 — `get_social_feed()` (break-glass)

Create `supabase/migrations/0033_social_feed.sql` with EXACTLY the following, **in this order** (helpers first — a `language sql`
function is parse-analyzed at CREATE with `check_function_bodies` on, so a function that calls a not-yet-created one fails to
apply). The two helpers live in the **`private` schema** (not exposed to PostgREST), matching `private.can_view_*`; `get_social_feed`
calls them **fully qualified**. Every `releases` join keys on **`release_id`** (the table's PK — there is no `releases.id`).

```sql
-- 0033_social_feed.sql — read-only aggregate for the header status feed (#59).
-- Per friend, the CURRENT overlap release-id sets between the caller and that friend, each gated by the existing consent helpers.
-- The client diffs these against a localStorage baseline to decide what is "new". No history, no writes, no price.

-- ── helper 1: friend-side release_ids overlapping the caller, exact or (any-mode) master. Bounded. ──
create or replace function private._feed_overlap(p_their_kind text, p_their_user text, p_my_kind text, p_my_user text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_any boolean := (coalesce((select match_mode from public.profiles where user_id = p_my_user),'exact') = 'any');
  v_out jsonb;
begin
  with their_rows as (
    select t.release_id, r.master_id from (
      select release_id from public.collection_items where p_their_kind='crate' and user_id=p_their_user
      union all
      select release_id from public.wantlist_items  where p_their_kind='wants' and user_id=p_their_user
      union all
      select release_id from public.inventory_items where p_their_kind='inv'   and user_id=p_their_user and status='for_sale'
    ) t join public.releases r on r.release_id = t.release_id
  ),
  my_rows as (
    select m.release_id, r.master_id from (
      select release_id from public.collection_items where p_my_kind='crate' and user_id=p_my_user
      union all
      select release_id from public.wantlist_items  where p_my_kind='wants' and user_id=p_my_user
      union all
      select release_id from public.inventory_items where p_my_kind='inv'   and user_id=p_my_user and status='for_sale'
    ) m join public.releases r on r.release_id = m.release_id
  )
  select coalesce(jsonb_agg(rid order by rid), '[]'::jsonb) into v_out
  from (
    select distinct tr.release_id as rid
    from their_rows tr
    where exists (
      select 1 from my_rows mr
      where mr.release_id = tr.release_id
         or (v_any and tr.master_id is not null and mr.master_id = tr.master_id)
    )
    order by 1
    limit 200
  ) s;
  return v_out;
end;
$$;

-- ── helper 2: their wantlist ∩ (my crate MINUS my inventory) — the "you have, unlisted" split (#4). ──
create or replace function private._feed_overlap_unlisted(p_their_user text, p_my_user text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_any boolean := (coalesce((select match_mode from public.profiles where user_id = p_my_user),'exact') = 'any');
  v_out jsonb;
begin
  with their_wants as (
    select w.release_id, r.master_id from public.wantlist_items w
    join public.releases r on r.release_id = w.release_id where w.user_id = p_their_user
  ),
  my_have as (
    select c.release_id, r.master_id from public.collection_items c
    join public.releases r on r.release_id = c.release_id where c.user_id = p_my_user
  ),
  my_listed as (select release_id from public.inventory_items where user_id = p_my_user and status='for_sale')
  select coalesce(jsonb_agg(rid order by rid), '[]'::jsonb) into v_out
  from (
    select distinct tw.release_id as rid
    from their_wants tw
    where exists (
      select 1 from my_have mh
      where (mh.release_id = tw.release_id or (v_any and tw.master_id is not null and mh.master_id = tw.master_id))
        and mh.release_id not in (select release_id from my_listed)
    )
    order by 1
    limit 200
  ) s;
  return v_out;
end;
$$;

-- ── the aggregate: one object per friend of the caller. ──
create or replace function public.get_social_feed()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',            f.friend_id,
    'discogs_username',   pr.discogs_username,
    'display_name',       pr.display_name,
    'avatar_url',         pr.avatar_url,
    'can_crate',          private.can_view_crate(auth.jwt()->>'sub', f.friend_id),
    'can_want',           private.can_view_wantlist(auth.jwt()->>'sub', f.friend_id),
    'can_forsale',        private.can_view_forsale(auth.jwt()->>'sub', f.friend_id),
    'forsale_you_want',   case when private.can_view_forsale(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('inv',   f.friend_id, 'wants', auth.jwt()->>'sub') else '[]'::jsonb end,
    'crate_you_want',     case when private.can_view_crate(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('crate', f.friend_id, 'wants', auth.jwt()->>'sub') else '[]'::jsonb end,
    'they_want_you_sell', case when private.can_view_wantlist(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('wants', f.friend_id, 'inv',   auth.jwt()->>'sub') else '[]'::jsonb end,
    'they_want_you_have', case when private.can_view_wantlist(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap_unlisted(f.friend_id, auth.jwt()->>'sub') else '[]'::jsonb end,
    'crate_you_own',      case when private.can_view_crate(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('crate', f.friend_id, 'crate', auth.jwt()->>'sub') else '[]'::jsonb end,
    'mutual_want',        case when private.can_view_wantlist(auth.jwt()->>'sub', f.friend_id)
                            then private._feed_overlap('wants', f.friend_id, 'wants', auth.jwt()->>'sub') else '[]'::jsonb end
  )), '[]'::jsonb)
  from public.friendships f
  join public.profiles pr on pr.user_id = f.friend_id
  where f.user_id = auth.jwt()->>'sub';
$$;

-- grants: mirror the established pattern. can_view_* are granted to authenticated (+service_role); match those exactly.
revoke all on function private._feed_overlap(text,text,text,text) from public, anon;
revoke all on function private._feed_overlap_unlisted(text,text) from public, anon;
grant execute on function private._feed_overlap(text,text,text,text) to authenticated, service_role;
grant execute on function private._feed_overlap_unlisted(text,text) to authenticated, service_role;
revoke all on function public.get_social_feed() from public, anon;
grant execute on function public.get_social_feed() to authenticated;
```

> Verify against the ACTUAL declarations of `private.can_view_crate/_wantlist/_forsale` in migrations 0013/0018/0028 before applying:
> confirm the exact schema-qualified names, arg order `(viewer, owner)`, and that they are granted the way shown. Match them.

**Post-apply verification (read-only connector, as a user with friends):**
```sql
select jsonb_array_length(public.get_social_feed());        -- = your friend count
select jsonb_pretty(public.get_social_feed());              -- 6 overlap arrays per friend; [] where consent is off; no error
```
Cross-check ONE array against a hand intersection, e.g. `crate_you_want` for a friend =
`select array_agg(ci.release_id) from collection_items ci where ci.user_id=<friend> and ci.release_id in
(select release_id from wantlist_items where user_id=<you>)` (exact-mode).

---

## 3. The client seen-state engine (`public/app.js`)

Add near the other localStorage helpers (~L23). Computed **once per load** via `feedCompute()`, which sets
`window.__twFeedActive` (the decorated event or null). **`stripHtml()` only READS `window.__twFeedActive` — it never calls the
engine** (so incidental re-renders — theme toggle, filtering — cannot flip the message or advance rotation).

```js
/* #59 status feed — per-device seen-state engine. boot.js sets window.__twFeed (the RPC's current per-friend overlaps);
   feedCompute() runs ONCE per load, diffs against a localStorage baseline, picks the one event to show, and caches it on
   window.__twFeedActive. stripHtml() reads that cache. All per-device. */
const FEED_KEY = 'tw_feed_v1';           // { seen:{ [evKey]:{ids:[...],firstSeen:ms,dismissed:bool} }, rot:int, primed:bool }
const FEED_TTL = { activity: 7*864e5, milestone: 30*864e5 };
const FEED_MILESTONE = new Set(['newFriend','openedCrate','openedForsale','openedWantlist']);
const FEED_PRIORITY = ['forsaleYouWant','theyWantYouSell','theyWantYouHave','crateYouWant',
  'newFriend','openedCrate','openedForsale','openedWantlist','crateYouOwn','mutualWant'];   // 10 types; lower index wins ties
const FEED_POOL_CAP = 5;

function _feedLoad(){ try { return JSON.parse(localStorage.getItem(FEED_KEY)) || {}; } catch(e){ return {}; } }
function _feedSave(s){ try { localStorage.setItem(FEED_KEY, JSON.stringify(s)); } catch(e){} }
const _feedTtl = (type) => FEED_MILESTONE.has(type) ? FEED_TTL.milestone : FEED_TTL.activity;
const _evKey = (friendId, type) => type + ':' + friendId;

function _feedCandidates(feed){
  const out = [];
  if (!Array.isArray(feed)) return out;
  for (const fr of feed){
    const friend = { id: fr.user_id, handle: fr.discogs_username, name: fr.display_name || fr.discogs_username || 'A friend' };
    const axes = [
      ['forsaleYouWant', fr.forsale_you_want], ['theyWantYouSell', fr.they_want_you_sell],
      ['theyWantYouHave', fr.they_want_you_have], ['crateYouWant', fr.crate_you_want],
      ['crateYouOwn', fr.crate_you_own], ['mutualWant', fr.mutual_want],
    ];
    for (const [type, ids] of axes)
      if (Array.isArray(ids) && ids.length) out.push({ type, friendId: fr.user_id, friend, ids: ids.map(String) });
    out.push({ type:'newFriend', friendId: fr.user_id, friend, ids:['friend'] });
    if (fr.can_crate)   out.push({ type:'openedCrate',    friendId: fr.user_id, friend, ids:['crate'] });
    if (fr.can_forsale) out.push({ type:'openedForsale',  friendId: fr.user_id, friend, ids:['forsale'] });
    if (fr.can_want)    out.push({ type:'openedWantlist', friendId: fr.user_id, friend, ids:['wantlist'] });
  }
  for (const c of out) c.key = _evKey(c.friendId, c.type);
  return out;
}

/* Run ONCE per load (from boot's get_social_feed .finally, and once from bootCrate as a fallback). Idempotent via
   window.__twFeedComputed. Sets window.__twFeedActive = decorated event | null, then repaints. */
function feedCompute(){
  if (window.__twFeedComputed) return;
  const feed = window.__twFeed;
  if (!Array.isArray(feed)) return;                 // not arrived yet — leave __twFeedActive as-is (null → count fallback)
  window.__twFeedComputed = true;

  const now = Date.now();
  let st = _feedLoad(); if (!st.seen) st.seen = {};
  const cands = _feedCandidates(feed);

  // FIRST-RUN PRIMING (Decision D1 = silent): record every current event's ids as already-seen, show nothing — the feed only
  // fires on CHANGES after this first load. Runs only with a loaded feed (guarded above), so no async-race flood. (D1-alt
  // "welcome flood": delete this block.)
  if (!st.primed){
    for (const c of cands) st.seen[c.key] = { ids: c.ids.slice(), firstSeen: 0, dismissed: false };
    st.primed = true; _feedSave(st); window.__twFeedActive = null; return;
  }

  const live = [];
  for (const c of cands){
    const rec = st.seen[c.key];
    const seenIds = rec ? (rec.ids || []) : [];
    const newIds = c.ids.filter(id => seenIds.indexOf(id) === -1);
    const fresh = newIds.length > 0;
    const withinTimer = rec && rec.firstSeen && (now < rec.firstSeen + _feedTtl(c.type));
    if (rec && rec.dismissed && !fresh) continue;   // a NEW id re-activates a dismissed event
    if (fresh || withinTimer) live.push({ ...c, fresh, firstSeen: rec ? rec.firstSeen : 0 });
  }
  if (!live.length){ window.__twFeedActive = null; return; }

  live.sort((a,b) => FEED_PRIORITY.indexOf(a.type) - FEED_PRIORITY.indexOf(b.type) || (b.firstSeen||now) - (a.firstSeen||now));
  const pool = live.slice(0, FEED_POOL_CAP);
  const freshPool = pool.filter(e => e.fresh);
  let chosen;
  if (freshPool.length){
    chosen = freshPool[0];
  } else {
    const idx = (st.rot || 0) % pool.length;
    chosen = pool[idx];
    st.rot = (idx + 1) % pool.length;
  }
  const prev = st.seen[chosen.key] || {};
  const startTimer = chosen.fresh || !prev.firstSeen;
  st.seen[chosen.key] = { ids: chosen.ids.slice(), firstSeen: startTimer ? now : prev.firstSeen, dismissed: false };
  _feedSave(st);
  window.__twFeedActive = _feedDecorate(chosen);
}

/* ✕ — suppress an event's current ids until genuinely new ones appear. */
function feedDismiss(key){
  const st = _feedLoad(); if (!st.seen || !st.seen[key]) return;
  st.seen[key].dismissed = true; _feedSave(st);
  window.__twFeedActive = null; render();
}
window.TraxWaxFeedCompute = feedCompute;
```

### 3.4 sentinel events & known limits

- **newFriend** fires for a friend id not in the primed baseline (a friend added since last load). Priming records current friends
  as seen, so existing friends never flood. TTL 30d.
- **openedCrate/Forsale/Wantlist** use a constant token id; because priming records the current tokens, the event fires only when a
  flag flips off→on *after* priming (the token appears where it wasn't).
- **Known limit (v1, acceptable):** the engine never prunes a `seen` record when a candidate later disappears. So if a friend turns
  a visibility flag **off then on again**, it will NOT re-fire (the stored token still matches). This is a minor edge; a later
  version can prune vanished candidates. (Do NOT claim off→on re-fires — it does not.)

---

## 4. Boot wiring (`public/boot.js`)

Replace the v1.24.0 count-only block (own-crate branch, grep `supabase.rpc('list_friends')` near the `TraxWaxViewer = { isOwn:
true …}` line) with two non-blocking reads:

```js
  // #59 — own-crate status feed. Two reads, both non-blocking (never gate first paint): list_friends for the count fallback,
  // get_social_feed for the rich feed. On resolve, compute the feed choice ONCE (TraxWaxFeedCompute) then repaint. Per-device
  // seen-state lives in app.js; here we only stash the raw current state.
  supabase.rpc('list_friends')
    .then(({ data }) => { window.__twFriendStatus = { count: (data || []).length }; })
    .catch(() => { window.__twFriendStatus = null; })
    .finally(() => { if (window.TraxWaxRerender) window.TraxWaxRerender(); });
  supabase.rpc('get_social_feed')
    .then(({ data }) => { window.__twFeed = Array.isArray(data) ? data : []; })
    .catch(() => { window.__twFeed = []; })
    .finally(() => { if (window.TraxWaxFeedCompute) window.TraxWaxFeedCompute(); if (window.TraxWaxRerender) window.TraxWaxRerender(); });
```

In `bootCrate()` (app.js), reset the compute flag at the top (near `_crateReady = false;`) and run a fallback compute before the
first render in case the RPC already resolved before app.js loaded:
```js
  window.__twFeedComputed = false;   // #59: recompute the feed choice for this (re)boot
```
…and just before the `render(); _crateReady = true;` pair:
```js
  if (window.TraxWaxFeedCompute) window.TraxWaxFeedCompute();   // #59: compute now if the feed RPC already resolved
```
Whichever of the two `feedCompute` calls sees `__twFeed` present first computes; the other no-ops via `__twFeedComputed`.

---

## 5. Strip render (`public/app.js`)

Add `_feedSentence` + `_feedDecorate` + `_feedHash` near the strip helpers (~L905). Copy strings MUST match §1 exactly (retain
"ALBUMS"):

```js
/* #59 — sentence + deep-link for a chosen feed event. Numeric counts + singular agreement (strip grammar §2.1). */
function _feedSentence(ev){
  const F = esc(String(ev.friend.name).split(' ')[0].toUpperCase());
  const n = ev.ids.length;
  switch(ev.type){
    case 'forsaleYouWant': return `${F} ADDED ${_sL(_pl(n,'ALBUM'),'openFriend')} FOR SALE THAT YOU WANT`;
    case 'theyWantYouSell': return `${F} WANTS ${_sL(_pl(n,'ALBUM'),'openFriend')} YOU'RE SELLING`;
    case 'theyWantYouHave': return `${F} WANTS ${_sL(_pl(n,'ALBUM'),'openFriend')} YOU HAVE`;
    case 'crateYouWant':   return `${F} ADDED ${_sL(_pl(n,'ALBUM'),'openFriend')} YOU WANT`;
    case 'crateYouOwn':    return `${F} ADDED ${_sL(_pl(n,'ALBUM'),'openFriend')} YOU OWN`;
    case 'mutualWant':     return n===1 ? `YOU AND ${F} BOTH WANT ${_sL('THE SAME ALBUM','openFriend')}`
                                        : `YOU AND ${F} BOTH WANT ${_sL(_cnt(n)+' OF THE SAME ALBUMS','openFriend')}`;
    case 'newFriend':      return _sL(F+' IS NOW YOUR FRIEND','openFriend');
    case 'openedCrate':    return _sL(F+' SHARED THEIR CRATE','openFriend');
    case 'openedForsale':  return _sL(F+' IS SELLING THEIR RECORDS NOW','openFriend');
    case 'openedWantlist': return _sL(F+' SHARED THEIR WANTLIST','openFriend');
  }
  return '';
}
/* deep-link: /app/{handle} + the view hash + the match param, so a click lands on the exact filtered view. */
const _FEED_TARGET = {
  forsaleYouWant: '#selling',                          // the GOODS view, matchSellingYouWant (existing #selling boot path)
  crateYouWant:   '?match=youWant',                    // their crate (default view) + youWant filter
  theyWantYouSell:'?match=theyWantSell#wantlist',      // their wantlist + the #3 split filter
  theyWantYouHave:'?match=theyWantHave#wantlist',      // their wantlist + the #4 split filter
  openedForsale:  '#forsale',                          // the GOODS view, unfiltered
  openedWantlist: '#wantlist',                         // their wantlist, unfiltered
  crateYouOwn: '', mutualWant: '', newFriend: '', openedCrate: '',   // their crate, unfiltered
};
function _feedDecorate(ev){
  ev.copy = _feedSentence(ev);
  ev.href = '/app/' + encodeURIComponent(ev.friend.handle || '') + (_FEED_TARGET[ev.type] || '');
  return ev;
}
```

In `stripHtml()` own branch (grep the `mode==='own'` block with `friendsClause`), replace the friendsClause/status construction
with a READ of `window.__twFeedActive` (no engine call here):
```js
  if(mode==='own'){
    const ev = window.__twFeedActive || null;   // computed once per load by feedCompute(); never recomputed on render
    let mid='';
    if (ev && ev.copy){
      const x = `<button data-act="feedDismiss" title="Dismiss" aria-label="Dismiss this update" style="margin-left:8px; padding:0 4px; background:none; border:0; color:rgba(255,255,255,.5); cursor:pointer; font-size:12px; line-height:1">✕</button>`;
      mid = ` · ${ev.copy}${x}`;
    } else {
      const fs = window.__twFriendStatus || null;
      if (fs) mid = fs.count===0
        ? ` · ${_sL('INVITE A FRIEND','accountFriends','Invite a friend — account settings')}`
        : ` · ${_sL(_pl(fs.count,'FRIEND'),'accountFriends','Friends — account settings')}`;
    }
    deskLeft = `${_sS('YOUR CRATE')}${mid}`;
    mobileRows = `<div class="tw-fs-row">${deskLeft}</div>`;
    actionsGap = '8px';
    right = `${_circle('copyCrateLink','Share my crate',ICO.share(17))}${lights}${_circle('account','Your account',ICO.gear(17))}`;
  }
```

Replace the dormant `openFriend` onClick stub (grep `case 'openFriend'`, reads `__twFriendStatus.event`) with:
```js
    case 'openFriend': { const ev=window.__twFeedActive; if(ev&&ev.href) window.location.href=ev.href; break; }   // #59 → the friend + its filter
    case 'feedDismiss': { const ev=window.__twFeedActive; if(ev&&ev.key) feedDismiss(ev.key); break; }
```
Both `_sL(..,'openFriend')` links resolve through `window.__twFeedActive.href` — safe because exactly one event shows at a time.

---

## 6. #3/#4 split filters — the smarter friend wantlist (`public/app.js` + boot.js)

Today `matchFilter ∈ {'youWant','theyWant',null}`, applied in `matches()` (~L307–316) against `window.__twMatchCtx`
(`viewerWants/Has` + master sets). Land `theyWantYouSell` vs `theyWantYouHave` on distinct, honest views.

**6a. Match ctx gains the CALLER's OWN inventory.** ⚠️ On a friend crate, `window.__twInventory` is the **FRIEND's** for-sale map
(app.js ~1978–1993; also wired to `__twMatchCtx.forSale`) — do NOT use it for the caller. The caller's own inventory comes from the
`TraxWaxInventory` provider (boot.js ~L257, scoped `.eq('user_id', profile.user_id)`), which today runs **only** under `IS_OWN()`.
In `TraxWaxMatchCtx` (boot.js, grep `TraxWaxMatchCtx =`) add a third pull — the caller's own `inventory_items` release_ids — and
expose them as `viewerSells` (+ `viewerSellsMasters`). Final ctx shape:
```js
  // ctx = { viewerWants:Set, viewerWantsMasters:Set, viewerHas:Set, viewerHasMasters:Set,
  //         viewerSells:Set, viewerSellsMasters:Set, forSale:Map|null(FRIEND's, unrelated) }
```
Fetch `viewerSells` with the same caller-scoped query `TraxWaxInventory` uses (own `inventory_items` where `status='for_sale'`),
mapped to a `Set` of `release_id` (and a `Set` of the joined `master_id` for any-mode). Do NOT read `__twInventory`.

**6b. Two filter modes** — in `matches()` replace the `theyWant` branch:
```js
    } else if(s.matchFilter==='theyWant' || s.matchFilter==='theyWantSell' || s.matchFilter==='theyWantHave'){
      const has = (ctx.viewerHas && ctx.viewerHas.has(r.id)) || (any && r.master_id && ctx.viewerHasMasters && ctx.viewerHasMasters.has(r.master_id));
      if(!has) return false;
      const sells = (ctx.viewerSells && ctx.viewerSells.has(r.id)) || (any && r.master_id && ctx.viewerSellsMasters && ctx.viewerSellsMasters.has(r.master_id));
      if(s.matchFilter==='theyWantSell' && !sells) return false;   // #3 — narrowed to what you're selling
      if(s.matchFilter==='theyWantHave' && sells)  return false;   // #4 — you have, NOT listed
    }
```

**6c. Whitelist the new params** where `?match=` is parsed into `state.matchFilter` (grep `p.get('match')`, ~L873):
```js
      const m=p.get('match'); if((m==='youWant'||m==='theyWant'||m==='theyWantSell'||m==='theyWantHave') && !IS_OWN() && window.__twMatchCtx) state.matchFilter=m;
```
No new onClick cases are needed: the feed navigates by deep-link (`/app/{handle}?match=theyWantSell#wantlist`), and `bootCrate`
applies `?match=` on load via `_applyUrlFilters` while the `#wantlist` hash selects the wantlist tab (and triggers the existing
friend-wantlist lazy-load). The MATCH active-chip label (grep `kind==='MATCH'`, ~L723) should map the two new values to readable
text, e.g. `theyWantSell` → `THEY WANT · YOU SELL`, `theyWantHave` → `THEY WANT · YOU HAVE`.

**6d. Friend-wantlist boot view.** Confirm a friend-crate `#wantlist` boot is permitted — gated by `CAN_VIEW_WANTLIST()` /
`_viewLocked('wantlist')` (app.js ~L77), not a tab-name list; when the owner shares their wantlist it's a valid boot view and
`bootCrate` lazy-loads `WANTLIST_RECORDS` for it. (There is no `_validTabs` symbol — do not reference one.)

**6e. (Out of scope, note only)** a "they want 6 of yours — 2 selling, 4 unlisted" summary line on the friend wantlist is a nice
follow-up; not part of #59 v1.

---

## 7. CSS

No new rules — the strip already wraps a long sentence (`.tw-fs-desktop{flex:1;min-width:0}`) and the ✕ is inline. Confirm mobile
still wraps to `.tw-fs-row` without horizontal overflow.

---

## 8. Decisions for Lane

- **D1 — first-baseline = silent prime** (recommended; §3 priming block, now race-guarded). Alt "welcome flood" = delete the
  priming block. Rec: silent.
- **D2 — dual TTL 7d activity / 30d milestone, timer from first display.** (Locked.)
- **D3 — pool cap 5, reload-driven rotation, ✕ dismiss.** (Locked.)

---

## 9. Verification (expected output)

1. Migration applies clean; `get_social_feed()` returns one object/friend, `[]` where consent off; cross-check one array vs a hand
   intersection (§2).
2. `node --check public/app.js && node --check public/boot.js` → clean.
3. Render harness (node): stub `window.__twFeed=[{user_id:'u',discogs_username:'tommy',display_name:'Tommy',can_crate:true,
   can_want:true,can_forsale:true,forsale_you_want:['111','222'],crate_you_want:[],they_want_you_sell:[],they_want_you_have:[],
   crate_you_own:[],mutual_want:[]}]`, empty localStorage → first `feedCompute()` primes (`__twFeedActive===null`, `primed:true`).
   Then flip localStorage to a primed baseline WITHOUT `111/222` and `__twFeedComputed=false`, recompute → `__twFeedActive.copy ===
   'TOMMY ADDED 2 ALBUMS FOR SALE THAT YOU WANT'` with one underlined count link + a ✕.
4. Idempotence: two `feedCompute()` calls in one load → the second no-ops (`__twFeedComputed`), rotation index advances at most once.
5. Dismiss: `feedDismiss(key)` → `__twFeedActive===null`; a fresh compute with a NEW id in that set re-activates it.
6. `#3/#4`: on a friend crate, `?match=theyWantSell#wantlist` shows only their-wanted records you have that ARE in YOUR inventory;
   `theyWantHave` only those NOT in your inventory; disjoint; union = old `theyWant`.
7. `grep -n "__twFriendStatus.event" public/*.js` → 0.

---

## 10. Build order

1. Migration 0033 (break-glass) + post-verify (§2).
2. app.js engine (§3) + `_feedSentence`/`_feedDecorate`/`_feedHash` (§5) — `node --check`.
3. boot.js feed fetch + `feedCompute` wiring (§4) + `bootCrate` reset/fallback-compute.
4. app.js strip render + onClick (§5).
5. #3/#4 split: `viewerSells` in `TraxWaxMatchCtx` (boot.js) + `matches()` modes + `?match=` whitelist + MATCH chip labels (§6).
6. `node --check`, render-harness checks (§9), then `remediation-audit` (Pass 1 + narrow Pass 2) to convergence.
7. Version (minor → 1.25.0), CHANGELOG, log, close #59, git handoff. Disarm break-glass.

---

## Verification-pass findings log (addressed 2026-09-06)

Recorded so nothing silently re-litigates. All fixed in this revision unless noted.

- **C1 — `releases.id` → `releases.release_id`** (PK is `release_id`; the migration wouldn't apply). Fixed: all joins key on
  `release_id`.
- **C2 — helper functions must be created BEFORE `get_social_feed`** (`check_function_bodies`). Fixed: helpers first.
- **C3 — `private`-schema rename contradiction.** Fixed: helpers declared in `private` from the start; `get_social_feed` calls them
  fully qualified. One source of truth.
- **C4 — priming raced the async feed → first-load flood.** Fixed: `feedCompute` runs once per load, guarded by
  `if(!Array.isArray(feed)) return;` above priming; only runs after the RPC resolves.
- **H1 — copy dropped "ALBUMS" vs Lane's approved catalog, inconsistently.** Fixed: "ALBUMS" retained in all count events (§1 + §5
  + §9 harness aligned).
- **H2 — `feedPick` mutated state on every render → message flipped on any interaction.** Fixed: split into `feedCompute` (once per
  load, mutates) + `stripHtml` (reads `__twFeedActive`, never mutates).
- **H3 — `viewerSells` must come from the CALLER's inventory, not the friend's `__twInventory`.** Fixed: §6a specifies the
  caller-scoped `TraxWaxInventory` query and warns off `__twInventory`.
- **M1 — "11 types" → 10** (event 10 deferred, 12/13 dropped). Fixed throughout.
- **M2 — false "flag off→on re-fires" claim.** Fixed: §3.4 now states it does NOT re-fire in v1 (known limit).
- **M3 — sample onClick invented `_closeAndRender` + omitted the wantlist lazy-load.** Resolved by dropping the new onClick cases
  entirely (§6c) — the feed uses the deep-link boot path, which already lazy-loads the friend wantlist.
- **M4 — wrong grant justification.** Fixed: grants stated to match the real `can_view_*` (authenticated + service_role), not
  "dropped."
- **L1 — dead CTEs (`mm`, `my_wants/crate/inv`).** Fixed: removed; the helpers self-contain their sets.
- **L2 — `_validTabs` doesn't exist** → `_viewLocked` / `CAN_VIEW_WANTLIST` (§6d). Fixed.
- **L3 — new `matchTheyWantSell/Have` onClick cases were dead-on-arrival.** Fixed: dropped (deep-link path only); `matches()`
  modes + `?match=` whitelist are what's needed.
</content>
