# Brand fonts — drop the files here

`index.html` self-hosts the two Lennar Brand Standards V1.1 faces from this
folder. The `@font-face` rules list `local()` first, so a workstation that
already has the fonts installed renders correctly today; the `url()` entries
take over for everyone else once the files are in place.

Copy these out of the Lennar brand kit into this folder, exact filenames:

| File | Used for |
|---|---|
| `Reckless-Light.woff2` / `.woff` | display numbers only (metric strip), weight 300 |
| `TTCommonsPro-Regular.woff2` / `.woff` | body + table cells, weight 400 |
| `TTCommonsPro-Medium.woff2` / `.woff` | emphasis in cells + buttons, weight 500 |
| `TTCommonsPro-DemiBold.woff2` / `.woff` | section + column headers, weight 600 |
| `TTCommonsPro-Bold.woff2` / `.woff` | ALL CAPS eyebrow labels, weight 700 |

`.woff2` alone is enough for every browser this tool targets; the `.woff` lines
are a harmless belt-and-braces fallback and can be ignored.

If the brand kit ships `.otf` or `.ttf` instead, convert first — a woff2 is
roughly a third of the size, which matters on a page that loads ~900 rows:

```bash
pip install fonttools brotli --break-system-packages
fonttools ttLib.woff2 compress -o Reckless-Light.woff2 Reckless-Light.otf
```

Until the files land, the page falls back to Times (display) and Arial
(everything else), exactly as the brand standards specify. Nothing breaks.

**Licensing:** Reckless and TT Commons Pro are commercially licensed. Confirm
the Lennar licence covers web embedding before deploying these files to a
public URL, even an unlisted one.
