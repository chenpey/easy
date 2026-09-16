import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRuntime, testCsrf, testToken, testUserId, testPassword } from './runtime';
import { digest } from '../src/worker/core';
import { cleanup } from '../src/worker/images';
import { passwordVerifier } from '../src/worker/auth';

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
async function save(id: string, revision = 0, patch: Record<string, unknown> = {}, operationId = randomUUID()) {
  return request(`/api/notes/${id}`, revision ? 'PUT' : 'POST', { ...base, ...patch, revision, operationId });
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
  const aiCreate = await request(`/api/integrations/notes/${id}`, 'POST', {
    ...base, title: 'AI 创建', content: '## 影响\n\n法兰克福 AI 上下文', revision: 0, operationId: randomUUID(),
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
    ...base, title: 'AI 更新', content: '## 结果\n\n索引迁移到了苏黎世区域', revision: note.revision, operationId: randomUUID(),
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

test('import duplicate checks use exact content and deduplicate blank notes', async () => {
  await create({ title: '原始标题', content: '完全相同的正文', tags: [] });
  const duplicate = await request('/api/notes/duplicate', 'POST', { title: '另一个标题', content: '完全相同的正文' });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json() as any).duplicate, true);
  assert.equal((await (await request('/api/notes/duplicate', 'POST', {
    title: '原始标题', content: '不同正文',
  })).json() as any).duplicate, false);
  assert.equal((await (await request('/api/notes/duplicate', 'POST', {
    title: '', content: '',
  })).json() as any).duplicate, true);
  assert.equal((await request('/api/notes/duplicate', 'POST', { title: '', content: 42 })).status, 400);
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

test('history collapses consecutive revisions that differ only by pin state', async () => {
  const note = await create({ content: 'legacy duplicate' });
  await instance.db.prepare(`INSERT INTO note_versions
    (note_id,revision,title,content,tags,pinned,deleted_at,saved_at,archived)
    SELECT note_id, 2, title, content, tags, CASE pinned WHEN 1 THEN 0 ELSE 1 END, deleted_at, saved_at + 1, archived
    FROM note_versions WHERE note_id=? AND revision=1`).bind(note.id).run();
  const data = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(data.versions.map((version: any) => version.revision), [2]);
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
  await create({ title: `${marker}-普通`, content: '中文没有空格也可查询', tags: ['验收标签'] });
  await create({ title: `${marker}-置顶`, content: '中文没有空格也可查询', tags: ['验收标签'], pinned: true });
  await create({ title: `${marker}-归档`, content: '中文没有空格也可查询', tags: ['仅归档标签'], archived: true });
  const trashed = await create({ title: `${marker}-回收站`, tags: ['仅回收站标签'] });
  await save(trashed.id, 1, { title: `${marker}-回收站`, tags: ['仅回收站标签'], deletedAt: Date.now() });
  const response = await request(`/api/notes?q=${encodeURIComponent(marker)}&view=all`);
  const data = await response.json() as any;
  assert.deepEqual(data.notes.map((note: any) => note.title), [`${marker}-置顶`, `${marker}-普通`]);
  const archive = await (await request(`/api/notes?q=${encodeURIComponent(marker)}&view=archive&tag=${encodeURIComponent('仅归档标签')}`)).json() as any;
  assert.deepEqual(archive.notes.map((note: any) => note.title), [`${marker}-归档`]);
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
  assert.equal((await save(randomUUID(), 0, { content: `![missing](/api/images/${randomUUID()})` })).status, 409);
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
  await instance.db.prepare('INSERT INTO users VALUES(?,?,?,?)').bind(otherId, 'other', '{}', Date.now()).run();
  await instance.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(otherToken), otherId, testCsrf, Date.now() + 60000).run();
  const note = await create();
  const headers = { Cookie: `__Host-easynote=${otherToken}` };
  assert.equal((await request(`/api/notes/${note.id}`, 'GET', undefined, headers)).status, 404);
  assert.equal((await request(`/api/notes/${note.id}`, 'PUT', { ...base, revision: 1, operationId: randomUUID() }, headers)).status, 410);
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
  await instance.db.prepare('INSERT INTO users VALUES(?,?,?,?)')
    .bind(userId, `account-${userId.slice(0, 8)}`, JSON.stringify(await passwordVerifier(originalPassword)), Date.now()).run();
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

test('incremental sync emits current notes and purge tombstones', async () => {
  const created = await create({ title: `离线同步-${randomUUID().slice(0, 6)}`, content: '第一版' });
  const first = await (await request('/api/sync?after=0&limit=200')).json() as any;
  const creation = first.changes.find((change: any) => change.noteId === created.id);
  assert.equal(creation.note.content, '第一版');
  assert.ok(first.cursor >= creation.sequence);

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
