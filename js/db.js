const STORE_FOODS = 'foodLibrary';
const STORE_LOG = 'dailyLog';
const STORE_PHOTOS = 'photos';
const STORE_SESSIONS = 'sessions';
const DB_VERSION = 1;

/** Opens (and upgrades, on first run) the app's IndexedDB database.
 * dbName is overridable so tests can isolate instances; the real app always
 * calls openDb() with the default. */
export function openDb(dbName = 'food-diary') {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FOODS)) {
        const foods = db.createObjectStore(STORE_FOODS, { keyPath: 'code' });
        foods.createIndex('barcode', 'barcode', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_LOG)) {
        db.createObjectStore(STORE_LOG, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
        db.createObjectStore(STORE_PHOTOS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Same numbering rule as scan_to_diary.py::_next_library_code — one past
 * the highest existing Fnn suffix, not just a row count. */
function nextCode(existingCodes) {
  let maxN = 0;
  for (const c of existingCodes) {
    const m = /^F(\d+)$/.exec(c);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `F${String(maxN + 1).padStart(2, '0')}`;
}

/** Dedupe entry point: reuses an existing Library row's code if `barcode`
 * already matches one, otherwise creates a new row with the next Fnn code. */
export async function upsertFoodByBarcode(db, { barcode, name = '', brand = '', packSize = null, packUnit = '' }) {
  const store = tx(db, STORE_FOODS, 'readwrite');
  const all = await reqToPromise(store.getAll());
  const existing = all.find((f) => f.barcode === barcode);
  if (existing) {
    return { code: existing.code, isNew: false, nameUnconfirmed: existing.nameUnconfirmed };
  }
  const code = nextCode(all.map((f) => f.code));
  const row = {
    code, barcode, name, brand, packSize, packUnit,
    typicalPortion: null, cookingMethod: '',
    nameUnconfirmed: Boolean(name),
    createdAt: Date.now(),
  };
  await reqToPromise(store.add(row));
  return { code, isNew: true, nameUnconfirmed: row.nameUnconfirmed };
}

export async function getAllFoods(db) {
  return reqToPromise(tx(db, STORE_FOODS, 'readonly').getAll());
}

export async function addLogEntry(db, entry) {
  return reqToPromise(tx(db, STORE_LOG, 'readwrite').add(entry));
}

export async function getAllLogEntries(db) {
  return reqToPromise(tx(db, STORE_LOG, 'readonly').getAll());
}

export async function addPhoto(db, blob) {
  return reqToPromise(tx(db, STORE_PHOTOS, 'readwrite').add({ blob, createdAt: Date.now() }));
}

export async function getAllPhotos(db) {
  return reqToPromise(tx(db, STORE_PHOTOS, 'readonly').getAll());
}

export async function startSession(db, now = Date.now) {
  return reqToPromise(tx(db, STORE_SESSIONS, 'readwrite').add({ startedAt: now(), endedAt: null, entriesLogged: null }));
}

export async function endSession(db, sessionId, entriesLogged, now = Date.now) {
  const store = tx(db, STORE_SESSIONS, 'readwrite');
  const row = await reqToPromise(store.get(sessionId));
  row.endedAt = now();
  row.entriesLogged = entriesLogged;
  await reqToPromise(store.put(row));
}

export async function getAllSessions(db) {
  return reqToPromise(tx(db, STORE_SESSIONS, 'readonly').getAll());
}
