#!/usr/bin/env python3
"""Refresh TraxWax's data from the Discogs API — no Claude, no Cowork.

Run by .github/workflows/refresh-collection.yml — MANUAL DISPATCH ONLY (the cron is retired;
this regenerates the DEV FIXTURE, nothing production reads it).

⚠ RESTRICTED DATA (audit A2, #63): this script deliberately fetches and writes NO
price/community fields (price, crating, crcount, have, want). The fixture is CC0 catalog
data + Lane's own added-date/rating. Do not re-add those fields — the Discogs API terms
forbid persisting them, the fixture is committed to a public repo, and the workflow now
FAILS the run if any of the five keys appears in the output.

Two things happen:

1. Collection listing (fast, ~19 calls) — fetched only to enumerate which release ids
   need their CC0 detail baked. It is NO LONGER written to public/collection.json (T1/#147
   i-b: that file is a synthetic dev fixture; the live site reads Supabase).

2. One `get_release` call per record MISSING its public/releases/<id>.json (new records
   only — the payload is immutable, so records that already have a file need nothing).
   Writes tracklist/country/released/videos once; existing files are never rewritten.

Only the Python standard library is used, so the workflow needs no pip install.

Env:
  DISCOGS_TOKEN       required — the Discogs personal access token (an Actions secret)
  DISCOGS_USER        optional — defaults to 'lanebecker'
  SKIP_RELEASES       optional — set to skip the get_release pass entirely (metadata +
                      cover_image only). ~30s run.
  RELEASE_NEW_ONLY    optional — accepted for compatibility; missing-file-only is now the
                      ONLY behavior (there are no mutable stats left to refresh).
  RELEASE_LIMIT       optional — cap the number of get_release calls this run.
                      0/unset = no cap.
"""
import json, os, re, sys, time, urllib.request, urllib.error

TOKEN = os.environ.get('DISCOGS_TOKEN')
USER  = os.environ.get('DISCOGS_USER', 'lanebecker')
SKIP_RELEASES  = bool(os.environ.get('SKIP_RELEASES', ''))
# RELEASE_NEW_ONLY: accepted-but-ignored (missing-file-only is now the only behavior).
REL_LIMIT      = int(os.environ.get('RELEASE_LIMIT', '0') or '0')
UA    = 'TraxWax/1.0 +https://traxwax.com'
API   = 'https://api.discogs.com'
HERE  = os.path.dirname(os.path.abspath(__file__))
RELDIR = os.path.join(HERE, '..', 'public', 'releases')
PAUSE = 1.1   # seconds between calls — stays under Discogs' 60/min authenticated limit

if not TOKEN:
    print('ERROR: DISCOGS_TOKEN not set', file=sys.stderr); sys.exit(1)


def get(url):
    req = urllib.request.Request(url, headers={'Authorization': f'Discogs token={TOKEN}', 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def get_with_retry(url, tries=4):
    for i in range(tries):
        try:
            return get(url)
        except urllib.error.HTTPError as e:
            if e.code == 429:            # rate limited — back off and retry
                time.sleep(5 * (i + 1)); continue
            if e.code == 404:
                return None
            raise
        except Exception:
            time.sleep(2 * (i + 1))
    return None


def clean(name):
    return re.sub(r'\s*\(\d+\)\s*$', '', name or '').strip()


def fetch_collection():
    out, page, pages = [], 1, 1
    while page <= pages:
        url = (f'{API}/users/{USER}/collection/folders/0/releases'
               f'?page={page}&per_page=100&sort=added&sort_order=desc')
        d = get_with_retry(url)
        if d is None:
            # A5 (#147): None = a HARD page-fetch failure after retries (network / 429 exhausted /
            # 404), NOT an empty collection. Fail loudly instead of baking release files off a
            # truncated listing (the old `if not d: break` silently proceeded on a partial list).
            print(f'ERROR: collection page {page} fetch failed after retries — refusing to bake '
                  f'off a truncated listing.', file=sys.stderr)
            sys.exit(1)
        pages = d.get('pagination', {}).get('pages', 1)
        for r in d.get('releases', []):
            bi = r.get('basic_information', {})
            out.append({
                'id': r['id'],
                'artist': ', '.join(clean(a.get('name', '')) for a in bi.get('artists', []) if a.get('name')),
                'title': (bi.get('title') or '').strip(),
                'year': bi.get('year', 0) or 0,
                'label': ((bi.get('labels') or [{}])[0].get('name', '') or ''),
                'styles': bi.get('styles', []) or [],
                'genres': bi.get('genres', []) or [],
                'vinyl': ((bi.get('formats') or [{}])[0].get('text', '') or ''),
                'thumb': bi.get('thumb', '') or '',
                'cover_image': bi.get('cover_image', '') or '',
                'added': (r.get('date_added', '') or '')[:10],
                'rating': r.get('rating', 0) or 0,     # Lane's personal 0–5 rating
                # A2 (#63): NO price/crating/crcount/have/want — Restricted, never written.
            })
        print(f'  collection page {page}/{pages} — {len(out)} records so far')
        page += 1
        time.sleep(PAUSE)
    return out


def release_detail(rid):
    """Immutable (CC0) modal payload from one get_release call. A2 (#63): the response's
    community/price fields are deliberately never read."""
    d = get_with_retry(f'{API}/releases/{rid}')
    if not d:
        return None
    return {
        'tracks': [{'pos': t.get('position', ''), 'title': t.get('title', ''), 'dur': t.get('duration', '')}
                   for t in (d.get('tracklist') or []) if t.get('type_') != 'heading'],
        'country': d.get('country', '') or '',
        'released': d.get('released_formatted') or d.get('released') or '',
        'videos': [{'title': v.get('title', ''), 'uri': v.get('uri', '')} for v in (d.get('videos') or [])[:3]],
    }


def main():
    os.makedirs(RELDIR, exist_ok=True)

    records = fetch_collection()
    if not records:
        print('No records fetched — nothing to bake.')
        return

    # #147 (i-b) + T1: this workflow NO LONGER writes public/collection.json — that file is the
    # real ownership export, deliberately replaced with a synthetic dev fixture (the live site
    # reads Supabase; only dev/fallback reads the baked fixture). Regenerating it here would
    # re-publish the ownership export to the public repo. We fetch the listing only to enumerate
    # which release ids still need their CC0 detail file baked, and commit ONLY those files.
    if SKIP_RELEASES:
        print('SKIP_RELEASES set — nothing to do (collection.json is no longer written).')
        return

    def has_file(r): return os.path.exists(os.path.join(RELDIR, f"{r['id']}.json"))
    todo = [r for r in records if not has_file(r)]
    if REL_LIMIT > 0:
        todo = todo[:REL_LIMIT]

    wrote_files = 0
    for r in todo:
        d = release_detail(r['id'])
        if d:
            relfile = os.path.join(RELDIR, f"{r['id']}.json")
            json.dump(d, open(relfile, 'w'), ensure_ascii=False, separators=(',', ':'))
            wrote_files += 1
        time.sleep(PAUSE)
    print(f'Release pass — files written {wrote_files} (of {len(todo)} missing). '
          f'collection.json left untouched (#147 i-b).')


if __name__ == '__main__':
    main()
