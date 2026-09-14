import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRuntime, testCsrf, testToken, testUserId, testPassword } from './runtime';
import { digest } from '../src/worker/core';
import { cleanup } from '../src/worker/images';

let instance: Awaited<ReturnType<typeof createRuntime>>;
const origin = 'https://easynote.example.test';
const base = { title: '测试笔记', content: '中文搜索与图片', tags: ['工作'], pinned: false, deletedAt: null };
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
  assert.equal((await request('/api/logout', 'POST', {}, { Cookie: cookie.split(';')[0], 'X-CSRF-Token': data.csrf })).status, 200);
  assert.equal((await request('/api/notes', 'GET', undefined, { Cookie: cookie.split(';')[0] })).status, 401);
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

test('two devices cannot silently overwrite the same revision', async () => {
  const note = await create();
  const results = await Promise.all([save(note.id, 1, { content: 'device A' }), save(note.id, 1, { content: 'device B' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const conflict = await results.find((r) => r.status === 409)!.json() as any;
  assert.equal(conflict.error.current.revision, 2);
  const remote = await request(`/api/notes/${note.id}`);
  assert.ok(['device A', 'device B'].includes((await remote.json() as any).note.content));
});

test('Chinese substring search, tags and pin filters work', async () => {
  await create({ title: '搜索唯一标题', content: '中文没有空格也可查询', tags: ['验收标签'], pinned: true });
  const response = await request(`/api/notes?q=${encodeURIComponent('没有空格')}&tag=${encodeURIComponent('验收标签')}&view=pinned`);
  const data = await response.json() as any;
  assert.equal(data.notes.length, 1);
  assert.equal(data.notes[0].title, '搜索唯一标题');
  assert.ok((await (await request('/api/tags')).json() as any).tags.includes('验收标签'));
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

test('history records versions and keeps the configured limit', async () => {
  const note = await create();
  for (let revision = 1; revision <= 5; revision++) {
    assert.equal((await save(note.id, revision, { content: `version ${revision + 1}` })).status, 200);
  }
  const data = await (await request(`/api/notes/${note.id}/versions`)).json() as any;
  assert.deepEqual(data.versions.map((v: any) => v.revision), [6, 5, 4]);
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
  await save(note.id, 2); await save(note.id, 3);
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
