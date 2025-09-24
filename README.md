# LightNotes - Safari Web App

A lightweight, offline-first note-taking app built for Safari that stores data locally using the Origin Private File System (OPFS) with localStorage fallback.

## Features

### Core Functionality (per PLAN.md)
- ✅ **OPFS Storage** - Private filesystem with localStorage fallback
- ✅ **Rich Text Editor** - Bold, italic, underline, bullet lists via contenteditable
- ✅ **Offline Support** - Service worker caches all assets for offline use
- ✅ **Export/Import** - Full backup/restore via ZIP files using JSZip
- ✅ **Search** - Real-time filtering of notes by title and content
- ✅ **Autosave** - Debounced saving (400ms) with status indicator
- ✅ **Keyboard Shortcuts** - ⌘N (new), ⌘F (search), ⌘Backspace (delete)

### Enhanced Features (v1 additions)
- ✅ **Title Field** - Dedicated title input above editor with sidebar sync
- ✅ **Zoom Control** - Adjustable editor zoom (80%-180%) with persistence
- ✅ **Pin Notes** - Star notes to keep them at the top of the sidebar
- ✅ **Duplicate Notes** - One-click note duplication
- ✅ **Recent Indicators** - Shows "Today", "Yesterday", or "X days ago"
- ✅ **Cursor Memory** - Remembers editing position when switching notes
- ✅ **Sidebar Resizing** - Drag to resize sidebar (200-500px, persisted)
- ✅ **Markdown Shortcuts** - Auto-converts `**bold**` and `*italic*` text
- ✅ **Backup Reminders** - Prompts to export after 7 days
- ✅ **Creation Dates** - Hover dates to see full creation timestamp
- ✅ **Visual Polish** - Amber background for pinned notes, translucent controls

## Installation

1. **Start Local Server**:
   ```bash
   cd public
   python3 -m http.server 5173
   ```

2. **Open in Safari**: Navigate to `http://localhost:5173`

3. **Install as App**: Safari → File → **Add to Dock** (macOS Sonoma+)

## File Structure

```
public/
├── index.html          # Main app layout
├── app.css            # Styling and dark theme
├── app.js             # UI logic, autosave, shortcuts
├── opfs.js            # Low-level OPFS operations
├── notes.js           # Notes CRUD with localStorage fallback
├── sw.js              # Service worker for offline support
└── vendor/
    └── jszip.min.js   # ZIP export/import functionality
```

## Data Model

- **Index**: `/index.json` - Array of note metadata
- **Notes**: `/notes/<id>.html` - Individual note content
- **Storage**: OPFS (primary) or localStorage (fallback)

### Note Structure
```json
{
  "id": "uuid",
  "title": "Note title",
  "created": 1234567890,
  "modified": 1234567890,
  "pinned": false,
  "cursorPos": 0
}
```

## Keyboard Shortcuts

- **⌘N** - Create new note
- **⌘F** - Focus search
- **⌘Backspace** - Delete current note
- **⌘B/I/U** - Bold/Italic/Underline (standard browser shortcuts)

## Technical Details

- **Storage**: Origin Private File System (OPFS) with localStorage fallback
- **Editor**: contenteditable with execCommand for formatting
- **Offline**: Service worker caches all assets
- **Export Format**: ZIP containing index.json + note HTML files
- **Browser**: Safari 17+ (OPFS support), degrades gracefully to localStorage
- **Dependencies**: JSZip for export/import functionality

## Performance

- **Boot time**: <200ms for 1000+ notes (loads index only)
- **Lazy loading**: Note content loaded on selection
- **Atomic writes**: OPFS createWritable() prevents corruption
- **Debounced saves**: Prevents excessive disk writes

## Privacy & Security

- **Local-only**: All data stays in OPFS/localStorage, no external calls
- **Origin-scoped**: Data isolated per domain
- **Paste sanitization**: Strips scripts and unsafe HTML
- **No analytics**: Zero external tracking

---

Built following the lightweight philosophy: essential features, excellent performance, maximum privacy.
