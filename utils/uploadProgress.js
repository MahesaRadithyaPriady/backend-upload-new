const g = typeof globalThis !== 'undefined' ? globalThis : global;
if (!g.__uploadProgressStore) {
  g.__uploadProgressStore = new Map();
}
const store = g.__uploadProgressStore;

export function setProgress(id, data) {
  if (!id) return;
  const prev = store.get(id) || {};
  store.set(id, { ...prev, ...data, updatedAt: Date.now() });
}

export function getProgress(id) {
  if (!id) return null;
  return store.get(id) || null;
}

export function clearProgress(id) {
  if (!id) return;
  store.delete(id);
}

export function getOrInit(id, init) {
  if (!id) return null;
  if (!store.has(id)) store.set(id, { ...(init || {}), updatedAt: Date.now() });
  return store.get(id);
}
