import { createRuntime } from './runtime';

const { runtime } = await createRuntime(8792);
await runtime.ready;
console.log('EasyNote isolated browser-test server: http://127.0.0.1:8792');
const close = async () => { await runtime.dispose(); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
