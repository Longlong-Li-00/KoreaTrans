import type { MeetingDraft } from "../types";

const DATABASE_NAME = "korea-live-translate";
const DATABASE_VERSION = 2;
const STORE_NAME = "drafts";
const CURRENT_DRAFT_KEY = "current";

function draftKey(id: string) {
  return `meeting:${id}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
      if (event.oldVersion < 2) {
        const store = request.transaction?.objectStore(STORE_NAME);
        if (store) {
          const legacyRequest = store.get(CURRENT_DRAFT_KEY);
          legacyRequest.onsuccess = () => {
            const legacyDraft = legacyRequest.result as MeetingDraft | undefined;
            if (legacyDraft?.schemaVersion === 1 && legacyDraft.id) {
              store.put(legacyDraft, draftKey(legacyDraft.id));
              store.delete(CURRENT_DRAFT_KEY);
            }
          };
        }
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
      (item) => item.kind === "gap" || item.kind === "pause" || (item.kind === "caption" && item.status === "final"),
    ),
  };
  await withStore("readwrite", (store) => store.put(safeDraft, draftKey(draft.id)));
}

export async function listMeetingDrafts(): Promise<MeetingDraft[]> {
  const drafts = await withStore<MeetingDraft[]>("readonly", (store) => store.getAll());
  const unique = new Map<string, MeetingDraft>();
  for (const draft of drafts) {
    if (!draft || draft.schemaVersion !== 1 || !draft.id) continue;
    const existing = unique.get(draft.id);
    if (!existing || Date.parse(draft.updatedAt) > Date.parse(existing.updatedAt)) unique.set(draft.id, draft);
  }
  return [...unique.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function loadMeetingDraft(id?: string): Promise<MeetingDraft | null> {
  const drafts = await listMeetingDrafts();
  return (id ? drafts.find((draft) => draft.id === id) : drafts[0]) ?? null;
}

export async function clearMeetingDraft(id?: string) {
  if (!id) {
    await withStore("readwrite", (store) => store.clear());
    return;
  }
  await withStore("readwrite", (store) => store.delete(draftKey(id)));
}
