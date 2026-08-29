# Bundled fonts

Both families are licensed under the SIL Open Font License 1.1, which permits
bundling and redistribution inside an application.

| File | Family | Source |
| --- | --- | --- |
| `manrope-variable.woff2` | Manrope (variable, 400–800) | https://fonts.google.com/specimen/Manrope |
| `space-mono-400.woff2` | Space Mono Regular | https://fonts.google.com/specimen/Space+Mono |
| `space-mono-700.woff2` | Space Mono Bold | https://fonts.google.com/specimen/Space+Mono |

These are the Latin subsets Google Fonts serves. They are shipped with the app
rather than fetched at runtime: the renderer's Content-Security-Policy allows
`font-src 'self'` only, and a desktop tool has to render correctly offline.

Full licence text: https://openfontlicense.org/
