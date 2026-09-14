import { zip, unzip, strToU8, strFromU8 } from 'fflate';
import { idPattern, imageIds, imagePath, type ClientConfig } from '../shared/types';
import { api, uploadImage } from './api';

const MAX_ARCHIVE_BYTES = 64 * 1024 ** 2;
const MAX_ENTRIES = 1200;
interface Manifest {
  format: 'easynote';
  version: 1;
  notes: Array<{ id: string; path: string; title: string; tags: string[]; pinned: boolean; deletedAt: number | null }>;
  images: Array<{ id: string; path: string; mime: string; filename: string; sha256: string }>;
}
const sha = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function exportArchive(progress: (text: string) => void): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  const manifest: Manifest = { format: 'easynote', version: 1, notes: [], images: [] };
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
  const images = new Set<string>();
  for (const id of ids) {
    const { note } = await api.note(id);
    const path = `notes/${id}.md`;
    add(path, strToU8(note.content));
    manifest.notes.push({ id, path, title: note.title, tags: note.tags, pinned: note.pinned, deletedAt: note.deletedAt });
    imageIds(note.content).forEach((image) => images.add(image));
    progress(`导出笔记 ${manifest.notes.length}/${ids.size}`);
  }
  for (const id of images) {
    const path = `images/${id}`;
    const response = await fetch(imagePath(id));
    if (!response.ok) throw new Error(`GET ${imagePath(id)} [${response.status}]\n${await response.text()}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    add(path, bytes);
    const mime = response.headers.get('Content-Type') ?? '';
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[mime];
    if (!extension) throw new Error('Unsupported backup image type.');
    manifest.images.push({ id, path, mime, filename: `${id}.${extension}`, sha256: await sha(bytes) });
    progress(`导出图片 ${manifest.images.length}/${images.size}`);
  }
  // Keep Markdown readable after extraction; the manifest retains the original stable image identifiers.
  for (const entry of manifest.notes) {
    files[entry.path] = strToU8(strFromU8(files[entry.path]).replace(/\/api\/images\/([0-9a-f-]{36})/gi, '../images/$1'));
  }
  add('manifest.json', strToU8(JSON.stringify(manifest, null, 2)));
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(files, { level: 0 }, (error, data) => error ? reject(error) : resolve(data)));
  const href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = href; link.download = `easynote-${new Date().toISOString().slice(0, 10)}.zip`; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
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

export async function importArchive(file: File, config: ClientConfig, progress: (text: string) => void): Promise<number> {
  if (file.name.toLowerCase().endsWith('.md') || file.name.toLowerCase().endsWith('.txt')) {
    if (file.size > config.maxNoteBytes) throw new Error('笔记大小超过限制。');
    await api.save(crypto.randomUUID(), { title: file.name.replace(/\.(md|txt)$/i, ''), content: await file.text(), tags: [], pinned: false, deletedAt: null }, 0, crypto.randomUUID());
    return 1;
  }
  const files = await unpack(file);
  if (!files['manifest.json'] || files['manifest.json'].length > 2 * 1024 ** 2) throw new Error('未找到有效的 EasyNote 备份清单。');
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Manifest;
  if (manifest.format !== 'easynote' || manifest.version !== 1 || !Array.isArray(manifest.notes) || !Array.isArray(manifest.images)) {
    throw new Error('不支持的备份格式。');
  }
  const seen = new Set<string>();
  for (const entry of manifest.images) {
    if (!entry || typeof entry.id !== 'string' || !idPattern.test(entry.id) || seen.has(entry.id) || entry.path !== `images/${entry.id}` ||
        !files[entry.path] || files[entry.path].length > config.maxImageBytes ||
        typeof entry.filename !== 'string' || !entry.filename || entry.filename.length > 180 || /[/\\\u0000-\u001f]/.test(entry.filename) ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(entry.mime) || await sha(files[entry.path]) !== entry.sha256) {
      throw new Error('图片缺失、重复或校验失败。');
    }
    seen.add(entry.id);
  }
  const planned = new Set<string>();
  for (const entry of manifest.notes) {
    if (!entry || typeof entry.id !== 'string' || !idPattern.test(entry.id) || planned.has(entry.id) || entry.path !== `notes/${entry.id}.md` || !files[entry.path] ||
        files[entry.path].length > config.maxNoteBytes || typeof entry.title !== 'string' || entry.title.length > 256 ||
        !Array.isArray(entry.tags) || entry.tags.length > 20 || entry.tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 40) ||
        typeof entry.pinned !== 'boolean' || !(entry.deletedAt === null || Number.isSafeInteger(entry.deletedAt) && entry.deletedAt > 0)) {
      throw new Error('笔记清单无效或正文缺失。');
    }
    planned.add(entry.id);
    const content = strFromU8(files[entry.path]).replace(/\.\.\/images\/([0-9a-f-]{36})/gi, '/api/images/$1');
    if (imageIds(content).some((id) => !seen.has(id))) throw new Error('笔记引用的图片不在备份中。');
  }
  const remap = new Map<string, string>();
  let imported = 0;
  try {
    for (const entry of manifest.images) {
      const image = await uploadImage(new File([new Uint8Array(files[entry.path])], entry.filename, { type: entry.mime }), config.maxImageBytes, config.maxImagePixels);
      remap.set(entry.id, image.id);
      progress(`恢复图片 ${remap.size}/${manifest.images.length}`);
    }
    for (const entry of manifest.notes) {
      const content = strFromU8(files[entry.path])
        .replace(/(?:\.\.\/images\/|\/api\/images\/)([0-9a-f-]{36})/gi, (_all, id: string) => imagePath(remap.get(id) ?? id));
      await api.save(crypto.randomUUID(), {
        title: entry.title, content, tags: entry.tags, pinned: entry.pinned, deletedAt: entry.deletedAt,
      }, 0, crypto.randomUUID());
      imported++;
      progress(`恢复笔记 ${imported}/${manifest.notes.length}`);
    }
  } catch (e) { throw new Error(`已导入 ${imported} 篇笔记，后续导入停止。\n${String(e)}`); }
  return imported;
}
