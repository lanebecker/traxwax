#!/usr/bin/env python3
"""Refresh TraxWax's data from the Discogs API — no Claude, no Cowork.

Run by .github/workflows/refresh-collection.yml on a weekly schedule (and on demand).
Two things happen:

1. Collection listing (fast, ~19 calls) → public/collection.json in the flat shape the
   site reads, plus the mutable community stats + lowest price per record.

2. One `get_release` call per record (the slow pass, ~35 min for the full collection).
   A single release response carries everything the detail modal shows — tracklist,
   country, release date, videos, community rating/have-want, and lowest price. From it:
     • the IMMUTABLE parts (tracks, country, released, videos) are written once to
       public/releases/<id>.json — a static file the modal loads directly, so tracklists
       never depend on a live call or the rate limit. Existing files are never rewritten
       (a pressing's tracklist can't change), so weekly diffs stay tiny.
     • the CHANGING parts (crating/crcount/have/want/price) are written into
       collection.json so the modal's stat cells are instant and stay ≤1 week fresh.

This single pass REPLACES the old marketplace price bake (get_release returns the price).

Only the Python standard library is used, so the workflow needs no pip install.

Env:
  DISCOGS_TOKEN       required — the Discogs personal access token (an Actions secret)
  DISCOGS_USER        optional — defaults to 'lanebecker'
  SKIP_RELEASES       optional — set to skip the get_release pass entirely (metadata +
                      cover_image only; keeps existing stats/prices). ~30s run.
  RELEASE_NEW_ONLY    optional — only get_release for records missing their releases/<id>.json
                      (i.e. newly-added records). Fast incremental run; existing stats kept.
  RELEASE_LIMIT       optional — cap the number of get_release calls this run (missing-file
                      records go first). 0/unset = no cap.
"""
import json, os, re, sys, time, urllib.request, urllib.error

TOKEN = os.environ.get('DISCOGS_TOKEN')
USER  = os.environ.get('DISCOGS_USER', 'lanebecker')
SKIP_RELEASES  = bool(os.environ.get('SKIP_RELEASES', ''))
NEW_ONLY       = bool(os.environ.get('RELEASE_NEW_ONLY', ''))
REL_LIMIT      = int(os.environ.get('RELEASE_LIMIT', '0') or '0')
UA    = 'TraxWax/1.0 +https://traxwax.com'
API   = 'https://api.discogs.com'
HERE  = os.path.dirname(os.path.abspath(__file__))
OUT   = os.path.join(HERE, '..', 'public', 'collection.json')
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
        if not d:
            break
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
                'price': None,                          # lowest sale (from get_release)
                'crating': None, 'crcount': None,       # community rating avg + count
                'have': None, 'want': None,             # community have / want
            })
        print(f'  collection page {page}/{pages} — {len(out)} records so far')
        page += 1
        time.sleep(PAUSE)
    return out


def release_detail(rid):
    """Full modal payload from one get_release call."""
    d = get_with_retry(f'{API}/releases/{rid}?curr_abbr=USD')
    if not d:
        return None
    comm = d.get('community', {}) or {}
    crat = (comm.get('rating') or {})
    return {
        # immutable (→ static per-release file)
        'tracks': [{'pos': t.get('position', ''), 'title': t.get('title', ''), 'dur': t.get('duration', '')}
                   for t in (d.get('tracklist') or []) if t.get('type_') != 'heading'],
        'country': d.get('country', '') or '',
        'released': d.get('released_formatted') or d.get('released') or '',
        'videos': [{'title': v.get('title', ''), 'uri': v.get('uri', '')} for v in (d.get('videos') or [])[:3]],
        # mutable (→ collection.json)
        'crating': crat.get('average'),
        'crcount': crat.get('count'),
        'have': comm.get('have'),
        'want': comm.get('want'),
        'price': d.get('lowest_price'),
    }


def main():
    os.makedirs(RELDIR, exist_ok=True)

    # Load previous mutable stats so a failed fetch preserves the last known values.
    prev = {}
    if os.path.exists(OUT):
        try:
            for r in json.load(open(OUT)):
                prev[r['id']] = {k: r.get(k) for k in ('price', 'crating', 'crcount', 'have', 'want')}
        except Exception:
            pass

    records = fetch_collection()
    if not records:
        print('No records fetched — leaving collection.json untouched.')
        return
    for r in records:                       # seed mutable fields from the previous run
        p = prev.get(r['id'], {})
        for k in ('price', 'crating', 'crcount', 'have', 'want'):
            r[k] = p.get(k)

    if SKIP_RELEASES:
        print('SKIP_RELEASES set — metadata + cover_image only; release pass skipped.')
    else:
        # Order the release pass: records missing their static file first (new records).
        def has_file(r): return os.path.exists(os.path.join(RELDIR, f"{r['id']}.json"))
        todo = [r for r in records if not has_file(r)]
        if not NEW_ONLY:
            todo += [r for r in records if has_file(r)]     # refresh stats for the rest too
        if REL_LIMIT > 0:
            todo = todo[:REL_LIMIT]

        wrote_files = refreshed = preserved = 0
        for r in todo:
            d = release_detail(r['id'])
            if d:
                relfile = os.path.join(RELDIR, f"{r['id']}.json")
                if not os.path.exists(relfile):             # immutable — write once
                    json.dump({'tracks': d['tracks'], 'country': d['country'],
                               'released': d['released'], 'videos': d['videos']},
                              open(relfile, 'w'), ensure_ascii=False, separators=(',', ':'))
                    wrote_files += 1
                for k in ('crating', 'crcount', 'have', 'want', 'price'):
                    r[k] = d[k]
                refreshed += 1
            elif any(r.get(k) is not None for k in ('crating', 'have', 'price')):
                preserved += 1                              # kept previous stats on a failed fetch
            time.sleep(PAUSE)
        print(f'Release pass — files written {wrote_files}, stats refreshed {refreshed}, preserved {preserved}')

    json.dump(records, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    priced = sum(1 for r in records if r['price'] is not None)
    print(f'Wrote {len(records)} records to collection.json | priced {priced}')


if __name__ == '__main__':
    main()
