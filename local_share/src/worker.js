import {
  HttpError, configuration, digest, getSession, localHttp, login, now, readJson,
  requireCsrf, sessionCookie,
} from "./auth.js";

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const revision = (env) => env.DB.prepare("UPDATE app_state SET revision = revision + 1 WHERE id = 1 AND changes() > 0");
const objectKey = (id) => `files/${id}`;
const validId = (id) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const encoder = new TextEncoder();
const sha256 = async (value) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", value)),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");

function validateFile(name, size, config) {
  if (typeof name !== "string" || !name.trim() || encoder.encode(name).length > 255 ||
      /[\/\\\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(400, "Invalid filename (maximum 255 UTF-8 bytes; no paths or control characters).");
  }
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "Invalid file size.");
  if (size > config.uploadLimit) throw new HttpError(413, `File exceeds ${config.uploadLimit} bytes.`);
}

function harden(response, request) {
  const result = new Response(response.body, response);
  const publicAsset = ["/assets/app.js", "/assets/style.css"].includes(new URL(request.url).pathname);
  result.headers.set("Cache-Control", publicAsset && (response.ok || response.status === 304) ? "public, max-age=0, must-revalidate" : "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("X-Frame-Options", "DENY");
  result.headers.set("Referrer-Policy", "no-referrer");
  result.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  result.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  result.headers.set("Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
  if (new URL(request.url).protocol === "https:") {
    result.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  return result;
}

async function asset(request, env, path) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const headers = new Headers();
  for (const name of ["If-None-Match", "If-Modified-Since"]) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  }
  return env.ASSETS.fetch(new Request(url, { method: request.method, headers }));
}

async function beginOperation(request, env, fingerprint) {
  const key = request.headers.get("Idempotency-Key") || crypto.randomUUID();
  if (!validId(key)) throw new HttpError(400, "Idempotency-Key must be a UUID v4.");
  const id = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    "INSERT OR IGNORE INTO operations(request_key, fingerprint, item_id, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
  ).bind(key, fingerprint, id, now()).run();
  if (claimed.meta.changes) return { id, key };
  const previous = await env.DB.prepare("SELECT * FROM operations WHERE request_key = ?").bind(key).first();
  if (!previous || previous.fingerprint !== fingerprint) throw new HttpError(409, "Idempotency key belongs to different content.");
  if (previous.state === "failed") {
    const retry = await env.DB.prepare(
      "UPDATE operations SET state = 'pending', item_id = ?, created_at = ? WHERE request_key = ? AND state = 'failed' AND item_id = ?",
    ).bind(id, now(), key, previous.item_id).run();
    if (retry.meta.changes) return { id, key };
  }
  if (previous.state !== "done") {
    throw new HttpError(409, "Operation is still processing. Retry later with the same key.");
  }
  const item = await env.DB.prepare("SELECT id FROM items WHERE id = ? AND state = 'ready'").bind(previous.item_id).first();
  if (!item) throw new HttpError(410, "This operation completed but its item has been deleted.");
  return { id: previous.item_id, key, replay: true };
}

async function beginMultipartOperation(request, env, fingerprint) {
  const key = request.headers.get("Idempotency-Key") || crypto.randomUUID();
  if (!validId(key)) throw new HttpError(400, "Idempotency-Key must be a UUID v4.");
  const id = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    "INSERT OR IGNORE INTO operations(request_key, fingerprint, item_id, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
  ).bind(key, fingerprint, id, now()).run();
  if (claimed.meta.changes) return { id, key };

  const previous = await env.DB.prepare("SELECT * FROM operations WHERE request_key = ?").bind(key).first();
  if (!previous || previous.fingerprint !== fingerprint) throw new HttpError(409, "Idempotency key belongs to different content.");
  if (previous.state === "done") {
    const item = await env.DB.prepare("SELECT id FROM items WHERE id = ? AND state = 'ready'").bind(previous.item_id).first();
    if (!item) throw new HttpError(410, "This operation completed but its item has been deleted.");
    return { id: previous.item_id, key, replay: true };
  }
  if (previous.state === "pending") {
    const active = await env.DB.prepare(
      `SELECT i.id, i.state, m.upload_id FROM items i
       LEFT JOIN multipart_uploads m ON m.item_id = i.id WHERE i.id = ?`,
    ).bind(previous.item_id).first();
    if (active?.state === "pending" && active.upload_id) return { id: previous.item_id, key, resume: true };
    const recovered = await env.DB.prepare(
      `UPDATE operations SET item_id = ?, created_at = ? WHERE request_key = ? AND item_id = ?
       AND state = 'pending' AND created_at < ?
       AND NOT EXISTS (SELECT 1 FROM multipart_uploads WHERE item_id = ?)`,
    ).bind(id, now(), key, previous.item_id, now() - 30, previous.item_id).run();
    if (recovered.meta.changes) {
      await env.DB.prepare("UPDATE items SET state = 'deleting' WHERE id = ? AND state != 'ready'").bind(previous.item_id).run();
      return { id, key };
    }
    throw new HttpError(409, "Upload is still being initialized. Retry later with the same key.");
  }

  const retry = await env.DB.prepare(
    "UPDATE operations SET state = 'pending', item_id = ?, created_at = ? WHERE request_key = ? AND state = 'failed' AND item_id = ?",
  ).bind(id, now(), key, previous.item_id).run();
  if (!retry.meta.changes) throw new HttpError(409, "Upload state changed. Retry later with the same key.");
  await env.DB.prepare("UPDATE items SET state = 'deleting' WHERE id = ? AND state != 'ready'").bind(previous.item_id).run();
  return { id, key };
}

async function publishFile(env, id, key) {
  const [published] = await env.DB.batch([
    env.DB.prepare(`UPDATE items SET state = 'ready' WHERE id = ? AND state = 'pending'
      AND EXISTS (SELECT 1 FROM operations WHERE request_key = ? AND item_id = ? AND state = 'pending')`).bind(id, key, id),
    revision(env),
    env.DB.prepare(`UPDATE operations SET state = 'done' WHERE request_key = ? AND item_id = ?
      AND EXISTS (SELECT 1 FROM items WHERE id = ? AND state = 'ready')`).bind(key, id, id),
    env.DB.prepare(`DELETE FROM multipart_parts WHERE item_id = ?
      AND EXISTS (SELECT 1 FROM items WHERE id = ? AND state = 'ready')`).bind(id, id),
    env.DB.prepare(`DELETE FROM multipart_uploads WHERE item_id = ?
      AND EXISTS (SELECT 1 FROM items WHERE id = ? AND state = 'ready')`).bind(id, id),
  ]);
  if (!published.meta.changes) throw new HttpError(409, "Upload was cancelled by a history clear.");
}

async function multipartPayload(env, id, config, touch = false) {
  const item = await env.DB.prepare(
    `SELECT i.id, i.name, i.size, i.state, m.chunk_size, m.total_parts, m.updated_at, m.state AS upload_state
     FROM items i LEFT JOIN multipart_uploads m ON m.item_id = i.id
     WHERE i.id = ? AND i.type = 'file'`,
  ).bind(id).first();
  if (!item || item.state === "deleting") throw new HttpError(404, "Upload not found.");
  if (item.state === "ready") return { success: true, id, complete: true, uploadedParts: [] };
  if (!item.chunk_size) throw new HttpError(409, "Upload is still being initialized.");
  if (touch) {
    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare("UPDATE multipart_uploads SET updated_at = ? WHERE item_id = ?").bind(timestamp, id),
      env.DB.prepare(`UPDATE operations SET created_at = ? WHERE item_id = ? AND state = 'pending'`).bind(timestamp, id),
    ]);
    item.updated_at = timestamp;
  }
  const { results } = await env.DB.prepare(
    "SELECT part_number, size, checksum FROM multipart_parts WHERE item_id = ? ORDER BY part_number",
  ).bind(id).all();
  return {
    success: true,
    id,
    complete: false,
    chunkSize: item.chunk_size,
    totalParts: item.total_parts,
    uploadConcurrency: config.uploadConcurrency,
    expiresAt: item.updated_at + config.uploadSessionTtl,
    uploadedParts: results.map((part) => ({
      partNumber: part.part_number,
      size: part.size,
      sha256: part.checksum,
    })),
  };
}

async function initiateMultipart(request, env, config) {
  const data = await readJson(request, 4096);
  validateFile(data.name, data.size, config);
  if (data.chunkSize !== config.uploadChunkBytes || !/^[a-f0-9]{64}$/.test(data.fileFingerprint || "")) {
    throw new HttpError(400, "Upload chunk size or file fingerprint is invalid.");
  }
  const fingerprint = await digest(JSON.stringify([
    "multipart-file-v1", data.name, data.size, data.chunkSize, data.fileFingerprint,
  ]));
  const operation = await beginMultipartOperation(request, env, fingerprint);
  const { id, key } = operation;
  if (operation.replay) return json({ success: true, id, complete: true, replayed: true });
  if (operation.resume) return json(await multipartPayload(env, id, config, true));

  let multipart;
  try {
    await env.DB.prepare("INSERT INTO items(id, type, name, size, state, created_at) VALUES (?, 'file', ?, ?, 'pending', ?)")
      .bind(id, data.name, data.size, now()).run();
    if (data.size === 0) {
      const object = await env.FILES.put(objectKey(id), new Uint8Array(), {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      if (!object || object.size !== 0) throw new HttpError(500, "Empty file could not be stored.");
      await publishFile(env, id, key);
      return json({ success: true, id, complete: true }, 201);
    }

    multipart = await env.FILES.createMultipartUpload(objectKey(id), {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const totalParts = Math.ceil(data.size / config.uploadChunkBytes);
    const created = await env.DB.prepare(
      `INSERT INTO multipart_uploads(item_id, upload_id, operation_key, chunk_size, total_parts, state, updated_at)
       SELECT ?, ?, ?, ?, ?, 'uploading', ? WHERE EXISTS
       (SELECT 1 FROM items WHERE id = ? AND state = 'pending')`,
    ).bind(id, multipart.uploadId, key, config.uploadChunkBytes, totalParts, now(), id).run();
    if (!created.meta.changes) throw new HttpError(409, "Upload was cancelled while it was being initialized.");
    return json(await multipartPayload(env, id, config), 201);
  } catch (error) {
    if (multipart) await multipart.abort().catch(() => {});
    await env.DB.batch([
      env.DB.prepare("UPDATE items SET state = 'deleting' WHERE id = ? AND state = 'pending'").bind(id),
      env.DB.prepare("UPDATE operations SET state = 'failed' WHERE request_key = ? AND item_id = ?").bind(key, id),
    ]);
    throw error;
  }
}

async function uploadMultipartPart(request, env, id, rawPartNumber) {
  if (!validId(id) || !/^[1-9]\d*$/.test(rawPartNumber)) throw new HttpError(404, "Upload part not found.");
  const partNumber = Number(rawPartNumber);
  const upload = await env.DB.prepare(
    `SELECT i.size, i.state AS item_state, m.upload_id, m.operation_key, m.chunk_size, m.total_parts, m.state
     FROM items i JOIN multipart_uploads m ON m.item_id = i.id WHERE i.id = ?`,
  ).bind(id).first();
  if (!upload || upload.item_state !== "pending") throw new HttpError(404, "Upload not found.");
  if (upload.state !== "uploading") throw new HttpError(409, "Upload is being completed. Retry later.");
  if (partNumber > upload.total_parts) throw new HttpError(400, "Invalid upload part number.");

  const expectedSize = partNumber === upload.total_parts
    ? upload.size - upload.chunk_size * (partNumber - 1)
    : upload.chunk_size;
  const length = request.headers.get("Content-Length");
  if (length === null) throw new HttpError(411, "Content-Length is required for upload parts.");
  if (!/^\d+$/.test(length) || Number(length) !== expectedSize) {
    throw new HttpError(400, `Upload part must contain exactly ${expectedSize} bytes.`);
  }
  const checksum = request.headers.get("X-Part-SHA256") || "";
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new HttpError(400, "X-Part-SHA256 must be a lowercase SHA-256 hex digest.");

  const body = await request.arrayBuffer();
  if (body.byteLength !== expectedSize) throw new HttpError(400, `Upload part must contain exactly ${expectedSize} bytes.`);
  if (await sha256(body) !== checksum) throw new HttpError(400, "Upload part checksum does not match its body.");
  const previous = await env.DB.prepare(
    "SELECT size, checksum FROM multipart_parts WHERE item_id = ? AND part_number = ?",
  ).bind(id, partNumber).first();
  if (previous?.size === expectedSize && previous.checksum === checksum) {
    return json({ success: true, partNumber, replayed: true });
  }

  const multipart = env.FILES.resumeMultipartUpload(objectKey(id), upload.upload_id);
  const uploaded = await multipart.uploadPart(partNumber, body);
  const timestamp = now();
  const [saved] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO multipart_parts(item_id, part_number, etag, checksum, size, updated_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS
       (SELECT 1 FROM multipart_uploads m JOIN items i ON i.id = m.item_id
        WHERE m.item_id = ? AND m.state = 'uploading' AND i.state = 'pending')`,
    ).bind(id, partNumber, uploaded.etag, checksum, expectedSize, timestamp, id),
    env.DB.prepare("UPDATE multipart_uploads SET updated_at = ? WHERE item_id = ? AND state = 'uploading'").bind(timestamp, id),
    env.DB.prepare("UPDATE operations SET created_at = ? WHERE request_key = ? AND state = 'pending'")
      .bind(timestamp, upload.operation_key),
  ]);
  if (!saved.meta.changes) throw new HttpError(409, "Upload was cancelled while this part was being stored.");
  return json({ success: true, partNumber }, 201);
}

async function completeMultipart(env, id) {
  if (!validId(id)) throw new HttpError(404, "Upload not found.");
  const item = await env.DB.prepare("SELECT id, size, state FROM items WHERE id = ? AND type = 'file'").bind(id).first();
  if (!item || item.state === "deleting") throw new HttpError(404, "Upload not found.");
  if (item.state === "ready") return json({ success: true, id, complete: true, replayed: true });

  const upload = await env.DB.prepare("SELECT * FROM multipart_uploads WHERE item_id = ?").bind(id).first();
  if (!upload) throw new HttpError(409, "Upload is still being initialized.");
  const { results: parts } = await env.DB.prepare(
    "SELECT part_number, etag, size FROM multipart_parts WHERE item_id = ? ORDER BY part_number",
  ).bind(id).all();
  if (parts.length !== upload.total_parts ||
      parts.some((part, index) => part.part_number !== index + 1) ||
      parts.reduce((total, part) => total + part.size, 0) !== item.size) {
    throw new HttpError(409, "Upload is incomplete. Resume missing parts before completing it.");
  }

  const claimed = await env.DB.prepare(
    "UPDATE multipart_uploads SET state = 'completing', updated_at = ? WHERE item_id = ? AND state = 'uploading'",
  ).bind(now(), id).run();
  let object = await env.FILES.head(objectKey(id));
  if (!claimed.meta.changes && !object) throw new HttpError(409, "Upload is already being completed. Retry later.");

  try {
    if (!object) {
      const multipart = env.FILES.resumeMultipartUpload(objectKey(id), upload.upload_id);
      object = await multipart.complete(parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
    }
    if (!object || object.size !== item.size) throw new HttpError(500, "Completed file size does not match the upload.");
    await publishFile(env, id, upload.operation_key);
    return json({ success: true, id, complete: true }, 201);
  } catch (error) {
    const committed = await env.DB.prepare("SELECT state FROM operations WHERE request_key = ?").bind(upload.operation_key).first();
    if (committed?.state === "done") return json({ success: true, id, complete: true, replayed: true });
    await env.DB.prepare(
      "UPDATE multipart_uploads SET state = 'uploading', updated_at = ? WHERE item_id = ? AND state = 'completing'",
    ).bind(now(), id).run();
    throw error;
  }
}

async function cancelMultipart(env, ctx, id) {
  if (!validId(id)) throw new HttpError(404, "Upload not found.");
  const [cancelled] = await env.DB.batch([
    env.DB.prepare("UPDATE items SET state = 'deleting' WHERE id = ? AND state = 'pending'").bind(id),
    env.DB.prepare(`UPDATE operations SET state = 'failed' WHERE item_id = ? AND state = 'pending'
      AND EXISTS (SELECT 1 FROM items WHERE id = ? AND state = 'deleting')`).bind(id, id),
  ]);
  if (!cancelled.meta.changes) throw new HttpError(404, "Upload not found.");
  backgroundCleanup(env, ctx);
  return json({ success: true }, 202);
}

function rangeFor(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  const invalid = () => { throw new HttpError(416, "Invalid byte range.", { "Content-Range": `bytes */${size}` }); };
  if (!match || (!match[1] && !match[2]) || size === 0) return invalid();
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return invalid();
  }
  return { offset: start, length: end - start + 1 };
}

async function download(request, env, id) {
  if (!validId(id)) throw new HttpError(404, "File not found.");
  const item = await env.DB.prepare("SELECT name, size FROM items WHERE id = ? AND type = 'file' AND state = 'ready'").bind(id).first();
  if (!item) throw new HttpError(404, "File not found.");
  const range = request.method === "HEAD" ? null : rangeFor(request.headers.get("Range"), item.size);
  const object = request.method === "HEAD"
    ? await env.FILES.head(objectKey(id))
    : await env.FILES.get(objectKey(id), range ? { range } : {});
  if (!object) throw new HttpError(404, "File not found.");
  const encoded = encodeURIComponent(item.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`,
    "Content-Length": String(range ? range.length : item.size),
    "Accept-Ranges": "bytes",
  };
  if (object.httpEtag) headers.ETag = object.httpEtag;
  if (object.uploaded) headers["Last-Modified"] = object.uploaded.toUTCString();
  if (range) headers["Content-Range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${item.size}`;
  return new Response(request.method === "HEAD" ? null : object.body, { status: range ? 206 : 200, headers });
}

async function cleanupDeleted(env) {
  const { results } = await env.DB.prepare("SELECT id, type FROM items WHERE state = 'deleting' ORDER BY seq LIMIT 50").all();
  if (!results.length) return 0;
  const fileIds = results.filter((item) => item.type === "file").map((item) => item.id);
  if (fileIds.length) {
    const slots = fileIds.map(() => "?").join(",");
    const { results: uploads } = await env.DB.prepare(
      `SELECT item_id, upload_id FROM multipart_uploads WHERE item_id IN (${slots})`,
    ).bind(...fileIds).all();
    await Promise.allSettled(uploads.map((upload) =>
      env.FILES.resumeMultipartUpload(objectKey(upload.item_id), upload.upload_id).abort()));
    await env.FILES.delete(fileIds.map(objectKey));
  }
  const slots = results.map(() => "?").join(",");
  const ids = results.map((item) => item.id);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM multipart_parts WHERE item_id IN (${slots})`).bind(...ids),
    env.DB.prepare(`DELETE FROM multipart_uploads WHERE item_id IN (${slots})`).bind(...ids),
    env.DB.prepare(`DELETE FROM items WHERE state = 'deleting' AND id IN (${slots})`).bind(...ids),
  ]);
  return results.length;
}

function backgroundCleanup(env, ctx) {
  ctx.waitUntil(cleanupDeleted(env).catch((error) => console.error("R2 cleanup deferred to cron:", error)));
}

async function route(request, env, ctx) {
  const config = configuration(env);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (url.protocol !== "https:" && !localHttp(request, env)) throw new HttpError(426, "HTTPS is required.");

  if (method === "POST" && path === "/api/login") {
    const result = await login(request, env, config);
    return json({ success: true }, 200, { "Set-Cookie": sessionCookie(request, env, result.token, config.ttl) });
  }
  if ((method === "GET" || method === "HEAD") && ["/assets/app.js", "/assets/style.css"].includes(path)) {
    return asset(request, env, path);
  }
  const session = await getSession(request, env);
  if ((method === "GET" || method === "HEAD") && path === "/login") {
    return session ? Response.redirect(`${url.origin}/`, 303) : asset(request, env, "/login.html");
  }
  if (!session) {
    if ((method === "GET" || method === "HEAD") && ["/", "/index.html"].includes(path)) {
      return Response.redirect(`${url.origin}/login`, 303);
    }
    throw new HttpError(401, "Authentication required.");
  }
  if (!["GET", "HEAD"].includes(method)) requireCsrf(request, session);

  if ((method === "GET" || method === "HEAD") && ["/", "/index.html"].includes(path)) return asset(request, env, "/index.html");
  if (method === "GET" && path === "/api/session") {
    return json({
      csrfToken: session.csrf_token, expiresAt: session.expires_at,
      maxUploadBytes: config.uploadLimit,
      uploadChunkBytes: config.uploadChunkBytes,
      uploadConcurrency: config.uploadConcurrency,
      uploadSessionTtlSeconds: config.uploadSessionTtl,
      maxTextBytes: config.textLimit,
      pollSeconds: config.pollSeconds,
    });
  }
  if (method === "POST" && path === "/api/logout") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.token_hash).run();
    return json({ success: true }, 200, { "Set-Cookie": sessionCookie(request, env, "", 0) });
  }
  if (method === "GET" && path === "/api/revision") {
    return json({ revision: session.revision });
  }
  if (method === "GET" && path === "/api/history") {
    const raw = url.searchParams.get("before");
    if (raw !== null && (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))) throw new HttpError(400, "Invalid history cursor.");
    const cursor = raw ? Number(raw) : Number.MAX_SAFE_INTEGER;
    // Bound the worst-case text allocation before fetching full bodies from D1.
    const pageSize = Math.min(config.pageSize, Math.max(1, Math.floor(1048576 / config.textLimit)));
    const [items, state] = await env.DB.batch([
      env.DB.prepare("SELECT seq, id, type, content, name, size, created_at FROM items WHERE state = 'ready' AND seq < ? ORDER BY seq DESC LIMIT ?").bind(cursor, pageSize + 1),
      env.DB.prepare("SELECT revision FROM app_state WHERE id = 1"),
    ]);
    return json({
      items: items.results.slice(0, pageSize),
      nextCursor: items.results.length > pageSize ? items.results[pageSize - 1].seq : null,
      revision: state.results[0].revision,
    });
  }
  if (method === "POST" && path === "/api/text") {
    const data = await readJson(request, config.textLimit * 6 + 1024);
    if (typeof data.text !== "string" || !data.text.trim()) throw new HttpError(400, "Text cannot be empty.");
    if (encoder.encode(data.text).length > config.textLimit) throw new HttpError(413, `Text exceeds ${config.textLimit} UTF-8 bytes.`);
    const operation = await beginOperation(request, env, await digest(JSON.stringify(["text", data.text])));
    const { id, key } = operation;
    if (operation.replay) return json({ success: true, id, replayed: true });
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO items(id, type, content, state, created_at) VALUES (?, 'text', ?, 'ready', ?)").bind(id, data.text, now()),
        revision(env),
        env.DB.prepare("UPDATE operations SET state = 'done' WHERE request_key = ? AND item_id = ?").bind(key, id),
      ]);
    } catch (error) {
      const committed = await env.DB.prepare("SELECT state FROM operations WHERE request_key = ? AND item_id = ?").bind(key, id).first();
      if (committed?.state === "done") return json({ success: true, id, replayed: true });
      await env.DB.prepare("UPDATE operations SET state = 'failed' WHERE request_key = ? AND item_id = ?").bind(key, id).run();
      throw error;
    }
    return json({ success: true, id }, 201);
  }
  if (method === "POST" && path === "/api/uploads") return initiateMultipart(request, env, config);
  const multipartRoute = path.match(/^\/api\/uploads\/([a-f0-9-]+)(?:\/(complete|parts\/([1-9]\d*)))?$/);
  if (multipartRoute) {
    const [, id, action, partNumber] = multipartRoute;
    if (method === "GET" && !action) return json(await multipartPayload(env, id, config));
    if (method === "DELETE" && !action) return cancelMultipart(env, ctx, id);
    if (method === "POST" && action === "complete") return completeMultipart(env, id);
    if (method === "PUT" && partNumber) return uploadMultipartPart(request, env, id, partNumber);
  }
  if ((method === "GET" || method === "HEAD") && path.startsWith("/uploads/")) return download(request, env, path.slice(9));
  if (method === "DELETE" && path.startsWith("/api/history/")) {
    const id = path.slice("/api/history/".length);
    if (!validId(id)) throw new HttpError(404, "Item not found.");
    const [result] = await env.DB.batch([
      env.DB.prepare("UPDATE items SET state = 'deleting' WHERE id = ? AND state = 'ready'").bind(id), revision(env),
    ]);
    if (!result.meta.changes) throw new HttpError(404, "Item not found.");
    backgroundCleanup(env, ctx);
    return json({ success: true }, 202);
  }
  if (method === "POST" && path === "/api/clear_history") {
    await env.DB.batch([env.DB.prepare("UPDATE items SET state = 'deleting' WHERE state != 'deleting'"), revision(env)]);
    backgroundCleanup(env, ctx);
    return json({ success: true }, 202);
  }
  throw new HttpError(404, "Route not found.");
}

export async function maintenance(env) {
  const timestamp = now();
  const configuredTtl = Number(env.UPLOAD_SESSION_TTL_SECONDS || 86400);
  const uploadTtl = Number.isSafeInteger(configuredTtl)
    ? Math.min(Math.max(configuredTtl, 3600), 6 * 86400)
    : 86400;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(timestamp),
    env.DB.prepare("DELETE FROM login_attempts WHERE started_at < ?").bind(timestamp - 86400),
    env.DB.prepare(
      `UPDATE items SET state = 'deleting' WHERE state = 'pending' AND (
       EXISTS (SELECT 1 FROM multipart_uploads m WHERE m.item_id = items.id AND m.updated_at < ?)
       OR (NOT EXISTS (SELECT 1 FROM multipart_uploads m WHERE m.item_id = items.id) AND created_at < ?)
      )`,
    ).bind(timestamp - uploadTtl, timestamp - 3600),
    env.DB.prepare(
      `UPDATE operations SET state = 'failed' WHERE state = 'pending'
       AND EXISTS (SELECT 1 FROM items WHERE items.id = operations.item_id AND items.state = 'deleting')`,
    ),
    env.DB.prepare("DELETE FROM operations WHERE state != 'pending' AND created_at < ?").bind(timestamp - 86400),
  ]);
  const batches = Number(env.CLEANUP_BATCHES || 4);
  for (let i = 0; i < Math.min(Math.max(batches, 1), 8); i++) {
    if (await cleanupDeleted(env) < 50) break;
  }
  // Reconcile a bounded R2 page to recover from crashes between R2 and D1 writes.
  const state = await env.DB.prepare("SELECT sweep_cursor FROM app_state WHERE id = 1").first();
  const page = await env.FILES.list({ prefix: "files/", limit: 50, cursor: state.sweep_cursor || undefined });
  if (page.objects.length) {
    const ids = page.objects.map((object) => object.key.slice(6));
    const { results } = await env.DB.prepare(`SELECT id FROM items WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    const existing = new Set(results.map((item) => item.id));
    const abandoned = page.objects.filter((object) =>
      !existing.has(object.key.slice(6)) && object.uploaded.getTime() < Date.now() - 3600000);
    if (abandoned.length) await env.FILES.delete(abandoned.map((object) => object.key));
  }
  await env.DB.prepare("UPDATE app_state SET sweep_cursor = ? WHERE id = 1")
    .bind(page.truncated ? page.cursor : "").run();
}

export default {
  async fetch(request, env, ctx) {
    try {
      return harden(await route(request, env, ctx), request);
    } catch (error) {
      const requestId = crypto.randomUUID();
      const known = error instanceof HttpError;
      if (!known) console.error(JSON.stringify({ requestId, method: request.method, path: new URL(request.url).pathname }), error);
      return harden(json({
        success: false, message: known ? error.message : "Internal server error.",
        method: request.method, path: new URL(request.url).pathname, requestId,
      }, known ? error.status : 500, known ? error.headers : {}), request);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(maintenance(env));
  },
};
