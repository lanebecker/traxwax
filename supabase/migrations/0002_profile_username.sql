-- 0002_profile_username.sql — Phase 1 Stage A
--
-- /app/<username> routes on the user's Discogs handle, so a handle must map to at most one
-- TraxWax profile. Indexed on lower() because boot.js compares case-insensitively; a
-- case-SENSITIVE index would admit 'Lane' and 'lane' as separate profiles that both claim
-- ownership of /app/lane.
--
-- The partial predicate is belt-and-braces: Postgres already treats NULLs as distinct in a
-- unique index, so any number of not-yet-connected users can coexist with
-- discogs_username IS NULL. Keeping the predicate makes the intent explicit and keeps the
-- index smaller.
--
-- Applied 2026-08-28. Enforcement verified: inserting 'CaseTest' then 'casetest' raised
-- unique_violation as intended.

create unique index if not exists profiles_discogs_username_key
  on public.profiles (lower(discogs_username))
  where discogs_username is not null;
