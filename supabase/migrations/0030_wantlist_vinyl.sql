-- 0030_wantlist_vinyl.sql — fix: wantlist cards showed every record as "Black". wantlist_items never had a
-- vinyl column, so the provider hardcoded vinyl:'' and shortVinyl('') falls back to 'Black'. Add the column so
-- the wantlist can carry the pressing's variant the same way collection_items does (captured at import from
-- basic_information.formats). Backfills empty; a wantlist re-sync populates it (upsert on user_id,release_id).
alter table public.wantlist_items add column if not exists vinyl text not null default '';
