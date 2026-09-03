# Account /friends redesign — the SPLIT + the 1c visibility box — plan

Status: EXECUTED — shipped as v1.15.0 (2026-09-03). Verification-pass folded the padding fix (8px 12px to
match the shipped MATCHING control, Lane-approved); adversarial audit Pass-1 CLEAN (42 jsdom assertions,
per-shelf dep mapping proven not-swapped). Frontend only (`public/boot.ui.js` + two small
`public/boot.js` edits). **No backend, no migration, no break-glass** — the data mapping is the same
`'friends'`/`'private'` values the toggles set today. Design source of record:
`Design/traxwax-account-page-redesign/account-friends-redesign/ACCOUNT-FRIENDS-REDESIGN-SPEC.md`
(+ `screenshots/`). Lane's call: **option 1c** (per-shelf PRIVATE ▸ FRIENDS segmented). Target **v1.15.0**
(new feature surface). Base: current committed tree (v1.14.1 pending Lane's push; this stacks on it).

## What changes
1. **The split:** a new **SHARING** nav item (between FRIENDS and DISCOGS) holds crate + wantlist visibility
   AND the matching control. FRIENDS slims to just its intro, the invite tool, and the friends list.
2. **The box (1c):** the two butted visibility toggle-boxes become ONE bordered container with a caption row
   and two hairline-separated shelf rows, each with a **PRIVATE ▸ FRIENDS segmented control** — the same
   segmented vocabulary as the MATCHING control right below it.

## Mechanism note (why the wiring is simple)
`bindAccountPage()` runs ONCE for the whole account page regardless of which section rendered; every wire fn
(`wireMatchSeg`, etc.) guards on element presence (`if (!seg) return`). So moving the visibility/matching
markup to the sharing section needs NO structural "move the binding" — the wires just target the markup
wherever it renders. We replace the two toggle wires with segment wires and keep the match wire as-is.

---

## Task 1 — NAV: add the SHARING item (`public/boot.ui.js` ~line 259)

FIND:
```js
const NAV = [
  { id: 'profile', label: 'PROFILE' },
  { id: 'friends', label: 'FRIENDS' },   // ▸ Wave 1 — live (crate-sharing toggle lives here too, v1.4.1)
  { id: 'discogs', label: 'DISCOGS' },
  { id: 'danger', label: 'DANGER ZONE', danger: true, target: 'discogs' },
];
```
REPLACE:
```js
const NAV = [
  { id: 'profile', label: 'PROFILE' },
  { id: 'friends', label: 'FRIENDS' },   // ▸ Wave 1 — the invite + friends list (v1.15.0: settings moved to SHARING)
  { id: 'sharing', label: 'SHARING' },   // v1.15.0: crate/wantlist visibility + matching
  { id: 'discogs', label: 'DISCOGS' },
  { id: 'danger', label: 'DANGER ZONE', danger: true, target: 'discogs' },
];
```
(`accountNav()` renders NAV generically — a real section id like `sharing` becomes a normal `<a href>` to
`o.hrefFor('sharing')`, active-highlighted when `active === 'sharing'`. No accountNav change needed.)

---

## Task 2 — allow + route the `sharing` section

### 2a — `public/boot.js` valid-section list (~line 899)
FIND:
```js
    const valid = ['profile', 'friends', 'discogs'];   // Wave 1: friends live (sharing merged into it, v1.4.1)
```
REPLACE:
```js
    const valid = ['profile', 'friends', 'sharing', 'discogs'];   // v1.15.0: SHARING split back out of friends
```

### 2b — `public/boot.ui.js` `accountPageHtml()` router guard + branch (~line 624 and ~648)
FIND:
```js
  const section = ['discogs', 'friends'].includes(o.section) ? o.section : 'profile';
```
REPLACE:
```js
  const section = ['discogs', 'friends', 'sharing'].includes(o.section) ? o.section : 'profile';
```
FIND:
```js
      (section === 'discogs' ? discogsSection(o)
        : section === 'friends' ? friendsSection(o)
        : profileSection(o)) +
```
REPLACE:
```js
      (section === 'discogs' ? discogsSection(o)
        : section === 'friends' ? friendsSection(o)
        : section === 'sharing' ? sharingSection(o)
        : profileSection(o)) +
```

---

## Task 3 — slim `friendsSection(o)` (`public/boot.ui.js` ~line 434)

REPLACE the ENTIRE `friendsSection` function (from `function friendsSection(o) {` through its closing `}`
at the `}` after the `#tw-friends-list` div — currently lines 434–524) with:
```js
function friendsSection(o) {
  return '' +
  '<div style="padding:28px 30px 34px; display:flex; flex-direction:column; gap:22px">' +
    // Intro: eyebrow + title + one description line. Settings moved to SHARING (v1.15.0).
    '<div style="display:flex; flex-direction:column; gap:5px">' +
      '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; ' +
        'color:var(--accent)">FRIENDS</span>' +
      '<h2 style="' + COND + '; font-size:32px; font-weight:700; line-height:1; margin:0; ' +
        'color:var(--ink)">The people you swap crates with</h2>' +
      '<span style="' + BODY + '; font-size:13px; line-height:1.65; color:var(--muted)">' +
        'Send a link to add someone. Manage who sees your shelves over in ' +
        '<a href="' + esc(o.hrefFor('sharing')) + '" style="color:var(--accent); text-decoration:underline">Sharing</a>.</span>' +
    '</div>' +

    // ── INVITE A FRIEND — the link tool, boxed with its caption. (Unchanged from before.)
    sectionLabel('INVITE A FRIEND') +
    '<div style="border:1.5px solid var(--line); padding:16px 18px; display:flex; ' +
      'flex-direction:column; gap:12px">' +
      '<span style="' + BODY + '; font-size:12.5px; line-height:1.6; color:var(--muted)">' +
        'Create a one-time link and send it to someone. When they open it, they’re added to your ' +
        'friends list below.</span>' +
      '<div id="tw-friends-msg" role="status" aria-live="polite" style="' + MONO + '; ' +
        'font-size:11.5px; line-height:1.6; color:var(--accent); min-height:0"></div>' +
      '<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">' +
        '<button id="tw-invite-btn" style="' + btnStyle('primary') + '">CREATE AN INVITE LINK</button>' +
        '<input id="tw-invite-link" readonly style="' + MONO + '; font-size:12px; padding:9px 11px; ' +
          'flex:1; min-width:280px; border:1.5px solid var(--hair); background:var(--bar); ' +
          'color:var(--ink); text-overflow:ellipsis; display:none">' +
        '<button id="tw-invite-copy" style="' + btnStyle('secondary') + '; display:none">COPY</button>' +
      '</div>' +
      '<span id="tw-invite-life" style="' + MONO + '; font-size:10px; letter-spacing:.06em; ' +
        'color:var(--faint); display:none">Works once · expires in 14 days</span>' +
    '</div>' +

    // ── YOUR FRIENDS · N — the list, one container, heading carries a live count.
    '<div id="tw-friends-head">' +
      sectionLabel('YOUR FRIENDS · <span id="tw-friends-count" style="color:var(--accent)">—</span>') +
    '</div>' +
    '<div id="tw-friends-list"></div>' +
  '</div>';
}
```
What left `friendsSection`: the `vis`/`on`/`wlOn`/`mm` consts, the `#tw-share-msg` line, the VISIBILITY block
(both toggle rows), the MATCHING block + its helper line. What stayed verbatim: the invite tool
(`#tw-invite-btn`/`#tw-invite-link`/`#tw-invite-copy`/`#tw-invite-life`/`#tw-friends-msg`) and the friends
list (`#tw-friends-head`/`#tw-friends-count`/`#tw-friends-list`). New intro copy per spec §1.2.

---

## Task 4 — new `sharingSection(o)` + `visSegBtn` helper (`public/boot.ui.js`)

INSERT immediately AFTER the (now-slimmed) `friendsSection` closing `}` and BEFORE the `segBtn` definition
(so both live together). Two new functions:

```js
/* v1.15.0: one PRIVATE ▸ FRIENDS segment for the 1c visibility control. Same idiom as segBtn (the MATCHING
   control), keyed on data-vis (the value 'private'|'friends'). The wire re-styles on click. */
function visSegBtn(v, label, cur) {
  const on = cur === v;
  return '<button data-vis="' + v + '" aria-pressed="' + on + '" style="' + MONO + '; font-size:10.5px; ' +
    'letter-spacing:.06em; padding:8px 12px; border:0; cursor:pointer; ' +
    (on ? 'background:var(--ink); color:var(--panel)' : 'background:var(--panel); color:var(--muted)') + '">' + label + '</button>';
}
// NOTE: padding is 8px 12px to be PIXEL-IDENTICAL to the shipped MATCHING segBtn (boot.ui.js:530), so the
// two segmented controls on the SHARING tab read as one language — the actual intent of spec §1c ("same
// markup as segBtn"). The spec's literal "8px 14px" is an internal inconsistency (segBtn is 8px 12px); we
// match the shipped control rather than touch it. Flag to Lane; he can choose 14px-on-both if he prefers.

/* v1.15.0 (the SPLIT): crate + wantlist visibility (1c segmented box) + the matching control, moved out of
   FRIENDS. Reads o.profile.{crate_visibility, wantlist_visibility, match_mode}. Bare helper names (this is
   inside boot.ui.js; `UI` is boot.js's import alias). */
function sharingSection(o) {
  const crateVis = ((o.profile && o.profile.crate_visibility) || 'private');   // 'friends' | 'private'
  const wlVis    = ((o.profile && o.profile.wantlist_visibility) || 'private');
  const mm       = (o.profile && o.profile.match_mode) || 'exact';             // #28: matching preference
  const rowTitle = (t) => '<span style="' + COND + '; font-size:21px; font-weight:700; line-height:1; color:var(--ink)">' + t + '</span>';
  const rowSub   = (t) => '<span style="' + MONO + '; font-size:10px; color:var(--muted)">' + t + '</span>';
  return '' +
  '<div style="padding:28px 30px 34px; display:flex; flex-direction:column; gap:22px">' +
    // Intro.
    '<div style="display:flex; flex-direction:column; gap:5px">' +
      '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.18em; ' +
        'color:var(--accent)">SHARING</span>' +
      '<h2 style="' + COND + '; font-size:32px; font-weight:700; line-height:1; margin:0; ' +
        'color:var(--ink)">Who sees what, and how matches read</h2>' +
      '<span style="' + BODY + '; font-size:13px; line-height:1.65; color:var(--muted)">' +
        'Your shelves are private by default. Open them to the friends you’ve added — prices never appear ' +
        'on anyone else’s crate. Change it back any time.</span>' +
    '</div>' +
    // Shared status line (visibility changes announce here — moved from FRIENDS).
    '<div id="tw-share-msg" role="status" aria-live="polite" style="' + MONO + '; font-size:11.5px; ' +
      'line-height:1.6; color:var(--accent); min-height:0"></div>' +

    // ── VISIBILITY — the 1c box: one container, caption row, two hairline-separated shelf rows.
    sectionLabel('VISIBILITY') +
    '<div style="border:1.5px solid var(--line)">' +
      '<div style="padding:11px 18px; border-bottom:1px solid var(--hair)">' +
        '<span style="' + MONO + '; font-size:9.5px; font-weight:700; letter-spacing:.16em; ' +
          'color:var(--muted)">WHO CAN SEE YOUR SHELVES</span>' +
      '</div>' +
      // crate row
      '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 18px">' +
        '<div style="display:flex; flex-direction:column; gap:3px">' + rowTitle('My crate') + rowSub('The records you own') + '</div>' +
        '<div id="tw-vis-crate-seg" role="group" aria-label="Crate visibility" style="display:flex; ' +
          'border:1.5px solid var(--line); flex:none">' +
          visSegBtn('private', 'PRIVATE', crateVis) + visSegBtn('friends', 'FRIENDS', crateVis) +
        '</div>' +
      '</div>' +
      // wantlist row (hairline between)
      '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 18px; ' +
        'border-top:1px solid var(--hair)">' +
        '<div style="display:flex; flex-direction:column; gap:3px">' + rowTitle('My wantlist') + rowSub('The records you’re hunting') + '</div>' +
        '<div id="tw-vis-wl-seg" role="group" aria-label="Wantlist visibility" style="display:flex; ' +
          'border:1.5px solid var(--line); flex:none">' +
          visSegBtn('private', 'PRIVATE', wlVis) + visSegBtn('friends', 'FRIENDS', wlVis) +
        '</div>' +
      '</div>' +
    '</div>' +

    // ── MATCHING — moved verbatim from friends (#28). Same segmented idiom → the tab reads as one language.
    sectionLabel('MATCHING') +
    '<div style="display:flex; align-items:center; justify-content:space-between; gap:16px; ' +
      'border:1.5px solid var(--line); padding:16px 18px">' +
      '<div style="display:flex; flex-direction:column; gap:3px">' +
        '<span style="' + COND + '; font-size:21px; font-weight:700; line-height:1; ' +
          'color:var(--ink)">How overlaps are counted</span>' +
        '<span style="' + MONO + '; font-size:10.5px; color:var(--muted)">' +
          'Changes how you read matches on everyone’s crate. Doesn’t change what you add.</span>' +
      '</div>' +
      '<div id="tw-match-seg" role="group" aria-label="Matching mode" style="display:flex; ' +
        'border:1.5px solid var(--line); flex:none">' +
        segBtn('exact', 'EXACT PRESSING', mm) + segBtn('any', 'ANY PRESSING', mm) +
      '</div>' +
    '</div>' +
    '<span style="' + MONO + '; font-size:10px; line-height:1.6; color:var(--faint); margin-top:-12px">' +
      'EXACT — the same pressing on both lists (the default). ANY — any pressing of the same album counts.</span>' +
  '</div>';
}
```

---

## Task 5 — bindAccountPage wires (`public/boot.ui.js` ~line 758–823)

### 5a — REPLACE `wireVisToggle` + `wireWlVisToggle` with ONE generic segment wire
FIND the two functions `function wireVisToggle() { … }` and `function wireWlVisToggle() { … }`
(lines ~760–798, the block from the `// ── Wave 1: SHARING toggle ──` comment through the close of
`wireWlVisToggle`). REPLACE both with:
```js
  // v1.15.0 (1c): the per-shelf PRIVATE ▸ FRIENDS segmented control — click-delegated on its container.
  // `setter` is the visibility dep for that shelf; `label` names it in the status line. Same restyle idiom
  // as wireMatchSeg. Writes 'private'|'friends' — the exact values the old toggles set.
  function wireVisSeg(segId, setter, label) {
    const seg = root.querySelector('#' + segId);
    if (!seg) return;
    seg.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-vis]');
      if (!b) return;
      const next = b.getAttribute('data-vis');   // 'private' | 'friends'
      const smsg = (t) => { const el = $('tw-share-msg'); if (el) el.textContent = t || ''; };
      try {
        await setter(next);
        seg.querySelectorAll('[data-vis]').forEach((x) => {
          const isOn = x.getAttribute('data-vis') === next;
          x.setAttribute('aria-pressed', isOn);
          x.style.background = isOn ? 'var(--ink)' : 'var(--panel)';
          x.style.color = isOn ? 'var(--panel)' : 'var(--muted)';
        });
        smsg(next === 'friends' ? ('Friends can now see your ' + label + '.') : ('Your ' + label + ' is private again.'));
      } catch (e) { smsg('Couldn’t change that: ' + ((e && e.message) || e)); }
    });
  }
```
(`wireMatchSeg` — lines ~801–820 — is UNCHANGED. It targets `#tw-match-seg`, now in the sharing section;
the section-agnostic bind still finds it.)

### 5b — REPLACE the wire-invocation block
FIND:
```js
  wireVisToggle();
  wireWlVisToggle();
  wireMatchSeg();
```
REPLACE:
```js
  wireVisSeg('tw-vis-crate-seg', deps.onSetVisibility, 'crate');
  wireVisSeg('tw-vis-wl-seg', deps.onSetWantlistVisibility, 'wantlist');
  wireMatchSeg();
```
(`deps.onSetVisibility` / `deps.onSetWantlistVisibility` / `deps.onSetMatchMode` are unchanged in
`boot.js`'s `renderAccount` → `bindAccountPage` deps object — signatures identical, only the control that
calls them changed. No `boot.js` deps edit needed beyond Task 2a.)

---

## Post-build verification
- `node --check public/boot.js && node --check public/boot.ui.js` → both OK.
- `grep -n "wireVisToggle\|wireWlVisToggle\|tw-vis-toggle\|tw-wlvis-toggle\|tw-vis-sub\|tw-wlvis-sub" public/boot.ui.js`
  → **zero** matches (the toggle path is fully retired).
- `grep -c "sharingSection\|visSegBtn\|tw-vis-crate-seg\|tw-vis-wl-seg\|wireVisSeg" public/boot.ui.js` → present.
- Live check on `/account/sharing` (both themes): nav shows PROFILE · FRIENDS · SHARING · DISCOGS · DANGER
  ZONE; SHARING renders the 1c box + MATCHING; clicking a segment persists + restyles + announces in
  `#tw-share-msg`; FRIENDS shows only intro + invite + list; `/account/friends` and deep-link
  `/account/sharing` both route; the "Sharing" link in the FRIENDS body navigates to the tab.

## Audit plan
remediation-audit Pass-1 (break this): the two allowlists both include 'sharing' (no 404/route-to-profile);
`visSegBtn`/segments write the correct 'private'|'friends' via the right dep per shelf (crate↔onSetVisibility,
wantlist↔onSetWantlistVisibility — not swapped); default-state highlight matches the persisted value; the
retired toggle wires leave no dangling reference; `#tw-share-msg` exists on the sharing section (the wires'
status line resolves); friends still renders invite+list with no missing-element errors; XSS-safe (all
copy static; `o.hrefFor('sharing')` esc'd); light+dark via tokens. Narrow Pass-2 over rework. Converge.
