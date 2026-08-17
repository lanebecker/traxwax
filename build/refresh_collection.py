#!/usr/bin/env python3
"""Refresh public/collection.json directly from the Discogs API — no Claude, no Cowork.

Run by .github/workflows/refresh-collection.yml on a weekly schedule (and on demand).
Fetches the full collection, maps it to the flat shape the site reads, and bakes
marketplace low prices. Preserves the previous price for any record whose price fetch
fails (429 / timeout), so a rough API day never wipes prices. The workflow only commits
if the file actually changed.

Only the Python standard library is used, so the workflow needs no pip install.

Env:
  DISCOGS_TOKEN       required — the Discogs personal access token (an Actions secret)
  DISCOGS_USER        optional — defaults to 'lanebecker'
  MAX_PRICE_FETCHES   optional — 0/unset = price every record (throttled). Set e.g. 700
                      to cap a run; records missing a price are fetched first.
"""
import json, os, re, sys, time, urllib.request, urllib.error

TOKEN = os.environ.get('DISCOGS_TOKEN')
USER  = os.environ.get('DISCOGS_USER', 'lanebecker')
MAXP  = int(os.environ.get('MAX_PRICE_FETCHES', '0') or '0')
UA    = 'TraxWax/1.0 +https://traxwax.com'
API   = 'https://api.discogs.com'
HERE  = os.path.dirname(os.path.abspath(__file__))
OUT   = os.path.join(HERE, '..', 'public', 'collection.json')
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
                'added': (r.get('date_added', '') or '')[:10],
                'rating': r.get('rating', 0) or 0,
                'price': None,
            })
        print(f'  collection page {page}/{pages} — {len(out)} records so far')
        page += 1
        time.sleep(PAUSE)
    return out


def marketplace_low(rid):
    d = get_with_retry(f'{API}/marketplace/stats/{rid}?curr_abbr=USD')
    if not d:
        return None
    lp = d.get('lowest_price')
    return lp.get('value') if isinstance(lp, dict) else None


def main():
    # Load previous prices so a failed fetch preserves the last known value.
    prev = {}
    if os.path.exists(OUT):
        try:
            for r in json.load(open(OUT)):
                if r.get('price') is not None:
                    prev[r['id']] = r['price']
        except Exception:
            pass

    records = fetch_collection()
    if not records:
        print('No records fetched — leaving collection.json untouched.')
        return
    for r in records:
        r['price'] = prev.get(r['id'])   # seed from previous run

    # Price pass: records missing a price first, then the rest; capped if MAX_PRICE_FETCHES>0.
    order = [r for r in records if r['price'] is None] + [r for r in records if r['price'] is not None]
    todo = order if MAXP <= 0 else order[:MAXP]
    fetched = preserved = 0
    for r in todo:
        v = marketplace_low(r['id'])
        if v is not None:
            r['price'] = v; fetched += 1
        elif r['price'] is not None:
            preserved += 1                # keep the previous value on a failed fetch
        time.sleep(PAUSE)

    json.dump(records, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    priced = sum(1 for r in records if r['price'] is not None)
    print(f'Wrote {len(records)} records | prices fetched {fetched}, preserved {preserved}, total priced {priced}')


if __name__ == '__main__':
    main()
