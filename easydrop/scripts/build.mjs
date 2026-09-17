import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const versions = JSON.parse(await readFile(new URL("../../versions.json", import.meta.url), "utf8"));
await rm(`${root}/dist`, { recursive: true, force: true });
await mkdir(`${root}/dist/assets`, { recursive: true });
await build({
  entryPoints: [`${root}/web/app.js`],
  outfile: `${root}/dist/assets/app.js`,
  bundle: true, minify: true, format: "esm", target: "es2022",
  define: { __EASYDROP_VERSION__: JSON.stringify(versions.easydrop) },
});
await copyFile(`${root}/web/style.css`, `${root}/dist/assets/style.css`);
await copyFile(`${root}/web/index.html`, `${root}/dist/index.html`);
await copyFile(`${root}/web/login.html`, `${root}/dist/login.html`);
await copyFile(`${root}/web/favicon.svg`, `${root}/dist/favicon.svg`);
for (const file of [
  "manifest.webmanifest",
  "sw.js",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "pwa-maskable-512x512.png",
  "apple-touch-icon.png",
]) {
  await copyFile(`${root}/web/${file}`, `${root}/dist/${file}`);
}
console.log("Built Worker static assets.");
