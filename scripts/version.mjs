#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..');
const sourcePath = resolve(root, 'versions.json');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const projects = {
  easynote: {
    title: 'EasyNote',
    directory: 'easynote',
    packagePath: 'easynote/package.json',
    lockPath: 'easynote/package-lock.json',
    readmePath: 'easynote/README.md',
    runtimePath: 'easynote/src/shared/version.ts',
  },
  easydrop: {
    title: 'EasyDrop',
    directory: 'easydrop',
    packagePath: 'easydrop/package.json',
    lockPath: 'easydrop/package-lock.json',
    readmePath: 'easydrop/README.md',
  },
  easynewmac: {
    title: 'EasyNewMac',
    directory: 'easynewmac',
    readmePath: 'easynewmac/README.md',
    versionPath: 'easynewmac/VERSION',
  },
};

function fail(message) {
  throw new Error(message);
}

function validateProject(name) {
  if (!projects[name]) fail(`Unknown project "${name}". Use easynote, easydrop or easynewmac.`);
  return projects[name];
}

function validateVersion(version) {
  if (typeof version !== 'string' || !semverPattern.test(version)) {
    fail(`Invalid version "${version}". Use semantic versioning such as 0.1.1.`);
  }
  return version;
}

export function bumpVersion(version, kind) {
  validateVersion(version);
  if (!['major', 'minor', 'patch'].includes(kind)) {
    fail(`Unknown bump type "${kind}". Use major, minor or patch.`);
  }
  const [major, minor, patch] = version.split('-')[0].split('+')[0].split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readVersions() {
  const versions = await readJson(sourcePath);
  for (const name of Object.keys(projects)) validateVersion(versions[name]);
  return versions;
}

async function writeIfChanged(path, content) {
  let current = '';
  try { current = await readFile(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current !== content) await writeFile(path, content);
}

function jsonContent(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function versionReadmeLine(version) {
  return `当前版本：\`${version}\``;
}

function rootReadmeBlock(versions) {
  return [
    '<!-- versions:start -->',
    '| 项目 | 当前版本 |',
    '| --- | --- |',
    `| [EasyDrop](easydrop/) | \`${versions.easydrop}\` |`,
    `| [EasyNewMac](easynewmac/) | \`${versions.easynewmac}\` |`,
    `| [EasyNote](easynote/) | \`${versions.easynote}\` |`,
    '<!-- versions:end -->',
  ].join('\n');
}

async function syncPackage(project, version) {
  if (!project.packagePath) return;
  const packagePath = resolve(root, project.packagePath);
  const packageJson = await readJson(packagePath);
  packageJson.version = version;
  await writeIfChanged(packagePath, jsonContent(packageJson));

  const lockPath = resolve(root, project.lockPath);
  const lockJson = await readJson(lockPath);
  lockJson.version = version;
  if (lockJson.packages?.['']) lockJson.packages[''].version = version;
  await writeIfChanged(lockPath, jsonContent(lockJson));
}

async function syncVersionFile(project, version) {
  if (!project.versionPath) return;
  await writeIfChanged(resolve(root, project.versionPath), `${version}\n`);
}

async function syncProjectReadme(project, version) {
  const path = resolve(root, project.readmePath);
  let content = await readFile(path, 'utf8');
  const line = versionReadmeLine(version);
  if (/^当前版本：.*$/m.test(content)) {
    content = content.replace(/^当前版本：.*$/m, line);
  } else {
    content = content.replace(new RegExp(`^(# ${project.title}\\n)`), `$1\n${line}\n`);
  }
  await writeIfChanged(path, content);
}

async function syncRuntimeVersion(project, version) {
  if (!project.runtimePath) return;
  const content = `// Generated from versions.json. Run node scripts/version.mjs sync after editing the source.\nexport const EASYNOTE_VERSION = '${version}';\n`;
  await writeIfChanged(resolve(root, project.runtimePath), content);
}

async function syncReadme(versions) {
  const path = resolve(root, 'README.md');
  let content = await readFile(path, 'utf8');
  const block = rootReadmeBlock(versions);
  if (/<!-- versions:start -->[\s\S]*?<!-- versions:end -->/.test(content)) {
    content = content.replace(/<!-- versions:start -->[\s\S]*?<!-- versions:end -->/, block);
  } else {
    content = content.replace(/^(Easy Suite[\s\S]*?\n\n)/, `$1## 版本\n\n${block}\n\n`);
  }
  await writeIfChanged(path, content);
}

async function syncAll(versions) {
  for (const [name, project] of Object.entries(projects)) {
    await syncPackage(project, versions[name]);
    await syncVersionFile(project, versions[name]);
    await syncProjectReadme(project, versions[name]);
    await syncRuntimeVersion(project, versions[name]);
  }
  await syncReadme(versions);
}

async function checkVersions(versions) {
  const errors = [];
  for (const [name, project] of Object.entries(projects)) {
    if (project.packagePath) {
      const packageJson = await readJson(resolve(root, project.packagePath));
      if (packageJson.version !== versions[name]) errors.push(`${project.packagePath} version is ${packageJson.version}`);
      const lockJson = await readJson(resolve(root, project.lockPath));
      if (lockJson.version !== versions[name] || lockJson.packages?.['']?.version !== versions[name]) {
        errors.push(`${project.lockPath} root version is not ${versions[name]}`);
      }
    }
    if (project.versionPath) {
      const versionFile = (await readFile(resolve(root, project.versionPath), 'utf8')).trim();
      if (versionFile !== versions[name]) errors.push(`${project.versionPath} is ${versionFile}`);
    }
    const readme = await readFile(resolve(root, project.readmePath), 'utf8');
    if (!readme.includes(versionReadmeLine(versions[name]))) errors.push(`${project.readmePath} is missing ${versions[name]}`);
    if (project.runtimePath) {
      const runtime = await readFile(resolve(root, project.runtimePath), 'utf8');
      if (!runtime.includes(`EASYNOTE_VERSION = '${versions[name]}'`)) errors.push(`${project.runtimePath} is stale`);
    }
  }
  const rootReadme = await readFile(resolve(root, 'README.md'), 'utf8');
  if (!rootReadme.includes(rootReadmeBlock(versions))) errors.push('README.md version table is stale');
  if (errors.length) fail(`Version files are out of sync:\n${errors.map((error) => `- ${error}`).join('\n')}`);
}

function projectFromCwd() {
  const current = resolve(process.cwd());
  const match = Object.entries(projects).find(([, project]) => resolve(root, project.directory) === current);
  return match?.[0] ?? '';
}

function usage() {
  return `Usage:
  node scripts/version.mjs show
  node scripts/version.mjs check
  node scripts/version.mjs sync
  node scripts/version.mjs set <project> <version>
  node scripts/version.mjs bump <project> <major|minor|patch>

From a project directory, the project name may be omitted:
  cd easynewmac && node ../scripts/version.mjs bump patch`;
}

async function main() {
  const [command = 'show', first, second] = process.argv.slice(2);
  const versions = await readVersions();
  if (command === 'show') {
    console.log(JSON.stringify(versions, null, 2));
    return;
  }
  if (command === 'check') {
    await checkVersions(versions);
    console.log('All project versions are synchronized.');
    return;
  }
  if (command === 'sync') {
    await syncAll(versions);
    console.log('Synchronized package metadata, runtime versions and README files.');
    return;
  }
  if (command === 'set' || command === 'bump') {
    const inferred = projectFromCwd();
    const projectName = projects[first] ? first : inferred;
    const value = projects[first] ? second : first;
    validateProject(projectName);
    if (!value) fail(`${command} requires a version or bump type.`);
    versions[projectName] = command === 'set'
      ? validateVersion(value)
      : bumpVersion(versions[projectName], value);
    await writeIfChanged(sourcePath, jsonContent(versions));
    await syncAll(versions);
    console.log(`${projects[projectName].title} version: ${versions[projectName]}`);
    return;
  }
  fail(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Version update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
