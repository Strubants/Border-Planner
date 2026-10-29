// Persistence in IndexedDB (handles photos, unlike localStorage).
// Data model (JSON, kept platform-neutral so a native app can reuse it):
// { version, borders: [{ id, name, photo, points:[{x,y}], zones:[{ id, name, points, plants:[
//   { id, name, planted:'YYYY-MM-DD', color:'#rrggbb', bloomFrom:1-12|0, bloomTo:1-12|0, notes }] }] }] }

const DB_NAME = 'borderplanner';
const STORE = 'kv';
const KEY = 'data';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const emptyData = () => ({ version: 1, borders: [] });

export async function loadData() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result || emptyData());
    req.onerror = () => reject(req.error);
  });
}

export async function saveData(data) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
