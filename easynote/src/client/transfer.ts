import { zip, unzip, strToU8, strFromU8 } from 'fflate';
import { filePath, idPattern, imagePath, storedFileIds, type ClientConfig } from '../shared/types';
import { api, uploadAttachment, uploadImage } from './api';
import { loadCachedFile, loadDrafts } from './drafts';

const MAX_ARCHIVE_BYTES = 64 * 1024 ** 2;
const MAX_ENTRIES = 1200;
const NOTE_PATH = /^notes\/[^<>:"/\\|?*\u0000-\u001f]+\.md$/;
const FILE_PATH = /^files\/[0-9a-f-]{36}-[^<>:"/\\|?*\u0000-\u001f]+$/i;
interface Manifest {
  format: 'easynote';
  version: 2;
  notes: Array<{ id: string; path: string; title: string; tags: string[]; pinned: boolean; archived: boolean; deletedAt: number | null }>;
  files: Array<{ id: string; path: string; mime: string; filename: string; sha256: string }>;
}
export interface ImportResult {
  imported: number;
  skipped: number;
}
const sha = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, '0')).join('');

function titleFromContent(content: string): string {
  const firstLine = content.replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  const title = firstLine.replace(/^#{1,6}(?:\s+|$)/, '').replace(/\s+#+$/, '').trim();
  return title.slice(0, 256);
}

const duplicateKey = (title: string, content: string) =>
  sha(strToU8(content ? `content\u0000${content}` : `empty\u0000${title.trim()}`));

function noteExportPath(title: string, used: Set<string>): string {
  let base = title.normalize('NFC').trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120)
    .replace(/[. ]+$/g, '');
  if (!base) base = '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base += '-笔记';
  let filename = `${base}.md`;
  for (let suffix = 2; used.has(filename.toLocaleLowerCase('en-US')); suffix++) {
    filename = `${base.slice(0, 112)} (${suffix}).md`;
  }
  used.add(filename.toLocaleLowerCase('en-US'));
  return `notes/${filename}`;
}

function safeFilename(value: string): string {
  return value.normalize('NFC').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '').slice(0, 120).replace(/[. ]+$/g, '') || '附件';
}

function responseFilename(response: Response, fallback: string): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('Content-Disposition') ?? '')?.[1];
  try { return encoded ? decodeURIComponent(encoded) : fallback; } catch { return fallback; }
}

function download(name: string, bytes: Uint8Array): void {
  const href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

export async function exportArchive(progress: (text: string) => void): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  const manifest: Manifest = { format: 'easynote', version: 2, notes: [], files: [] };
  let total = 0;
  const add = (path: string, bytes: Uint8Array) => {
    total += bytes.byteLength;
    if (total > MAX_ARCHIVE_BYTES || Object.keys(files).length >= MAX_ENTRIES) throw new Error('当前浏览器导出上限为 64 MiB / 1200 个文件。');
    files[path] = bytes;
  };
  let offset: number | null = 0;
  const ids = new Set<string>();
  do {
    const page = await api.list({ view: 'export', offset });
    page.notes.forEach((n) => ids.add(n.id));
    offset = page.nextOffset;
  } while (offset !== null);
  const storedFiles = new Set<string>();
  const noteFilenames = new Set<string>();
  for (const id of ids) {
    const { note } = await api.note(id);
    const path = noteExportPath(note.title, noteFilenames);
    add(path, strToU8(note.content));
    manifest.notes.push({
      id, path, title: note.title, tags: note.tags,
      pinned: note.pinned, archived: note.archived, deletedAt: note.deletedAt,
    });
    storedFileIds(note.content).forEach((file) => storedFiles.add(file));
    progress(`导出笔记 ${manifest.notes.length}/${ids.size}`);
  }
  for (const id of storedFiles) {
    const response = await fetch(filePath(id));
    if (!response.ok) throw new Error(`GET ${filePath(id)} [${response.status}]\n${await response.text()}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const filename = responseFilename(response, id);
    const path = `files/${id}-${safeFilename(filename)}`;
    add(path, bytes);
    const mime = response.headers.get('Content-Type') ?? '';
    manifest.files.push({ id, path, mime, filename, sha256: await sha(bytes) });
    progress(`导出文件 ${manifest.files.length}/${storedFiles.size}`);
  }
  // Keep Markdown readable after extraction; the manifest retains stable file identifiers.
  for (const entry of manifest.notes) {
    let content = strFromU8(files[entry.path]);
    for (const stored of manifest.files) {
      content = content.replaceAll(imagePath(stored.id), `../${stored.path}`)
        .replaceAll(filePath(stored.id), `../${stored.path}`);
    }
    files[entry.path] = strToU8(content);
  }
  add('manifest.json', strToU8(JSON.stringify(manifest, null, 2)));
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(files, { level: 0 }, (error, data) => error ? reject(error) : resolve(data)));
  download(`easynote-${new Date().toISOString().slice(0, 10)}.zip`, bytes);
}

export async function exportLocalDrafts(userId: string, progress: (text: string) => void): Promise<number> {
  const drafts = await loadDrafts(userId);
  if (!drafts.size) throw new Error('当前没有待同步的本机草稿。');
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  const add = (path: string, bytes: Uint8Array) => {
    total += bytes.byteLength;
    if (total > MAX_ARCHIVE_BYTES || Object.keys(files).length >= MAX_ENTRIES) {
      throw new Error('本机草稿导出上限为 64 MiB / 1200 个文件。');
    }
    files[path] = bytes;
  };
  const used = new Set<string>();
  const manifest = {
    format: 'easynote-local-drafts',
    version: 1,
    exportedAt: new Date().toISOString(),
    drafts: [] as Array<{ id: string; path: string; title: string; revision: number; operationId: string }>,
    files: [] as Array<{ id: string; path: string; mime: string; filename: string; sha256: string }>,
  };
  const referenced = new Set<string>();
  for (const [id, draft] of drafts) {
    const path = noteExportPath(draft.note.title, used).replace(/^notes\//, 'drafts/');
    add(path, strToU8(draft.note.content));
    manifest.drafts.push({ id, path, title: draft.note.title, revision: draft.note.revision, operationId: draft.operationId });
    storedFileIds(draft.note.content).forEach((file) => referenced.add(file));
  }
  for (const id of referenced) {
    const cached = await loadCachedFile(userId, id);
    if (!cached) continue;
    const path = `files/${id}-${safeFilename(cached.filename)}`;
    const bytes = new Uint8Array(await cached.blob.arrayBuffer());
    add(path, bytes);
    manifest.files.push({ id, path, mime: cached.mime, filename: cached.filename, sha256: await sha(bytes) });
  }
  for (const draft of manifest.drafts) {
    let content = strFromU8(files[draft.path]);
    for (const stored of manifest.files) {
      content = content.replaceAll(imagePath(stored.id), `../${stored.path}`)
        .replaceAll(filePath(stored.id), `../${stored.path}`);
    }
    files[draft.path] = strToU8(content);
  }
  add('manifest.json', strToU8(JSON.stringify(manifest, null, 2)));
  progress(`正在打包 ${drafts.size} 篇草稿`);
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(files, { level: 0 }, (error, data) => error ? reject(error) : resolve(data)));
  download(`easynote-local-drafts-${new Date().toISOString().slice(0, 10)}.zip`, bytes);
  return drafts.size;
}

async function unpack(file: File): Promise<Record<string, Uint8Array>> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('导入文件超过 64 MiB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    let total = 0;
    let count = 0;
    let violation = false;
    const paths = new Set<string>();
    unzip(bytes, {
      filter(entry) {
        total += entry.originalSize; count++;
        if (total > MAX_ARCHIVE_BYTES || count > MAX_ENTRIES || paths.has(entry.name) ||
            entry.name.split('/').some((part) => part === '..') || entry.name.startsWith('/')) violation = true;
        paths.add(entry.name);
        return !violation;
      },
    }, (error, entries) => {
      if (error) reject(error);
      else if (violation) reject(new Error('备份解压大小、路径或文件数量不符合限制。'));
      else resolve(entries);
    });
  });
}

export async function importArchive(file: File, config: ClientConfig, progress: (text: string) => void): Promise<ImportResult> {
  if (file.name.toLowerCase().endsWith('.md') || file.name.toLowerCase().endsWith('.txt')) {
    if (file.size > config.maxNoteBytes) throw new Error('笔记大小超过限制。');
    const content = await file.text();
    const title = titleFromContent(content);
    if ((await api.duplicate(title, content)).duplicate) {
      progress('已跳过重复笔记');
      return { imported: 0, skipped: 1 };
    }
    await api.save(crypto.randomUUID(), {
      title, content,
      tags: [], pinned: false, archived: false, deletedAt: null,
    }, 0, crypto.randomUUID());
    return { imported: 1, skipped: 0 };
  }
  const files = await unpack(file);
  if (!files['manifest.json'] || files['manifest.json'].length > 2 * 1024 ** 2) throw new Error('未找到有效的 EasyNote 备份清单。');
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Manifest;
  if (manifest.format !== 'easynote' || manifest.version !== 2 ||
      !Array.isArray(manifest.notes) || !Array.isArray(manifest.files)) {
    throw new Error('不支持的备份格式。');
  }
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.id !== 'string' || !idPattern.test(entry.id) || seen.has(entry.id) ||
        typeof entry.path !== 'string' || entry.path.length > 240 || !FILE_PATH.test(entry.path) || !entry.path.startsWith(`files/${entry.id}-`) ||
        !files[entry.path] ||
        typeof entry.filename !== 'string' || !entry.filename || entry.filename.length > 180 || /[/\\\u0000-\u001f]/.test(entry.filename) ||
        !['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'].includes(entry.mime) ||
        files[entry.path].length > (entry.mime.startsWith('image/') ? config.maxImageBytes : config.maxAttachmentBytes) ||
        await sha(files[entry.path]) !== entry.sha256) {
      throw new Error('文件缺失、重复或校验失败。');
    }
    seen.add(entry.id);
  }
  const planned = new Set<string>();
  const notePaths = new Set<string>();
  const prepared: Array<{ entry: Manifest['notes'][number]; content: string }> = [];
  for (const entry of manifest.notes) {
    const pathKey = typeof entry?.path === 'string' ? entry.path.normalize('NFC').toLocaleLowerCase('en-US') : '';
    if (!entry || typeof entry.id !== 'string' || !idPattern.test(entry.id) || planned.has(entry.id) ||
        typeof entry.path !== 'string' || entry.path.length > 160 || !NOTE_PATH.test(entry.path) || notePaths.has(pathKey) || !files[entry.path] ||
        files[entry.path].length > config.maxNoteBytes || typeof entry.title !== 'string' || entry.title.length > 256 ||
        !Array.isArray(entry.tags) || entry.tags.length > 20 || entry.tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 40) ||
        typeof entry.pinned !== 'boolean' || typeof entry.archived !== 'boolean' ||
        !(entry.deletedAt === null || Number.isSafeInteger(entry.deletedAt) && entry.deletedAt > 0)) {
      throw new Error('笔记清单无效或正文缺失。');
    }
    planned.add(entry.id);
    notePaths.add(pathKey);
    let content = strFromU8(files[entry.path]);
    for (const stored of manifest.files) {
      const canonical = stored.mime.startsWith('image/') ? imagePath(stored.id) : filePath(stored.id);
      content = content.replaceAll(`../${stored.path}`, canonical);
    }
    if (storedFileIds(content).some((id) => !seen.has(id))) throw new Error('笔记引用的文件不在备份中。');
    prepared.push({ entry, content });
  }
  const unique: typeof prepared = [];
  const fingerprints = new Set<string>();
  let skipped = 0;
  for (const candidate of prepared) {
    const fingerprint = await duplicateKey(candidate.entry.title, candidate.content);
    if (fingerprints.has(fingerprint) || (await api.duplicate(candidate.entry.title, candidate.content)).duplicate) {
      skipped++;
      progress(`跳过重复笔记 ${skipped}`);
      continue;
    }
    fingerprints.add(fingerprint);
    unique.push(candidate);
  }
  const neededFiles = new Set(unique.flatMap(({ content }) => storedFileIds(content)));
  const remap = new Map<string, string>();
  let imported = 0;
  try {
    for (const entry of manifest.files.filter((file) => neededFiles.has(file.id))) {
      const source = new File([new Uint8Array(files[entry.path])], entry.filename, { type: entry.mime });
      const uploaded = entry.mime.startsWith('image/')
        ? await uploadImage(source, config.maxImageBytes, config.maxImagePixels)
        : await uploadAttachment(source, config.maxAttachmentBytes);
      remap.set(entry.id, uploaded.id);
      progress(`恢复文件 ${remap.size}/${neededFiles.size}`);
    }
    for (const { entry, content: sourceContent } of unique) {
      const content = sourceContent
        .replace(/\/api\/(images|files)\/([0-9a-f-]{36})/gi, (_all, kind: string, id: string) => {
          const next = remap.get(id) ?? id;
          return kind.toLowerCase() === 'images' ? imagePath(next) : filePath(next);
        });
      await api.save(crypto.randomUUID(), {
        title: entry.title, content, tags: entry.tags, pinned: entry.pinned,
        archived: entry.archived, deletedAt: entry.deletedAt,
      }, 0, crypto.randomUUID());
      imported++;
      progress(`恢复笔记 ${imported}/${unique.length}`);
    }
  } catch (e) { throw new Error(`已导入 ${imported} 篇、跳过 ${skipped} 篇重复笔记，后续导入停止。\n${String(e)}`); }
  return { imported, skipped };
}
