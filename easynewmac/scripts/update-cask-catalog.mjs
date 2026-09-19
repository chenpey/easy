#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://formulae.brew.sh/api/cask.json";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const APP_OUTPUT_FILE = path.join(
  PROJECT_DIR,
  "catalog",
  "homebrew-casks.tsv",
);
const NAME_OUTPUT_FILE = path.join(
  PROJECT_DIR,
  "catalog",
  "homebrew-cask-names.tsv",
);

const inputIndex = process.argv.indexOf("--input");
const inputFile =
  inputIndex >= 0 && process.argv[inputIndex + 1]
    ? path.resolve(process.argv[inputIndex + 1])
    : null;

async function loadCasks() {
  if (inputFile) {
    return JSON.parse(fs.readFileSync(inputFile, "utf8"));
  }

  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`Homebrew API returned HTTP ${response.status}`);
  }
  return response.json();
}

function validToken(token) {
  return /^[A-Za-z0-9][A-Za-z0-9@+._-]*$/.test(token);
}

function normalizedKey(value) {
  if (typeof value !== "string") return null;
  const key = value.normalize("NFC").trim().toLowerCase();
  return key && !/[\t\r\n]/.test(key) ? key : null;
}

function appFilename(artifact) {
  if (!Array.isArray(artifact.app) || typeof artifact.app[0] !== "string") {
    return null;
  }

  const filename = normalizedKey(path.posix.basename(artifact.app[0]));
  return filename?.endsWith(".app") ? filename : null;
}

const casks = await loadCasks();
const appCandidates = new Map();
const nameCandidates = new Map();

function addCandidate(map, key, token) {
  if (!key) return;
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(token);
}

for (const cask of casks) {
  if (
    cask.disabled ||
    cask.token === "homebrew-app" ||
    !validToken(cask.token)
  ) {
    continue;
  }

  for (const artifact of cask.artifacts || []) {
    const filename = appFilename(artifact);
    if (!filename) continue;
    addCandidate(appCandidates, filename, cask.token);
  }

  for (const name of cask.name || []) {
    addCandidate(nameCandidates, normalizedKey(name), cask.token);
  }
}

function uniqueEntries(candidates) {
  return [...candidates]
    .filter(([, tokens]) => tokens.size === 1)
    .map(([key, tokens]) => [key, [...tokens][0]])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

const generatedAt = new Date().toISOString().slice(0, 10);
const appEntries = uniqueEntries(appCandidates);
const nameEntries = uniqueEntries(nameCandidates);

function writeCatalog(outputFile, description, entries) {
  const output = [
    `# Generated from ${SOURCE_URL}`,
    `# Updated ${generatedAt}; ${entries.length} unique ${description}`,
    "# Format: lowercase key<TAB>Homebrew Cask token",
    ...entries.map(([key, token]) => `${key}\t${token}`),
    "",
  ].join("\n");
  fs.writeFileSync(outputFile, output, "utf8");
}

fs.mkdirSync(path.dirname(APP_OUTPUT_FILE), { recursive: true });
writeCatalog(APP_OUTPUT_FILE, "app bundle filenames", appEntries);
writeCatalog(NAME_OUTPUT_FILE, "display names", nameEntries);
console.log(
  `Wrote ${appEntries.length} app names and ${nameEntries.length} display names to ${path.relative(process.cwd(), path.dirname(APP_OUTPUT_FILE))}`,
);
