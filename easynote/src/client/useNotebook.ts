import { useCallback, useEffect, useRef, useState } from 'react';
import {
  filePath,
  noteFingerprint,
  noteInput,
  noteLinkIds,
  sameNoteInput,
  storedFileIds,
  type Note,
  type NoteInput,
  type NoteSummary,
  type Session,
  type SyncChange,
} from '../shared/types';
import { unfinishedTasks } from '../shared/tasks';
import { api, ApiError, noteEventsUrl } from './api';
import { mergeNoteChanges, type ConflictPreference, type NoteConflictField } from './merge';
import { preparePdfExport } from './pdf';
import {
  applyMirrorChanges,
  cacheFile,
  cacheMirroredNote,
  cacheSession,
  loadCachedFile,
  loadDrafts,
  loadMirroredNote,
  loadMirroredNotes,
  offlineEnabled,
  persistDraft,
  pruneCachedFiles,
  setOfflineEnabled,
  syncCursor,
  type Draft,
} from './drafts';

const blankNote = (note: Pick<Note, 'title' | 'content' | 'tags' | 'archived' | 'deletedAt'>) =>
  !note.title && !note.content && !note.tags.length && !note.archived && note.deletedAt === null;
const blankSummary = (note: NoteSummary) =>
  !note.title && !note.excerpt && !note.tags.length && !note.archived && note.deletedAt === null;
const noteExcerpt = (content: string, query: string) => {
  const needle = query.trim();
  if (!needle) return content.slice(0, 180);
  const match = content.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  const start = match > 60 ? match - 60 : 0;
  const length = Math.max(180, needle.length + 60);
  return `${start ? '…' : ''}${content.slice(start, start + length)}`;
};

async function prepareOfflineResources(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  let timeout = 0;
  try {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error('离线资源准备超时，请稍后重试。')), 20_000);
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
  }
  await preparePdfExport();
}

export function useNotebook(session: Session) {
  const userId = session.user!.id;
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const current = useRef<Note | null>(null);
  const drafts = useRef(new Map<string, Draft>());
  const running = useRef(new Set<string>());
  const blocked = useRef(new Set<string>());
  const pendingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const alive = useRef(true);
  const ready = useRef(false);
  const pollInFlight = useRef(false);
  const pollQueued = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);
  const selectionAbort = useRef<AbortController | null>(null);
  const pollError = useRef('');
  const [tick, bump] = useState(0);
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<{
    base?: Note;
    local: Note;
    remote?: Note;
    fields: NoteConflictField[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(navigator.onLine && !session.offline);
  const [offlineLibrary, setOfflineLibrary] = useState(false);
  const [offlineCount, setOfflineCount] = useState(0);
  const mirror = useRef(new Map<string, Note>());
  const notesRef = useRef<NoteSummary[]>([]);
  const onlineCursor = useRef<number | null>(null);
  const offlineLibraryRef = useRef(false);
  const listGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const createInFlight = useRef<Promise<Note> | null>(null);
  const persist = (id: string, draft: Draft | null) => persistDraft(userId, id, draft).catch((e: unknown) => {
    if (alive.current) setError(`本地草稿写入失败，请勿关闭页面。\n${String(e)}`);
    throw e;
  });
  const discardDraft = async (id: string) => {
    const timer = pendingTimers.current.get(id);
    if (timer) clearTimeout(timer);
    pendingTimers.current.delete(id);
    drafts.current.delete(id);
    blocked.current.delete(id);
    await persist(id, null);
  };
  const show = useCallback((value: Note | null) => { current.current = value; setNote(value); }, []);
  const notify = () => { if (alive.current) bump((v) => v + 1); };
  notesRef.current = notes;

  const renderMirror = useCallback(() => {
    const scoped = [...mirror.current.values()].filter((item) => {
      if (view === 'trash') {
        if (item.deletedAt === null) return false;
      } else if (item.deletedAt !== null || item.archived !== (view === 'archive')) return false;
      if (tag && !item.tags.includes(tag)) return false;
      return !query || `${item.title} ${item.content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
    });
    scoped.sort((left, right) => Number(right.pinned) - Number(left.pinned) ||
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    setNotes(scoped.map(({ content, ...item }) => ({ ...item, excerpt: noteExcerpt(content, query) })));
    const viewTags = new Set<string>();
    for (const item of mirror.current.values()) {
      const inView = view === 'trash' ? item.deletedAt !== null :
        item.deletedAt === null && item.archived === (view === 'archive');
      if (inView) item.tags.forEach((value) => viewTags.add(value));
    }
    setTags([...viewTags].sort((left, right) => left.localeCompare(right, 'zh-CN')));
    setNextOffset(null);
    setOfflineCount(mirror.current.size);
  }, [query, tag, view]);

  const cacheReferencedFiles = useCallback(async (changed: Note[]) => {
    const ids = new Set(changed.flatMap((item) => storedFileIds(item.content)));
    for (const id of ids) {
      if (await loadCachedFile(userId, id)) continue;
      const response = await fetch(filePath(id), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`GET ${filePath(id)} [${response.status}]\n${await response.text()}`);
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      let filename = id;
      try { if (encodedName) filename = decodeURIComponent(encodedName); } catch { /* Keep the stable ID as fallback. */ }
      await cacheFile(userId, id, {
        blob: await response.blob(),
        mime: response.headers.get('Content-Type') ?? 'application/octet-stream',
        filename,
      });
    }
  }, [userId]);

  const syncOfflineMirror = useCallback(async (signal?: AbortSignal) => {
    let cursor = await syncCursor(userId);
    const changed: Note[] = [];
    let hasMore = true;
    while (hasMore) {
      const page = await api.sync(cursor, signal);
      await applyMirrorChanges(userId, page.changes, page.cursor);
      for (const change of page.changes) {
        if (change.note) {
          mirror.current.set(change.noteId, change.note);
          changed.push(change.note);
          if (current.current?.id === change.noteId && !drafts.current.has(change.noteId) &&
              change.note.revision > current.current.revision) show(change.note);
        } else {
          mirror.current.delete(change.noteId);
          if (current.current?.id === change.noteId && !drafts.current.has(change.noteId)) show(null);
        }
      }
      cursor = page.cursor;
      hasMore = page.hasMore;
    }
    await cacheReferencedFiles(changed.length ? changed : [...mirror.current.values()]);
    const referenced = new Set([
      ...[...mirror.current.values()].flatMap((item) => storedFileIds(item.content)),
      ...[...drafts.current.values()].flatMap((draft) => storedFileIds(draft.note.content)),
    ]);
    await pruneCachedFiles(userId, referenced);
    if (alive.current) {
      setOnline(true);
      setOfflineCount(mirror.current.size);
    }
  }, [cacheReferencedFiles, show, userId]);

  const syncOnlineChanges = useCallback(async (signal?: AbortSignal) => {
    if (onlineCursor.current === null) {
      onlineCursor.current = (await api.syncHead(signal)).cursor;
      return;
    }
    const generation = listGeneration.current;
    let cursor = onlineCursor.current;
    let hasMore = true;
    const changes: SyncChange[] = [];
    while (hasMore) {
      const page = await api.sync(cursor, signal);
      changes.push(...page.changes);
      cursor = page.cursor;
      hasMore = page.hasMore;
    }
    if (!changes.length) {
      onlineCursor.current = cursor;
      return;
    }
    const data = await api.tags(view, signal);
    if (!alive.current) return;
    onlineCursor.current = cursor;

    for (const change of changes) {
      if (current.current?.id !== change.noteId || drafts.current.has(change.noteId)) continue;
      if (!change.note) show(null);
      else if (change.note.revision > current.current.revision) show(change.note);
    }
    if (generation !== listGeneration.current) return;

    const updated = new Map(notesRef.current.map((item) => [item.id, item]));
    for (const change of changes) {
      const item = change.note;
      const inView = item && (view === 'trash'
        ? item.deletedAt !== null
        : item.deletedAt === null && item.archived === (view === 'archive'));
      const matches = inView && (!tag || item.tags.includes(tag)) &&
        (!query || `${item.title} ${item.content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      if (!item || !matches) updated.delete(change.noteId);
      else {
        const { content, ...summary } = item;
        updated.set(item.id, { ...summary, excerpt: noteExcerpt(content, query) });
      }
    }
    const values = [...updated.values()].sort((left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.updatedAt - left.updatedAt ||
      left.id.localeCompare(right.id));
    notesRef.current = values;
    setNotes(values);
    setNextOffset((value) => value === null ? null : values.length);
    setTags(data.tags);
  }, [query, show, tag, view]);
  const syncOnlineRef = useRef(syncOnlineChanges);
  syncOnlineRef.current = syncOnlineChanges;

  const refresh = useCallback(async (append = false, signal?: AbortSignal) => {
    const generation = ++listGeneration.current;
    if (offlineLibraryRef.current) {
      if (navigator.onLine && !session.offline) await syncOfflineMirror(signal);
      if (alive.current && generation === listGeneration.current) renderMirror();
      return;
    }
    const result = await api.list({ q: query, view, tag, offset: append ? nextOffset ?? 0 : 0 }, signal);
    if (!alive.current || generation !== listGeneration.current) return;
    const existingBlank = result.notes.find(blankSummary);
    if (existingBlank) {
      const redundant = [...drafts.current.values()]
        .map((draft) => draft.note)
        .filter((item) => item.revision === 0 && item.id !== existingBlank.id && blankNote(item));
      if (redundant.length) {
        const replacement = redundant.some((item) => item.id === current.current?.id)
          ? mirror.current.get(existingBlank.id) ?? (await api.note(existingBlank.id, signal)).note
          : null;
        await Promise.all(redundant.map((item) => discardDraft(item.id)));
        if (!alive.current || generation !== listGeneration.current) return;
        if (replacement) show(replacement);
      }
    }
    setNotes((prev) => append ? [...prev, ...result.notes.filter((n) => !prev.some((old) => old.id === n.id))] : result.notes);
    setNextOffset(result.nextOffset);
    const data = await api.tags(view, signal);
    if (alive.current && generation === listGeneration.current) setTags(data.tags);
  }, [nextOffset, query, renderMirror, session.offline, syncOfflineMirror, tag, view]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const saveRef = useRef<(id: string, refreshAfter?: boolean, createVersion?: boolean) => Promise<boolean>>(async () => false);
  const schedule = (id: string) => {
    const previous = pendingTimers.current.get(id);
    if (previous) clearTimeout(previous);
    pendingTimers.current.set(id, setTimeout(() => {
      pendingTimers.current.delete(id);
      if (!blocked.current.has(id)) void saveRef.current(id);
    }, session.config.autosaveMs));
  };

  const save = async (id: string, refreshAfter = true, createVersion = false): Promise<boolean> => {
    if (running.current.has(id)) return false;
    let target = drafts.current.get(id)?.note ?? (current.current?.id === id ? current.current : null);
    if (!target) return !createVersion;
    if (!navigator.onLine || session.offline) { notify(); return false; }
    const pendingTimer = pendingTimers.current.get(id);
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimers.current.delete(id);
    running.current.add(id);
    notify();
    let ok = false;
    let contentSaved = false;
    let conflictHandled = false;
    let automaticMerges = 0;
    try {
      while (true) {
        const draft = drafts.current.get(id);
        target = draft?.note ?? (current.current?.id === id ? current.current : target);
        try {
          if (draft) await persist(id, draft);
          const operationId = draft?.operationId ?? crypto.randomUUID();
          const { note: saved } = await api.save(
            id,
            noteInput(target),
            target.revision,
            operationId,
            createVersion && !draft,
          );
          if (!alive.current) return true;
          if (offlineLibraryRef.current) mirror.current.set(saved.id, saved);
          const latest = drafts.current.get(id);
          if (latest?.operationId === operationId) {
            drafts.current.delete(id);
            if (current.current?.id === id) show(saved);
            await persist(id, null);
          } else if (latest) {
            const updated: Draft = {
              ...latest,
              note: { ...latest.note, revision: saved.revision, createdAt: saved.createdAt },
              base: saved,
            };
            drafts.current.set(id, updated);
            if (current.current?.id === id) show(updated.note);
            await persist(id, updated);
          }
          if (offlineLibraryRef.current) {
            renderMirror();
            await cacheMirroredNote(userId, saved);
          }
          contentSaved = true;
          if (createVersion && draft) {
            await api.save(id, noteInput(saved), saved.revision, crypto.randomUUID(), true);
          }
          blocked.current.delete(id);
          ok = true;
          if (refreshAfter) await refreshRef.current();
          break;
        } catch (error) {
          const latest = drafts.current.get(id);
          const local = latest?.note ?? target;
          const remote = error instanceof ApiError ? error.body.error?.current : undefined;
          if (error instanceof ApiError && error.status === 409 && remote && latest?.base) {
            const merged = mergeNoteChanges(latest.base, local, remote);
            if (!merged.conflicts.length && automaticMerges < 2) {
              const next: Draft = { note: merged.note, base: remote, operationId: crypto.randomUUID() };
              drafts.current.set(id, next);
              if (current.current?.id === id) show(next.note);
              await persist(id, next);
              automaticMerges++;
              continue;
            }
            setConflict({ base: latest.base, local, remote, fields: merged.conflicts });
            conflictHandled = true;
          } else if (error instanceof ApiError && error.status === 409 && remote) {
            setConflict({
              base: latest?.base,
              local,
              remote,
              fields: ['title', 'content', 'tags', 'pinned', 'archived', 'deletedAt'],
            });
            conflictHandled = true;
          } else if (error instanceof ApiError && error.status === 410) {
            setConflict({ base: latest?.base, local, fields: ['deletedAt'] });
            conflictHandled = true;
          }
          throw error;
        }
      }
    } catch (e) {
      if (!alive.current) return false;
      if (!(e instanceof ApiError) && offlineLibraryRef.current) setOnline(false);
      blocked.current.add(id);
      setError(conflictHandled ? '' : String(e));
    } finally {
      running.current.delete(id);
      notify();
      if ((ok || contentSaved) && drafts.current.has(id) && alive.current) schedule(id);
    }
    return ok;
  };
  saveRef.current = save;

  const edit = (patch: Partial<NoteInput>, target = current.current) => {
    if (!target) return;
    const existingDraft = drafts.current.get(target.id);
    const latest = existingDraft?.note ?? (current.current?.id === target.id ? current.current : target);
    const updated = { ...latest, ...patch };
    if ((latest.revision > 0 || existingDraft) && sameNoteInput(noteInput(latest), noteInput(updated))) return;
    const draft: Draft = {
      note: updated,
      operationId: crypto.randomUUID(),
      base: existingDraft ? existingDraft.base : latest,
    };
    drafts.current.set(target.id, draft);
    if (current.current?.id === target.id) show(updated);
    void persist(target.id, draft).catch(() => undefined);
    notify();
    schedule(target.id);
  };

  const select = async (id: string) => {
    if (current.current?.id === id) return;
    const generation = ++selectionGeneration.current;
    selectionAbort.current?.abort();
    try {
      const local = drafts.current.get(id);
      if (local) { show(local.note); return; }
      let cached: Note | null = null;
      if (offlineLibraryRef.current) {
        cached = mirror.current.get(id) ?? await loadMirroredNote(userId, id);
        if (!alive.current || generation !== selectionGeneration.current) return;
        if (cached) {
          mirror.current.set(id, cached);
          show(cached);
        }
      }
      if (!navigator.onLine || session.offline) {
        if (!cached) throw new Error('这篇笔记尚未保存到本机。');
        return;
      }
      const controller = new AbortController();
      selectionAbort.current = controller;
      const revalidate = async () => {
        try {
          const result = await api.note(id, controller.signal);
          if (offlineLibraryRef.current) {
            mirror.current.set(id, result.note);
            void cacheMirroredNote(userId, result.note).catch((e: unknown) => {
              if (alive.current) setError(`离线笔记写入失败。\n${String(e)}`);
            });
          }
          if (!alive.current || generation !== selectionGeneration.current || drafts.current.has(id)) return;
          if (current.current?.id !== id || current.current.revision !== result.note.revision) show(result.note);
          if (offlineLibraryRef.current) setOnline(true);
        } catch (e) {
          if (controller.signal.aborted || !alive.current || generation !== selectionGeneration.current) return;
          if (cached) {
            if (!(e instanceof ApiError)) setOnline(false);
            return;
          }
          throw e;
        } finally {
          if (selectionAbort.current === controller) selectionAbort.current = null;
        }
      };
      if (cached) {
        void revalidate().catch((e: unknown) => { if (alive.current) setError(String(e)); });
        return;
      }
      await revalidate();
    } catch (e) {
      if (alive.current && generation === selectionGeneration.current) setError(String(e));
    }
  };
  const clearSelection = () => {
    selectionGeneration.current++;
    selectionAbort.current?.abort();
    selectionAbort.current = null;
    show(null);
  };

  const append = (target: Note, text: string) => {
    const latest = drafts.current.get(target.id)?.note ?? (current.current?.id === target.id ? current.current : target);
    edit({ content: `${latest.content}${latest.content ? '\n\n' : ''}${text}\n` }, latest);
  };

  const findDuplicates = async (fingerprints: string[]): Promise<Map<string, string>> => {
    const wanted = new Set(fingerprints);
    const matches = new Map<string, string>();
    const candidates = new Map<string, Pick<Note, 'id' | 'title' | 'content'>>();
    for (const item of mirror.current.values()) candidates.set(item.id, item);
    for (const item of notes) {
      if (!candidates.has(item.id) && Array.from(item.excerpt).length < 180) {
        candidates.set(item.id, { id: item.id, title: item.title, content: item.excerpt });
      }
    }
    if (current.current) candidates.set(current.current.id, current.current);
    for (const draft of drafts.current.values()) candidates.set(draft.note.id, draft.note);
    await Promise.all([...candidates.values()].map(async (candidate) => {
      const fingerprint = await noteFingerprint(candidate.title, candidate.content);
      if (wanted.has(fingerprint) && !matches.has(fingerprint)) matches.set(fingerprint, candidate.id);
    }));
    const missing = [...wanted].filter((fingerprint) => !matches.has(fingerprint));
    if (missing.length) {
      const remote = await api.duplicates(missing);
      for (const match of remote.matches) matches.set(match.fingerprint, match.noteId);
    }
    return matches;
  };

  const create = (input: Partial<NoteInput> = {}): Promise<Note> => {
    if (createInFlight.current) return createInFlight.current;
    const operation = (async () => {
      const open = (value: Note) => {
        selectionGeneration.current++;
        setView('all'); setQuery(''); setTag(''); show(value);
        return value;
      };
      if (!Object.keys(input).length) {
        const fullNotes = [
          ...mirror.current.values(),
          ...(current.current ? [current.current] : []),
          ...[...drafts.current.values()].map((draft) => draft.note),
        ];
        const saved = fullNotes.find((item) => item.revision > 0 && blankNote(item));
        if (saved) return open(saved);
        const listed = notes.find(blankSummary);
        if (listed) {
          const existing = fullNotes.find((item) => item.id === listed.id) ?? (await api.note(listed.id)).note;
          const redundant = fullNotes.filter((item) =>
            item.revision === 0 && item.id !== existing.id && blankNote(item) && drafts.current.has(item.id));
          await Promise.all(redundant.map((item) => discardDraft(item.id)));
          return open(existing);
        }
        const local = fullNotes.find((item) => item.revision === 0 && blankNote(item));
        if (local) return open(local);
        if (navigator.onLine && !session.offline) {
          const existing = await api.blank();
          if (existing.note) return open(existing.note);
        }
      }
      const newNote: Note = {
        id: crypto.randomUUID(), title: '', content: '', tags: [], pinned: false, archived: false, deletedAt: null,
        createdAt: Date.now(), updatedAt: Date.now(), revision: 0, ...input,
      };
      open(newNote);
      edit({}, newNote);
      return newNote;
    })();
    createInFlight.current = operation;
    void operation.finally(() => {
      if (createInFlight.current === operation) createInFlight.current = null;
    }).catch(() => undefined);
    return operation;
  };

  const retry = async (checkpointId?: string): Promise<boolean> => {
    setError(''); setConflict(null); pollError.current = '';
    let savedAll = true;
    let checkpointSaved = false;
    for (const id of [...drafts.current.keys()]) {
      blocked.current.delete(id);
      const createVersion = id === checkpointId;
      if (!await saveRef.current(id, false, createVersion)) { savedAll = false; break; }
      if (createVersion) checkpointSaved = true;
    }
    if (savedAll && checkpointId && !checkpointSaved) {
      blocked.current.delete(checkpointId);
      savedAll = await saveRef.current(checkpointId, false, true);
    }
    try {
      await refreshRef.current();
      return savedAll;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  const conflictCopy = async () => {
    if (!conflict) return;
    const local = drafts.current.get(conflict.local.id)?.note ?? conflict.local;
    const originalId = local.id;
    const copy: Note = {
      ...local, id: crypto.randomUUID(), title: `${local.title || '未命名笔记'} (冲突副本)`,
      revision: 0, deletedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    const draft: Draft = { note: copy, base: copy, operationId: crypto.randomUUID() };
    await persist(copy.id, draft);
    drafts.current.set(copy.id, draft);
    drafts.current.delete(originalId);
    await persist(originalId, null);
    blocked.current.delete(originalId);
    selectionGeneration.current++;
    show(copy);
    setConflict(null); setError('');
    await saveRef.current(copy.id);
  };

  const resolveConflict = async (preference: ConflictPreference) => {
    if (!conflict?.remote) return;
    const latest = drafts.current.get(conflict.local.id);
    const local = latest?.note ?? conflict.local;
    const resolved = conflict.base
      ? mergeNoteChanges(conflict.base, local, conflict.remote, preference).note
      : preference === 'local'
        ? { ...local, revision: conflict.remote.revision, createdAt: conflict.remote.createdAt }
        : conflict.remote;
    const draft: Draft = {
      note: resolved,
      base: conflict.remote,
      operationId: crypto.randomUUID(),
    };
    drafts.current.set(local.id, draft);
    blocked.current.delete(local.id);
    if (current.current?.id === local.id) show(draft.note);
    await persist(local.id, draft);
    setConflict(null);
    setError('');
    await saveRef.current(local.id);
  };

  const discardConflict = async () => {
    if (!conflict) return;
    const { local, remote } = conflict;
    await discardDraft(local.id);
    if (remote) {
      if (offlineLibraryRef.current) {
        mirror.current.set(remote.id, remote);
        await cacheMirroredNote(userId, remote);
        renderMirror();
      }
      if (current.current?.id === local.id) show(remote);
    } else if (current.current?.id === local.id) {
      show(null);
    }
    setConflict(null);
    setError('');
    await refreshRef.current();
  };

  const purge = async () => {
    if (!current.current || drafts.current.has(current.current.id)) throw new Error('请先保存当前笔记。');
    const target = current.current;
    await api.purge(target);
    if (current.current?.id === target.id) show(null);
    await refreshRef.current();
  };

  const purgeTrash = async (): Promise<number> => {
    const result = await api.purgeTrash();
    if (current.current?.deletedAt) show(null);
    await refreshRef.current();
    return result.deleted;
  };

  const allAvailableNotes = async (): Promise<Note[]> => {
    if (offlineLibraryRef.current) {
      const values = new Map(mirror.current);
      for (const draft of drafts.current.values()) values.set(draft.note.id, draft.note);
      return [...values.values()];
    }
    const summaries: NoteSummary[] = [];
    let offset: number | null = 0;
    do {
      const page = await api.list({ view: 'export', offset });
      summaries.push(...page.notes);
      offset = page.nextOffset;
    } while (offset !== null);
    return Promise.all(summaries.map(async (item) => drafts.current.get(item.id)?.note ?? (await api.note(item.id)).note));
  };

  const bulkUpdate = async (ids: string[], transform: (value: Note) => Partial<NoteInput>): Promise<number> => {
    const wanted = new Set(ids);
    const targets = (await allAvailableNotes()).filter((item) => wanted.has(item.id));
    if (targets.length !== wanted.size) throw new Error('部分笔记已不可用，请刷新列表后重试。');
    let updated = 0;
    for (const target of targets) {
      const latest = drafts.current.get(target.id)?.note ?? target;
      const next = { ...latest, ...transform(latest) };
      if (sameNoteInput(noteInput(latest), noteInput(next))) continue;
      const existing = drafts.current.get(target.id);
      const draft: Draft = {
        note: next,
        operationId: crypto.randomUUID(),
        base: existing ? existing.base : target,
      };
      drafts.current.set(target.id, draft);
      await persist(target.id, draft);
      blocked.current.delete(target.id);
      if (current.current?.id === target.id) show(next);
      if (navigator.onLine && !session.offline) {
        if (!await save(target.id, false)) {
          throw new Error(`批量操作已处理 ${updated} 篇，在“${target.title || '未命名笔记'}”处停止。`);
        }
      }
      updated++;
    }
    notify();
    if (offlineLibraryRef.current) renderMirror();
    else await refreshRef.current();
    return updated;
  };

  const manageTag = async (source: string, target: string | null): Promise<number> => {
    const affected = (await allAvailableNotes()).filter((item) => item.tags.includes(source));
    return bulkUpdate(affected.map((item) => item.id), (item) => ({
      tags: [...new Set(item.tags.flatMap((value) => value === source ? target ? [target] : [] : [value]))],
    }));
  };

  const searchAll = async (value: string): Promise<NoteSummary[]> => {
    const q = value.trim().toLocaleLowerCase();
    if (offlineLibraryRef.current) {
      return (await allAvailableNotes())
        .filter((item) => item.deletedAt === null && (!q || `${item.title} ${item.content}`.toLocaleLowerCase().includes(q)))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 30)
        .map(({ content, ...item }) => ({ ...item, excerpt: content.slice(0, 180) }));
    }
    const [active, archived] = await Promise.all([
      api.list({ q: value, view: 'all' }),
      api.list({ q: value, view: 'archive' }),
    ]);
    return [...active.notes, ...archived.notes]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 30);
  };

  const backlinks = async (id: string): Promise<NoteSummary[]> => {
    if (!offlineLibraryRef.current) return (await api.backlinks(id)).notes;
    return (await allAvailableNotes())
      .filter((item) => item.deletedAt === null && noteLinkIds(item.content).includes(id))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ content, ...item }) => ({ ...item, excerpt: content.slice(0, 180) }));
  };

  const tasks = async () => {
    if (!offlineLibraryRef.current || navigator.onLine && !session.offline) return (await api.tasks()).tasks;
    return (await allAvailableNotes()).flatMap(unfinishedTasks);
  };

  const configureOffline = async (enabled: boolean): Promise<void> => {
    if (enabled) await prepareOfflineResources();
    await setOfflineEnabled(userId, enabled, session);
    offlineLibraryRef.current = enabled;
    setOfflineLibrary(enabled);
    if (enabled) {
      onlineCursor.current = null;
      mirror.current = await loadMirroredNotes(userId);
      await cacheSession(session);
      if (navigator.onLine && !session.offline) await syncOfflineMirror();
      renderMirror();
    } else {
      mirror.current.clear();
      setOfflineCount(0);
      onlineCursor.current = navigator.onLine && !session.offline
        ? (await api.syncHead()).cursor
        : null;
      await refreshRef.current();
    }
  };

  const cachedFile = useCallback(async (id: string): Promise<string | null> => {
    const value = await loadCachedFile(userId, id);
    return value ? URL.createObjectURL(value.blob) : null;
  }, [userId]);

  useEffect(() => {
    alive.current = true;
    void Promise.all([loadDrafts(userId), offlineEnabled(userId)]).then(async ([loaded, enabled]) => {
      if (!alive.current) return;
      drafts.current = loaded;
      offlineLibraryRef.current = enabled;
      setOfflineLibrary(enabled);
      if (enabled) {
        mirror.current = await loadMirroredNotes(userId);
        setOfflineCount(mirror.current.size);
        if (!session.offline) await cacheSession(session);
      } else if (navigator.onLine && !session.offline) {
        onlineCursor.current = (await api.syncHead()).cursor;
      }
      for (const id of loaded.keys()) blocked.current.add(id);
      if (loaded.size) show(loaded.values().next().value!.note);
      try {
        if (enabled && loaded.size && navigator.onLine && !session.offline) await retry();
        else {
          await refreshRef.current();
          if (!enabled && navigator.onLine && !session.offline) await syncOnlineRef.current();
        }
      } catch (error) {
        if (!enabled || !mirror.current.size) throw error;
        setOnline(false);
        renderMirror();
      }
      ready.current = true;
      if (enabled && !session.offline) {
        void prepareOfflineResources().catch((e: unknown) => {
          if (alive.current) setError(`离线 PDF 资源准备失败。\n${String(e)}`);
        });
      }
    }).catch((e: unknown) => { if (alive.current) setError(String(e)); }).finally(() => {
      if (alive.current) { setLoading(false); notify(); }
    });
    return () => {
      alive.current = false;
      ready.current = false;
      selectionAbort.current?.abort();
      for (const timer of pendingTimers.current.values()) clearTimeout(timer);
    };
  }, [userId, show]);

  useEffect(() => {
    if (!ready.current) return;
    const timer = setTimeout(() => {
      if (offlineLibraryRef.current) {
        listGeneration.current++;
        renderMirror();
      }
      else void refreshRef.current().catch((e: unknown) => setError(String(e)));
    }, 200);
    return () => clearTimeout(timer);
  }, [loading, view, query, tag, renderMirror]);

  useEffect(() => {
    setOnline(navigator.onLine && !session.offline);
  }, [session.offline]);

  useEffect(() => {
    if (!ready.current) return;
    const poll = async () => {
      if (pollInFlight.current) {
        pollQueued.current = true;
        return;
      }
      if (!ready.current || document.hidden || !navigator.onLine || session.offline) return;
      pollInFlight.current = true;
      const controller = new AbortController();
      pollAbort.current = controller;
      const timeout = setTimeout(() => controller.abort(), session.config.pollSeconds * 1000);
      try {
        if (offlineLibraryRef.current) await refreshRef.current(false, controller.signal);
        else await syncOnlineRef.current(controller.signal);
        const previous = pollError.current;
        pollError.current = '';
        if (previous && alive.current) setError((value) => value === previous ? '' : value);
      } catch (e) {
        if (alive.current && !controller.signal.aborted) {
          if (offlineLibraryRef.current) setOnline(false);
          const message = `后台同步失败，将自动重试。\n${String(e)}`;
          pollError.current = message;
          setError(message);
        }
      } finally {
        clearTimeout(timeout);
        if (pollAbort.current === controller) pollAbort.current = null;
        pollInFlight.current = false;
        if (pollQueued.current) {
          pollQueued.current = false;
          queueMicrotask(() => void poll());
        }
      }
    };
    let socket: WebSocket | null = null;
    let reconnectTimer = 0;
    let pingTimer = 0;
    let reconnectDelay = 1000;
    let stopped = false;
    const connectEvents = () => {
      if (stopped || session.offline || !navigator.onLine ||
          socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
      socket = new WebSocket(noteEventsUrl());
      socket.addEventListener('open', () => {
        reconnectDelay = 1000;
        window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send('ping');
        }, 25_000);
      });
      socket.addEventListener('message', (event) => {
        if (event.data === 'pong') return;
        try {
          if (JSON.parse(String(event.data)).type === 'notes-changed') void poll();
        } catch { /* Ignore unknown event payloads. */ }
      });
      socket.addEventListener('close', () => {
        window.clearInterval(pingTimer);
        socket = null;
        if (stopped || session.offline || !navigator.onLine) return;
        window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(connectEvents, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      });
      socket.addEventListener('error', () => socket?.close());
    };
    const network = () => {
      setOnline(navigator.onLine && !session.offline);
      if (navigator.onLine && !session.offline) {
        connectEvents();
        if (offlineLibraryRef.current && drafts.current.size) void retry();
        else void poll();
      }
      else {
        pollAbort.current?.abort();
        socket?.close();
      }
    };
    const visibility = () => {
      if (document.hidden) pollAbort.current?.abort();
      else void poll();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (drafts.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    const timer = setInterval(() => void poll(), session.config.pollSeconds * 1000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    window.addEventListener('beforeunload', beforeUnload);
    connectEvents();
    if (ready.current && navigator.onLine && !session.offline) {
      if (offlineLibraryRef.current && drafts.current.size) void retry();
      else void poll();
    }
    return () => {
      stopped = true;
      clearInterval(timer);
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pingTimer);
      socket?.close();
      pollAbort.current?.abort();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [loading, session.config.pollSeconds, session.offline, show]);

  const pending = [...drafts.current.values()].map((draft) => draft.note);
  const visible = notes.map((item) => {
    const draft = drafts.current.get(item.id)?.note;
    return draft ? { ...draft, excerpt: noteExcerpt(draft.content, query) } : item;
  });
  for (const local of pending) {
    if (!visible.some((item) => item.id === local.id)) visible.unshift({ ...local, excerpt: noteExcerpt(local.content, query) });
  }
  const filtered = visible.filter((item) => {
    if (view === 'trash') {
      if (item.deletedAt === null) return false;
    } else {
      if (item.deletedAt !== null || item.archived !== (view === 'archive')) return false;
    }
    if (tag && !item.tags.includes(tag)) return false;
    return !query || `${item.title} ${item.excerpt}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  });
  const status = !online ? '仅保存在本机' : note && running.current.has(note.id) ? '正在保存' :
    note && drafts.current.has(note.id) ? blocked.current.has(note.id) ? '待处理草稿' : '本机草稿' : '已保存到云端';
  void tick;
  return {
    note, notes: filtered, tags, view, query, tag, setView, setQuery, setTag,
    nextOffset, loading, error, setError, conflict, setConflict, status, pending,
    online, offlineLibrary, offlineCount,
    busy: running.current.size > 0, select, clearSelection, create, edit, append, save: () => note ? save(note.id) : Promise.resolve(true),
    retry, conflictCopy, resolveConflict, discardConflict, purge, purgeTrash,
    refresh: () => refreshRef.current(), loadMore: () => refresh(true),
    configureOffline, cachedFile, backlinks, tasks, searchAll, manageTag, bulkUpdate, findDuplicates,
  };
}
