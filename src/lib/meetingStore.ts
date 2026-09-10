import type { MeetingDraft } from "../types";

const DATABASE_NAME = "korea-live-translate";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";
const CURRENT_DRAFT_KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地草稿数据库"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地草稿操作失败"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地草稿事务失败"));
  });
}

export async function saveMeetingDraft(draft: MeetingDraft) {
  const safeDraft: MeetingDraft = {
    ...draft,
    items: draft.items.filter(
      (item) => item.kind === "gap" || (item.kind === "caption" && item.status === "final"),
    ),
  };
  await withStore("readwrite", (store) => store.put(safeDraft, CURRENT_DRAFT_KEY));
}

export async function loadMeetingDraft(): Promise<MeetingDraft | null> {
  const draft = await withStore<MeetingDraft | undefined>("readonly", (store) =>
    store.get(CURRENT_DRAFT_KEY),
  );
  if (!draft || draft.schemaVersion !== 1) return null;
  return draft;
}

export async function clearMeetingDraft() {
  await withStore("readwrite", (store) => store.delete(CURRENT_DRAFT_KEY));
}

