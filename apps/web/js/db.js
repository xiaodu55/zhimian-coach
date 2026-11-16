/**
 * 本地 IndexedDB 存储层（§12 隐私承诺：所有录音、转写稿、答题记录、答辩材料、薄弱点仅存浏览器本地）
 */
const DB_NAME = 'zhimian_coach_db';
const DB_VERSION = 1;

const STORES = [
  'recordings',   // 录音 Blob 与关联字幕时间戳
  'sessions',     // 陪练与复盘历史记录
  'documents',    // 上传解析后的文档分段 (segments[])
  'weaknesses',   // 薄弱点弹药库与复习优先级队列
  'opportunities' // 台账：面试/答辩机会状态机
];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function dbPut(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put({
      ...item,
      updatedAt: item.updatedAt || new Date().toISOString()
    });
    tx.oncomplete = () => resolve(item);
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDelete(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 一键导出本地全量 JSON 备份（自证数据完全在用户手上）
 */
export async function exportAllData() {
  const dump = {
    app: 'zhimian-coach',
    exportedAt: new Date().toISOString(),
    stores: {}
  };
  for (const name of ['sessions', 'documents', 'weaknesses', 'opportunities']) {
    dump.stores[name] = await dbGetAll(name);
  }
  return dump;
}

/**
 * 导入 JSON 备份恢复状态
 */
export async function importAllData(dump) {
  if (!dump || !dump.stores) throw new Error('无效的备份文件格式');
  for (const [storeName, items] of Object.entries(dump.stores)) {
    if (STORES.includes(storeName) && Array.isArray(items)) {
      for (const item of items) {
        if (item && item.id) {
          await dbPut(storeName, item);
        }
      }
    }
  }
}
