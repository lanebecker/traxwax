# Cold audit — Wave 4 plan (performance + modal a11y)

Status: **EXECUTED — shipped as v1.9.1 (2026-09-01).** Verification-pass clean (2 plan-doc fixes applied
pre-build); build + remediation-audit Pass-1 (2 introduced defects fixed) + Pass-2 (clean) converged; one
pre-existing finding filed as #48. Frontend only (`public/app.js`) — no break-glass, no migration, no Edge
change.

## Scope

- **#44** — opening a record rebuilds the entire card grid ~3×. `render()` builds one big `html` string
  (header + filterbar + tabs + grid + `${modalHtml()}`) and swaps it all into `#app`; a single record-open
  fires `render()` three times (`openDetail`, then `_loadStats`, then `_loadRelease`), each recomputing
  `computeVals()` and re-parsing every card. **Fix:** extract the modal into its own body-level container so
  opening/updating it never touches the grid; re-route the six modal-only `render()` calls to a new
  `renderModal()`.
- **#37 (modal-inert sub-item)** — the modal couldn't be made `inert`-isolated while it shared `#app` with
  the grid. Once the modal is its own container, set `#app` `inert` + `aria-hidden` while a modal is open.
  This closes the last open piece of #37 (the search-label already shipped; tap-targets/FOUC remain your
  design call, tracked in #37).

**Explicitly out of scope (deliberate non-goals):** rAF-coalescing `render()` and memoizing the grid HTML.
The container split removes the pathological case (3× grid rebuild on modal open). Coalescing `render()`
into a frame batch would make the render heart async and risk subtle focus/caret/roving timing bugs — high
risk, low remaining value once the modal is split out. Note this in the #44 close.

---

## The design

- A single body-level `<div id="tw-modal-root">` (created lazily, exactly like `#tw-toast`/`#tw-remove-snack`)
  holds the modal overlay. It is a sibling of `#app`, NOT a child — so a `boot.js` `#app` reset never wipes
  it, and `#app` can be made `inert` while the modal lives beside it.
- `render()` becomes **shell-only**: it drops the trailing `${modalHtml()}`, keeps its search-caret capture/
  restore and `_syncGridRoving()`, and ends by calling `renderModal()` (cheap — `modalHtml()` returns `''`
  when nothing is open).
- `renderModal()` (new) captures modal focus, swaps `#tw-modal-root.innerHTML = modalHtml()`, toggles `#app`
  `inert`/`aria-hidden` on `state.detailId`, and runs `_syncModalFocus()`.
- The six modal-only actions call `renderModal()` directly, leaving the grid DOM untouched.
- `onClick` (document-level) and `onKeydown` (window-level) already catch events from anywhere, so the
  body-level modal needs no new listeners.

---

## Task 1 — add `renderModal()` (new function)

In `public/app.js`, add this function immediately BEFORE `function render(){` (currently ~line 502):

```js
/* #44 + #37: the detail modal renders into its OWN body-level container (a sibling of #app, like the
   toast/snackbar), so opening or updating it never rebuilds the card grid, and #app can be made inert
   beside it. render() (shell) calls this at its end; the six modal-only actions call it directly. */
function renderModal(){
  let root = document.getElementById('tw-modal-root');
  if (!root){ root = document.createElement('div'); root.id = 'tw-modal-root'; document.body.appendChild(root); }
  // Capture focus inside the modal BEFORE replacing it, so _syncModalFocus can restore the same control.
  const ae = document.activeElement;
  _modalFocusKey = null;
  if (state.detailId && ae && ae.closest && ae.closest('.tw-modal-ov')) {
    _modalFocusKey = { act: ae.getAttribute('data-act'), arg: ae.getAttribute('data-arg'), href: ae.getAttribute('href') };
  }
  root.innerHTML = modalHtml();   // '' when state.detailId is null → the modal is removed
  // #37: while the modal is open, the shell is inert + hidden from assistive tech; the modal (beside #app)
  // stays interactive, as do the body-level toast/snackbar.
  const app = document.getElementById('app');
  if (app){
    if (state.detailId){ app.inert = true; app.setAttribute('aria-hidden', 'true'); }
    else { app.inert = false; app.removeAttribute('aria-hidden'); }
  }
  _syncModalFocus();
}
```

---

## Task 2 — `render()`: drop the inline modal, end with `renderModal()`

### 2a — remove `${modalHtml()}` from the shell html

`render()`'s html template currently ends (app.js ~658) with the footer then the modal. Find:
```js
  </footer>
  ${modalHtml()}`;
```
(the exact trailing lines of the `html` template literal — the `</footer>` close followed by
`` ${modalHtml()}`; ``). Replace with just the footer close and end the template:
```js
  </footer>`;
```
So `#app` no longer contains the modal.

### 2b — remove the modal-focus capture from `render()` (it moves into `renderModal()`)

`render()`'s tail contains the modal-focus capture (app.js ~669–677). Find EXACTLY (the interior `// W0.4`
comment is part of the file — include it or the Edit will not match):
```js
  const _caret=_wasSearch ? _ae.selectionStart : null;
  // W0.4: if focus is inside the open modal, remember WHICH control (by act+arg, or href for
  // links) so _syncModalFocus can put it back after the innerHTML swap wipes activeElement to
  // <body>. Without this, every async stats/tracklist re-render yanked focus back to ✕.
  _modalFocusKey = null;
  if (state.detailId && _ae && _ae.closest && _ae.closest('.tw-modal-ov')) {
    _modalFocusKey = { act:_ae.getAttribute('data-act'), arg:_ae.getAttribute('data-arg'), href:_ae.getAttribute('href') };
  }
  app.innerHTML=html;
```
Replace with:
```js
  const _caret=_wasSearch ? _ae.selectionStart : null;
  app.innerHTML=html;   // shell only — the modal lives in #tw-modal-root now (renderModal owns its focus capture)
```
(The search-caret capture/restore above and below this is unchanged — it belongs to the shell.)

### 2c — end `render()` with `renderModal()` instead of `_syncModalFocus()`

Find EXACTLY (the `// A11y (W0.4)` comment is part of the file):
```js
  // A11y (W0.4): re-establish roving tabindex, then modal focus. Roving first so the modal's
  // focus-restore target (the invoking cover cell) is tabbable when we hand focus back to it.
  _syncGridRoving();
  _syncModalFocus();
}
```
Replace with:
```js
  // A11y (W0.4): re-establish grid roving tabindex first (so the modal's focus-restore target — the
  // invoking cover cell — is tabbable), then renderModal() handles the modal DOM + its focus + shell inert.
  _syncGridRoving();
  renderModal();
}
```

---

## Task 3 — re-route the six modal-only `render()` calls to `renderModal()`

Each of these changes ONLY modal state (`state.detailId`, `rec._rel`, `rec._relErr`, `rec._stats`), so it
must not rebuild the grid.

1. **onKeydown Escape** (app.js ~852):
   `if (e.key==='Escape'){ state.detailId=null; render(); return; }`
   → `if (e.key==='Escape'){ state.detailId=null; renderModal(); return; }`

2. **openDetail** (app.js ~895): the lone `render();` after setting `state.detailId=id` →
   `renderModal();`

3. **_loadRelease** (app.js ~908):
   `if(state.detailId===rec.id) render();`
   → `if(state.detailId===rec.id) renderModal();`

4. **_loadStats** (app.js ~922):
   `if(state.detailId===rec.id) render();`
   → `if(state.detailId===rec.id) renderModal();`

5. **case 'retryDetail'** (app.js ~1142):
   `case 'retryDetail': { const r=recordById(state.detailId); if(r){ r._relErr=false; render(); _loadRelease(r); } break; }`
   → replace the inner `render()` with `renderModal()`:
   `case 'retryDetail': { const r=recordById(state.detailId); if(r){ r._relErr=false; renderModal(); _loadRelease(r); } break; }`

6. **case 'closeDetail'** (app.js ~1146):
   `case 'closeDetail': state.detailId=null; render(); break;`
   → `case 'closeDetail': state.detailId=null; renderModal(); break;`

**Do NOT change** the grid-affecting closers that also clear the modal — `case 'artist'` (~1139),
`case 'color'` (~1140), `case 'detailGenre'` (~1143): they set `state.detailId=null` AND change the grid
(filter), so they must stay `render()` (which now also calls `renderModal()` → clears the modal + inert).
Same for `friendAdd`/`friendRemove`/`removeWant`/`_refreshMatchCounts` — they change grid cards (badges/
meta) and stay on `render()`; the trailing `renderModal()` refreshes the open modal's control too.

---

## Task 3b — defensive: reset modal state on (re)boot

`bootCrate` writes `#app.innerHTML` directly for its loading/error placeholders (app.js ~1224, ~1251),
bypassing `renderModal()`. Not reachable in the normal flow (at boot `state.detailId` is null and a fresh
page has `inert` unset), but to make a mid-session re-boot safe, add — at the TOP of `bootCrate`, right
after the existing `WANTLIST_RECORDS=null;` reset:
```js
  state.detailId = null;   // #44/#37: never inherit a stale open modal across a (re)boot
  { const _a = document.getElementById('app'); if (_a){ _a.inert = false; _a.removeAttribute('aria-hidden'); } }
  { const _m = document.getElementById('tw-modal-root'); if (_m) _m.innerHTML = ''; }
```

## Task 4 — verify (no functional test harness; manual + reasoning)

```
cd "<repo>/public" && node --check app.js
```
Expected: no output / your echoed OK. Any SyntaxError fails the task.

Grep checks:
```
grep -n "renderModal" app.js        # expect: def + the render() tail call + 6 modal-only call sites (+ any)
grep -n "\${modalHtml()}" app.js    # expect: NONE (removed from the shell html)
grep -n "modalHtml()" app.js        # expect: only inside renderModal()
grep -n "\.inert" app.js            # expect: the two lines in renderModal()
```

Manual walkthrough after deploy (the real proof — perf + a11y):
- Open a record on THE CRATE: the modal appears, the grid does NOT flicker/rebuild (watch the cards; with
  DevTools Performance, one record-open should no longer show three full re-layouts of the grid).
- Tracklist + stats fill into the open modal without the grid moving.
- Close via ✕, backdrop click, and Escape — modal disappears, focus returns to the invoking card.
- While the modal is open, Tab stays trapped in the modal and the background is not reachable by
  screen-reader/keyboard (`#app` is `inert`); the undo snackbar (if shown) is still reachable.
- Friend crate: `+ WANT`/`✕ REMOVE` from inside the modal flips the modal's control AND the card's
  strip/meta behind it (shell render + `renderModal()`), modal stays open, focus preserved.
- Wantlist tab: removing from the modal closes it (detailId cleared) and drops the card; undo works.
- Genre/color/artist chips inside the modal (`detailGenre`, `artist`, `color`) close the modal and filter
  the grid.

---

## Rollback

Frontend-only and additive-in-shape. Revert the `app.js` commit: put `${modalHtml()}` back at the end of
the `html` template, restore the `_modalFocusKey` capture + `_syncModalFocus()` in `render()`'s tail, change
the six call sites back to `render()`, and drop `renderModal()`. No data/DB/Edge involved.

## Audit plan

After build, before commit: independent pass-1 adversarial audit — the six re-routed calls are all truly
modal-only (no grid state touched); the grid-affecting closers (artist/color/detailGenre) + the want
handlers correctly stay on `render()` and their trailing `renderModal()` clears/refreshes the modal; focus
plumbing intact (open focuses the modal, close returns to the invoker, Tab-trap works); `#app` `inert`
toggles correctly and never gets stuck on (every close path clears it); the body-level modal-root doesn't
get orphaned by a `boot.js`/`bootCrate` `#app` reset; no synchronous post-`render()` DOM read broke. Narrow
pass to convergence (run it by default — don't wait to be asked).
