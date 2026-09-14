import { test, expect } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createPreview } from "../scripts/preview.mjs";

let preview;
test.beforeAll(async () => { preview = await createPreview({ POLL_INTERVAL_SECONDS: "5" }); });
test.afterAll(async () => { await preview?.mf.dispose(); });

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`share workflow at ${viewport.width}px`, async ({ page, context, browser }) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: preview.url });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(preview.url);
    await expect(page).toHaveURL(`${preview.url}/login`);
    await expect(page).toHaveTitle("登录 | EasyDrop");
    await expect(page.getByRole("heading", { name: "EasyDrop" })).toBeVisible();
    await expect(page.getByLabel("用户名")).toBeVisible();
    await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/login-${viewport.width}.png`, fullPage: true });

    // A disposable login through the real API installs its HttpOnly cookie into this test context.
    const login = await context.request.post(`${preview.url}/api/login`, {
      headers: { Origin: preview.url }, data: { username: preview.username, password: preview.password },
    });
    expect(login.status()).toBe(200);
    await page.goto(preview.url);
    await expect(page).toHaveTitle("EasyDrop");
    await expect(page.locator("#file-input")).toBeEnabled();
    const text = `<script>window.injected = true</script>\n${"long-text-".repeat(30)}`;
    await page.getByLabel("分享文本", { exact: true }).fill(text);
    await page.getByRole("button", { name: "分享文本", exact: true }).click();
    await expect(page.locator(".item-text").filter({ hasText: text })).toBeVisible();
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await expect(page.locator("#text-input")).toHaveValue("");

    const filename = `qa-${viewport.width}-${"long-name-".repeat(16)}.txt`;
    await page.locator("#file-input").setInputFiles([
      { name: filename, mimeType: "text/plain", buffer: Buffer.from("browser file contents") },
      { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
    ]);
    await page.getByRole("button", { name: "上传文件", exact: true }).click();
    await expect(page.locator("#notice")).toHaveText("上传完成");
    const file = page.locator(".history-item").filter({ hasText: filename });
    await expect(file).toHaveCount(1);
    const fileLink = file.getByRole("link", { name: "打开文件链接" });
    const fileUrl = await fileLink.getAttribute("href");
    expect(fileUrl).toMatch(new RegExp(`^${preview.url}/uploads/[a-f0-9-]+$`));
    await file.getByRole("button", { name: "复制文件链接" }).click();
    await expect(page.locator("#notice")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fileUrl);
    await fileLink.hover();
    await expect(file.locator(".file-link-qr")).toBeVisible();
    await expect(file.locator(".file-link-qr")).toHaveCSS("opacity", "1");
    await expect.poll(() => file.locator(".file-link-qr canvas").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      return dark;
    })).toBeGreaterThan(100);
    await page.screenshot({ path: `test-results/file-link-qr-${viewport.width}.png` });
    const downloadPromise = page.waitForEvent("download");
    await fileLink.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);
    expect(await download.failure()).toBeNull();
    await page.locator("#refresh").focus();
    await page.locator("#history-title").hover();
    await expect(file.locator(".file-link-qr")).toBeHidden();
    await page.screenshot({ path: `test-results/share-${viewport.width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const scanContext = await browser.newContext({ viewport });
    const scanPage = await scanContext.newPage();
    await scanPage.goto(fileUrl);
    await expect(scanPage).toHaveURL(/\/login\?next=/);
    expect(new URL(scanPage.url()).searchParams.get("next")).toBe(new URL(fileUrl).pathname);
    await scanPage.getByLabel("用户名").fill(preview.username);
    await scanPage.getByLabel("密码", { exact: true }).fill(preview.password);
    const scannedDownloadPromise = scanPage.waitForEvent("download");
    await scanPage.getByRole("button", { name: "登录", exact: true }).click();
    const scannedDownload = await scannedDownloadPromise;
    expect(scannedDownload.suggestedFilename()).toBe(filename);
    expect(await scannedDownload.failure()).toBeNull();
    await expect(scanPage).toHaveURL(`${preview.url}/`);
    await scanContext.close();

    await page.getByRole("button", { name: "访问二维码" }).click();
    await expect(page.locator("#qr-dialog")).toBeVisible();
    expect(await page.locator("#qr-canvas").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      return dark > 100 && dark < canvas.width * canvas.height * 0.8;
    })).toBe(true);
    await page.screenshot({ path: `test-results/qr-${viewport.width}.png` });
    await page.getByRole("button", { name: "关闭", exact: true }).click();

    await file.getByRole("button", { name: "删除记录" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(file).toHaveCount(0);
    await page.getByRole("button", { name: "清空历史" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("暂无分享记录")).toBeVisible();
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page).toHaveURL(`${preview.url}/login`);
    expect((await context.request.get(`${preview.url}/api/history`)).status()).toBe(401);
    expect(errors).toEqual([]);
  });
}

async function loginContext(context) {
  const login = await context.request.post(`${preview.url}/api/login`, {
    headers: { Origin: preview.url }, data: { username: preview.username, password: preview.password },
  });
  expect(login.ok()).toBe(true);
  const session = await (await context.request.get(`${preview.url}/api/session`)).json();
  const headers = { Origin: preview.url, "X-CSRF-Token": session.csrfToken };
  await context.request.post(`${preview.url}/api/clear_history`, { headers });
  return headers;
}

test("administrator can create, edit, disable, enable and delete a user", async ({ page, context }) => {
  await loginContext(context);
  await page.goto(preview.url);
  await page.getByRole("button", { name: "用户管理" }).click();
  await expect(page.locator("#users-dialog")).toBeVisible();

  await page.getByLabel("用户名").fill("ui-member");
  await page.getByLabel("密码", { exact: true }).fill("UiMemberPass123!");
  await page.getByRole("button", { name: "添加用户" }).click();
  let row = page.locator(".user-row").filter({ hasText: "ui-member" });
  await expect(row).toContainText("用户 · 已启用");
  await page.screenshot({ path: "test-results/users-1280.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#users-dialog")).toBeVisible();
  expect(await page.locator("#users-dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/users-390.png" });

  await row.getByRole("button", { name: "编辑用户" }).click();
  await page.getByLabel("用户名").fill("ui-member-edited");
  await page.getByLabel("密码", { exact: true }).fill("ChangedPass456!");
  await page.getByRole("button", { name: "保存修改" }).click();
  row = page.locator(".user-row").filter({ hasText: "ui-member-edited" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "禁用用户" }).click();
  await expect(row).toContainText("已禁用");
  await row.getByRole("button", { name: "启用用户" }).click();
  await expect(row).toContainText("已启用");

  await row.getByRole("button", { name: "删除用户" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(row).toHaveCount(0);
});

test("editing during submit cannot send a second request or erase new input", async ({ page, context }) => {
  await loginContext(context);
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/text", async (route) => {
    requests++;
    const response = await route.fetch();
    await hold;
    await route.fulfill({ response });
  });
  await page.goto(preview.url);
  await expect(page.locator("#file-input")).toBeEnabled();
  await page.locator("#text-input").fill("first draft");
  await page.getByRole("button", { name: "分享文本", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.locator("#text-input").fill("next draft");
  await expect(page.getByRole("button", { name: "分享文本", exact: true })).toBeDisabled();
  release();
  await expect(page.locator(".item-text")).toHaveText("first draft");
  await expect(page.locator("#text-input")).toHaveValue("next draft");
  expect(requests).toBe(1);
});

test("lost upload response can be retried without duplicate history", async ({ page, context }) => {
  await loginContext(context);
  let interrupted = false;
  let completeReached;
  let releaseComplete;
  const reachedComplete = new Promise((resolve) => { completeReached = resolve; });
  const holdComplete = new Promise((resolve) => { releaseComplete = resolve; });
  await page.route("**/api/uploads/*/complete", async (route) => {
    if (!interrupted) {
      interrupted = true;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      completeReached();
      await holdComplete;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto(preview.url);
  await expect(page.locator("#file-input")).toBeEnabled();
  await page.locator("#file-input").setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry") });
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  try {
    await reachedComplete;
    await expect(page.locator("#upload-list .upload-row > .muted")).toHaveText("上传分片 1/1");
  } finally {
    releaseComplete();
  }
  await expect(page.locator("#notice")).toHaveText("1 个文件上传失败");
  await page.getByRole("button", { name: "继续上传", exact: true }).click();
  await expect(page.locator("#notice")).toHaveText("上传完成");
  await expect(page.locator(".history-item").filter({ hasText: "retry.txt" })).toHaveCount(1);
});

test("multipart upload runs concurrently and resumes after pause and reload", async ({ page, context }) => {
  await loginContext(context);
  const path = new URL("../test-results/resume-large.bin", import.meta.url).pathname;
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  await writeFile(path, Buffer.alloc(11 * 1024 * 1024, 0x5a));
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maxActive = 0;
  await page.route("**/api/uploads/*/parts/*", async (route) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const response = await route.fetch();
      await hold;
      await route.fulfill({ response });
    } catch {
      // Pausing intentionally aborts the browser-side requests.
    } finally {
      active--;
    }
  });
  try {
    await page.goto(preview.url);
    await page.locator("#file-input").setInputFiles(path);
    await page.getByRole("button", { name: "上传文件", exact: true }).click();
    await expect.poll(() => maxActive).toBeGreaterThan(1);
    await page.getByRole("button", { name: "暂停上传", exact: true }).click();
    release();
    await expect(page.locator("#notice")).toHaveText("上传已暂停");
    await page.unroute("**/api/uploads/*/parts/*");

    await page.reload();
    await page.locator("#file-input").setInputFiles(path);
    await expect(page.getByRole("button", { name: "继续上传", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "继续上传", exact: true }).click();
    await expect(page.locator("#notice")).toHaveText("上传完成", { timeout: 30000 });
    await expect(page.locator(".history-item").filter({ hasText: "resume-large.bin" })).toHaveCount(1);
  } finally {
    release?.();
    await rm(path, { force: true });
  }
});

test("polling keeps expanded pages and manual refresh applies updates", async ({ page, context }) => {
  const headers = await loginContext(context);
  for (let i = 0; i < 18; i++) {
    expect((await context.request.post(`${preview.url}/api/text`, { headers, data: { text: `history-${i}` } })).ok()).toBe(true);
  }
  await page.goto(preview.url);
  await expect(page.locator(".history-item")).toHaveCount(8);
  await page.getByRole("button", { name: "加载更早记录" }).click();
  await expect(page.locator(".history-item")).toHaveCount(16);
  await page.getByRole("button", { name: "加载更早记录" }).click();
  await expect(page.locator(".history-item")).toHaveCount(18);
  await context.request.post(`${preview.url}/api/text`, { headers, data: { text: "new from another device" } });
  await expect(page.locator("#refresh")).toHaveClass(/has-updates/, { timeout: 10000 });
  await expect(page.locator(".history-item")).toHaveCount(18);
  await page.getByRole("button", { name: "刷新历史" }).click();
  await expect(page.locator(".history-item")).toHaveCount(8);
  await expect(page.locator(".item-text").first()).toHaveText("new from another device");
});
