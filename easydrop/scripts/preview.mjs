import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery as splitSqlQuery } from "wrangler";
import { createInitialAdmin, randomToken } from "../src/auth.js";

export async function applyLocalMigrations(db) {
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
    const schema = await readFile(new URL(file, directory), "utf8");
    await db.batch(splitSqlQuery(schema).map((statement) => db.prepare(statement)));
  }
}

export async function createPreview(vars = {}) {
  const root = new URL("../", import.meta.url);
  const config = JSON.parse(await readFile(new URL("wrangler.json", root), "utf8"));
  const password = `Aa1!${randomToken().slice(0, 20)}`;
  const initialAdmin = await createInitialAdmin("admin", password);
  const bundle = await build({
    entryPoints: [new URL("src/worker.js", root).pathname],
    bundle: true, write: false, format: "esm", platform: "browser",
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "easydrop-preview", host: "127.0.0.1", port: 0,
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    bindings: { ...config.vars, ...vars, ALLOW_LOCAL_HTTP: "true", INITIAL_ADMIN: initialAdmin },
    d1Databases: ["DB"], r2Buckets: ["FILES"],
    assets: {
      directory: new URL("dist", root).pathname, binding: "ASSETS", run_worker_first: true,
      routerConfig: { has_user_worker: true },
      assetConfig: { html_handling: "none", not_found_handling: "none" },
    },
  }));
  try {
    const db = await mf.getD1Database("DB");
    await applyLocalMigrations(db);
    const url = (await mf.ready).origin;
    return { mf, username: "admin", password, url };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await createPreview();
  console.log(`Preview URL: ${preview.url}`);
  console.log(`Temporary preview username: ${preview.username}`);
  console.log(`Temporary preview password: ${preview.password}`);
  console.log("Local-only, disposable data. Stop this process to discard all preview data.");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
    await preview.mf.dispose();
    process.exit(0);
  });
}
