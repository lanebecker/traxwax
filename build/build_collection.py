#!/usr/bin/env python3
"""Map the Discogs collection export into TraxWax's flat record shape.

Input : ../discogs_records.json  (the project's cached full collection)
Output: ../public/collection.json

Flat shape (Seam 1): {id, artist, title, year, label, styles[], genres[], vinyl,
thumb, added, rating, price}. Prices stay null here — they're filled live by the
Cloudflare proxy (/api/price/:id) or a future price-bake step.
"""
import json, re, os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC  = os.path.join(HERE, "..", "..", "discogs_records.json")
OUT  = os.path.join(HERE, "..", "public", "collection.json")

def clean(name: str) -> str:
    return re.sub(r"\s*\(\d+\)\s*$", "", name or "").strip()

def main():
    recs = json.load(open(SRC))["records"]
    out = []
    for r in recs:
        bi = r["basic_information"]
        artist = ", ".join(clean(a.get("name", "")) for a in bi.get("artists", []) if a.get("name"))
        out.append({
            "id": r["id"],
            "artist": artist,
            "title": (bi.get("title", "") or "").strip(),
            "year": bi.get("year", 0) or 0,
            "label": ((bi.get("labels") or [{}])[0].get("name", "") or ""),
            "styles": bi.get("styles", []) or [],
            "genres": bi.get("genres", []) or [],
            "vinyl": ((bi.get("formats") or [{}])[0].get("text", "") or ""),
            "thumb": bi.get("thumb", "") or "",
            "added": (r.get("date_added", "") or "")[:10],
            "rating": r.get("rating", 0) or 0,
            "price": None,
        })
    json.dump(out, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(out)} records -> {os.path.relpath(OUT)}")

if __name__ == "__main__":
    main()
