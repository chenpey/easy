import { openDB } from 'idb';
import type { Note, Session, SyncChange } from '../shared/types';

export interface Draft { note: Note; operationId: string }
export interface CachedFile { blob: Blob; mime: string; filename: string }

const database = () => openDB('easynote', 1, {
  upgrade(db) {
    db.createObjectStore('drafts');
    db.createObjectStore('notes');
    db.createObjectStore('files');
    db.createObjectStore('meta');
  },
});

interface PendingWrite {
  draft: Draft | null;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}
const pending = new Map<string, PendingWrite>();
let draining: Promise<void> | null = null;

const accountKey = (userId: string, id: string) => `${userId}:${id}`;
const offlineKey = (userId: string) => `offline:${userId}`;
const cursorKey = (userId: string) => `cursor:${userId}`;
const sessionKey = (userId: string) => `session:${userId}`;

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

async function entriesForUser<T>(storeName: 'drafts' | 'notes' | 'files', userId: string): Promise<Map<string, T>> {
  const db = await database();
  try {
    const tx = db.transaction(storeName);
    const result = new Map<string, T>();
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const key = String(cursor.key);
      if (key.startsWith(`${userId}:`)) result.set(key.slice(userId.length + 1), cursor.value as T);
      cursor = await cursor.continue();
    }
    return result;
  } finally {
    db.close();
  }
}

export function persistDraft(userId: string, id: string, draft: Draft | null): Promise<void> {
  const key = accountKey(userId, id);
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
  return entriesForUser<Draft>('drafts', userId);
}

export async function offlineEnabled(userId: string): Promise<boolean> {
  const db = await database();
  try { return await db.get('meta', offlineKey(userId)) === true; }
  finally { db.close(); }
}

export async function setOfflineEnabled(userId: string, enabled: boolean, session?: Session): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction('meta', 'readwrite');
    await tx.store.put(enabled, offlineKey(userId));
    if (enabled && session?.user) {
      await tx.store.put({ ...session, csrf: null, offline: true }, sessionKey(userId));
      await tx.store.put(userId, 'last-user');
    }
    await tx.done;
  } finally { db.close(); }
  if (!enabled) await clearOfflineMirror(userId);
}

export async function cacheSession(session: Session): Promise<void> {
  if (!session.user || !await offlineEnabled(session.user.id)) return;
  const db = await database();
  try {
    const tx = db.transaction('meta', 'readwrite');
    await tx.store.put({ ...session, csrf: null, offline: true }, sessionKey(session.user.id));
    await tx.store.put(session.user.id, 'last-user');
    await tx.done;
  } finally { db.close(); }
}

export async function loadOfflineSession(): Promise<Session | null> {
  const db = await database();
  try {
    const userId = await db.get('meta', 'last-user');
    if (typeof userId !== 'string' || await db.get('meta', offlineKey(userId)) !== true) return null;
    const session = await db.get('meta', sessionKey(userId)) as Session | null ?? null;
    if (!session?.expiresAt || session.expiresAt <= Date.now()) {
      await db.delete('meta', sessionKey(userId));
      await db.delete('meta', 'last-user');
      return null;
    }
    return session;
  } finally { db.close(); }
}

export async function forgetCachedSession(userId: string): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction('meta', 'readwrite');
    await tx.store.delete(sessionKey(userId));
    if (await tx.store.get('last-user') === userId) await tx.store.delete('last-user');
    await tx.done;
  } finally { db.close(); }
}

export async function loadMirroredNotes(userId: string): Promise<Map<string, Note>> {
  return entriesForUser<Note>('notes', userId);
}

export async function loadMirroredNote(userId: string, id: string): Promise<Note | null> {
  const db = await database();
  try { return await db.get('notes', accountKey(userId, id)) as Note | null ?? null; }
  finally { db.close(); }
}

export async function cacheMirroredNote(userId: string, note: Note): Promise<void> {
  const db = await database();
  try { await db.put('notes', note, accountKey(userId, note.id)); }
  finally { db.close(); }
}

export async function syncCursor(userId: string): Promise<number> {
  const db = await database();
  try {
    const cursor = await db.get('meta', cursorKey(userId));
    return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  } finally { db.close(); }
}

export async function applyMirrorChanges(userId: string, changes: SyncChange[], cursor: number): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction(['notes', 'meta'], 'readwrite');
    for (const change of changes) {
      const key = accountKey(userId, change.noteId);
      if (change.note) await tx.objectStore('notes').put(change.note, key);
      else await tx.objectStore('notes').delete(key);
    }
    await tx.objectStore('meta').put(cursor, cursorKey(userId));
    await tx.done;
  } finally { db.close(); }
}

export async function cacheFile(userId: string, id: string, file: CachedFile): Promise<void> {
  const db = await database();
  try { await db.put('files', file, accountKey(userId, id)); }
  finally { db.close(); }
}

export async function loadCachedFile(userId: string, id: string): Promise<CachedFile | null> {
  const db = await database();
  try { return await db.get('files', accountKey(userId, id)) as CachedFile | null ?? null; }
  finally { db.close(); }
}

export async function pruneCachedFiles(userId: string, keep: Set<string>): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction('files', 'readwrite');
    let cursor = await tx.store.openCursor();
    while (cursor) {
      const key = String(cursor.key);
      if (key.startsWith(`${userId}:`) && !keep.has(key.slice(userId.length + 1))) await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  } finally { db.close(); }
}

async function deletePrefixed(store: { openCursor(): Promise<any> }, prefix: string): Promise<void> {
  let cursor = await store.openCursor();
  while (cursor) {
    if (String(cursor.key).startsWith(prefix)) await cursor.delete();
    cursor = await cursor.continue();
  }
}

export async function clearOfflineMirror(userId: string): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction(['notes', 'files', 'meta'], 'readwrite');
    await deletePrefixed(tx.objectStore('notes'), `${userId}:`);
    await deletePrefixed(tx.objectStore('files'), `${userId}:`);
    await tx.objectStore('meta').delete(cursorKey(userId));
    await tx.objectStore('meta').delete(sessionKey(userId));
    if (await tx.objectStore('meta').get('last-user') === userId) await tx.objectStore('meta').delete('last-user');
    await tx.done;
  } finally { db.close(); }
}

export async function clearAccountStorage(userId: string): Promise<void> {
  while (draining) await draining;
  const db = await database();
  try {
    const tx = db.transaction(['drafts', 'notes', 'files', 'meta'], 'readwrite');
    await deletePrefixed(tx.objectStore('drafts'), `${userId}:`);
    await deletePrefixed(tx.objectStore('notes'), `${userId}:`);
    await deletePrefixed(tx.objectStore('files'), `${userId}:`);
    await tx.objectStore('meta').delete(offlineKey(userId));
    await tx.objectStore('meta').delete(cursorKey(userId));
    await tx.objectStore('meta').delete(sessionKey(userId));
    if (await tx.objectStore('meta').get('last-user') === userId) await tx.objectStore('meta').delete('last-user');
    await tx.done;
  } finally { db.close(); }
}
