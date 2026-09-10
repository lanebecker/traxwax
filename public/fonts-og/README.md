# fonts-og — TTF faces for the /og/<slug> card renderer (Wave 5b S2)

Satori (inside workers-og) needs TTF/OTF buffers; these are the four card faces, two files each
(latin + latin-ext — satori falls back per-glyph across same-name entries, so "Ærø Ø." renders).

Source: the @fontsource npm packages (Google Fonts builds), woff → TTF via fontTools
(`TTFont(woff); f.flavor=None; f.save(ttf)`), 2026-09-10:
- @fontsource/anton → Anton-400-{latin,latin-ext}.ttf
- @fontsource/barlow-condensed (700) → BarlowCondensed-700-{latin,latin-ext}.ttf
- @fontsource/ibm-plex-mono (400+700) → IBMPlexMono-{400,700}-{latin,latin-ext}.ttf

Served as static assets (this folder lives under public/); functions/og/[slug].js loads them via
env.ASSETS.fetch — nothing font-shaped in the function bundle. Names beyond latin-ext render as
missing glyphs on the card; acceptable, revisit if it ever bites a real user.
