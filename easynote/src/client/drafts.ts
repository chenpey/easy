import { openDB } from 'idb';
import type { Note } from '../shared/types';

export interface Draft { note: Note; operationId: string }
const database = () => openDB('easynote', 1, {
  upgrade(db) { db.createObjectStore('drafts'); },
});

interface PendingWrite {
  draft: Draft | null;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}
const pending = new Map<string, PendingWrite>();
let draining: Promise<void> | null = null;

function createWrite(draft: Draft | null): PendingWrite {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { draft, promise, resolve, reject };
}

async function drain(): Promise<void> {
  let db: Awaited<ReturnType<typeof database>>;
  try {
    db = await database();
  } catch (error) {
    for (const write of pending.values()) write.reject(error);
    pending.clear();
    return;
  }
  try {
    while (pending.size) {
      const [key, write] = pending.entries().next().value as [string, PendingWrite];
      pending.delete(key);
      try {
        if (write.draft) await db.put('drafts', write.draft, key);
        else await db.delete('drafts', key);
        write.resolve();
      } catch (error) {
        write.reject(error);
      }
    }
  } finally {
    db.close();
  }
}

function startDrain(): void {
  if (draining) return;
  draining = drain().finally(() => {
    draining = null;
    if (pending.size) startDrain();
  });
}

export function persistDraft(userId: string, id: string, draft: Draft | null): Promise<void> {
  const key = `${userId}:${id}`;
  const existing = pending.get(key);
  if (existing) {
    existing.draft = draft;
    return existing.promise;
  }
  const write = createWrite(draft);
  pending.set(key, write);
  startDrain();
  return write.promise;
}

export async function loadDrafts(userId: string): Promise<Map<string, Draft>> {
  while (draining) await draining;
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
