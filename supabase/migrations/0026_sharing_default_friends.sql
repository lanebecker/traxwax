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

-- B6 (#74, audit v1.25): the one-time backfill UPDATE that lived here was EXECUTED
-- 2026-09-03 against the alpha cohort (the product call above) and has been REMOVED
-- from the tree 2026-09-07: an unconditional consent-widening UPDATE must not survive
-- where any replay path (history repair, re-baseline, incident re-apply) could re-run
-- it over users who have since chosen 'private'. The SET DEFAULTs above are the
-- durable part; the executed statement is recorded in git history and issue #74.
