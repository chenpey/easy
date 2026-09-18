import { test, expect } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createPreview } from "../scripts/preview.mjs";

let preview;
test.beforeAll(async () => {
  preview = await createPreview({
    POLL_INTERVAL_SECONDS: "5",
    LOGIN_IP_LIMIT: "1000",
    LOGIN_GLOBAL_LIMIT: "10000",
  });
});
test.afterAll(async () => { await preview?.mf.dispose(); });

test("PWA metadata, icons and public-only service worker cache work", async ({ page, context }) => {
  await page.goto(preview.url);
  await expect(page).toHaveURL(`${preview.url}/login`);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png");

  const manifestResponse = await page.request.get(`${preview.url}/manifest.webmanifest`);
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()["content-type"]).toContain("manifest+json");
  expect(await manifestResponse.json()).toMatchObject({
    id: "/",
    name: "EasyDrop",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#0071e3",
    background_color: "#f5f5f7",
  });
  for (const path of [
    "/pwa-192x192.png",
    "/pwa-512x512.png",
    "/pwa-maskable-512x512.png",
    "/apple-touch-icon.png",
  ]) {
    const icon = await page.request.get(`${preview.url}${path}`);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/png");
  }

  const worker = await page.request.get(`${preview.url}/sw.js`);
  expect(worker.status()).toBe(200);
  expect(worker.headers()["content-type"]).toContain("javascript");
  await expect.poll(() => page.evaluate(async () =>
    Boolean(await navigator.serviceWorker.getRegistration("/")))).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cdp = await context.newCDPSession(page);
  const loadedManifest = await cdp.send("Page.getAppManifest");
  expect(loadedManifest.url).toBe(`${preview.url}/manifest.webmanifest`);
  expect(loadedManifest.errors).toEqual([]);
  expect((await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
  const cachedPaths = await page.evaluate(async () => {
    const paths = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
    }
    return paths;
  });
  expect(cachedPaths).toContain("/assets/app.js");
  expect(cachedPaths.some((path) => path.startsWith("/api/"))).toBe(false);
  expect(cachedPaths.some((path) => ["/", "/index.html", "/login"].includes(path))).toBe(false);
});

test("an external top-level launch preserves the persistent session", async ({ page, context }) => {
  const login = await context.request.post(`${preview.url}/api/login`, {
    headers: { Origin: preview.url },
    data: { username: preview.username, password: preview.password },
  });
  expect(login.status()).toBe(200);
  const sessionCookie = (await context.cookies(preview.url)).find((cookie) => cookie.name === "easydrop_dev");
  expect(sessionCookie).toMatchObject({ sameSite: "Lax" });

  await page.route("https://launcher.example.test/", (route) => route.fulfill({
    contentType: "text/html",
    body: `<a href="${preview.url}/">Open EasyDrop</a>`,
  }));
  await page.goto("https://launcher.example.test/");
  await page.getByRole("link", { name: "Open EasyDrop" }).click();
  await expect(page).toHaveURL(`${preview.url}/`);
  await expect(page.locator("#file-input")).toBeEnabled();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
  test(`share workflow at ${viewport.width}px`, async ({ page, context, browser }) => {
    await page.setViewportSize(viewport);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: preview.url });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(preview.url);
    await expect(page).toHaveURL(`${preview.url}/login`);
    await expect(page).toHaveTitle("登录 | EasyDrop");
    await expect(page.getByRole("heading", { name: "EasyDrop" })).toBeVisible();
    await expect(page.locator("#login-view").getByLabel("用户名", { exact: true })).toBeVisible();
    await expect(page.locator("#login-view").getByLabel("密码", { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/login-${viewport.width}.png`, fullPage: true });

    // A disposable login through the real API installs its HttpOnly cookie into this test context.
    const login = await context.request.post(`${preview.url}/api/login`, {
      headers: { Origin: preview.url }, data: { username: preview.username, password: preview.password },
    });
    expect(login.status()).toBe(200);
    await page.goto(preview.url);
    await expect(page).toHaveTitle("EasyDrop");
    await expect(page.locator("#file-input")).toBeEnabled();
    await expect(page.locator("#upload-limit")).toHaveText("单文件上限 200.0 MB");
    const expectedContentWidth = viewport.width > 680 ? Math.min(viewport.width - 48, 960) : viewport.width - 32;
    const layoutBoxes = await page.locator(".header-inner, .workspace, .compose, .history").evaluateAll((nodes) =>
      nodes.map((node) => {
        const { left, width } = node.getBoundingClientRect();
        return { left, width };
      }));
    expect(layoutBoxes).toEqual(Array(4).fill({
      left: (viewport.width - expectedContentWidth) / 2,
      width: expectedContentWidth,
    }));
    const controlBoxes = await page.locator("#text-input, .file-picker").evaluateAll((nodes) =>
      nodes.map((node) => {
        const { top, height } = node.getBoundingClientRect();
        return { top, height };
      }));
    expect(controlBoxes.map(({ height }) => height)).toEqual([80, 80]);
    if (viewport.width > 680) expect(controlBoxes[0].top).toBe(controlBoxes[1].top);
    if (viewport.width === 1280) {
      await expect(page.locator(".compose")).toHaveCSS("width", "960px");
    }
    const sharedUrl = `${preview.url}/favicon.svg?source=shared#drop`;
    const text = `<script>window.injected = true</script>\n${sharedUrl}。\n${"long-text-".repeat(30)}`;
    await page.getByLabel("分享文本", { exact: true }).fill(text);
    await page.getByRole("button", { name: "分享文本", exact: true }).click();
    const textItem = page.locator(".history-item").filter({ hasText: text });
    await expect(textItem).toBeVisible();
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    const sharedLink = textItem.getByRole("link", { name: sharedUrl });
    await expect(sharedLink).toHaveAttribute("href", sharedUrl);
    await expect(sharedLink).toHaveAttribute("target", "_blank");
    await expect(sharedLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(textItem.locator(".item-text")).toHaveText(text);
    const openedLinkPromise = page.waitForEvent("popup");
    await sharedLink.click();
    const openedLink = await openedLinkPromise;
    await expect(openedLink).toHaveURL(sharedUrl);
    await openedLink.close();
    await expect(page.locator("#text-input")).toHaveValue("");
    const copyText = textItem.getByRole("button", { name: "复制文本" });
    await copyText.click();
    await expect(copyText).toHaveClass(/copy-confirmed/);
    await expect(page.locator("#copy-notice")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

    const filename = `qa-${viewport.width}-${"long-name-".repeat(16)}.txt`;
    const imageName = `preview-${viewport.width}.png`;
    const imageBase64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 36;
      const context = canvas.getContext("2d");
      context.fillStyle = "#0071e3";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.fillRect(12, 9, 24, 18);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator("#file-input").setInputFiles([
      { name: filename, mimeType: "text/plain", buffer: Buffer.from("browser file contents") },
      { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
      { name: imageName, mimeType: "image/png", buffer: Buffer.from(imageBase64, "base64") },
    ]);
    await page.getByRole("button", { name: "上传文件", exact: true }).click();
    await expect(page.locator("#notice")).toHaveText("上传完成");
    const file = page.locator(".history-item").filter({ hasText: filename });
    await expect(file).toHaveCount(1);
    const image = page.locator(".history-item").filter({ hasText: imageName });
    const thumbnail = image.locator(".file-thumbnail");
    await image.scrollIntoViewIfNeeded();
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((node) => node.naturalWidth)).toBe(48);
    expect(await thumbnail.getAttribute("src")).toMatch(/^\/previews\/[a-f0-9-]+$/);
    await thumbnail.evaluate((node) => { node.dataset.testIdentity = "preserved"; });
    let repeatedPreviewRequests = 0;
    const countPreviewRequest = (request) => {
      if (new URL(request.url()).pathname.startsWith("/previews/")) repeatedPreviewRequests++;
    };
    page.on("request", countPreviewRequest);
    await page.getByRole("button", { name: "刷新历史" }).click();
    await expect(page.locator("#notice")).toHaveText("已刷新");
    await expect(thumbnail).toHaveAttribute("data-test-identity", "preserved");
    expect(repeatedPreviewRequests).toBe(0);
    page.off("request", countPreviewRequest);
    let unexpectedDownloads = 0;
    let unexpectedPopups = 0;
    const countUnexpectedDownload = () => { unexpectedDownloads++; };
    const countUnexpectedPopup = () => { unexpectedPopups++; };
    page.on("download", countUnexpectedDownload);
    page.on("popup", countUnexpectedPopup);
    await image.locator(".item-actions").getByRole("button", { name: `预览图片 ${imageName}` }).click();
    const imagePreviewDialog = page.locator("#image-preview-dialog");
    await expect(imagePreviewDialog).toBeVisible();
    await expect(imagePreviewDialog.locator("#image-preview-name")).toHaveText(imageName);
    const fullImage = imagePreviewDialog.locator("#image-preview-content");
    await expect(fullImage).toBeVisible();
    expect(await fullImage.getAttribute("src")).toMatch(/^\/images\/[a-f0-9-]+\/preview-\d+\.png$/);
    await expect.poll(() => fullImage.evaluate((node) => node.naturalWidth)).toBe(48);
    expect(unexpectedDownloads).toBe(0);
    expect(unexpectedPopups).toBe(0);
    await page.screenshot({ path: `test-results/image-preview-${viewport.width}.png` });
    await imagePreviewDialog.getByRole("button", { name: "关闭图片预览" }).click();
    await expect(imagePreviewDialog).toBeHidden();
    page.off("download", countUnexpectedDownload);
    page.off("popup", countUnexpectedPopup);
    const fileLink = file.getByRole("link", { name: `下载文件 ${filename}` });
    const fileUrl = await fileLink.getAttribute("href");
    const fileLinkUrl = new URL(fileUrl);
    expect(fileLinkUrl.pathname).toMatch(/^\/uploads\/[a-f0-9-]+\//);
    expect(decodeURIComponent(fileLinkUrl.pathname.split("/").at(-1))).toBe(filename);
    await expect(fileLink).not.toHaveAttribute("target", "_blank");
    await expect(image.getByRole("link", { name: `下载文件 ${imageName}` })).toBeVisible();
    const copyFileLink = file.getByRole("button", { name: "复制文件链接" });
    await copyFileLink.click();
    await expect(copyFileLink).toHaveClass(/copy-confirmed/);
    await expect(page.locator("#copy-notice")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fileUrl);
    await file.getByRole("button", { name: "创建临时链接" }).click();
    const temporaryDialog = page.locator("#temporary-share-dialog");
    await expect(temporaryDialog).toBeVisible();
    await temporaryDialog.getByRole("spinbutton", { name: "有效时长（小时）" }).fill("2");
    await temporaryDialog.getByRole("button", { name: "创建链接" }).click();
    await expect(page.locator("#notice")).toHaveText("临时链接已创建");
    const temporaryUrl = await temporaryDialog.locator("#temporary-share-url").getAttribute("href");
    const temporaryLinkUrl = new URL(temporaryUrl);
    expect(temporaryLinkUrl.pathname).toMatch(/^\/shared\/[a-f0-9]{64}\//);
    expect(decodeURIComponent(temporaryLinkUrl.pathname.split("/").at(-1))).toBe(filename);
    await expect(temporaryDialog.locator("#temporary-share-status")).toContainText("当前链接有效至");
    await expect.poll(() => temporaryDialog.locator("#temporary-share-qr").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      return dark;
    })).toBeGreaterThan(100);
    const copyTemporaryLink = temporaryDialog.getByRole("button", { name: "复制链接" });
    await copyTemporaryLink.click();
    await expect(temporaryDialog.locator("#temporary-share-notice")).toBeVisible();
    await expect(temporaryDialog.locator("#temporary-share-notice")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(temporaryUrl);
    await page.screenshot({ path: `test-results/temporary-share-${viewport.width}.png` });
    const guestContext = await browser.newContext();
    const publicDownload = await guestContext.request.get(temporaryUrl);
    expect(publicDownload.status()).toBe(200);
    expect(await publicDownload.text()).toBe("browser file contents");
    await temporaryDialog.getByRole("button", { name: "撤销链接" }).click();
    await expect(page.locator("#notice")).toHaveText("临时链接已撤销");
    expect((await guestContext.request.get(temporaryUrl)).status()).toBe(404);
    await guestContext.close();
    await temporaryDialog.getByRole("button", { name: "关闭" }).click();
    await expect(file.getByRole("button", { name: "创建临时链接" })).toBeVisible();
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
    await scanPage.locator("#login-view").getByLabel("用户名", { exact: true }).fill(preview.username);
    await scanPage.locator("#login-view").getByLabel("密码", { exact: true }).fill(preview.password);
    const scannedDownloadPromise = scanPage.waitForEvent("download");
    await scanPage.getByRole("button", { name: "登录", exact: true }).click();
    const scannedDownload = await scannedDownloadPromise;
    expect(scannedDownload.suggestedFilename()).toBe(filename);
    expect(await scannedDownload.failure()).toBeNull();
    await expect(scanPage).toHaveURL(`${preview.url}/`);
    await scanContext.close();

    const siteQrButton = page.getByRole("button", { name: "访问二维码" });
    await siteQrButton.hover();
    await expect(page.locator("#site-link-popover")).toBeVisible();
    await expect(page.locator("#site-url-preview")).toHaveText(preview.url);
    await expect.poll(() => page.locator("#site-qr-preview").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      return dark;
    })).toBeGreaterThan(100);
    await page.screenshot({ path: `test-results/site-qr-hover-${viewport.width}.png` });
    await page.locator("#history-title").hover();
    await expect(page.locator("#site-link-popover")).toBeHidden();
    await siteQrButton.click();
    await expect(page.locator("#qr-dialog")).toBeVisible();
    expect(await page.locator("#qr-canvas").evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      return dark > 100 && dark < canvas.width * canvas.height * 0.8;
    })).toBe(true);
    await page.locator("#copy-url").click();
    await expect(page.locator("#site-copy-notice")).toBeVisible();
    await expect(page.locator("#site-copy-notice")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(preview.url);
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

  await page.getByLabel("用户名", { exact: true }).fill("ui-member");
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
  await page.getByLabel("用户名", { exact: true }).fill("ui-member-edited");
  await page.getByLabel("新密码（留空则不修改）").fill("ChangedPass456!");
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

test("registration, recovery, password change and self-deletion work end to end", async ({ page, context, browser }) => {
  const adminHeaders = await loginContext(context);
  await page.goto(preview.url);
  await page.getByRole("button", { name: "用户管理" }).click();
  await page.getByLabel("自助注册").check();
  await expect(page.locator("#notice")).toHaveText("已开放自助注册");
  await expect(page.getByLabel("自助注册")).toBeChecked();
  await page.locator("#users-dialog").getByRole("button", { name: "关闭" }).click();

  const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`${preview.url}/register`);
  await expect(memberPage).toHaveTitle("注册 | EasyDrop");
  const registerView = memberPage.locator("#register-view");
  await registerView.getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await registerView.getByLabel("密码", { exact: true }).fill("UiSelfService123!");
  await registerView.getByLabel("确认密码").fill("UiSelfService123!");
  await registerView.getByRole("button", { name: "提交注册" }).click();
  await expect(registerView.getByText("注册已提交，等待管理员启用。")).toBeVisible();
  const registrationCode = await memberPage.locator("#registration-recovery-code").textContent();
  expect(registrationCode).toMatch(/^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
  await memberPage.screenshot({ path: "test-results/registration-1280.png", fullPage: true });

  const row = page.locator(".user-row").filter({ hasText: "ui-self-service" });
  await page.getByRole("button", { name: "用户管理" }).click();
  await expect(row).toContainText("待启用");
  await row.getByRole("button", { name: "启用用户" }).click();
  await expect(row).toContainText("已启用");

  await memberPage.goto(`${preview.url}/login`);
  const loginView = memberPage.locator("#login-view");
  await loginView.getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await loginView.getByLabel("密码", { exact: true }).fill("UiSelfService123!");
  await loginView.getByRole("button", { name: "登录", exact: true }).click();
  await expect(memberPage).toHaveURL(`${preview.url}/`);

  await memberPage.getByRole("button", { name: "账户设置" }).click();
  const accountDialog = memberPage.locator("#account-dialog");
  await expect(accountDialog).toBeVisible();
  await expect(accountDialog.locator("#account-username")).toHaveText("ui-self-service");
  const recoveryForm = accountDialog.locator("#recovery-form");
  await recoveryForm.getByLabel("当前密码").fill("UiSelfService123!");
  await recoveryForm.getByRole("button", { name: "生成恢复码" }).click();
  await expect(accountDialog.locator("#account-recovery-code")).toHaveText(/^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
  const recoveryCode = await accountDialog.locator("#account-recovery-code").textContent();
  expect(recoveryCode).toMatch(/^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
  await memberPage.setViewportSize({ width: 390, height: 844 });
  expect(await accountDialog.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await memberPage.screenshot({ path: "test-results/account-390.png" });

  const resetContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const resetPage = await resetContext.newPage();
  await resetPage.goto(`${preview.url}/reset-password`);
  await expect(resetPage).toHaveTitle("重置密码 | EasyDrop");
  const resetView = resetPage.locator("#reset-view");
  await resetView.getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await resetView.getByLabel("恢复码").fill(recoveryCode);
  await resetView.getByLabel("新密码", { exact: true }).fill("UiRecoveredPass456!");
  await resetView.getByLabel("确认新密码").fill("UiRecoveredPass456!");
  await resetView.getByRole("button", { name: "重置密码" }).click();
  await expect(resetPage.locator("#notice")).toHaveText("密码已重置，请返回登录");
  await resetContext.close();

  await memberPage.reload();
  await expect(memberPage).toHaveURL(`${preview.url}/login`);
  await memberPage.locator("#login-view").getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await memberPage.locator("#login-view").getByLabel("密码", { exact: true }).fill("UiRecoveredPass456!");
  await memberPage.locator("#login-view").getByRole("button", { name: "登录", exact: true }).click();
  await memberPage.getByRole("button", { name: "账户设置" }).click();
  const passwordForm = memberPage.locator("#password-form");
  await passwordForm.getByLabel("当前密码").fill("UiRecoveredPass456!");
  await passwordForm.getByLabel("新密码", { exact: true }).fill("UiChangedPass789!");
  await passwordForm.getByLabel("确认新密码").fill("UiChangedPass789!");
  await passwordForm.getByRole("button", { name: "修改密码" }).click();
  await expect(memberPage).toHaveURL(`${preview.url}/login`);

  await memberPage.locator("#login-view").getByLabel("用户名", { exact: true }).fill("ui-self-service");
  await memberPage.locator("#login-view").getByLabel("密码", { exact: true }).fill("UiChangedPass789!");
  await memberPage.locator("#login-view").getByRole("button", { name: "登录", exact: true }).click();
  await memberPage.getByRole("button", { name: "账户设置" }).click();
  await memberPage.getByRole("button", { name: "注销账号" }).click();
  const deleteDialog = memberPage.locator("#delete-account-dialog");
  await deleteDialog.getByLabel("输入用户名确认").fill("ui-self-service");
  await deleteDialog.getByLabel("当前密码").fill("UiChangedPass789!");
  await deleteDialog.getByRole("button", { name: "确认注销" }).click();
  await expect(memberPage).toHaveURL(`${preview.url}/login`);
  await memberContext.close();

  const closed = await context.request.patch(`${preview.url}/api/settings/registration`, {
    headers: adminHeaders,
    data: { enabled: false },
  });
  expect(closed.ok()).toBe(true);
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

test("polling refreshes expanded pages, preserves position and recovers after failure", async ({ page, context }) => {
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
  const anchor = page.getByText("history-9", { exact: true });
  await anchor.scrollIntoViewIfNeeded();
  const anchorTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
  let revisionRequests = 0;
  await page.route("**/api/revision", async (route) => {
    revisionRequests++;
    if (revisionRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Temporary polling failure." }),
      });
      return;
    }
    await route.continue();
  });
  const created = await context.request.post(`${preview.url}/api/text`, {
    headers, data: { text: "new from another device" },
  });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#notice")).toHaveText("Temporary polling failure.");
  await expect(page.locator(".item-text").first()).toHaveText("new from another device", { timeout: 12000 });
  await expect(page.locator(".history-item")).toHaveCount(19);
  await expect(page.locator("#notice")).toHaveText("分享历史已自动更新");
  expect(revisionRequests).toBeGreaterThanOrEqual(2);
  expect(Math.abs(await anchor.evaluate((node) => node.getBoundingClientRect().top) - anchorTop)).toBeLessThan(1);
  const deleted = await context.request.delete(`${preview.url}/api/history/${id}`, { headers });
  expect(deleted.ok()).toBe(true);
  await expect(page.getByText("new from another device", { exact: true })).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator(".history-item")).toHaveCount(18);
});
