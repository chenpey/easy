import { createIcons, LogIn, LogOut, QrCode, Text, Files, FileUp, Send, Upload, Pause, Play, RefreshCw, Trash2, X, Copy, Link, FileText, Users, UserPlus, Pencil, UserCheck, UserX, Share2, Unlink, KeyRound, UserRound } from "lucide";
import QRCode from "qrcode";

const icons = { LogIn, LogOut, QrCode, Text, Files, FileUp, Send, Upload, Pause, Play, RefreshCw, Trash2, X, Copy, Link, FileText, Users, UserPlus, Pencil, UserCheck, UserX, Share2, Unlink, KeyRound, UserRound };
const renderIcons = () => createIcons({ icons });
const $ = (id) => document.getElementById(id);
const isLogin = document.body.dataset.page === "login";
let session;
let nextCursor = null;
let currentRevision = -1;
let loading = false;
let pendingRefresh = false;
let uploading = false;
let pauseRequested = false;
let uploadQueue = [];
let pollTimer;
let pollingStopped = false;
let revisionCheckRunning = false;
let pollFailureCount = 0;
let textSubmitting = false;
let textOperation;
let expandedHistory = false;
let sessionEnded = false;
let temporaryShareItem;
const maxPollRetrySeconds = 60;
const activeUploads = new Set();
const activeRequests = new Set();
const busyButtons = new WeakSet();
const copyFeedbackTimers = new WeakMap();
const historyRowCache = new Map();
const previewSourceTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const previewSourceExtension = /\.(?:jpe?g|png|gif|webp|avif|bmp)$/i;
const previewMaxSide = 256;
const previewMaxBytes = 256 * 1024;
let retainHistoryRows = false;
const uploadStorageKey = () => `easydrop/resumable-uploads/v2/${session?.user.id || "anonymous"}`;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Service worker registration failed.", error));
  });
}

class UploadPaused extends Error {}

function requestedDownloadPath() {
  const path = new URL(location.href).searchParams.get("next") || "";
  return /^\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/[^/]+$/.test(path)
    ? path
    : null;
}

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("error-details").hidden = true;
}

function report(error) {
  notice(error.message, true);
  $("error-body").textContent = error.details || String(error);
  $("error-details").hidden = false;
}

function apiError(method, path, status, body) {
  let message = `HTTP ${status}`;
  try { message = JSON.parse(body).message || message; } catch { /* Keep non-JSON error bodies intact. */ }
  const error = new Error(message);
  error.status = status;
  error.details = `${method} ${path}\nHTTP ${status}\n${body}`;
  if (status === 401 && message === "Authentication required." && !isLogin) expireSession();
  return error;
}

function expireSession() {
  pollingStopped = true;
  clearTimeout(pollTimer);
  for (const xhr of activeUploads) xhr.abort();
  $("history-list")?.replaceChildren();
  historyRowCache.clear();
  session = null;
  sessionEnded = true;
  uploading = false;
  textSubmitting = false;
  for (const controller of activeRequests) controller.abort();
  location.replace("/login");
}

async function api(path, { method = "GET", data, payload, contentType, operationKey } = {}) {
  if (data !== undefined && payload !== undefined) throw new Error("API request body is ambiguous.");
  const headers = {};
  if (data !== undefined) headers["Content-Type"] = "application/json";
  if (contentType) headers["Content-Type"] = contentType;
  if (operationKey) headers["Idempotency-Key"] = operationKey;
  if (method !== "GET" && session) headers["X-CSRF-Token"] = session.csrfToken;
  const controller = new AbortController();
  activeRequests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, {
      method, headers, body: data === undefined ? payload : JSON.stringify(data),
      credentials: "same-origin", cache: "no-store", signal: controller.signal,
    });
    const body = await response.text();
    if (sessionEnded) throw new Error("Session ended.");
    if (!response.ok) throw apiError(method, path, response.status, body);
    try { return JSON.parse(body); } catch { throw apiError(method, path, response.status, body); }
  } catch (error) {
    if (!error.details) error.details = `${method} ${path}\n${error.name}: ${error.message}`;
    throw error;
  } finally {
    clearTimeout(timeout);
    activeRequests.delete(controller);
  }
}

async function busy(button, action) {
  if (busyButtons.has(button)) return;
  busyButtons.add(button);
  button.disabled = true;
  try { await action(); } catch (error) { if (!sessionEnded) report(error); } finally {
    busyButtons.delete(button);
    button.disabled = false;
  }
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function icon(name) {
  const node = document.createElement("i");
  node.dataset.lucide = name;
  return node;
}

function appendLinkifiedText(container, value) {
  const pattern = /https?:\/\/[^\s<>"']+/giu;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    let candidate = match[0];
    let suffix = "";
    while (/[.,;:!?，。；：！？、]$/u.test(candidate)) {
      suffix = candidate.at(-1) + suffix;
      candidate = candidate.slice(0, -1);
    }
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    container.append(document.createTextNode(value.slice(offset, match.index)));
    const link = document.createElement("a");
    link.className = "item-text-link";
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = candidate;
    container.append(link, document.createTextNode(suffix));
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(value.slice(offset)));
}

function actionButton(label, name, handler, danger = false) {
  const button = document.createElement("button");
  button.className = `icon-button${danger ? " danger" : ""}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  button.addEventListener("click", () => busy(button, () => handler(button)));
  return button;
}

function confirmDelete(title) {
  return new Promise((resolve) => {
    const dialog = $("confirm-dialog");
    $("confirm-title").textContent = title;
    dialog.returnValue = "cancel";
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}

function resetUserForm() {
  $("user-form").reset();
  $("user-id").value = "";
  $("user-enabled").checked = true;
  $("user-password").required = true;
  $("user-password-label").textContent = "密码";
  $("user-submit-label").textContent = "添加用户";
  $("user-cancel").hidden = true;
}

async function loadUsers() {
  const [data, authConfig] = await Promise.all([api("/api/users"), api("/api/auth/config")]);
  $("registration-enabled").checked = authConfig.registrationEnabled;
  const list = $("user-list");
  list.replaceChildren();
  for (const user of data.users) {
    const row = document.createElement("div");
    row.className = `user-row${user.enabled ? "" : " user-disabled"}`;
    const meta = document.createElement("div");
    meta.className = "user-meta";
    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = user.username;
    const detail = document.createElement("div");
    detail.className = "user-detail muted";
    const state = user.pendingApproval ? "待启用" : user.enabled ? "已启用" : "已禁用";
    detail.textContent = `${user.role === "admin" ? "管理员" : "用户"} · ${state}`;
    meta.append(name, detail);
    const actions = document.createElement("div");
    actions.className = "item-actions";
    const edit = actionButton("编辑用户", "pencil", () => {
      $("user-id").value = user.id;
      $("user-name").value = user.username;
      $("user-password").value = "";
      $("user-password").required = false;
      $("user-password-label").textContent = "新密码（留空则不修改）";
      $("user-role").value = user.role;
      $("user-enabled").checked = user.enabled;
      $("user-submit-label").textContent = "保存修改";
      $("user-cancel").hidden = false;
      $("user-name").focus();
    });
    const toggle = actionButton(user.enabled ? "禁用用户" : "启用用户", user.enabled ? "user-x" : "user-check", async () => {
      await api(`/api/users/${user.id}`, { method: "PATCH", data: { enabled: !user.enabled } });
      await loadUsers();
    });
    const remove = actionButton("删除用户", "trash-2", async () => {
      if (!await confirmDelete(`删除用户 ${user.username}？`)) return;
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      await loadUsers();
    }, true);
    if (user.id === session.user.id) {
      toggle.disabled = true;
      remove.disabled = true;
    }
    actions.append(edit, toggle, remove);
    row.append(meta, actions);
    list.append(row);
  }
  renderIcons();
}

function showCopyFeedback(button, status, popover) {
  if (!button) return;
  clearTimeout(copyFeedbackTimers.get(button));
  status.textContent = "已复制";
  if (popover) {
    button.dataset.copyFeedback = "已复制";
    button.classList.add("copy-confirmed");
  }
  copyFeedbackTimers.set(button, setTimeout(() => {
    button.classList.remove("copy-confirmed");
    delete button.dataset.copyFeedback;
    status.textContent = "";
    copyFeedbackTimers.delete(button);
  }, 1600));
}

async function copy(value, button, status) {
  await navigator.clipboard.writeText(value);
  showCopyFeedback(button, status || $("copy-notice"), !status);
}

function requireMatchingPasswords(passwordId, confirmationId) {
  if ($(passwordId).value !== $(confirmationId).value) throw new Error("两次输入的密码不一致");
}

async function initializeAuth() {
  const path = location.pathname;
  const view = path === "/register" ? "register" : path === "/reset-password" ? "reset" : "login";
  for (const name of ["login", "register", "reset"]) $(`${name}-view`).hidden = name !== view;
  document.title = `${view === "register" ? "注册" : view === "reset" ? "重置密码" : "登录"} | EasyDrop`;
  for (const name of ["login", "register"]) {
    const tab = $(`${name}-tab`);
    if (name === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }

  const authConfig = await api("/api/auth/config");
  $("register-tab").hidden = !authConfig.registrationEnabled;
  if (view === "register" && !authConfig.registrationEnabled) {
    $("register-form").hidden = true;
    $("registration-closed").hidden = false;
  }

  $("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      await api("/api/login", {
        method: "POST",
        data: { username: $("username").value, password: $("password").value },
      });
      $("password").value = "";
      const downloadPath = requestedDownloadPath();
      if (!downloadPath) {
        location.replace("/");
        return;
      }
      notice("登录成功，正在下载文件");
      const link = document.createElement("a");
      link.href = downloadPath;
      link.download = "";
      link.hidden = true;
      document.body.append(link);
      link.click();
      setTimeout(() => location.replace("/"), 500);
    });
  });

  $("register-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      requireMatchingPasswords("register-password", "register-password-confirm");
      const result = await api("/api/register", {
        method: "POST",
        data: {
          username: $("register-username").value,
          password: $("register-password").value,
        },
      });
      $("register-form").reset();
      $("register-form").hidden = true;
      $("registration-recovery-code").textContent = result.recoveryCode;
      $("registration-result").hidden = false;
      notice("");
    });
  });
  $("copy-registration-code").addEventListener("click", () => busy($("copy-registration-code"), () =>
    copy($("registration-recovery-code").textContent, $("copy-registration-code"), $("registration-copy-notice"))));

  $("reset-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      requireMatchingPasswords("reset-password", "reset-password-confirm");
      await api("/api/password/reset", {
        method: "POST",
        data: {
          username: $("reset-username").value,
          recoveryCode: $("recovery-code").value,
          newPassword: $("reset-password").value,
        },
      });
      $("reset-form").reset();
      $("reset-form").hidden = true;
      notice("密码已重置，请返回登录");
    });
  });
}

function temporaryShareActive(item) {
  return Number(item?.share_expires_at) > Math.floor(Date.now() / 1000);
}

function renderTemporaryShare(item, result = null) {
  const expiresAt = result?.expiresAt || item.share_expires_at;
  const active = Number(expiresAt) > Math.floor(Date.now() / 1000);
  $("temporary-share-file").textContent = item.name;
  $("temporary-share-status").textContent = active
    ? `当前链接有效至 ${new Date(expiresAt * 1000).toLocaleString()}`
    : "当前未启用临时访问";
  $("temporary-share-actions").hidden = !active && !result;
  $("temporary-share-revoke").hidden = !active;
  $("temporary-share-result").hidden = !result;
  $("temporary-share-copy").hidden = !result;
  $("temporary-share-notice").textContent = "";
  if (!result) {
    $("temporary-share-url").removeAttribute("href");
    $("temporary-share-url").textContent = "";
    $("temporary-share-expiry").textContent = "";
    return;
  }
  $("temporary-share-url").href = result.url;
  $("temporary-share-url").textContent = result.url;
  $("temporary-share-expiry").textContent = `有效至 ${new Date(result.expiresAt * 1000).toLocaleString()}`;
  $("temporary-share-qr").hidden = false;
  QRCode.toCanvas($("temporary-share-qr"), result.url, { width: 200, margin: 2 }).catch((error) => {
    console.error("Temporary file QR generation failed:", error);
    $("temporary-share-qr").hidden = true;
  });
}

function openTemporaryShare(item) {
  temporaryShareItem = item;
  $("temporary-share-form").reset();
  renderTemporaryShare(item);
  $("temporary-share-dialog").showModal();
}

function historyRow(item) {
  const row = document.createElement("article");
  row.className = "history-item";
  row.dataset.id = item.id;
  const content = document.createElement("div");
  content.className = "item-content";
  const time = document.createElement("time");
  time.className = "muted";
  time.dateTime = new Date(item.created_at * 1000).toISOString();
  time.textContent = new Date(item.created_at * 1000).toLocaleString();
  const body = document.createElement("p");
  body.className = item.type === "text" ? "item-text" : "item-name";
  if (item.type === "text") appendLinkifiedText(body, item.content);
  else body.textContent = `${item.name} (${size(item.size)})`;
  content.append(time, body);
  const actions = document.createElement("div");
  actions.className = "item-actions";
  if (item.type === "text") {
    actions.append(actionButton("复制文本", "copy", (button) => copy(item.content, button)));
  } else {
    const fileUrl = new URL(`/uploads/${item.id}/${encodeURIComponent(item.name)}`, location.origin).href;
    if (item.media_type) {
      const thumbnailLink = document.createElement("a");
      thumbnailLink.className = "thumbnail-link";
      thumbnailLink.href = fileUrl;
      thumbnailLink.target = "_blank";
      thumbnailLink.rel = "noopener";
      thumbnailLink.title = "下载图片";
      thumbnailLink.setAttribute("aria-label", `下载图片 ${item.name}`);
      const thumbnail = document.createElement("img");
      thumbnail.className = "file-thumbnail";
      thumbnail.src = `/previews/${item.id}`;
      thumbnail.alt = `${item.name} 缩略图`;
      thumbnail.loading = "lazy";
      thumbnail.decoding = "async";
      thumbnail.addEventListener("error", () => thumbnailLink.remove(), { once: true });
      thumbnailLink.append(thumbnail);
      content.insertBefore(thumbnailLink, body);
    }
    const preview = document.createElement("div");
    preview.className = "file-link-preview";
    const link = document.createElement("a");
    link.className = "icon-button";
    link.href = fileUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "打开文件链接";
    link.setAttribute("aria-label", "打开文件链接");
    link.append(icon("link"));
    const qr = document.createElement("div");
    qr.className = "qr-popover file-link-qr";
    const canvas = document.createElement("canvas");
    canvas.width = 168;
    canvas.height = 168;
    canvas.setAttribute("aria-label", `${item.name} 文件链接二维码`);
    const hint = document.createElement("span");
    hint.textContent = "扫码后登录下载";
    qr.append(canvas, hint);
    preview.append(link, qr);
    QRCode.toCanvas(canvas, fileUrl, { width: 168, margin: 1 }).catch((error) => {
      console.error("File QR generation failed:", error);
      qr.remove();
    });
    const temporaryShare = actionButton(
      temporaryShareActive(item) ? "管理临时链接" : "创建临时链接",
      "share-2",
      () => openTemporaryShare(item),
    );
    temporaryShare.classList.toggle("active-share", temporaryShareActive(item));
    actions.append(preview, actionButton("复制文件链接", "copy", (button) => copy(fileUrl, button)), temporaryShare);
  }
  actions.append(actionButton("删除记录", "trash-2", async () => {
    if (!await confirmDelete("删除这条记录？")) return;
    await api(`/api/history/${item.id}`, { method: "DELETE" });
    notice("已删除");
    await loadHistory();
  }, true));
  row.append(icon(item.type === "text" ? "file-text" : "files"), content, actions);
  return row;
}

function historyItemSnapshot(item) {
  return {
    type: item.type,
    content: item.content,
    name: item.name,
    size: item.size,
    mediaType: item.media_type,
    createdAt: item.created_at,
    shareExpiresAt: item.share_expires_at,
  };
}

function sameHistoryItem(snapshot, item) {
  return snapshot.type === item.type &&
    snapshot.content === item.content &&
    snapshot.name === item.name &&
    snapshot.size === item.size &&
    snapshot.mediaType === item.media_type &&
    snapshot.createdAt === item.created_at &&
    snapshot.shareExpiresAt === item.share_expires_at;
}

function cachedHistoryRow(item) {
  const cached = historyRowCache.get(item.id);
  if (cached && sameHistoryItem(cached.item, item)) return cached.row;
  const row = historyRow(item);
  historyRowCache.set(item.id, { item: historyItemSnapshot(item), row });
  return row;
}

function pruneHistoryRowCache() {
  const visible = new Set(Array.from($("history-list").querySelectorAll(".history-item"), (row) => row.dataset.id));
  for (const id of historyRowCache.keys()) if (!visible.has(id)) historyRowCache.delete(id);
}

async function loadHistory(more = false) {
  if (sessionEnded) return;
  if (loading) {
    if (!more) pendingRefresh = true;
    return;
  }
  loading = true;
  $("load-more").disabled = true;
  try {
    const data = await api(`/api/history${more && nextCursor ? `?before=${nextCursor}` : ""}`);
    if (sessionEnded) return;
    if (more && data.revision !== currentRevision) markHistoryUpdate();
    const list = $("history-list");
    const existing = new Set(Array.from(list.querySelectorAll("[data-id]"), (row) => row.dataset.id));
    if (!more) {
      expandedHistory = false;
      $("refresh").classList.remove("has-updates");
      $("refresh").title = "刷新历史";
      currentRevision = data.revision;
    }
    if (more) expandedHistory = true;
    const fragment = document.createDocumentFragment();
    for (const item of data.items) {
      if (!more || !existing.has(item.id)) fragment.append(cachedHistoryRow(item));
    }
    if (more) list.append(fragment);
    else list.replaceChildren(fragment);
    nextCursor = data.nextCursor;
    const count = list.querySelectorAll(".history-item").length;
    $("history-count").textContent = count ? `${count}${nextCursor ? "+" : ""}` : "";
    if (!count) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "暂无分享记录";
      list.append(empty);
    }
    $("load-more").hidden = !nextCursor;
    if (!retainHistoryRows) pruneHistoryRowCache();
    renderIcons();
  } finally {
    loading = false;
    $("load-more").disabled = false;
    if (pendingRefresh && !sessionEnded) {
      pendingRefresh = false;
      await loadHistory();
    }
  }
}

function markHistoryUpdate() {
  $("refresh").classList.add("has-updates");
  $("refresh").title = "分享历史有更新";
}

function visibleHistoryAnchors() {
  const viewportTop = document.querySelector("header")?.getBoundingClientRect().bottom || 0;
  return Array.from($("history-list").querySelectorAll(".history-item")).flatMap((row) => {
    const bounds = row.getBoundingClientRect();
    return bounds.bottom > viewportTop && bounds.top < innerHeight
      ? [{ id: row.dataset.id, top: bounds.top }]
      : [];
  });
}

async function refreshHistoryPreservingPosition() {
  const loadedCount = $("history-list").querySelectorAll(".history-item").length;
  const restoreExpanded = expandedHistory;
  const anchors = visibleHistoryAnchors();
  retainHistoryRows = true;
  try {
    await loadHistory();
    while (restoreExpanded && nextCursor &&
        $("history-list").querySelectorAll(".history-item").length < loadedCount) {
      await loadHistory(true);
    }
    for (const anchor of anchors) {
      const row = Array.from($("history-list").querySelectorAll(".history-item"))
        .find((item) => item.dataset.id === anchor.id);
      if (!row) continue;
      scrollBy(0, row.getBoundingClientRect().top - anchor.top);
      break;
    }
  } finally {
    retainHistoryRows = false;
    pruneHistoryRowCache();
  }
}

function schedulePoll(delaySeconds = session?.pollSeconds) {
  clearTimeout(pollTimer);
  if (pollingStopped || !session || document.hidden) return;
  pollTimer = setTimeout(() => { void checkForHistoryUpdates(); }, delaySeconds * 1000);
}

async function checkForHistoryUpdates() {
  clearTimeout(pollTimer);
  if (pollingStopped || !session || document.hidden || revisionCheckRunning) return;
  if (uploading || loading) {
    schedulePoll();
    return;
  }
  revisionCheckRunning = true;
  let updated = false;
  try {
    const state = await api("/api/revision");
    if (state.revision !== currentRevision) {
      await refreshHistoryPreservingPosition();
      updated = true;
    }
    if (updated) notice("分享历史已自动更新");
    else if (pollFailureCount) notice("同步已恢复");
    pollFailureCount = 0;
  } catch (error) {
    if (!sessionEnded) {
      pollFailureCount++;
      report(error);
    }
  } finally {
    revisionCheckRunning = false;
    const exponent = Math.max(0, Math.min(pollFailureCount - 1, 10));
    const delay = pollFailureCount
      ? Math.min(session?.pollSeconds * (2 ** exponent), maxPollRetrySeconds)
      : session?.pollSeconds;
    schedulePoll(delay);
  }
}

function savedUploads() {
  try {
    const records = JSON.parse(localStorage.getItem(uploadStorageKey()) || "[]");
    const oldest = Date.now() - 7 * 86400 * 1000;
    return Array.isArray(records) ? records.filter((record) =>
      typeof record.key === "string" && typeof record.name === "string" &&
      Number.isSafeInteger(record.size) && Number.isSafeInteger(record.lastModified) &&
      Number(record.updatedAt) >= oldest) : [];
  } catch {
    return [];
  }
}

function saveUpload(entry) {
  try {
    const records = savedUploads().filter((record) => record.key !== entry.key);
    records.push({
      key: entry.key,
      id: entry.id || null,
      name: entry.file.name,
      size: entry.file.size,
      lastModified: entry.file.lastModified,
      chunkSize: entry.chunkSize || null,
      fileFingerprint: entry.fileFingerprint || null,
      updatedAt: Date.now(),
    });
    localStorage.setItem(uploadStorageKey(), JSON.stringify(records));
  } catch {
    // Upload still resumes within this page when persistent browser storage is unavailable.
  }
}

function forgetUpload(key) {
  try {
    localStorage.setItem(uploadStorageKey(), JSON.stringify(savedUploads().filter((record) => record.key !== key)));
  } catch {
    // Expired server-side upload state is cleaned independently.
  }
}

function uploadButton(name, label, disabled = false) {
  const button = $("upload");
  button.replaceChildren(icon(name), label);
  button.disabled = disabled;
  renderIcons();
}

function updateUploadControls() {
  const pending = uploadQueue.some((entry) => !entry.done);
  if (uploading) {
    uploadButton("pause", pauseRequested ? "正在暂停" : "暂停上传", pauseRequested);
  } else {
    const started = uploadQueue.some((entry) => !entry.done && entry.started);
    uploadButton(started ? "play" : "upload", started ? "继续上传" : "上传文件", !pending);
  }
  $("file-input").disabled = uploading;
  $("clear").disabled = uploading || !session;
}

function makeUploadRow(file, saved) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "upload-row";
  const name = document.createElement("span");
  name.className = "upload-name";
  name.textContent = `${file.name} (${size(file.size)})`;
  const state = document.createElement("span");
  state.className = "muted";
  state.textContent = saved ? "可恢复" : "待上传";
  const progress = document.createElement("progress");
  progress.max = 100;
  progress.value = 0;
  progress.setAttribute("aria-label", `${file.name} 上传进度`);
  row.append(name, state);
  li.append(row, progress);
  $("upload-list").append(li);
  const entry = {
    file,
    state,
    progress,
    done: false,
    started: Boolean(saved),
    key: saved?.key || crypto.randomUUID(),
    id: saved?.id || null,
    chunkSize: saved?.chunkSize || null,
    fileFingerprint: saved?.fileFingerprint || null,
    partChecksums: new Map(),
    completed: new Map(),
    inFlight: new Map(),
  };
  saveUpload(entry);
  return entry;
}

async function partChecksum(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createImagePreview(file) {
  if (!previewSourceTypes.has(file.type.toLowerCase()) && !previewSourceExtension.test(file.name)) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (!bitmap.width || !bitmap.height) return null;
    const scale = Math.min(1, previewMaxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const preview = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    return preview?.type === "image/webp" && preview.size <= previewMaxBytes ? preview : null;
  } catch (error) {
    console.warn(`Thumbnail generation skipped for ${file.name}:`, error);
    return null;
  } finally {
    bitmap?.close();
  }
}

async function uploadImagePreview(entry, preview) {
  return api(`/api/uploads/${entry.id}/preview`, {
    method: "PUT",
    payload: preview,
    contentType: "image/webp",
  });
}

async function prepareFile(entry) {
  const chunkSize = session.uploadChunkBytes;
  const totalParts = Math.ceil(entry.file.size / chunkSize);
  const checksums = [];
  for (let index = 0; index < totalParts; index++) {
    if (pauseRequested) throw new UploadPaused("Upload paused.");
    entry.state.textContent = `校验文件 ${index + 1}/${totalParts}`;
    checksums.push(await partChecksum(entry.file.slice(index * chunkSize, Math.min((index + 1) * chunkSize, entry.file.size))));
  }
  const manifest = JSON.stringify(["multipart-file-v1", entry.file.size, chunkSize, checksums]);
  const fileFingerprint = await partChecksum(new Blob([manifest]));
  if (entry.fileFingerprint && (entry.fileFingerprint !== fileFingerprint || entry.chunkSize !== chunkSize)) {
    forgetUpload(entry.key);
    entry.key = crypto.randomUUID();
    entry.id = null;
  }
  entry.chunkSize = chunkSize;
  entry.fileFingerprint = fileFingerprint;
  entry.partChecksums = new Map(checksums.map((checksum, index) => [index + 1, checksum]));
  saveUpload(entry);
  return { chunkSize, fileFingerprint };
}

function updateUploadProgress(entry) {
  if (entry.file.size === 0) {
    entry.progress.value = entry.done ? 100 : 0;
    return;
  }
  const completed = Array.from(entry.completed.values()).reduce((total, bytes) => total + bytes, 0);
  const inFlight = Array.from(entry.inFlight.values()).reduce((total, bytes) => total + bytes, 0);
  entry.progress.value = Math.min(100, Math.round((completed + inFlight) / entry.file.size * 100));
}

function uploadPart(entry, partNumber, blob, checksum) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeUploads.add(xhr);
    const path = `/api/uploads/${entry.id}/parts/${partNumber}`;
    xhr.open("PUT", path);
    xhr.timeout = 30 * 60 * 1000;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Part-SHA256", checksum);
    xhr.setRequestHeader("X-CSRF-Token", session.csrfToken);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      entry.inFlight.set(partNumber, event.loaded);
      updateUploadProgress(entry);
    };
    xhr.onloadend = () => {
      activeUploads.delete(xhr);
      entry.inFlight.delete(partNumber);
      updateUploadProgress(entry);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(apiError("PUT", path, xhr.status, xhr.responseText));
      try {
        if (!JSON.parse(xhr.responseText).success) throw new Error();
      } catch { return reject(apiError("PUT", path, xhr.status, xhr.responseText)); }
      entry.inFlight.delete(partNumber);
      entry.completed.set(partNumber, blob.size);
      updateUploadProgress(entry);
      resolve();
    };
    xhr.onerror = () => reject(new Error(`PUT ${path}: ${entry.file.name} 网络错误`));
    xhr.ontimeout = () => reject(new Error(`PUT ${path}: ${entry.file.name} 分片上传超时`));
    xhr.onabort = () => reject(pauseRequested ? new UploadPaused("Upload paused.") : new Error(`PUT ${path}: ${entry.file.name} 上传中止`));
    xhr.send(blob);
  });
}

async function uploadFile(entry) {
  entry.started = true;
  saveUpload(entry);
  entry.state.textContent = "生成缩略图";
  const preview = await createImagePreview(entry.file);
  const prepared = await prepareFile(entry);
  entry.state.textContent = entry.id ? "检查恢复点" : "初始化";
  const upload = await api("/api/uploads", {
    method: "POST",
    data: {
      name: entry.file.name,
      size: entry.file.size,
      mediaType: entry.file.type,
      chunkSize: prepared.chunkSize,
      fileFingerprint: prepared.fileFingerprint,
    },
    operationKey: entry.key,
  });
  entry.id = upload.id;
  saveUpload(entry);
  if (preview) {
    entry.state.textContent = "上传缩略图";
    try {
      await uploadImagePreview(entry, preview);
    } catch (error) {
      if (sessionEnded) throw error;
      entry.previewFailed = true;
      console.error("Image preview upload failed:", error.details || error);
    }
  }
  if (upload.complete) {
    entry.done = true;
    entry.progress.value = 100;
    entry.state.textContent = entry.previewFailed ? "已上传（无缩略图）" : "已上传";
    forgetUpload(entry.key);
    return;
  }
  if (upload.chunkSize !== prepared.chunkSize) throw new Error("服务端分片配置已变化，请重新选择文件。");

  const remote = new Map(upload.uploadedParts.map((part) => [part.partNumber, part]));
  entry.completed.clear();
  entry.inFlight.clear();
  let cursor = 1;
  let firstError;

  const processPart = async (partNumber) => {
    const start = (partNumber - 1) * upload.chunkSize;
    const end = Math.min(start + upload.chunkSize, entry.file.size);
    const blob = entry.file.slice(start, end);
    const checksum = entry.partChecksums.get(partNumber);
    const stored = remote.get(partNumber);
    if (stored?.size === blob.size && stored.sha256 === checksum) {
      entry.completed.set(partNumber, blob.size);
      updateUploadProgress(entry);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (pauseRequested) throw new UploadPaused("Upload paused.");
      entry.state.textContent = attempt === 1
        ? `上传分片 ${partNumber}/${upload.totalParts}`
        : `重试分片 ${partNumber}/${upload.totalParts} (${attempt}/3)`;
      try {
        await uploadPart(entry, partNumber, blob, checksum);
        return;
      } catch (error) {
        const retryable = !error.status || error.status === 429 || error.status >= 500;
        if (error instanceof UploadPaused || sessionEnded || !retryable || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
  };

  const worker = async () => {
    while (!pauseRequested && !firstError) {
      const partNumber = cursor++;
      if (partNumber > upload.totalParts) return;
      try {
        await processPart(partNumber);
      } catch (error) {
        firstError ||= error;
      }
    }
  };
  const concurrency = Math.min(upload.uploadConcurrency || session.uploadConcurrency || 1, upload.totalParts);
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (firstError) throw firstError;
  if (pauseRequested) throw new UploadPaused("Upload paused.");

  if (upload.totalParts > 1) entry.state.textContent = "正在合并";
  await api(`/api/uploads/${entry.id}/complete`, { method: "POST" });
  entry.done = true;
  entry.progress.value = 100;
  entry.state.textContent = entry.previewFailed ? "已上传（无缩略图）" : "已上传";
  forgetUpload(entry.key);
}

async function startUpload() {
  if (uploading || !session) return;
  uploading = true;
  pauseRequested = false;
  updateUploadControls();
  let failures = 0;
  let paused = false;
  const errors = [];
  try {
    for (const entry of uploadQueue.filter((item) => !item.done)) {
      if (!session) break;
      try {
        if (entry.file.size > session.maxUploadBytes) throw new Error(`${entry.file.name} 超过单文件上限`);
        await uploadFile(entry);
        if (pauseRequested) {
          paused = true;
          break;
        }
      } catch (error) {
        if (error instanceof UploadPaused) {
          entry.state.textContent = "已暂停";
          paused = true;
          break;
        }
        failures++;
        entry.state.textContent = "失败";
        errors.push(error.details || error.message);
      }
    }
    if (failures) {
      const error = new Error(`${failures} 个文件上传失败`);
      error.details = errors.join("\n\n");
      report(error);
    } else if (paused && session) notice("上传已暂停");
    else if (session) notice("上传完成");
    if (session) await loadHistory();
  } catch (error) {
    report(error);
  } finally {
    uploading = false;
    pauseRequested = false;
    updateUploadControls();
    if (uploadQueue.every((item) => item.done)) $("file-input").value = "";
  }
}

function pauseUpload() {
  if (!uploading || pauseRequested) return;
  pauseRequested = true;
  updateUploadControls();
  for (const xhr of activeUploads) xhr.abort();
}

async function initializeApp() {
  session = await api("/api/session");
  $("users-open").hidden = session.user.role !== "admin";
  $("upload-limit").textContent = `单文件上限 ${size(session.maxUploadBytes)}`;
  const updateCount = () => {
    const bytes = new TextEncoder().encode($("text-input").value).length;
    $("text-count").textContent = `${size(bytes)} / ${size(session.maxTextBytes)}`;
    $("text-form").querySelector("button").disabled = textSubmitting || !$("text-input").value.trim() || bytes > session.maxTextBytes;
  };
  $("text-input").addEventListener("input", updateCount);
  updateCount();
  $("refresh").disabled = false;
  $("clear").disabled = false;
  updateUploadControls();
  $("text-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (textSubmitting || !session) return;
    textSubmitting = true;
    const button = $("text-form").querySelector("button");
    await busy(button, async () => {
      const text = $("text-input").value;
      if (!textOperation || textOperation.text !== text) textOperation = { text, key: crypto.randomUUID() };
      await api("/api/text", { method: "POST", data: { text }, operationKey: textOperation.key });
      textOperation = null;
      if ($("text-input").value === text) $("text-input").value = "";
      notice("已分享");
      await loadHistory();
    });
    textSubmitting = false;
    if (session) updateCount();
  });
  $("file-input").addEventListener("change", () => {
    $("upload-list").replaceChildren();
    const records = savedUploads();
    const used = new Set();
    uploadQueue = Array.from($("file-input").files).map((file) => {
      const saved = records.find((record) =>
        !used.has(record.key) && record.name === file.name && record.size === file.size &&
        record.lastModified === file.lastModified);
      if (saved) used.add(saved.key);
      return makeUploadRow(file, saved);
    });
    $("file-count").textContent = uploadQueue.length ? `${uploadQueue.length} 个文件` : "未选择文件";
    updateUploadControls();
  });
  $("upload").addEventListener("click", () => uploading ? pauseUpload() : startUpload());
  $("refresh").addEventListener("click", () => busy($("refresh"), async () => {
    await loadHistory();
    notice("已刷新");
    pollingStopped = false;
    pollFailureCount = 0;
    schedulePoll();
  }));
  $("load-more").addEventListener("click", () => loadHistory(true).catch(report));
  $("clear").addEventListener("click", () => busy($("clear"), async () => {
    if (uploading) return;
    if (!await confirmDelete("清空所有分享记录和文件？")) return;
    await api("/api/clear_history", { method: "POST" });
    await loadHistory();
    notice("已清空");
  }));
  $("logout").addEventListener("click", () => busy($("logout"), async () => {
    await api("/api/logout", { method: "POST" });
    expireSession();
  }));
  $("account-open").addEventListener("click", () => {
    $("password-form").reset();
    $("recovery-form").reset();
    $("account-recovery-result").hidden = true;
    $("account-recovery-code").textContent = "";
    $("account-recovery-notice").textContent = "";
    $("account-username").textContent = session.user.username;
    $("recovery-status").textContent = session.user.hasRecoveryCode
      ? "已设置恢复码"
      : "尚未设置恢复码";
    $("recovery-submit-label").textContent = session.user.hasRecoveryCode ? "重新生成恢复码" : "生成恢复码";
    $("account-dialog").showModal();
  });
  $("account-close").addEventListener("click", () => $("account-dialog").close());
  $("password-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      requireMatchingPasswords("new-password", "new-password-confirm");
      await api("/api/account/password", {
        method: "POST",
        data: {
          currentPassword: $("current-password").value,
          newPassword: $("new-password").value,
        },
      });
      expireSession();
    });
  });
  $("recovery-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      const result = await api("/api/account/recovery-code", {
        method: "POST",
        data: { currentPassword: $("recovery-current-password").value },
      });
      $("recovery-form").reset();
      $("account-recovery-code").textContent = result.recoveryCode;
      $("account-recovery-result").hidden = false;
      $("recovery-status").textContent = "恢复码已更新";
      $("recovery-submit-label").textContent = "重新生成恢复码";
      session.user.hasRecoveryCode = true;
    });
  });
  $("copy-account-recovery").addEventListener("click", () => busy($("copy-account-recovery"), () =>
    copy($("account-recovery-code").textContent, $("copy-account-recovery"), $("account-recovery-notice"))));
  $("delete-account-open").addEventListener("click", () => {
    $("delete-account-form").reset();
    $("account-dialog").close();
    $("delete-account-dialog").showModal();
  });
  $("delete-account-close").addEventListener("click", () => $("delete-account-dialog").close());
  $("delete-account-cancel").addEventListener("click", () => $("delete-account-dialog").close());
  $("delete-account-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      await api("/api/account", {
        method: "DELETE",
        data: {
          username: $("delete-account-username").value,
          currentPassword: $("delete-account-password").value,
        },
      });
      expireSession();
    });
  });
  $("site-url-preview").textContent = location.origin;
  QRCode.toCanvas($("site-qr-preview"), location.origin, { width: 168, margin: 1 }).catch((error) => {
    console.error("Site QR preview generation failed:", error);
    $("site-link-popover").remove();
  });
  $("qr-open").addEventListener("click", () => busy($("qr-open"), async () => {
    $("site-url").textContent = location.origin;
    $("site-copy-notice").textContent = "";
    await QRCode.toCanvas($("qr-canvas"), location.origin, { width: 200, margin: 2 });
    $("qr-dialog").showModal();
  }));
  $("qr-close").addEventListener("click", () => $("qr-dialog").close());
  $("copy-url").addEventListener("click", () => busy($("copy-url"), () =>
    copy(location.origin, $("copy-url"), $("site-copy-notice"))));
  $("temporary-share-close").addEventListener("click", () => $("temporary-share-dialog").close());
  $("temporary-share-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      if (!temporaryShareItem) return;
      const item = temporaryShareItem;
      const result = await api(`/api/history/${item.id}/share`, {
        method: "POST",
        data: { hours: Number($("temporary-share-hours").value) },
      });
      item.share_expires_at = result.expiresAt;
      renderTemporaryShare(item, result);
      notice("临时链接已创建");
      await loadHistory();
    });
  });
  $("temporary-share-copy").addEventListener("click", () => busy($("temporary-share-copy"), () =>
    copy($("temporary-share-url").href, $("temporary-share-copy"), $("temporary-share-notice"))));
  $("temporary-share-revoke").addEventListener("click", () => busy($("temporary-share-revoke"), async () => {
    if (!temporaryShareItem) return;
    await api(`/api/history/${temporaryShareItem.id}/share`, { method: "DELETE" });
    temporaryShareItem.share_expires_at = null;
    renderTemporaryShare(temporaryShareItem);
    notice("临时链接已撤销");
    await loadHistory();
  }));
  $("users-open").addEventListener("click", () => busy($("users-open"), async () => {
    resetUserForm();
    await loadUsers();
    $("users-dialog").showModal();
  }));
  $("users-close").addEventListener("click", () => $("users-dialog").close());
  $("registration-enabled").addEventListener("change", async () => {
    const input = $("registration-enabled");
    const enabled = input.checked;
    input.disabled = true;
    try {
      await api("/api/settings/registration", { method: "PATCH", data: { enabled } });
      notice(enabled ? "已开放自助注册" : "已关闭自助注册");
    } catch (error) {
      input.checked = !enabled;
      report(error);
    } finally {
      input.disabled = false;
    }
  });
  $("user-cancel").addEventListener("click", resetUserForm);
  $("user-form").addEventListener("submit", (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      const id = $("user-id").value;
      const data = {
        username: $("user-name").value,
        role: $("user-role").value,
        enabled: $("user-enabled").checked,
      };
      if ($("user-password").value) data.password = $("user-password").value;
      const result = await api(id ? `/api/users/${id}` : "/api/users", {
        method: id ? "PATCH" : "POST",
        data,
      });
      if (result.signedOut) {
        expireSession();
        return;
      }
      resetUserForm();
      await loadUsers();
      notice(id ? "用户已更新并下线" : "用户已添加");
    });
  });
  window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
  const pollWhenActive = () => {
    if (!document.hidden) void checkForHistoryUpdates();
  };
  document.addEventListener("visibilitychange", pollWhenActive);
  window.addEventListener("focus", pollWhenActive);
  window.addEventListener("online", pollWhenActive);
  window.addEventListener("beforeunload", (event) => {
    if (uploading || textSubmitting) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  await loadHistory();
  notice("");
  schedulePoll();
}

renderIcons();
if (isLogin) initializeAuth().catch(report);
else initializeApp().catch(report);
