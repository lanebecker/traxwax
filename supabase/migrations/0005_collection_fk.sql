-- 0005_collection_fk.sql — Phase 1 Stage D
--
-- PostgREST embedding (collection_items -> releases in one query) requires a real foreign
-- key. Stage C guaranteed the data satisfies it: every imported item seeds its release.
-- ON DELETE is left at the default (NO ACTION -- round-1 audit corrected rev 1's claim
-- that the default is RESTRICT): a release row referenced by anyone's collection cannot be
-- deleted out from under them, and nothing in this system deletes from releases anyway.
--
-- NOTE: import-collection MUST seed releases before upserting items once this exists;
-- Task D2 ships that reorder in the same stage.

-- Idempotence guard (audit #28): a bare ADD CONSTRAINT fails on replay; every other
-- migration in this set survives a re-run.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'collection_items_release_fk') then
    alter table public.collection_items
      add constraint collection_items_release_fk
      foreign key (release_id) references public.releases(release_id);
  end if;
end $$;
