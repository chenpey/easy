import { rm } from 'node:fs/promises';

await Promise.all([
  rm(new URL('../dist/ai/', import.meta.url), { recursive: true, force: true }),
  rm(new URL('../dist/shared/', import.meta.url), { recursive: true, force: true }),
]);
