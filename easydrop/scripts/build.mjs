import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(`${root}/dist`, { recursive: true, force: true });
await mkdir(`${root}/dist/assets`, { recursive: true });
await build({
  entryPoints: [`${root}/web/app.js`],
  outfile: `${root}/dist/assets/app.js`,
  bundle: true, minify: true, format: "esm", target: "es2022",
});
await copyFile(`${root}/web/style.css`, `${root}/dist/assets/style.css`);
await copyFile(`${root}/web/index.html`, `${root}/dist/index.html`);
await copyFile(`${root}/web/login.html`, `${root}/dist/login.html`);
await copyFile(`${root}/web/favicon.svg`, `${root}/dist/favicon.svg`);
console.log("Built Worker static assets.");
