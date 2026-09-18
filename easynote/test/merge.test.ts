import assert from 'node:assert/strict';
import test from 'node:test';
import type { Note } from '../src/shared/types';
import { mergeNoteChanges } from '../src/client/merge';

const baseNote = (patch: Partial<Note> = {}): Note => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: '会议记录',
  content: '第一段\n第二段\n第三段\n',
  tags: ['工作'],
  pinned: false,
  archived: false,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  ...patch,
});

test('three-way merge combines non-overlapping content and metadata changes', () => {
  const base = baseNote();
  const local = baseNote({
    content: '第一段\n本机修改第二段\n第三段\n',
    tags: ['工作', '本机'],
  });
  const remote = baseNote({
    content: '云端修改第一段\n第二段\n第三段\n',
    tags: ['工作', '云端'],
    pinned: true,
    revision: 2,
  });
  const merged = mergeNoteChanges(base, local, remote);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.note.content, '云端修改第一段\n本机修改第二段\n第三段\n');
  assert.deepEqual(merged.note.tags, ['工作', '云端', '本机']);
  assert.equal(merged.note.pinned, true);
  assert.equal(merged.note.revision, 2);
});

test('three-way merge reports overlapping edits and resolves only the conflicting region', () => {
  const base = baseNote();
  const local = baseNote({
    title: '本机标题',
    content: '第一段\n本机第二段\n第三段\n',
  });
  const remote = baseNote({
    content: '云端第一段\n云端第二段\n第三段\n',
    archived: true,
    revision: 2,
  });
  const detected = mergeNoteChanges(base, local, remote);
  assert.deepEqual(detected.conflicts, ['content']);

  const keepLocal = mergeNoteChanges(base, local, remote, 'local');
  assert.equal(keepLocal.note.title, '本机标题');
  assert.equal(keepLocal.note.content, '云端第一段\n本机第二段\n第三段\n');
  assert.equal(keepLocal.note.archived, true);

  const keepRemote = mergeNoteChanges(base, local, remote, 'remote');
  assert.equal(keepRemote.note.title, '本机标题');
  assert.equal(keepRemote.note.content, '云端第一段\n云端第二段\n第三段\n');
  assert.equal(keepRemote.note.archived, true);
});

test('deletion overlapping another device edit requires an explicit choice', () => {
  const base = baseNote();
  const local = baseNote({ content: '本机新内容\n第二段\n第三段\n' });
  const remote = baseNote({ deletedAt: 100, revision: 2 });
  const merged = mergeNoteChanges(base, local, remote);
  assert.deepEqual(merged.conflicts, ['deletedAt']);
  assert.equal(merged.note.content, local.content);
  assert.equal(merged.note.deletedAt, null);
  assert.equal(mergeNoteChanges(base, local, remote, 'remote').note.deletedAt, 100);
});

test('large line-based merges fall back to an explicit conflict without expensive diffing', () => {
  const lines = Array.from({ length: 1000 }, (_, index) => `重复段落 ${index % 3}`);
  const base = baseNote({ content: `${lines.join('\n')}\n` });
  const local = baseNote({ content: `本机修改\n${lines.slice(1).join('\n')}\n` });
  const remote = baseNote({ content: `${lines.slice(0, -1).join('\n')}\n云端修改\n`, revision: 2 });

  const merged = mergeNoteChanges(base, local, remote);
  assert.deepEqual(merged.conflicts, ['content']);
  assert.equal(merged.note.content, local.content);
  assert.equal(mergeNoteChanges(base, local, remote, 'remote').note.content, remote.content);
});
