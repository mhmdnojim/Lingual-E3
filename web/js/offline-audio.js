const DB_NAME = 'lingua-books-offline-audio';
const STORE = 'recordings';
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Offline audio storage is unavailable.'));
  });
}

async function transaction(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try { result = action(store); } catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(result?.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('Offline audio could not be saved.')); };
  });
}

export const offlineAudio = {
  all() { return transaction('readonly', (s) => s.getAll()); },
  get(id) { return transaction('readonly', (s) => s.get(id)); },
  put(item) { return transaction('readwrite', (s) => s.put(item)); },
  remove(id) { return transaction('readwrite', (s) => s.delete(id)); },
};
