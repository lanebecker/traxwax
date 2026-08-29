repo: lanebecker/traxwax
branch: main

## Last sync

date: 2026-08-29T16:40:00Z

### Updated in this project

- Designed all 20 non-crate surfaces (landing, auth chrome, 9 system states, account page, empty crate) as `TraxWax Surfaces.dc.html`.
- Produced `implementation/` — spec, drop-in landing page, `boot.ui.js` shell system, CSS additions, Clerk appearance, ordered `boot.js` edit list.
- Promoted the account modal to an `/app/account` route; flagged the reserved-word collision with the `/app/<username>` grammar.
- Recorded 9 roadmap accommodations (Waves 1–5) so later waves are data changes, not redesigns.

## Screen map

| Project screen | Repo files |
|---|---|
| TraxWax Surfaces.dc.html — S1 landing | public/index.html |
| TraxWax Surfaces.dc.html — S2–S12 states | public/boot.js (`notice`, `mountAuth`, `runImport`, `render`) |
| TraxWax Surfaces.dc.html — S13–S16 account | public/boot.js (`openAccountModal`) |
| TraxWax Surfaces.dc.html — S17–S19 crate states | public/app.js |
| TraxWax App.dc.html (crate) | public/app.js, public/styles.css |
| Tokens / shell CSS | public/styles.css |
| implementation/ package | targets all of the above |

## Sync history

- 2026-08-29T15:53:00Z — first read of the repo: landing, auth shell, account modal, boot states, `docs/social-roadmap.md` (rev 3). No files copied except three screenshots.

---

## As-built reconciliation — v1.3.2 (implemented 2026-08-29, not yet pushed at time of writing)

The package above was implemented in full. **Two Lane decisions diverged from the design-time
plan**, so the screen map above is a design-time snapshot; the rows below are repo truth. The
authoritative, detailed, current surface→file map is **`docs/design-screen-map.md`** — diff
future syncs against that.

1. **The account surface routes at `/account` and `/account/discogs`, OUTSIDE `/app`** — the
   spec §6 *recommended* option, not the `/app/account` reserved-word carve-out the design-time
   note above assumed. There is no `RESERVED_SEGMENTS` set. `openAccountModal` was **deleted**;
   the account page is `renderAccount()` in `public/boot.js`, rendered by
   `UI.accountPageHtml` / `UI.bindAccountPage` in `public/boot.ui.js`. `public/_redirects`
   rewrites `/account` + `/account/*` to the `/app/` shell (like `/app`); `_headers` marks them
   no-cache; `_routes.json` unchanged. **Consequence for later waves:** the spec's plan to
   reserve `i`/`invite` in a `RESERVED_SEGMENTS` set is moot — Wave 1's invite route and
   Wave 5's public-crate route each need their own top-level route added the same way.
2. **Cut as a patch (v1.3.2)**, leaving the social-roadmap wave→version map unchanged.

Corrected screen-map rows (supersede the table above):

| Project screen | Repo files (as built) |
|---|---|
| S2–S12 states | `public/boot.js` (`notice` shim → `UI.stateCard`, `mountAuth`, `paintConnect`, `runImport`, `showError`, `render`) + `public/boot.ui.js` |
| S13–S16 account | `public/boot.js` `renderAccount()` + `public/boot.ui.js` `accountPageHtml`/`bindAccountPage`; route `/account`, `/account/discogs` |
| S0 shell system | `public/boot.ui.js` (new) + `public/boot.clerk.js` (new) + landing classes in `public/styles.css` |
| package | landed as `public/boot.ui.js`, `public/boot.clerk.js`, edits to `boot.js`/`app.js`/`styles.css`/`index.html`, config in `_redirects`/`_headers`; spec at `docs/design-surfaces-spec.md`, doc source at `docs/design-source/` |

Everything else shipped as designed. Verification: 4× `node --check`, 33/33 jsdom assertions,
a cold adversarial audit (cleared, 2 minor introduced regressions fixed). Design doc source is
committed at `docs/design-source/` (open `TraxWax Surfaces.dc.html` locally).

### Sync history (cont.)

- 2026-08-29 (v1.3.2) — package implemented into `main`; account surface built at `/account`
  per Lane's decision (not `/app/account`); `github.md` + `design-source/` landed;
  `docs/design-screen-map.md` is the current authoritative map.
