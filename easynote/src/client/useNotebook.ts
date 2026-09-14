import { useCallback, useEffect, useRef, useState } from 'react';
import { noteInput, sameNoteInput, type Note, type NoteInput, type NoteSummary, type Session } from '../shared/types';
import { api, ApiError } from './api';
import { loadDrafts, persistDraft, type Draft } from './drafts';

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
  const [tick, bump] = useState(0);
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<{ local: Note; remote?: Note } | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncPaused, setSyncPaused] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const listGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const persist = (id: string, draft: Draft | null) => persistDraft(userId, id, draft).catch((e: unknown) => {
    if (alive.current) setError(`本地草稿写入失败，请勿关闭页面。\n${String(e)}`);
    throw e;
  });
  const show = useCallback((value: Note | null) => { current.current = value; setNote(value); }, []);
  const notify = () => { if (alive.current) bump((v) => v + 1); };

  const refresh = useCallback(async (append = false) => {
    const generation = ++listGeneration.current;
    const result = await api.list({ q: query, view, tag, offset: append ? nextOffset ?? 0 : 0 });
    if (!alive.current || generation !== listGeneration.current) return;
    setNotes((prev) => append ? [...prev, ...result.notes.filter((n) => !prev.some((old) => old.id === n.id))] : result.notes);
    setNextOffset(result.nextOffset);
    const data = await api.tags();
    if (alive.current && generation === listGeneration.current) setTags(data.tags);
  }, [query, view, tag, nextOffset]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const saveRef = useRef<(id: string) => Promise<boolean>>(async () => false);
  const schedule = (id: string) => {
    const previous = pendingTimers.current.get(id);
    if (previous) clearTimeout(previous);
    pendingTimers.current.set(id, setTimeout(() => {
      pendingTimers.current.delete(id);
      if (!blocked.current.has(id)) void saveRef.current(id);
    }, session.config.autosaveMs));
  };

  const save = async (id: string): Promise<boolean> => {
    if (running.current.has(id)) return false;
    const draft = drafts.current.get(id);
    if (!draft) return true;
    if (!navigator.onLine) { notify(); return false; }
    running.current.add(id);
    notify();
    let ok = false;
    try {
      await persist(id, draft);
      const { note: saved } = await api.save(id, noteInput(draft.note), draft.note.revision, draft.operationId);
      if (!alive.current) return true;
      const latest = drafts.current.get(id);
      if (latest?.operationId === draft.operationId) {
        drafts.current.delete(id);
        if (current.current?.id === id) show(saved);
        await persist(id, null);
      } else if (latest) {
        const updated = { ...latest, note: { ...latest.note, revision: saved.revision, createdAt: saved.createdAt } };
        drafts.current.set(id, updated);
        if (current.current?.id === id) show(updated.note);
        await persist(id, updated);
      }
      blocked.current.delete(id);
      ok = true;
      await refreshRef.current();
    } catch (e) {
      if (!alive.current) return false;
      blocked.current.add(id);
      if (e instanceof ApiError && [409, 410].includes(e.status)) {
        setConflict({ local: drafts.current.get(id)?.note ?? draft.note, remote: e.body.error?.current });
      }
      setError(String(e));
    } finally {
      running.current.delete(id);
      notify();
      if (ok && drafts.current.has(id) && alive.current) schedule(id);
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
    const draft = { note: updated, operationId: crypto.randomUUID() };
    drafts.current.set(target.id, draft);
    if (current.current?.id === target.id) show(updated);
    void persist(target.id, draft).catch(() => undefined);
    notify();
    schedule(target.id);
  };

  const select = async (id: string) => {
    const generation = ++selectionGeneration.current;
    try {
      const local = drafts.current.get(id);
      if (local) { show(local.note); return; }
      const result = await api.note(id);
      if (!alive.current || generation !== selectionGeneration.current) return;
      show(drafts.current.get(id)?.note ?? result.note);
    } catch (e) { if (alive.current) setError(String(e)); }
  };

  const append = (target: Note, text: string) => {
    const latest = drafts.current.get(target.id)?.note ?? (current.current?.id === target.id ? current.current : target);
    edit({ content: `${latest.content}${latest.content ? '\n\n' : ''}${text}\n` }, latest);
  };

  const create = async (input: Partial<NoteInput> = {}) => {
    const newNote: Note = {
      id: crypto.randomUUID(), title: '', content: '', tags: [], pinned: false, deletedAt: null,
      createdAt: Date.now(), updatedAt: Date.now(), revision: 0, ...input,
    };
    selectionGeneration.current++;
    setView('all'); setQuery(''); setTag(''); show(newNote);
    edit({}, newNote);
    return newNote;
  };

  const retry = async (): Promise<boolean> => {
    setError(''); setConflict(null); setSyncPaused(false);
    let savedAll = true;
    for (const id of drafts.current.keys()) {
      blocked.current.delete(id);
      if (!await saveRef.current(id)) { savedAll = false; break; }
    }
    try {
      await refreshRef.current();
      return savedAll;
    } catch (e) {
      setError(String(e)); setSyncPaused(true);
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
    const draft = { note: copy, operationId: crypto.randomUUID() };
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

  const purge = async () => {
    if (!current.current || drafts.current.has(current.current.id)) throw new Error('请先保存当前笔记。');
    const target = current.current;
    await api.purge(target);
    if (current.current?.id === target.id) show(null);
    await refreshRef.current();
  };

  useEffect(() => {
    alive.current = true;
    void loadDrafts(userId).then(async (loaded) => {
      if (!alive.current) return;
      drafts.current = loaded;
      ready.current = true;
      for (const id of loaded.keys()) blocked.current.add(id);
      if (loaded.size) show(loaded.values().next().value!.note);
      await refreshRef.current();
    }).catch((e: unknown) => { if (alive.current) setError(String(e)); }).finally(() => {
      if (alive.current) { setLoading(false); notify(); }
    });
    return () => {
      alive.current = false;
      ready.current = false;
      for (const timer of pendingTimers.current.values()) clearTimeout(timer);
    };
  }, [userId, show]);

  useEffect(() => {
    if (!ready.current) return;
    const timer = setTimeout(() => void refreshRef.current().catch((e: unknown) => setError(String(e))), 200);
    return () => clearTimeout(timer);
  }, [view, query, tag]);

  useEffect(() => {
    const poll = async () => {
      if (!ready.current || document.hidden || syncPaused || !navigator.onLine) return;
      try {
        if (notes.length > 50) return;
        await refreshRef.current();
        const before = current.current;
        if (!before || drafts.current.has(before.id)) return;
        const remote = (await api.note(before.id)).note;
        if (current.current?.id === before.id && !drafts.current.has(before.id) && remote.revision > current.current.revision) show(remote);
      } catch (e) {
        if (alive.current) { setError(String(e)); setSyncPaused(true); }
      }
    };
    const network = () => setOnline(navigator.onLine);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (drafts.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    const timer = setInterval(() => void poll(), session.config.pollSeconds * 1000);
    document.addEventListener('visibilitychange', poll);
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [session.config.pollSeconds, syncPaused, nextOffset, notes.length, show]);

  const pending = [...drafts.current.values()].map((draft) => draft.note);
  const visible = notes.map((item) => {
    const draft = drafts.current.get(item.id)?.note;
    return draft ? { ...draft, excerpt: draft.content.slice(0, 180) } : item;
  });
  for (const local of pending) {
    if (!visible.some((item) => item.id === local.id)) visible.unshift({ ...local, excerpt: local.content.slice(0, 180) });
  }
  const filtered = visible.filter((item) => {
    if ((view === 'trash') !== (item.deletedAt !== null)) return false;
    if (view === 'pinned' && !item.pinned || tag && !item.tags.includes(tag)) return false;
    return !query || `${item.title} ${item.excerpt}`.toLowerCase().includes(query.toLowerCase()) || notes.some((n) => n.id === item.id);
  });
  const status = !online ? '仅保存在本机' : note && running.current.has(note.id) ? '正在保存' :
    note && drafts.current.has(note.id) ? blocked.current.has(note.id) ? '待处理草稿' : '本机草稿' : '已保存到云端';
  void tick;
  return {
    note, notes: filtered, tags, view, query, tag, setView, setQuery, setTag,
    nextOffset, loading, error, setError, conflict, setConflict, status, pending,
    busy: running.current.size > 0, select, create, edit, append, save: () => note ? save(note.id) : Promise.resolve(true),
    retry, conflictCopy, purge, refresh: () => refreshRef.current(), loadMore: () => refresh(true),
  };
}
