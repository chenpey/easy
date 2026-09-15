/// <reference types="node" />
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { Writable } from 'node:stream';
import type { BridgeConfig } from './client.js';
import { EasyNoteClient, validateServerUrl } from './client.js';

export function defaultConfigPath(): string {
  if (process.platform === 'win32') {
    return resolve(process.env.APPDATA ?? resolve(homedir(), 'AppData', 'Roaming'), 'EasyNote', 'ai.json');
  }
  if (process.platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'EasyNote', 'ai.json');
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'easynote', 'ai.json');
}

export function configPathFromArgs(args: string[]): string {
  const index = args.indexOf('--config');
  if (index === -1) return defaultConfigPath();
  if (!args[index + 1] || args.length !== index + 2) throw new Error('--config requires one path and must be the final option.');
  return resolve(args[index + 1]);
}

function validateConfig(value: unknown): BridgeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object.');
  const data = value as Record<string, unknown>;
  const token = typeof data.token === 'string' ? data.token : '';
  if (!/^enai_[a-f0-9]{64}$/.test(token)) throw new Error('Configuration token has an invalid format.');
  return { url: validateServerUrl(String(data.url ?? '')), token };
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') throw new Error(`EasyNote AI configuration not found: ${path}\nRun the setup command first.`);
    throw error;
  }
  try {
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`EasyNote AI configuration is not valid JSON: ${path}`);
    throw error;
  }
}

class MutedOutput extends Writable {
  muted = false;

  _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) process.stdout.write(chunk, encoding);
    callback();
  }
}

async function secretQuestion(prompt: string, rl: ReturnType<typeof createInterface>, output: MutedOutput): Promise<string> {
  process.stdout.write(prompt);
  output.muted = true;
  try {
    return (await rl.question('')).trim();
  } finally {
    output.muted = false;
    process.stdout.write('\n');
  }
}

export async function setupConfig(path: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive setup requires a terminal.');
  const output = new MutedOutput();
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    if (existsSync(path)) {
      const overwrite = (await rl.question(`Configuration exists at ${path}. Replace it? [y/N] `)).trim().toLowerCase();
      if (!['y', 'yes'].includes(overwrite)) throw new Error('Setup cancelled; existing configuration was not changed.');
    }
    const url = validateServerUrl((await rl.question('EasyNote URL: ')).trim());
    const token = await secretQuestion('AI integration token: ', rl, output);
    const config = validateConfig({ url, token });
    const status = await new EasyNoteClient(config).status();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(path, 0o600);
    process.stdout.write(`Connected to ${status.account} through ${status.integration} (${status.access}).\n`);
    process.stdout.write(`Configuration: ${path}\n`);
    process.stdout.write(`MCP client configuration:\n${JSON.stringify({
      mcpServers: {
        easynote: {
          command: process.execPath,
          args: [resolve(process.argv[1]), 'mcp', '--config', path],
        },
      },
    }, null, 2)}\n`);
  } finally {
    rl.close();
  }
}
