# Seofy (MV3)

Chrome extension that inspects a page's SEO surface — overview, headings, links, images, schema, social tags, and more.

## Load it

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. Pin the toolbar icon, click it on any regular https page

> Won't run on `chrome://`, the Web Store, or other restricted URLs — the popup will say so.

## What it does

- **Scrapes** `<img>`, `<picture><source>`, inline-SVG `<image>`, and CSS `background-image` urls (capped at 600 nodes for big pages) via `chrome.scripting.executeScript`
- **Filter chips** are auto-generated from the file types actually present (JPG, PNG, SVG, WEBP, AVIF, GIF, …) with per-type counts. Multi-select supported
- **List view** (1 per row) or **grid view** (3-up). View persists during a session
- **Per-row actions** (revealed on hover): copy URL, open in new tab, download
- **Download all** queues every visible image through `chrome.downloads`
- **Live size hydration**: HEAD requests in the background (6 in flight) fill in byte sizes
- **Quality flags**: missing-alt warning per row, broken-image fallback tile, total-missing-alt count in the header

## Files

- `manifest.json` — MV3, permissions: `activeTab`, `scripting`, `downloads`, `<all_urls>`
- `popup.html` / `popup.css` / `popup.js` — the UI (no build step, no deps)
- `icons/` — **add your own** 16/32/48/128 PNGs here, or remove the icon refs from `manifest.json` to load without them

## Notes / caveats

- Some hosts block CORS HEAD requests, so byte sizes will stay `—` for those
- Cross-origin images can't be probed for natural dimensions until rendered; the scraper uses `naturalWidth/Height` when available
- Filename sanitization strips path-traversal chars before passing to `chrome.downloads.download`
