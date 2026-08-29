# Phase 2 — Profiles: avatar button, profile fields, onboarding step

**Rev 2 — 2026-08-29 (rev 1 audited: REVISE-FIRST, 6 MAJOR + 7 MINOR, all folded — Audit
record at bottom).** User profiles for the social future: a circle avatar button
replacing the header ACCOUNT text button, profile fields (photo, name, bio, location,
collecting-since, links) editable in the account modal, and a skippable post-signup
completion step. No GitHub issue — feature request from Lane, 2026-08-29.

## Locked decisions (Lane, 2026-08-29)

- **Clerk + DB sync.** Clerk owns identity fields (first/last name, profile image —
  upload via `user.setProfileImage()`, hosting/CDN by Clerk; Google sign-ins arrive with
  both pre-filled). `ensureProfile` syncs `display_name` + `avatar_url` into `profiles`
  on every boot so future social features can query them. Extra fields (bio, location,
  collecting_since, links) live in `profiles` directly, client-written under RLS.
- **Onboarding:** Clerk's signup form collects name (dashboard toggle — Task L1); ONE
  skippable completion card appears after sign-in only when the name is missing.
  Nothing blocks the crate.
- **Fields now:** bio (≤200 chars), location (≤100), collecting_since (year),
  link1/link2 (https URLs). All optional.
- **No-photo fallback:** Clerk's auto-generated initials avatar — `user.imageUrl` is
  ALWAYS populated (initials image when no photo), so the circle button never needs a
  custom placeholder.

## Design

**Source-of-truth split.** Name + photo: Clerk (edited via `user.update()` /
`user.setProfileImage()`); the DB copies (`display_name`, `avatar_url`) are a one-way
sync, refreshed by `ensureProfile` on every boot — the sync upsert NEVER carries the
extra fields, so bio/location/etc. (DB-owned, edited via PostgREST under RLS) are
untouched by it.

**Privacy default:** `profiles` policies are own-row only (verified live:
`profiles_select_own/insert_own/update_own`, all `auth.jwt()->>'sub' = user_id`). The
new columns are therefore invisible to other users until a future social phase
deliberately exposes a view. Store now, expose nothing.

**Writability:** migration 0007 granted table-level INSERT/UPDATE to `authenticated`,
and the `profiles_guard` trigger pins ONLY the four OAuth-owned columns
(`discogs_username`, `discogs_connected_at`, `last_import_at`, `import_status`) — new
columns pass through it untouched, so no trigger change is needed. Safety on what
clients may write comes from CHECK constraints (Task 1): length caps, year range, https
scheme on links, and `avatar_url` pinned to Clerk's image host so no one can point their
future-public avatar at an arbitrary URL.

**Deletion/disconnect semantics** (inherited from v1.1.0, no change needed): disconnect
resets only the OAuth-owned columns — profile fields survive; `delete_account` removes
the whole row — profile fields die with it. Correct on both counts.

## Confirmed facts (measured before writing)

- `profiles` RLS: exactly the three own-row policies above (live `pg_policies` read).
- `profiles_guard` (0007) forces only the four OAuth-owned columns for
  authenticated/anon; service_role/postgres skip it.
- `ensureProfile(userId)` in boot.js upserts `{ user_id }` with
  `onConflict: 'user_id'` and selects
  `user_id, discogs_username, import_status, last_import_at`.
- `ownerInfo(profile)` builds `window.TraxWaxOwner = { ownerLine, lastSyncedAt }`;
  `installCrateProviders` sets it and `window.TraxWaxAccount = openAccountModal`.
- app.js header right-cluster order: counters div → RE-SYNC (DB mode) → ACCOUNT
  (DB mode) → theme toggle. `case 'account'` in `onClick` calls `window.TraxWaxAccount`.
- The account modal (`openAccountModal` in boot.js) derives `uname` from
  `TraxWaxOwner.ownerLine` and renders disconnect + delete sections.
- **clerk-js v6** (rev1-F2: the shell loads `@clerk/clerk-js@6` from the custom domain
  `clerk.traxwax.com` — `public/app/index.html:21`). `user.update({ firstName,
  lastName })` and `user.setProfileImage({ file })` are v6 User-resource APIs (carried
  over from v5). `user.imageUrl` is expected to be a populated
  `https://img.clerk.com/...` URL (initials-generated when no photo; Google avatars
  proxied through the same host) — **HYPOTHESIS under the custom domain**, verified at
  V5 live E2E. The design degrades safely if wrong: the sync's host guard simply skips
  `avatar_url`, and the fallback icon (Task 3a, rev1-F6) renders instead. After
  `setProfileImage`, call `user.reload()` before reading `imageUrl` — the cached value
  may be stale.
- CHECK constraints cannot contain subqueries — hence link1/link2 as two text columns
  with LIKE checks rather than a jsonb array.

---

## Task L1 (LANE, dashboard) — collect name at signup

Clerk dashboard → **production** TraxWax instance → toggle name collection on and
required. **As executed (Lane, 2026-08-29):** in the current dashboard this lives under
the **"User Model"** tab as **"Require First and Last Name"** — not under
"Email, phone, username → Personal information" as rev 1 guessed. DONE. New
email/password signups now collect first + last name on Clerk's own form; Google
signups already carry a name. (The dev instance can get the same toggle for preview
parity, low priority.)

## Task 1 — Migration `supabase/migrations/0011_profiles_display.sql`

```sql
-- 0011_profiles_display.sql — Phase 2 profiles: display + social fields.
-- display_name/avatar_url are a one-way SYNC from Clerk (client-written each boot);
-- bio/location/collecting_since/link1/link2 are DB-owned optional fields. All are
-- user-writable under the own-row RLS + 0007 table grants; the 0007 guard trigger pins
-- only OAuth-owned columns and is deliberately unchanged. Privacy: profiles has
-- own-row-only SELECT, so nothing here is visible to other users yet.
-- (Yes, display_name returns after 0008 dropped it as dead code — this time with a job.)

alter table public.profiles
  add column if not exists display_name     text,
  add column if not exists avatar_url       text,
  add column if not exists bio              text,
  add column if not exists location         text,
  add column if not exists collecting_since integer,
  add column if not exists link1            text,
  add column if not exists link2            text;

-- Named constraints; idempotent via drop-if-exists first (re-runnable migration).
alter table public.profiles drop constraint if exists profiles_display_name_len;
alter table public.profiles drop constraint if exists profiles_avatar_url_host;
alter table public.profiles drop constraint if exists profiles_bio_len;
alter table public.profiles drop constraint if exists profiles_location_len;
alter table public.profiles drop constraint if exists profiles_collecting_since_range;
alter table public.profiles drop constraint if exists profiles_link1_shape;
alter table public.profiles drop constraint if exists profiles_link2_shape;

alter table public.profiles
  add constraint profiles_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 80),
  -- The avatar will eventually render on OTHER users' screens: pin it to Clerk's image
  -- host so a client cannot point it at an arbitrary URL.
  add constraint profiles_avatar_url_host
    check (avatar_url is null or avatar_url like 'https://img.clerk.com/%'),
  add constraint profiles_bio_len
    check (bio is null or char_length(bio) <= 200),
  add constraint profiles_location_len
    check (location is null or char_length(location) <= 100),
  add constraint profiles_collecting_since_range
    check (collecting_since is null or collecting_since between 1900 and 2100),
  add constraint profiles_link1_shape
    check (link1 is null or (link1 like 'https://%' and char_length(link1) <= 200)),
  add constraint profiles_link2_shape
    check (link2 is null or (link2 like 'https://%' and char_length(link2) <= 200));
```

**Verify after apply:**

```sql
-- rev1-F1: information_schema.constraint_table_usage does NOT cover CHECK constraints
-- (live-confirmed: the rev-1 query returned 0 against an existing check). pg_constraint
-- is the instrument that can actually see them.
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='profiles'
      and column_name in ('display_name','avatar_url','bio','location',
                          'collecting_since','link1','link2')) as new_cols,   -- 7
  (select count(*) from pg_constraint
    where conrelid='public.profiles'::regclass and contype='c') as checks;    -- 8 (7 new + profiles_import_status_check)
```

Negative checks (each must FAIL with a check violation, run as raw SQL with rollback via
failed statement — no cleanup needed since each errors): bio of 300 chars; avatar_url
`https://evil.example/x.png`; collecting_since 1850; link1 `http://insecure.example`.

## Task 2 — `public/boot.js` edits

**2a — `ensureProfile` becomes the sync point.** Replace the whole function:

```js
/* Ensure a profiles row exists for this Clerk user, and SYNC the Clerk-owned display
   fields into it (Phase 2 profiles): display_name + avatar_url flow one way, Clerk → DB,
   every boot — so the DB copy future social features query can never drift far. The
   upsert deliberately NEVER carries the DB-owned fields (bio, location, collecting_since,
   link1, link2); they are edited directly and must not be touched here.
   upsert (not insert) because two tabs racing would otherwise hit a 23505 PK violation. */
async function ensureProfile(userId) {
  const u = window.Clerk.user;
  const name = [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
  const row = { user_id: userId };
  if (name) row.display_name = name.slice(0, 80);
  // imageUrl is always populated (initials avatar when no photo) and always on Clerk's
  // image host — which the DB check constraint enforces as defense-in-depth.
  if (u?.imageUrl && u.imageUrl.startsWith('https://img.clerk.com/')) {
    row.avatar_url = u.imageUrl;
  }
  const { data, error } = await supabase
    .from('profiles')
    .upsert(row, { onConflict: 'user_id', ignoreDuplicates: false })
    .select('user_id, discogs_username, import_status, last_import_at, ' +
      'display_name, avatar_url, bio, location, collecting_since, link1, link2')
    .single();
  if (error) throw new Error('profile upsert failed: ' + error.message);
  return data;
}
```

**2b — `ownerInfo` carries the display fields.** Replace:

```js
function ownerInfo(profile) {
  return {
    ownerLine: profile.discogs_username
      ? profile.discogs_username + "'s shelf · filed by whim"
      : 'Your shelf · filed by whim',
    lastSyncedAt: profile.last_import_at || null,
  };
}
```

with:

```js
function ownerInfo(profile) {
  return {
    ownerLine: profile.discogs_username
      ? profile.discogs_username + "'s shelf · filed by whim"
      : 'Your shelf · filed by whim',
    lastSyncedAt: profile.last_import_at || null,
    // Phase 2 profiles: the header avatar button + modal read these.
    displayName: profile.display_name || '',
    avatarUrl: profile.avatar_url || '',
  };
}
```

**2c — the skippable completion card.** In `render()`, directly after
`const profile = await ensureProfile(window.Clerk.user.id);` insert:

```js
  // Phase 2 profiles: ONE skippable completion card, only when the name is missing
  // (email/password signups before the Clerk name toggle, or with it off; Google users
  // arrive complete and never see this). Skipping is remembered per browser; completing
  // sets the Clerk name, so the condition never re-fires anywhere.
  let profileSkip = false;
  try { profileSkip = !!localStorage.getItem('tw_profile_skip'); } catch (e) {}
  // rev1-F9: never intercept an in-flight OAuth return — the parked link expires in
  // 15 minutes and the verify handler must run first.
  const inVerifyLeg = new URLSearchParams(window.location.search).get('connect') === 'verify';
  if (!window.Clerk.user.firstName && !profileSkip && !inVerifyLeg) {
    clearAuthMount();
    const mono = "font-family:'IBM Plex Mono',monospace;";
    const inp = 'style="' + mono + ' font-size:12px; padding:9px 11px; width:100%; ' +
      'background:var(--panel); color:var(--ink); border:1.5px solid var(--line); ' +
      'border-radius:0; box-sizing:border-box"';
    app().innerHTML = shell(`
      <div style="font-family:Anton,sans-serif; font-size:34px; letter-spacing:.02em;
        color:var(--accent); margin-bottom:14px">Whose crate is this?</div>
      <div style="font-size:13px; line-height:1.7; color:var(--muted); margin-bottom:18px">
        A name for your shelf — and a photo if you like. You can change both any time
        from the ACCOUNT button.</div>
      <div id="tw-ob-err" style="${mono} font-size:11.5px; color:var(--accent);
        margin-bottom:12px"></div>
      <div style="display:flex; gap:10px; margin-bottom:10px">
        <input id="tw-ob-first" placeholder="First name" autocomplete="given-name" ${inp} />
        <input id="tw-ob-last" placeholder="Last name" autocomplete="family-name" ${inp} />
      </div>
      <div style="margin-bottom:18px">
        <label style="${mono} font-size:11px; color:var(--muted)">Photo (optional)
          <input id="tw-ob-photo" type="file" accept="image/jpeg,image/png,image/webp"
            style="display:block; margin-top:6px; ${mono} font-size:11px; color:var(--ink)" />
        </label>
      </div>
      <div style="display:flex; gap:10px">
        <button id="tw-ob-save" style="${mono} font-size:12px; font-weight:700;
          letter-spacing:.1em; padding:11px 18px; border:1.5px solid var(--line);
          background:var(--accent); color:var(--on-accent); cursor:pointer">SAVE</button>
        <button id="tw-ob-skip" style="${mono} font-size:12px; letter-spacing:.1em;
          padding:11px 18px; border:1.5px solid var(--line); background:var(--panel);
          color:var(--muted); cursor:pointer">SKIP FOR NOW</button>
      </div>
    `);
    document.getElementById('tw-ob-skip').addEventListener('click', () => {
      try { localStorage.setItem('tw_profile_skip', '1'); } catch (e) {}
      route();
    });
    document.getElementById('tw-ob-save').addEventListener('click', async () => {
      const first = document.getElementById('tw-ob-first').value.trim();
      const last = document.getElementById('tw-ob-last').value.trim();
      const err = document.getElementById('tw-ob-err');
      if (!first) { err.textContent = 'A first name is the one thing we need here.'; return; }
      const btn = document.getElementById('tw-ob-save');
      btn.disabled = true; btn.textContent = 'SAVING…';
      try {
        await window.Clerk.user.update({ firstName: first, lastName: last });
        const photo = document.getElementById('tw-ob-photo').files[0];
        if (photo) {
          if (photo.size > 10 * 1024 * 1024) throw new Error('That photo is over 10 MB.');
          await window.Clerk.user.setProfileImage({ file: photo });
          await window.Clerk.user.reload();   // rev1-F2: imageUrl can be stale until reload
        }
        route();   // re-runs ensureProfile → syncs name/avatar to the DB → continues
      } catch (e) {
        btn.disabled = false; btn.textContent = 'SAVE';
        err.textContent = 'Could not save (' + ((e && e.message) || e) + '). Try again.';
      }
    });
    return;
  }
```

**2d — the account modal grows a PROFILE section.** In `openAccountModal()` (rev1-F4:
keep the `uname` derivation and everything above `ov.innerHTML` — the replacement still
uses `owner` and `esc(uname)`): replace ONLY the six contiguous innerHTML lines from
`'<div style="font-family:Anton,sans-serif; font-size:26px; …">YOUR ACCOUNT</div>' +`
through the `'<div id="tw-acct-msg" …></div>' +` line (they are reproduced verbatim at
the top of the replacement below, with the PROFILE section appended) with:

```js
    '<div style="font-family:Anton,sans-serif; font-size:26px; color:var(--accent); ' +
    'margin-bottom:6px">YOUR ACCOUNT</div>' +
    '<div style="' + mono + ' font-size:11px; color:var(--muted); margin-bottom:20px">' +
    'Connected to Discogs as <b>' + esc(uname) + '</b></div>' +
    '<div id="tw-acct-msg" style="' + mono + ' font-size:11.5px; color:var(--accent); ' +
    'line-height:1.6; margin-bottom:14px"></div>' +
    // ── Phase 2: PROFILE ──────────────────────────────────────────────────────
    '<div style="border:1.5px solid var(--line); padding:16px; margin-bottom:18px">' +
    '<div style="display:flex; gap:14px; align-items:center; margin-bottom:12px">' +
    // rev1-F6: never render <img src=""> (broken-image glyph; some browsers re-request
    // the page). Falsy avatarUrl gets the house user icon instead.
    (owner.avatarUrl
      ? '<img id="tw-prof-avatar" src="' + esc(owner.avatarUrl) + '" alt="" ' +
        'style="width:56px; height:56px; border-radius:50%; border:1.5px solid var(--line); ' +
        'object-fit:cover; background:var(--skel)" />'
      : '<span id="tw-prof-avatar" style="width:56px; height:56px; border-radius:50%; ' +
        // background #fff, not var(--skel): the glyph is fixed #16171a and must stay
        // visible in dark theme (pass-2 advisory) — same treatment as the header button.
        'border:1.5px solid var(--line); background:#fff; display:inline-flex; ' +
        'align-items:center; justify-content:center">' + TW_USER_ICON(34) + '</span>') +
    '<label style="' + mono + ' font-size:10.5px; color:var(--muted); cursor:pointer">' +
    'CHANGE PHOTO<input id="tw-prof-photo" type="file" ' +
    'accept="image/jpeg,image/png,image/webp" style="display:none" /></label>' +
    '</div>' +
    '<div style="display:flex; gap:8px; margin-bottom:8px">' +
    '<input id="tw-prof-first" placeholder="First name" style="' + acctInp + '" />' +
    '<input id="tw-prof-last" placeholder="Last name" style="' + acctInp + '" />' +
    '</div>' +
    '<input id="tw-prof-bio" placeholder="Bio — one line about your collection" ' +
    'maxlength="200" style="' + acctInp + ' margin-bottom:8px" />' +
    '<div style="display:flex; gap:8px; margin-bottom:8px">' +
    '<input id="tw-prof-loc" placeholder="Location" maxlength="100" style="' + acctInp + '" />' +
    '<input id="tw-prof-since" placeholder="Collecting since (year)" inputmode="numeric" ' +
    'maxlength="4" style="' + acctInp + ' width:170px; flex:none" />' +
    '</div>' +
    '<input id="tw-prof-link1" placeholder="Link (https://…)" maxlength="200" ' +
    'style="' + acctInp + ' margin-bottom:8px" />' +
    '<input id="tw-prof-link2" placeholder="Another link (https://…)" maxlength="200" ' +
    'style="' + acctInp + ' margin-bottom:12px" />' +
    '<button id="tw-prof-save" style="' + mono + ' font-size:11px; font-weight:700; ' +
    'letter-spacing:.08em; padding:9px 14px; border:1.5px solid var(--line); ' +
    'background:var(--ink); color:var(--panel); cursor:pointer">SAVE PROFILE</button>' +
    '</div>' +
```

Before `ov.innerHTML =`, add the shared input style, and add the icon helper at MODULE
level (before `openAccountModal`), since app.js's fallback in Task 3a mirrors it:

```js
/* Phase 2 profiles: the house no-photo user icon — flat head-and-shoulders in the
   TraxWax idiom. Returns an inline SVG sized to fit a circle of the given px. */
function TW_USER_ICON(px) {
  return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="8.2" r="4.2" fill="#16171a"/>' +
    '<path d="M3.5 21c1.4-4.4 4.6-6.6 8.5-6.6s7.1 2.2 8.5 6.6z" fill="#16171a"/></svg>';
}
```

```js
  const acctInp = mono + ' font-size:11.5px; padding:8px 10px; flex:1; min-width:0; ' +
    'background:var(--panel); color:var(--ink); border:1.5px solid var(--line); ' +
    'border-radius:0; box-sizing:border-box; display:block; width:100%';
```

After the `const msg = (t) => …` line (rev1-F8: after — not before — so the new handlers
read as plainly legal rather than TDZ-lookalike) add the population + handlers:

```js
  // ── Phase 2: populate + save the profile section ─────────────────────────
  (async () => {
    try {
      const { data: p } = await supabase.from('profiles')
        .select('bio, location, collecting_since, link1, link2')
        .eq('user_id', window.Clerk.user.id).single();
      const u = window.Clerk.user;
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
      set('tw-prof-first', u.firstName); set('tw-prof-last', u.lastName);
      if (p) {
        set('tw-prof-bio', p.bio); set('tw-prof-loc', p.location);
        set('tw-prof-since', p.collecting_since ? String(p.collecting_since) : '');
        set('tw-prof-link1', p.link1); set('tw-prof-link2', p.link2);
      }
    } catch (e) { console.error(e); }
  })();

  const photoInput = document.getElementById('tw-prof-photo');
  photoInput.addEventListener('change', async () => {
    const f = photoInput.files[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { msg('That photo is over 10 MB — pick a smaller one.'); return; }
    msg('Uploading photo…');
    try {
      await window.Clerk.user.setProfileImage({ file: f });
      await window.Clerk.user.reload();   // rev1-F2: imageUrl can be stale until reload
      const img = document.getElementById('tw-prof-avatar');
      if (img && img.tagName === 'IMG') img.src = window.Clerk.user.imageUrl;
      // Sync the new URL to the DB copy + the header button.
      const p = await ensureProfile(window.Clerk.user.id);
      window.TraxWaxOwner = ownerInfo(p);
      msg('Photo updated.');
    } catch (e) { msg('Photo upload failed (' + ((e && e.message) || e) + ').'); }
  });

  document.getElementById('tw-prof-save').addEventListener('click', async () => {
    const val = (id) => (document.getElementById(id)?.value ?? '').trim();
    const saveBtn = document.getElementById('tw-prof-save');
    // rev1-F10: once Task L1 makes Name required, Clerk rejects an empty first name —
    // and that failure would take the unrelated bio/location edits down with it.
    if (!val('tw-prof-first')) { msg('First name can’t be empty.'); return; }
    const sinceRaw = val('tw-prof-since');
    const since = sinceRaw ? Number(sinceRaw) : null;
    if (sinceRaw && (!Number.isInteger(since) || since < 1900 || since > 2100)) {
      msg('“Collecting since” wants a year, like 1998.'); return;
    }
    for (const id of ['tw-prof-link1', 'tw-prof-link2']) {
      const v = val(id);
      if (v && !v.startsWith('https://')) { msg('Links need to start with https://'); return; }
    }
    saveBtn.disabled = true; saveBtn.textContent = 'SAVING…';
    try {
      await window.Clerk.user.update({
        firstName: val('tw-prof-first'), lastName: val('tw-prof-last'),
      });
      const { error } = await supabase.from('profiles').update({
        bio: val('tw-prof-bio') || null,
        location: val('tw-prof-loc') || null,
        collecting_since: since,
        link1: val('tw-prof-link1') || null,
        link2: val('tw-prof-link2') || null,
      }).eq('user_id', window.Clerk.user.id);
      if (error) throw new Error(error.message);
      const p = await ensureProfile(window.Clerk.user.id);   // re-sync name → display_name
      window.TraxWaxOwner = ownerInfo(p);
      msg('Profile saved.');
    } catch (e) {
      msg('Save failed (' + ((e && e.message) || e) + ').');
    }
    saveBtn.disabled = false; saveBtn.textContent = 'SAVE PROFILE';
  });
```

## Task 3 — `public/app.js` edits

**3a — replace the ACCOUNT text button with the avatar circle**, moved to the END of the
right cluster (outermost = upper-right corner). Replace:

```js
        ${DB_MODE()?`<button data-act="account" title="Manage your account" style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; padding:7px 11px; background:#fff; color:#16171a; border:1.5px solid #16171a">ACCOUNT</button>`:''}
```

with an empty string (delete the line), and after the theme-toggle button line
(`…${s.theme==='dark'?'LIGHTS ON':'LIGHTS OUT'}</button>`) insert (rev1-F6: falsy
`avatarUrl` renders the house user icon, never `<img src="">` — app.js carries its own
copy of the glyph, matching boot.js's `TW_USER_ICON`, since the two files share nothing
by design):

```js
        ${DB_MODE()?(()=>{const o=window.TraxWaxOwner||{};const av=o.avatarUrl||'';
          const icon='<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.2" r="4.2" fill="#16171a"/><path d="M3.5 21c1.4-4.4 4.6-6.6 8.5-6.6s7.1 2.2 8.5 6.6z" fill="#16171a"/></svg>';
          return `<button data-act="account" title="${esc(o.displayName||'Your account')}" style="width:33px; height:33px; padding:0; border:1.5px solid #16171a; border-radius:50%; overflow:hidden; background:#fff; flex:none; cursor:pointer; display:inline-flex; align-items:center; justify-content:center">${av?`<img src="${esc(av)}" alt="Account" style="width:100%; height:100%; object-fit:cover; display:block">`:icon}</button>`;})():''}
```

(The `case 'account'` click handler already exists and is unchanged. The circle is
`flex:none` so the mobile header stack can't squash it; it is deliberately NOT
`tw-hide-mobile`. Desktop: appended after the theme toggle = outermost upper-right.
Mobile ≤640px (rev1-F11): the header stacks and `.tw-headR` left-aligns, so the circle
sits at the right end of the second row — consistent with every other header control,
not a floating corner element.)

## Task 4 — Verification battery

- **V1 syntax:** `node --check public/app.js` (no module syntax there); boot.js is an ES
  module — `npx esbuild --loader:.js=js public/boot.js --outfile=/dev/null` (rev1-F12;
  the repo has no package.json, npx fetches esbuild).
- **V2 migration checks** per Task 1 (7 columns, 8 checks via pg_constraint) + the four
  negative constraint probes (each errors).
- **V3 sync round-trip (SQL + live):** after Lane's first post-deploy load, `profiles`
  for his row shows `display_name`/`avatar_url` populated from Clerk. Guard re-check
  (rev1-F13 — the trigger FORCES columns silently, it does not error, and running as
  postgres SKIPS it entirely): as ONE batch — `begin; set local role authenticated;
  set local request.jwt.claims to '{"sub":"<lane sub>","role":"authenticated"}';
  update profiles set discogs_username='squatter', bio='guard-test' where
  user_id='<lane sub>'; select discogs_username, bio from profiles where
  user_id='<lane sub>'; rollback;` — the explicit begin/rollback guarantees `SET LOCAL`
  validity AND makes the probe side-effect-free even if the trigger were broken (pass-2
  advisory: without it, a statement-split execute_sql would run as postgres and actually
  squat the handle). Success = the select shows discogs_username UNCHANGED and
  bio='guard-test'; the rollback discards both.
- **V4 jsdom baked mode:** NO harness exists in the repo (rev1-F3) — rebuild per the
  recipe in `docs/phase-2-account-plan.md` Task 9.5 (jsdom scratch dir, `#app` mount,
  3-record fixture, baked boot), then assert: renders, `data-act="account"` ABSENT in
  baked mode (unchanged rule — the circle is DB-mode only), boot survives with
  `window.TraxWaxOwner` undefined.
- **V5 live E2E (Lane):** (a) circle button appears upper-right with his Google avatar
  (or initials image); (b) ACCOUNT modal opens from it, profile fields populate, edit
  bio + location + since + a link → SAVE → reload → values persist; (c) CHANGE PHOTO
  with a small image → circle + modal avatar update after reload; (d) sign-up flow
  check deferred to the next fresh account (no second user yet) — the onboarding card
  can be forced by clearing `tw_profile_skip` and testing with the name temporarily
  cleared in Clerk, OR accepted as covered by code review + V4.
- **V6:** `esc()` audit — every profile-sourced string rendered into HTML goes through
  `esc()` (grep the new hunks).

## Task 5 — Docs, version, handoff

- `CHANGELOG.md` `[1.3.0]` — Added: profiles (avatar button, profile fields, onboarding
  step, Clerk+DB sync). `VERSION` → `1.3.0`. `docs/roadmap.md` shipped entry.
- traxwax-clone/CLAUDE.md: profiles table note (display fields synced from Clerk,
  own-row private until social).
- Handoff chain; no GitHub issue to close (feature request).

## Rollout order (safety-critical — rev1-F5)

The new `ensureProfile` SELECTs the seven new columns; if the frontend deploys before
the migration, **every signed-in boot throws** (`column does not exist` → showError →
full-page failure). Therefore, strictly:

1. Apply migration 0011 to production and run the Task 1 verify block. (The migration is
   backward-compatible with the deployed frontend — new nullable columns are invisible
   to it.)
2. Only then hand Lane the push chain for the frontend commit.
Never batch these so the push happens first.

## Rollback

Frontend: `git revert`. Migration 0011 rollback (operator tool):
`alter table public.profiles drop column display_name, drop column avatar_url, drop
column bio, drop column location, drop column collecting_since, drop column link1,
drop column link2;` — destroys profile data, so only if abandoning the feature.

## Open items / accepted edges

1. **`ownerLine` still uses the Discogs handle**, not the display name — changing the
   shelf's title voice is a design decision deferred to Lane (L5).
2. **Skip memory is per-browser** (`localStorage`); a skipped user sees the card once
   per new browser until they set a name. Accepted — it is one card with a SKIP button.
3. **Avatar moderation** is delegated to Clerk (their image pipeline); nothing renders
   to other users yet anyway.
4. **The dev Clerk instance** (preview) may lack the name-at-signup toggle — preview
   signups then see the completion card instead. Fine.
5. **Social exposure** (public profile views, friends) is explicitly out of scope; when
   it comes, it needs a deliberate view/policy exposing ONLY the display fields, never
   import_status/timestamps.
6. **A no-name email signup returning from Discogs OAuth** skips the onboarding card for
   that leg (rev1-F9's guard) and sees it on the next plain load instead — the parked
   link's 15-minute expiry always wins.

---

## Audit record — rev 1 → rev 2 (2026-08-29)

Independent no-context verification of rev 1: **REVISE-FIRST** (6 MAJOR, 7 MINOR), all
folded. **F1:** the Task 1 verify query used `information_schema.constraint_table_usage`,
which never lists CHECK constraints — live-confirmed returning 0 against an existing
check; it would have false-failed the migration gate whose documented next step is the
data-destroying rollback. Replaced with `pg_constraint contype='c'`. **F2:** "clerk-js
v5" was asserted as a confirmed fact without measurement — the shell loads **v6** from
the custom domain `clerk.traxwax.com`; the API claims are restated as
verify-at-E2E hypotheses with safe degradation, and `user.reload()` added after photo
uploads. **F3:** V4 cited the nonexistent "existing 13-test harness" (session scratch,
never committed — the account plan already admits this); now references that plan's
rebuild recipe. **F4:** 2d's prose told the executor to delete the `uname` block the
replacement depends on; now line-anchored to the six innerHTML lines only. **F5:** no
deploy-ordering constraint — frontend-before-migration bricks every signed-in boot; a
Rollout order section now forbids it. **F6:** `<img src="">` on the empty-avatar path;
both surfaces now render the house user icon (which also fulfills the user's literal
"basic user icon" request). **F7:** "Who's crate" → "Whose crate". **F8:** modal
insertion point moved after `const msg`. **F9:** the onboarding card no longer
intercepts the `?connect=verify` return leg. **F10:** modal save validates first name
before calling Clerk. **F11:** mobile-position honesty note. **F12:** V1 tooling
corrected for the ES-module boot.js. **F13:** the V3 guard re-check now specifies role +
JWT claims and the silent-force success criterion. Verified correct by the same pass:
all byte-checked edit anchors, the migration SQL (multi-add-constraint form, idempotence,
existing-row safety, host-check unspoofability), disconnect/deletion semantics quotes,
guard-trigger pass-through for new columns, and the upsert/trigger interplay.
