-- 0026_sharing_default_friends.sql — default new users to friends-visible, and flip existing users on.
-- Product decision (Lane, 2026-09-03): sharing should be ON by default. Two parts:
-- (1) new-user DEFAULT flips 'private' → 'friends' for both crate and wantlist visibility. New profiles get
--     this automatically — ensureProfile's upsert omits these columns, so the column default applies on insert.
-- (2) one-time backfill: every EXISTING profile set to friends-visible on both shelves (the 4-user alpha,
--     opened up per Lane). On a fresh `db reset` this UPDATE touches 0 rows (users sign up at runtime), so it
--     is a no-op there — it only did real work against the prod rows at apply time. Both CHECK constraints
--     already permit 'friends'.

alter table public.profiles alter column crate_visibility    set default 'friends';
alter table public.profiles alter column wantlist_visibility set default 'friends';

update public.profiles set crate_visibility = 'friends', wantlist_visibility = 'friends';
