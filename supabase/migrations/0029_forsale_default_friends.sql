-- 0029_forsale_default_friends.sql — for-sale sharing ON by default. Product call (Lane): mirror the 0026
-- crate/wantlist flip for the for-sale axis too. Two parts, same shape as 0026.

-- PART 1 (new-user default): flip the column default 'private' → 'friends'. New profiles pick this up
-- automatically — ensureProfile's upsert omits forsale_visibility (it's in the SELECT, not the INSERT row),
-- so the column default applies on insert; NO frontend change (the `|| 'private'` read is a null-fallback on
-- a NOT NULL column, never hit).
alter table public.profiles alter column forsale_visibility set default 'friends';

-- PART 2 (backfill existing): open for-sale to friends for every existing user (all 4). For-sale is GATED
-- under crate visibility (can_view_forsale requires crate_visibility='friends' AND forsale_visibility='friends');
-- 0026 already set every user's crate to 'friends', so this makes each user's for-sale visible to their friends.
-- The CHECK (profiles_forsale_visibility_chk) already permits 'friends'. On a fresh db reset this UPDATE hits
-- 0 rows (users sign up at runtime) → no-op → the migration is safe to keep in the tree.
-- B6 (#74, audit v1.25): the one-time backfill UPDATE that lived here was EXECUTED
-- 2026-09-04 against the alpha cohort and has been REMOVED from the tree 2026-09-07 —
-- same replay-safety reasoning as 0026. The SET DEFAULT above is the durable part.
