import { initStore, listNotes, readNote, writeNote, createNote, deleteNote, updateTitleAndModified, togglePin, updateCursorPosition, duplicateNote, saveIndex, setNoteDirty, isNoteDirty, setNoteBase } from './notes.js';
import { getIndex, putIndex, getNoteHtml, putNoteHtml, deleteNoteRemote, getTodosRemote, putTodosRemote, enqueueOperation, flushQueue, setupQueueRetry, listKeys } from './sync.js';

const els = {};
let currentNote = null; // { id, title, created, modified }
let zoomScale = 1;

function $(id) { return document.getElementById(id); }

function debounce(fn, ms = 400) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function status(text) {
  // Keep compat no-op for old calls
}

function setSyncDot(state) {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.classList.remove('sync-green', 'sync-amber', 'sync-red');
  if (state === 'syncing') dot.classList.add('sync-amber');
  else if (state === 'synced') dot.classList.add('sync-green');
  else if (state === 'offline') dot.classList.add('sync-red');
}

function stripTitleFrom(htmlOrText) {
  const txt = htmlOrText.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n');
  const lines = txt.split('\n').map(s => s.trim());
  const first = lines.find(Boolean) || '';
  return first.length > 120 ? first.slice(0, 120) : first;
}

function formatDate(timestamp) {
  const now = new Date();
  const date = new Date(timestamp);
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

function getSelectionPosition() {
  const sel = window.getSelection();
  if (sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(els.editor);
  preCaretRange.setEnd(range.endContainer, range.endOffset);
  return preCaretRange.toString().length;
}

function setSelectionPosition(pos) {
  const walker = document.createTreeWalker(
    els.editor,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  let charCount = 0;
  let node;
  
  while (node = walker.nextNode()) {
    const nextCharCount = charCount + node.textContent.length;
    if (nextCharCount >= pos) {
      const range = document.createRange();
      const selection = window.getSelection();
      range.setStart(node, pos - charCount);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    charCount = nextCharCount;
  }
}

function checkBackupReminder() {}
function showBackupNotification() {}
function hideBackupNotification() {}

function handleMarkdownShortcuts(e) {
  const sel = window.getSelection();
  if (sel.rangeCount === 0) return;
  
  const range = sel.getRangeAt(0);
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return;
  
  const text = textNode.textContent;
  // Guard: skip processing on extremely long nodes to avoid perf pitfalls
  if (text && text.length > 5000) return;
  const cursorPos = range.startOffset;
  
  // Check for **bold** pattern
  const boldMatch = text.match(/\*\*([^*]+)\*\*$/);
  if (boldMatch && cursorPos >= text.length) {
    const boldText = boldMatch[1];
    const start = text.lastIndexOf('**' + boldText + '**');
    
    range.setStart(textNode, start);
    range.setEnd(textNode, start + boldMatch[0].length);
    
    document.execCommand('insertHTML', false, `<b>${boldText}</b> `);
    
    // Reset bold formatting for subsequent text
    setTimeout(() => {
      if (document.queryCommandState('bold')) {
        document.execCommand('bold', false);
      }
    }, 0);
    return;
  }
  
  // Check for *italic* pattern
  const italicMatch = text.match(/\*([^*]+)\*$/);
  if (italicMatch && cursorPos >= text.length && !text.includes('**')) {
    const italicText = italicMatch[1];
    const start = text.lastIndexOf('*' + italicText + '*');
    
    range.setStart(textNode, start);
    range.setEnd(textNode, start + italicMatch[0].length);
    
    document.execCommand('insertHTML', false, `<i>${italicText}</i> `);
    
    // Reset italic formatting for subsequent text
    setTimeout(() => {
      if (document.queryCommandState('italic')) {
        document.execCommand('italic', false);
      }
    }, 0);
    return;
  }

  // Check for ~~strikethrough~~ pattern
  const strikeMatch = text.match(/~~([^~]+)~~$/);
  if (strikeMatch && cursorPos >= text.length) {
    const strikeText = strikeMatch[1];
    const start = text.lastIndexOf('~~' + strikeText + '~~');

    range.setStart(textNode, start);
    range.setEnd(textNode, start + strikeMatch[0].length);

    document.execCommand('insertHTML', false, `<s>${strikeText}</s> `);

    // Reset strikethrough formatting for subsequent text if browser toggled state
    setTimeout(() => {
      if (document.queryCommandState && document.queryCommandState('strikeThrough')) {
        document.execCommand('strikeThrough', false);
      }
    }, 0);
    return;
  }
}

function toggleParagraphHighlight() {
  const sel = window.getSelection();
  if (sel.rangeCount === 0) return;
  
  const range = sel.getRangeAt(0);
  let container = range.commonAncestorContainer;
  
  // Find the paragraph element
  while (container && container.nodeType !== Node.ELEMENT_NODE) {
    container = container.parentNode;
  }
  
  while (container && container.tagName !== 'P' && container !== els.editor) {
    container = container.parentNode;
  }
  
  if (container && container.tagName === 'P') {
    container.classList.toggle('highlighted-para');
    // Trigger save since DOM manipulation doesn't fire input event
    status('Saving…');
    saveDebounced();
  }
}

function sanitiseHtmlOnPaste(e) {
  if (!e.clipboardData) return;
  const html = e.clipboardData.getData('text/html');
  const text = e.clipboardData.getData('text/plain');
  if (!html) return; // let browser handle plain text normally
  e.preventDefault();
  const cleaned = cleanHtml(html);
  document.execCommand('insertHTML', false, cleaned || text);
}

function cleanHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const allowed = new Set(['B','I','U','S','STRIKE','UL','OL','LI','P','BR','A']);
  const safeHref = (url) => {
    try {
      const u = new URL(url, 'http://x');
      return ['http:', 'https:', 'mailto:'].includes(u.protocol);
    } catch { return false; }
  };
  const walk = node => {
    for (const child of Array.from(node.children)) {
      if (!allowed.has(child.tagName)) {
        // Replace disallowed element with its textContent wrapped in P
        const p = doc.createElement('p');
        p.textContent = child.textContent;
        child.replaceWith(p);
      } else {
        // sanitize attributes
        for (const attr of Array.from(child.attributes)) {
          const name = attr.name.toLowerCase();
          const value = attr.value;
          if (child.tagName === 'A' && name === 'href') {
            if (!safeHref(value || '')) child.removeAttribute('href');
            child.setAttribute('rel', 'noopener noreferrer');
          } else if (child.tagName === 'P' && name === 'class' && value === 'highlighted-para') {
            // Allow highlighted-para class on p elements
            continue;
          } else if (name.startsWith('on')) {
            child.removeAttribute(attr.name);
          } else if (!['href','rel','class'].includes(name)) {
            child.removeAttribute(attr.name);
          } else if (name === 'class' && value !== 'highlighted-para') {
            child.removeAttribute(attr.name);
          }
        }
        walk(child);
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// --- Simple GLOBAL To-Do list ---
let currentTodos = [];

function getTodoStorageKey() {
  return 'ln_todos_global';
}

function loadTodos() {
  try {
    const raw = localStorage.getItem(getTodoStorageKey());
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
}

const pushTodosRemoteDebounced = debounce(async () => {
  try {
    const todos = loadTodos();
    await putTodosRemote(todos);
  } catch (e) {
    // enqueue todos for retry
    try {
      const todos = loadTodos();
      enqueueOperation({ type: 'put_todos', todos });
    } catch {}
  }
}, 500);

function saveTodos(todos) {
  try {
    localStorage.setItem(getTodoStorageKey(), JSON.stringify(todos));
  } catch {}
  // Best-effort remote push (ignore if not configured)
  pushTodosRemoteDebounced();
}

function renderTodos() {
  if (!els.todoList) return;
  els.todoList.innerHTML = '';
  for (const item of currentTodos) {
    const li = document.createElement('li');
    li.tabIndex = 0;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!item.done;
    cb.onchange = () => {
      item.done = cb.checked;
      saveTodos(currentTodos);
      txt.classList.toggle('done', !!item.done);
    };

    const txt = document.createElement('div');
    txt.className = `todo-text${item.done ? ' done' : ''}`;
    txt.textContent = item.text;

    const del = document.createElement('button');
    del.className = 'todo-del';
    del.textContent = '×';
    del.title = 'Delete task';
    del.onclick = () => {
      currentTodos = currentTodos.filter(t => t.id !== item.id);
      saveTodos(currentTodos);
      renderTodos();
    };

    li.appendChild(cb);
    li.appendChild(txt);
    li.appendChild(del);
    els.todoList.appendChild(li);

    // Keyboard support on list item
    li.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        currentTodos = currentTodos.filter(t => t.id !== item.id);
        saveTodos(currentTodos);
        renderTodos();
      }
    });
  }
}

function addTodoFromInput() {
  const text = (els.todoInput.value || '').trim();
  if (!text) return;
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  currentTodos.push({ id, text, done: false });
  saveTodos(currentTodos);
  els.todoInput.value = '';
  renderTodos();
}

async function refreshList(selectId) {
  const items = await listNotes();
  els.notes.innerHTML = '';
  for (const n of items) {
    const li = document.createElement('li');
    li.dataset.id = n.id;
    if (n.id === selectId) li.classList.add('active');
    if (n.pinned) li.classList.add('pinned');
    
    const titleDiv = document.createElement('div');
    titleDiv.className = 'note-title';
    
    const mainDiv = document.createElement('div');
    mainDiv.className = 'note-main';
    mainDiv.textContent = n.title || '(untitled)';
    
    const metaDiv = document.createElement('div');
    metaDiv.className = 'note-meta';
    
    const dateDiv = document.createElement('div');
    dateDiv.className = 'note-date';
    const modifiedDate = formatDate(n.modified || n.created);
    const createdDate = new Date(n.created).toLocaleDateString();
    dateDiv.textContent = modifiedDate;
    dateDiv.title = `Created: ${createdDate}`;
    
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'note-actions';
    
    const pinBtn = document.createElement('button');
    pinBtn.className = `pin-btn${n.pinned ? ' pinned' : ''}`;
    pinBtn.innerHTML = '★';
    pinBtn.title = n.pinned ? 'Unpin note' : 'Pin note';
    pinBtn.onclick = async (e) => {
      e.stopPropagation();
      await togglePin(n.id);
      await refreshList(selectId);
    };
    
    const duplicateBtn = document.createElement('button');
    duplicateBtn.className = 'duplicate-btn';
    duplicateBtn.innerHTML = '⧉';
    duplicateBtn.title = 'Duplicate note';
    duplicateBtn.onclick = async (e) => {
      e.stopPropagation();
      const newNote = await duplicateNote(n.id);
      if (newNote) {
        await refreshList(newNote.id);
        await openNote(newNote.id);
      }
    };
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete note';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      onDeleteNote(n.id);
    };
    
    actionsDiv.appendChild(pinBtn);
    actionsDiv.appendChild(duplicateBtn);
    actionsDiv.appendChild(deleteBtn);
    
    metaDiv.appendChild(dateDiv);
    metaDiv.appendChild(actionsDiv);
    
    titleDiv.appendChild(mainDiv);
    titleDiv.appendChild(metaDiv);
    
    li.onclick = (e) => {
      // Don't trigger note opening if clicking on action buttons
      if (e.target.closest('.note-actions')) return;
      openNote(n.id);
      // Close drawer on mobile after selecting a note
      try { document.body.classList.remove('drawer-open'); } catch {}
    };
    
    li.appendChild(titleDiv);
    els.notes.appendChild(li);
  }
}

async function openNote(id) {
  const items = await listNotes();
  const meta = items.find(n => n.id === id) || null;
  if (!meta) return;
  
  // Save cursor position of previous note
  if (currentNote) {
    const pos = getSelectionPosition();
    await updateCursorPosition(currentNote.id, pos);
  }
  
  currentNote = meta;
  const html = await readNote(id);
  els.editor.innerHTML = html;
  els.title.value = currentNote.title || '';
  
  // Restore cursor position
  setTimeout(() => {
    if (currentNote.cursorPos) {
      setSelectionPosition(currentNote.cursorPos);
    }
    // Only auto-focus editor if it has content, otherwise let user start with title
    if (els.editor.innerText.trim()) {
      els.editor.focus();
    }
  }, 50);
  
  for (const li of els.notes.querySelectorAll('li')) li.classList.toggle('active', li.dataset.id === id);
  status('');
}

const saveNow = async () => {
  if (!currentNote) return;
  const html = els.editor.innerHTML;
  await writeNote(currentNote.id, html);
  const title = (els.title.value || stripTitleFrom(els.editor.innerText));
  await updateTitleAndModified(currentNote.id, title);
  await refreshList(currentNote.id);
  setSyncDot('synced');
  // Remote push with LWW Plan A inside sync layer
  try {
    await putNoteHtml(currentNote.id, html);
    const idx = await listNotes();
    await putIndex(idx);
    try { await setNoteBase(currentNote.id, '', html); } catch {}
    try { await setNoteDirty(currentNote.id, false); } catch {}
  } catch (e) {
    // enqueue for retry when offline or not configured
    try {
      const idx = await listNotes();
      enqueueOperation({ type: 'put_note', noteId: currentNote.id, html });
      enqueueOperation({ type: 'put_index', index: idx });
    } catch {}
    setSyncDot('offline');
  }
};
const saveDebounced = debounce(saveNow, 400);

function filterList(q) {
  q = q.trim().toLowerCase();
  const lis = els.notes.querySelectorAll('li');
  for (const li of lis) {
    const title = li.textContent.toLowerCase();
    let show = !q || title.includes(q);
    if (!show && currentNote && li.dataset.id === currentNote.id) {
      // attempt in-editor text match when open
      show = els.editor.innerText.toLowerCase().includes(q);
    }
    li.style.display = show ? '' : 'none';
  }
}

async function onNew() {
  const entry = await createNote();
  await refreshList(entry.id);
  await openNote(entry.id);
  // Focus title first to give editor time to initialize properly
  els.title.focus();
}

async function onDeleteNote(id) {
  const items = await listNotes();
  const note = items.find(n => n.id === id);
  const title = note ? (note.title || '(untitled)') : 'this note';
  
  if (!confirm(`Delete "${title}"?`)) return;
  
  await deleteNote(id);
  // Remote delete best-effort
  try {
    await deleteNoteRemote(id);
    const idxNow = await listNotes();
    await putIndex(idxNow);
  } catch {}
  // enqueue delete if failed
  try {
    const idxNow = await listNotes();
    enqueueOperation({ type: 'delete_note', noteId: id, index: idxNow });
  } catch {}
  
  // If we're deleting the currently open note, clear the editor
  if (currentNote && currentNote.id === id) {
    currentNote = null;
    els.editor.innerHTML = '';
    els.title.value = '';
    
    // Open the first remaining note, or create a new one
    const remaining = await listNotes();
    if (remaining.length > 0) {
      await openNote(remaining[0].id);
    } else {
      await onNew();
      return;
    }
  }
  
  await refreshList(currentNote ? currentNote.id : null);
}

async function onDeleteCurrent() {
  if (!currentNote) return;
  await onDeleteNote(currentNote.id);
}

function bindToolbar() {
  const ensureFocus = () => { if (document.activeElement !== els.editor) els.editor.focus(); };
  $('b').onclick = () => { ensureFocus(); document.execCommand('bold'); };
  $('i').onclick = () => { ensureFocus(); document.execCommand('italic'); };
  $('u').onclick = () => { ensureFocus(); document.execCommand('underline'); };
  $('s').onclick = () => { ensureFocus(); document.execCommand('strikeThrough'); };
  $('highlight').onclick = () => { ensureFocus(); toggleParagraphHighlight(); };
  $('ul').onclick = () => { ensureFocus(); document.execCommand('insertUnorderedList'); };
}

function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();

    // Global meta shortcuts
    if (e.metaKey) {
      if (k === 'n') { e.preventDefault(); onNew(); return; }
      if (k === 'backspace') { e.preventDefault(); onDeleteCurrent(); return; }
      // Do not hijack Cmd+F unless search is already focused
      if (k === 'f') {
        if (document.activeElement === els.search) {
          // allow typing in search box, but do not prevent default browser Find
          return;
        }
        // let browser's find operate; do not preventDefault
        return;
      }
    }

    // Editor-scoped formatting shortcuts
    if (e.metaKey && document.activeElement === els.editor) {
      if (k === 'b') { e.preventDefault(); document.execCommand('bold'); }
      else if (k === 'i') { e.preventDefault(); document.execCommand('italic'); }
      else if (k === 'u') { e.preventDefault(); document.execCommand('underline'); }
      else if (k === 'x' && e.shiftKey) { e.preventDefault(); document.execCommand('strikeThrough'); }
    }
  });
}

// Lightweight toolbar active-state updater
let rafPending = false;
function scheduleUpdateToolbarState() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!els.editor) return;
    // Only compute when selection is inside editor
    const sel = window.getSelection();
    let inEditor = false;
    if (sel && sel.rangeCount) {
      let node = sel.anchorNode;
      while (node) {
        if (node === els.editor) { inEditor = true; break; }
        node = node.parentNode;
      }
    }
    if (!inEditor) {
      for (const id of ['b','i','u','s','ul','highlight']) {
        const btn = $(id);
        if (btn) btn.classList.remove('active');
      }
      return;
    }

    const states = {
      b: document.queryCommandState('bold'),
      i: document.queryCommandState('italic'),
      u: document.queryCommandState('underline'),
      s: document.queryCommandState('strikeThrough')
    };
    for (const id of ['b','i','u','s']) {
      const btn = $(id);
      if (btn) btn.classList.toggle('active', !!states[id]);
    }

    // List active state
    const listActive = document.queryCommandState('insertUnorderedList');
    const ulBtn = $('ul');
    if (ulBtn) ulBtn.classList.toggle('active', !!listActive);

    // Highlight paragraph active state
    let highlightActive = false;
    if (sel && sel.rangeCount) {
      let node = sel.anchorNode;
      while (node && node !== els.editor) {
        if (node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('highlighted-para')) {
          highlightActive = true;
          break;
        }
        node = node.parentNode;
      }
    }
    const hiBtn = $('highlight');
    if (hiBtn) hiBtn.classList.toggle('active', highlightActive);
  });
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

async function exportAll() {
  if (!window.JSZip) { alert('Export unavailable: JSZip missing.'); return; }
  const { listNotes, readNote } = await import('./notes.js');
  const zip = new JSZip();
  const idx = await listNotes();
  zip.file('index.json', JSON.stringify(idx));
  // Include global todos in backup
  try { zip.file('todos.json', JSON.stringify(loadTodos())); } catch {}
  const dir = zip.folder('notes');
  for (const n of idx) {
    const html = await readNote(n.id);
    dir.file(`${n.id}.html`, html);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, 'lightnotes-backup.zip');
  
  // Update backup timestamp
  localStorage.setItem('ln_last_backup', String(Date.now()));
}

async function importZip(file) {
  if (!window.JSZip) { alert('Import unavailable: JSZip missing.'); return; }
  const { initStore, saveIndex, writeNote } = await import('./notes.js');
  await initStore();
  const zip = await JSZip.loadAsync(file);
  const idxFile = zip.file('index.json');
  if (!idxFile) { alert('Invalid backup: missing index.json'); return; }
  let idx;
  try { idx = JSON.parse(await idxFile.async('string')); }
  catch { alert('Invalid index.json in backup'); return; }
  for (const entry of idx) {
    const f = zip.file(`notes/${entry.id}.html`);
    if (!f) continue;
    const html = await f.async('string');
    await writeNote(entry.id, html);
  }
  await saveIndex(idx);
  // Optionally restore todos.json if present
  try {
    const tf = zip.file('todos.json');
    if (tf) {
      const raw = await tf.async('string');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        currentTodos = parsed;
        saveTodos(currentTodos);
      }
    }
  } catch {}
  await refreshList();

  // After a manual import, push a clean snapshot to R2: remove old remote notes/todos, then upload current notes, index, and todos
  try {
    setSyncDot('syncing');
    // Delete remote notes
    const remoteNoteKeys = await listKeys('notes/');
    for (const key of remoteNoteKeys) {
      const id = key.replace(/^notes\//, '').replace(/\.html$/, '');
      if (id) {
        try { await deleteNoteRemote(id); } catch {}
      }
    }
    // Reset remote todos
    try { await putTodosRemote([]); } catch {}
    // Upload current notes first
    const currentIdx = await listNotes();
    for (const n of currentIdx) {
      try {
        const html = await readNote(n.id);
        await putNoteHtml(n.id, html);
      } catch {}
    }
    // Then upload index
    await putIndex(currentIdx);
    // Push current todos if any
    try {
      const todos = loadTodos();
      await putTodosRemote(todos);
    } catch {}
    setSyncDot('synced');
  } catch (e) {
    console.warn('Remote reset/upload after import failed:', e);
    setSyncDot('offline');
  }
}

async function boot() {
  els.search = $('search');
  els.notes = $('notes');
  els.editor = $('editor');
  els.title = $('title');
  els.status = $('status');
  // indicator initial state
  setSyncDot(navigator.onLine ? 'synced' : 'offline');
  window.addEventListener('online', () => setSyncDot('synced'));
  window.addEventListener('offline', () => setSyncDot('offline'));
  els.settingsBtn = $('settingsBtn');
  els.settingsModal = $('settingsModal');
  els.apiUrl = $('apiUrl');
  els.apiToken = $('apiToken');
  els.settingsSave = $('settingsSave');
  els.settingsClose = $('settingsClose');
  els.newBtn = $('new');
  els.expBtn = $('exp');
  els.impBtn = $('imp');
  els.impFile = $('importFile');
  // To-Do sidebar elements
  els.todoInput = $('todoInput');
  els.todoAdd = $('todoAdd');
  els.todoList = $('todoList');

  // Mobile UI controls
  els.menuBtn = $('menuBtn');
  els.tabNotes = $('tabNotes');
  els.tabEditor = $('tabEditor');
  els.tabTodos = $('tabTodos');

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  
  // Wire mobile controls (no-ops on desktop where elements are hidden)
  if (els.menuBtn) {
    els.menuBtn.addEventListener('click', () => {
      document.body.classList.toggle('drawer-open');
      // Close To-Do if opening drawer
      if (document.body.classList.contains('drawer-open')) {
        document.body.classList.remove('todo-open');
      }
    });
  }
  const setActiveTab = (active) => {
    for (const id of ['tabNotes','tabEditor','tabTodos']) {
      const el = $(id);
      if (el) el.classList.toggle('active', id === active);
    }
  };
  if (els.tabNotes) {
    els.tabNotes.addEventListener('click', () => {
      document.body.classList.add('drawer-open');
      document.body.classList.remove('todo-open');
      setActiveTab('tabNotes');
    });
  }
  if (els.tabEditor) {
    els.tabEditor.addEventListener('click', () => {
      document.body.classList.remove('drawer-open');
      document.body.classList.remove('todo-open');
      setActiveTab('tabEditor');
    });
  }
  if (els.tabTodos) {
    els.tabTodos.addEventListener('click', () => {
      const willOpen = !document.body.classList.contains('todo-open');
      document.body.classList.remove('drawer-open');
      document.body.classList.toggle('todo-open', willOpen);
      setActiveTab(willOpen ? 'tabTodos' : 'tabEditor');
    });
  }
  // Close overlays when resizing back to desktop widths
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) {
      document.body.classList.remove('drawer-open','todo-open');
      setActiveTab('tabEditor');
    }
  });
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'flush-queue') {
        try { flushQueue(); } catch {}
      }
    });
  }

  try {
    await initStore();
    await refreshList();
  } catch (err) {
    console.error('Storage init failed:', err);
    status('Storage error - clearing and retrying...');
    
    // Clear potentially corrupted localStorage
    try {
      localStorage.removeItem('ln_index_v1');
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('ln_note_')) {
          localStorage.removeItem(key);
        }
      }
      await initStore();
      await refreshList();
      status('Storage reset successfully');
    } catch (finalErr) {
      console.error('Final storage init failed:', finalErr);
      status('Storage unavailable');
      return;
    }
  }

  // Attempt startup sync with remote (non-fatal)
  try { await syncStartup(); } catch (e) { console.warn('Startup sync skipped:', e && e.message); }
  try { setupQueueRetry(); await flushQueue(); } catch {}

  els.editor.addEventListener('input', (e) => { 
    handleMarkdownShortcuts(e);
    setSyncDot('syncing');
    saveDebounced(); 
    scheduleUpdateToolbarState();
    if (currentNote) { try { setNoteDirty(currentNote.id, true); } catch {} }
  });
  
  // Ensure proper paragraph structure when editor gets focus
  els.editor.addEventListener('focus', () => {
    // If editor is empty or has no proper paragraph structure, add one
    if (!els.editor.innerHTML.trim() || !els.editor.querySelector('p')) {
      els.editor.innerHTML = '<p><br></p>';
      // Place cursor at start of paragraph
      const p = els.editor.querySelector('p');
      const range = document.createRange();
      const selection = window.getSelection();
      range.setStart(p, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
  els.editor.addEventListener('paste', sanitiseHtmlOnPaste);
  els.editor.addEventListener('mouseup', scheduleUpdateToolbarState);
  els.editor.addEventListener('keyup', scheduleUpdateToolbarState);

  // Flush saves on lifecycle events
  window.addEventListener('pagehide', () => { try { saveNow(true); } catch {} }, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { try { saveNow(true); } catch {} }
    if (document.visibilityState === 'visible') { try { focusSyncThrottled(); } catch {} }
  });
  window.addEventListener('pageshow', (e) => { try { focusSyncThrottled(); } catch {} });
  
  // Sidebar resizing
  const resizer = document.querySelector('.sidebar-resizer');
  let isResizing = false;
  
  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = Math.max(200, Math.min(500, e.clientX));
    document.documentElement.style.setProperty('--left-w', `${newWidth}px`);
    localStorage.setItem('ln_left_w', String(newWidth));
  });
  
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
    }
  });
  
  // Restore sidebar width is handled early in index.html via CSS var

  // Right sidebar resizing
  const todoResizer = document.querySelector('.todo-resizer');
  let isResizingRight = false;

  todoResizer.addEventListener('mousedown', (e) => {
    isResizingRight = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizingRight) return;
    const bodyRect = document.body.getBoundingClientRect();
    const fromRight = Math.max(200, Math.min(500, bodyRect.right - e.clientX));
    const leftWidth = parseInt(localStorage.getItem('ln_left_w') || localStorage.getItem('ln_sidebar_width') || '280', 10);
    document.documentElement.style.setProperty('--left-w', `${leftWidth}px`);
    document.documentElement.style.setProperty('--right-w', `${fromRight}px`);
    localStorage.setItem('ln_right_w', String(fromRight));
  });

  document.addEventListener('mouseup', () => {
    if (isResizingRight) {
      isResizingRight = false;
      document.body.style.cursor = '';
    }
  });

  // Restore right sidebar width handled early via CSS var
  els.title.addEventListener('input', debounce(async () => {
    if (!currentNote) return;
    const t = els.title.value.trim();
    await updateTitleAndModified(currentNote.id, t);
    await refreshList(currentNote.id);
  }, 200));

  els.search.addEventListener('input', (e) => filterList(e.target.value));
  els.newBtn.addEventListener('click', onNew);
  els.expBtn.addEventListener('click', exportAll);
  els.impBtn.addEventListener('click', () => els.impFile.click());
  els.impFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await importZip(file);
    e.target.value = '';
  });

  bindToolbar();
  bindShortcuts();

  // Improve editing behavior in Safari/WebKit
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
    document.execCommand('styleWithCSS', false, true);
  } catch {}

  // Text size controls
  els.textSizeDown = $('textSizeDown');
  els.textSizeUp = $('textSizeUp');
  const savedZoom = parseFloat(localStorage.getItem('ln_zoom') || '1');
  zoomScale = isFinite(savedZoom) ? savedZoom : 1;
  applyZoom(zoomScale);
  
  els.textSizeDown.addEventListener('click', () => {
    zoomScale = Math.max(0.8, zoomScale - 0.1);
    applyZoom(zoomScale);
    localStorage.setItem('ln_zoom', String(zoomScale));
  });
  
  els.textSizeUp.addEventListener('click', () => {
    zoomScale = Math.min(1.8, zoomScale + 0.1);
    applyZoom(zoomScale);
    localStorage.setItem('ln_zoom', String(zoomScale));
  });

  // Font controls
  els.fontSelect = $('fontSelect');
  const savedFont = localStorage.getItem('ln_font') || 'sans';
  applyFont(savedFont);
  els.fontSelect.value = savedFont;
  els.fontSelect.addEventListener('change', (e) => {
    const font = e.target.value;
    applyFont(font);
    localStorage.setItem('ln_font', font);
  });

  // To-Do controls (guard for Safari timing)
  if (els.todoAdd) {
    els.todoAdd.addEventListener('click', addTodoFromInput);
  }
  if (els.todoInput) {
    els.todoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTodoFromInput();
      }
    });
  }

  // Load global todos once
  currentTodos = loadTodos();
  renderTodos();

  // Settings UI
  if (els.settingsBtn && els.settingsModal && els.apiUrl && els.apiToken && els.settingsSave && els.settingsClose) {
    // Load existing values
    try {
      els.apiUrl.value = localStorage.getItem('ln_api_url') || '';
      els.apiToken.value = localStorage.getItem('ln_token') || '';
    } catch {}

    const openSettings = () => { els.settingsModal.classList.remove('hidden'); };
    const closeSettings = () => { els.settingsModal.classList.add('hidden'); };

    els.settingsBtn.addEventListener('click', openSettings);
    els.settingsClose.addEventListener('click', closeSettings);
    els.settingsSave.addEventListener('click', async () => {
      try {
        const hadRemote = remoteConfigured();
        const url = (els.apiUrl.value || '').trim().replace(/\/$/, '');
        const token = (els.apiToken.value || '').trim();
        if (url) localStorage.setItem('ln_api_url', url);
        if (token) localStorage.setItem('ln_token', token);
        const ss = $('settingsStatus');
        if (ss) { ss.textContent = 'Saved'; setTimeout(() => { ss.textContent = ''; }, 1200); }
        // On first-time configuration, perform a fresh pull of all notes/todos from R2
        const hasRemoteNow = remoteConfigured();
        if (!hadRemote && hasRemoteNow) {
          try {
            setSyncDot('syncing');
            await pullAllFromRemote();
            setSyncDot('synced');
        // Set a short cool-off so immediate focus sync doesn't refetch
        try { localStorage.setItem('ln_focus_cooloff', String(Date.now() + 3000)); } catch {}
          } catch (e) {
            console.warn('Initial remote pull failed:', e);
            setSyncDot('offline');
          }
        }
      } catch {}
    });
    // ESC closes
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.settingsModal.classList.add('hidden'); });
    // Click outside closes
    els.settingsModal.addEventListener('click', (e) => { if (e.target === els.settingsModal) els.settingsModal.classList.add('hidden'); });
  }

  // Open the first note or create a starter
  const notes = await listNotes();
  if (notes.length) {
    await openNote(notes[0].id);
    // Check backup reminder after loading notes
    setTimeout(() => checkBackupReminder(), 2000);
  } else {
    await onNew();
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  // Document already parsed
  boot();
}

// expose for debugging
window.__app = { refreshList, openNote };

function applyZoom(scale) {
  // Remove transform scaling and use font-size only for proper text reflow
  els.editor.style.transform = '';
  els.editor.style.transformOrigin = '';
  els.editor.style.width = '';
  els.editor.style.maxWidth = '';
  
  // Scale the font size and line height proportionally
  els.editor.style.fontSize = `${Math.round(14 * scale)}px`;
  els.editor.style.lineHeight = `${1.5}`;
}

function applyFont(fontFamily) {
  // Remove any existing font classes
  els.editor.classList.remove('font-sans', 'font-serif', 'font-mono');
  
  // Add the selected font class
  els.editor.classList.add(`font-${fontFamily}`);
}

// --- Remote sync bootstrap ---
function remoteConfigured() {
  try {
    return !!(localStorage.getItem('ln_api_url') && localStorage.getItem('ln_token'));
  } catch { return false; }
}

async function syncStartup() {
  if (!remoteConfigured()) return;
  // Ensure remote has index; if not, we'll create it on first PUT
  try {
    const res = await getIndex();
    if (!res.unchanged && res.data) {
      // If data is string, parse; otherwise accept array
      const remoteIdx = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      // Merge: prefer local entries, add missing from remote
      const localIdx = await listNotes();
      const map = new Map(localIdx.map(n => [n.id, n]));
      for (const entry of Array.isArray(remoteIdx) ? remoteIdx : []) {
        if (!map.has(entry.id)) map.set(entry.id, entry);
      }
      const merged = Array.from(map.values());
      await saveIndex(merged);
      // Pull any missing note bodies
      const haveIds = new Set((await listNotes()).map(n => n.id));
      for (const entry of merged) {
        try {
          if (haveIds.has(entry.id)) {
            // ensure file exists locally; read will throw if not present in OPFS
            try { await readNote(entry.id); }
            catch {
              const noteRes = await getNoteHtml(entry.id);
              if (!noteRes.unchanged && typeof noteRes.data === 'string') {
                await writeNote(entry.id, noteRes.data);
              }
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    // If remote empty, seed on first save; ignore
  }
  // Pull todos
  try {
    const t = await getTodosRemote();
    if (!t.unchanged && t.data) {
      const parsed = typeof t.data === 'string' ? JSON.parse(t.data) : t.data;
      if (Array.isArray(parsed)) {
        currentTodos = parsed;
        saveTodos(currentTodos);
        renderTodos();
      }
    }
  } catch {}
}

async function pullAllFromRemote() {
  // Pull index
  try {
    const res = await getIndex();
    let idx = [];
    if (!res.unchanged && res.data) {
      idx = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      if (!Array.isArray(idx)) idx = [];
    }
    // Save index locally
    await saveIndex(idx);
    // Pull each note body
    for (const entry of idx) {
      try {
        const nr = await getNoteHtml(entry.id);
        if (!nr.unchanged && typeof nr.data === 'string') {
          await writeNote(entry.id, nr.data);
        }
      } catch {}
    }
  } catch {}
  // Pull todos
  try {
    const t = await getTodosRemote();
    if (!t.unchanged && t.data) {
      const parsed = typeof t.data === 'string' ? JSON.parse(t.data) : t.data;
      if (Array.isArray(parsed)) {
        currentTodos = parsed;
        saveTodos(currentTodos);
        renderTodos();
      }
    }
  } catch {}
  // Refresh UI
  await refreshList();
}

// --- Focus sync: push-first, pull-second (ETag-aware) ---
let lastFocusSyncAt = 0;
const focusSyncThrottled = debounce(() => { focusSync().catch(() => {}); }, 1000);

async function focusSync() {
  if (!remoteConfigured()) return;
  const now = Date.now();
  const coolOffUntil = parseInt(localStorage.getItem('ln_focus_cooloff') || '0', 10);
  if (now < coolOffUntil) return;
  setSyncDot('syncing');
  try { await saveNow(true); } catch {}
  try { await flushQueue(); } catch {}
  try {
    const res = await getIndex();
    let idx = [];
    if (!res.unchanged && res.data) {
      idx = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      if (!Array.isArray(idx)) idx = [];
      await saveIndex(idx);
    }
    const localIdx = await listNotes();
    const localIds = new Set(localIdx.map(n => n.id));
    for (const entry of idx) {
      if (!localIds.has(entry.id)) continue;
      const dirty = await isNoteDirty(entry.id);
      if (dirty) continue;
      try {
        const nr = await getNoteHtml(entry.id);
        if (!nr.unchanged && typeof nr.data === 'string') {
          await writeNote(entry.id, nr.data);
          if (currentNote && currentNote.id === entry.id) {
            const stillDirty = await isNoteDirty(entry.id);
            if (!stillDirty) {
              els.editor.innerHTML = nr.data;
            }
          }
        }
      } catch {}
    }
    setSyncDot('synced');
  } catch (e) {
    setSyncDot('offline');
  }
  lastFocusSyncAt = Date.now();
}


