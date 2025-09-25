import { initStore, listNotes, readNote, writeNote, createNote, deleteNote, updateTitleAndModified, togglePin, updateCursorPosition, duplicateNote } from './notes.js';

const els = {};
let currentNote = null; // { id, title, created, modified }
let zoomScale = 1;

function $(id) { return document.getElementById(id); }

function debounce(fn, ms = 400) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function status(text) {
  els.status.textContent = text;
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

function checkBackupReminder() {
  const lastBackup = localStorage.getItem('ln_last_backup');
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  
  if (!lastBackup || (now - parseInt(lastBackup)) > sevenDays) {
    showBackupNotification();
  }
}

function showBackupNotification() {
  const notification = $('notification');
  const notificationText = $('notificationText');
  const actionBtn = $('notificationAction');
  const dismissBtn = $('notificationDismiss');
  
  notificationText.textContent = "It's been a while since your last backup. Consider exporting your notes.";
  notification.classList.remove('hidden');
  
  actionBtn.onclick = () => {
    exportAll();
    localStorage.setItem('ln_last_backup', String(Date.now()));
    hideBackupNotification();
  };
  
  dismissBtn.onclick = () => {
    hideBackupNotification();
    // Set a shorter reminder period (3 days) if dismissed
    localStorage.setItem('ln_last_backup', String(Date.now() - (4 * 24 * 60 * 60 * 1000)));
  };
}

function hideBackupNotification() {
  const notification = $('notification');
  notification.classList.add('hidden');
}

function handleMarkdownShortcuts(e) {
  const sel = window.getSelection();
  if (sel.rangeCount === 0) return;
  
  const range = sel.getRangeAt(0);
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return;
  
  const text = textNode.textContent;
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
  const allowed = new Set(['B','I','U','UL','OL','LI','P','BR','A']);
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
            try { new URL(value, document.baseURI); } catch { child.removeAttribute('href'); }
            child.setAttribute('rel', 'noopener');
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
    els.editor.focus();
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
  status('Saved');
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
  els.editor.focus();
}

async function onDeleteNote(id) {
  const items = await listNotes();
  const note = items.find(n => n.id === id);
  const title = note ? (note.title || '(untitled)') : 'this note';
  
  if (!confirm(`Delete "${title}"?`)) return;
  
  await deleteNote(id);
  
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
  $('highlight').onclick = () => { ensureFocus(); toggleParagraphHighlight(); };
  $('ul').onclick = () => { ensureFocus(); document.execCommand('insertUnorderedList'); };
}

function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (!e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); onNew(); }
    else if (k === 'f') { e.preventDefault(); els.search.focus(); }
    else if (k === 'backspace') { e.preventDefault(); onDeleteCurrent(); }
    else if (k === 'b' && document.activeElement === els.editor) { e.preventDefault(); document.execCommand('bold'); }
    else if (k === 'i' && document.activeElement === els.editor) { e.preventDefault(); document.execCommand('italic'); }
    else if (k === 'u' && document.activeElement === els.editor) { e.preventDefault(); document.execCommand('underline'); }
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
  await refreshList();
}

async function boot() {
  els.search = $('search');
  els.notes = $('notes');
  els.editor = $('editor');
  els.title = $('title');
  els.status = $('status');
  els.newBtn = $('new');
  els.expBtn = $('exp');
  els.impBtn = $('imp');
  els.impFile = $('importFile');

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

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

  els.editor.addEventListener('input', (e) => { 
    handleMarkdownShortcuts(e);
    status('Saving…'); 
    saveDebounced(); 
  });
  els.editor.addEventListener('paste', sanitiseHtmlOnPaste);
  
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
    document.body.style.gridTemplateColumns = `${newWidth}px 1fr`;
    localStorage.setItem('ln_sidebar_width', String(newWidth));
  });
  
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
    }
  });
  
  // Restore sidebar width
  const savedWidth = localStorage.getItem('ln_sidebar_width');
  if (savedWidth) {
    document.body.style.gridTemplateColumns = `${savedWidth}px 1fr`;
  }
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


