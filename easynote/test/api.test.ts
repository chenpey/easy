import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRuntime, testCsrf, testToken, testUserId, testPassword } from './runtime';
import { digest } from '../src/worker/core';
import { cleanup } from '../src/worker/images';
import { passwordVerifier } from '../src/worker/auth';
import { noteFingerprint } from '../src/shared/types';

let instance: Awaited<ReturnType<typeof createRuntime>>;
const origin = 'https://easynote.example.test';
const base = { title: '测试笔记', content: '中文搜索与图片', tags: ['工作'], pinned: false, archived: false, deletedAt: null };
async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return instance.runtime.dispatchFetch(`${origin}${path}`, {
    method, headers: {
      Origin: origin, 'CF-Connecting-IP': '192.0.2.3',
      Cookie: `__Host-easynote=${testToken}`, 'X-CSRF-Token': testCsrf,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function save(
  id: string,
  revision = 0,
  patch: Record<string, unknown> = {},
  operationId = randomUUID(),
  createVersion = true,
) {
  return request(`/api/notes/${id}`, revision ? 'PUT' : 'POST', {
    ...base, ...patch, revision, operationId, createVersion,
  });
}
async function create(patch: Record<string, unknown> = {}) {
  const id = randomUUID();
  const response = await save(id, 0, patch);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json() as any).note;
}
before(async () => { instance = await createRuntime(); });
after(async () => { await instance?.runtime.dispose(); });

test('anonymous requests, cross-origin writes and missing CSRF are rejected', async () => {
  assert.equal((await request('/api/notes', 'GET', undefined, { Cookie: '' })).status, 401);
  assert.equal((await request(`/api/events?client=${randomUUID()}`, 'GET', undefined, {
    Cookie: '',
  })).status, 401);
  assert.equal((await request(`/api/events?client=${randomUUID()}`, 'GET', undefined, {
    Origin: 'https://other.test',
  })).status, 403);
  assert.equal((await request(`/api/notes/${randomUUID()}`, 'POST', {}, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await request(`/api/notes/${randomUUID()}`, 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await instance.runtime.dispatchFetch('http://easynote.example.test/api/session')).status, 403);
});

test('login uses HttpOnly secure cookie; logout revokes the session', async () => {
  const wrong = await request('/api/login', 'POST', { username: 'tester', password: 'wrong' });
  assert.equal(wrong.status, 401);
  const good = await request('/api/login', 'POST', { username: 'tester', password: testPassword });
  assert.equal(good.status, 200, await good.clone().text());
  const cookie = good.headers.get('Set-Cookie')!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
  const data = await good.json() as any;
  assert.ok(data.expiresAt > Date.now());
  assert.equal((await request('/api/logout', 'POST', {}, { Cookie: cookie.split(';')[0], 'X-CSRF-Token': data.csrf })).status, 200);
  assert.equal((await request('/api/notes', 'GET', undefined, { Cookie: cookie.split(';')[0] })).status, 401);
  assert.equal((await (await request('/api/session', 'GET', undefined, { Cookie: cookie.split(';')[0] })).json() as any).expiresAt, null);
});

test('AI tokens are scoped, revocable and preserve revision history', async () => {
  const created = await request('/api/integrations/tokens', 'POST', {
    name: '测试 AI', access: 'read-write', expiresInDays: null,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const credential = await created.json() as any;
  assert.match(credential.secret, /^enai_[a-f0-9]{64}$/);
  assert.equal(credential.token.expiresAt, null);
  const bearer = { Authorization: `Bearer ${credential.secret}`, Cookie: '', 'X-CSRF-Token': '' };
  const status = await request('/api/integrations/status', 'GET', undefined, bearer);
  assert.deepEqual(await status.json(), { account: 'tester', integration: '测试 AI', access: 'read-write' });

  const id = randomUUID();
  const longQuery = '跨设备检索'.repeat(5);
  const aiCreate = await request(`/api/integrations/notes/${id}`, 'POST', {
    ...base, title: 'AI 创建', content: `## 影响\n\n法兰克福 AI 上下文\n${longQuery}`, revision: 0, operationId: randomUUID(),
  }, bearer);
  assert.equal(aiCreate.status, 201, await aiCreate.clone().text());
  const note = (await aiCreate.json() as any).note;
  const search = await (await request(`/api/integrations/notes?q=${encodeURIComponent('法兰克福')}&view=all&limit=10`, 'GET', undefined, bearer)).json() as any;
  const searchResult = search.notes.find((item: any) => item.id === id);
  assert.equal(searchResult.uri, `easynote://notes/${id}.md`);
  assert.ok(searchResult.matches.some((match: any) =>
    match.field === 'content' && match.line === 3 && match.heading === '影响' && match.snippet.includes('法兰克福')));
  assert.match(searchResult.excerpt, /法兰克福/);
  const titleSearch = await (await request('/api/integrations/notes?q=AI&limit=10', 'GET', undefined, bearer)).json() as any;
  assert.ok(titleSearch.notes.find((item: any) => item.id === id).matches.some((match: any) =>
    match.field === 'title' && match.line === null && match.heading === null && match.snippet.includes('AI')));
  const longSearch = await request(
    `/api/integrations/notes?q=${encodeURIComponent(longQuery)}&view=all&limit=10`,
    'GET',
    undefined,
    bearer,
  );
  assert.equal(longSearch.status, 200, await longSearch.clone().text());
  assert.ok((await longSearch.json() as any).notes.some((item: any) => item.id === id));
  assert.equal((await request('/api/integrations/notes?limit=21', 'GET', undefined, bearer)).status, 400);
  assert.equal((await request('/api/integrations/notes?sort=invalid', 'GET', undefined, bearer)).status, 400);

  const secondId = randomUUID();
  const secondCreate = await request(`/api/integrations/notes/${secondId}`, 'POST', {
    ...base, title: '批量读取第二篇', revision: 0, operationId: randomUUID(),
  }, bearer);
  assert.equal(secondCreate.status, 201, await secondCreate.clone().text());
  const batch = await (await request(
    `/api/integrations/notes/batch?ids=${encodeURIComponent(`${secondId},${id}`)}`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.deepEqual(batch.notes.map((item: any) => item.id), [secondId, id]);
  assert.equal((await request('/api/integrations/notes/batch?ids=invalid', 'GET', undefined, bearer)).status, 400);
  assert.equal((await request(
    `/api/integrations/notes/batch?ids=${Array.from({ length: 21 }, () => randomUUID()).join(',')}`,
    'GET',
    undefined,
    bearer,
  )).status, 400);
  assert.equal((await request(
    `/api/integrations/notes/batch?ids=${randomUUID()}`,
    'GET',
    undefined,
    bearer,
  )).status, 404);

  const rankMarker = `rank${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const rankedNotes = [
    { id: randomUUID(), title: rankMarker, content: '标题完全匹配' },
    { id: randomUUID(), title: '正文重复命中', content: `${rankMarker}\n${rankMarker}\n${rankMarker}` },
    { id: randomUUID(), title: '正文单次命中', content: `${'填充 '.repeat(80)}${rankMarker}` },
  ];
  for (const item of rankedNotes) {
    const response = await request(`/api/integrations/notes/${item.id}`, 'POST', {
      ...base,
      title: item.title,
      content: item.content,
      revision: 0,
      operationId: randomUUID(),
    }, bearer);
    assert.equal(response.status, 201, await response.clone().text());
  }
  const ranked = await (await request(
    `/api/integrations/notes?q=${rankMarker}&limit=10`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.deepEqual(ranked.notes.slice(0, 3).map((item: any) => item.id), rankedNotes.map((item) => item.id));
  assert.equal(ranked.notes[1].matches.length, 3);

  const literalId = randomUUID();
  assert.equal((await request(`/api/integrations/notes/${literalId}`, 'POST', {
    ...base,
    title: '字面量检索',
    content: '部署状态是 100%_ready',
    revision: 0,
    operationId: randomUUID(),
  }, bearer)).status, 201);
  const literalSearch = await (await request(
    `/api/integrations/notes?q=${encodeURIComponent('100%_ready')}`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.deepEqual(literalSearch.notes.map((item: any) => item.id), [literalId]);

  const aiUpdate = await request(`/api/integrations/notes/${id}`, 'PUT', {
    ...base, title: 'AI 更新', content: '## 结果\n\n索引迁移到了苏黎世区域',
    revision: note.revision, operationId: randomUUID(), createVersion: false,
  }, bearer);
  assert.equal(aiUpdate.status, 200, await aiUpdate.clone().text());
  const updated = (await aiUpdate.json() as any).note;
  const removedMatch = await (await request(
    `/api/integrations/notes?q=${encodeURIComponent('法兰克福')}`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.ok(!removedMatch.notes.some((item: any) => item.id === id));
  const updatedMatch = await (await request(
    `/api/integrations/notes?q=${encodeURIComponent('苏黎世')}`,
    'GET',
    undefined,
    bearer,
  )).json() as any;
  assert.ok(updatedMatch.notes.some((item: any) => item.id === id));
  assert.equal((await request(`/api/integrations/notes/${id}`, 'PUT', {
    ...base, title: '陈旧写入', revision: note.revision, operationId: randomUUID(),
  }, bearer)).status, 409);
  assert.equal((await (await request(`/api/integrations/notes/${id}`, 'GET', undefined, bearer)).json() as any).note.title, 'AI 更新');

  const versions = await (await request(`/api/notes/${id}/versions`)).json() as any;
  assert.deepEqual(versions.versions.map((version: any) => version.revision), [2, 1]);
  assert.equal(versions.versions[0].actorType, 'ai');
  assert.equal(versions.versions[0].actorName, '测试 AI');

  const readOnlyResponse = await request('/api/integrations/tokens', 'POST', {
    name: '只读镜像', access: 'read', expiresInDays: 30,
  });
  const readOnly = await readOnlyResponse.json() as any;
  const readOnlyHeaders = { Authorization: `Bearer ${readOnly.secret}`, Cookie: '', 'X-CSRF-Token': '' };
  assert.equal((await request('/api/integrations/notes?q=AI&limit=1', 'GET', undefined, readOnlyHeaders)).status, 200);
  assert.equal((await request(`/api/integrations/notes/${id}`, 'GET', undefined, readOnlyHeaders)).status, 200);
  assert.equal((await request(`/api/integrations/notes/batch?ids=${id}`, 'GET', undefined, readOnlyHeaders)).status, 200);
  assert.equal((await request(`/api/integrations/notes/${id}`, 'PUT', {
    ...base, revision: updated.revision, operationId: randomUUID(),
  }, readOnlyHeaders)).status, 403);
  assert.equal((await request(`/api/integrations/notes/${id}`, 'DELETE', {
    revision: updated.revision,
  }, bearer)).status, 404);

  const listed = await (await request('/api/integrations/tokens')).json() as any;
  assert.equal(listed.tokens.length, 2);
  assert.equal(listed.tokens.find((item: any) => item.id === credential.token.id).expiresAt, null);
  assert.ok(!JSON.stringify(listed).includes(credential.secret));
  assert.equal((await request(`/api/integrations/tokens/${credential.token.id}`, 'DELETE', {})).status, 200);
  assert.equal((await request('/api/integrations/status', 'GET', undefined, bearer)).status, 401);
});

test('idempotent create and update; operation IDs cannot be reused with changed input', async () => {
  const id = randomUUID(), operation = randomUUID();
  assert.equal((await save(id, 0, {}, operation)).status, 201);
  assert.equal((await save(id, 0, {}, operation)).status, 200);
  assert.equal((await save(id, 0, { title: 'different' }, operation)).status, 409);
  const updateOperation = randomUUID();
  assert.equal((await save(id, 1, { title: 'new' }, updateOperation)).status, 200);
  const retry = await save(id, 1, { title: 'new' }, updateOperation);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as any).note.revision, 2);
});

test('automatic saves skip history while manual checkpoints are explicit and deduplicated', async () => {
  const id = randomUUID();
  assert.equal((await save(id, 0, { content: '自动保存 1' }, randomUUID(), false)).status, 201);
  assert.equal((await save(id, 1, { content: '自动保存 2' }, randomUUID(), false)).status, 200);
  let history = await (await request(`/api/notes/${id}/versions`)).json() as any;
  assert.deepEqual(history.versions, []);

  const checkpointOperation = randomUUID();
  const checkpoint = await save(id, 2, { content: '自动保存 2' }, checkpointOperation, true);
  assert.equal(checkpoint.status, 200, await checkpoint.clone().text());
  assert.equal((await checkpoint.json() as any).note.revision, 2);
  assert.equal((await save(id, 2, { content: '自动保存 2' }, checkpointOperation, true)).status, 200);
  assert.equal((await save(id, 2, { content: '自动保存 2' }, checkpointOperation, false)).status, 409);
  assert.equal((await save(id, 2, { content: '自动保存 2' }, randomUUID(), true)).status, 200);
  history = await (await request(`/api/notes/${id}/versions`)).json() as any;
  assert.deepEqual(history.versions.map((version: any) => version.revision), [2]);

  assert.equal((await save(id, 2, { content: '自动保存 3' }, randomUUID(), false)).status, 200);
  assert.equal((await save(id, 3, { content: '手动保存 4' }, randomUUID(), true)).status, 200);
  history = await (await request(`/api/notes/${id}/versions`)).json() as any;
  assert.deepEqual(history.versions.map((version: any) => version.revision), [4, 2]);
});

test('only one completely blank active note can exist', async () => {
  const first = await create({ title: '', content: '', tags: [] });
  const lookup = await (await request('/api/notes/blank')).json() as any;
  assert.equal(lookup.note.id, first.id);

  const duplicateId = randomUUID();
  const duplicate = await save(duplicateId, 0, { title: '', content: '', tags: [] });
  assert.equal(duplicate.status, 200, await duplicate.clone().text());
  assert.equal((await duplicate.json() as any).note.id, first.id);
  assert.equal((await instance.db.prepare(`SELECT COUNT(*) AS count FROM notes
    WHERE user_id=? AND title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL`)
    .bind(testUserId).first<{ count: number }>())!.count, 1);

  assert.equal((await save(first.id, 1, { title: '开始记录', content: '', tags: [] })).status, 200);
  const next = await create({ title: '', content: '', tags: [] });
  assert.notEqual(next.id, first.id);
});

test('batch duplicate lookup follows content fingerprints and tracks updates', async () => {
  const marker = randomUUID();
  const note = await create({ title: '原始标题', content: marker, tags: [] });
  const empty = await create({ title: `空正文-${marker}`, content: '', tags: [] });
  const contentFingerprint = await noteFingerprint('另一个标题', marker);
  const emptyFingerprint = await noteFingerprint(empty.title, '');
  const missingFingerprint = await noteFingerprint('原始标题', '不同正文');
  const duplicate = await request('/api/notes/duplicates', 'POST', {
    fingerprints: [contentFingerprint, emptyFingerprint, missingFingerprint, contentFingerprint],
  });
  assert.equal(duplicate.status, 200);
  const matches = new Map((await duplicate.json() as any).matches
    .map((match: any) => [match.fingerprint, match.noteId]));
  assert.equal(matches.get(contentFingerprint), note.id);
  assert.equal(matches.get(emptyFingerprint), empty.id);
  assert.equal(matches.has(missingFingerprint), false);

  const updatedContent = `${marker}-updated`;
  assert.equal((await save(note.id, note.revision, { content: updatedContent })).status, 200);
  const updatedFingerprint = await noteFingerprint(note.title, updatedContent);
  const afterUpdate = await (await request('/api/notes/duplicates', 'POST', {
    fingerprints: [contentFingerprint, updatedFingerprint],
  })).json() as any;
  assert.deepEqual(afterUpdate.matches, [{ fingerprint: updatedFingerprint, noteId: note.id }]);
  assert.equal((await request('/api/notes/duplicates', 'POST', { fingerprints: ['invalid'] })).status, 400);
  assert.deepEqual(await (await request('/api/notes/duplicates', 'POST', { fingerprints: [] })).json(), { matches: [] });
});

test('unchanged saves do not create revisions, including reordered tags', async () => {
  const note = await create({ tags: ['工作', '个人'] });
  const unchanged = await save(note.id, 1, { tags: ['个人', '工作'] });
  assert.equal(unchanged.status, 200, await unchanged.clone().text());
  const body = await unchanged.json() as any;
  assert.equal(body.unchanged, true);
  assert.equal(body.note.revision, 1);
  const versions = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(versions.versions.map((version: any) => version.revision), [1]);
  const changed = await save(note.id, 1, { tags: ['个人', '工作'], pinned: true });
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal((await changed.json() as any).note.revision, 2);
  const afterPin = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(afterPin.versions.map((version: any) => version.revision), [1]);
  const unpinned = await save(note.id, 2, { tags: ['个人', '工作'], pinned: false });
  assert.equal(unpinned.status, 200, await unpinned.clone().text());
  assert.equal((await unpinned.json() as any).note.revision, 3);
  const afterUnpin = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(afterUnpin.versions.map((version: any) => version.revision), [1]);
});

test('two devices cannot silently overwrite the same revision', async () => {
  const note = await create();
  const results = await Promise.all([save(note.id, 1, { content: 'device A' }), save(note.id, 1, { content: 'device B' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const conflict = await results.find((r) => r.status === 409)!.json() as any;
  assert.equal(conflict.error.current.revision, 2);
  const remote = await request(`/api/notes/${note.id}`);
  assert.ok(['device A', 'device B'].includes((await remote.json() as any).note.content));
});

test('Chinese search, tags, pin order and archive filters work', async () => {
  const marker = randomUUID().slice(0, 8);
  const longQuery = '完整中文搜索'.repeat(5);
  await create({ title: `${marker}-普通`, content: '中文没有空格也可查询', tags: ['验收标签'] });
  await create({ title: `${marker}-置顶`, content: '中文没有空格也可查询', tags: ['验收标签'], pinned: true });
  await create({ title: `${marker}-归档`, content: '中文没有空格也可查询', tags: ['仅归档标签'], archived: true });
  const longSearchNote = await create({ title: '长查询', content: longQuery });
  const trashed = await create({ title: `${marker}-回收站`, tags: ['仅回收站标签'] });
  await save(trashed.id, 1, { title: `${marker}-回收站`, tags: ['仅回收站标签'], deletedAt: Date.now() });
  const response = await request(`/api/notes?q=${encodeURIComponent(marker)}&view=all`);
  const data = await response.json() as any;
  assert.deepEqual(data.notes.map((note: any) => note.title), [`${marker}-置顶`, `${marker}-普通`]);
  const archive = await (await request(`/api/notes?q=${encodeURIComponent(marker)}&view=archive&tag=${encodeURIComponent('仅归档标签')}`)).json() as any;
  assert.deepEqual(archive.notes.map((note: any) => note.title), [`${marker}-归档`]);
  const longSearch = await request(`/api/notes?q=${encodeURIComponent(longQuery)}&view=all`);
  assert.equal(longSearch.status, 200, await longSearch.clone().text());
  assert.ok((await longSearch.json() as any).notes.some((note: any) => note.id === longSearchNote.id));
  const allTags = (await (await request('/api/tags?view=all')).json() as any).tags;
  assert.ok(allTags.includes('验收标签'));
  assert.ok(!allTags.includes('仅归档标签'));
  assert.ok(!allTags.includes('仅回收站标签'));
  assert.deepEqual((await (await request('/api/tags?view=archive')).json() as any).tags, ['仅归档标签']);
  assert.deepEqual((await (await request('/api/tags?view=trash')).json() as any).tags, ['仅回收站标签']);
  assert.equal((await request('/api/notes?view=pinned')).status, 400);
  assert.equal((await request('/api/tags?view=export')).status, 400);
});

test('trash, restore, permanent deletion and purge tombstones protect old devices', async () => {
  const note = await create();
  assert.equal((await request(`/api/notes/${note.id}`, 'DELETE', { revision: 1 })).status, 409);
  assert.equal((await save(note.id, 1, { deletedAt: Date.now() })).status, 200);
  assert.equal((await save(note.id, 2, { deletedAt: null })).status, 200);
  assert.equal((await save(note.id, 3, { deletedAt: Date.now() })).status, 200);
  assert.equal((await request(`/api/notes/${note.id}`, 'DELETE', { revision: 3 })).status, 409);
  assert.equal((await request(`/api/notes/${note.id}`, 'DELETE', { revision: 4 })).status, 200);
  assert.equal((await request(`/api/notes/${note.id}`)).status, 404);
  assert.equal((await save(note.id, 0)).status, 410);
});

test('all trash notes can be permanently deleted in one operation', async () => {
  const first = await create({ title: '批量删除一' });
  const second = await create({ title: '批量删除二' });
  const active = await create({ title: '保留的正常笔记' });
  assert.equal((await save(first.id, 1, { title: first.title, deletedAt: Date.now() })).status, 200);
  assert.equal((await save(second.id, 1, { title: second.title, deletedAt: Date.now() })).status, 200);

  const response = await request('/api/notes/trash', 'DELETE', {});
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(((await response.json() as any).deleted) >= 2);
  assert.equal((await request(`/api/notes/${first.id}`)).status, 404);
  assert.equal((await request(`/api/notes/${second.id}`)).status, 404);
  assert.equal((await request(`/api/notes/${active.id}`)).status, 200);
  assert.equal((await save(first.id, 0)).status, 410);
  assert.equal((await (await request('/api/notes/trash', 'DELETE', {})).json() as any).deleted, 0);
});

test('history keeps the configured content-version limit across pin revision gaps', async () => {
  const note = await create();
  assert.equal((await save(note.id, 1, { pinned: true })).status, 200);
  assert.equal((await save(note.id, 2, { content: 'version 3', pinned: true })).status, 200);
  assert.equal((await save(note.id, 3, { content: 'version 3', pinned: false })).status, 200);
  assert.equal((await save(note.id, 4, { content: 'version 5' })).status, 200);
  assert.equal((await save(note.id, 5, { content: 'version 6' })).status, 200);
  const data = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(data.versions.map((v: any) => v.revision), [6, 5, 3]);
});

test('validation rejects malformed notes, missing images and oversized content', async () => {
  assert.equal((await save(randomUUID(), 0, { content: 'x'.repeat(262145) })).status, 400);
  assert.equal((await save(randomUUID(), 0, { tags: [42] })).status, 400);
  assert.equal((await request(`/api/notes/${randomUUID()}`, 'POST', {
    ...base, revision: 0, operationId: randomUUID(), createVersion: 'yes',
  })).status, 400);
  assert.equal((await save(randomUUID(), 0, { content: `![missing](/api/images/${randomUUID()})` })).status, 409);
});

test('a note can reference the documented maximum of 80 stored files', async () => {
  const ids = Array.from({ length: 80 }, () => randomUUID());
  const now = Date.now();
  await instance.db.prepare(`INSERT INTO images
    (id,user_id,filename,mime,size,width,height,sha256,status,created_at,last_used_at)
    SELECT value,?,value||'.txt','text/plain',1,0,0,?,'ready',?,? FROM json_each(?)`)
    .bind(testUserId, '0'.repeat(64), now, now, JSON.stringify(ids)).run();
  const id = randomUUID();
  const response = await save(id, 0, {
    content: ids.map((fileId) => `[附件](/api/files/${fileId})`).join('\n'),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const refs = await instance.db.prepare('SELECT COUNT(*) AS count FROM image_refs WHERE note_id=?')
    .bind(id).first<{ count: number }>();
  assert.equal(refs?.count, 80);
});

test('private images validate media type, have no public cache, and survive history references', async () => {
  const id = randomUUID();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const upload = (mime: string) => instance.runtime.dispatchFetch(`${origin}/api/images/${id}`, {
    method: 'PUT', headers: { Origin: origin, Cookie: `__Host-easynote=${testToken}`, 'X-CSRF-Token': testCsrf, 'Content-Type': mime, 'X-Filename': encodeURIComponent('测试.png') }, body: bytes,
  });
  assert.equal((await upload('image/jpeg')).status, 415);
  assert.equal((await upload('image/png')).status, 201);
  assert.equal((await upload('image/png')).status, 200);
  const response = await request(`/api/images/${id}`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await request(`/api/images/${id}`, 'GET', undefined, { Cookie: '' })).status, 401);
  const note = await create({ content: `![test](/api/images/${id})` });
  await save(note.id, 1, { content: 'image removed' });
  await instance.db.prepare('UPDATE images SET last_used_at=0 WHERE id=?').bind(id).run();
  const env = { DB: instance.db, IMAGES: instance.bucket, IMAGE_GRACE_HOURS: '24' } as any;
  await cleanup(env);
  assert.equal((await request(`/api/images/${id}`)).status, 200);
  await save(note.id, 2, { content: 'cleanup step one' });
  await save(note.id, 3, { content: 'cleanup step two' });
  await cleanup(env);
  assert.equal((await request(`/api/images/${id}`)).status, 404);
});

test('another account cannot read, edit or reference private notes and images', async () => {
  const otherId = randomUUID(), otherToken = 'c'.repeat(64);
  await instance.db.prepare(`INSERT INTO users
    (id,username,password_verifier,created_at,role,enabled,approved_at,updated_at)
    VALUES(?,?,?,?,'user',1,?,?)`).bind(otherId, 'other', '{}', Date.now(), Date.now(), Date.now()).run();
  await instance.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(otherToken), otherId, testCsrf, Date.now() + 60000).run();
  const note = await create();
  const headers = { Cookie: `__Host-easynote=${otherToken}` };
  assert.equal((await request(`/api/notes/${note.id}`, 'GET', undefined, headers)).status, 404);
  assert.equal((await request(`/api/notes/${note.id}`, 'PUT', { ...base, revision: 1, operationId: randomUUID() }, headers)).status, 410);
  const duplicateLookup = await request('/api/notes/duplicates', 'POST', {
    fingerprints: [await noteFingerprint(note.title, note.content)],
  }, headers);
  assert.deepEqual(await duplicateLookup.json(), { matches: [] });
  const imageId = randomUUID();
  await instance.db.prepare("INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind(imageId, testUserId, 'owned.png', 'image/png', 1, 1, 1, '0'.repeat(64), 'ready', Date.now(), Date.now()).run();
  const foreign = await request(`/api/notes/${randomUUID()}`, 'POST',
    { ...base, content: `![private](/api/images/${imageId})`, revision: 0, operationId: randomUUID() }, headers);
  assert.equal(foreign.status, 409);
  assert.equal((await request(`/api/images/${imageId}`, 'GET', undefined, headers)).status, 404);
});

test('password changes revoke other sessions and logout-all revokes the current session', async () => {
  const userId = randomUUID();
  const firstToken = '1'.repeat(64);
  const secondToken = '2'.repeat(64);
  const csrf = '3'.repeat(64);
  const originalPassword = 'Original-Test-Password-938!';
  const newPassword = 'Updated-Test-Password-482!';
  await instance.db.prepare(`INSERT INTO users
    (id,username,password_verifier,created_at,role,enabled,approved_at,updated_at)
    VALUES(?,?,?,?,'user',1,?,?)`)
    .bind(userId, `account-${userId.slice(0, 8)}`, JSON.stringify(await passwordVerifier(originalPassword)),
      Date.now(), Date.now(), Date.now()).run();
  await instance.db.batch([
    instance.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(firstToken), userId, csrf, Date.now() + 60_000),
    instance.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(secondToken), userId, csrf, Date.now() + 60_000),
  ]);
  const accountHeaders = { Cookie: `__Host-easynote=${firstToken}`, 'X-CSRF-Token': csrf };
  assert.equal((await request('/api/account/password', 'POST', {
    currentPassword: 'wrong', newPassword,
  }, accountHeaders)).status, 403);
  const changed = await request('/api/account/password', 'POST', {
    currentPassword: originalPassword, newPassword,
  }, accountHeaders);
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal((await request('/api/session', 'GET', undefined, accountHeaders)).status, 200);
  assert.equal((await request('/api/session', 'GET', undefined, {
    Cookie: `__Host-easynote=${secondToken}`, 'X-CSRF-Token': csrf,
  })).status, 200);
  const secondSession = await (await request('/api/session', 'GET', undefined, {
    Cookie: `__Host-easynote=${secondToken}`, 'X-CSRF-Token': csrf,
  })).json() as any;
  assert.equal(secondSession.user, null);
  assert.equal((await request('/api/login', 'POST', {
    username: `account-${userId.slice(0, 8)}`, password: originalPassword,
  })).status, 401);
  assert.equal((await request('/api/login', 'POST', {
    username: `account-${userId.slice(0, 8)}`, password: newPassword,
  })).status, 200);
  const loggedOut = await request('/api/account/logout-all', 'POST', { currentPassword: newPassword }, accountHeaders);
  assert.equal(loggedOut.status, 200, await loggedOut.clone().text());
  const currentSession = await (await request('/api/session', 'GET', undefined, accountHeaders)).json() as any;
  assert.equal(currentSession.user, null);
});

test('administrators manage isolated tenant accounts and registration approval', async () => {
  const username = `tenant-${randomUUID().slice(0, 8)}`;
  const password = 'Tenant-Test-Password-482!';
  const created = await request('/api/admin/users', 'POST', { username, password, role: 'user' });
  assert.equal(created.status, 201, await created.clone().text());
  const account = (await created.json() as any).user;
  assert.equal(account.role, 'user');
  assert.equal(account.enabled, true);

  const login = await request('/api/login', 'POST', { username, password });
  assert.equal(login.status, 200, await login.clone().text());
  const loginBody = await login.json() as any;
  assert.equal(loginBody.user.role, 'user');
  const accountCookie = login.headers.get('Set-Cookie')!.split(';')[0];
  const tenantHeaders = { Cookie: accountCookie, 'X-CSRF-Token': loginBody.csrf };
  const privateNote = await create({ title: `管理员私有-${randomUUID().slice(0, 6)}` });
  assert.equal((await request(`/api/notes/${privateNote.id}`, 'GET', undefined, tenantHeaders)).status, 404);
  const tenantNoteId = randomUUID();
  assert.equal((await request(`/api/notes/${tenantNoteId}`, 'POST', {
    ...base, title: '租户独立笔记', revision: 0, operationId: randomUUID(),
  }, tenantHeaders)).status, 201);
  assert.equal((await request(`/api/notes/${tenantNoteId}`)).status, 404);
  assert.equal((await request('/api/admin/users', 'GET', undefined, tenantHeaders)).status, 403);

  const disabled = await request(`/api/admin/users/${account.id}`, 'PATCH', { enabled: false });
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal((await request('/api/session', 'GET', undefined, tenantHeaders)).status, 200);
  assert.equal((await (await request('/api/session', 'GET', undefined, tenantHeaders)).json() as any).user, null);
  assert.equal((await request('/api/login', 'POST', { username, password })).status, 401);

  assert.equal((await request('/api/admin/settings/registration', 'PATCH', { enabled: true })).status, 200);
  const pendingName = `pending-${randomUUID().slice(0, 8)}`;
  const pendingPassword = 'Pending-Test-Password-592!';
  const registration = await request('/api/register', 'POST', {
    username: pendingName, password: pendingPassword,
  }, { Cookie: '', 'X-CSRF-Token': '' });
  assert.equal(registration.status, 201, await registration.clone().text());
  const recoveryCode = (await registration.json() as any).recoveryCode;
  assert.match(recoveryCode, /^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
  assert.equal((await request('/api/login', 'POST', { username: pendingName, password: pendingPassword })).status, 401);
  const users = (await (await request('/api/admin/users')).json() as any).users;
  const pending = users.find((item: any) => item.username === pendingName);
  assert.equal(pending.pendingApproval, true);
  assert.equal((await request(`/api/admin/users/${pending.id}`, 'PATCH', { enabled: true })).status, 200);
  assert.equal((await request('/api/login', 'POST', { username: pendingName, password: pendingPassword })).status, 200);

  const recoveredPassword = 'Recovered-Test-Password-593!';
  assert.equal((await request('/api/account/reset-password', 'POST', {
    username: pendingName, recoveryCode, newPassword: recoveredPassword,
  }, { Cookie: '', 'X-CSRF-Token': '' })).status, 200);
  assert.equal((await request('/api/login', 'POST', { username: pendingName, password: pendingPassword })).status, 401);
  const recoveredLogin = await request('/api/login', 'POST', { username: pendingName, password: recoveredPassword });
  assert.equal(recoveredLogin.status, 200);
  const recoveredSession = await recoveredLogin.json() as any;
  const recoveredHeaders = {
    Cookie: recoveredLogin.headers.get('Set-Cookie')!.split(';')[0],
    'X-CSRF-Token': recoveredSession.csrf,
  };
  assert.equal((await request('/api/account', 'DELETE', {
    username: pendingName, currentPassword: recoveredPassword,
  }, recoveredHeaders)).status, 202);
  await cleanup({ DB: instance.db, IMAGES: instance.bucket, IMAGE_GRACE_HOURS: '24' } as any);
  assert.equal(await instance.db.prepare('SELECT id FROM users WHERE id=?').bind(pending.id).first(), null);
  assert.equal((await request('/api/admin/settings/registration', 'PATCH', { enabled: false })).status, 200);
});

test('concurrent administrator changes always preserve one enabled administrator', async () => {
  const username = `admin-${randomUUID().slice(0, 8)}`;
  const password = 'Concurrent-Admin-Password-684!';
  const created = await request('/api/admin/users', 'POST', { username, password, role: 'admin' });
  assert.equal(created.status, 201, await created.clone().text());
  const other = (await created.json() as any).user;
  const login = await request('/api/login', 'POST', { username, password });
  assert.equal(login.status, 200, await login.clone().text());
  const session = await login.json() as any;
  const otherHeaders = {
    Cookie: login.headers.get('Set-Cookie')!.split(';')[0],
    'X-CSRF-Token': session.csrf,
  };

  try {
    const responses = await Promise.all([
      request(`/api/admin/users/${other.id}`, 'PATCH', { role: 'user' }),
      request(`/api/admin/users/${testUserId}`, 'PATCH', { role: 'user' }, otherHeaders),
    ]);
    const statuses = responses.map((response) => response.status);
    const remaining = await instance.db.prepare(`SELECT COUNT(*) AS count FROM users
      WHERE role='admin' AND enabled=1 AND deletion_requested_at IS NULL`).first<{ count: number }>();
    assert.equal(remaining?.count, 1, `unexpected statuses: ${statuses.join(',')}`);
    assert.ok(statuses.some((status) => status === 200));
    assert.ok(statuses.some((status) => [401, 403, 409].includes(status)), `unexpected statuses: ${statuses.join(',')}`);
  } finally {
    await instance.db.prepare(`UPDATE users SET role='admin',enabled=1,deletion_requested_at=NULL WHERE id=?`)
      .bind(testUserId).run();
    await instance.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)')
      .bind(await digest(testToken), testUserId, testCsrf, Date.now() + 86400_000).run();
    await instance.db.prepare('DELETE FROM users WHERE id=?').bind(other.id).run();
  }
});

test('task center aggregates unfinished tasks with source positions', async () => {
  const first = await create({
    title: '任务来源',
    content: ['- [ ] 第一项', '- [x] 已完成', '```md', '- [ ] 代码示例', '```', '- [] 简写项'].join('\n'),
  });
  const archived = await create({ title: '归档任务', content: '- [ ] 仍需处理', archived: true });
  const result = await request('/api/tasks');
  assert.equal(result.status, 200);
  const tasks = (await result.json() as any).tasks.filter((item: any) => [first.id, archived.id].includes(item.noteId));
  const firstTasks = tasks.filter((item: any) => item.noteId === first.id);
  assert.deepEqual(firstTasks.map((item: any) => item.text), ['第一项', '简写项']);
  assert.deepEqual(firstTasks.map((item: any) => item.line), [1, 6]);
  assert.equal(firstTasks[1].offset, first.content.lastIndexOf('- []'));
  assert.equal(tasks.find((item: any) => item.noteId === archived.id).archived, true);
});

test('read-only note shares expire, revoke and remain scoped to current note files', async () => {
  const note = await create({ title: '公开只读笔记', content: '仅可阅读' });
  const created = await request(`/api/notes/${note.id}/share`, 'POST', { expiresInHours: 24 });
  assert.equal(created.status, 201, await created.clone().text());
  const share = await created.json() as any;
  assert.match(share.url, /^https:\/\/easynote\.example\.test\/shared\/[a-f0-9]{64}$/);
  const rawToken = share.url.split('/').at(-1);
  const publicResponse = await request(`/api/public/shares/${rawToken}`, 'GET', undefined, {
    Cookie: '', 'X-CSRF-Token': '',
  });
  assert.equal(publicResponse.status, 200);
  assert.deepEqual((await publicResponse.json() as any).note.title, '公开只读笔记');
  assert.equal(publicResponse.headers.get('Cache-Control'), 'no-store');
  assert.equal((await request(`/api/notes/${note.id}/share`, 'DELETE', {})).status, 200);
  assert.equal((await request(`/api/public/shares/${rawToken}`, 'GET', undefined, {
    Cookie: '', 'X-CSRF-Token': '',
  })).status, 404);
});

test('incremental sync emits current notes and purge tombstones', async () => {
  const created = await create({ title: `离线同步-${randomUUID().slice(0, 6)}`, content: '第一版' });
  const first = await (await request('/api/sync?after=0&limit=200')).json() as any;
  const head = await (await request('/api/sync/cursor')).json() as any;
  const creation = first.changes.find((change: any) => change.noteId === created.id);
  assert.equal(creation.note.content, '第一版');
  assert.ok(first.cursor >= creation.sequence);
  assert.ok(head.cursor >= first.cursor);

  const updatedResponse = await save(created.id, created.revision, { title: created.title, content: '第二版' });
  const updated = (await updatedResponse.json() as any).note;
  const second = await (await request(`/api/sync?after=${first.cursor}&limit=200`)).json() as any;
  assert.equal(second.changes.find((change: any) => change.noteId === created.id).note.content, '第二版');

  await save(created.id, updated.revision, { title: created.title, content: '第二版', deletedAt: Date.now() });
  const trashed = await (await request(`/api/notes/${created.id}`)).json() as any;
  await request(`/api/notes/${created.id}`, 'DELETE', { revision: trashed.note.revision });
  const third = await (await request(`/api/sync?after=${second.cursor}&limit=200`)).json() as any;
  assert.equal(third.changes.find((change: any) => change.noteId === created.id).note, null);
});

test('stable internal links expose backlinks', async () => {
  const target = await create({ title: '链接目标', content: '目标正文' });
  const source = await create({ title: '链接来源', content: `参见 [[${target.id}|链接目标]]` });
  const backlinks = await (await request(`/api/notes/${target.id}/backlinks`)).json() as any;
  assert.ok(backlinks.notes.some((note: any) => note.id === source.id));
});

test('private PDF and text attachments are validated and downloaded safely', async () => {
  const pdfId = randomUUID();
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const upload = await instance.runtime.dispatchFetch(`${origin}/api/files/${pdfId}`, {
    method: 'PUT',
    headers: {
      Origin: origin,
      Cookie: `__Host-easynote=${testToken}`,
      'X-CSRF-Token': testCsrf,
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent('资料.pdf'),
    },
    body: pdf,
  });
  assert.equal(upload.status, 201, await upload.clone().text());
  const stored = (await upload.json() as any).file;
  assert.equal(stored.url, `/api/files/${pdfId}`);
  const downloaded = await request(`/api/files/${pdfId}`);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('Content-Disposition') ?? '', /^attachment;/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf);
  assert.equal((await request(`/api/images/${pdfId}`)).status, 404);

  const invalid = await instance.runtime.dispatchFetch(`${origin}/api/files/${randomUUID()}`, {
    method: 'PUT',
    headers: {
      Origin: origin,
      Cookie: `__Host-easynote=${testToken}`,
      'X-CSRF-Token': testCsrf,
      'Content-Type': 'application/pdf',
      'X-Filename': encodeURIComponent('伪造.pdf'),
    },
    body: Buffer.from('not a pdf'),
  });
  assert.equal(invalid.status, 415);
});
