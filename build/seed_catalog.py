#!/usr/bin/env python3
"""seed_catalog.py — generate the CC0-only catalog seed for TraxWax multi-user (Phase 0).

Reads the already-baked single-user data and emits ONE idempotent SQL file that loads the
shared `public.releases` catalog. CC0 (public-domain) fields ONLY — per the Discogs API
terms (spec §8), prices / community stats are NOT stored, and per-user fields (personal
rating, date added, variant) belong in `collection_items`, not the shared catalog.

Inputs  (relative to the repo root, which is this script's parent directory):
  public/collection.json        — [{id, artist, title, year, label, styles[], genres[],
                                     thumb, cover_image, ...restricted/per-user fields...}]
  public/releases/<id>.json     — {tracks, country, released, videos}  (may be absent)

Output:
  seed_releases.sql (repo root) — insert ... select from jsonb_to_recordset(...)
                                   on conflict (release_id) do nothing;
  Written atomically (temp file + os.replace) so a partial/failed run never leaves a
  torn file, and an ABORTED run leaves any previous seed_releases.sql renamed to
  seed_releases.sql.stale (a loud marker) rather than silently passing it off as fresh.

Run:
  python3 build/seed_catalog.py
Then load seed_releases.sql into the TraxWax Supabase project (SQL editor, psql, or the
Supabase MCP). INSERT-ONLY, by design: `on conflict (release_id) do nothing` never
modifies an existing row — this is a one-shot Phase-0 bootstrap and must not clobber a
catalog the production merging path (`seed_releases(jsonb)`, migration 0010/0044) has
since enriched. It is safe to re-run, but re-running only fills in releases that are not
already present; it does NOT refresh the contents of rows that are.

Stdlib only. Does not touch the network or any database.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
COLLECTION = REPO / "public" / "collection.json"
RELEASES_DIR = REPO / "public" / "releases"
OUT = REPO / "seed_releases.sql"

# Fields copied verbatim from collection.json into the catalog. CC0 only.
# Deliberately EXCLUDED: price, crating, crcount, have, want (Restricted marketplace/community
# data) and rating, added, vinyl (per-user — those go to collection_items in Phase 1).
CC0_META = ("artist", "title", "year", "label", "styles", "genres", "thumb", "cover_image")

DOLLAR_TAG = "$seed$"


def _mark_stale_out() -> None:
    """On an aborted run, a seed_releases.sql from an EARLIER successful run is still on disk with an
    unchanged mtime and no failure marker - the documented next step ('then load seed_releases.sql')
    would load stale data. Rename it to a loud, PERSISTENT marker (not just a stderr line) so it can't
    be loaded as if it were fresh."""
    if OUT.exists():
        stale = OUT.with_suffix(OUT.suffix + ".stale")
        os.replace(OUT, stale)   # same-dir rename; overwrites any prior .stale
        print(f"WARNING: this run aborted and did NOT regenerate {OUT.name}; renamed the previous "
              f"file to {stale.name} so it is not mistaken for fresh output.", file=sys.stderr)


def main() -> int:
    if not COLLECTION.exists():
        print(f"ERROR: {COLLECTION} not found", file=sys.stderr)
        _mark_stale_out()
        return 1

    records = json.loads(COLLECTION.read_text())
    rows = []
    with_release_file = 0

    for rec in records:
        rid = rec.get("id")
        if rid is None:
            continue
        row = {"release_id": int(rid)}
        for k in CC0_META:
            row[k] = rec.get(k)
        # normalize array fields to lists (jsonb_to_recordset maps a JSON array → text[])
        row["styles"] = row.get("styles") or []
        row["genres"] = row.get("genres") or []

        # immutable CC0 detail from the per-release file, if we baked it
        rel_path = RELEASES_DIR / f"{rid}.json"
        if rel_path.exists():
            with_release_file += 1
            rel = json.loads(rel_path.read_text())
            row["tracks"] = rel.get("tracks") or []
            row["country"] = rel.get("country") or None
            row["released"] = rel.get("released") or None
            row["videos"] = rel.get("videos") or []
        else:
            # no detail yet → leave tracks null so Phase 1 enrich can target `where tracks is null`
            row["tracks"] = None
            row["country"] = None
            row["released"] = None
            row["videos"] = None
        rows.append(row)

    payload = json.dumps(rows, ensure_ascii=False)
    if DOLLAR_TAG in payload:
        # astronomically unlikely in music metadata, but never emit a broken dollar-quote
        print(f"ERROR: data contains the dollar-quote tag {DOLLAR_TAG}; change DOLLAR_TAG.",
              file=sys.stderr)
        _mark_stale_out()
        return 2

    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    sql = f"""-- seed_releases.sql — CC0-only catalog seed for public.releases
-- Generated by build/seed_catalog.py at {generated}
-- Source: public/collection.json ({len(rows)} releases; {with_release_file} with baked tracklists)
-- INSERT-ONLY: ON CONFLICT (release_id) DO NOTHING never modifies an existing row. Safe to re-run,
-- but a re-run only inserts releases NOT already present; it does not refresh existing rows. (The
-- production path that DOES merge is the RPC seed_releases(jsonb), migration 0010/0044.)

insert into public.releases
  (release_id, artist, title, year, label, styles, genres, thumb, cover_image,
   tracks, country, released, videos)
select release_id, artist, title, year, label, styles, genres, thumb, cover_image,
       tracks, country, released, videos
from jsonb_to_recordset({DOLLAR_TAG}
{payload}
{DOLLAR_TAG}) as x(
  release_id  bigint,
  artist      text,
  title       text,
  year        int,
  label       text,
  styles      text[],
  genres      text[],
  thumb       text,
  cover_image text,
  tracks      jsonb,
  country     text,
  released    text,
  videos      jsonb
)
on conflict (release_id) do nothing;
"""
    # Atomic publish: write a temp file in the same dir, then os.replace onto OUT (same-filesystem
    # rename is atomic) so OUT is only ever a COMPLETE file from a successful run.
    tmp = OUT.with_suffix(OUT.suffix + ".tmp")
    tmp.write_text(sql)
    os.replace(tmp, OUT)
    print(f"Wrote {OUT}")
    print(f"  releases: {len(rows)}")
    print(f"  with baked tracklists: {with_release_file}")
    print(f"  without tracklists (Phase 1 enrich targets these): {len(rows) - with_release_file}")
    print("  NOTE: loading this SQL is INSERT-ONLY (ON CONFLICT DO NOTHING) - existing rows are never modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
