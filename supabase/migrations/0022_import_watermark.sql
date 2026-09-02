-- 0022_import_watermark.sql — cold-audit #39 (import future-skew self-wipe).
-- import-collection minted the stale-sweep watermark from db_now on page 1 and then trusted the CLIENT's
-- echo on pages >=2 (with +5min future tolerance). A forged +future echo made the final-page sweep
-- (delete where updated_at < started_at) delete the rows just upserted this run — a transient self-wipe.
-- Fix: persist the page-1 db_now server-side, per kind, and sweep against THAT (never the client echo).
-- Owner-only columns (profiles has no friend SELECT policy; get_crate_owner's projection excludes them).
alter table public.profiles
  add column if not exists import_started_collection timestamptz,
  add column if not exists import_started_wantlist   timestamptz;
