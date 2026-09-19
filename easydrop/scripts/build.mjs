import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const versions = JSON.parse(await readFile(new URL("../../versions.json", import.meta.url), "utf8"));
await rm(`${root}/dist`, { recursive: true, force: true });
await mkdir(`${root}/dist/assets`, { recursive: true });

const fingerprint = (content) => createHash("sha256").update(content).digest("hex").slice(0, 12);
const javascript = await build({
  entryPoints: [`${root}/web/app.js`],
  bundle: true, minify: true, format: "esm", target: "es2022", write: false,
  define: { __EASYDROP_VERSION__: JSON.stringify(versions.easydrop) },
});
const script = javascript.outputFiles[0]?.contents;
if (!script) throw new Error("EasyDrop JavaScript bundle was not generated.");
const appAsset = `/assets/app-${fingerprint(script)}.js`;
await writeFile(`${root}/dist${appAsset}`, script);

const stylesheet = await readFile(`${root}/web/style.css`);
const styleAsset = `/assets/style-${fingerprint(stylesheet)}.css`;
await writeFile(`${root}/dist${styleAsset}`, stylesheet);

for (const page of ["index.html", "login.html"]) {
  const html = (await readFile(`${root}/web/${page}`, "utf8"))
    .replace("/assets/style.css", styleAsset)
    .replace("/assets/app.js", appAsset);
  await writeFile(`${root}/dist/${page}`, html);
}

const staticAssets = [
  appAsset,
  styleAsset,
  "/apple-touch-icon.png",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/pwa-maskable-512x512.png",
];
const serviceWorker = (await readFile(`${root}/web/sw.js`, "utf8"))
  .replace("__EASYDROP_CACHE_NAME__", `easydrop-static-v${versions.easydrop}`)
  .replace("/* __EASYDROP_STATIC_ASSETS__ */ []", JSON.stringify(staticAssets, null, 2));
await writeFile(`${root}/dist/sw.js`, serviceWorker);

await copyFile(`${root}/web/favicon.svg`, `${root}/dist/favicon.svg`);
for (const file of [
  "manifest.webmanifest",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "pwa-maskable-512x512.png",
  "apple-touch-icon.png",
]) {
  await copyFile(`${root}/web/${file}`, `${root}/dist/${file}`);
}
console.log("Built Worker static assets.");
