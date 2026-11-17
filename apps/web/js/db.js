/**
 * 本地 IndexedDB 存储层（§12 隐私承诺：所有录音、转写稿、答题记录、答辩材料、薄弱点仅存浏览器本地）
 */
const DB_NAME = 'zhimian_coach_db';
const DB_VERSION = 2;

const STORES = [
  'recordings',   // 录音 Blob 与关联字幕时间戳
  'sessions',     // 陪练与复盘历史记录
  'documents',    // 上传解析后的文档分段 (segments[])
  'weaknesses',   // 薄弱点弹药库与复习优先级队列
  'opportunities', // 台账：面试/答辩机会状态机
  'resumeAnalyses' // 简历解析结果（含题目与练习状态），跨会话持久
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
    // 升级被旧标签页阻塞时，open 会一直 pending → 整个应用卡死。这里设 3s 上限并明确报错。
    const guard = setTimeout(() => {
      console.warn('[db] 打开超时：可能有旧标签页占用旧版本连接');
    }, 3000);
    req.onsuccess = () => {
      clearTimeout(guard);
      const db = req.result;
      // 关键：允许后续版本升级。否则旧标签页握着 v1 连接时，本页开 v2 会被永久阻塞
      //（表现：页面卡在骨架屏、状态药丸一直"检测服务中…"）
      db.onversionchange = () => {
        db.close();
        console.warn('[db] 已关闭旧连接，允许数据库升级');
      };
      resolve(db);
    };
    req.onerror = () => {
      clearTimeout(guard);
      reject(req.error);
    };
    req.onblocked = () => {
      clearTimeout(guard);
      reject(new Error('本地库升级被旧标签页阻塞，请关闭旧标签页后重试（或点顶部「重置」清库）'));
    };
  });
  return dbPromise;
}

export async function dbPut(storeName, item) {
  const db = await openDB();
  if (!db.objectStoreNames.contains(storeName)) {
    console.warn('[db] store 不存在：' + storeName);
    return null;
  }
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
  if (!db.objectStoreNames.contains(storeName)) {
    console.warn('[db] store 不存在：' + storeName);
    return [];
  }
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
/** 清空本地库（换版本/排查时用）：删库后下次打开会按当前版本重建 */
export async function resetLocalData() {
  try {
    const db = await openDB();
    db.close();
  } catch {
    /* 忽略 */
  }
  dbPromise = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

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
