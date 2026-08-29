-- 0011_profiles_display.sql — Phase 2 profiles: display + social fields.
-- Plan: docs/phase-2-profiles-plan.md (rev 2, twice audited).
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
