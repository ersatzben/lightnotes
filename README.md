# LightNotes

A tiny, offline‑first notes app optimized for Safari with sub‑200ms startup. All data stays on your device using OPFS (with localStorage fallback). No accounts, no sync, no telemetry.

## What you get

- Notes list with search, pin, duplicate, and delete
- Title field synced with the sidebar
- Rich text editing: bold, italic, underline, strikethrough, bullet lists, links
- Paragraph highlight toggle
- Markdown shortcuts: `**bold**`, `*italic*`, `~~strike~~`
- Toolbar buttons show active state based on caret position
- Text size controls (80–180%) and font family selector (Sans/Serif/Mono)
- Autosave with status indicator
- Global to‑do sidebar on the right (add / toggle / delete)
- Resizable sidebars (left and right), widths persisted
- Offline support via Service Worker
- Export/Import all notes as a ZIP (JSZip)
- Backup reminder after 7 days

## Run locally

```bash
cd /Users/benjohnson/dev/notetaking
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000` in Safari. Optional: Safari → File → Add to Dock.

## Keyboard shortcuts

- ⌘N – New note
- ⌘F – Focus search
- ⌘⌫ – Delete current note
- ⌘B / ⌘I / ⌘U – Bold / Italic / Underline
- ⌘⇧X – Strikethrough

## File structure

```
.
├── index.html       # App layout (sidebar, toolbar, editor, to‑do panel)
├── app.css          # Styling, dark theme, layout, resizers
├── app.js           # UI logic, editor, to‑dos, autosave, shortcuts
├── notes.js         # Notes CRUD with OPFS + localStorage fallback
├── opfs.js          # Low‑level OPFS helpers
├── sw.js            # Service worker for offline support
└── vendor/
    └── jszip.min.js # ZIP export/import
```

## Data & storage

- Storage is OPFS when available; falls back to localStorage
- Index: array of note metadata (id, title, created, modified, pinned, cursorPos)
- Notes are stored as HTML
- Global to‑dos are stored in localStorage

Paste sanitization allows a safe subset of tags (B, I, U, S/STRIKE, UL/OL/LI, P, BR, A) and preserves the `highlighted-para` class on paragraphs; event handlers and unsafe attributes are stripped.

## Performance

- Startup is minimal: load index, defer everything else
- Debounced saves (400ms)
- Atomic writes in OPFS to avoid corruption

## Privacy

- Everything stays local; no network calls except for loading JSZip from `vendor/`
- No analytics, no tracking, no external storage

## Export / Import

- Export creates a ZIP with `index.json` and `notes/<id>.html`
- Import restores from a ZIP created by the app

## Browser support

- Optimized for Safari 17+
- Degrades gracefully to localStorage when OPFS is unavailable
