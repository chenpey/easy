import { zip, unzip, strToU8, strFromU8 } from 'fflate';
import { filePath, idPattern, imagePath, storedFileIds, type ClientConfig } from '../shared/types';
import { api, uploadAttachment, uploadImage } from './api';
import { loadCachedFile, loadDrafts } from './drafts';

const MAX_ARCHIVE_BYTES = 64 * 1024 ** 2;
const MAX_ENTRIES = 1200;
const NOTE_PATH = /^notes\/[^<>:"/\\|?*\u0000-\u001f]+\.md$/;
const FILE_PATH = /^files\/[0-9a-f-]{36}-[^<>:"/\\|?*\u0000-\u001f]+$/i;
const EXTERNAL_NOTE = /\.(?:md|markdown|txt)$/i;
const IMAGE_MIMES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const ATTACHMENT_MIMES: Record<string, string> = {
  pdf: 'application/pdf',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
};
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

function normalizeExternalPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' || /[\u0000-\u001f]/.test(part)) throw new Error('导入目录包含不安全路径。');
    parts.push(part.normalize('NFC'));
  }
  if (!parts.length) throw new Error('导入文件路径无效。');
  return parts.join('/');
}

function relativePath(source: string, target: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(target.replace(/^<|>$/g, '')); } catch { return null; }
  decoded = decoded.split(/[?#]/, 1)[0];
  if (!decoded || decoded.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;
  const parts = source.split('/').slice(0, -1);
  for (const part of decoded.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      if (/[\u0000-\u001f]/.test(part)) return null;
      parts.push(part.normalize('NFC'));
    }
  }
  return parts.length ? parts.join('/') : null;
}

function externalMetadata(path: string, content: string): { title: string; tags: string[] } {
  const filename = path.split('/').at(-1)!.replace(EXTERNAL_NOTE, '');
  const match = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(content);
  const frontmatter = match?.[1] ?? '';
  const titleValue = /^title:\s*(.+?)\s*$/mi.exec(frontmatter)?.[1]
    ?.replace(/^(['"])(.*)\1$/, '$2').trim();
  const inlineTags = /^tags:\s*\[(.*?)\]\s*$/mi.exec(frontmatter)?.[1]
    ?.split(',').map((value) => value.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean) ?? [];
  const blockTags = /^tags:\s*\r?\n((?:\s+-\s+.*\r?\n?)*)/mi.exec(frontmatter)?.[1]
    ?.split(/\r?\n/).map((value) => value.replace(/^\s*-\s+/, '').trim()).filter(Boolean) ?? [];
  const tags = [...new Set([...inlineTags, ...blockTags].map((value) => value.replace(/^#/, '').slice(0, 40)).filter(Boolean))].slice(0, 20);
  const heading = titleFromContent(match ? content.slice(match[0].length) : content);
  return { title: (titleValue || heading || filename || '未命名').slice(0, 256), tags };
}

function externalMime(path: string): string | null {
  const extension = path.toLocaleLowerCase('en-US').split('.').at(-1) ?? '';
  return IMAGE_MIMES[extension] ?? ATTACHMENT_MIMES[extension] ?? null;
}

async function replaceAsync(
  value: string,
  pattern: RegExp,
  replacer: (...values: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...value.matchAll(pattern)];
  if (!matches.length) return value;
  const replacements = await Promise.all(matches.map((match) => replacer(...match.slice(0))));
  let result = '';
  let cursor = 0;
  for (const [index, match] of matches.entries()) {
    result += value.slice(cursor, match.index) + replacements[index];
    cursor = match.index! + match[0].length;
  }
  return result + value.slice(cursor);
}

async function importExternalEntries(
  rawEntries: Array<{ path: string; bytes: Uint8Array }>,
  config: ClientConfig,
  progress: (text: string) => void,
): Promise<ImportResult> {
  if (!rawEntries.length || rawEntries.length > MAX_ENTRIES) throw new Error('请选择包含 Markdown 或 TXT 的目录或 ZIP。');
  let total = 0;
  const entries = new Map<string, { path: string; bytes: Uint8Array }>();
  for (const raw of rawEntries) {
    const path = normalizeExternalPath(raw.path);
    if (path.startsWith('__MACOSX/') || path.split('/').some((part) => part.startsWith('.'))) continue;
    total += raw.bytes.length;
    if (total > MAX_ARCHIVE_BYTES) throw new Error('导入内容超过 64 MiB。');
    const key = path.toLocaleLowerCase('en-US');
    if (entries.has(key)) throw new Error(`导入目录存在重复路径：${path}`);
    entries.set(key, { path, bytes: raw.bytes });
  }
  const noteEntries = [...entries.values()].filter((entry) => EXTERNAL_NOTE.test(entry.path));
  if (!noteEntries.length) throw new Error('没有找到 Markdown 或 TXT 笔记。');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const notes = noteEntries.map((entry) => {
    if (entry.bytes.length > config.maxNoteBytes) throw new Error(`笔记超过大小限制：${entry.path}`);
    let content: string;
    try { content = decoder.decode(entry.bytes); } catch { throw new Error(`笔记不是 UTF-8：${entry.path}`); }
    return { ...entry, id: crypto.randomUUID(), content, ...externalMetadata(entry.path, content) };
  });
  const noteByPath = new Map(notes.map((entry) => [entry.path.toLocaleLowerCase('en-US'), entry]));
  const noteByStem = new Map<string, typeof notes[number] | null>();
  for (const entry of notes) {
    const stem = entry.path.split('/').at(-1)!.replace(EXTERNAL_NOTE, '').toLocaleLowerCase('en-US');
    noteByStem.set(stem, noteByStem.has(stem) ? null : entry);
  }
  const resolveNote = (source: string, target: string) => {
    const clean = target.split('#', 1)[0].trim();
    const direct = relativePath(source, clean);
    const candidates = direct ? [direct, `${direct}.md`, `${direct}.markdown`, `${direct}.txt`] : [];
    for (const candidate of candidates) {
      const found = noteByPath.get(candidate.toLocaleLowerCase('en-US'));
      if (found) return found;
    }
    return noteByStem.get(clean.split('/').at(-1)!.toLocaleLowerCase('en-US')) ?? null;
  };

  const uploads = new Map<string, Promise<{ id: string; url: string }>>();
  const upload = (source: string, target: string) => {
    const path = relativePath(source, target);
    if (!path) return null;
    const key = path.toLocaleLowerCase('en-US');
    const entry = entries.get(key);
    const mime = externalMime(path);
    if (!entry || !mime || EXTERNAL_NOTE.test(path)) return null;
    let running = uploads.get(key);
    if (!running) {
      running = (async () => {
        const file = new File([new Uint8Array(entry.bytes)], entry.path.split('/').at(-1)!, { type: mime });
        const stored = mime.startsWith('image/')
          ? await uploadImage(file, config.maxImageBytes, config.maxImagePixels)
          : await uploadAttachment(file, config.maxAttachmentBytes);
        progress(`上传引用文件 ${uploads.size}`);
        return stored;
      })();
      uploads.set(key, running);
    }
    return running;
  };

  const prepared: Array<{ source: typeof notes[number]; content: string }> = [];
  for (const source of notes) {
    let content = source.content;
    content = await replaceAsync(content, /!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
      async (original, target, label) => {
        const stored = upload(source.path, target);
        if (!stored) return original;
        const file = await stored;
        return externalMime(target)?.startsWith('image/')
          ? `![${label || target}](${file.url})`
          : `[${label || target}](${file.url})`;
      });
    content = await replaceAsync(content, /(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
      async (original, target, label) => {
        const linked = resolveNote(source.path, target);
        return linked ? `[[${linked.id}|${label || linked.title}]]` : original;
      });
    content = await replaceAsync(content, /(!?)\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*)?\)/g,
      async (original, imageMarker, label, target) => {
        const linked = resolveNote(source.path, target);
        if (!imageMarker && linked) return `[[${linked.id}|${label || linked.title}]]`;
        const stored = upload(source.path, target);
        if (!stored) return original;
        const file = await stored;
        return `${imageMarker}[${label}](${file.url})`;
      });
    if (new TextEncoder().encode(content).length > config.maxNoteBytes) {
      throw new Error(`转换后的笔记超过大小限制：${source.path}`);
    }
    prepared.push({ source, content });
  }

  const remapped = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  const unique: typeof prepared = [];
  let skipped = 0;
  for (const candidate of prepared) {
    const fingerprint = await duplicateKey(candidate.source.title, candidate.content);
    const incoming = fingerprints.get(fingerprint);
    if (incoming) {
      remapped.set(candidate.source.id, incoming);
      skipped++;
      progress(`跳过重复笔记 ${skipped}`);
      continue;
    }
    const existing = await api.duplicate(candidate.source.title, candidate.content);
    if (existing.duplicate && existing.noteId) {
      remapped.set(candidate.source.id, existing.noteId);
      skipped++;
      progress(`跳过重复笔记 ${skipped}`);
      continue;
    }
    fingerprints.set(fingerprint, candidate.source.id);
    unique.push(candidate);
  }
  const finalId = (id: string) => {
    const visited = new Set<string>();
    while (remapped.has(id) && !visited.has(id)) {
      visited.add(id);
      id = remapped.get(id)!;
    }
    return id;
  };
  let imported = 0;
  for (const { source, content: preparedContent } of unique) {
    const content = preparedContent.replace(
      /\[\[([0-9a-f-]{36})(\|[^\]\r\n]{1,256}\]\])/gi,
      (original, id: string, suffix: string) => idPattern.test(id) ? `[[${finalId(id)}${suffix}` : original,
    );
    await api.save(source.id, {
      title: source.title,
      content,
      tags: source.tags,
      pinned: false,
      archived: false,
      deletedAt: null,
    }, 0, crypto.randomUUID());
    imported++;
    progress(`导入笔记 ${imported}/${notes.length}`);
  }
  return { imported, skipped };
}

export async function importExternalFiles(
  selected: File[],
  config: ClientConfig,
  progress: (text: string) => void,
): Promise<ImportResult> {
  if (!selected.length) throw new Error('没有选择导入文件。');
  if (selected.length === 1 && (selected[0].name.toLocaleLowerCase('en-US').endsWith('.zip') ||
      EXTERNAL_NOTE.test(selected[0].name) && selected[0].size === 0)) {
    return importArchive(selected[0], config, progress);
  }
  const entries = await Promise.all(selected.map(async (file) => ({
    path: file.webkitRelativePath || file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })));
  return importExternalEntries(entries, config, progress);
}

export async function importArchive(file: File, config: ClientConfig, progress: (text: string) => void): Promise<ImportResult> {
  if (EXTERNAL_NOTE.test(file.name)) {
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
  if (!files['manifest.json']) {
    return importExternalEntries(Object.entries(files).map(([path, bytes]) => ({ path, bytes })), config, progress);
  }
  if (files['manifest.json'].length > 2 * 1024 **2) throw new Error('EasyNote 备份清单过大。');
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Manifest;
  if (manifest.format !== 'easynote') {
    return importExternalEntries(Object.entries(files).map(([path, bytes]) => ({ path, bytes })), config, progress);
  }
  if (manifest.version !== 2 || !Array.isArray(manifest.notes) || !Array.isArray(manifest.files)) {
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
