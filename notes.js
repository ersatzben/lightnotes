import * as fs from './opfs.js';

let rootHandle;
let notesDirHandle;
let indexFileHandle;
let storageMode = 'opfs'; // 'opfs' | 'local'
const LS_INDEX_KEY = 'ln_index_v1';
const LS_NOTE_PREFIX = 'ln_note_';
const LS_META_PREFIX = 'ln_meta_';
let metaDirHandle; // OPFS directory for per-note metadata

export async function initStore() {
  try {
    rootHandle = await fs.getRoot();
    notesDirHandle = await fs.getDir(rootHandle, 'notes');
		// Ensure meta dir exists for per-note metadata
		try { metaDirHandle = await fs.getDir(rootHandle, 'meta'); }
		catch { metaDirHandle = await fs.createDir(rootHandle, 'meta'); }
    indexFileHandle = await fs.getFileHandle(rootHandle, 'index.json');
    try {
      const txt = await fs.readText(indexFileHandle);
      if (!txt || !txt.trim()) {
        await fs.writeText(indexFileHandle, '[]');
      } else {
        try { JSON.parse(txt); }
        catch { await fs.writeText(indexFileHandle, '[]'); }
      }
    } catch {
      await fs.writeText(indexFileHandle, '[]');
    }
    storageMode = 'opfs';
  } catch (e) {
    // Fallback to localStorage
    storageMode = 'local';
    if (!localStorage.getItem(LS_INDEX_KEY)) localStorage.setItem(LS_INDEX_KEY, '[]');
  }
}

export async function listNotes() {
  if (storageMode === 'local') {
    try {
      const json = localStorage.getItem(LS_INDEX_KEY) || '[]';
      const arr = JSON.parse(json);
      // Sort: pinned first, then by modified time
      arr.sort((a, b) => {
        if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
        return (b.modified || 0) - (a.modified || 0) || (b.created || 0) - (a.created || 0);
      });
      return arr;
    } catch (e) {
      console.warn('localStorage index corrupted, resetting:', e);
      localStorage.setItem(LS_INDEX_KEY, '[]');
      return [];
    }
  }
  let json = await fs.readText(indexFileHandle);
  if (!json || !json.trim()) {
    await fs.writeText(indexFileHandle, '[]');
    json = '[]';
  }
  let arr;
  try {
    arr = JSON.parse(json);
  } catch (e) {
    // reset corrupted index
    await fs.writeText(indexFileHandle, '[]');
    arr = [];
  }
  // Sort: pinned first, then by modified time
  arr.sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
    return (b.modified || 0) - (a.modified || 0) || (b.created || 0) - (a.created || 0);
  });
  return arr;
}

export async function saveIndex(notesArray) {
  if (storageMode === 'local') {
    try {
      localStorage.setItem(LS_INDEX_KEY, JSON.stringify(notesArray || []));
    } catch (e) {
      console.error('Failed to save index to localStorage:', e);
    }
    return;
  }
  await fs.writeText(indexFileHandle, JSON.stringify(notesArray || []));
}

export async function readNote(id) {
  if (storageMode === 'local') {
    return localStorage.getItem(LS_NOTE_PREFIX + id) || '<p></p>';
  }
  const fh = await fs.getFileHandle(notesDirHandle, `${id}.html`);
  return await fs.readText(fh);
}

export async function writeNote(id, html) {
  if (storageMode === 'local') {
    localStorage.setItem(LS_NOTE_PREFIX + id, html);
    return;
  }
  const fh = await fs.getFileHandle(notesDirHandle, `${id}.html`);
  await fs.writeText(fh, html);
}

export function generateId() {
  if ('randomUUID' in crypto) return crypto.randomUUID();
  // Fallback simple uuid v4-ish
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >>> 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function createNote() {
  const id = generateId();
  const now = Date.now();
  const initialHtml = '<p></p>';
  await writeNote(id, initialHtml);
  const notes = await listNotes();
  const entry = { id, title: '', created: now, modified: now, pinned: false, cursorPos: 0 };
  notes.unshift(entry);
  await saveIndex(notes);
  return entry;
}

export async function deleteNote(id) {
  if (storageMode === 'local') {
    localStorage.removeItem(LS_NOTE_PREFIX + id);
  } else {
    await fs.removeEntry(notesDirHandle, `${id}.html`);
  }
  const notes = await listNotes();
  const filtered = notes.filter(n => n.id !== id);
  await saveIndex(filtered);
}

export async function updateTitleAndModified(id, newTitle) {
  const notes = await listNotes();
  const idx = notes.findIndex(n => n.id === id);
  if (idx !== -1) {
    notes[idx].title = newTitle;
    notes[idx].modified = Date.now();
    await saveIndex(notes);
  }
}

export async function togglePin(id) {
  const notes = await listNotes();
  const idx = notes.findIndex(n => n.id === id);
  if (idx !== -1) {
    notes[idx].pinned = !notes[idx].pinned;
    await saveIndex(notes);
    return notes[idx].pinned;
  }
  return false;
}

export async function updateCursorPosition(id, position) {
  const notes = await listNotes();
  const idx = notes.findIndex(n => n.id === id);
  if (idx !== -1) {
    notes[idx].cursorPos = position;
    await saveIndex(notes);
  }
}

export async function duplicateNote(id) {
  const html = await readNote(id);
  const notes = await listNotes();
  const original = notes.find(n => n.id === id);
  if (!original) return null;
  
  const newId = generateId();
  const now = Date.now();
  await writeNote(newId, html);
  
  const entry = { 
    id: newId, 
    title: (original.title || 'Untitled') + ' (Copy)', 
    created: now, 
    modified: now, 
    pinned: false, 
    cursorPos: 0 
  };
  notes.unshift(entry);
  await saveIndex(notes);
  return entry;
}


// --- Per-note metadata (dirty/baseEtag/baseBody) ---
// Stored in OPFS under meta/<id>.json or localStorage under ln_meta_<id>

export async function getNoteMeta(id) {
	try {
		if (storageMode === 'local') {
			const raw = localStorage.getItem(LS_META_PREFIX + id) || '{}';
			const obj = JSON.parse(raw);
			return obj && typeof obj === 'object' ? obj : {};
		}
		// OPFS
		if (!metaDirHandle) {
			try { metaDirHandle = await fs.getDir(rootHandle, 'meta'); }
			catch { metaDirHandle = await fs.createDir(rootHandle, 'meta'); }
		}
		let fh;
		try { fh = await fs.getFileHandle(metaDirHandle, `${id}.json`); }
		catch { return {}; }
		const txt = await fs.readText(fh);
		return txt ? JSON.parse(txt) : {};
	} catch {
		return {};
	}
}

export async function setNoteMeta(id, meta) {
	try {
		const safe = meta && typeof meta === 'object' ? meta : {};
		if (storageMode === 'local') {
			localStorage.setItem(LS_META_PREFIX + id, JSON.stringify(safe));
			return;
		}
		if (!metaDirHandle) {
			try { metaDirHandle = await fs.getDir(rootHandle, 'meta'); }
			catch { metaDirHandle = await fs.createDir(rootHandle, 'meta'); }
		}
		const fh = await fs.getFileHandle(metaDirHandle, `${id}.json`);
		await fs.writeText(fh, JSON.stringify(safe));
	} catch {}
}

export async function setNoteDirty(id, dirty) {
	const meta = await getNoteMeta(id);
	meta.dirty = !!dirty;
	await setNoteMeta(id, meta);
}

export async function isNoteDirty(id) {
	const meta = await getNoteMeta(id);
	return !!meta.dirty;
}

export async function setNoteBase(id, baseEtag, baseBody) {
	const meta = await getNoteMeta(id);
	meta.baseEtag = baseEtag || '';
	if (typeof baseBody === 'string') meta.baseBody = baseBody;
	meta.dirty = false;
	await setNoteMeta(id, meta);
}

