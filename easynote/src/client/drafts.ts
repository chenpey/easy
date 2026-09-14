import { openDB } from 'idb';
import type { Note } from '../shared/types';

export interface Draft { note: Note; operationId: string }
const database = () => openDB('easynote', 1, {
  upgrade(db) { db.createObjectStore('drafts'); },
});
let queue: Promise<unknown> = Promise.resolve();

export function persistDraft(userId: string, id: string, draft: Draft | null): Promise<void> {
  const task = queue.catch(() => undefined).then(async () => {
    const db = await database();
    try {
      if (draft) await db.put('drafts', draft, `${userId}:${id}`);
      else await db.delete('drafts', `${userId}:${id}`);
    } finally { db.close(); }
  });
  queue = task;
  return task;
}

export async function loadDrafts(userId: string): Promise<Map<string, Draft>> {
  await queue;
  const db = await database();
  try {
    const tx = db.transaction('drafts');
    const result = new Map<string, Draft>();
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const key = String(cursor.key);
      if (key.startsWith(`${userId}:`)) result.set(key.slice(userId.length + 1), cursor.value as Draft);
      cursor = await cursor.continue();
    }
    return result;
  } finally { db.close(); }
}
