import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { testToken, testCsrf, testPassword } from './runtime';

const origin = 'http://127.0.0.1:8792';
const headers = { Origin: origin, 'X-CSRF-Token': testCsrf };
test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'easynote_dev', value: testToken, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
});
async function newNote(page: Page, title: string, content = '') {
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill(title);
  await page.getByRole('textbox', { name: '笔记正文' }).fill(content);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
}

test('PWA metadata, install action, app-shell cache and API exclusion work', async ({ page, context }) => {
  await page.goto('/');
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['content-type']).toContain('manifest+json');
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: 'EasyNote', start_url: '/', scope: '/', display: 'standalone',
    theme_color: '#3361cc', background_color: '#ffffff',
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: '192x192', type: 'image/png' }),
    expect.objectContaining({ sizes: '512x512', type: 'image/png' }),
    expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
  ]));
  for (const path of ['/pwa-192x192.png', '/pwa-512x512.png', '/pwa-maskable-512x512.png', '/apple-touch-icon.png']) {
    const icon = await page.request.get(path);
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toContain('image/png');
  }
  const worker = await page.request.get('/sw.js');
  expect(worker.status()).toBe(200);
  expect(worker.headers()['content-type']).toContain('javascript');
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration('/')))).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cachedUrls = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
  expect(cachedUrls.some((url) => new URL(url).pathname === '/index.html')).toBe(true);
  expect(cachedUrls.some((url) => new URL(url).pathname.includes('/assets/html2canvas'))).toBe(true);
  expect(cachedUrls.some((url) => new URL(url).pathname.includes('/assets/jspdf'))).toBe(true);
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);

  await page.evaluate(() => {
    const state = window as typeof window & { installPrompted?: boolean };
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt(): Promise<void>;
      userChoice: Promise<{ outcome: 'accepted'; platform: string }>;
    };
    event.prompt = async () => { state.installPrompted = true; };
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(event);
  });
  await page.locator('.account').click();
  await page.getByRole('button', { name: '安装 EasyNote' }).click();
  expect(await page.evaluate(() => (window as typeof window & { installPrompted?: boolean }).installPrompted)).toBe(true);
  await expect(page.getByRole('button', { name: '安装 EasyNote' })).toBeHidden();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'EasyNote' })).toBeVisible();
  await context.setOffline(false);
});

test('an external PWA launch restores the session through the same-origin bootstrap request', async ({ page }) => {
  await page.route('https://launcher.example.test/', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<a href="${origin}/">Open EasyNote</a>`,
  }));
  await page.goto('https://launcher.example.test/');
  await page.getByRole('link', { name: 'Open EasyNote' }).click();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator('.account')).toContainText('tester');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeHidden();
});

test('AI integration tokens can be created once, listed and revoked', async ({ page }) => {
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByLabel('名称').fill('桌面 AI');
  await page.getByLabel('有效期').selectOption('permanent');
  await page.getByRole('button', { name: '创建令牌' }).click();
  await expect(page.getByText('令牌仅显示一次')).toBeVisible();
  await expect(page.locator('.token-secret code')).toHaveText(/^enai_[a-f0-9]{64}$/);
  await expect(page.getByText('桌面 AI', { exact: true })).toBeVisible();
  await expect(page.getByText('读取和写入 · 永久有效', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-ai-access.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-ai-access.png', fullPage: true });
  await page.getByRole('button', { name: '撤销令牌 桌面 AI' }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByText('桌面 AI', { exact: true })).toBeHidden();
});

test('create, autosave, reload, edit Markdown and preview safely', async ({ page }) => {
  const title = `读书记录-${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/easynote-icon.svg');
  const icon = await page.request.get('/easynote-icon.svg');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/svg+xml');
  await newNote(page, title, '# 本周阅读\n\n记录一些值得留下的想法。\n\n- 保持简单\n- 定期整理\n\n<script>alert(1)</script>');
  await page.getByRole('button', { name: '立即同步', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已同步，内容为最新');
  const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
  const history = await (await page.request.get(`/api/notes/${listed.notes[0].id}/versions`)).json();
  expect(history.versions).toHaveLength(1);
  await page.reload();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('本周阅读');
  await page.getByRole('button', { name: '预览模式' }).click();
  await expect(page.getByRole('heading', { name: '本周阅读' })).toBeVisible();
  await expect(page.locator('.markdown script')).toHaveCount(0);
  const documentLayout = () => page.locator('.document').evaluate((element) => {
    const container = element.parentElement!;
    const style = getComputedStyle(container);
    const availableWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const documentBox = element.getBoundingClientRect();
    const containerBox = container.getBoundingClientRect();
    return {
      availableWidth,
      leftGap: documentBox.left - containerBox.left - parseFloat(style.paddingLeft),
      width: documentBox.width,
      widthRatio: documentBox.width / availableWidth,
    };
  });
  const mediumLayout = await documentLayout();
  expect(Math.abs(mediumLayout.leftGap)).toBeLessThanOrEqual(1);
  expect(mediumLayout.widthRatio).toBeCloseTo(1, 2);
  await page.setViewportSize({ width: 2000, height: 960 });
  const readableLayout = await documentLayout();
  expect(Math.abs(readableLayout.leftGap)).toBeLessThanOrEqual(1);
  expect(readableLayout.width).toBeCloseTo(900, 0);
  await page.getByRole('button', { name: '使用宽屏' }).click();
  await expect(page.getByRole('button', { name: '使用阅读宽度' })).toHaveAttribute('aria-pressed', 'true');
  const wideLayout = await documentLayout();
  expect(wideLayout.width).toBeCloseTo(1080, 0);
  expect(await page.evaluate(() => localStorage.getItem('easynote-document-width'))).toBe('wide');
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('footnotes, lazy code highlighting and precise source switching work', async ({ page }) => {
  const content = [
    '## 起点',
    '',
    '开头段落。',
    '',
    '```javascript',
    'const answer = 42;',
    '```',
    '',
    '## 目标',
    '',
    '精准目标段落[^detail]',
    '',
    '[^detail]: 脚注正文。',
  ].join('\n');
  await page.goto('/');
  await newNote(page, `阅读增强-${randomUUID().slice(0, 6)}`, content);
  await page.getByRole('button', { name: '预览模式' }).click();

  const preview = page.locator('.document .markdown');
  await expect(preview.locator('a[data-footnote-ref="1"]')).toHaveText('[1]');
  await expect(preview.locator('[data-footnote-id="1"]')).toContainText('脚注正文。');
  await expect(preview.locator('code[data-code-language="javascript"] .hljs-keyword')).toHaveText('const');
  await expect(preview.locator('code[data-code-language="javascript"] .hljs-number')).toHaveText('42');

  await preview.locator('p[data-source-line]').filter({ hasText: '精准目标段落' }).dblclick();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toBeFocused();
  await page.keyboard.type('定位：');
  await expect.poll(() => editor.locator('.cm-line').allTextContents())
    .toContain('定位：精准目标段落[^detail]');

  await page.keyboard.press('Control+e');
  await expect(page.getByRole('button', { name: '预览模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Control+e');
  await expect(editor).toBeFocused();
  await page.keyboard.type('继续');
  await expect.poll(() => editor.locator('.cm-line').allTextContents())
    .toContain('定位：继续精准目标段落[^detail]');
});

test('restoring a content version preserves the current pin state', async ({ page }) => {
  const id = randomUUID();
  const title = `版本置顶-${id.slice(0, 6)}`;
  const created = await page.request.post(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: '旧正文', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const updated = await page.request.put(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: '新正文', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 1, operationId: randomUUID(),
    },
  });
  expect(updated.status()).toBe(200);
  const pinned = await page.request.put(`${origin}/api/notes/${id}`, {
    headers,
    data: {
      title, content: '新正文', tags: [], pinned: true, archived: false,
      deletedAt: null, revision: 2, operationId: randomUUID(),
    },
  });
  expect(pinned.status()).toBe(200);

  await page.goto('/');
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('button', { name: '取消置顶' })).toBeVisible();
  await page.getByRole('button', { name: '历史版本' }).click();
  const history = page.getByRole('dialog');
  await expect(history.getByText('修订 3', { exact: false })).toBeHidden();
  await history.getByRole('button').filter({ hasText: '修订 1' }).click();
  await history.getByRole('button', { name: '恢复此版本' }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`${origin}/api/notes/${id}`);
    return (await response.json()).note;
  }).toMatchObject({ content: '旧正文', pinned: true, revision: 4 });
});

test('Mermaid flowcharts, mindmaps and sanitized HTML blocks render safely', async ({ page }) => {
  let externalRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'example.com') externalRequests++;
  });
  const example = await readFile(new URL('../examples/mermaid-html-demo.md', import.meta.url), 'utf8');
  const unsafeHtml = [
    '<section style="position:fixed" onclick="window.htmlBlockExecuted=true">',
    '  <h2>安全清洗测试</h2>',
    '  <a href="javascript:alert(1)">危险链接</a>',
    '  <img src="https://example.com/tracker.png" onerror="window.htmlBlockExecuted=true">',
    '  <script>window.htmlBlockExecuted=true</script>',
    '</section>',
  ].join('\n');
  const styledDiagram = [
    '```mermaid',
    'graph TD',
    '  subgraph people[个人及出资方]',
    '    founder([Founder])',
    '  end',
    '  subgraph company[企业架构]',
    '    operator[有限责任公司]',
    '    pool{有限合伙企业}',
    '  end',
    '  founder ==>|出资| pool',
    '  operator -.->|管理| pool',
    '  classDef company fill:#e1f5fe,stroke:#01579b,stroke-width:2px',
    '  classDef pool fill:#ffecb3,stroke:#ff8f00,stroke-width:2px',
    '  class operator company',
    '  class pool pool',
    '```',
  ].join('\n');
  const shapedMindmap = [
    '```mermaid',
    'mindmap',
    '  root((Root))',
    '    square[Square]',
    '    rounded(Rounded)',
    '    circle((Circle))',
    '    bang))Bang((',
    '    cloud)Cloud(',
    '    hexagon{{Hexagon}}',
    '```',
  ].join('\n');
  const content = `${example}\n\n${styledDiagram}\n\n${shapedMindmap}\n\n${unsafeHtml}`;
  await page.goto('/');
  await newNote(page, `图表与HTML-${randomUUID().slice(0, 6)}`, content);
  await page.getByRole('button', { name: '预览模式' }).click();

  const diagrams = page.locator('.mermaid-diagram svg');
  await expect(diagrams).toHaveCount(4, { timeout: 15000 });
  const sizes = await diagrams.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height, nodes: element.querySelectorAll('path, rect, circle, text').length };
  }));
  expect(sizes.every((size) => size.width > 80 && size.height > 40 && size.nodes > 2)).toBe(true);
  const scrollMetrics = await page.locator('.mermaid-diagram').evaluateAll((elements) =>
    elements.map((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      svgWidth: element.querySelector('svg')!.getBoundingClientRect().width,
      viewBoxWidth: element.querySelector('svg')!.viewBox.baseVal.width,
    }))
  );
  expect(scrollMetrics.every(({ clientWidth, scrollWidth, svgWidth, viewBoxWidth }) =>
    scrollWidth <= clientWidth + 1
    && Math.abs(svgWidth - Math.min(clientWidth, Math.ceil(viewBoxWidth))) <= 1
  )).toBe(true);
  const mindmapRootAlignment = await diagrams.nth(1).evaluate((svg) => {
    const rootNode = svg.querySelector<SVGGElement>('.mindmap-node.section-root');
    const label = rootNode?.querySelector<SVGGraphicsElement>('text');
    const root = rootNode?.querySelector<SVGGraphicsElement>('.label-container');
    if (!label || !root) return null;
    const labelBox = label.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    return {
      x: Math.abs(labelBox.x + labelBox.width / 2 - (rootBox.x + rootBox.width / 2)),
      y: Math.abs(labelBox.y + labelBox.height / 2 - (rootBox.y + rootBox.height / 2)),
    };
  });
  expect(mindmapRootAlignment).not.toBeNull();
  expect(mindmapRootAlignment!.x).toBeLessThanOrEqual(2);
  expect(mindmapRootAlignment!.y).toBeLessThanOrEqual(2);
  const mindmapLeafAlignments = await diagrams.nth(1).evaluate((svg) =>
    ['Markdown', 'HTML Block'].map((text) => {
      const label = [...svg.querySelectorAll<SVGGraphicsElement>('.mindmap-node text')]
        .find((element) => element.textContent?.trim() === text);
      const node = label?.closest<SVGGElement>('.mindmap-node');
      const shape = node?.querySelector<SVGGraphicsElement>('.node-bkg, .label-container');
      if (!label || !shape) return null;
      const labelBox = label.getBoundingClientRect();
      const shapeBox = shape.getBoundingClientRect();
      return Math.abs(labelBox.x + labelBox.width / 2 - (shapeBox.x + shapeBox.width / 2));
    })
  );
  expect(mindmapLeafAlignments.every((offset) => offset !== null && offset <= 2)).toBe(true);
  const shapedMindmapAnchors = await diagrams.nth(3).evaluate((svg) =>
    [...svg.querySelectorAll<SVGGElement>('.mindmap-node')].map((node) => ({
      label: node.querySelector('text')?.textContent?.trim() ?? '',
      anchor: getComputedStyle(node.querySelector('text')!).textAnchor,
    }))
  );
  expect(shapedMindmapAnchors).toHaveLength(7);
  expect(shapedMindmapAnchors.every(({ label, anchor }) => label && anchor === 'middle')).toBe(true);
  const styled = diagrams.nth(2);
  await expect(styled.locator('.node').first()).toHaveAttribute('data-look', 'classic');
  expect(await styled.locator('.node.company .label-container').evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(225, 245, 254)');
  expect(await styled.locator('.node.pool .label-container').evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(255, 236, 179)');
  expect(await styled.locator('.cluster rect').first().evaluate((element) => getComputedStyle(element).fill))
    .toBe('rgb(255, 255, 222)');
  expect(await styled.locator('.node').first().evaluate((element) => getComputedStyle(element).filter))
    .toBe('none');
  await expect(page.getByRole('heading', { name: 'HTML Block' })).toBeVisible();
  await expect(page.getByText('这是一段由 HTML 渲染的内容', { exact: false })).toBeVisible();
  const section = page.locator('.markdown section').filter({ hasText: '安全清洗测试' });
  await expect(section).not.toHaveAttribute('style');
  await expect(section).not.toHaveAttribute('onclick');
  await expect(page.locator('.markdown script, .markdown iframe, .markdown form')).toHaveCount(0);
  await expect(page.locator('.markdown img')).toHaveCount(0);
  await expect(page.locator('.blocked-image')).toHaveText('[外部图片未加载]');
  await expect(page.locator('.markdown a').filter({ hasText: '危险链接' })).not.toHaveAttribute('href');
  expect(await page.evaluate(() => Boolean((window as typeof window & { htmlBlockExecuted?: boolean }).htmlBlockExecuted))).toBe(false);
  expect(externalRequests).toBe(0);
  await page.screenshot({ path: 'test-results/desktop-diagrams-html.png', fullPage: true });
  await page.locator('.account').click();
  await page.getByRole('switch', { name: '深色外观' }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.mermaid-diagram svg')).toHaveCount(4, { timeout: 15000 });
  await page.screenshot({ path: 'test-results/desktop-diagrams-dark.png', fullPage: true });
});

test('new note reopens the existing completely blank note', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const first = await (await page.request.get('/api/notes/blank')).json();
  expect(first.note?.id).toBeTruthy();

  await page.reload();
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill('复用空白笔记');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const reused = await (await page.request.get(`/api/notes/${first.note.id}`)).json();
  expect(reused.note.title).toBe('复用空白笔记');
  expect((await (await page.request.get('/api/notes/blank')).json()).note).toBeNull();
});

test('unsaved local draft survives refresh and syncs only after explicit retry', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `草稿恢复-${randomUUID().slice(0, 6)}`, '云端版本');
  await page.route('**/api/notes/*', async (route) => {
    if (route.request().method() === 'PUT') await route.abort('failed');
    else await route.continue();
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('网络失败之后的本地草稿');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/notes/*');
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('网络失败之后的本地草稿');
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '立即同步', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('草稿已保存并同步');
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
});

test('conflicting remote edits create an explicit local copy', async ({ page }) => {
  const title = `双端编辑-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '初始内容');
  const list = await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`);
  const note = (await list.json()).notes[0];
  const remote = await page.request.put(`/api/notes/${note.id}`, {
    headers, data: { title, content: '另一台设备的内容', tags: [], pinned: false, archived: false, deletedAt: null, revision: note.revision, operationId: randomUUID() },
  });
  expect(remote.status()).toBe(200);
  await page.getByRole('textbox', { name: '笔记正文' }).fill('当前设备的内容');
  await expect(page.getByRole('heading', { name: '检测到版本冲突' })).toBeVisible();
  await page.getByRole('button', { name: '另存冲突副本' }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(`${title} (冲突副本)`);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const original = await (await page.request.get(`/api/notes/${note.id}`)).json();
  expect(original.note.content).toBe('另一台设备的内容');
});

test('images render, export includes bytes, and import creates a readable copy', async ({ page }) => {
  const title = `图片备份-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  const untitledId = randomUUID();
  const untitled = await page.request.post(`${origin}/api/notes/${untitledId}`, {
    headers,
    data: {
      title: '', content: '没有标题的导出笔记', tags: [], pinned: false, archived: false,
      deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(untitled.status()).toBe(201);
  await newNote(page, title, '## 工作记录\n\n一张保存在私有空间的图片。');
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({ name: '笔记截图.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByText('图片已插入', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预览模式' }).click();
  await expect(page.locator('.markdown img')).toBeVisible();
  await expect.poll(() => page.locator('.markdown img').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: 'test-results/desktop-image.png', fullPage: true });
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect.poll(async () => {
    const result = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}&view=archive`)).json();
    return result.notes.some((note: { title: string }) => note.title === title);
  }).toBe(true);
  await page.locator('.account').click();
  await page.getByText('查看导入格式示例', { exact: true }).click();
  await expect(page.getByText('请选择 EasyNote 导出的完整 ZIP，不要解压后逐个选择笔记文件。', { exact: true })).toBeVisible();
  await expect(page.locator('.import-guide pre').first()).toContainText('示例笔记.md');
  await expect(page.locator('.import-guide pre').nth(1)).toContainText('"format": "easynote"');
  await expect(page.locator('.import-guide pre').nth(1)).toContainText('"path": "notes/示例笔记.md"');
  await expect(page.locator('.import-guide pre').nth(1)).toContainText('"archived": false');
  await page.screenshot({ path: 'test-results/import-guide.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 ZIP' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const archive = unzipSync(new Uint8Array(await readFile(path!)));
  const manifest = JSON.parse(strFromU8(archive['manifest.json']));
  expect(manifest.version).toBe(2);
  expect(manifest.notes.find((entry: { title: string }) => entry.title === title)).toMatchObject({
    path: `notes/${title}.md`,
    pinned: false, archived: true, deletedAt: null,
  });
  expect(manifest.notes.find((entry: { id: string }) => entry.id === untitledId).path)
    .toBe('notes/未命名.md');
  expect(new Set(manifest.notes.map((entry: { path: string }) => entry.path.toLocaleLowerCase('en-US'))).size)
    .toBe(manifest.notes.length);
  await expect(page.getByText('备份已下载', { exact: true })).toBeVisible();
  await page.locator('input[accept=".zip,.md,.txt"]').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: await readFile(path!) });
  await expect(page.locator('.toast')).toContainText('未导入：', { timeout: 30000 });
  await expect(page.locator('.toast')).toContainText('笔记已存在');
  const result = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}&view=archive`)).json();
  expect(result.notes.length).toBe(1);

  const standaloneTitle = `正文标题-${randomUUID().slice(0, 6)}`;
  const standaloneContent = `# ${standaloneTitle}\n\n标题来自正文，而不是文件名。`;
  const importInput = page.locator('input[accept=".zip,.md,.txt"]');
  const standaloneFile = {
    name: `${randomUUID()}.md`, mimeType: 'text/markdown', buffer: Buffer.from(standaloneContent),
  };
  await importInput.setInputFiles(standaloneFile);
  await expect(page.locator('.toast')).toHaveText('已导入 1 篇笔记');
  await expect.poll(async () => {
    const notes = await (await page.request.get(`/api/notes?q=${encodeURIComponent(standaloneTitle)}&view=all`)).json();
    return notes.notes.some((note: { title: string }) => note.title === standaloneTitle);
  }).toBe(true);

  await importInput.setInputFiles(standaloneFile);
  await expect(page.locator('.toast')).toHaveText('未导入：1 篇笔记已存在');
  const duplicates = await (await page.request.get(`/api/notes?q=${encodeURIComponent(standaloneTitle)}&view=all`)).json();
  expect(duplicates.notes.filter((note: { title: string }) => note.title === standaloneTitle)).toHaveLength(1);

  const emptyFile = { name: 'empty.md', mimeType: 'text/markdown', buffer: Buffer.from('') };
  await importInput.setInputFiles(emptyFile);
  await expect(page.locator('.toast')).toHaveText('已导入 1 篇笔记');
  const blank = await (await page.request.get('/api/notes/blank')).json();
  expect(blank.note?.id).toBeTruthy();
  await importInput.setInputFiles(emptyFile);
  await expect(page.locator('.toast')).toHaveText('未导入：1 篇笔记已存在');
  expect((await (await page.request.get('/api/notes/blank')).json()).note.id).toBe(blank.note.id);
});

test('mobile navigation, pin, archive, trash and restore remain usable without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const title = `手机笔记-${randomUUID().slice(0, 6)}`;
  await newNote(page, title, '手机上的简短记录');
  await page.getByRole('button', { name: '置顶', exact: true }).click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消归档', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.getByRole('button').filter({ hasText: title })).toBeHidden();
  await page.getByRole('combobox', { name: '笔记分类' }).selectOption('archive');
  await page.getByRole('button').filter({ hasText: title }).click();
  await page.getByRole('button', { name: '取消归档', exact: true }).click();
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.getByRole('button').filter({ hasText: title })).toBeHidden();
  await page.getByRole('combobox', { name: '笔记分类' }).selectOption('all');
  await page.getByRole('button').filter({ hasText: title }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByText('已移入回收站', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复笔记' }).click();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '返回笔记列表' }).click();
  await expect(page.getByRole('textbox', { name: '搜索笔记' })).toBeVisible();
});

test('all notes in trash can be permanently deleted after confirmation', async ({ page }) => {
  await page.goto('/');
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    const created = await page.request.post(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: `待清空-${index + 1}`, content: '', tags: [], pinned: false, archived: false,
        deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const trashed = await page.request.put(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: `待清空-${index + 1}`, content: '', tags: [], pinned: false, archived: false,
        deletedAt: Date.now(), revision: 1, operationId: randomUUID(),
      },
    });
    expect(trashed.status()).toBe(200);
  }

  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await expect(page.getByRole('button', { name: '全部永久删除', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全部永久删除', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '永久删除全部笔记？' })).toBeVisible();
  await expect(dialog).toContainText('此操作无法撤销');
  await dialog.getByRole('button', { name: '全部永久删除', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已永久删除 2 篇笔记');
  await expect(page.getByText('暂无笔记', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/notes?view=trash')).json()).notes).toHaveLength(0);
  await page.screenshot({ path: 'test-results/desktop-empty-trash.png', fullPage: true });
});

test('tags are scoped to the current note category and preserve it when selected', async ({ page }) => {
  await page.goto('/');
  const marker = randomUUID().slice(0, 6);
  const title = `归档标签-${marker}`;
  const archiveTag = `归档-${marker}`;
  await newNote(page, title, '用于验证归档标签筛选');
  await page.getByRole('textbox', { name: '笔记标签' }).fill(`${archiveTag}, 公共-${marker}`);
  await page.getByRole('textbox', { name: '笔记标签' }).press('Tab');
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect.poll(async () => {
    const result = await (await page.request.get(`/api/notes?view=archive&tag=${encodeURIComponent(archiveTag)}`)).json();
    return result.notes.some((note: { title: string }) => note.title === title);
  }).toBe(true);

  await page.getByRole('button', { name: '归档笔记', exact: true }).click();
  const tagNav = page.getByRole('navigation', { name: '标签' });
  await expect(tagNav.getByRole('button', { name: archiveTag, exact: true })).toBeVisible();
  await tagNav.getByRole('button', { name: archiveTag, exact: true }).click();
  await expect(page.getByRole('heading', { name: `归档笔记 · #${archiveTag}` })).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-archive-tags.png', fullPage: true });

  await page.getByRole('button', { name: '全部笔记', exact: true }).click();
  await expect(tagNav.getByRole('button', { name: archiveTag, exact: true })).toBeHidden();
});

test('note list width is adjustable, persistent, and both footers align', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `布局测试-${randomUUID().slice(0, 6)}`, '检查可调整的笔记列表。');
  const list = page.locator('.note-list');
  const separator = page.getByRole('separator', { name: '调整笔记列表宽度' });
  const initial = await list.boundingBox();
  const handle = await separator.boundingBox();
  expect(initial).not.toBeNull();
  expect(handle).not.toBeNull();
  expect(initial!.width).toBeCloseTo(300, 0);
  await expect(separator).toHaveAttribute('aria-valuemin', '220');
  await expect(separator).toHaveAttribute('aria-valuemax', '440');
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 140);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 84, handle!.y + 140, { steps: 5 });
  await page.mouse.up();
  const resized = await list.boundingBox();
  expect(resized!.width).toBeGreaterThan(initial!.width + 70);
  expect(await separator.getAttribute('aria-valuenow')).toBe(String(Math.round(resized!.width)));
  const footers = await page.evaluate(() => {
    const sidebarFooter = document.querySelector('.sidebar-bottom')!.getBoundingClientRect();
    const listFooter = document.querySelector('.list-footer')!.getBoundingClientRect();
    const documentFooter = document.querySelector('.document-footer')!.getBoundingClientRect();
    return {
      sidebarTop: sidebarFooter.top, sidebarHeight: sidebarFooter.height,
      listTop: listFooter.top, documentTop: documentFooter.top,
      listHeight: listFooter.height, documentHeight: documentFooter.height,
    };
  });
  expect(Math.abs(footers.sidebarTop - footers.listTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(footers.listTop - footers.documentTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(footers.sidebarHeight - footers.listHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(footers.listHeight - footers.documentHeight)).toBeLessThanOrEqual(1);
  expect(footers.sidebarHeight).toBeCloseTo(32, 0);
  expect(footers.listHeight).toBeCloseTo(32, 0);
  expect(footers.documentHeight).toBeCloseTo(32, 0);
  await page.screenshot({ path: 'test-results/desktop-resized.png', fullPage: true });
  await page.getByRole('button', { name: '收起侧栏' }).click();
  expect((await list.boundingBox())!.width).toBeCloseTo(resized!.width, 0);
  await page.reload();
  expect((await list.boundingBox())!.width).toBeCloseTo(resized!.width, 0);
  await separator.dblclick();
  await expect(separator).toHaveAttribute('aria-valuenow', '300');
});

test('typing while a save response is delayed preserves the newer draft', async ({ page }) => {
  const title = `连续输入-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '初始正文');
  let release: (() => void) | undefined;
  let reportStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { reportStarted = resolve; });
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  await page.route('**/api/notes/*', async (route) => {
    if (route.request().method() === 'PUT' && first) {
      first = false;
      const result = await route.fetch();
      reportStarted!();
      await delayed;
      await route.fulfill({ response: result });
    } else await route.continue();
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('第一段修改');
  await started;
  await page.getByRole('textbox', { name: '笔记正文' }).fill('请求期间继续输入，完整保留第二段修改');
  release!();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('完整保留第二段修改');
});

test('a stalled save times out and remains retryable without reloading', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `超时恢复-${randomUUID().slice(0, 6)}`, '已保存内容');
  await page.clock.install();
  await page.evaluate(() => {
    const state = window as typeof window & { stalledPuts: number };
    state.stalledPuts = 0;
    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return original(input, init);
      state.stalledPuts++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
  });
  await page.getByRole('textbox', { name: '笔记正文' }).fill('等待超时的本地草稿');
  await page.getByRole('button', { name: '立即同步', exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { stalledPuts: number }).stalledPuts)).toBe(1);
  await page.clock.runFor(31_000);
  await expect(page.getByRole('alert')).toContainText('Request timed out after 30 seconds.');
  await expect(page.getByText('待处理草稿', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled();
});

test('polling still refreshes the selected note after loading more than 50 notes', async ({ page }) => {
  const marker = randomUUID().slice(0, 8);
  const targetId = randomUUID();
  const targetTitle = `分页同步-${marker}`;
  for (let index = 0; index < 55; index++) {
    const id = index === 54 ? targetId : randomUUID();
    const response = await page.request.post(`${origin}/api/notes/${id}`, {
      headers,
      data: {
        title: index === 54 ? targetTitle : `分页填充-${marker}-${index}`,
        content: '初始内容', tags: [], pinned: false, archived: false, deletedAt: null,
        revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto('/');
  const loadMore = page.getByRole('button', { name: '加载更多' });
  await loadMore.click();
  await expect(loadMore).toBeHidden();
  await page.getByRole('button').filter({ hasText: targetTitle }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(targetTitle);
  await page.route(`**/api/notes/${targetId}`, (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Temporary failure.' } }),
  }));
  const failedPoll = page.waitForResponse((response) =>
    response.url().endsWith(`/api/notes/${targetId}`) && response.status() === 503);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await failedPoll;
  await expect(page.getByRole('alert')).toContainText('后台同步失败，将自动重试。');
  await page.unroute(`**/api/notes/${targetId}`);
  const remote = await page.request.put(`${origin}/api/notes/${targetId}`, {
    headers,
    data: {
      title: targetTitle, content: '另一台设备更新后的内容', tags: [], pinned: false, archived: false, deletedAt: null,
      revision: 1, operationId: randomUUID(),
    },
  });
  expect(remote.status()).toBe(200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText('另一台设备更新后的内容');
  await expect(page.getByRole('alert')).toBeHidden();
});

test('an expired session returns to login without a page reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await page.route('**/api/notes?**', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Please sign in.' } }),
  }));
  const sync = page.getByRole('button', { name: '同步', exact: true });
  await expect(sync).toBeEnabled();
  await sync.click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect(page.getByText('登录已过期，请重新登录。', { exact: true })).toBeVisible();
});

test('a second tab cannot overwrite this browser profile local drafts', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('另一个标签页正在编辑', { exact: true })).toBeVisible();
  await page.close();
  await other.getByRole('button', { name: '重新打开' }).click();
  await expect(other.getByRole('heading', { name: '全部笔记' })).toBeVisible();
  await other.close();
});

test('dark theme persists and the narrow mobile layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('switch', { name: '深色外观' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await newNote(page, '窄屏排版', '深色主题下的笔记');
  await page.screenshot({ path: 'test-results/mobile-dark.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('command palette, cursor-position image insertion and private attachments work', async ({ page }) => {
  const title = `快捷插入-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '开头\n结尾');
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await editor.press('ArrowLeft');
  await editor.press('ArrowLeft');
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '光标图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('图片已插入', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content;
  }).toMatch(/开头\n!\[光标图片\.png\]\(\/api\/images\/[0-9a-f-]{36}\)\n\n结尾/);

  await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles({
    name: '资料.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'),
  });
  await expect(page.getByText('附件已插入', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预览模式' }).click();
  await expect(page.getByRole('link', { name: '资料.pdf' })).toHaveAttribute('href', /\/api\/files\/[0-9a-f-]{36}$/);

  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog');
  await expect(palette.getByRole('heading', { name: '快速跳转' })).toBeVisible();
  await palette.getByLabel('快速跳转搜索').fill(title);
  await expect(palette.getByRole('button', { name: title, exact: true })).toBeVisible();
  await palette.getByRole('button', { name: title, exact: true }).click();
  await expect(palette).toBeHidden();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(title);
  await page.keyboard.press('Meta+s');
  await expect(page.getByRole('status')).toHaveText('已同步，内容为最新');
});

test('editing shortcuts and keyboard navigation work without pointer input', async ({ page }) => {
  await page.goto('/');
  await newNote(page, `键盘操作-${randomUUID().slice(0, 6)}`, '格式文本');
  const editor = page.getByRole('textbox', { name: '笔记正文' });

  await editor.press('Meta+a');
  await editor.press('Meta+b');
  await expect(editor).toContainText('**格式文本**');
  await editor.press('Meta+b');
  await expect(editor).toContainText('格式文本');
  await expect(editor).not.toContainText('**');
  await editor.press('Meta+a');
  await editor.press('Meta+i');
  await expect(editor).toContainText('*格式文本*');

  await editor.press('Meta+Enter');
  await expect(page.getByRole('button', { name: '预览模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByRole('button', { name: '编辑模式' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: '笔记正文' }).press('Meta+/');
  const shortcuts = page.getByRole('dialog');
  await expect(shortcuts.getByRole('heading', { name: '快捷键' })).toBeVisible();
  await expect(shortcuts).toContainText('Cmd/Ctrl+P');
  await shortcuts.getByRole('button', { name: '关闭' }).click();

  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog');
  const commandSearch = palette.getByLabel('快速跳转搜索');
  await commandSearch.fill('设置');
  await commandSearch.press('ArrowDown');
  await expect(palette.getByRole('button', { name: '打开设置' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click();
  await page.getByRole('textbox', { name: '笔记标题' }).fill(`第二篇-${randomUUID().slice(0, 6)}`);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  const rows = page.locator('.note-row');
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await rows.first().focus();
  await rows.first().press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await rows.nth(1).press('Home');
  await expect(rows.first()).toBeFocused();
});

test('Markdown todo items render and persist interactive checkbox changes', async ({ page }) => {
  const title = `待办事项-${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await newNote(page, title, '- [] 兼容简写\n- [x] 已完成\n- [ ] 标准待办');
  await page.getByRole('button', { name: '预览模式' }).click();

  const compact = page.getByRole('checkbox', { name: '待办事项：兼容简写' });
  const completed = page.getByRole('checkbox', { name: '待办事项：已完成' });
  const standard = page.getByRole('checkbox', { name: '待办事项：标准待办' });
  await expect(compact).toBeEnabled();
  await expect(compact).not.toBeChecked();
  await expect(completed).toBeChecked();
  await expect(standard).not.toBeChecked();

  await compact.click();
  await completed.click();
  await expect(compact).toBeChecked();
  await expect(completed).not.toBeChecked();
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-todo.png', fullPage: true });

  await page.getByRole('button', { name: '编辑模式' }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toContainText('- [x] 兼容简写');
  await expect(editor).toContainText('- [ ] 已完成');
  await expect(editor).toContainText('- [ ] 标准待办');
});

test('current note prints as a ready A4 PDF document', async ({ page }) => {
  const title = `PDF/导出:${randomUUID().slice(0, 6)}`;
  const content = [
    '## 打印正文',
    '',
    '包含图表和私有图片。',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[准备] --> B[导出]',
    '```',
  ].join('\n');
  await page.goto('/');
  await newNote(page, title, content);
  await page.getByRole('textbox', { name: '笔记标签' }).fill('打印, 测试');
  await page.getByRole('textbox', { name: '笔记标签' }).press('Tab');
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '打印图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出当前笔记为 PDF' })).toBeVisible();
  await page.evaluate(() => {
    const state = window as typeof window & {
      printCapture?: {
        title: string;
        text: string;
        diagrams: number;
        pendingDiagrams: number;
        imagesReady: boolean;
      };
    };
    window.print = () => {
      const root = document.querySelector<HTMLElement>('.print-document')!;
      const images = [...root.querySelectorAll<HTMLImageElement>('img')];
      state.printCapture = {
        title: document.title,
        text: root.textContent ?? '',
        diagrams: root.querySelectorAll('.mermaid-diagram svg').length,
        pendingDiagrams: root.querySelectorAll('[data-mermaid-source]').length,
        imagesReady: images.length === 1 && images.every((item) => item.complete && item.naturalWidth > 0),
      };
    };
  });
  await page.getByRole('textbox', { name: '笔记标题' }).press('Meta+p');
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { printCapture?: unknown }).printCapture)).toBeTruthy();
  const captured = await page.evaluate(() =>
    (window as typeof window & { printCapture: {
      title: string; text: string; diagrams: number; pendingDiagrams: number; imagesReady: boolean;
    } }).printCapture);
  expect(captured).toMatchObject({
    title: expect.stringMatching(/^PDF-导出-/),
    diagrams: 1,
    pendingDiagrams: 0,
    imagesReady: true,
  });
  expect(captured.text).toContain(title);
  expect(captured.text).toContain('更新于');
  expect(captured.text).toContain('#打印 #测试');
  expect(captured.text).toContain('包含图表和私有图片。');
  expect(await page.title()).toBe('EasyNote');

  await page.emulateMedia({ media: 'print' });
  const printLayout = await page.evaluate(() => ({
    printDisplay: getComputedStyle(document.querySelector('.print-document')!).display,
    workspaceDisplay: getComputedStyle(document.querySelector('.workspace')!).display,
    background: getComputedStyle(document.querySelector('.print-document')!).backgroundColor,
  }));
  expect(printLayout).toEqual({ printDisplay: 'block', workspaceDisplay: 'none', background: 'rgb(255, 255, 255)' });
  await page.screenshot({ path: 'test-results/print-note.png', fullPage: true });
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
});

test('mobile browsers receive a real PDF through share or download', async ({ page }) => {
  const title = `移动/PDF:${randomUUID().slice(0, 6)}`;
  const content = [
    '## 移动端导出',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[iOS] --> C[PDF]',
    '  B[Android] --> C',
    '```',
    '',
    ...Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 段内容用于验证移动端 PDF 分页不会截断长笔记。`),
  ].join('\n\n');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await newNote(page, title, content);
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '移动端图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as typeof window & {
      mobileShare?: { name: string; type: string; size: number; header: string };
      printCalls?: number;
    };
    state.printCalls = 0;
    window.print = () => { state.printCalls = (state.printCalls ?? 0) + 1; };
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: ({ files }: ShareData) => files?.[0]?.type === 'application/pdf',
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files }: ShareData) => {
        const file = files![0];
        state.mobileShare = {
          name: file.name,
          type: file.type,
          size: file.size,
          header: await file.slice(0, 4).text(),
        };
      },
    });
  });

  const exportButton = page.locator('.mobile-pdf-action');
  await expect(exportButton).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await exportButton.click();
  const ready = page.getByRole('dialog');
  await expect(ready.getByRole('heading', { name: 'PDF 已生成' })).toBeVisible({ timeout: 20_000 });
  await expect(ready).toContainText('移动-PDF-');
  await page.screenshot({ path: 'test-results/mobile-pdf-ready.png', fullPage: true });
  await ready.getByRole('button', { name: '保存或分享' }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { mobileShare?: unknown }).mobileShare)).toBeTruthy();
  const shared = await page.evaluate(() =>
    (window as typeof window & { mobileShare?: { name: string; type: string; size: number; header: string } }).mobileShare);
  expect(shared).toMatchObject({
    name: expect.stringMatching(/^移动-PDF-.+\.pdf$/),
    type: 'application/pdf',
    header: '%PDF',
  });
  expect(shared!.size).toBeGreaterThan(1_000);
  expect(await page.evaluate(() => (window as typeof window & { printCalls?: number }).printCalls)).toBe(0);
  await expect(page.getByRole('status')).toHaveText('PDF 已交给系统保存');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
  await exportButton.click();
  await expect(page.getByRole('heading', { name: 'PDF 已生成' })).toBeVisible({ timeout: 20_000 });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^移动-PDF-.+\.pdf$/);
  await download.saveAs('test-results/mobile-note.pdf');
  const path = await download.path();
  expect(path).toBeTruthy();
  const pdfBytes = await readFile(path!);
  expect(pdfBytes.subarray(0, 4).toString()).toBe('%PDF');
  expect(new TextDecoder('latin1').decode(pdfBytes).match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThan(1);
});

test('outline, stable internal links and backlinks navigate between notes', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const targetTitle = `知识目标-${marker}`;
  const sourceTitle = `知识来源-${marker}`;
  const targetId = randomUUID();
  await page.goto('/');
  const created = await page.request.post(`${origin}/api/notes/${targetId}`, {
    headers,
    data: {
      title: targetTitle, content: '## 目标章节\n\n目标内容', tags: [], pinned: false,
      archived: false, deletedAt: null, revision: 0, operationId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  await newNote(page, sourceTitle, '## 来源章节\n\n引用目标');
  await page.getByRole('button', { name: '大纲与反向链接' }).click();
  const panel = page.getByRole('complementary', { name: '笔记导航' });
  await expect(panel.getByRole('button', { name: '来源章节' })).toBeVisible();

  await page.getByRole('button', { name: '插入内部链接' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByLabel('搜索链接目标').fill(targetTitle);
  await picker.getByRole('button', { name: targetTitle, exact: true }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText(/\[\[[0-9a-f-]{36}\|知识目标-/);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预览模式' }).click();
  await page.getByRole('link', { name: targetTitle }).click();
  await expect(page.getByRole('textbox', { name: '笔记标题' })).toHaveValue(targetTitle);
  await expect(panel.getByRole('button', { name: sourceTitle, exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-knowledge-navigation.png', fullPage: true });
});

test('full offline library supports cold start, full-text search and note reading', async ({ page, context }) => {
  const marker = randomUUID().slice(0, 7);
  const title = `离线笔记-${marker}`;
  await page.goto('/');
  await newNote(page, title, `只有离线镜像中存在的检索词-${marker}`);
  const image = await page.locator('.document').screenshot({ type: 'png' });
  await page.locator('input[type=file][accept^="image"]').setInputFiles({
    name: '离线图片.png', mimeType: 'image/png', buffer: image,
  });
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible();
  await page.locator('.account').click();
  await page.getByRole('switch', { name: '离线笔记库' }).click();
  await expect(page.getByText(/离线笔记库 · \d+ 篇/)).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('离线', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索笔记' }).fill(`检索词-${marker}`);
  await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible();
  await page.getByRole('button').filter({ hasText: title }).click();
  await expect(page.getByRole('textbox', { name: '笔记正文' })).toContainText(`检索词-${marker}`);
  await page.getByRole('button', { name: '预览模式' }).click();
  const cachedImage = page.locator('.markdown img');
  await expect(cachedImage).toBeVisible();
  await expect.poll(() => cachedImage.evaluate((element: HTMLImageElement) =>
    element.src.startsWith('blob:') && element.complete && element.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: '编辑模式' }).click();
  const editor = page.getByRole('textbox', { name: '笔记正文' });
  await expect(editor).toBeFocused();
  await editor.press('Control+End');
  await editor.press('Enter');
  await editor.pressSequentially(`离线修改-${marker}`);
  await expect(page.getByText('仅保存在本机', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/desktop-offline-library.png', fullPage: true });
  await context.setOffline(false);
  await expect(page.getByText('已保存到云端', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => {
    const listed = await (await page.request.get(`/api/notes?q=${encodeURIComponent(title)}`)).json();
    return (await (await page.request.get(`/api/notes/${listed.notes[0].id}`)).json()).note.content;
  }).toContain(`离线修改-${marker}`);
});

test('batch note actions and tag management preserve revisions', async ({ page }) => {
  const marker = randomUUID().slice(0, 6);
  const firstTitle = `批量一-${marker}`;
  const secondTitle = `批量二-${marker}`;
  const sourceTag = `来源-${marker}`;
  const addedTag = `批量-${marker}`;
  const renamedTag = `归并-${marker}`;
  await page.goto('/');
  for (const [title, content] of [[firstTitle, '第一篇'], [secondTitle, '第二篇']]) {
    const response = await page.request.post(`${origin}/api/notes/${randomUUID()}`, {
      headers,
      data: {
        title, content, tags: [sourceTag], pinned: false, archived: false,
        deletedAt: null, revision: 0, operationId: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.reload();
  await expect(page.getByRole('button').filter({ hasText: firstTitle })).toBeVisible();

  await page.getByRole('button', { name: '批量选择' }).click();
  await page.getByRole('button').filter({ hasText: firstTitle }).click();
  await page.getByRole('button').filter({ hasText: secondTitle }).click();
  await page.getByRole('button', { name: '加标签' }).click();
  await page.getByRole('dialog').getByLabel('标签', { exact: true }).fill(addedTag);
  await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已为 2 篇笔记添加标签');

  await page.getByRole('button', { name: '管理标签' }).click();
  const manager = page.getByRole('dialog');
  await manager.getByLabel('来源标签').fill(sourceTag);
  await manager.getByLabel('操作').selectOption('merge');
  await manager.getByLabel('目标标签').fill(renamedTag);
  await manager.getByRole('button', { name: '应用' }).click();
  await expect(page.getByRole('status')).toHaveText('已更新 2 篇笔记');

  await page.getByRole('button', { name: '批量选择' }).click();
  await page.getByRole('button').filter({ hasText: firstTitle }).click();
  await page.getByRole('button').filter({ hasText: secondTitle }).click();
  await page.locator('.bulk-toolbar').getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已归档 2 篇笔记');
  const archived = await (await page.request.get(`/api/notes?view=archive&q=${encodeURIComponent(marker)}`)).json();
  expect(archived.notes).toHaveLength(2);
  for (const summary of archived.notes) {
    const full = await (await page.request.get(`/api/notes/${summary.id}`)).json();
    expect(full.note.tags).toEqual(expect.arrayContaining([addedTag, renamedTag]));
    expect(full.note.tags).not.toContain(sourceTag);
    expect(full.note.revision).toBeGreaterThan(2);
  }
});

test('a revoked offline session is removed as soon as the device reconnects', async ({ page, context }) => {
  await page.goto('/');
  const login = await page.request.post(`${origin}/api/login`, {
    headers: { Origin: origin },
    data: { username: 'tester', password: testPassword },
  });
  expect(login.status()).toBe(200);
  const liveSession = await login.json();
  await page.reload();
  await page.locator('.account').click();
  await page.getByRole('switch', { name: '离线笔记库' }).click();
  await expect(page.getByText(/离线笔记库 · \d+ 篇/)).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('离线', { exact: true })).toBeVisible();

  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === 'easynote_dev');
  expect(sessionCookie).toBeTruthy();
  const revoked = await fetch(`${origin}/api/logout`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: `${sessionCookie!.name}=${sessionCookie!.value}`,
      'X-CSRF-Token': liveSession.csrf,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(revoked.status).toBe(200);

  await context.setOffline(false);
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible({ timeout: 10_000 });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await context.setOffline(false);
});

test('account security changes the password and logs out every device', async ({ page }) => {
  const newPassword = 'Changed-EasyNote-Password-842!';
  await page.goto('/');
  await page.locator('.account').click();
  await page.getByRole('button', { name: '管理', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('当前密码').nth(0).fill(testPassword);
  await dialog.getByLabel('新密码', { exact: true }).fill(newPassword);
  await dialog.getByLabel('确认新密码').fill(newPassword);
  await dialog.getByRole('button', { name: '确认修改' }).click();
  await expect(page.getByRole('status')).toHaveText('密码已修改，其他设备已退出');
  await dialog.getByLabel('当前密码').nth(1).fill(newPassword);
  await dialog.getByRole('button', { name: '登出所有设备' }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await page.getByLabel('用户名').fill('tester');
  await page.getByLabel('密码').fill(newPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '全部笔记' })).toBeVisible();
});
