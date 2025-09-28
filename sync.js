// Lightweight client API helper for Cloudflare Worker backend
// Responsibilities in this file:
// - Read API base URL and token from localStorage
// - Provide a typed-ish fetch wrapper with ETag handling
// - Maintain a tiny localStorage ETag cache per-path
// - Offer convenience helpers for index, notes, and todos

const LS_API_URL_KEY = 'ln_api_url';
const LS_TOKEN_KEY = 'ln_token';
const LS_ETAG_MAP_KEY = 'ln_etags_v1';
const LS_QUEUE_KEY = 'ln_sync_queue_v1';

function getApiBase() {
  return (localStorage.getItem(LS_API_URL_KEY) || '').replace(/\/$/, '');
}

function getAuthHeader() {
  const token = localStorage.getItem(LS_TOKEN_KEY) || '';
  return token ? `Bearer ${token}` : '';
}

function loadEtagMap() {
  try {
    const raw = localStorage.getItem(LS_ETAG_MAP_KEY) || '{}';
    const map = JSON.parse(raw);
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

function saveEtagMap(map) {
  try {
    localStorage.setItem(LS_ETAG_MAP_KEY, JSON.stringify(map || {}));
  } catch {}
}

function getCachedEtag(path) {
  const map = loadEtagMap();
  return map[path] || '';
}

function setCachedEtag(path, etag) {
  if (!etag) return;
  const map = loadEtagMap();
  map[path] = etag;
  saveEtagMap(map);
}

function removeCachedEtag(path) {
  const map = loadEtagMap();
  if (path in map) {
    delete map[path];
    saveEtagMap(map);
  }
}

function ensureConfigured() {
  const base = getApiBase();
  const auth = getAuthHeader();
  if (!base || !auth) {
    const reason = !base ? 'API URL not set' : 'API token not set';
    const err = new Error(`Remote API not configured: ${reason}`);
    err.code = 'not_configured';
    throw err;
  }
}

async function api(method, path, body, opts = {}) {
  ensureConfigured();
  const base = getApiBase();
  const auth = getAuthHeader();
  const headers = { Authorization: auth };

  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
  if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
  if (opts.ifNoneMatchStar) headers['If-None-Match'] = '*';

  let payload = body;
  if (body && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${base}/${path}`, { 
    method, 
    headers, 
    body: payload,
    cache: (method === 'GET' || method === 'HEAD') ? 'no-store' : undefined
  });

  const normalizeEtag = (tag) => (tag || '').replace(/^W\//, '').replace(/"/g, '');
  const etagRaw = res.headers.get('ETag') || '';
  const etag = normalizeEtag(etagRaw);
  // 304 Not Modified – propagate unchanged flag
  if (res.status === 304) {
    return { status: 304, unchanged: true, etag, data: null };
  }
  // 412 Precondition Failed – conflict
  if (res.status === 412) {
    const err = new Error('conflict');
    err.code = 'conflict';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(res.statusText || 'Request failed');
    err.code = `http_${res.status}`;
    throw err;
  }

  const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, etag, data };
}

// Convenience wrappers with ETag caching
async function getWithCache(path) {
  const cached = getCachedEtag(path);
  const res = await api('GET', path, null, { ifNoneMatch: cached || undefined });
  if (!res.unchanged && res.etag) setCachedEtag(path, res.etag);
  return res;
}

async function putWithMatch(path, body) {
  // Plan A: fresh HEAD to confirm current ETag
  try {
    const head = await api('HEAD', path);
    const current = head.etag || getCachedEtag(path) || undefined;
    try {
      const res = await api('PUT', path, body, { ifMatch: current });
      if (res.etag) setCachedEtag(path, res.etag);
      return res;
    } catch (e) {
      if (e && e.code === 'conflict') {
        // Fast-forward: prefer local, unconditional PUT
        const res2 = await api('PUT', path, body);
        if (res2.etag) setCachedEtag(path, res2.etag);
        return res2;
      }
      throw e;
    }
  } catch (e) {
    // If HEAD 404: create new with If-None-Match: * to avoid races
    const res = await api('PUT', path, body, { ifNoneMatchStar: true });
    if (res.etag) setCachedEtag(path, res.etag);
    return res;
  }
}

async function del(path) {
  const res = await api('DELETE', path);
  removeCachedEtag(path);
  return res;
}

// High-level resources
export async function getIndex() {
  return await getWithCache('index.json');
}

export async function putIndex(indexArray) {
  return await putWithMatch('index.json', indexArray || []);
}

export async function getNoteHtml(noteId) {
  return await getWithCache(`notes/${noteId}.html`);
}

export async function putNoteHtml(noteId, htmlString) {
  return await putWithMatch(`notes/${noteId}.html`, htmlString);
}

export async function deleteNoteRemote(noteId) {
  return await del(`notes/${noteId}.html`);
}

export async function getTodosRemote() {
  return await getWithCache('todos.json');
}

export async function putTodosRemote(todosArray) {
  return await putWithMatch('todos.json', todosArray || []);
}

export async function listKeys(prefix = '') {
  const res = await api('GET', `list?prefix=${encodeURIComponent(prefix)}`);
  if (res && res.data) {
    return typeof res.data === 'string' ? JSON.parse(res.data).keys || [] : (res.data.keys || []);
  }
  return [];
}

// Expose a small surface for manual testing in DevTools
window.__sync = {
  apiBase: getApiBase,
  setApiBase(url) { localStorage.setItem(LS_API_URL_KEY, String(url || '')); },
  setToken(token) { localStorage.setItem(LS_TOKEN_KEY, String(token || '')); },
  getIndex,
  putIndex,
  getNoteHtml,
  putNoteHtml,
  deleteNoteRemote,
  getTodosRemote,
  putTodosRemote,
};

export { api, getWithCache as getPathWithCache, putWithMatch as putPathWithMatch };

// --- Offline queue ---
function loadQueue() {
  try {
    const raw = localStorage.getItem(LS_QUEUE_KEY) || '[]';
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveQueue(arr) {
  try { localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(arr || [])); } catch {}
}

export function enqueueOperation(op) {
  const q = loadQueue();
  const withTs = { ...op };
  if (!withTs.ts) withTs.ts = Date.now();
  q.push(withTs);
  saveQueue(q);
  // Ask SW to schedule a background sync if available
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'request-sync' });
    }
  } catch {}
}

export async function flushQueue() {
  // Do nothing if not configured
  try { ensureConfigured(); } catch { return; }
  let q = loadQueue();
  if (!q.length) return;
  const next = [];
  for (const item of q) {
    try {
      if (item.type === 'put_note') {
        await putWithMatch(`notes/${item.noteId}.html`, item.html);
      } else if (item.type === 'put_index') {
        await putWithMatch('index.json', item.index || []);
      } else if (item.type === 'delete_note') {
        await del(`notes/${item.noteId}.html`);
        // also push index if provided
        if (item.index) await putWithMatch('index.json', item.index || []);
      } else if (item.type === 'put_todos') {
        await putWithMatch('todos.json', item.todos || []);
      } else {
        // unknown op, drop
      }
      // success: continue (drop item)
    } catch (e) {
      if (e && e.code === 'conflict') {
        // For queued conflicts, drop; user will resolve on next manual save
        continue;
      }
      // Keep item for next flush (likely still offline)
      next.push(item);
    }
  }
  saveQueue(next);
}

export function setupQueueRetry() {
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { flushQueue().catch(() => {}); });
    setInterval(() => { flushQueue().catch(() => {}); }, 15000);
  }
}


