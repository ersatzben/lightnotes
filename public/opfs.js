// Low-level OPFS helpers
// All functions throw on failure; callers should handle and surface errors.

export async function getRoot() {
  if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
    throw new Error('OPFS not supported in this browser. Use Safari 17+ or Chromium 102+.');
  }
  return await navigator.storage.getDirectory();
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
  await w.write(new Blob([text], { type: 'text/html' }));
  await w.close();
}

export async function removeEntry(dirHandle, name) {
  // { recursive: false } because we only remove files in this app
  await dirHandle.removeEntry(name, { recursive: false });
}


