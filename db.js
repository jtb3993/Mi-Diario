// IndexedDB layer for spanish_journal
// Primary storage is IndexedDB (no localStorage for primary data).

const DB_NAME = "spanish_journal";
const DB_VERSION = 1;

const STORE_DAYS = "days";
const STORE_PAGES = "pages";
const STORE_MISTAKES = "mistakes";
const STORE_AUDIO = "audioNotes";
const STORE_TAGS = "tags";
const STORE_META = "appMeta";

const DAY_MS = 24 * 60 * 60 * 1000;
const BIN_RETENTION_DAYS = 14;

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("Transaction error"));
  });
}

export function nowTs() {
  return Date.now();
}

export function toDayId(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // Fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function openJournalDB() {
  const req = indexedDB.open(DB_NAME, DB_VERSION);

  req.onupgradeneeded = () => {
    const db = req.result;

    // days
    if (!db.objectStoreNames.contains(STORE_DAYS)) {
      db.createObjectStore(STORE_DAYS, { keyPath: "dayId" });
    }

    // pages
    if (!db.objectStoreNames.contains(STORE_PAGES)) {
      const store = db.createObjectStore(STORE_PAGES, { keyPath: "pageId" });
      store.createIndex("dayId", "dayId", { unique: false });
      store.createIndex("createdAt", "createdAt", { unique: false });
      store.createIndex("inkedAt", "inkedAt", { unique: false });
      store.createIndex("deletedAt", "deletedAt", { unique: false });
    }

    // mistakes
    if (!db.objectStoreNames.contains(STORE_MISTAKES)) {
      const store = db.createObjectStore(STORE_MISTAKES, { keyPath: "mistakeId" });
      store.createIndex("dayId", "dayId", { unique: false });
      store.createIndex("pageId", "pageId", { unique: false });
      store.createIndex("type", "type", { unique: false });
      store.createIndex("wrong", "wrong", { unique: false });
      store.createIndex("correct", "correct", { unique: false });
      store.createIndex("createdAt", "createdAt", { unique: false });
    }

    // audioNotes
    if (!db.objectStoreNames.contains(STORE_AUDIO)) {
      const store = db.createObjectStore(STORE_AUDIO, { keyPath: "audioId" });
      store.createIndex("dayId", "dayId", { unique: false });
      store.createIndex("pageId", "pageId", { unique: false });
      store.createIndex("createdAt", "createdAt", { unique: false });
      store.createIndex("deletedAt", "deletedAt", { unique: false });
    }

    // tags
    if (!db.objectStoreNames.contains(STORE_TAGS)) {
      db.createObjectStore(STORE_TAGS, { keyPath: "tag" });
    }

    // appMeta
    if (!db.objectStoreNames.contains(STORE_META)) {
      db.createObjectStore(STORE_META, { keyPath: "key" });
    }
  };

  const db = await reqToPromise(req);
  return db;
}

export async function ensureDay(db, dayId) {
  const tx = db.transaction([STORE_DAYS], "readwrite");
  const store = tx.objectStore(STORE_DAYS);

  const existing = await reqToPromise(store.get(dayId));
  if (!existing) {
    const ts = nowTs();
    await reqToPromise(store.put({ dayId, createdAt: ts, updatedAt: ts }));
  } else {
    await reqToPromise(store.put({ ...existing, updatedAt: nowTs() }));
  }

  await txDone(tx);
}

export async function createPage(db, { dayId, titleEmoji = "", attemptText = "", correctText = "", tags = [] }) {
  const pageId = uuid();
  const ts = nowTs();

  await ensureDay(db, dayId);

  const page = {
    pageId,
    dayId,
    createdAt: ts,
    updatedAt: ts,
    titleEmoji,
    attemptText,
    correctText,
    analysis: null,
    tags,
    inked: false,
    inkedAt: null,
    deletedAt: null,
  };

  const tx = db.transaction([STORE_PAGES], "readwrite");
  await reqToPromise(tx.objectStore(STORE_PAGES).put(page));
  await txDone(tx);

  return page;
}

export async function getPage(db, pageId) {
  const tx = db.transaction([STORE_PAGES], "readonly");
  const page = await reqToPromise(tx.objectStore(STORE_PAGES).get(pageId));
  await txDone(tx);
  return page || null;
}

export async function updatePage(db, patch) {
  const tx = db.transaction([STORE_PAGES], "readwrite");
  const store = tx.objectStore(STORE_PAGES);
  const existing = await reqToPromise(store.get(patch.pageId));
  if (!existing) {
    await txDone(tx);
    throw new Error("Page not found");
  }
  const updated = { ...existing, ...patch, updatedAt: nowTs() };
  await reqToPromise(store.put(updated));
  await txDone(tx);
  return updated;
}

export async function listPagesByDay(db, dayId, { includeDeleted = false } = {}) {
  const tx = db.transaction([STORE_PAGES], "readonly");
  const store = tx.objectStore(STORE_PAGES);
  const idx = store.index("dayId");

  const pages = [];
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(dayId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const v = cur.value;
      if (includeDeleted || !v.deletedAt) pages.push(v);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });

  await txDone(tx);

  pages.sort((a, b) => b.createdAt - a.createdAt);
  return pages;
}

export async function softDeletePage(db, pageId) {
  const ts = nowTs();

  // Mark page deleted
  const tx = db.transaction([STORE_PAGES, STORE_AUDIO], "readwrite");
  const pagesStore = tx.objectStore(STORE_PAGES);
  const audioStore = tx.objectStore(STORE_AUDIO);

  const page = await reqToPromise(pagesStore.get(pageId));
  if (!page) {
    await txDone(tx);
    return null;
  }

  if (!page.deletedAt) {
    await reqToPromise(pagesStore.put({ ...page, deletedAt: ts, updatedAt: ts }));
  }

  // Mark audio notes deleted
  const audioIdx = audioStore.index("pageId");
  await new Promise((resolve, reject) => {
    const req = audioIdx.openCursor(IDBKeyRange.only(pageId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const v = cur.value;
      if (!v.deletedAt) cur.update({ ...v, deletedAt: ts });
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });

  await txDone(tx);
  return true;
}

export async function inkPage(db, pageId) {
  const page = await getPage(db, pageId);
  if (!page) throw new Error("Page not found");
  if (page.inked) return page;
  return updatePage(db, { pageId, inked: true, inkedAt: nowTs() });
}

export async function upsertMistakesForPage(db, dayId, pageId, mistakes, analysisSummary) {
  // Remove old mistakes for this page, then insert fresh ones.
  const tx = db.transaction([STORE_MISTAKES, STORE_PAGES], "readwrite");
  const mistakesStore = tx.objectStore(STORE_MISTAKES);
  const pagesStore = tx.objectStore(STORE_PAGES);

  // Delete old by cursor on pageId index
  const idx = mistakesStore.index("pageId");
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(pageId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      cur.delete();
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });

  for (const m of mistakes) {
    await reqToPromise(mistakesStore.put(m));
  }

  const page = await reqToPromise(pagesStore.get(pageId));
  if (page) {
    await reqToPromise(
      pagesStore.put({
        ...page,
        analysis: analysisSummary,
        updatedAt: nowTs(),
      })
    );
  }

  await txDone(tx);
}

export async function listMistakesByPage(db, pageId) {
  const tx = db.transaction([STORE_MISTAKES], "readonly");
  const store = tx.objectStore(STORE_MISTAKES);
  const idx = store.index("pageId");
  const out = [];

  await new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(pageId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });

  await txDone(tx);
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function addAudioNote(db, { dayId, pageId, mimeType, blob, durationSec }) {
  const audioId = uuid();
  const ts = nowTs();

  const note = {
    audioId,
    dayId,
    pageId,
    createdAt: ts,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    mimeType: mimeType || "audio/webm",
    blob,
    deletedAt: null,
  };

  const tx = db.transaction([STORE_AUDIO], "readwrite");
  await reqToPromise(tx.objectStore(STORE_AUDIO).put(note));
  await txDone(tx);
  return note;
}

export async function listAudioNotesByPage(db, pageId, { includeDeleted = false } = {}) {
  const tx = db.transaction([STORE_AUDIO], "readonly");
  const store = tx.objectStore(STORE_AUDIO);
  const idx = store.index("pageId");
  const out = [];

  await new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(pageId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const v = cur.value;
      if (includeDeleted || !v.deletedAt) out.push(v);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });

  await txDone(tx);
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function softDeleteAudio(db, audioId) {
  const tx = db.transaction([STORE_AUDIO], "readwrite");
  const store = tx.objectStore(STORE_AUDIO);
  const existing = await reqToPromise(store.get(audioId));
  if (!existing) {
    await txDone(tx);
    return null;
  }
  if (existing.deletedAt) {
    await txDone(tx);
    return true;
  }
  await reqToPromise(store.put({ ...existing, deletedAt: nowTs() }));
  await txDone(tx);
  return true;
}

export async function touchTags(db, tags) {
  const ts = nowTs();
  const clean = [...new Set((tags || []).map((t) => (t || "").trim()).filter(Boolean))];

  const tx = db.transaction([STORE_TAGS], "readwrite");
  const store = tx.objectStore(STORE_TAGS);

  for (const tag of clean) {
    const existing = await reqToPromise(store.get(tag));
    if (!existing) {
      await reqToPromise(store.put({ tag, createdAt: ts, lastUsedAt: ts, countUsed: 1 }));
    } else {
      await reqToPromise(
        store.put({
          ...existing,
          lastUsedAt: ts,
          countUsed: (existing.countUsed || 0) + 1,
        })
      );
    }
  }

  await txDone(tx);
}

export async function listTags(db) {
  const tx = db.transaction([STORE_TAGS], "readonly");
  const store = tx.objectStore(STORE_TAGS);
  const all = await reqToPromise(store.getAll());
  await txDone(tx);

  all.sort((a, b) => (b.countUsed || 0) - (a.countUsed || 0));
  return all;
}

export async function getAllNonDeletedPages(db) {
  const tx = db.transaction([STORE_PAGES], "readonly");
  const store = tx.objectStore(STORE_PAGES);
  const all = await reqToPromise(store.getAll());
  await txDone(tx);
  return all.filter((p) => !p.deletedAt);
}

export async function getAllNonDeletedMistakes(db) {
  const tx = db.transaction([STORE_MISTAKES], "readonly");
  const store = tx.objectStore(STORE_MISTAKES);
  const all = await reqToPromise(store.getAll());
  await txDone(tx);
  return all;
}

export async function getAllNonDeletedAudio(db) {
  const tx = db.transaction([STORE_AUDIO], "readonly");
  const store = tx.objectStore(STORE_AUDIO);
  const all = await reqToPromise(store.getAll());
  await txDone(tx);
  return all.filter((a) => !a.deletedAt);
}

export async function runHourlyCleanup(db) {
  const cutoff = nowTs() - BIN_RETENTION_DAYS * DAY_MS;

  const tx = db.transaction([STORE_PAGES, STORE_AUDIO, STORE_MISTAKES, STORE_META], "readwrite");
  const pagesStore = tx.objectStore(STORE_PAGES);
  const audioStore = tx.objectStore(STORE_AUDIO);
  const mistakesStore = tx.objectStore(STORE_MISTAKES);
  const metaStore = tx.objectStore(STORE_META);

  // Purge deleted pages older than cutoff
  const deletedPages = [];
  await new Promise((resolve, reject) => {
    const idx = pagesStore.index("deletedAt");
    const req = idx.openCursor(IDBKeyRange.lowerBound(1));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const v = cur.value;
      if (v.deletedAt && v.deletedAt < cutoff) {
        deletedPages.push(v.pageId);
        cur.delete();
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });

  // Purge deleted audio older than cutoff
  await new Promise((resolve, reject) => {
    const idx = audioStore.index("deletedAt");
    const req = idx.openCursor(IDBKeyRange.lowerBound(1));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const v = cur.value;
      if (v.deletedAt && v.deletedAt < cutoff) {
        cur.delete();
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });

  // Purge mistakes for deleted pages (even if mistakes store has no deletedAt)
  if (deletedPages.length) {
    const pageIdx = mistakesStore.index("pageId");
    for (const pageId of deletedPages) {
      await new Promise((resolve, reject) => {
        const req = pageIdx.openCursor(IDBKeyRange.only(pageId));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          cur.delete();
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    }
  }

  await reqToPromise(
    metaStore.put({ key: "lastCleanupAt", value: nowTs() })
  );

  await txDone(tx);
}
