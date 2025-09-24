Below is a concrete, browser-only build plan for a Safari web app that stores notes locally in the Origin Private File System (OPFS), works offline, and supports basic rich text.

# 1) scope and constraints

* Runs in Safari on macOS. User “installs” as a Dock app: Safari → File → **Add to Dock** (macOS Sonoma+). 
* Storage is OPFS: `navigator.storage.getDirectory()` → private per-origin filesystem. Not Finder-visible; you provide export/import. 
* Editor uses a `contenteditable` element; bold/italics/underline via `document.execCommand`. It’s deprecated but still broadly supported and preserves the undo stack. Keep the feature set small. 

# 2) project layout

```
/public
  index.html
  app.css
  app.js              // UI wiring + state
  opfs.js             // low-level OPFS helpers
  notes.js            // notes/index CRUD using opfs.js
  sw.js               // service worker (offline cache)
  vendor/jszip.min.js // for export/import zip
```

# 3) data model (files in OPFS)

* `/index.json` – array of note metadata:

  ```json
  [{"id":"uuid","title":"First line","created":..., "modified":...}]
  ```
* `/notes/<id>.html` – HTML body (the `contenteditable` contents).
* No DB. All reads/writes are file operations against OPFS handles. 

# 4) ui model

* Left: sidebar list (titles, sorted by `modified`, optional pinned flag).
* Right: editor (`div[contenteditable]`).
* Toolbar: **B**/**I**/**U**, bullet list, undo/redo.
* Footer: status (Saved / Saving… / Error).

# 5) opfs primitives (low-level)

* Initialisation:

  ```js
  // opfs.js
  export async function getRoot() {
    return await navigator.storage.getDirectory(); // OPFS root
  }
  export async function getDir(handle, name) {
    return await handle.getDirectoryHandle(name, { create: true });
  }
  export async function getFileHandle(dir, name) {
    return await dir.getFileHandle(name, { create: true });
  }
  export async function readText(fileHandle) {
    const f = await fileHandle.getFile();
    return await f.text();
  }
  export async function writeText(fileHandle, text) {
    const w = await fileHandle.createWritable();
    await w.write(new Blob([text]));
    await w.close(); // atomic commit
  }
  ```

  OPFS directory & file handles per MDN/WebKit. 

# 6) notes api (higher-level)

* Boot:

  ```js
  // notes.js
  import * as fs from './opfs.js';

  let root, notesDir, indexHandle;

  export async function initStore() {
    root = await fs.getRoot();
    notesDir = await fs.getDir(root, 'notes');
    indexHandle = await fs.getFileHandle(root, 'index.json');
    // create index if missing
    try { await fs.readText(indexHandle); }
    catch { await fs.writeText(indexHandle, '[]'); }
  }

  export async function listNotes() {
    const json = await fs.readText(indexHandle);
    return JSON.parse(json);
  }

  export async function saveIndex(arr) {
    await fs.writeText(indexHandle, JSON.stringify(arr));
  }

  export async function readNote(id) {
    const fh = await fs.getFileHandle(notesDir, `${id}.html`);
    return await fs.readText(fh);
  }

  export async function writeNote(id, html) {
    const fh = await fs.getFileHandle(notesDir, `${id}.html`);
    await fs.writeText(fh, html);
  }
  ```
* New note:

  * Generate `id` (UUID), write empty `"<p></p>"` body, push entry to `index.json`.
* Delete note:

  * `notesDir.removeEntry('${id}.html')`, remove entry from `index.json`.

# 7) editor wiring (rich text, autosave, titles)

* `contenteditable` div with `input` listener.

* Debounce saves (300–500 ms) to avoid thrash:

  ```js
  function debounce(fn, ms=400){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
  const saveNow = async () => {
    const html = editor.innerHTML;
    await writeNote(current.id, html);
    updateTitleFrom(html);
    status('Saved');
  };
  const saveDebounced = debounce(saveNow, 400);
  editor.addEventListener('input', () => { status('Saving…'); saveDebounced(); });
  ```

* Title extraction: strip tags, take first non-empty line from `editor.innerText`. Update `index.json` entry and `modified`.

* Formatting actions via `execCommand`:

  ```js
  document.getElementById('boldBtn').onclick = () => document.execCommand('bold');
  document.getElementById('italicBtn').onclick = () => document.execCommand('italic');
  document.getElementById('underlineBtn').onclick = () => document.execCommand('underline');
  document.getElementById('ulBtn').onclick = () => document.execCommand('insertUnorderedList');
  ```

  `execCommand` remains implemented across major browsers; it preserves undo stacks. Test with `document.queryCommandSupported`. 

# 8) keyboard shortcuts

* Let the browser handle ⌘B/⌘I/⌘U (they already map to execCommand).
* Add:

  * ⌘N: new note (preventDefault).
  * ⌘F: focus search input.
  * ⌘Backspace: delete current (with confirm).

# 9) search

* In memory: load `index.json` + lazily cache stripped text of the open note only.
* Sidebar filter matches `title` (fast) and optionally `editor.innerText` when that note is open. For “global” search across hundreds of notes, add a background scan that builds a light stemmed index on idle.

# 10) offline support (service worker)

* Cache `index.html`, `app.css`, `app.js`, `opfs.js`, `notes.js`, `jszip.min.js`.
* Don’t cache note content in SW; it lives in OPFS.
* Minimal SW:

  ```js
  // sw.js
  const ASSETS = ['/', '/index.html', '/app.css', '/app.js', '/opfs.js', '/notes.js', '/vendor/jszip.min.js'];
  self.addEventListener('install', e => {
    e.waitUntil(caches.open('v1').then(c => c.addAll(ASSETS)));
  });
  self.addEventListener('fetch', e => {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  });
  ```
* Register from `app.js` once:

  ```js
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  ```

# 11) export / import (backup)

* Use **JSZip** in the page to zip `index.json` and all note files into a download; import reverses the process. ([GitHub][5])
* Export:

  ```js
  const zip = new JSZip();
  const idx = await listNotes();
  zip.file('index.json', JSON.stringify(idx));
  for (const n of idx) {
    const html = await readNote(n.id);
    zip.file(`notes/${n.id}.html`, html);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, 'lightnotes-backup.zip');
  ```
* Import:

  * Load zip, read `index.json`, write files into OPFS (overwrite on id match), then `saveIndex`.
  * Validate schema; guard against malformed zips (common JSZip footgun). 

# 12) install as a mac app

* User action: Safari → File → **Add to Dock** creates a standalone windowed app without URL bar. Document in your “Help” panel. 

# 13) security and privacy

* All data stays local in OPFS (origin-scoped, private). Not directly user-browsable; that’s by design. Provide explicit export. 
* No analytics. No external network calls (other than JSZip from your own origin).

# 14) edge cases and limits

* OPFS quota is generous but not infinite; surface a rough count of notes/bytes. (Check `navigator.storage.estimate()`.)
* If the user clears Safari data for your site, OPFS is wiped. Export is the safety valve. (State this plainly in onboarding.)
* Avoid pasting hostile HTML: sanitise on paste (strip `script`, event handlers). Optionally allow only `<b> <i> <u> <ul> <ol> <li> <p> <br> <a>` with `rel="noopener"`.

# 15) basic html skeleton (enough to start)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>LightNotes</title>
  <link rel="stylesheet" href="app.css" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <aside id="list"><input id="search" placeholder="Search" /><ul id="notes"></ul>
    <button id="new">New</button><button id="exp">Export</button><button id="imp">Import</button>
  </aside>
  <main>
    <div id="toolbar">
      <button id="b"><b>B</b></button>
      <button id="i"><i>I</i></button>
      <button id="u"><u>U</u></button>
      <button id="ul">• List</button>
      <span id="status"></span>
    </div>
    <div id="editor" contenteditable="true" spellcheck="true"></div>
  </main>
  <script src="vendor/jszip.min.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

# 16) performance notes

* Lazy load note bodies: only read `notes/<id>.html` on selection; on boot, read just `index.json`. OPFS handle ops are cheap, but keep the main thread responsive.
* Save writes are atomic via `createWritable()` → `close()`; if the tab crashes mid-write, you don’t corrupt the file. 
* Debounce saves and coalesce index writes (update title + modified together).

# 17) test plan

* Create 1,000 notes programmatically; verify launch <200 ms and sidebar filter responsiveness.
* Paste from Word/Pages and from the web; confirm sanitiser prevents scripts.
* Simulate failures: throw on write → show non-blocking error and keep “dirty” badge.
* Clear Safari website data → confirm the app boots to first-run and your “Restore from backup” flow works.

# 18) optional niceties later

* Pinned notes: extra boolean in `index.json`; sort pinned first.
* Backlinks: `[[Note Title]]` scanning on idle; keep a reverse map in memory.
* Print to PDF: use a print stylesheet (A4, serif body, reasonable margins).

