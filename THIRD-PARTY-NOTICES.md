# Third-Party Notices

TraxWax's own source is under the MIT `LICENSE`. It bundles or redistributes the third-party
components below, each under its own licence. Nothing here changes those upstream licences; this
file records them, as those licences require.

## Fonts — SIL Open Font License 1.1

`public/fonts-og/*.ttf` (8 files, 3 families) are OFL-1.1, **not** MIT. Full licence text and the
per-family copyright / Reserved Font Name notices: `public/fonts-og/OFL.txt`.

| Family | Files | Source | Licence |
|--------|-------|--------|---------|
| Anton | `Anton-400-{latin,latin-ext}.ttf` | `@fontsource/anton` (Google Fonts) | OFL-1.1 |
| Barlow Condensed | `BarlowCondensed-700-{latin,latin-ext}.ttf` | `@fontsource/barlow-condensed` | OFL-1.1 |
| IBM Plex Mono | `IBMPlexMono-{400,700}-{latin,latin-ext}.ttf` | `@fontsource/ibm-plex-mono` | OFL-1.1 (Reserved Font Name "Plex") |

## npm dependencies (OG-card Function; see `package-lock.json`)

Runtime dependency `workers-og` and its transitive tree:

| Package | Version | Licence | Notes |
|---------|---------|---------|-------|
| workers-og | 0.0.25 | MIT (© 2023 Kevin Ang) | The npm manifest omits the `license` field, so the lockfile records none; the upstream repo (github.com/kvnang/workers-og) ships a verbatim MIT `LICENSE.md`. |
| satori | 0.10.14 | **MPL-2.0** | Source-availability obligation; used unmodified from npm. |
| @resvg/resvg-wasm | 2.6.2 | **MPL-2.0** | Source-availability obligation; used unmodified from npm. |
| @shuding/opentype.js | 1.4.0-beta.0 | MIT | |
| yoga-wasm-web | 0.3.3 | MIT | |
| css-color-keywords | 1.0.0 | ISC | |
| base64-js | 0.0.8 | MIT | |
| camelize | 1.0.1 | MIT | |
| color-name | 1.1.4 | MIT | |
| css-background-parser | 0.1.0 | MIT | |
| css-box-shadow | 1.0.0-3 | MIT | |
| css-to-react-native | 3.2.0 | MIT | |
| emoji-regex | 10.6.0 | MIT | |
| escape-html | 1.0.3 | MIT | |
| fflate | 0.7.5 | MIT | |
| hex-rgb | 4.3.0 | MIT | |
| just-camel-case | 6.2.0 | MIT | |
| linebreak | 1.1.0 | MIT | |
| pako | 0.2.9 | MIT | |
| parse-css-color | 0.2.1 | MIT | |
| postcss-value-parser | 4.2.0 | MIT | |
| string.prototype.codepointat | 0.2.1 | MIT | |
| tiny-inflate | 1.0.3 | MIT | |
| unicode-trie | 2.0.0 | MIT | |

**MPL-2.0 note.** `satori` and `@resvg/resvg-wasm` are bundled unmodified as published on npm; no
MPL-covered file has been modified in this repository. The OG-card renderer runs server-side on
Cloudflare Workers, so the Executable Form is not distributed to end users in the ordinary case; to
the extent MPL-2.0 §3.2 is triggered by distributing the bundled Worker, the "make Source Code Form
available and inform recipients by reasonable means" obligation is met by the unmodified upstream
sources at the pinned versions below:

- `satori@0.10.14` — https://registry.npmjs.org/satori/-/satori-0.10.14.tgz · https://github.com/vercel/satori
- `@resvg/resvg-wasm@2.6.2` — https://registry.npmjs.org/@resvg/resvg-wasm/-/resvg-wasm-2.6.2.tgz · https://github.com/yisibl/resvg-js

_Dependency versions and licences above are taken from `package-lock.json`; the two MPL-2.0 entries
are the only non-permissive licences in the tree._

## Vendored front-end library — supabase-js (browser)

`public/vendor/supabase-js-2.116.0.js` is a self-contained ESM bundle of
`@supabase/supabase-js@2.116.0` and its dependency tree, produced by esbuild (see
`build/vendor-supabase.sh`) and served same-origin (#186 Phase 1 — replaces the former
`cdn.jsdelivr.net` runtime import). The bundle ships no inline licence banners; the bundled
packages and their licences are:

| Package | Version | Licence |
|---------|---------|---------|
| @supabase/supabase-js | 2.116.0 | MIT |
| @supabase/auth-js | 2.116.0 | MIT |
| @supabase/functions-js | 2.116.0 | MIT |
| @supabase/postgrest-js | 2.116.0 | MIT |
| @supabase/realtime-js | 2.116.0 | MIT |
| @supabase/storage-js | 2.116.0 | MIT |
| @supabase/phoenix | 0.4.5 | MIT |
| iceberg-js | 0.8.1 | MIT |
| tslib | 2.8.1 | 0BSD |

All permissive (MIT / 0BSD); no copyleft. Source: https://github.com/supabase/supabase-js
(npm tarball `https://registry.npmjs.org/@supabase/supabase-js/-/supabase-js-2.116.0.tgz`).
